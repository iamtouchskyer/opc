// Flow core commands: route, init, validate, validateHandshakeData, validate-context
// Depends on: flow-templates.mjs, viz-commands.mjs (getMarker), util.mjs

import { readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "crypto";
import { FLOW_TEMPLATES } from "./flow-templates.mjs";
import { getMarker } from "./viz-commands.mjs";
import {
  getFlag, resolveDir, atomicWriteSync,
  VALID_NODE_TYPES, VALID_STATUSES, VALID_VERDICTS, EVIDENCE_TYPES,
  WRITER_SIG,
} from "./util.mjs";

// ─── route ──────────────────────────────────────────────────────

export function cmdRoute(args) {
  const node = getFlag(args, "node");
  const verdict = getFlag(args, "verdict");
  const flow = getFlag(args, "flow");

  if (!node || !verdict || !flow) {
    console.error("Usage: opc-harness route --node <gateId> --verdict <PASS|FAIL|ITERATE> --flow <template>");
    process.exit(1);
  }

  const template = FLOW_TEMPLATES[flow];
  if (!template) {
    console.log(JSON.stringify({ next: null, valid: false, error: `unknown flow template: ${flow}` }));
    return;
  }

  if (!template.nodes.includes(node)) {
    console.log(JSON.stringify({ next: null, valid: false, error: `node '${node}' not in flow '${flow}'` }));
    return;
  }

  const nodeEdges = template.edges[node];
  if (!nodeEdges || !(verdict in nodeEdges)) {
    console.log(JSON.stringify({ next: null, valid: false, error: `no edge for verdict '${verdict}' from node '${node}' in flow '${flow}'` }));
    return;
  }

  console.log(JSON.stringify({ next: nodeEdges[verdict], valid: true }));
}

// ─── init ───────────────────────────────────────────────────────

export function cmdInit(args) {
  const flow = getFlag(args, "flow");
  const entry = getFlag(args, "entry");
  const dir = resolveDir(args);

  if (!flow) {
    console.error("Usage: opc-harness init --flow <template> --entry <nodeId> --dir <path>");
    process.exit(1);
  }

  const template = FLOW_TEMPLATES[flow];
  if (!template) {
    console.log(JSON.stringify({ created: false, error: `unknown flow template: ${flow}` }));
    return;
  }

  const entryNode = entry || template.nodes[0];
  if (!template.nodes.includes(entryNode)) {
    console.log(JSON.stringify({ created: false, error: `entry node '${entryNode}' not in flow '${flow}'` }));
    return;
  }

  const statePath = join(dir, "flow-state.json");
  const force = args.includes("--force");
  if (existsSync(statePath) && !force) {
    console.log(JSON.stringify({ created: false, error: "flow-state.json already exists (use --force to overwrite)" }));
    return;
  }

  mkdirSync(join(dir, "nodes"), { recursive: true });

  const state = {
    version: "1.0",
    flowTemplate: flow,
    currentNode: entryNode,
    entryNode,
    totalSteps: 0,
    maxTotalSteps: template.limits.maxTotalSteps,
    maxLoopsPerEdge: template.limits.maxLoopsPerEdge,
    maxNodeReentry: template.limits.maxNodeReentry,
    history: [],
    edgeCounts: {},
    _written_by: WRITER_SIG,
    _last_modified: new Date().toISOString(),
    _write_nonce: createHash("sha256")
      .update(Date.now().toString() + Math.random().toString())
      .digest("hex").slice(0, 16),
  };

  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

  // Print initial flow viz to stderr
  const vizLines = [""];
  for (let i = 0; i < template.nodes.length; i++) {
    const id = template.nodes[i];
    const m = getMarker(id, state);
    let line = `  ${m} ${id}`;
    const edges = template.edges[id];
    if (edges && edges.FAIL) line += `  ← FAIL → ${edges.FAIL}`;
    vizLines.push(line);
    if (i < template.nodes.length - 1) vizLines.push("  │");
  }
  vizLines.push("");
  console.error(vizLines.join("\n"));

  console.log(JSON.stringify({ created: true, flow, entry: entryNode }));
}

// ─── validate ───────────────────────────────────────────────────

/**
 * Shared handshake validation logic — used by both cmdValidate and pre-transition check.
 */
export function validateHandshakeData(data, opts = {}) {
  const errors = [];
  const warnings = [];

  for (const field of ["nodeId", "nodeType", "runId", "status", "summary", "timestamp"]) {
    if (typeof data[field] !== "string" || data[field].length === 0) {
      errors.push(`missing or empty required field: ${field}`);
    }
  }

  if (data.nodeType && !VALID_NODE_TYPES.has(data.nodeType)) {
    errors.push(`invalid nodeType: '${data.nodeType}' (expected: ${[...VALID_NODE_TYPES].join(", ")})`);
  }
  if (data.status && !VALID_STATUSES.has(data.status)) {
    errors.push(`invalid status: '${data.status}' (expected: ${[...VALID_STATUSES].join(", ")})`);
  }
  if (data.verdict != null && !VALID_VERDICTS.has(data.verdict)) {
    errors.push(`invalid verdict: '${data.verdict}' (expected: ${[...VALID_VERDICTS].join(", ")} or null)`);
  }

  if (!Array.isArray(data.artifacts)) {
    errors.push("artifacts must be an array");
  } else if (opts.baseDir) {
    for (let i = 0; i < data.artifacts.length; i++) {
      const a = data.artifacts[i];
      if (!a.type || !a.path) {
        errors.push(`artifact[${i}]: missing type or path`);
      } else if (!existsSync(join(opts.baseDir, a.path)) && !existsSync(a.path)) {
        errors.push(`artifact[${i}]: file not found: ${a.path}`);
      }
    }
  }

  if (opts.checkEvidence && data.nodeType === "execute" && data.status === "completed") {
    const hasEvidence = Array.isArray(data.artifacts) &&
      data.artifacts.some((a) => EVIDENCE_TYPES.has(a.type));
    if (!hasEvidence) {
      if (opts.softEvidence) {
        warnings.push("softEvidence: executor node missing standard evidence type (test-result, screenshot, cli-output) — warning only");
      } else {
        errors.push("executor node missing evidence (need at least one artifact with type: test-result, screenshot, or cli-output)");
      }
    }
  }

  if (data.findings && typeof data.findings === "object") {
    if ((data.findings.critical || 0) > 0 && data.verdict === "PASS") {
      errors.push("verdict is PASS but findings.critical > 0");
    }
  }

  if (data.loopback != null) {
    if (typeof data.loopback !== "object") {
      errors.push("loopback must be an object");
    } else {
      if (!data.loopback.from) errors.push("loopback.from is required");
      if (!data.loopback.reason) errors.push("loopback.reason is required");
      if (typeof data.loopback.iteration !== "number") errors.push("loopback.iteration must be a number");
    }
  }

  return { errors, warnings };
}

export function cmdValidate(args) {
  const file = args[0];
  if (!file) {
    console.error("Usage: opc-harness validate <handshake.json>");
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ valid: false, errors: [`cannot read/parse: ${err.message}`] }));
    return;
  }

  let soft = false;
  try {
    const harnessDir = dirname(dirname(dirname(file)));
    const statePath = join(harnessDir, "flow-state.json");
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state.flowTemplate) {
        const tmpl = FLOW_TEMPLATES[state.flowTemplate];
        if (tmpl && tmpl.softEvidence) soft = true;
      }
    }
  } catch { /* flow-state.json unreadable — treat as strict */ }

  const { errors, warnings } = validateHandshakeData(data, {
    checkEvidence: true,
    softEvidence: soft,
    baseDir: dirname(file),
  });

  for (const w of warnings) {
    console.error(`\u26a0\ufe0f  ${w}`);
  }

  console.log(JSON.stringify({ valid: errors.length === 0, errors }));
}

// ─── validate-context ──────────────────────────────────────────

export const RULE_VALIDATORS = {
  "non-empty-array": (v) => Array.isArray(v) && v.length > 0,
  "non-empty-object": (v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0,
  "non-empty-string": (v) => typeof v === "string" && v.length > 0,
  "positive-integer": (v) => Number.isInteger(v) && v > 0,
};

export function cmdValidateContext(args) {
  const flow = getFlag(args, "flow");
  const node = getFlag(args, "node");
  const dir = resolveDir(args);

  if (!flow || !node) {
    console.error("Usage: opc-harness validate-context --flow <template> --node <nodeId> --dir <path>");
    process.exit(1);
  }

  const template = FLOW_TEMPLATES[flow];
  if (!template) {
    console.log(JSON.stringify({ valid: false, errors: [`unknown flow template: ${flow}`] }));
    return;
  }

  if (!template.contextSchema) {
    console.log(JSON.stringify({ valid: true, errors: [], note: "no contextSchema in template" }));
    return;
  }

  const nodeSchema = template.contextSchema[node];
  if (!nodeSchema) {
    console.log(JSON.stringify({ valid: true, errors: [], note: `no contextSchema for node '${node}'` }));
    return;
  }

  const contextPath = join(dir, "flow-context.json");
  if (!existsSync(contextPath)) {
    console.log(JSON.stringify({ valid: false, errors: [`flow-context.json not found`] }));
    return;
  }

  let context;
  try {
    context = JSON.parse(readFileSync(contextPath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ valid: false, errors: [`cannot parse flow-context.json: ${err.message}`] }));
    return;
  }

  const errors = [];

  if (nodeSchema.required) {
    for (const field of nodeSchema.required) {
      if (context[field] === undefined || context[field] === null) {
        errors.push(`missing required field: '${field}'`);
      }
    }
  }

  if (nodeSchema.rules) {
    for (const [field, ruleName] of Object.entries(nodeSchema.rules)) {
      const validator = Object.hasOwn(RULE_VALIDATORS, ruleName) ? RULE_VALIDATORS[ruleName] : undefined;
      if (typeof validator !== "function") {
        errors.push(`unknown rule '${ruleName}' for field '${field}'`);
        continue;
      }
      if (context[field] !== undefined && context[field] !== null && !validator(context[field])) {
        errors.push(`field '${field}' fails rule '${ruleName}'`);
      }
    }
  }

  console.log(JSON.stringify({ valid: errors.length === 0, errors }));
}
