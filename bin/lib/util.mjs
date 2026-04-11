// Shared utilities used across all harness modules.
// Single source of truth for getFlag, resolveDir, atomicWriteSync, constants.

import { writeFileSync, renameSync } from "fs";
import { resolve } from "path";

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
  if (!resolved.startsWith(cwd + "/") && resolved !== cwd) {
    console.error(`ERROR: --dir resolved to '${resolved}' which is outside cwd '${cwd}'`);
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
