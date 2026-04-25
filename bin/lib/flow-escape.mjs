// Flow escape hatches + listing: skip, pass, stop, goto, ls
// Depends on: flow-templates.mjs, flow-transition.mjs (cmdTransition), util.mjs, file-lock.mjs

import { readFileSync, readdirSync, statSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { FLOW_TEMPLATES, loadFlowFromFile } from "./flow-templates.mjs";
import { cmdTransition } from "./flow-transition.mjs";
import {
  getFlag, resolveDir, atomicWriteSync, getSessionsBaseDir,
  WRITER_SIG,
} from "./util.mjs";
import { lockFile } from "./file-lock.mjs";

// ── Shared state loader ──

function loadState(dir) {
  const statePath = join(dir, "flow-state.json");
  if (!existsSync(statePath)) return null;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    // Auto-restore flow template from _flow_file if needed
    if (state._flow_file) {
      loadFlowFromFile(state._flow_file);
    }
    return { state, statePath };
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
  const statePath = join(dir, "flow-state.json");

  // Acquire lock
  const lock = lockFile(statePath, { command: "skip" });
  if (!lock.acquired) {
    console.log(JSON.stringify({ error: "could not acquire lock", holder: lock.holder }));
    return;
  }
  try {
    const loaded = loadState(dir);
    if (!loaded) { console.log(JSON.stringify({ error: "no flow-state.json" })); return; }
    const { state, statePath: sp } = loaded;
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

    // ── Cycle limit checks (mirror cmdTransition) ──
    const limits = {
      maxTotalSteps: state.maxTotalSteps ?? template.limits.maxTotalSteps,
      maxLoopsPerEdge: state.maxLoopsPerEdge ?? template.limits.maxLoopsPerEdge,
      maxNodeReentry: state.maxNodeReentry ?? template.limits.maxNodeReentry,
    };
    if (state.totalSteps >= limits.maxTotalSteps) {
      console.log(JSON.stringify({ error: `maxTotalSteps (${limits.maxTotalSteps}) reached — cannot skip` }));
      return;
    }
    const edgeKey = `${current}\u2192${next}`;
    const edgeCount = state.edgeCounts[edgeKey] || 0;
    if (edgeCount >= limits.maxLoopsPerEdge) {
      console.log(JSON.stringify({ error: `maxLoopsPerEdge (${limits.maxLoopsPerEdge}) reached for '${edgeKey}' — cannot skip` }));
      return;
    }
    const nodeEntries = state.history.filter(h => h.nodeId === next).length;
    if (nodeEntries >= limits.maxNodeReentry) {
      console.log(JSON.stringify({ error: `maxNodeReentry (${limits.maxNodeReentry}) reached for '${next}' — cannot skip` }));
      return;
    }
    // ── maxSkips: prevent skipping through entire flow ──
    const maxSkips = template.limits.maxSkips ?? 2;
    const skipCount = state.history.filter(h => h.skipped).length;
    if (skipCount >= maxSkips) {
      console.log(JSON.stringify({ error: `maxSkips (${maxSkips}) reached — cannot skip more nodes` }));
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
    atomicWriteSync(join(nodeDir, "handshake.json"), JSON.stringify(skipHandshake, null, 2) + "\n");

    const runId = `run_${state.history.filter(h => h.nodeId === next).length + 1}`;
    state.history.push({ nodeId: next, runId, timestamp: new Date().toISOString(), skipped: true });
    state.currentNode = next;
    state.totalSteps++;
    state.edgeCounts[edgeKey] = (state.edgeCounts[edgeKey] || 0) + 1;
    state._written_by = WRITER_SIG;
    state._last_modified = new Date().toISOString();

    atomicWriteSync(sp, JSON.stringify(state, null, 2) + "\n");
    mkdirSync(join(dir, "nodes", next, runId), { recursive: true });

    console.log(JSON.stringify({ skipped: current, next, runId }));
  } finally {
    lock.release();
  }
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

  // ── OUT-1: Refuse pass when upstream verdict is ITERATE or FAIL ──
  // Find the upstream node: the non-gate node that has an edge pointing to this gate
  const upstreamId = Object.keys(template.edges).find(n => {
    const nt = template.nodeTypes?.[n];
    return nt && nt !== "gate" && Object.values(template.edges[n]).includes(current);
  });
  if (upstreamId) {
    const upstreamHandshakePath = join(dir, "nodes", upstreamId, "handshake.json");
    if (existsSync(upstreamHandshakePath)) {
      try {
        const harnessPath = join(dirname(fileURLToPath(import.meta.url)), "..", "opc-harness.mjs");
        const synthOutput = execFileSync(
          "node",
          [harnessPath, "synthesize", "--node", upstreamId, "--dir", dir, "--no-strict"],
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
        );
        // synthesize may output pretty-printed JSON; extract from first { to last }
        const trimmed = synthOutput.trim();
        const firstBrace = trimmed.indexOf("{");
        const lastBrace = trimmed.lastIndexOf("}");
        const synthResult = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        const mechVerdict = synthResult.verdict;
        if (mechVerdict === "ITERATE" || mechVerdict === "FAIL") {
          console.log(JSON.stringify({
            error: `Cannot force-pass: upstream verdict is ${mechVerdict}. Use /opc skip instead.`,
            allowed: false,
          }));
          return;
        }
      } catch (err) {
        // synthesize fails when no eval files exist yet — allow pass
        // But propagate unexpected errors (e.g. synthesize crashed)
        const stderr = err.stderr?.toString() || "";
        const stdout = err.stdout?.toString() || "";
        const combined = stderr + stdout;
        // "no eval" / "no artifact" / "not found" patterns indicate no evals exist — safe to pass
        if (!/no eval|no artifact|not found|does not exist|no runs/i.test(combined)) {
          console.log(JSON.stringify({
            error: `synthesize failed unexpectedly: ${stderr || err.message}`,
            allowed: false,
          }));
          return;
        }
        // No evals yet — allow pass through
      }
    }
  }

  // Delegate to cmdTransition (which has its own locking)
  const transArgs = ["--from", current, "--to", next, "--verdict", "PASS", "--flow", templateName, "--dir", dir];
  if (state._flow_file) transArgs.push("--flow-file", state._flow_file);
  cmdTransition(transArgs);
}

// ─── stop ───────────────────────────────────────────────────────
/** /opc stop — terminate flow, preserve state */

export function cmdStop(args) {
  const dir = resolveDir(args);
  const statePath = join(dir, "flow-state.json");

  // Acquire lock
  const lock = lockFile(statePath, { command: "stop" });
  if (!lock.acquired) {
    console.log(JSON.stringify({ error: "could not acquire lock", holder: lock.holder }));
    return;
  }
  try {
    const loaded = loadState(dir);
    if (!loaded) { console.log(JSON.stringify({ error: "no flow-state.json" })); return; }
    const { state, statePath: sp } = loaded;

    if (state.status === "completed") {
      console.log(JSON.stringify({ stopped: false, reason: "flow already completed" }));
      return;
    }

    state.status = "stopped";
    state.stoppedAt = new Date().toISOString();
    state._written_by = WRITER_SIG;
    state._last_modified = new Date().toISOString();

    atomicWriteSync(sp, JSON.stringify(state, null, 2) + "\n");
    console.log(JSON.stringify({ stopped: true, currentNode: state.currentNode, totalSteps: state.totalSteps }));
  } finally {
    lock.release();
  }
}

// ─── goto ───────────────────────────────────────────────────────
/** /opc goto <nodeId> — manual jump (cycle limits still enforced) */

export function cmdGoto(args) {
  const dir = resolveDir(args);
  // Parse positional args: filter out all --flag and their values
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      i++; // skip flag value
    } else {
      positional.push(args[i]);
    }
  }
  const targetNode = positional[0] || null;
  if (!targetNode) {
    console.error("Usage: opc-harness goto <nodeId> [--dir <path>]");
    process.exit(1);
  }

  const statePath = join(dir, "flow-state.json");

  // Acquire lock
  const lock = lockFile(statePath, { command: "goto" });
  if (!lock.acquired) {
    console.log(JSON.stringify({ error: "could not acquire lock", holder: lock.holder }));
    return;
  }
  try {
    const loaded = loadState(dir);
    if (!loaded) { console.log(JSON.stringify({ error: "no flow-state.json" })); return; }
    const { state, statePath: sp } = loaded;
    const template = Object.hasOwn(FLOW_TEMPLATES, state.flowTemplate) ? FLOW_TEMPLATES[state.flowTemplate] : null;
    if (!template) { console.log(JSON.stringify({ error: `unknown flow: ${state.flowTemplate}` })); return; }

    if (!template.nodes.includes(targetNode)) {
      console.log(JSON.stringify({ error: `'${targetNode}' is not a node in flow '${state.flowTemplate}'` }));
      return;
    }

    // Check node reentry limit
    const limits = {
      maxNodeReentry: state.maxNodeReentry ?? template.limits.maxNodeReentry,
      maxTotalSteps: state.maxTotalSteps ?? template.limits.maxTotalSteps,
      maxLoopsPerEdge: state.maxLoopsPerEdge ?? template.limits.maxLoopsPerEdge,
    };
    if (state.totalSteps >= limits.maxTotalSteps) {
      console.log(JSON.stringify({ error: `maxTotalSteps (${limits.maxTotalSteps}) reached — cannot goto` }));
      return;
    }
    const edgeKey = `${state.currentNode}→${targetNode}`;
    const edgeCount = state.edgeCounts?.[edgeKey] || 0;
    if (edgeCount >= limits.maxLoopsPerEdge) {
      console.log(JSON.stringify({ error: `maxLoopsPerEdge (${limits.maxLoopsPerEdge}) reached for '${edgeKey}' — cannot goto` }));
      return;
    }
    const nodeEntries = state.history.filter(h => h.nodeId === targetNode).length;
    if (nodeEntries >= limits.maxNodeReentry) {
      console.log(JSON.stringify({ error: `maxNodeReentry (${limits.maxNodeReentry}) reached for '${targetNode}'` }));
      return;
    }

    const runId = `run_${nodeEntries + 1}`;
    state.history.push({ nodeId: targetNode, runId, timestamp: new Date().toISOString(), goto: true });
    state.currentNode = targetNode;
    state.totalSteps++;
    if (!state.edgeCounts) state.edgeCounts = {};
    state.edgeCounts[edgeKey] = (state.edgeCounts[edgeKey] || 0) + 1;
    state._written_by = WRITER_SIG;
    state._last_modified = new Date().toISOString();

    atomicWriteSync(sp, JSON.stringify(state, null, 2) + "\n");
    mkdirSync(join(dir, "nodes", targetNode, runId), { recursive: true });

    console.log(JSON.stringify({ goto: targetNode, runId, totalSteps: state.totalSteps }));
  } finally {
    lock.release();
  }
}

// ─── ls ─────────────────────────────────────────────────────────
// List all active flows in the current project

export function cmdLs(args) {
  const baseDir = getFlag(args, "base", ".");
  const recursive = args.includes("--recursive");
  const results = [];

  // De-duplicate candidates by resolved path
  const seen = new Set();

  function addCandidate(dir) {
    const sp = join(dir, "flow-state.json");
    if (seen.has(dir) || !existsSync(sp)) return;
    seen.add(dir);
    try {
      const state = JSON.parse(readFileSync(sp, "utf8"));
      const st = statSync(sp);
      results.push({
        dir,
        flow: state.flowTemplate,
        currentNode: state.currentNode,
        entryNode: state.entryNode || null,
        status: state.status || "in_progress",
        totalSteps: state.totalSteps,
        lastModified: st.mtime.toISOString(),
      });
    } catch { /* corrupt — skip */ }
  }

  function scanBaseDir(base) {
    // Scan .harness and .harness-* at this base level
    try {
      const entries = readdirSync(base, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && (e.name === ".harness" || e.name.startsWith(".harness-"))) {
          addCandidate(join(base, e.name));
        }
      }
    } catch { /* unreadable dir */ }

    // Also check .harness/*/flow-state.json (named harness pattern)
    const harnessDir = join(base, ".harness");
    if (existsSync(harnessDir)) {
      try {
        const subs = readdirSync(harnessDir, { withFileTypes: true });
        for (const s of subs) {
          if (s.isDirectory()) {
            addCandidate(join(harnessDir, s.name));
          }
        }
      } catch { /* unreadable */ }
      // .harness itself may have a flow-state.json
      addCandidate(harnessDir);
    }
  }

  // Scan the base dir
  scanBaseDir(baseDir);

  // Scan ~/.opc/sessions/{project-hash}/ for session-based flows
  try {
    const sessionsBase = getSessionsBaseDir(baseDir === "." ? process.cwd() : baseDir);
    if (existsSync(sessionsBase)) {
      const sessions = readdirSync(sessionsBase, { withFileTypes: true });
      for (const s of sessions) {
        if (s.isDirectory() && s.name !== "latest") {
          addCandidate(join(sessionsBase, s.name));
        }
      }
    }
  } catch { /* ~/.opc not available */ }

  // --recursive: also scan one level deep (*/.harness/) for monorepo support
  if (recursive) {
    try {
      const entries = readdirSync(baseDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".")) {
          scanBaseDir(join(baseDir, e.name));
        }
      }
    } catch { /* unreadable */ }
  }

  console.log(JSON.stringify({ flows: results }));
}
