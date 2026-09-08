// Session-ownership for OPC loops.
//
// Problem this solves: `/opc loop` + context compaction can leave two live
// Claude sessions both driving the SAME loop-state.json in the same session
// dir. The file lock / in_progress guard prevent *state corruption*, but they
// do NOT prevent two drivers doing duplicate WORK (a resumed agent that jumps
// straight to complete-tick bypasses the next-tick in_progress guard entirely).
//
// The fix: bind a loop to exactly one session.
//   - LIVE discrimination = the Claude-ancestor (PID + process start time). Each
//     Claude Code session is one OS process; walking the harness's parent chain
//     finds it. Two live sessions have different Claude PIDs → the non-owner is
//     refused. The start time is paired with the PID because a bare PID is not a
//     stable identity: over a long run the owner can exit and the OS can recycle
//     its PID, which would make isPidAlive lie and permanently BLOCK a valid
//     takeover. (pid, start_time) is stable across reuse.
//   - The PID survives compaction (compaction does not swap the process), so a
//     compact-resumed agent is still recognised as the owner with zero friction.
//   - A stable per-loop TOKEN is stamped at init for identity/audit and rotated
//     on takeover. Discrimination does not depend on it; it only records *who*
//     owns the loop and makes reclaim auditable.
//   - Legacy stamps without a recorded start time degrade gracefully to PID-only
//     comparison, preserving pre-fix behavior.
//
// Depends on: (none — self-contained)

import { execFileSync } from "child_process";
import { hostname } from "os";
import { createHash, randomBytes } from "crypto";

// ── Liveness ────────────────────────────────────────────────────
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return err && err.code === "EPERM";
  }
}

// ── Parent-chain walk to find the owning Claude session ─────────
// Returns { ppid, args } for one pid, or null if ps can't see it.
function psInfo(pid) {
  try {
    const out = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    if (!out) return null;
    const m = out.match(/^\s*(\d+)\s+(.*)$/s);
    if (!m) return null;
    return { ppid: Number(m[1]), args: m[2] };
  } catch {
    return null;
  }
}

// A process is the Claude Code CLI if its command line references `claude`
// but is not the harness itself (which is a child of Claude).
function looksLikeClaude(args) {
  if (!args) return false;
  if (/opc-harness/.test(args)) return false;
  return /\bclaude\b/i.test(args);
}

// ── Process start-time (PID-reuse guard) ────────────────────────
// A bare PID is not a stable identity: over a long (e.g. 24h) run the owning
// Claude process can exit and the OS can recycle its PID to an unrelated
// process. `isPidAlive` would then report "alive" and permanently BLOCK a
// legitimate takeover. Pairing the PID with the process START TIME fixes this:
// start time is fixed at exec and differs across a reuse, so (pid, start) is a
// stable instance identity. We treat the `ps -o lstart=` string as an opaque
// token and compare by equality — no parsing, no locale assumptions.
export function psStartTime(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(n)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Walk up from the current harness process until we hit the Claude ancestor.
// Returns its PID, or null when not running under Claude (e.g. a manual CLI
// invocation), in which case ownership binding is disabled (legacy behavior).
export function findClaudeAncestorPid() {
  let pid = process.pid;
  const seen = new Set();
  for (let depth = 0; depth < 40; depth++) {
    if (!Number.isInteger(pid) || pid <= 1 || seen.has(pid)) break;
    seen.add(pid);
    const info = psInfo(pid);
    if (!info) break;
    if (looksLikeClaude(info.args)) return pid;
    pid = info.ppid;
  }
  return null;
}

// ── Caller identity ─────────────────────────────────────────────
export function resolveCallerIdentity() {
  // Kill switch: OPC_DISABLE_OWNERSHIP=1 → pretend caller has no Claude ancestor
  // (legacy behavior). Use for test harnesses, batch scripts, and hosts where
  // `ps` walks the parent chain to an unrelated Claude process (race / multi-
  // session hosts). checkOwnership() also short-circuits on the same env var.
  if (process.env.OPC_DISABLE_OWNERSHIP === "1") {
    return { claude_pid: null, claude_started_at: null, host: hostname() };
  }
  const claude_pid = findClaudeAncestorPid();
  return {
    claude_pid,
    claude_started_at: claude_pid != null ? psStartTime(claude_pid) : null,
    host: hostname(),
  };
}

// ── Fail-open detection (Hole 3) ────────────────────────────────
// When we cannot resolve the caller's Claude PID (ps unavailable, not running
// under Claude, an unusual harness launch), ownership binding is degraded.
// Drive commands now fail CLOSED (checkOwnership refuses if a live owner is
// recorded), but init cannot bind a loop to a session with no PID, and a
// --force override on drive re-opens the double-drive window. Surface this so
// the operator knows enforcement is running in a degraded mode. Returns a
// warning string when the caller PID is unresolvable, else null.
export function ownershipEnforcementWarning(caller) {
  if (caller && caller.claude_pid != null) return null;
  return "session-ownership degraded — could not resolve this Claude session's PID " +
    "(ps unavailable or not launched under Claude). A loop initialized now cannot be bound " +
    "to this session, and drive commands fail closed (refuse when a live owner is recorded). " +
    "If you run /opc loop in more than one window, keep only one live.";
}

// ── Owner stamp ─────────────────────────────────────────────────
export function generateOwnerToken() {
  return createHash("sha256")
    .update(Date.now().toString() + randomBytes(8).toString("hex"))
    .digest("hex")
    .slice(0, 16);
}

export function makeOwner(caller, token = generateOwnerToken()) {
  return {
    token,
    claude_pid: caller.claude_pid,
    claude_started_at: caller.claude_started_at ?? null,
    host: caller.host,
    claimed_at: new Date().toISOString(),
  };
}

// ── Ownership decision ──────────────────────────────────────────
// Returns { decision: "OWNER" | "BLOCKED" | "TAKEOVER", reason, owner? }.
//
//   OWNER    — caller is the owning session (same live Claude PID), or the loop
//              has no owner stamp (legacy loop). If the caller's PID is
//              unresolvable, OWNER only when the recorded owner is not provably
//              live (otherwise BLOCKED — fail closed).
//   BLOCKED  — a DIFFERENT Claude session owns the loop and is still alive. The
//              caller must not drive it. This is the double-drive bug case.
//   TAKEOVER — the owner is gone (dead PID). The caller may reclaim the loop;
//              callers should re-stamp _owner via makeOwner() and persist.
export function checkOwnership(state, caller, opts = {}) {
  const owner = state && state._owner;

  // Kill switch: OPC_DISABLE_OWNERSHIP=1 → legacy behavior (allow all). Use for
  // test harnesses, batch scripts, and environments where `ps` walks the parent
  // chain to a different, unrelated Claude process (race / multi-session hosts).
  if (process.env.OPC_DISABLE_OWNERSHIP === "1") {
    return { decision: "OWNER", reason: "ownership check disabled via OPC_DISABLE_OWNERSHIP=1" };
  }

  // Legacy loop (pre-ownership) — no stamp to enforce.
  if (!owner || owner.claude_pid == null) {
    return { decision: "OWNER", reason: "no ownership stamp — legacy loop" };
  }
  // Caller's Claude PID is unresolvable (ps unavailable, or not launched under
  // Claude). We cannot prove this caller IS the owning session. Failing OPEN
  // here (the old behavior — return OWNER for everyone) let a second session
  // drive the loop undetected: the exact double-drive bug this module exists to
  // prevent. Fail CLOSED instead — if the recorded owner instance is provably
  // still live (same host, PID alive, start time matches), refuse. A legitimate
  // manual/admin caller in a ps-less environment can pass --force to override.
  if (caller.claude_pid == null) {
    const ownerLive = owner.host === caller.host
      && isPidAlive(owner.claude_pid)
      && startTimeStillMatches(owner);
    if (ownerLive && !opts.force) {
      return {
        decision: "BLOCKED",
        reason: `cannot resolve this caller's Claude PID and the loop is owned by a live session ` +
          `(pid ${owner.claude_pid}) — refusing to drive it (pass --force if no other session is active)`,
        owner,
      };
    }
    return {
      decision: opts.force ? "TAKEOVER" : "OWNER",
      reason: opts.force
        ? "forced takeover (caller PID unresolvable)"
        : "caller PID unresolvable and owner not provably live — allowing",
      owner,
    };
  }

  const sameHost = owner.host === caller.host;
  const samePid = sameHost && Number(owner.claude_pid) === Number(caller.claude_pid);

  // Start-time discriminates a genuine identity match from a PID collision.
  // If both sides recorded a start time and they differ, the PIDs coincide by
  // OS reuse — NOT the same process. When either side lacks a start time
  // (legacy stamp / ps unavailable) we fall back to PID-only comparison to
  // preserve the original behavior rather than over-block.
  const startTimesKnown = owner.claude_started_at != null && caller.claude_started_at != null;
  const startTimesMatch = !startTimesKnown || owner.claude_started_at === caller.claude_started_at;

  if (samePid && startTimesMatch) {
    return { decision: "OWNER", reason: "caller is the owning Claude session" };
  }
  // samePid but start times differ → caller reused the owner's dead PID.
  // Fall through to the liveness check, which will (correctly) find the
  // recorded owner instance gone and permit takeover.

  // Owner is truly live only if its PID is alive AND the process at that PID is
  // the same instance that stamped the loop (start time matches). A recycled
  // PID passes isPidAlive but fails the start-time check → treated as dead.
  const ownerPidAlive = sameHost && isPidAlive(owner.claude_pid);
  const ownerInstanceLive = ownerPidAlive && startTimeStillMatches(owner);
  if (ownerInstanceLive && !opts.force) {
    return {
      decision: "BLOCKED",
      reason: `loop is owned by a live Claude session (pid ${owner.claude_pid}` +
        `${sameHost ? "" : ` on ${owner.host}`}) — refusing to drive it from this session`,
      owner,
    };
  }

  // Owner is dead (or --force) — safe to reclaim: a dead owner can't double-drive.
  const tokenMatch = opts.callerToken != null && opts.callerToken === owner.token;
  return {
    decision: "TAKEOVER",
    reason: opts.force
      ? "forced takeover"
      : tokenMatch
        ? "previous owner is gone and caller holds the loop token — reclaiming"
        : "previous owner is gone — reclaiming",
    owner,
  };
}

// Is the process currently at owner.claude_pid still the same instance that
// stamped the loop? Returns true when we cannot tell (legacy stamp with no
// recorded start time) so liveness degrades to PID-only, matching pre-fix
// behavior. Returns false only when we have a recorded start time AND the live
// process reports a different one — i.e. a confirmed PID reuse.
function startTimeStillMatches(owner) {
  if (owner.claude_started_at == null) return true; // legacy — can't verify
  const current = psStartTime(owner.claude_pid);
  if (current == null) return false; // process gone between checks
  return current === owner.claude_started_at;
}
