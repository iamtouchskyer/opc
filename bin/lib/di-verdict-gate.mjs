import { existsSync, readFileSync } from "fs";
import { join } from "path";

function upstreamEntries(state, template, currentNode) {
  let lastGateIdx = -1;
  for (let i = state.history.length - 1; i >= 0; i--) {
    const entry = state.history[i];
    if (template.nodeTypes?.[entry.nodeId] === "gate" && entry.nodeId !== currentNode) {
      lastGateIdx = i;
      break;
    }
  }
  const slice = lastGateIdx === -1 ? state.history : state.history.slice(lastGateIdx + 1);
  return slice.filter(entry => template.nodeTypes?.[entry.nodeId] !== "gate");
}

function latestRunEntries(entries) {
  const seen = new Set();
  const latest = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry.runId || seen.has(entry.nodeId)) continue;
    seen.add(entry.nodeId);
    latest.unshift(entry);
  }
  return latest;
}

function readVerdict(path) {
  try {
    return { data: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { error: `${path} unreadable: ${err.message}` };
  }
}

function safeInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function verdictReason(entry, verdict) {
  const aiErrors = safeInt(verdict.aiSmellErrors ?? verdict.ai_smell_errors);
  if (aiErrors > 0) {
    return `DI AI smell verdict failed in ${entry.nodeId}/${entry.runId}: ${aiErrors} error(s)`;
  }
  const recommendation = typeof verdict.recommendation === "string"
    ? verdict.recommendation.toUpperCase()
    : null;
  if (verdict.pass === false || (recommendation && recommendation !== "PASS")) {
    return `DI verdict failed in ${entry.nodeId}/${entry.runId}: ${verdict.recommendation || "non-PASS"}`;
  }
  return null;
}

export function collectDiVerdictReasons(dir, state, template, currentNode) {
  const reasons = [];
  const entries = latestRunEntries(upstreamEntries(state, template, currentNode));
  for (const entry of entries) {
    const path = join(dir, "nodes", entry.nodeId, entry.runId, "ext-design-intelligence", "verdict.json");
    if (!existsSync(path)) continue;
    const loaded = readVerdict(path);
    if (loaded.error) {
      reasons.push(`DI verdict unreadable in ${entry.nodeId}/${entry.runId} — fail-closed`);
      continue;
    }
    const reason = verdictReason(entry, loaded.data || {});
    if (reason) reasons.push(reason);
  }
  return reasons;
}
