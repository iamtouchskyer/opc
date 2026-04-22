// Shared utilities used across all harness modules.
// Single source of truth for getFlag, resolveDir, atomicWriteSync, constants.

import { writeFileSync, renameSync, symlinkSync, unlinkSync, readlinkSync, existsSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { createHash, randomBytes } from "crypto";
import { homedir } from "os";

// ── CLI flag parsing ────────────────────────────────────────────
export function getFlag(args, name, fallback = null) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] != null ? args[idx + 1] : fallback;
}

// ── Safe directory resolution with path traversal guard ─────────
export function resolveDir(args) {
  const raw = getFlag(args, "dir", ".harness");
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
