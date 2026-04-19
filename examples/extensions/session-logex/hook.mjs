// hook.mjs — session-logex (OPC Run 3 U3.5, revised after U3.5r)
//
// Declares `post-flow-digest@1`. Spec §10 has no `state.after` hook, so
// the nudge is delivered via `verdictAppend` at gate/deliver-style nodes.
//
// Design downgrade (documented per plan.md):
//   Original intent — "auto-invoke /logex when a flow completes".
//   Requires state.after + skill invocation from hook, neither exists.
//   Downgrade: **soft nudge**, a single info finding. Dedup via a sibling
//   marker file so the same flow's gates don't re-spam the user.
//
// Trigger rule (all must hold):
//   - flow-state.json discovered near ctx.flowDir (bounded: stops at a
//     repo-root sentinel — .git / package.json / .opc — or root)
//   - status ∈ DONE_STATUSES (see below)
//   - step_count / ticks / history.length >= MIN_STEPS
//   - sibling `.logex-nudged` does NOT exist (first-fire only)
//   - /logex skill present (else nudge would be unactionable)

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const meta = {
  provides: ["post-flow-digest@1"],
  // Limited to gate/deliver style capabilities. We deliberately omit
  // execute@1 — emitting on every executor verdict would amplify noise.
  compatibleCapabilities: ["verification@1", "design-review@1"],
};

const LOGEX_SKILL = join(process.env.HOME || "", ".claude/skills/logex");
const MIN_STEPS = 5;
const REPO_SENTINELS = [".git", "package.json", ".opc"];
// Aligned with DONE_STATUSES below:
const DONE_STATUSES = new Set([
  "pipeline_complete", "complete", "completed", "done", "finished", "success",
]);

let _logexAvailable = null;
function logexAvailable() {
  if (_logexAvailable !== null) return _logexAvailable;
  _logexAvailable = existsSync(LOGEX_SKILL);
  return _logexAvailable;
}

export function startupCheck() {
  if (!logexAvailable()) {
    process.stderr.write(
      `[session-logex] WARN: ${LOGEX_SKILL} not found — nudge suppressed (would be unactionable)\n`
    );
    return { ok: true, available: false };
  }
  return { ok: true, available: true };
}

function findFlowState(start) {
  if (!start) return null;
  let cur;
  try { cur = resolve(start); } catch { return null; }
  const root = resolve("/");
  while (true) {
    // Direct hit at cwd
    const direct = join(cur, "flow-state.json");
    if (existsSync(direct)) return direct;
    // Any .harness*/flow-state.json (future-proof: harness-run3, harness-run5, etc.)
    try {
      for (const entry of readdirSync(cur)) {
        if (!entry.startsWith(".harness")) continue;
        const p = join(cur, entry, "flow-state.json");
        if (existsSync(p)) return p;
      }
    } catch { /* unreadable dir — ignore */ }
    // Stop at repo-root sentinel — prevents contaminating sibling flows
    if (REPO_SENTINELS.some((s) => existsSync(join(cur, s)))) return null;
    if (cur === root) return null;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function readState(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function shouldNudge(state) {
  if (!state || typeof state !== "object") return false;
  const status = String(state.status || "").toLowerCase();
  if (!DONE_STATUSES.has(status)) return false;
  const steps =
    Number(state.step_count) ||
    Number(state.tick) ||
    Number(state.tickCount) ||
    (Array.isArray(state.history) ? state.history.length : 0);
  return steps >= MIN_STEPS;
}

export function verdictAppend(ctx) {
  try {
    if (!logexAvailable()) return [];
    const searchStart = ctx?.flowDir || ctx?.runDir || ctx?.cwd || process.cwd();
    const statePath = findFlowState(searchStart);
    if (!statePath) return [];
    const markerPath = join(dirname(statePath), ".logex-nudged");
    if (existsSync(markerPath)) return []; // already nudged this flow
    const state = readState(statePath);
    if (!shouldNudge(state)) return [];
    try { writeFileSync(markerPath, new Date().toISOString()); } catch { /* non-fatal */ }
    return [{
      severity: "info",
      category: "post-flow-digest",
      message:
        `session eligible for /logex digest — run \`/logex\` in this session ` +
        `(or /logex <path> pointing at ~/.claude/projects/**/<session>.jsonl)`,
    }];
  } catch (err) {
    process.stderr.write(
      `[session-logex] WARN: verdictAppend failed: ${err?.message || err}\n`
    );
    return [];
  }
}

export { findFlowState as _findFlowState, shouldNudge as _shouldNudge };
