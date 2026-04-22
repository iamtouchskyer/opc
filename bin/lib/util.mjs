// Shared utilities used across all harness modules.
// Single source of truth for getFlag, resolveDir, atomicWriteSync, constants.

import { writeFileSync, renameSync, symlinkSync, unlinkSync, readlinkSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import { resolve, join } from "path";
import { createHash, randomBytes } from "crypto";
import { homedir } from "os";

// ── CLI flag parsing ────────────────────────────────────────────
export function getFlag(args, name, fallback = null) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] != null ? args[idx + 1] : fallback;
}

// ── Safe directory resolution with path traversal guard ─────────
// When no --dir is given, prefer the latest session dir (if one exists).
// Falls back to ".harness" for backward compatibility.
export function resolveDir(args) {
  const hasExplicit = args.includes("--dir");
  let raw;
  if (hasExplicit) {
    raw = getFlag(args, "dir", ".harness");
  } else {
    // Auto-resolve: latest session dir > .harness
    const latest = getLatestSessionDir();
    raw = latest || ".harness";
  }
  const resolved = resolve(raw);
  const cwd = process.cwd();
  const opcBase = join(homedir(), ".opc", "sessions");
  // Allow: under cwd OR under ~/.opc/sessions/ (session dirs)
  if (!resolved.startsWith(cwd + "/") && resolved !== cwd && !resolved.startsWith(opcBase + "/")) {
    console.error(`ERROR: --dir resolved to '${resolved}' which is outside cwd '${cwd}' and ~/.opc/sessions/`);
    process.exit(1);
  }
  return resolved;
}

// ── Atomic file write (rename-based) ────────────────────────────
export function atomicWriteSync(filePath, data) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

// ── Shared constants ────────────────────────────────────────────
export const VALID_NODE_TYPES = new Set(["discussion", "build", "review", "execute", "gate"]);
export const VALID_STATUSES = new Set(["completed", "failed", "blocked"]);
export const VALID_VERDICTS = new Set(["PASS", "ITERATE", "FAIL", "BLOCKED"]);
export const EVIDENCE_TYPES = new Set(["test-result", "screenshot", "cli-output"]);

export const WRITER_SIG = "opc-harness";
export const IDEMPOTENCY_WINDOW_MS = 5000;

// ── Session directory management ────────────────────────────────
// ~/.opc/sessions/{project-hash}/{session-id}/
// Solves multi-window bug: each init gets its own dir, no clobbering.

export function getProjectHash(cwd = process.cwd()) {
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
  const base = getSessionsBaseDir(cwd);
  const latestLink = join(base, "latest");
  try {
    const target = readlinkSync(latestLink);
    const resolved = resolve(base, target);
    // Guard: symlink target must resolve within sessions base dir
    if (!resolved.startsWith(base + "/")) return null;
    return existsSync(join(resolved, "flow-state.json")) ? resolved : null;
  } catch {
    return null;
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
        const st = statSync(join(dir, "flow-state.json"));
        if (st.mtimeMs < cutoff) {
          rmSync(dir, { recursive: true, force: true });
          deleted.push(e.name);
        }
      } catch {
        // No flow-state.json or unreadable — skip (don't delete unknown dirs)
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
