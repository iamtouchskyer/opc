export function isRepairVerdict(verdict) {
  return verdict === "FAIL" || verdict === "ITERATE";
}

export function flowLimits(state, template) {
  return {
    maxTotalSteps: state.maxTotalSteps ?? template.limits.maxTotalSteps,
    maxLoopsPerEdge: state.maxLoopsPerEdge ?? template.limits.maxLoopsPerEdge,
    maxNodeReentry: state.maxNodeReentry ?? template.limits.maxNodeReentry,
  };
}

export function transitionBudgetVerdict({ state, template, from, to, verdict }) {
  const limits = flowLimits(state, template);
  if (state.totalSteps >= limits.maxTotalSteps) {
    return { allowed: false, reason: `maxTotalSteps (${limits.maxTotalSteps}) reached` };
  }

  const edgeKey = `${from}\u2192${to}`;
  const edgeCount = state.edgeCounts?.[edgeKey] || 0;
  if (isRepairVerdict(verdict) && edgeCount >= limits.maxLoopsPerEdge) {
    return {
      allowed: false,
      reason: `maxLoopsPerEdge (${limits.maxLoopsPerEdge}) reached for edge '${edgeKey}'`,
    };
  }

  if (to !== null) {
    const nodeEntries = state.history.filter((h) => h.nodeId === to).length;
    if (nodeEntries >= limits.maxNodeReentry) {
      return {
        allowed: false,
        reason: `maxNodeReentry (${limits.maxNodeReentry}) reached for node '${to}'`,
      };
    }
  }

  return { allowed: true, edgeKey, edgeCount };
}

export function gotoExitBudgetVerdict({ state, template, targetNode }) {
  const edges = template.edges[targetNode] || {};
  const exits = Object.entries(edges).filter(([, next]) => next !== null);
  if (exits.length === 0) return { allowed: true };

  const nextState = {
    ...state,
    totalSteps: (state.totalSteps || 0) + 1,
    history: [...state.history, { nodeId: targetNode }],
    edgeCounts: { ...(state.edgeCounts || {}) },
  };
  const blocked = [];
  for (const [verdict, next] of exits) {
    const budget = transitionBudgetVerdict({
      state: nextState, template, from: targetNode, to: next, verdict,
    });
    if (budget.allowed) return { allowed: true };
    blocked.push(`${verdict}->${next}: ${budget.reason}`);
  }

  return {
    allowed: false,
    reason: `all exits from '${targetNode}' are exhausted: ${blocked.join("; ")}`,
  };
}
