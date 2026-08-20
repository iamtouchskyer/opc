import { existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";
import { resolveCurrentRun } from "./runaway-guard.mjs";

export function isRunId(value) {
  return typeof value === "string" && /^run_\d+$/.test(value);
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseHandshakeFile(path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { error: `${path}: corrupt/parse error: ${error.message}` };
  }
  if (!isPlainObject(data)) {
    return { error: `${path}: root must be a non-null object` };
  }
  return { data };
}

export function handshakeIdentityErrors(data, nodeId, runId) {
  const errors = [];
  if (data.nodeId !== nodeId) {
    errors.push(`nodeId is '${data.nodeId}', expected '${nodeId}'`);
  }
  if (data.runId !== runId) {
    errors.push(`runId is '${data.runId}', expected '${runId}'`);
  }
  if (typeof data.status !== "string" || data.status.length === 0) {
    errors.push("status missing or invalid");
  }
  return errors;
}

export function resolveExactRunHandshake(dir, nodeId, runId) {
  if (!isRunId(runId)) {
    return { path: null, data: null, error: `invalid runId '${runId}' for node '${nodeId}'` };
  }
  const nodeDir = join(dir, "nodes", nodeId);
  const runPath = join(nodeDir, runId, "handshake.json");
  if (!existsSync(runPath)) return { path: runPath, data: null, error: null, missing: true };
  const parsed = parseHandshakeFile(runPath);
  if (parsed.error) return { path: runPath, data: null, error: parsed.error };
  const errors = handshakeIdentityErrors(parsed.data, nodeId, runId);
  return errors.length > 0
    ? { path: runPath, data: parsed.data, error: `${runPath}: ${errors.join("; ")}` }
    : { path: runPath, data: parsed.data, error: null };
}

export function sessionAuthorityErrors(state) {
  const errors = [];
  if (!isPlainObject(state)) return ["flow-state.json must contain an object"];
  if (typeof state.currentNode !== "string" || state.currentNode.length === 0) {
    errors.push("flow-state.json currentNode missing or invalid");
  }
  if (!Array.isArray(state.history)) {
    errors.push("flow-state.json history must be an array");
    return errors;
  }
  state.history.forEach((entry, i) => {
    const nodeId = entry?.nodeId || entry?.node;
    const runId = entry?.runId || entry?.run;
    if (typeof nodeId !== "string" || nodeId.length === 0) {
      errors.push(`flow-state.json history[${i}].nodeId missing or invalid`);
    }
    if (!isRunId(runId)) {
      errors.push(`flow-state.json history[${i}].runId missing or invalid`);
    }
  });
  const current = resolveCurrentRun(state);
  if (!current) errors.push(`cannot resolve current run for '${state.currentNode || "unknown"}'`);
  return errors;
}

export function readSessionAuthority(dir) {
  const statePath = join(dir, "flow-state.json");
  if (!existsSync(statePath)) return { exists: false, state: null, error: null };
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    return { exists: true, state: null, error: `cannot parse flow-state.json: ${error.message}` };
  }
  const errors = sessionAuthorityErrors(state);
  if (errors.length > 0) return { exists: true, state: null, error: errors.join("; ") };
  return { exists: true, state, error: null };
}

export function authoritativeEntries(state, { includeCurrent = true } = {}) {
  const entries = [];
  const seen = new Set();
  const add = (entry) => {
    const nodeId = entry?.nodeId || entry?.node;
    const runId = entry?.runId || entry?.run;
    if (typeof nodeId !== "string" || nodeId.length === 0 || !isRunId(runId)) return false;
    const key = `${nodeId}\0${runId}`;
    if (seen.has(key)) return true;
    entries.push({ nodeId, runId });
    seen.add(key);
    return true;
  };

  if (state?.entryNode) add({ nodeId: state.entryNode, runId: "run_1" });
  for (const entry of state?.history || []) add(entry);
  if (includeCurrent) {
    const current = resolveCurrentRun(state);
    if (current) add({ nodeId: state.currentNode, runId: current.runId });
  }
  return entries;
}

export function latestAuthoritativeRunByNode(state) {
  const map = new Map();
  for (const entry of authoritativeEntries(state)) map.set(entry.nodeId, entry.runId);
  return map;
}

export function expectedRunForNode(state, nodeId) {
  return latestAuthoritativeRunByNode(state).get(nodeId) || null;
}

export function canonicalHandshakePath(dir, nodeId) {
  return join(dir, "nodes", nodeId, "handshake.json");
}

const NODE_LEVEL_ARTIFACTS = new Set([
  "build-brief.md",
  "test-plan.md",
  "test-execution.json",
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isPlainObject(value)) return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function canonicalArtifactPath(path, runId, context = {}) {
  if (typeof path !== "string") return path;
  let normalized = path;
  while (normalized.startsWith("../")) normalized = normalized.slice(3);
  if (/^run_\d+\//.test(normalized)) return normalized;
  if (NODE_LEVEL_ARTIFACTS.has(normalized)) {
    const nodePath = context.nodeDir ? join(context.nodeDir, normalized) : null;
    const runPath = context.runDir ? join(context.runDir, normalized) : null;
    if (nodePath && existsSync(nodePath) && (!runPath || !existsSync(runPath))) return normalized;
  }
  if (normalized.startsWith("/") || normalized.startsWith("./")) return normalized;
  return `${runId}/${normalized}`;
}

function artifactPathSegments(path) {
  return String(path).split(/[\\/]+/);
}

function validateExactArtifactPath(path, runId) {
  if (typeof path !== "string" || path.length === 0) return "path missing or invalid";
  if (path.includes("\0") || isAbsolute(path) || path.startsWith("./")) return `path '${path}' must be a clean relative path`;
  const segments = artifactPathSegments(path);
  if (segments.includes("..")) {
    if (path.startsWith("../") && NODE_LEVEL_ARTIFACTS.has(path.slice(3)) && segments.length === 2) return null;
    return `path '${path}' contains traversal`;
  }
  if (/^run_\d+\//.test(path)) return `exact artifact path '${path}' must be run-relative, not run_N-prefixed`;
  return null;
}

function validateCanonicalArtifactPath(path, runId) {
  if (typeof path !== "string" || path.length === 0) return "path missing or invalid";
  if (path.includes("\0") || isAbsolute(path) || path.startsWith("./")) return `path '${path}' must be a clean relative path`;
  const segments = artifactPathSegments(path);
  if (segments.includes("..")) return `path '${path}' contains traversal`;
  if (NODE_LEVEL_ARTIFACTS.has(path)) return null;
  const prefix = `${runId}/`;
  if (!path.startsWith(prefix)) return `canonical artifact path '${path}' must start with '${prefix}'`;
  const rest = path.slice(prefix.length);
  if (!rest || rest.startsWith("./") || artifactPathSegments(rest).includes("..")) {
    return `canonical artifact path '${path}' has invalid run-relative suffix`;
  }
  if (/^run_\d+\//.test(rest)) return `canonical artifact path '${path}' has duplicate run_N prefix`;
  return null;
}

function artifactPathErrors(handshake, runId, kind) {
  const errors = [];
  if (!Array.isArray(handshake?.artifacts)) return errors;
  const validator = kind === "canonical" ? validateCanonicalArtifactPath : validateExactArtifactPath;
  for (const [index, artifact] of handshake.artifacts.entries()) {
    const error = validator(artifact?.path, runId);
    if (error) errors.push(`${kind} artifacts[${index}]: ${error}`);
  }
  return errors;
}

function normalizeProjection(value, runId, key = "", context = {}) {
  if (Array.isArray(value)) {
    const items = value.map((item) => normalizeProjection(item, runId, "", context));
    return key === "artifacts" ? items.sort((a, b) => stableJson(a).localeCompare(stableJson(b))) : items;
  }
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const k of Object.keys(value).sort()) {
    out[k] = normalizeProjection(value[k], runId, k, context);
  }
  if (key === "" && Array.isArray(out.artifacts)) {
    out.artifacts = normalizeProjection(out.artifacts, runId, "artifacts", context);
  }
  if (Object.hasOwn(out, "path")) out.path = canonicalArtifactPath(out.path, runId, context);
  return out;
}

function firstProjectionDiff(canonical, exact, path = "$") {
  if (stableJson(canonical) === stableJson(exact)) return null;
  if (Array.isArray(canonical) || Array.isArray(exact)) {
    if (!Array.isArray(canonical) || !Array.isArray(exact)) return `${path}: type mismatch`;
    if (canonical.length !== exact.length) return `${path}: canonical length ${canonical.length} != exact length ${exact.length}`;
    for (let i = 0; i < canonical.length; i++) {
      const diff = firstProjectionDiff(canonical[i], exact[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return `${path}: array mismatch`;
  }
  if (!isPlainObject(canonical) || !isPlainObject(exact)) {
    return `${path}: canonical ${JSON.stringify(canonical)} != exact ${JSON.stringify(exact)}`;
  }
  const keys = [...new Set([...Object.keys(canonical), ...Object.keys(exact)])].sort();
  for (const key of keys) {
    if (!Object.hasOwn(canonical, key)) return `${path}.${key}: missing from canonical`;
    if (!Object.hasOwn(exact, key)) return `${path}.${key}: missing from exact`;
    const diff = firstProjectionDiff(canonical[key], exact[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return `${path}: object mismatch`;
}

export function canonicalProjectionErrors(dir, state, validateCanonical = null, options = {}) {
  const errors = [];
  const entries = options.entries
    ? new Map(options.entries.map((entry) => [entry.nodeId, entry.runId]))
    : latestAuthoritativeRunByNode(state);
  for (const [nodeId, runId] of entries) {
    const path = canonicalHandshakePath(dir, nodeId);
    if (!existsSync(path)) continue;
    const exact = resolveExactRunHandshake(dir, nodeId, runId);
    if (exact.error) {
      errors.push(`${nodeId}/${runId}: exact ${exact.error}`);
      continue;
    }
    if (exact.missing || !exact.path || !existsSync(exact.path)) {
      errors.push(`${nodeId}/${runId}: exact handshake missing at ${exact.path}`);
      continue;
    }
    const parsed = parseHandshakeFile(path);
    if (parsed.error) {
      errors.push(`${nodeId}/${runId}: canonical ${parsed.error}`);
      continue;
    }
    const identityErrors = handshakeIdentityErrors(parsed.data, nodeId, runId);
    if (identityErrors.length > 0) {
      errors.push(`${nodeId}/${runId}: canonical ${path}: ${identityErrors.join("; ")}`);
    }
    if (validateCanonical) {
      const schemaErrors = validateCanonical(parsed.data, path, nodeId, runId);
      errors.push(...schemaErrors.map((error) => `${nodeId}/${runId}: canonical ${error}`));
    }
    errors.push(...artifactPathErrors(parsed.data, runId, "canonical").map((error) => `${nodeId}/${runId}: ${error}`));
    errors.push(...artifactPathErrors(exact.data, runId, "exact").map((error) => `${nodeId}/${runId}: ${error}`));
    const nodeDir = join(dir, "nodes", nodeId);
    const context = { nodeDir, runDir: join(nodeDir, runId) };
    const canonicalProjection = normalizeProjection(parsed.data, runId, "", context);
    const exactProjection = normalizeProjection(exact.data, runId, "", context);
    const diff = firstProjectionDiff(canonicalProjection, exactProjection);
    if (diff) {
      errors.push(`${nodeId}/${runId}: canonical ${path} is not exact-run projection of ${exact.path}: ${diff}`);
    }
  }
  return errors;
}
