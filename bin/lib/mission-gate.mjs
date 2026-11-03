// Single-flow Mission policy. Reuses OPC repair counts; owns no graph or I/O.
// Decision taxonomy is narrowed from PR #35: RESTORE is intentionally unsupported.
export const MISSION_SCHEMA = "opc.mission-lite/v1";
export const FINDING_CLASSES = ["ARTIFACT", "PLAN", "ENVIRONMENT", "GOAL_SPEC"];
const REPAIR = new Set(["FAIL", "ITERATE"]);
const CONTINUE = new Set(["CONTINUE_CURRENT", "RESHAPE_SMALLER"]);

export function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateContract(value) {
  if (!value || value.schemaVersion !== 1 || !nonempty(value.goal)) throw new Error("Mission requires schemaVersion:1 and a non-empty goal");
  const keys = ["schemaVersion", "goal", "outcomes", "nonGoals", "appetite"];
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("unknown Mission contract field (legacy contracts are not migrated)");
  if (!Array.isArray(value.outcomes) || !value.outcomes.length) throw new Error("Mission requires at least one outcome");
  const ids = new Set();
  for (const outcome of value.outcomes) {
    if (!outcome || !nonempty(outcome.id) || !/^[a-zA-Z0-9][\w-]*$/.test(outcome.id) || !nonempty(outcome.description) || ids.has(outcome.id)) throw new Error("outcomes require unique IDs and descriptions");
    ids.add(outcome.id);
  }
  if (!Array.isArray(value.nonGoals) || value.nonGoals.some(item => !nonempty(item))) throw new Error("nonGoals must be an array of non-empty strings (may be empty)");
  const appetite = value.appetite;
  if (!appetite || !Number.isSafeInteger(appetite.maxRepairCycles) || appetite.maxRepairCycles < 1
    || !Number.isFinite(appetite.maxMinutes) || appetite.maxMinutes <= 0) throw new Error("appetite requires positive maxRepairCycles (integer) and maxMinutes");
  if (Object.keys(appetite).some(key => !["maxRepairCycles", "maxMinutes"].includes(key))) throw new Error("unsupported appetite field");
  return value;
}

export function createMission(contract, now = Date.now()) {
  validateContract(contract);
  return { schema: MISSION_SCHEMA, contract, startedAt: now, signal: null, decisions: [], grant: null, acceptance: null };
}

export function validateMission(state) {
  const m = state.mission;
  if (!m || m.schema !== MISSION_SCHEMA) throw new Error("unsupported Mission state; use its original runtime or start a new session");
  validateContract(m.contract);
  if (!Number.isFinite(m.startedAt) || !Array.isArray(m.decisions)
    || !Number.isSafeInteger(state.totalSteps) || state.totalSteps < 0
    || !state.repairEdgeCounts || typeof state.repairEdgeCounts !== "object" || Array.isArray(state.repairEdgeCounts)
    || Object.values(state.repairEdgeCounts).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error("invalid Mission progress");
  if (m.signal !== null && (!m.signal || !FINDING_CLASSES.includes(m.signal.classification) || !nonempty(m.signal.reason))) throw new Error("invalid Mission signal");
  return m;
}

export function missionTrigger({ state, from = state.currentNode, to = state.currentNode, verdict = "CHECK", now = Date.now() }) {
  if (!Object.hasOwn(state, "mission")) return null;
  try {
    const m = validateMission(state);
    const repairs = Object.values(state.repairEdgeCounts).reduce((a, b) => a + b, 0);
    if (now < m.startedAt || now - m.startedAt >= m.contract.appetite.maxMinutes * 60000) return { code: "MISSION_TIME_LIMIT", hard: true, reason: "Mission time appetite reached or clock moved backwards" };
    if (REPAIR.has(verdict) && repairs >= m.contract.appetite.maxRepairCycles) return { code: "MISSION_REPAIR_LIMIT", hard: true, reason: "Mission repair appetite reached" };
    if (state.autoMode === true && REPAIR.has(verdict) && (state.autoRepairCounts?.[`${from}→${to}`] ?? 0) >= 1) {
      return { code: "LEGACY_AUTO_REPAIR_LIMIT", hard: true, reason: "The existing Claude auto repair limit requires human intervention" };
    }
    if (m.decisions.some(d => d.action === "HUMAN_REBET")) return { code: "MISSION_HUMAN_REBET", hard: true, reason: "New user-authorized scope needs a new session; this Mission cannot resume" };
    if (m.signal) return { code: "MISSION_SIGNAL", hard: m.signal.classification === "GOAL_SPEC", ...m.signal };
    const edgeKey = `${from}→${to}`;
    const g = m.grant;
    if (g && g.step === state.totalSteps && verdict !== "CHECK"
      && (g.from !== from || g.to !== to || g.verdict !== verdict)) {
      return { code: "MISSION_EDGE_MISMATCH", hard: true, reason: "The one-shot decision only authorizes its reviewed edge" };
    }
    if (REPAIR.has(verdict) && (state.repairEdgeCounts[edgeKey] || 0) >= 1) {
      if (g && g.step === state.totalSteps && g.from === from && g.to === to && g.verdict === verdict) return null;
      return { code: "MISSION_REPEATED_REPAIR", hard: false, reason: `Repeated repair on ${edgeKey}; inspect whether there is new evidence` };
    }
    return null;
  } catch (error) {
    return { code: "MISSION_INVALID", hard: true, reason: error.message };
  }
}

export function missionBudgetError(context) {
  const trigger = missionTrigger(context);
  return trigger ? { allowed: false, reason: `${trigger.code}: ${trigger.reason}; run mission status with this edge`, mission: trigger } : null;
}

export function allowedMissionActions(state, trigger) {
  const actions = ["HUMAN_REBET", "STOP_SALVAGE"];
  if (!trigger || trigger.hard) return actions;
  if (!state.mission.decisions.some(d => CONTINUE.has(d.action))) actions.push("CONTINUE_CURRENT", "RESHAPE_SMALLER");
  if (!state.mission.decisions.some(d => d.action === "RECON")) actions.push("RECON");
  return actions;
}

export function applyMissionDecision(state, packet, review) {
  if (!packet.trigger) throw new Error("no Mission trigger to decide");
  if (!allowedMissionActions(state, packet.trigger).includes(review.action)) throw new Error("action is not allowed or its one-shot budget is exhausted");
  if (!FINDING_CLASSES.includes(review.classification) || !nonempty(review.reason)) throw new Error("review requires classification and reason");
  const required = { CONTINUE_CURRENT: "ARTIFACT", RESHAPE_SMALLER: "PLAN", RECON: "ENVIRONMENT" };
  if (required[review.action] && required[review.action] !== review.classification) throw new Error("action does not match classification");
  if (CONTINUE.has(review.action) && packet.edge.verdict === "CHECK") throw new Error("continuation requires an exact flow edge, not CHECK");
  const m = state.mission;
  m.decisions.push({ action: review.action, classification: review.classification, reason: review.reason,
    binding: packet.binding, step: state.totalSteps, evidence: review.evidence, reviewer: review.reviewer });
  m.acceptance = null;
  if (CONTINUE.has(review.action)) {
    m.signal = null;
    m.grant = { step: state.totalSteps, ...packet.edge };
  } else if (review.action === "STOP_SALVAGE") {
    state.status = "stopped";
    state.stoppedAt = new Date().toISOString();
  } else {
    m.signal = { classification: review.classification, reason: review.reason };
  }
}
