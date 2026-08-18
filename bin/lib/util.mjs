// Shared utilities used across all harness modules.
// Single source of truth for getFlag, resolveDir, atomicWriteSync, constants.

import { writeFileSync, renameSync, symlinkSync, unlinkSync, readlinkSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, realpathSync } from "fs";
import { resolve, join, dirname } from "path";
import { createHash, randomBytes } from "crypto";
import { homedir } from "os";
import { execSync } from "child_process";
import { lockFile } from "./file-lock.mjs";

// ── CLI flag parsing ────────────────────────────────────────────
export function getFlag(args, name, fallback = null) {
  const eqPrefix = `--${name}=`;
  const eq = args.find(a => typeof a === "string" && a.startsWith(eqPrefix));
  if (eq) return eq.slice(eqPrefix.length);
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] != null ? args[idx + 1] : fallback;
}

export function hasFlag(args, name) {
  const flag = `--${name}`;
  const eqPrefix = `${flag}=`;
  return args.includes(flag) || args.some(a => typeof a === "string" && a.startsWith(eqPrefix));
}

// ── Safe directory resolution with path traversal guard ─────────
// When no --dir is given, prefer the latest session dir (if one exists).
// Falls back to ".harness" for backward compatibility.
export function resolveDir(args, opts = {}) {
  const hasExplicit = args.includes("--dir");
  let raw;
  if (hasExplicit) {
    raw = getFlag(args, "dir", ".harness");
  } else {
    // Auto-resolve: latest session dir > .harness (if exists) > error
    const latest = getLatestSessionDir();
    if (latest) {
      raw = latest;
    } else if (existsSync(resolve(".harness", "flow-state.json"))) {
      console.error("WARN: falling back to legacy .harness dir — consider running `opc-harness init` for session-based flow");
      raw = ".harness";  // backward compat: legacy .harness dir with active flow
    } else if (opts.optional) {
      return null;  // caller handles missing dir gracefully
    } else {
      const cwd = process.cwd();
      const hash = getProjectHash(cwd);
      const base = getSessionsBaseDir(cwd);
      console.error(`ERROR: No active session found for cwd '${cwd}' (hash: ${hash}).`);
      console.error(`  Looked in: ${base}/`);
      console.error(`  Tip: use --dir <path> to target an existing session, or run 'opc-harness ls' to list all.`);
      process.exit(1);
    }
  }
  let resolved;
  try { resolved = realpathSync(resolve(raw)); } catch { resolved = resolve(raw); }
  let cwd;
  try { cwd = realpathSync(process.cwd()); } catch { cwd = process.cwd(); }
  const opcBase = join(homedir(), ".opc", "sessions");
  // Allow: under cwd OR under ~/.opc/sessions/ (session dirs)
  if (!resolved.startsWith(cwd + "/") && resolved !== cwd && !resolved.startsWith(opcBase + "/")) {
    console.error(`ERROR: --dir resolved to '${resolved}' which is outside cwd '${cwd}' and ~/.opc/sessions/`);
    process.exit(1);
  }
  return resolved;
}

// ── Read-only dir resolution (no path traversal guard) ─────────
// For read-only commands (viz, replay, ext-commands) that need session
// auto-resolve but don't need write-path guards.
export function resolveDirReadOnly(args, fallback = ".harness") {
  if (args.includes("--dir")) return getFlag(args, "dir", fallback);
  return resolveDir(args, { optional: true }) || fallback;
}

// ── Atomic file write (rename-based) ────────────────────────────
export function atomicWriteSync(filePath, data) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

// ── Shared constants ────────────────────────────────────────────
export const VALID_NODE_TYPES = new Set(["discussion", "brief", "build", "review", "execute", "hotfix", "gate"]);
export const VALID_STATUSES = new Set(["completed", "failed", "blocked"]);
export const VALID_VERDICTS = new Set(["PASS", "ITERATE", "FAIL", "BLOCKED"]);
export const EVIDENCE_TYPES = new Set(["test-result", "screenshot", "cli-output"]);

export const VALID_LOOP_STATUSES = new Set(["initialized", "in_progress", "pipeline_complete", "terminated", "stalled"]);
export const TERMINAL_LOOP_STATUSES = new Set(["pipeline_complete", "terminated", "stalled"]);

export const WRITER_SIG = "opc-harness";
export const IDEMPOTENCY_WINDOW_MS = 5000;

// ── Session directory management ────────────────────────────────
// ~/.opc/sessions/{project-hash}/{session-id}/
// Solves multi-window bug: each init gets its own dir, no clobbering.

/**
 * Resolve the canonical project root for hashing.
 * 1. Try git root (covers 99% of real usage — subdirs all hash the same)
 * 2. Fallback to realpath(cwd) with trailing slash stripped
 */
export function getProjectRoot(cwd = process.cwd()) {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return realpathSync(gitRoot);
  } catch {
    // Not a git repo — use normalized cwd
    try { return realpathSync(cwd).replace(/\/+$/, ""); } catch { return cwd; }
  }
}

export function getProjectHash(cwd = process.cwd()) {
  const root = getProjectRoot(cwd);
  return createHash("sha256").update(root).digest("hex").slice(0, 12);
}

/**
 * Legacy hash: sha256(raw cwd) — used for migration fallback.
 */
function getLegacyProjectHash(cwd = process.cwd()) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

export function createSessionId() {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

export function getSessionsBaseDir(cwd = process.cwd()) {
  return join(homedir(), ".opc", "sessions", getProjectHash(cwd));
}

/**
 * Create a new session directory and update the `latest` symlink.
 * Returns the absolute path to the new session dir.
 */
export function createSessionDir(cwd = process.cwd()) {
  const home = homedir();
  if (!home) { console.error("ERROR: HOME not set — cannot create session dir"); process.exit(1); }
  const base = getSessionsBaseDir(cwd);
  const sessionId = createSessionId();
  const sessionDir = join(base, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  // Update `latest` symlink (atomic: write tmp, rename)
  const latestLink = join(base, "latest");
  const tmpLink = `${latestLink}.tmp.${process.pid}`;
  try { unlinkSync(tmpLink); } catch { /* ok */ }
  symlinkSync(sessionId, tmpLink);  // relative target
  renameSync(tmpLink, latestLink);

  // Auto-GC: clean sessions older than 7 days (best-effort, never crash init)
  try { gcSessions(cwd); } catch { /* ignore */ }

  return sessionDir;
}

/**
 * Resolve the latest session dir for the current project.
 * Returns null if no session exists.
 */
export function getLatestSessionDir(cwd = process.cwd()) {
  // Try new hash (git-root-based) first, then legacy hash (raw cwd) for migration
  for (const hash of [getProjectHash(cwd), getLegacyProjectHash(cwd)]) {
    const base = join(homedir(), ".opc", "sessions", hash);
    const latestLink = join(base, "latest");
    try {
      const target = readlinkSync(latestLink);
      const resolved = resolve(base, target);
      // Guard: symlink target must resolve within sessions base dir
      if (!resolved.startsWith(base + "/")) continue;
      if (existsSync(join(resolved, "flow-state.json"))) return resolved;
      // Symlink valid, dir exists, but no flow-state.json — warn
      if (existsSync(resolved)) {
        console.error(`WARN: session dir '${resolved}' exists but has no flow-state.json — skipping`);
      }
    } catch {
      // No symlink or unreadable — try next hash
    }
  }
  return null;
}

export function runtimeRegistryPath(sessionId, home = homedir()) {
  const key = createHash("sha256").update(String(sessionId)).digest("hex");
  return join(home, ".opc", "runtime", `${key}.json`);
}

function deleteRegisteredAutoSession(dir, initialState, cutoff, errors) {
  if (typeof initialState._claudeSessionId !== "string" || initialState._claudeSessionId.length === 0) {
    errors.push(`cannot GC auto session '${dir}': missing Claude session ID`);
    return false;
  }

  const sessionId = initialState._claudeSessionId;
  const path = runtimeRegistryPath(sessionId);
  const statePath = join(dir, "flow-state.json");
  let lock;
  try {
    mkdirSync(dirname(path), { recursive: true });
    lock = lockFile(path, { command: "gc-session-registry", timeout: 0 });
    if (!lock.acquired) {
      errors.push(`cannot acquire registry lock for '${dir}'`);
      return false;
    }

    // Re-check age and identity under the same lock used by auto init. A
    // same-directory --force init may have replaced the stale state while GC
    // was waiting for this lock.
    if (statSync(statePath).mtimeMs >= cutoff) return false;
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (state?.autoMode !== true || state._claudeSessionId !== sessionId) return false;

    let registry;
    try {
      registry = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        rmSync(dir, { recursive: true, force: true });
        return true;
      }
      throw error;
    }

    if (registry?.sessionId !== sessionId || typeof registry.sessionDir !== "string") {
      errors.push(`cannot GC auto session '${dir}': registry identity is invalid`);
      return false;
    }
    if (resolve(registry.sessionDir) !== resolve(dir)) {
      rmSync(dir, { recursive: true, force: true });
      return true;
    }

    if (state.status !== "completed" && state.status !== "stopped") return false;

    // Keep the lock until both operations finish. Unlinking the registry first
    // can leave an orphan directory on I/O failure, but never a registry that
    // points at a deleted flow.
    unlinkSync(path);
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (error) {
    errors.push(`cannot clean registry for '${dir}': ${error.message}`);
    return false;
  } finally {
    if (lock?.acquired) lock.release();
  }
}

/**
 * Delete session dirs older than maxAgeDays in the given project's sessions base.
 * Returns { deleted: string[], errors: string[] }.
 */
export function gcSessions(cwd = process.cwd(), { maxAgeDays = 7 } = {}) {
  const base = getSessionsBaseDir(cwd);
  const deleted = [];
  const errors = [];
  if (!existsSync(base)) return { deleted, errors };

  const cutoff = Date.now() - maxAgeDays * 86400_000;
  try {
    const entries = readdirSync(base, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "latest") continue;
      const dir = join(base, e.name);
      try {
        const statePath = join(dir, "flow-state.json");
        const st = statSync(statePath);
        if (st.mtimeMs < cutoff) {
          let state;
          try {
            state = JSON.parse(readFileSync(statePath, "utf8"));
          } catch (error) {
            errors.push(`cannot read expired session '${dir}': ${error.message}`);
            continue;
          }
          if (state?.autoMode === true) {
            if (!deleteRegisteredAutoSession(dir, state, cutoff, errors)) continue;
          } else {
            rmSync(dir, { recursive: true, force: true });
          }
          deleted.push(e.name);
        }
      } catch {
        // No flow-state.json — check if this is an orphaned partial init (has nodes/ subdir)
        // Only GC orphans older than maxAgeDays based on dir mtime
        try {
          const dirStat = statSync(dir);
          if (dirStat.mtimeMs < cutoff && existsSync(join(dir, "nodes"))) {
            rmSync(dir, { recursive: true, force: true });
            deleted.push(e.name + " (orphan)");
          }
        } catch { /* unreadable — skip */ }
      }
    }
  } catch (err) {
    errors.push(err.message);
  }
  return { deleted, errors };
}

/**
 * CLI: opc-harness gc [--max-age <days>] [--base <cwd>]
 */
export function cmdGc(args) {
  const maxAge = parseInt(getFlag(args, "max-age", "7"), 10);
  const base = getFlag(args, "base", process.cwd());
  const result = gcSessions(base, { maxAgeDays: maxAge });
  console.log(JSON.stringify(result));
}
