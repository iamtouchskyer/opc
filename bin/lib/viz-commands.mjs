// Visualization and replay commands: getMarker, cmdViz, cmdReplayData
// Depends on: flow-templates.mjs, util.mjs

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { FLOW_TEMPLATES } from "./flow-templates.mjs";
import { getFlag } from "./util.mjs";

export function getMarker(nodeId, state) {
  if (!state) return "○";
  if (state.currentNode === nodeId) return "▶";
  if (state.history?.some((h) => h.nodeId === nodeId)) return "✅";
  if (state.entryNode === nodeId && state.currentNode !== nodeId) return "✅";
  return "○";
}

export function cmdViz(args) {
  const flow = getFlag(args, "flow");
  // Read-only command: no resolveDir guard needed (viz reads state but never writes)
  const dir = getFlag(args, "dir");
  const jsonOut = args.includes("--json");

  if (!flow) {
    console.error("Usage: opc-harness viz --flow <template> [--dir <path>] [--json]");
    process.exit(1);
  }

  const template = Object.hasOwn(FLOW_TEMPLATES, flow) ? FLOW_TEMPLATES[flow] : null;
  if (!template) {
    console.error(`Unknown flow template: ${flow}`);
    process.exit(1);
  }

  let state = null;
  if (dir) {
    const sp = join(dir, "flow-state.json");
    if (existsSync(sp)) {
      try { state = JSON.parse(readFileSync(sp, "utf8")); } catch { /* ignore */ }
    }
  }

  // Collect loopbacks: gates with FAIL/ITERATE edges
  const loopbacks = [];
  for (const [nodeId, edges] of Object.entries(template.edges)) {
    for (const [verdict, target] of Object.entries(edges)) {
      if (target && verdict !== "PASS") {
        loopbacks.push({ gate: nodeId, verdict, target });
      }
    }
  }

  if (jsonOut) {
    const nodes = template.nodes.map((id) => ({ id, status: getMarker(id, state) }));
    console.log(JSON.stringify({ nodes, loopbacks }, null, 2));
    return;
  }

  // ASCII output — prefer FAIL over ITERATE for display
  const loopMap = {};
  for (const lb of loopbacks) {
    if (!loopMap[lb.gate] || lb.verdict === "FAIL") loopMap[lb.gate] = lb;
  }

  for (let i = 0; i < template.nodes.length; i++) {
    const id = template.nodes[i];
    const marker = getMarker(id, state);
    let line = `  ${marker} ${id}`;
    if (loopMap[id]) line += `          ← ${loopMap[id].verdict} → ${loopMap[id].target}`;
    console.log(line);
    if (i < template.nodes.length - 1) console.log("  │");
  }
}

// ─── replay-data ────────────────────────────────────────────────
// Outputs flow-state + handshakes as JSON for the HTML viewer.

export function cmdReplayData(args) {
  // Read-only command: no resolveDir guard needed (reads state + handshakes, never writes)
  const dir = getFlag(args, "dir", ".harness");

  const statePath = join(dir, "flow-state.json");
  if (!existsSync(statePath)) {
    console.error(`No flow-state.json in ${dir}. Nothing to replay.`);
    process.exit(1);
  }

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    console.error(`Cannot parse flow-state.json: ${err.message}`);
    process.exit(1);
  }

  const template = Object.hasOwn(FLOW_TEMPLATES, state.flowTemplate) ? FLOW_TEMPLATES[state.flowTemplate] : null;
  if (!template) {
    console.error(`Unknown flow template: ${state.flowTemplate}`);
    process.exit(1);
  }

  const handshakes = {};
  for (const nodeId of template.nodes) {
    const hp = join(dir, "nodes", nodeId, "handshake.json");
    if (existsSync(hp)) {
      try {
        const hs = JSON.parse(readFileSync(hp, "utf8"));
        const details = [];
        const nodeDir = join(dir, "nodes", nodeId);
        try {
          const entries = readdirSync(nodeDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith("run_")) {
              const runDir = join(nodeDir, entry.name);
              const runFiles = readdirSync(runDir);
              for (const rf of runFiles) {
                if (rf.endsWith(".md") || rf.endsWith(".txt")) {
                  try {
                    const content = readFileSync(join(runDir, rf), "utf8");
                    details.push({ file: rf, run: entry.name, content });
                  } catch { /* skip */ }
                }
              }
            }
          }
        } catch { /* no run dirs */ }
        hs.details = details;
        handshakes[nodeId] = hs;
      } catch { /* skip */ }
    }
  }

  const loopbacks = [];
  for (const [nodeId, edges] of Object.entries(template.edges)) {
    for (const [verdict, target] of Object.entries(edges)) {
      if (target && verdict !== "PASS") {
        loopbacks.push({ gate: nodeId, verdict, target });
      }
    }
  }

  console.log(JSON.stringify({
    flowTemplate: state.flowTemplate,
    nodes: template.nodes,
    edges: template.edges,
    loopbacks,
    entryNode: state.entryNode,
    currentNode: state.currentNode,
    totalSteps: state.totalSteps,
    history: state.history,
    handshakes,
  }, null, 2));
}
