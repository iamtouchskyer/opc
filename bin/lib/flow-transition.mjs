// Flow transition commands: transition, validate-chain, finalize
// Depends on: flow-templates.mjs, flow-core.mjs (validateHandshakeData), viz-commands.mjs, util.mjs, file-lock.mjs

import { readFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import os from "os";
import { FLOW_TEMPLATES, resolveFlowTemplate, loadFlowFromFile } from "./flow-templates.mjs";
import { validateHandshakeData } from "./flow-core.mjs";
import { getMarker } from "./viz-commands.mjs";
import {
  getFlag, resolveDir, atomicWriteSync,
  WRITER_SIG, IDEMPOTENCY_WINDOW_MS,
} from "./util.mjs";
import { lockFile } from "./file-lock.mjs";
import { resolveBypass } from "./extensions.mjs";
import { parseBypassArgs } from "./bypass-args.mjs";

// ─── transition ─────────────────────────────────────────────────

export function cmdTransition(args) {
  const from = getFlag(args, "from");
  const to = getFlag(args, "to");
  const verdict = getFlag(args, "verdict");
  const dir = resolveDir(args);

  if (!from || !to || !verdict) {
    console.error("Usage: opc-harness transition --from <node> --to <node> --verdict <V> --flow <template> [--flow-file <path>] --dir <path>");
    process.exit(1);
  }

  // Try to load _flow_file from existing state before resolving template
  const statePath = join(dir, "flow-state.json");
  let existingState = null;
  if (existsSync(statePath)) {
    try { existingState = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* will be caught later */ }
  }

  const resolved = resolveFlowTemplate(args, existingState);
  if (resolved.error) {
    console.log(JSON.stringify({ allowed: false, reason: resolved.error }));
    return;
  }
  const { template, name: flow } = resolved;

  const nodeEdges = template.edges[from];
  if (!nodeEdges || nodeEdges[verdict] !== to) {
    console.log(JSON.stringify({ allowed: false, reason: `edge '${from}' --${verdict}--> '${to}' not in flow '${flow}'` }));
    return;
  }

  // Acquire lock
  const lock = lockFile(statePath, { command: "transition" });
  if (!lock.acquired) {
    console.log(JSON.stringify({ allowed: false, reason: "could not acquire lock", holder: lock.holder }));
    return;
  }
  try {
    _cmdTransitionLocked(from, to, verdict, flow, dir, template, statePath);
  } finally {
    lock.release();
  }
}

function _cmdTransitionLocked(from, to, verdict, flow, dir, template, statePath) {
  let state;
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch (err) {
      console.log(JSON.stringify({ allowed: false, reason: `corrupt flow-state.json: ${err.message}` }));
      return;
    }
    if (state.currentNode !== from) {
      console.log(JSON.stringify({ allowed: false, reason: `currentNode is '${state.currentNode}', not '${from}' — cannot transition from a node you are not at` }));
      return;
    }
    if (state._written_by !== WRITER_SIG || !state._write_nonce) {
      console.log(JSON.stringify({ allowed: false, reason: "flow-state.json was not written by opc-harness — possible direct edit" }));
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

  const edgeKey = `${from}\u2192${to}`;
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

  // ── Gate detection ──
  const fromNodeType = template.nodeTypes ? template.nodeTypes[from] : null;
  const isGate = fromNodeType === "gate" || (fromNodeType == null && (from === "gate" || from.startsWith("gate-")));

  // ── Pre-transition handshake validation ──
  if (!isGate) {
    const fromHandshakePath = join(dir, "nodes", from, "handshake.json");
    if (!existsSync(fromHandshakePath)) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `pre-transition check: handshake.json missing for node '${from}' — write handshake before transitioning`,
      }));
      return;
    }
    let hsData;
    try {
      hsData = JSON.parse(readFileSync(fromHandshakePath, "utf8"));
    } catch (err) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `pre-transition check: cannot parse handshake.json for '${from}': ${err.message}`,
      }));
      return;
    }
    const softEv = !!(template.softEvidence);
    const { errors: hsErrors, warnings: hsWarnings } = validateHandshakeData(hsData, {
      checkEvidence: true,
      softEvidence: softEv,
      baseDir: dirname(fromHandshakePath),
    });
    if (hsData.status !== "completed") {
      hsErrors.push(`status is '${hsData.status}', expected 'completed'`);
    }
    for (const w of hsWarnings) {
      console.error(`\u26a0\ufe0f  ${w}`);
    }
    if (hsErrors.length > 0) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `pre-transition check: handshake.json for '${from}' has errors: ${hsErrors.join("; ")}`,
        handshakeErrors: hsErrors,
      }));
      return;
    }
  }

  // ── Idempotency guard ──
  if (state.history.length > 0) {
    const lastEntry = state.history[state.history.length - 1];
    if (lastEntry.nodeId === to) {
      const lastTime = new Date(lastEntry.timestamp).getTime();
      const now = Date.now();
      if (now - lastTime < IDEMPOTENCY_WINDOW_MS) {
        console.log(JSON.stringify({
          allowed: false,
          reason: `idempotency guard: already transitioned to '${to}' ${Math.round((now - lastTime) / 1000)}s ago — likely duplicate transition`,
          duplicate: true,
        }));
        return;
      }
    }
  }

  const existingRuns = state.history.filter((h) => h.nodeId === to).length;
  const runId = `run_${existingRuns + 1}`;

  // ── Backlog enforcement for 🟡 findings ──
  if (isGate && (verdict === "PASS" || verdict === "ITERATE")) {
    const backlogPath = join(dir, "backlog.md");
    const upstreamId = Object.keys(template.edges).find(n =>
      Object.values(template.edges[n]).includes(from)
    ) || null;

    if (upstreamId) {
      const upstreamHandshake = join(dir, "nodes", upstreamId, "handshake.json");
      if (existsSync(upstreamHandshake)) {
        try {
          const hsData = JSON.parse(readFileSync(upstreamHandshake, "utf8"));
          const warningCount = hsData.findings?.warning || 0;
          if (warningCount > 0) {
            if (!existsSync(backlogPath)) {
              console.log(JSON.stringify({
                allowed: false,
                reason: `upstream '${upstreamId}' has ${warningCount} \ud83d\udfe1 warning(s) but backlog.md does not exist — write findings to backlog before transitioning`,
                backlog_required: true, upstream: upstreamId, warnings: warningCount,
              }));
              return;
            }
            const backlogText = readFileSync(backlogPath, "utf8");
            const escapedUpstreamId = upstreamId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const backlogEntryPattern = new RegExp(`^\\s*-\\s*\\[[ x]\\]\\s*[\ud83d\udd34\ud83d\udfe1\ud83d\udd35\u23ed\ufe0f].*\\[${escapedUpstreamId}\\]`, "gm");
            const matches = backlogText.match(backlogEntryPattern) || [];
            if (matches.length === 0) {
              console.log(JSON.stringify({
                allowed: false,
                reason: `upstream '${upstreamId}' has ${warningCount} \ud83d\udfe1 warning(s) but backlog.md has no formatted entries from '${upstreamId}'`,
                backlog_required: true, upstream: upstreamId, warnings: warningCount,
              }));
              return;
            }
            if (matches.length < warningCount) {
              console.log(JSON.stringify({
                allowed: false,
                reason: `upstream '${upstreamId}' has ${warningCount} \ud83d\udfe1 warning(s) but backlog.md only has ${matches.length} entries — need ${warningCount}`,
                backlog_required: true, upstream: upstreamId, warnings: warningCount, backlog_entries: matches.length,
              }));
              return;
            }
          }
        } catch (parseErr) {
          console.log(JSON.stringify({
            allowed: false,
            reason: `upstream '${upstreamId}' handshake is corrupt: ${parseErr.message}`,
          }));
          return;
        }
      }
    }
  }

  if (isGate) {
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
    atomicWriteSync(join(gateDir, "handshake.json"), JSON.stringify(gateHandshake, null, 2) + "\n");
  }

  state.history.push({ nodeId: to, runId, timestamp: new Date().toISOString() });
  state.currentNode = to;
  state.totalSteps++;
  state.edgeCounts[edgeKey] = edgeCount + 1;
  state._written_by = WRITER_SIG;
  state._last_modified = new Date().toISOString();

  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");
  mkdirSync(join(dir, "nodes", to, runId), { recursive: true });

  // Print live flow viz to stderr
  console.error("");
  for (let i = 0; i < template.nodes.length; i++) {
    const id = template.nodes[i];
    const m = getMarker(id, state);
    let line = `  ${m} ${id}`;
    const edges = template.edges[id];
    if (edges && edges.FAIL) line += `  \u2190 FAIL \u2192 ${edges.FAIL}`;
    console.error(line);
    if (i < template.nodes.length - 1) console.error("  \u2502");
  }
  console.error("");

  console.log(JSON.stringify({ allowed: true, reason: "ok", next: to, runId, state }));
}

// ─── validate-chain ─────────────────────────────────────────────

export function cmdValidateChain(args) {
  const dir = resolveDir(args);

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

  // Load config to get requiredExtensions
  let requiredExtensions = [];
  try {
    const configPath = join(os.homedir(), ".opc", "config.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      requiredExtensions = Array.isArray(cfg.requiredExtensions) ? cfg.requiredExtensions : [];
    }
  } catch { /* best effort */ }

  // ─── Bypass-aware requiredExtensions enforcement ─────────────────
  // If the flow was initialized under bypass (recorded in flow-state.bypassMode),
  // OR if the current invocation is under env/CLI bypass, the requiredExtensions
  // check is waived. Rationale: the bypass mechanism exists so a benchmark /
  // reproducible run on a vanilla machine can execute without any private
  // extensions; enforcing requiredExtensions after the fact would defeat that.
  // The bypass record persisted on flow-state is the audit trail.
  let bypassActive = false;
  let bypassSource = null;
  if (state.bypassMode && state.bypassMode.mode === "disable-all") {
    bypassActive = true;
    bypassSource = `flow-state(${state.bypassMode.source})`;
  } else {
    const decision = resolveBypass({ ...parseBypassArgs(args), quietBypass: true });
    if (decision.mode === "disable-all") {
      bypassActive = true;
      bypassSource = `runtime(${decision.source})`;
    }
  }
  if (bypassActive && requiredExtensions.length > 0) {
    console.error(`[opc] validate-chain: waiving requiredExtensions (${requiredExtensions.join(", ")}) — bypass active via ${bypassSource}`);
    requiredExtensions = [];
  }

  for (const entry of state.history) {
    const nd = entry.node || entry.nodeId;
    const handshakePath = join(dir, "nodes", nd, "handshake.json");
    executedPath.push(nd);

    if (!existsSync(handshakePath)) {
      if (nd === state.currentNode) continue;
      errors.push(`missing handshake for node '${nd}'`);
    }
  }

  const nodesDir = join(dir, "nodes");
  if (existsSync(nodesDir)) {
    try {
      const nodeDirs = readdirSync(nodesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const nd of nodeDirs) {
        const hp = join(nodesDir, nd, "handshake.json");
        if (existsSync(hp)) {
          try {
            const data = JSON.parse(readFileSync(hp, "utf8"));
            if (!data.node && !data.nodeId) errors.push(`${nd}/handshake.json: missing node identifier`);
            if (!data.status) errors.push(`${nd}/handshake.json: missing status`);
            // Check extensionsApplied for required extensions — skip gate nodes (auto-generated, no extension context)
            const isGateNode = nd.startsWith("gate") || data.node === "gate" || data.nodeId === "gate";
            if (requiredExtensions.length > 0 && !isGateNode) {
              if (!Object.hasOwn(data, "extensionsApplied")) {
                errors.push(`${nd}/handshake.json: extensionsApplied missing — run \`extension-verdict\` after review nodes`);
              } else {
                const applied = Array.isArray(data.extensionsApplied) ? data.extensionsApplied : [];
                for (const req of requiredExtensions) {
                  if (!applied.includes(req)) {
                    errors.push(`${nd}/handshake.json: required extension '${req}' missing from extensionsApplied`);
                  }
                }
              }
            }
          } catch (err) {
            errors.push(`${nd}/handshake.json: parse error: ${err.message}`);
          }
        }
      }
    } catch { /* nodes dir unreadable */ }
  }

  console.log(JSON.stringify({ valid: errors.length === 0, errors, executedPath }));
}

// ─── finalize ──────────────────────────────────────────────────

export function cmdFinalize(args) {
  const dir = resolveDir(args);
  const strict = args.includes("--strict");

  const statePath = join(dir, "flow-state.json");
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ finalized: false, error: "flow-state.json not found" }));
    return;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ finalized: false, error: `corrupt flow-state.json: ${err.message}` }));
    return;
  }

  if (state._written_by !== WRITER_SIG) {
    console.log(JSON.stringify({ finalized: false, error: "flow-state.json was not written by opc-harness" }));
    return;
  }

  const flow = state.flowTemplate;

  // Auto-restore flow template from _flow_file if needed
  if (state._flow_file) {
    loadFlowFromFile(state._flow_file); // injects into FLOW_TEMPLATES
  }

  const template = Object.hasOwn(FLOW_TEMPLATES, flow) ? FLOW_TEMPLATES[flow] : null;
  if (!template) {
    console.log(JSON.stringify({ finalized: false, error: `unknown flow template: ${flow}` }));
    return;
  }

  const currentNode = state.currentNode;
  const nodeEdges = template.edges[currentNode];
  if (!nodeEdges || nodeEdges.PASS !== null) {
    console.log(JSON.stringify({
      finalized: false,
      error: `currentNode '${currentNode}' is not a terminal node (PASS edge \u2192 ${nodeEdges?.PASS ?? "undefined"}, expected null)`,
    }));
    return;
  }

  // --strict: validate ALL nodes have valid handshakes before finalizing
  if (strict) {
    const chainErrors = [];
    const allNodes = template.nodes;
    for (const nodeId of allNodes) {
      const hp = join(dir, "nodes", nodeId, "handshake.json");
      if (!existsSync(hp)) {
        chainErrors.push(`missing handshake for '${nodeId}'`);
        continue;
      }
      let hsData;
      try {
        hsData = JSON.parse(readFileSync(hp, "utf8"));
      } catch (parseErr) {
        chainErrors.push(`cannot parse handshake for '${nodeId}': ${parseErr.message}`);
        continue;
      }
      const { errors: hsErrors } = validateHandshakeData(hsData, {
        checkEvidence: true,
        softEvidence: !!(template.softEvidence),
        baseDir: join(dir, "nodes", nodeId),
      });
      for (const e of hsErrors) {
        chainErrors.push(`${nodeId}: ${e}`);
      }
    }
    if (chainErrors.length > 0) {
      console.log(JSON.stringify({
        finalized: false,
        error: `--strict: chain validation failed: ${chainErrors.join("; ")}`,
        chainErrors,
      }));
      return;
    }
  }

  const handshakePath = join(dir, "nodes", currentNode, "handshake.json");
  if (!existsSync(handshakePath)) {
    // Auto-create handshake for terminal gate nodes (they are reached via transition TO, not FROM)
    const terminalNodeType = template.nodeTypes?.[currentNode];
    if (terminalNodeType === "gate" || currentNode === "gate" || currentNode.startsWith("gate-")) {
      mkdirSync(join(dir, "nodes", currentNode), { recursive: true });
      const autoHandshake = {
        nodeId: currentNode,
        nodeType: "gate",
        runId: `run_${(state.history.filter(h => h.nodeId === currentNode).length || 0) + 1}`,
        status: "completed",
        verdict: "PASS",
        summary: `Terminal gate finalized (auto-created)`,
        timestamp: new Date().toISOString(),
        artifacts: [],
        findings: null,
      };
      atomicWriteSync(handshakePath, JSON.stringify(autoHandshake, null, 2) + "\n");
    } else {
      console.log(JSON.stringify({
        finalized: false,
        error: `terminal node '${currentNode}' handshake.json not found — complete the node before finalizing`,
      }));
      return;
    }
  }

  let hsData;
  try {
    hsData = JSON.parse(readFileSync(handshakePath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ finalized: false, error: `cannot parse terminal handshake: ${err.message}` }));
    return;
  }

  if (hsData.status !== "completed") {
    console.log(JSON.stringify({
      finalized: false,
      error: `terminal node handshake status is '${hsData.status}', expected 'completed'`,
    }));
    return;
  }

  if (state.status === "completed") {
    console.log(JSON.stringify({
      finalized: true, flow, terminalNode: currentNode, totalSteps: state.totalSteps, note: "already finalized",
    }));
    return;
  }

  const lock = lockFile(statePath, { command: "finalize" });
  if (!lock.acquired) {
    console.log(JSON.stringify({ finalized: false, error: "could not acquire lock", holder: lock.holder }));
    return;
  }
  try {
    // Re-read state under lock to prevent TOCTOU
    const freshState = JSON.parse(readFileSync(statePath, "utf8"));
    if (freshState.status === "completed") {
      console.log(JSON.stringify({
        finalized: true, flow, terminalNode: currentNode, totalSteps: freshState.totalSteps, note: "already finalized",
      }));
      return;
    }

    freshState.status = "completed";
    freshState.completedAt = new Date().toISOString();
    freshState._last_modified = new Date().toISOString();
    freshState._written_by = WRITER_SIG;

    atomicWriteSync(statePath, JSON.stringify(freshState, null, 2) + "\n");

    console.log(JSON.stringify({ finalized: true, flow, terminalNode: currentNode, totalSteps: freshState.totalSteps }));
  } finally {
    lock.release();
  }
}
