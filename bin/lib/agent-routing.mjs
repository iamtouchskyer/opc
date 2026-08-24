// agent-routing.mjs — deterministic native-first routing advice for OPC roles.
//
// This resolver does not spawn Agents and does not assume every Codex host
// exposes a per-call model selector. It returns a model preference plus a
// host-auto fallback, leaving lifecycle management to Codex itself.

import { loadLayeredOpcConfig } from "./config-layering.mjs";
import { getFlag } from "./util.mjs";

export const DEFAULT_AGENT_ROUTING = Object.freeze({
  controlPlane: "codex-native",
  defaultTier: "auto",
  unknownModelPolicy: "host-auto",
  externalByDefault: false,
  models: Object.freeze({
    economy: "gpt-5.6-terra",
    standard: "gpt-5.6",
    frontier: "gpt-5.6",
    auto: null,
  }),
  reasoning: Object.freeze({
    economy: "medium",
    standard: "medium",
    frontier: "high",
    auto: "host-auto",
  }),
  taskShapes: Object.freeze({
    "read-heavy": "economy",
    routine: "economy",
    semantic: "standard",
    "high-risk": "frontier",
    "tool-only": "none",
  }),
  nodeTypes: Object.freeze({
    discussion: "auto",
    brief: "auto",
    build: "auto",
    review: "auto",
    execute: "none",
    hotfix: "standard",
    gate: "none",
  }),
  nodes: Object.freeze({
    "test-design": "economy",
    "e2e-user": "economy",
    "ux-simulation": "economy",
    "post-launch-sim": "economy",
  }),
  roles: Object.freeze({
    tester: "economy",
    "new-user": "economy",
    "active-user": "economy",
    "churned-user": "economy",
    "user-simulator": "economy",
  }),
  externalPlatforms: Object.freeze(["claude", "minimax", "opencode"]),
});

export class AgentRoutingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AgentRoutingError";
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRecord(base, override) {
  return { ...base, ...(isPlainObject(override) ? override : {}) };
}

export function normalizeAgentRouting(raw = {}) {
  const cfg = isPlainObject(raw) ? raw : {};
  return {
    ...DEFAULT_AGENT_ROUTING,
    ...cfg,
    models: mergeRecord(DEFAULT_AGENT_ROUTING.models, cfg.models),
    reasoning: mergeRecord(DEFAULT_AGENT_ROUTING.reasoning, cfg.reasoning),
    taskShapes: mergeRecord(DEFAULT_AGENT_ROUTING.taskShapes, cfg.taskShapes),
    nodeTypes: mergeRecord(DEFAULT_AGENT_ROUTING.nodeTypes, cfg.nodeTypes),
    nodes: mergeRecord(DEFAULT_AGENT_ROUTING.nodes, cfg.nodes),
    roles: mergeRecord(DEFAULT_AGENT_ROUTING.roles, cfg.roles),
    externalPlatforms: Array.isArray(cfg.externalPlatforms)
      ? cfg.externalPlatforms.filter(value => typeof value === "string" && value.trim())
      : [...DEFAULT_AGENT_ROUTING.externalPlatforms],
  };
}

function validateIdentifier(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentRoutingError("INVALID_ROUTE_INPUT", `${label} must be a non-empty string`, { [label]: value });
  }
  const trimmed = value.trim();
  if (trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new AgentRoutingError("INVALID_ROUTE_INPUT", `${label} contains invalid characters or is too long`, { [label]: value });
  }
  return trimmed;
}

function resolveTier(routing, { node, nodeType, role, taskShape }) {
  if (taskShape && Object.hasOwn(routing.taskShapes, taskShape)) {
    return { tier: routing.taskShapes[taskShape], source: `taskShape:${taskShape}` };
  }
  if (role && Object.hasOwn(routing.roles, role)) {
    return { tier: routing.roles[role], source: `role:${role}` };
  }
  if (Object.hasOwn(routing.nodes, node)) {
    return { tier: routing.nodes[node], source: `node:${node}` };
  }
  if (Object.hasOwn(routing.nodeTypes, nodeType)) {
    return { tier: routing.nodeTypes[nodeType], source: `nodeType:${nodeType}` };
  }
  return { tier: routing.defaultTier, source: "defaultTier" };
}

export function resolveAgentRoute({
  node,
  nodeType,
  role = null,
  taskShape = null,
  requestedPlatform = null,
  explicitThirdParty = false,
  config = {},
}) {
  const safeNode = validateIdentifier(node, "node");
  const safeNodeType = validateIdentifier(nodeType, "nodeType");
  const safeRole = role == null ? null : validateIdentifier(role, "role");
  const safeTaskShape = taskShape == null ? null : validateIdentifier(taskShape, "taskShape");
  const routing = normalizeAgentRouting(config.agentRouting);

  if (safeTaskShape && !Object.hasOwn(routing.taskShapes, safeTaskShape)) {
    throw new AgentRoutingError(
      "TASK_SHAPE_UNSUPPORTED",
      `task shape '${safeTaskShape}' is not configured`,
      { taskShape: safeTaskShape, allowed: Object.keys(routing.taskShapes) },
    );
  }

  if (requestedPlatform != null) {
    const platform = validateIdentifier(requestedPlatform, "requestedPlatform").toLowerCase();
    if (!routing.externalPlatforms.map(item => item.toLowerCase()).includes(platform)) {
      throw new AgentRoutingError(
        "EXTERNAL_PLATFORM_UNSUPPORTED",
        `external platform '${platform}' is not configured`,
        { platform, allowed: routing.externalPlatforms },
      );
    }
    if (!explicitThirdParty) {
      throw new AgentRoutingError(
        "EXPLICIT_THIRD_PARTY_REQUIRED",
        `external platform '${platform}' requires an explicit user request`,
        { platform },
      );
    }
    return {
      ok: true,
      dispatch: true,
      controlPlane: "external-cli",
      externalPlatform: platform,
      explicitThirdParty: true,
      node: safeNode,
      nodeType: safeNodeType,
      role: safeRole,
      taskShape: safeTaskShape,
      configSource: config._source?.agentRouting || "default",
    };
  }

  const { tier: rawTier, source } = resolveTier(routing, {
    node: safeNode,
    nodeType: safeNodeType,
    role: safeRole,
    taskShape: safeTaskShape,
  });
  let tier = validateIdentifier(rawTier, "tier");

  if (tier === "none") {
    return {
      ok: true,
      dispatch: false,
      controlPlane: "orchestrator-tools",
      node: safeNode,
      nodeType: safeNodeType,
      role: safeRole,
      taskShape: safeTaskShape,
      tier,
      modelPreference: null,
      reasoningEffort: null,
      selection: "none",
      source,
      configSource: config._source?.agentRouting || "default",
    };
  }

  if (!Object.hasOwn(routing.models, tier)) {
    if (routing.unknownModelPolicy !== "host-auto") {
      throw new AgentRoutingError("MODEL_TIER_UNRESOLVED", `no model mapping for tier '${tier}'`, { tier, source });
    }
    tier = "auto";
  }

  const modelPreference = routing.models[tier] || null;
  const reasoningEffort = routing.reasoning[tier] || "host-auto";
  return {
    ok: true,
    dispatch: true,
    controlPlane: "codex-native",
    externalPlatform: null,
    explicitThirdParty: false,
    node: safeNode,
    nodeType: safeNodeType,
    role: safeRole,
    taskShape: safeTaskShape,
    tier,
    modelPreference,
    reasoningEffort,
    selection: modelPreference ? "prefer-if-host-selectable-else-auto" : "host-auto",
    source,
    configSource: config._source?.agentRouting || "default",
  };
}

export function cmdAgentRoute(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.error("Usage: opc-harness agent-route --node <id> --node-type <type> [--role <name>] [--task-shape <read-heavy|routine|semantic|high-risk|tool-only>] [--dir <project>] [--external-platform <name> --explicit-third-party]");
    return;
  }

  const anchorDir = getFlag(args, "dir", process.cwd());
  const config = loadLayeredOpcConfig(anchorDir, {});
  try {
    const route = resolveAgentRoute({
      node: getFlag(args, "node"),
      nodeType: getFlag(args, "node-type"),
      role: getFlag(args, "role"),
      taskShape: getFlag(args, "task-shape"),
      requestedPlatform: getFlag(args, "external-platform"),
      explicitThirdParty: args.includes("--explicit-third-party"),
      config,
    });
    console.log(JSON.stringify(route, null, 2));
  } catch (error) {
    if (!(error instanceof AgentRoutingError)) throw error;
    console.log(JSON.stringify({
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    }, null, 2));
    process.exitCode = 2;
  }
}
