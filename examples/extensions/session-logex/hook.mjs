// hook.mjs — session-logex (OPC Run 3 U3.5)
//
// Declares `post-flow-digest@1`. Spec §10 has no `state.after` hook, so
// the nudge is delivered via `verdictAppend` at gate/deliver-style nodes.
//
// Design downgrade (documented per plan.md):
//   The original intent was: "when a flow completes successfully and was
//   long enough to warrant a blog post, auto-invoke /logex". That requires
//   a state.after hook + the ability to call a skill from an extension —
//   neither exists in the current spec. Downgrade to a **soft nudge**:
//   emit a single `info` finding with the command the user would run.
//
// Trigger rule (all must hold):
//   - flow-state.json exists near ctx.flowDir
//   - status ∈ {pipeline_complete, complete, done} (tolerant)
//   - step_count / ticks >= MIN_STEPS (signal: non-trivial session)
//
// Otherwise return [] — never injects noise on short or in-progress flows.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const meta = {
  provides: ["post-flow-digest@1"],
  compatibleCapabilities: ["verification@1", "design-review@1", "execute@1"],
};

const LOGEX_SKILL = join(process.env.HOME || "", ".claude/skills/logex");
const MIN_STEPS = 5;
const STATE_BASENAMES = ["flow-state.json"];
const STATE_DIRS = [".harness", ".harness-run3", ".harness-run3-integration"];
const DONE_STATUSES = new Set(["pipeline_complete", "complete", "done", "completed"]);

export function startupCheck() {
  if (!existsSync(LOGEX_SKILL)) {
    process.stderr.write(
      `[session-logex] WARN: ${LOGEX_SKILL} not found — verdictAppend nudge still emits, but /logex will be unavailable to the user\n`
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
  // Walk upward: at each level, check direct hits and each known harness dir.
  while (true) {
    for (const base of STATE_BASENAMES) {
      const direct = join(cur, base);
      if (existsSync(direct)) return direct;
    }
    for (const d of STATE_DIRS) {
      const p = join(cur, d, "flow-state.json");
      if (existsSync(p)) return p;
    }
    if (cur === root) return null;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function readState(path) {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function shouldNudge(state) {
  if (!state || typeof state !== "object") return false;
  const status = String(state.status || state.phase || "").toLowerCase();
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
    const searchStart = ctx?.flowDir || ctx?.runDir || ctx?.cwd || process.cwd();
    const statePath = findFlowState(searchStart);
    if (!statePath) return [];
    const state = readState(statePath);
    if (!shouldNudge(state)) return [];
    return [
      {
        severity: "info",
        category: "post-flow-digest",
        message:
          "session eligible for /logex digest — run `/logex` to generate a blog-style paper from this session",
      },
    ];
  } catch (err) {
    process.stderr.write(
      `[session-logex] WARN: verdictAppend failed: ${err?.message || err}\n`
    );
    return [];
  }
}

export { findFlowState as _findFlowState, shouldNudge as _shouldNudge };
