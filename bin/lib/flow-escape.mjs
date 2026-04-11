// Flow escape hatches + listing: skip, pass, stop, goto, ls
// Depends on: flow-templates.mjs, flow-transition.mjs (cmdTransition), util.mjs

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { FLOW_TEMPLATES } from "./flow-templates.mjs";
import { cmdTransition } from "./flow-transition.mjs";
import {
  getFlag, resolveDir, atomicWriteSync,
  WRITER_SIG,
} from "./util.mjs";

// ── Shared state loader ──

function loadState(dir) {
  const statePath = join(dir, "flow-state.json");
  if (!existsSync(statePath)) return null;
  try {
    return { state: JSON.parse(readFileSync(statePath, "utf8")), statePath };
  } catch {
    console.error(`Cannot parse ${statePath}`);
    process.exit(1);
  }
}

// ─── skip ───────────────────────────────────────────────────────
/** /opc skip — advance current node via PASS edge without executing */

export function cmdSkip(args) {
  const dir = resolveDir(args);
  const flow = getFlag(args, "flow");
  const loaded = loadState(dir);
  if (!loaded) { console.log(JSON.stringify({ error: "no flow-state.json" })); return; }
  const { state, statePath } = loaded;
  const templateName = flow || state.flowTemplate;
  const template = Object.hasOwn(FLOW_TEMPLATES, templateName) ? FLOW_TEMPLATES[templateName] : null;
  if (!template) { console.log(JSON.stringify({ error: `unknown flow: ${templateName}` })); return; }

  const current = state.currentNode;
  const edges = template.edges[current];
  if (!edges || !("PASS" in edges)) {
    console.log(JSON.stringify({ error: `no PASS edge from '${current}'` }));
    return;
  }
  const next = edges.PASS;
  if (next === null) {
    console.log(JSON.stringify({ error: `'${current}' is terminal — use finalize instead` }));
    return;
  }

  // Write a skip handshake so pre-transition won't block
  const nodeDir = join(dir, "nodes", current);
  mkdirSync(nodeDir, { recursive: true });
  const skipHandshake = {
    nodeId: current,
    nodeType: template.nodeTypes?.[current] || "execute",
    runId: `run_${(state.history.filter(h => h.nodeId === current).length || 0) + 1}`,
    status: "completed",
    verdict: null,
    summary: "SKIPPED via /opc skip",
    timestamp: new Date().toISOString(),
    artifacts: [],
    skipped: true,
  };
  writeFileSync(join(nodeDir, "handshake.json"), JSON.stringify(skipHandshake, null, 2) + "\n");

  const runId = `run_${state.history.filter(h => h.nodeId === next).length + 1}`;
  const edgeKey = `${current}\u2192${next}`;
  state.history.push({ nodeId: next, runId, timestamp: new Date().toISOString() });
  state.currentNode = next;
  state.totalSteps++;
  state.edgeCounts[edgeKey] = (state.edgeCounts[edgeKey] || 0) + 1;
  state._written_by = WRITER_SIG;
  state._last_modified = new Date().toISOString();

  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");
  mkdirSync(join(dir, "nodes", next, runId), { recursive: true });

  console.log(JSON.stringify({ skipped: current, next, runId }));
}

// ─── pass ───────────────────────────────────────────────────────
/** /opc pass — force current gate to PASS */

export function cmdPass(args) {
  const dir = resolveDir(args);
  const loaded = loadState(dir);
  if (!loaded) { console.log(JSON.stringify({ error: "no flow-state.json" })); return; }
  const { state } = loaded;
  const templateName = state.flowTemplate;
  const template = Object.hasOwn(FLOW_TEMPLATES, templateName) ? FLOW_TEMPLATES[templateName] : null;
  if (!template) { console.log(JSON.stringify({ error: `unknown flow: ${templateName}` })); return; }

  const current = state.currentNode;
  const nodeType = template.nodeTypes?.[current];
  if (nodeType !== "gate" && current !== "gate" && !current.startsWith("gate-")) {
    console.log(JSON.stringify({ error: `'${current}' is not a gate node — /opc pass only works on gates` }));
    return;
  }

  const edges = template.edges[current];
  if (!edges || !("PASS" in edges)) {
    console.log(JSON.stringify({ error: `no PASS edge from gate '${current}'` }));
    return;
  }

  const next = edges.PASS;
  if (next === null) {
    console.log(JSON.stringify({ error: `gate '${current}' PASS \u2192 null (terminal). Use finalize instead.` }));
    return;
  }
  // Delegate to cmdTransition
  const transArgs = ["--from", current, "--to", next, "--verdict", "PASS", "--flow", templateName, "--dir", dir];
  cmdTransition(transArgs);
}

// ─── stop ───────────────────────────────────────────────────────
/** /opc stop — terminate flow, preserve state */

export function cmdStop(args) {
  const dir = resolveDir(args);
  const loaded = loadState(dir);
  if (!loaded) { console.log(JSON.stringify({ error: "no flow-state.json" })); return; }
  const { state, statePath } = loaded;

  if (state.status === "completed") {
    console.log(JSON.stringify({ stopped: false, reason: "flow already completed" }));
    return;
  }

  state.status = "stopped";
  state.stoppedAt = new Date().toISOString();
  state._written_by = WRITER_SIG;
  state._last_modified = new Date().toISOString();

  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");
  console.log(JSON.stringify({ stopped: true, currentNode: state.currentNode, totalSteps: state.totalSteps }));
}

// ─── goto ───────────────────────────────────────────────────────
/** /opc goto <nodeId> — manual jump (cycle limits still enforced) */

export function cmdGoto(args) {
  const dir = resolveDir(args);
  const targetNode = args.find(a => !a.startsWith("--") && a !== getFlag(args, "dir"));
  if (!targetNode) {
    console.error("Usage: opc-harness goto <nodeId> [--dir <path>]");
    process.exit(1);
  }

  const loaded = loadState(dir);
  if (!loaded) { console.log(JSON.stringify({ error: "no flow-state.json" })); return; }
  const { state, statePath } = loaded;
  const template = Object.hasOwn(FLOW_TEMPLATES, state.flowTemplate) ? FLOW_TEMPLATES[state.flowTemplate] : null;
  if (!template) { console.log(JSON.stringify({ error: `unknown flow: ${state.flowTemplate}` })); return; }

  if (!template.nodes.includes(targetNode)) {
    console.log(JSON.stringify({ error: `'${targetNode}' is not a node in flow '${state.flowTemplate}'` }));
    return;
  }

  // Check node reentry limit
  const limits = { maxNodeReentry: state.maxNodeReentry ?? template.limits.maxNodeReentry };
  const nodeEntries = state.history.filter(h => h.nodeId === targetNode).length;
  if (nodeEntries >= limits.maxNodeReentry) {
    console.log(JSON.stringify({ error: `maxNodeReentry (${limits.maxNodeReentry}) reached for '${targetNode}'` }));
    return;
  }

  const runId = `run_${nodeEntries + 1}`;
  state.history.push({ nodeId: targetNode, runId, timestamp: new Date().toISOString(), goto: true });
  state.currentNode = targetNode;
  state.totalSteps++;
  state._written_by = WRITER_SIG;
  state._last_modified = new Date().toISOString();

  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");
  mkdirSync(join(dir, "nodes", targetNode, runId), { recursive: true });

  console.log(JSON.stringify({ goto: targetNode, runId, totalSteps: state.totalSteps }));
}

// ─── ls ─────────────────────────────────────────────────────────
// List all active flows in the current project

export function cmdLs(args) {
  const baseDir = getFlag(args, "base", ".");
  const results = [];

  // Scan common harness directories
  const candidates = [];
  try {
    const entries = readdirSync(baseDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && (e.name === ".harness" || e.name.startsWith(".harness-"))) {
        candidates.push(join(baseDir, e.name));
      }
    }
  } catch { /* unreadable dir */ }

  // Also check .harness/*/flow-state.json (named harness pattern)
  const harnessDir = join(baseDir, ".harness");
  if (existsSync(harnessDir)) {
    try {
      const subs = readdirSync(harnessDir, { withFileTypes: true });
      for (const s of subs) {
        if (s.isDirectory() && existsSync(join(harnessDir, s.name, "flow-state.json"))) {
          candidates.push(join(harnessDir, s.name));
        }
      }
    } catch { /* unreadable */ }
    if (existsSync(join(harnessDir, "flow-state.json"))) {
      candidates.push(harnessDir);
    }
  }

  for (const dir of candidates) {
    const sp = join(dir, "flow-state.json");
    if (!existsSync(sp)) continue;
    try {
      const state = JSON.parse(readFileSync(sp, "utf8"));
      results.push({
        dir,
        flow: state.flowTemplate,
        currentNode: state.currentNode,
        status: state.status || "in_progress",
        totalSteps: state.totalSteps,
      });
    } catch { /* corrupt — skip */ }
  }

  console.log(JSON.stringify({ flows: results }));
}
