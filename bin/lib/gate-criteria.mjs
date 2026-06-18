import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";

function readJson(path) {
  try {
    return { data: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { error: `${path} unreadable: ${err.message}` };
  }
}

function jsonPathValue(data, path) {
  if (typeof path !== "string" || !path.startsWith("$.")) return { missing: true };
  let current = data;
  for (const key of path.slice(2).split(".")) {
    if (!key || current == null || typeof current !== "object" || !(key in current)) {
      return { missing: true };
    }
    current = current[key];
  }
  return { value: current };
}

function compare(actual, operator, expected) {
  if (operator === "==") return actual === expected;
  if (operator === "!=") return actual !== expected;
  if (operator === "<") return Number(actual) < Number(expected);
  if (operator === "<=") return Number(actual) <= Number(expected);
  if (operator === ">") return Number(actual) > Number(expected);
  if (operator === ">=") return Number(actual) >= Number(expected);
  return false;
}

function sourcePath(baseDir, source) {
  if (typeof source !== "string" || source.length === 0) return null;
  return source.startsWith("/") ? source : resolve(baseDir, source);
}

function evaluateCheck(check, baseDir) {
  const id = check?.id || "unnamed";
  const path = sourcePath(baseDir, check?.source);
  if (!path || !existsSync(path)) return `${id}: source missing: ${check?.source || ""}`;
  const loaded = readJson(path);
  if (loaded.error) return `${id}: ${loaded.error}`;
  const picked = jsonPathValue(loaded.data, check?.path);
  if (picked.missing) return `${id}: path missing: ${check?.path || ""}`;
  if (!compare(picked.value, check?.operator, check?.threshold)) {
    return `${id}: ${check?.path} ${picked.value} does not satisfy ${check?.operator} ${check?.threshold}`;
  }
  return null;
}

function evaluateCriteriaFile(path) {
  const loaded = readJson(path);
  if (loaded.error) return [loaded.error];
  const checks = loaded.data?.checks;
  if (!Array.isArray(checks) || checks.length === 0) {
    return [`${path}: checks must be a non-empty array`];
  }
  return checks.map(check => evaluateCheck(check, dirname(path))).filter(Boolean);
}

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

export function findGateCriteriaFiles(dir, state, template, currentNode) {
  const paths = new Set();
  const rootCriteria = join(dir, "gate-criteria.json");
  if (existsSync(rootCriteria)) paths.add(rootCriteria);
  const entries = upstreamEntries(state, template, currentNode);
  for (const entry of entries) {
    const nodeDir = join(dir, "nodes", entry.nodeId);
    const nodeCriteria = join(nodeDir, "gate-criteria.json");
    if (existsSync(nodeCriteria)) paths.add(nodeCriteria);
  }
  for (const entry of latestRunEntries(entries)) {
    const nodeDir = join(dir, "nodes", entry.nodeId);
    const runCriteria = join(nodeDir, entry.runId, "gate-criteria.json");
    if (entry.runId && existsSync(runCriteria)) paths.add(runCriteria);
  }
  return [...paths];
}

export function collectGateCriteriaReasons(dir, state, template, currentNode) {
  const reasons = [];
  for (const file of findGateCriteriaFiles(dir, state, template, currentNode)) {
    reasons.push(...evaluateCriteriaFile(file));
  }
  return reasons;
}
