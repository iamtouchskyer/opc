const REPAIR_VERDICTS = new Set(["FAIL", "ITERATE"]);

function resolveLimits(state, template) {
  const limits = {};
  for (const name of ["maxTotalSteps", "maxLoopsPerEdge", "maxNodeReentry"]) {
    limits[name] = Object.hasOwn(state, name)
      ? state[name]
      : template.limits?.[name];
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      return { error: `${name} must be a positive integer` };
    }
  }
  return limits;
}

function readCount(map, edgeKey, label) {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { error: `${label} is invalid` };
  }
  const count = map[edgeKey] ?? 0;
  if (!Number.isInteger(count) || count < 0) {
    return { error: `${label} count is invalid for edge '${edgeKey}'` };
  }
  return { count };
}

function validateCountMap(map, label) {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { error: `${label} is invalid` };
  }
  for (const edgeKey of Object.keys(map)) {
    const result = readCount(map, edgeKey, label);
    if (result.error) return result;
  }
  return {};
}

export function isRepairVerdict(verdict) {
  return REPAIR_VERDICTS.has(String(verdict || "").toUpperCase());
}

export function repairEdgeCount(state, edgeKey) {
  if (Object.hasOwn(state, "repairEdgeCounts")) {
    return readCount(state.repairEdgeCounts, edgeKey, "repairEdgeCounts");
  }
  return readCount(state.edgeCounts ?? {}, edgeKey, "edgeCounts");
}

export function seedRepairEdgeCounts(state, template) {
  if (Object.hasOwn(state, "repairEdgeCounts")) {
    const existing = state.repairEdgeCounts;
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error("repairEdgeCounts is invalid");
    }
    for (const edgeKey of Object.keys(existing)) {
      const result = readCount(existing, edgeKey, "repairEdgeCounts");
      if (result.error) throw new Error(result.error);
    }
    return existing;
  }

  const seeded = {};
  for (const [from, edges] of Object.entries(template.edges || {})) {
    for (const [verdict, to] of Object.entries(edges || {})) {
      if (!isRepairVerdict(verdict) || to === null) continue;
      const edgeKey = `${from}→${to}`;
      const legacy = readCount(state.edgeCounts ?? {}, edgeKey, "edgeCounts");
      if (legacy.error) throw new Error(legacy.error);
      seeded[edgeKey] = legacy.count;
    }
  }
  state.repairEdgeCounts = seeded;
  return seeded;
}

export function evaluateFlowBudget({ state, template, from, to, verdict }) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return { allowed: false, reason: "state is invalid" };
  }
  const limits = resolveLimits(state, template);
  if (limits.error) return { allowed: false, reason: limits.error };
  if (!Number.isInteger(state.totalSteps) || state.totalSteps < 0) {
    return { allowed: false, reason: "totalSteps must be a non-negative integer" };
  }
  if (!Array.isArray(state.history)) {
    return { allowed: false, reason: "history is invalid" };
  }
  const traversalMap = validateCountMap(state.edgeCounts, "edgeCounts");
  if (traversalMap.error) return { allowed: false, reason: traversalMap.error };
  if (Object.hasOwn(state, "repairEdgeCounts")) {
    const repairMap = validateCountMap(state.repairEdgeCounts, "repairEdgeCounts");
    if (repairMap.error) return { allowed: false, reason: repairMap.error };
  }
  if (to === null) return { allowed: true, terminal: true };
  if (state.totalSteps >= limits.maxTotalSteps) {
    return { allowed: false, reason: `maxTotalSteps (${limits.maxTotalSteps}) reached` };
  }

  const edgeKey = `${from}→${to}`;
  const edgeCount = state.edgeCounts[edgeKey] ?? 0;

  let repairCount = 0;
  if (isRepairVerdict(verdict)) {
    const repairCounts = seedRepairEdgeCounts(state, template);
    repairCount = repairCounts[edgeKey] ?? 0;
    if (repairCount >= limits.maxLoopsPerEdge) {
      return {
        allowed: false,
        reason: `maxLoopsPerEdge (${limits.maxLoopsPerEdge}) reached for repair edge '${edgeKey}'`,
        edgeKey,
        repairCount,
      };
    }
  }

  const nodeEntries = state.history.filter((entry) => entry.nodeId === to).length;
  if (nodeEntries >= limits.maxNodeReentry) {
    return {
      allowed: false,
      reason: `maxNodeReentry (${limits.maxNodeReentry}) reached for node '${to}'`,
    };
  }

  return { allowed: true, edgeKey, edgeCount, repairCount };
}

export function nodeHasBudgetedExit({ state, template, node }) {
  const edges = Object.entries(template.edges?.[node] || {});
  const reasons = [];

  for (const [verdict, to] of edges) {
    if (verdict === "PASS" && to === null) {
      return { available: true, terminal: true };
    }
    if (to === null) continue;

    const result = evaluateFlowBudget({ state, template, from: node, to, verdict });
    if (result.allowed) return { available: true, verdict, to };
    reasons.push(result.reason);
  }

  return { available: false, reasons };
}
