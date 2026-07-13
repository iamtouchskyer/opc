// model-routing.mjs — deterministic model selection for every OPC subagent.
//
// Claude Code defaults an omitted subagent model to the parent model. That is
// convenient, but a multi-agent flow can accidentally multiply premium-model
// usage. This resolver keeps flow/role topology unchanged while making the
// model choice explicit, inspectable, and configurable.

import { loadLayeredOpcConfig } from "./config-layering.mjs";
import { getFlag } from "./util.mjs";

export const DEFAULT_AGENT_ROUTING = Object.freeze({
  defaultTier: "standard",
  unknownModelPolicy: "deny",
  allowPremiumByDefault: false,
  models: Object.freeze({
    economy: "haiku",
    standard: "sonnet",
    premium: "inherit",
  }),
  nodeTypes: Object.freeze({
    discussion: "standard",
    brief: "standard",
    build: "standard",
    review: "standard",
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
  premiumModels: Object.freeze(["inherit", "opus"]),
});

export class ModelRoutingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ModelRoutingError";
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
    nodeTypes: mergeRecord(DEFAULT_AGENT_ROUTING.nodeTypes, cfg.nodeTypes),
    nodes: mergeRecord(DEFAULT_AGENT_ROUTING.nodes, cfg.nodes),
    roles: mergeRecord(DEFAULT_AGENT_ROUTING.roles, cfg.roles),
    premiumModels: Array.isArray(cfg.premiumModels)
      ? cfg.premiumModels.filter(v => typeof v === "string" && v.trim())
      : [...DEFAULT_AGENT_ROUTING.premiumModels],
  };
}

function validateIdentifier(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ModelRoutingError("INVALID_ROUTE_INPUT", `${label} must be a non-empty string`, { [label]: value });
  }
  const trimmed = value.trim();
  if (trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ModelRoutingError("INVALID_ROUTE_INPUT", `${label} contains invalid characters or is too long`, { [label]: value });
  }
  return trimmed;
}

function resolveTier(routing, { node, nodeType, role }) {
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

function modelIsPremium(model, tier, routing) {
  if (tier === "premium") return true;
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return true;
  return routing.premiumModels.some(item => item.toLowerCase() === lower);
}

/**
 * Resolve a route without reading the filesystem. Useful for tests and hosts
 * that already have a merged config object.
 */
export function resolveModelRoute({
  node,
  nodeType,
  role = null,
  config = {},
  env = process.env,
  allowPremium = false,
}) {
  const safeNode = validateIdentifier(node, "node");
  const safeNodeType = validateIdentifier(nodeType, "nodeType");
  const safeRole = role == null ? null : validateIdentifier(role, "role");
  const routing = normalizeAgentRouting(config.agentRouting);
  const { tier: rawTier, source } = resolveTier(routing, {
    node: safeNode,
    nodeType: safeNodeType,
    role: safeRole,
  });
  const tier = validateIdentifier(rawTier, "tier");

  if (tier === "none") {
    return {
      ok: true,
      dispatch: false,
      node: safeNode,
      nodeType: safeNodeType,
      role: safeRole,
      tier,
      model: null,
      source,
      configSource: config._source?.agentRouting || "default",
      envOverride: false,
      premium: false,
      premiumApproved: false,
      warnings: [],
    };
  }

  let model = routing.models[tier];
  if ((model == null || model === "") && routing.unknownModelPolicy === "inherit") {
    model = "inherit";
  }
  if (model == null || model === "") {
    throw new ModelRoutingError(
      "MODEL_UNRESOLVED",
      `no model configured for tier '${tier}'`,
      { tier, source, unknownModelPolicy: routing.unknownModelPolicy },
    );
  }
  model = validateIdentifier(model, "model");

  const envModel = typeof env.CLAUDE_CODE_SUBAGENT_MODEL === "string"
    ? env.CLAUDE_CODE_SUBAGENT_MODEL.trim()
    : "";
  const warnings = [];
  let effectiveSource = source;
  let envOverride = false;
  if (envModel) {
    model = validateIdentifier(envModel, "CLAUDE_CODE_SUBAGENT_MODEL");
    effectiveSource = "env:CLAUDE_CODE_SUBAGENT_MODEL";
    envOverride = true;
    warnings.push("CLAUDE_CODE_SUBAGENT_MODEL overrides OPC per-dispatch model selection");
  }

  const premium = modelIsPremium(model, tier, routing);
  const premiumApproved = Boolean(allowPremium || routing.allowPremiumByDefault === true || envOverride);
  if (premium && !premiumApproved) {
    throw new ModelRoutingError(
      "PREMIUM_APPROVAL_REQUIRED",
      `model '${model}' requires explicit premium approval`,
      { tier, model, source: effectiveSource },
    );
  }

  return {
    ok: true,
    dispatch: true,
    node: safeNode,
    nodeType: safeNodeType,
    role: safeRole,
    tier,
    model,
    source: effectiveSource,
    configSource: config._source?.agentRouting || "default",
    envOverride,
    premium,
    premiumApproved,
    warnings,
  };
}

export function cmdModelRoute(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.error("Usage: opc-harness model-route --node <id> --node-type <type> [--role <name>] [--dir <project>] [--allow-premium]");
    console.error("Resolves the explicit host-native model for one subagent dispatch.");
    return;
  }

  const node = getFlag(args, "node");
  const nodeType = getFlag(args, "node-type");
  const role = getFlag(args, "role");
  const anchorDir = getFlag(args, "dir", process.cwd());
  const config = loadLayeredOpcConfig(anchorDir, {});

  try {
    const route = resolveModelRoute({
      node,
      nodeType,
      role,
      config,
      allowPremium: args.includes("--allow-premium"),
    });
    console.log(JSON.stringify(route, null, 2));
  } catch (err) {
    if (!(err instanceof ModelRoutingError)) throw err;
    console.log(JSON.stringify({
      ok: false,
      error: { code: err.code, message: err.message, details: err.details },
    }, null, 2));
    process.exitCode = 2;
  }
}
