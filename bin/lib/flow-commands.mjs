// Flow state management commands: route, init, validate, transition, validate-chain
// Depends on: flow-templates.mjs, viz-commands.mjs (getMarker)

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { FLOW_TEMPLATES } from "./flow-templates.mjs";
import { getMarker } from "./viz-commands.mjs";

function getFlag(args, name, fallback = null) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] != null ? args[idx + 1] : fallback;
}

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
  const dir = getFlag(args, "dir", ".harness");

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
  if (existsSync(statePath)) {
    console.log(JSON.stringify({ created: false, error: "flow-state.json already exists" }));
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
  };

  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

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

const VALID_NODE_TYPES = new Set(["discussion", "build", "review", "execute", "gate"]);
const VALID_STATUSES = new Set(["completed", "failed", "blocked"]);
const VALID_VERDICTS = new Set(["PASS", "ITERATE", "FAIL", "BLOCKED"]);
const EVIDENCE_TYPES = new Set(["test-result", "screenshot", "cli-output"]);

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

  const errors = [];

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
  } else {
    const baseDir = dirname(file);
    for (let i = 0; i < data.artifacts.length; i++) {
      const a = data.artifacts[i];
      if (!a.type || !a.path) {
        errors.push(`artifact[${i}]: missing type or path`);
      } else if (!existsSync(join(baseDir, a.path)) && !existsSync(a.path)) {
        errors.push(`artifact[${i}]: file not found: ${a.path}`);
      }
    }
  }

  if (data.nodeType === "execute" && data.status === "completed") {
    const hasEvidence = Array.isArray(data.artifacts) &&
      data.artifacts.some((a) => EVIDENCE_TYPES.has(a.type));
    if (!hasEvidence) {
      errors.push("executor node missing evidence (need at least one artifact with type: test-result, screenshot, or cli-output)");
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

  console.log(JSON.stringify({ valid: errors.length === 0, errors }));
}

// ─── transition ─────────────────────────────────────────────────

export function cmdTransition(args) {
  const from = getFlag(args, "from");
  const to = getFlag(args, "to");
  const verdict = getFlag(args, "verdict");
  const flow = getFlag(args, "flow");
  const dir = getFlag(args, "dir", ".harness");

  if (!from || !to || !verdict || !flow) {
    console.error("Usage: opc-harness transition --from <node> --to <node> --verdict <V> --flow <template> --dir <path>");
    process.exit(1);
  }

  const template = FLOW_TEMPLATES[flow];
  if (!template) {
    console.log(JSON.stringify({ allowed: false, reason: `unknown flow template: ${flow}` }));
    return;
  }

  const nodeEdges = template.edges[from];
  if (!nodeEdges || nodeEdges[verdict] !== to) {
    console.log(JSON.stringify({ allowed: false, reason: `edge '${from}' --${verdict}--> '${to}' not in flow '${flow}'` }));
    return;
  }

  const statePath = join(dir, "flow-state.json");
  let state;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf8"));
    if (state.currentNode !== from) {
      console.log(JSON.stringify({ allowed: false, reason: `currentNode is '${state.currentNode}', not '${from}' — cannot transition from a node you are not at` }));
      return;
    }
  } else {
    mkdirSync(join(dir, "nodes"), { recursive: true });
    state = {
      version: "1.0",
      flowTemplate: flow,
      currentNode: from,
      entryNode: template.nodes[0],
      totalSteps: 0,
      maxTotalSteps: template.limits.maxTotalSteps,
      maxLoopsPerEdge: template.limits.maxLoopsPerEdge,
      maxNodeReentry: template.limits.maxNodeReentry,
      history: [],
      edgeCounts: {},
    };
  }

  const limits = {
    maxTotalSteps: state.maxTotalSteps ?? template.limits.maxTotalSteps,
    maxLoopsPerEdge: state.maxLoopsPerEdge ?? template.limits.maxLoopsPerEdge,
    maxNodeReentry: state.maxNodeReentry ?? template.limits.maxNodeReentry,
  };

  if (state.totalSteps >= limits.maxTotalSteps) {
    console.log(JSON.stringify({ allowed: false, reason: `maxTotalSteps (${limits.maxTotalSteps}) reached` }));
    return;
  }

  const edgeKey = `${from}→${to}`;
  const edgeCount = state.edgeCounts[edgeKey] || 0;
  if (edgeCount >= limits.maxLoopsPerEdge) {
    console.log(JSON.stringify({ allowed: false, reason: `maxLoopsPerEdge (${limits.maxLoopsPerEdge}) reached for edge '${edgeKey}'` }));
    return;
  }

  const nodeEntries = state.history.filter((h) => h.nodeId === to).length;
  if (nodeEntries >= limits.maxNodeReentry) {
    console.log(JSON.stringify({ allowed: false, reason: `maxNodeReentry (${limits.maxNodeReentry}) reached for node '${to}'` }));
    return;
  }

  const existingRuns = state.history.filter((h) => h.nodeId === to).length;
  const runId = `run_${existingRuns + 1}`;

  if (from.startsWith("gate")) {
    const gateDir = join(dir, "nodes", from);
    mkdirSync(gateDir, { recursive: true });
    const gateHandshake = {
      nodeId: from,
      nodeType: "gate",
      runId: `run_${(state.history.filter((h) => h.nodeId === from).length || 0) + 1}`,
      status: "completed",
      verdict,
      summary: `verdict=${verdict}, next=${to}`,
      timestamp: new Date().toISOString(),
      artifacts: [],
      findings: null,
    };
    writeFileSync(join(gateDir, "handshake.json"), JSON.stringify(gateHandshake, null, 2) + "\n");
  }

  state.history.push({ nodeId: to, runId, timestamp: new Date().toISOString() });
  state.currentNode = to;
  state.totalSteps++;
  state.edgeCounts[edgeKey] = edgeCount + 1;

  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  mkdirSync(join(dir, "nodes", to, runId), { recursive: true });

  // Print live flow viz to stderr
  console.error("");
  for (let i = 0; i < template.nodes.length; i++) {
    const id = template.nodes[i];
    const m = getMarker(id, state);
    let line = `  ${m} ${id}`;
    const edges = template.edges[id];
    if (edges && edges.FAIL) line += `  ← FAIL → ${edges.FAIL}`;
    console.error(line);
    if (i < template.nodes.length - 1) console.error("  │");
  }
  console.error("");

  console.log(JSON.stringify({ allowed: true, reason: "ok", next: to, runId, state }));
}

// ─── validate-chain ─────────────────────────────────────────────

export function cmdValidateChain(args) {
  const dir = getFlag(args, "dir", ".harness");

  const statePath = join(dir, "flow-state.json");
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ valid: false, errors: ["flow-state.json not found"], executedPath: [] }));
    return;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ valid: false, errors: [`cannot parse flow-state.json: ${err.message}`], executedPath: [] }));
    return;
  }

  const errors = [];
  const executedPath = [];

  for (const entry of state.history) {
    const handshakePath = join(dir, "nodes", entry.nodeId, "handshake.json");
    executedPath.push(entry.nodeId);

    if (!existsSync(handshakePath)) {
      if (entry.nodeId === state.currentNode) continue;
      errors.push(`missing handshake for node '${entry.nodeId}' (expected: ${handshakePath})`);
    }
  }

  let nodesDir;
  try {
    nodesDir = join(dir, "nodes");
    if (existsSync(nodesDir)) {
      const nodeDirs = readdirSync(nodesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const nd of nodeDirs) {
        const hp = join(nodesDir, nd, "handshake.json");
        if (existsSync(hp)) {
          try {
            const data = JSON.parse(readFileSync(hp, "utf8"));
            if (!data.nodeId) errors.push(`${nd}/handshake.json: missing nodeId`);
            if (!data.nodeType) errors.push(`${nd}/handshake.json: missing nodeType`);
            if (!data.status) errors.push(`${nd}/handshake.json: missing status`);
          } catch (err) {
            errors.push(`${nd}/handshake.json: parse error: ${err.message}`);
          }
        }
      }
    }
  } catch {
    // nodes dir doesn't exist
  }

  console.log(JSON.stringify({ valid: errors.length === 0, errors, executedPath }));
}
