// Loop advance command: next-tick
// Depends on: loop-helpers.mjs, util.mjs

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parsePlan, hashContent } from "./loop-helpers.mjs";
import { getFlag, resolveDir, atomicWriteSync, WRITER_SIG } from "./util.mjs";
import { FLOW_TEMPLATES, loadFlowFromFile } from "./flow-templates.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPC_ROOT = join(__dirname, "..", "..");

// ── Unit type → context hints mapping ─────────────────────────
const UNIT_TYPE_HINTS = {
  implement: {
    protocols: ["implementer-prompt.md"],
    roles: ["engineer"],
    recommended_flow: "build-verify",
  },
  build: {
    protocols: ["implementer-prompt.md"],
    roles: ["engineer"],
    recommended_flow: "build-verify",
  },
  review: {
    protocols: ["role-evaluator-prompt.md", "context-brief.md"],
    roles: ["frontend", "backend", "security"],
    recommended_flow: "review",
  },
  fix: {
    protocols: ["implementer-prompt.md"],
    roles: ["engineer"],
    recommended_flow: "build-verify",
  },
  e2e: {
    protocols: ["executor-protocol.md"],
    roles: ["tester"],
    recommended_flow: "build-verify",
  },
  accept: {
    protocols: ["role-evaluator-prompt.md"],
    roles: ["pm", "designer"],
    recommended_flow: "pre-release",
  },
  "ux-sim": {
    protocols: ["ux-simulation-protocol.md", "ux-observer-protocol.md"],
    roles: ["new-user", "active-user", "churned-user"],
    recommended_flow: "full-stack",
  },
  "ux-simulation": {
    protocols: ["ux-simulation-protocol.md", "ux-observer-protocol.md"],
    roles: ["new-user", "active-user", "churned-user"],
    recommended_flow: "full-stack",
  },
};

function getContextHints(unitType) {
  // Match by prefix: "implement-ui" → "implement"
  const baseType = Object.keys(UNIT_TYPE_HINTS).find(k => unitType.startsWith(k));
  if (!baseType) {
    return { protocols: [], roles: [], recommended_flow: "build-verify" };
  }
  const hints = UNIT_TYPE_HINTS[baseType];
  return {
    protocols: hints.protocols.map(p => join(OPC_ROOT, "pipeline", p)).filter(p => existsSync(p)),
    roles: hints.roles.map(r => join(OPC_ROOT, "roles", `${r}.md`)).filter(r => existsSync(r)),
    recommended_flow: hints.recommended_flow,
  };
}

// ─── next-tick ──────────────────────────────────────────────────

export function cmdNextTick(args) {
  const dir = resolveDir(args);

  const statePath = join(dir, "loop-state.json");
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ ready: false, terminate: true, reason: "loop-state.json not found" }));
    return;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ ready: false, terminate: true, reason: `corrupt loop-state.json: ${err.message}` }));
    return;
  }
  const warnings = [];

  // Auto-restore flow template from _flow_file if persisted
  if (state._flow_file) {
    const result = loadFlowFromFile(state._flow_file);
    if (result.error) {
      warnings.push(`_flow_file restore failed: ${result.error}`);
    }
  }

  // Tamper: writer chain + nonce
  if (state._written_by !== WRITER_SIG || !state._write_nonce) {
    warnings.push("loop-state.json was not written by opc-harness — possible direct edit");
  }

  // Already terminated
  if (state.status === "pipeline_complete" || state.status === "terminated") {
    console.log(JSON.stringify({
      ready: false,
      terminate: true,
      reason: `loop already ${state.status}`,
    }));
    return;
  }

  // Concurrent tick guard
  if (state.status === "in_progress") {
    console.log(JSON.stringify({
      ready: false,
      terminate: false,
      reason: "another tick is in progress — skipping this cron fire",
      current_unit: state.next_unit,
    }));
    return;
  }

  // Rule 8/9: Stall detection
  const history = state._tick_history || [];
  if (checkStall(state, history, statePath)) return;
  if (checkOscillation(state, history, statePath)) return;

  // Total tick limit
  const maxTicks = state._max_total_ticks || Infinity;
  if (state.tick >= maxTicks) {
    state.status = "terminated";
    state.description = `maxTotalTicks (${maxTicks}) reached at tick ${state.tick}`;
    state._written_by = WRITER_SIG;
    state._last_modified = new Date().toISOString();
    atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

    console.log(JSON.stringify({
      ready: false,
      terminate: true,
      reason: `maxTotalTicks (${maxTicks}) reached`,
      total_ticks: state.tick,
    }));
    return;
  }

  // Wall-clock deadline
  if (state._started_at && state._max_duration_hours) {
    const elapsed = (Date.now() - new Date(state._started_at).getTime()) / (1000 * 60 * 60);
    if (elapsed >= state._max_duration_hours) {
      state.status = "terminated";
      state.description = `Wall-clock deadline (${state._max_duration_hours}h) reached after ${elapsed.toFixed(1)}h`;
      state._written_by = WRITER_SIG;
      state._last_modified = new Date().toISOString();
      atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

      console.log(JSON.stringify({
        ready: false,
        terminate: true,
        reason: `wall-clock deadline (${state._max_duration_hours}h) reached after ${elapsed.toFixed(1)}h`,
        elapsed_hours: parseFloat(elapsed.toFixed(1)),
      }));
      return;
    }
  }

  // No next unit → terminate
  if (!state.next_unit) {
    state.status = "pipeline_complete";
    state.description = `Pipeline complete at tick ${state.tick}`;
    state._written_by = WRITER_SIG;
    state._last_modified = new Date().toISOString();
    atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

    // Rule 13: surface backlog at termination
    const backlogPath = join(dir, "backlog.md");
    const backlogExists = existsSync(backlogPath);
    let backlogSummary = null;
    if (backlogExists) {
      const backlogText = readFileSync(backlogPath, "utf8");
      const openItems = (backlogText.match(/^- \[ \]/gm) || []).length;
      backlogSummary = { file: backlogPath, open_items: openItems };
    }

    console.log(JSON.stringify({
      ready: false,
      terminate: true,
      reason: "next_unit is null — pipeline complete",
      total_ticks: state.tick,
      backlog: backlogSummary,
      hint: backlogSummary && backlogSummary.open_items > 0
        ? `\u26a0\ufe0f ${backlogSummary.open_items} open backlog items — review before closing`
        : undefined,
    }));
    return;
  }

  // Validate next_unit in plan + plan hash
  const planFile = state.plan_file || join(dir, "plan.md");
  if (existsSync(planFile)) {
    const planText = readFileSync(planFile, "utf8");
    const units = parsePlan(planText);
    const unitIds = units.map(u => u.id);

    if (state._plan_hash) {
      const currentHash = hashContent(planText);
      if (currentHash !== state._plan_hash) {
        warnings.push(`plan.md modified since init-loop (hash ${state._plan_hash} \u2192 ${currentHash})`);
      }
    }

    if (!unitIds.includes(state.next_unit)) {
      state.status = "pipeline_complete";
      state.description = `Auto-terminated: unit '${state.next_unit}' not found in plan`;
      const badUnit = state.next_unit;
      state.next_unit = null;
      state._written_by = WRITER_SIG;
      state._last_modified = new Date().toISOString();
      atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

      console.log(JSON.stringify({
        ready: false,
        terminate: true,
        reason: `next_unit '${badUnit}' not found in plan — auto-terminated`,
        total_ticks: state.tick,
      }));
      return;
    }

    const unitDetails = units.find(u => u.id === state.next_unit);

    // Capture previous status before mutation
    const prevStatus = state.status;

    // Set in_progress as mutex
    state.status = "in_progress";
    state._written_by = WRITER_SIG;
    state._last_modified = new Date().toISOString();
    atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

    // Look up unitHandler from flow template (if loop was started from a custom flow)
    let handler = undefined;
    if (state._flow_template && unitDetails) {
      const tmpl = Object.hasOwn(FLOW_TEMPLATES, state._flow_template) ? FLOW_TEMPLATES[state._flow_template] : null;
      if (tmpl && tmpl.unitHandlers && tmpl.unitHandlers[unitDetails.type]) {
        handler = tmpl.unitHandlers[unitDetails.type];
      }
    }
    // Also check for unitHandlers stored directly in loop-state (set by init-loop --handlers)
    if (!handler && state._unit_handlers && unitDetails) {
      handler = state._unit_handlers[unitDetails.type] || undefined;
    }

    // Build context hints for the orchestrator
    const unitType = unitDetails ? unitDetails.type : "unknown";
    const contextHints = getContextHints(unitType);

    console.log(JSON.stringify({
      ready: true,
      terminate: false,
      next_unit: state.next_unit,
      unit_type: unitType,
      unit_description: unitDetails ? unitDetails.description : "",
      tick: state.tick + 1,
      previous_unit: state.unit,
      previous_status: prevStatus,
      handler: handler || undefined,
      context_hints: contextHints,
      recommended_flow: contextHints.recommended_flow,
      warnings: warnings.length > 0 ? warnings : undefined,
    }));
    return;
  }

  // No plan file — hard error
  console.log(JSON.stringify({
    ready: false,
    terminate: false,
    error: `plan file '${planFile}' not found — cannot validate next unit`,
  }));
}

// ── Stall detection helpers ─────────────────────────────────────

function checkStall(state, history, statePath) {
  if (history.length >= 2) {
    const last2 = history.slice(-2);
    if (last2[0].unit === last2[1].unit) {
      if (history.length >= 3) {
        const last3 = history.slice(-3);
        if (last3[0].unit === last3[1].unit && last3[1].unit === last3[2].unit) {
          state.status = "stalled";
          state.description = `Stalled on unit '${last3[0].unit}' for 3 consecutive ticks`;
          state._written_by = WRITER_SIG;
          state._last_modified = new Date().toISOString();
          atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

          console.log(JSON.stringify({
            ready: false,
            terminate: true,
            reason: `\u26d4 stalled on unit '${last3[0].unit}' for 3 ticks — needs human input`,
            stalled_unit: last3[0].unit,
          }));
          return true;
        }
      }
    }
  }
  return false;
}

function checkOscillation(state, history, statePath) {
  if (history.length >= 4) {
    const last4 = history.slice(-4);
    if (last4[0].unit === last4[2].unit && last4[1].unit === last4[3].unit && last4[0].unit !== last4[1].unit) {
      if (history.length >= 6) {
        const last6 = history.slice(-6);
        if (last6[0].unit === last6[2].unit && last6[2].unit === last6[4].unit &&
            last6[1].unit === last6[3].unit && last6[3].unit === last6[5].unit) {
          state.status = "stalled";
          state.description = `Oscillation stall: '${last6[0].unit}' \u2194 '${last6[1].unit}' for 6 ticks`;
          state._written_by = WRITER_SIG;
          state._last_modified = new Date().toISOString();
          atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

          console.log(JSON.stringify({
            ready: false,
            terminate: true,
            reason: `\u26d4 oscillation stall: '${last6[0].unit}' \u2194 '${last6[1].unit}' for 6 ticks — needs human input`,
            stalled_units: [last6[0].unit, last6[1].unit],
          }));
          return true;
        }
      }
    }
  }
  return false;
}
