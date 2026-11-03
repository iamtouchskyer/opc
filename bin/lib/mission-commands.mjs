import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getFlag, resolveDir, atomicWriteSync, WRITER_SIG } from "./util.mjs";
import { lockFile } from "./file-lock.mjs";
import { resolveCurrentRun } from "./runaway-guard.mjs";
import { resolveExactRunHandshake } from "./flow-evidence.mjs";
import { resolveFlowTemplate } from "./flow-templates.mjs";
import { evaluateFlowBudget } from "./flow-budget.mjs";
import { FINDING_CLASSES, validateMission, missionTrigger, allowedMissionActions, applyMissionDecision, nonempty } from "./mission-gate.mjs";
import { missionBinding, evidenceFiles, validateEvidence, validateReviewer } from "./mission-evidence.mjs";

function packetFor(state, dir, args) {
  validateMission(state);
  const resolved = resolveFlowTemplate(args, state);
  if (resolved.error) throw new Error(resolved.error);
  const from = getFlag(args, "from", state.currentNode);
  const verdict = getFlag(args, "verdict", "CHECK");
  if (from !== state.currentNode) throw new Error("Mission review must target the current node");
  const rawTo = getFlag(args, "to");
  const to = rawTo === "null" ? null : (rawTo ?? (verdict === "CHECK" ? from : resolved.template.edges[from]?.[verdict]));
  if (verdict !== "CHECK" && (to === undefined || resolved.template.edges[from]?.[verdict] !== to)) throw new Error("Mission edge is not in the current flow");
  const edge = { from, to, verdict };
  let trigger = missionTrigger({ state, ...edge });
  if (verdict !== "CHECK") {
    const budget = evaluateFlowBudget({ state, template: resolved.template, ...edge });
    if (!budget.allowed && !budget.mission) trigger = { code: "LEGACY_FLOW_LIMIT", hard: true, reason: budget.reason };
  }
  return { enabled: true, mode: "single-flow", flow: state.flowTemplate, contract: state.mission.contract,
    edge, trigger, allowedActions: allowedMissionActions(state, trigger),
    binding: trigger || verdict !== "CHECK" ? missionBinding(state, dir, edge) : null,
    sessionDir: dir, currentNode: state.currentNode, status: state.status || "in_progress" };
}

export function cmdMission(args) {
  const action = args[0];
  const dir = resolveDir(args);
  const path = join(dir, "flow-state.json");
  let lock;
  try {
    const readOnly = ["status", "evidence"].includes(action);
    if (!["status", "evidence", "pause", "decide", "accept"].includes(action)) throw new Error("usage: mission <status|evidence|pause|decide|accept> [--review file] --dir session");
    if (!existsSync(path)) throw new Error("flow-state.json not found");
    if (!readOnly) {
      lock = lockFile(path, { command: `mission-${action}` });
      if (!lock.acquired) throw new Error("could not acquire flow-state lock");
    }
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (!Object.hasOwn(state, "mission")) {
      if (action !== "status") throw new Error("Mission is not enabled");
      console.log(JSON.stringify({ ok: true, enabled: false, flow: state.flowTemplate }));
      return;
    }
    validateMission(state);
    if (existsSync(join(dir, "loop-state.json"))) throw new Error("Mission loop/shared state is unsupported");
    if (action === "evidence") {
      console.log(JSON.stringify({ ok: true, evidence: evidenceFiles([getFlag(args, "file")], state, dir) }));
      return;
    }
    if (!readOnly && ["stopped", "completed"].includes(state.status)) throw new Error("Mission is terminal; cannot mutate it");
    if (action === "pause") {
      const classification = getFlag(args, "class");
      const reason = getFlag(args, "reason");
      if (!FINDING_CLASSES.includes(classification) || !nonempty(reason)) throw new Error("pause requires --class ARTIFACT|PLAN|ENVIRONMENT|GOAL_SPEC and --reason");
      if (state.mission.signal) throw new Error("Mission is already paused; decide its existing signal");
      state.mission.signal = { classification, reason };
      state.mission.acceptance = null;
    }
    const packet = packetFor(state, dir, args);
    if (action === "decide" || action === "accept") {
      const reviewPath = getFlag(args, "review");
      if (!nonempty(reviewPath)) throw new Error("--review file is required");
      const review = JSON.parse(readFileSync(reviewPath, "utf8"));
      validateReviewer(review, packet.binding);
      if (action === "decide") {
        review.evidence = validateEvidence(review.evidence, state, dir);
        applyMissionDecision(state, packet, review);
      } else {
        if (packet.trigger || packet.edge.to !== null || packet.edge.verdict !== "PASS") throw new Error("accept requires an unblocked terminal PASS edge");
        const run = resolveCurrentRun(state);
        const exact = resolveExactRunHandshake(dir, state.currentNode, run?.runId);
        if (exact.error || exact.missing || !existsSync(join(dir, "nodes", state.currentNode, "handshake.json"))) throw new Error("seal the terminal node before obtaining its Mission outcome review");
        if (!Array.isArray(review.outcomes) || review.outcomes.length !== state.mission.contract.outcomes.length) throw new Error("every Mission outcome requires a review result");
        const evidence = [];
        for (const outcome of state.mission.contract.outcomes) {
          const matches = review.outcomes.filter(item => item?.id === outcome.id);
          if (matches.length !== 1 || matches[0].status !== "PASS" || !nonempty(matches[0].reason)) throw new Error(`outcome ${outcome.id} is missing or not PASS`);
          evidence.push(...validateEvidence(matches[0].evidence, state, dir));
        }
        state.mission.acceptance = { binding: packet.binding, reviewer: review.reviewer, evidence, outcomes: review.outcomes };
      }
    }
    if (action !== "status") {
      state._written_by = WRITER_SIG;
      state._last_modified = new Date().toISOString();
      atomicWriteSync(path, JSON.stringify(state, null, 2) + "\n");
    }
    console.log(JSON.stringify({ ok: true, ...packet, ...(action !== "status" ? { applied: action } : {}) }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  } finally { lock?.release?.(); }
}
