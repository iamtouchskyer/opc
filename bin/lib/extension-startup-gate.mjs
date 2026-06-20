import { existsSync, readFileSync } from "fs";
import { join } from "path";

function normalizeCapability(cap) {
  if (typeof cap !== "string" || cap.length === 0) return null;
  if (/^[a-z][a-z0-9-]*@[1-9]\d*$/.test(cap)) return cap;
  if (/^[a-z][a-z0-9-]*$/.test(cap)) return `${cap}@1`;
  return cap;
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

function requestedCaps(entries, template) {
  const caps = new Set();
  for (const entry of entries) {
    for (const cap of template.nodeCapabilities?.[entry.nodeId] || []) {
      const normalized = normalizeCapability(cap);
      if (normalized) caps.add(normalized);
    }
  }
  return caps;
}

function failureCaps(failure) {
  return [
    ...(Array.isArray(failure.provides) ? failure.provides : []),
    ...(Array.isArray(failure.disabledCapabilities) ? failure.disabledCapabilities : []),
  ].map(normalizeCapability).filter(Boolean);
}

function readStartupFailures(dir) {
  const path = join(dir, ".ext-registry.json");
  if (!existsSync(path)) return { failures: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return { failures: Array.isArray(data.startupFailures) ? data.startupFailures : [] };
  } catch (err) {
    return { error: `.ext-registry.json unreadable: ${err.message}` };
  }
}

export function collectExtensionStartupReasons(dir, state, template, currentNode) {
  const loaded = readStartupFailures(dir);
  if (loaded.error) return [loaded.error];
  if (loaded.failures.length === 0) return [];

  const requested = requestedCaps(upstreamEntries(state, template, currentNode), template);
  if (requested.size === 0) return [];

  const reasons = [];
  for (const failure of loaded.failures) {
    const impacted = failureCaps(failure).filter(cap => requested.has(cap));
    if (impacted.length === 0) continue;
    reasons.push(
      `extension startup failed for requested capability ${impacted.join(", ")}: ` +
      `${failure.ext || "unknown"}.startup.check [${failure.kind || "error"}] ${failure.message || ""}`
    );
  }
  return reasons;
}
