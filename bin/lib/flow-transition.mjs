// Flow transition commands: transition, validate-chain, finalize
// Depends on: flow-templates.mjs, flow-core.mjs (validateHandshakeData), viz-commands.mjs, util.mjs, file-lock.mjs

import { readFileSync, readdirSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { join, dirname, resolve, basename } from "path";
import { fileURLToPath } from "url";
import os from "os";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { FLOW_TEMPLATES, resolveFlowTemplate, loadFlowFromFile } from "./flow-templates.mjs";
import { validateHandshakeData } from "./flow-core.mjs";
import { getMarker } from "./viz-commands.mjs";
import {
  getFlag, resolveDir, atomicWriteSync, gcSessions, getProjectRoot,
  WRITER_SIG, IDEMPOTENCY_WINDOW_MS,
} from "./util.mjs";
import { lockFile } from "./file-lock.mjs";
import { resolveBypass, loadExtensions, firePromptAppend, fireVerdictAppend, survivingExtensions, saveRegistryCache } from "./extensions.mjs";
import { parseBypassArgs } from "./bypass-args.mjs";
import { loadOpcConfig, readTaskFromAC, findLatestRunDir } from "./ext-commands.mjs";
import { collectGateCriteriaReasons } from "./gate-criteria.mjs";
import { collectDiVerdictReasons } from "./di-verdict-gate.mjs";
import { executeTestCommand, loadTestCommandSpec, testCommandHash } from "./test-command-execution.mjs";
import { collectExtensionStartupReasons } from "./extension-startup-gate.mjs";
import { collectTestDesignPlanReasons } from "./test-plan-gate.mjs";
import { readCumulativeFindingsAppend, writeCumulativeFindings } from "./cumulative-findings.mjs";
import { collectTestResultReasons } from "./test-result-gate.mjs";

function nodeHandshakePath(dir, nodeId) {
  const nodeDir = join(dir, "nodes", nodeId);
  const direct = join(nodeDir, "handshake.json");
  if (existsSync(direct)) return direct;
  const latestRun = findLatestRunDir(nodeDir);
  const fallback = latestRun ? join(latestRun, "handshake.json") : null;
  return fallback && existsSync(fallback) ? fallback : direct;
}

function mandatoryRoleHint(nodeId) {
  if (/^test[-_]design$/.test(nodeId)) {
    return " For test-design, skeptic-owner reviews test plan completeness, not code quality.";
  }
  return "";
}

function testEvidenceContext(dir, handshake) {
  const sourceNode = handshake?.testEvidenceProvenance?.sourceNode;
  if (!sourceNode) return {};
  const spec = loadTestCommandSpec(dir, sourceNode);
  if (!spec) return {};
  return {
    expectedCommandHash: testCommandHash(spec.testCommand),
    expectedSourcePlanHash: spec.sourcePlanHash,
    allowVacuousChecks: spec.allowVacuousChecks,
  };
}

function synthesizeBaseForState(state) {
  if (typeof state?.projectRoot === "string" && state.projectRoot) return state.projectRoot;
  return getProjectRoot();
}

function harnessPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "opc-harness.mjs");
}

function parseJsonLastLine(text) {
  try {
    return JSON.parse(String(text || "").trim());
  } catch {
    // Some commands may include a leading log line before a compact JSON object.
  }
  try {
    return JSON.parse(String(text || "").trim().split("\n").pop());
  } catch {
    return null;
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function entriesSinceLastGate(state, template, currentNode) {
  let lastGateHistIdx = -1;
  for (let i = state.history.length - 1; i >= 0; i--) {
    const h = state.history[i];
    const nt = template.nodeTypes?.[h.nodeId];
    if (nt === "gate" && h.nodeId !== currentNode) {
      lastGateHistIdx = i;
      break;
    }
  }
  return lastGateHistIdx === -1 ? state.history : state.history.slice(lastGateHistIdx + 1);
}

function hasEvalFiles(dir, nodeId) {
  const nodeDir = join(dir, "nodes", nodeId);
  let runs = [];
  try {
    runs = readdirSync(nodeDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^run_\d+$/.test(e.name))
      .sort((a, b) => Number(b.name.slice(4)) - Number(a.name.slice(4)));
  } catch {
    return false;
  }
  for (const run of runs) {
    const runDir = join(nodeDir, run.name);
    try {
      if (readdirSync(runDir).some(f => /^eval.*\.md$/.test(f) && f !== "eval-extensions.md")) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function collectGateSynthesizeReasons(dir, state, template, currentNode, verdict) {
  if (verdict !== "PASS") return [];
  const reasons = [];
  const seen = new Set();
  for (const entry of entriesSinceLastGate(state, template, currentNode)) {
    const nodeId = entry.nodeId;
    if (seen.has(nodeId) || template.nodeTypes?.[nodeId] !== "review") continue;
    if (!hasEvalFiles(dir, nodeId)) continue;
    seen.add(nodeId);
    let output;
    try {
      output = execFileSync(
        "node",
        [harnessPath(), "synthesize", "--node", nodeId, "--dir", dir, "--base", synthesizeBaseForState(state)],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch (err) {
      reasons.push(`synthesize failed for ${nodeId}: ${err.stderr || err.message}`);
      continue;
    }
    const synth = parseJsonLastLine(output);
    if (!synth) {
      reasons.push(`synthesize output for ${nodeId} was not valid JSON`);
    } else if (synth.verdict && synth.verdict !== "PASS") {
      reasons.push(`synthesize verdict for ${nodeId} is ${synth.verdict}, not PASS`);
    }
  }
  return reasons;
}

function normalizeHandshakeVerdict(value) {
  const verdict = String(value || "").toUpperCase();
  return ["PASS", "FAIL", "ITERATE", "BLOCKED"].includes(verdict) ? verdict : null;
}

function collectGateHandshakeVerdictReasons(dir, state, template, currentNode, verdict) {
  if (verdict !== "PASS") return [];
  const reasons = [];
  const seen = new Set();
  for (const entry of entriesSinceLastGate(state, template, currentNode)) {
    const nodeId = entry.nodeId;
    const nodeType = template.nodeTypes?.[nodeId];
    if (seen.has(nodeId) || !nodeType || nodeType === "gate") continue;
    seen.add(nodeId);
    const hsPath = nodeHandshakePath(dir, nodeId);
    if (!existsSync(hsPath)) continue;
    let handshake;
    try { handshake = JSON.parse(readFileSync(hsPath, "utf8")); } catch { continue; }
    const sealedVerdict = normalizeHandshakeVerdict(handshake?.verdict);
    if (sealedVerdict && sealedVerdict !== "PASS") {
      reasons.push(`sealed verdict for ${nodeId} is ${sealedVerdict}, not PASS`);
    }
  }
  return reasons;
}

function collectGateVerdictReasons(dir, state, template, currentNode, verdict) {
  return [
    ...collectGateHandshakeVerdictReasons(dir, state, template, currentNode, verdict),
    ...collectGateSynthesizeReasons(dir, state, template, currentNode, verdict),
  ];
}

function hasOpcTestCommandEvidence(handshake) {
  const prov = handshake?.testEvidenceProvenance;
  return handshake?.nodeType === "execute"
    && /^test[-_]execute$/.test(String(handshake?.nodeId || ""))
    && prov?.kind === "opc-test-command"
    && prov?.executionActor === "opc-harness:test-command"
    && typeof prov?.commandHash === "string"
    && typeof prov?.sourcePlanHash === "string"
    && Array.isArray(handshake?.artifacts)
    && handshake.artifacts.some(a => a?.type === "test-result" && /\.json$/i.test(a?.path || ""));
}

function collectHandshakeStructuredReasons(dir, nodeId, hsPath, handshake) {
  const reasons = [];
  if (!Array.isArray(handshake?.artifacts)) return reasons;
  const evidenceContext = testEvidenceContext(dir, handshake);
  for (const art of handshake.artifacts) {
    if (art.type !== "test-result" || !/\.json$/i.test(art.path || "")) continue;
    const artPath = resolve(dirname(hsPath), art.path);
    let text;
    let data;
    try {
      text = readFileSync(artPath, "utf8");
      data = JSON.parse(text);
    } catch {
      reasons.push(`artifact ${art.path} unreadable — fail-closed`);
      continue;
    }
    reasons.push(...collectTestResultReasons(data, {
      handshake,
      nodeId,
      artifact: art,
      artifactHash: sha256(text),
      ...evidenceContext,
    }));
  }
  return reasons;
}

// ─── Step 1.5: Structured result check (extracted for testability) ───

/**
 * Scan upstream nodes (since last gate) for artifacts with type "report" or
 * "test-result". Returns an array of fail reasons. Empty array = PASS.
 * Fail-closed: unreadable artifacts produce a fail reason.
 */
export function checkStructuredResults(dir, state, template, currentNode) {
  const structuredFailReasons = [];
  structuredFailReasons.push(...collectGateCriteriaReasons(dir, state, template, currentNode));
  structuredFailReasons.push(...collectDiVerdictReasons(dir, state, template, currentNode));
  structuredFailReasons.push(...collectExtensionStartupReasons(dir, state, template, currentNode));
  const upstreamNodes = entriesSinceLastGate(state, template, currentNode)
    .filter(h => {
      const nt = template.nodeTypes?.[h.nodeId];
      return nt && nt !== "gate";
    });

  const seen = new Set();
  let requiredTestCommandEvidenceFound = false;
  for (const entry of upstreamNodes) {
    if (seen.has(entry.nodeId)) continue;
    seen.add(entry.nodeId);
    const hsPath = nodeHandshakePath(dir, entry.nodeId);
    if (!existsSync(hsPath)) continue;
    let hs;
    try { hs = JSON.parse(readFileSync(hsPath, "utf8")); } catch { continue; }
    if (!Array.isArray(hs.artifacts)) continue;
    if (template.requiredTestCommandEvidence && hasOpcTestCommandEvidence(hs)) {
      requiredTestCommandEvidenceFound = true;
    }

    for (const art of hs.artifacts) {
      if (art.type !== "report" && art.type !== "test-result") continue;
      const artPath = resolve(dirname(hsPath), art.path);
      let text;
      let data;
      try {
        text = readFileSync(artPath, "utf8");
        data = JSON.parse(text);
      } catch (e) {
        structuredFailReasons.push(`artifact ${art.path} unreadable — fail-closed`);
        continue;
      }
      const evidenceContext = testEvidenceContext(dir, hs);
      structuredFailReasons.push(...collectTestResultReasons(data, {
        handshake: hs,
        nodeId: entry.nodeId,
        artifact: art,
        artifactHash: sha256(text),
        ...evidenceContext,
      }));
    }
  }
  if (template.requiredTestCommandEvidence && !requiredTestCommandEvidenceFound) {
    structuredFailReasons.push("required OPC testCommand evidence missing before gate");
  }
  return structuredFailReasons;
}

// ─── transition ─────────────────────────────────────────────────

export async function cmdTransition(args) {
  const from = getFlag(args, "from");
  const toRaw = getFlag(args, "to");
  const verdict = getFlag(args, "verdict");
  const dir = resolveDir(args);

  // Normalize: CLI "--to null" arrives as string "null" — treat as JS null (terminal transition)
  const to = toRaw === "null" ? null : toRaw;

  if (!from || !verdict) {
    console.error("Usage: opc-harness transition --from <node> --to <node|null> --verdict <V> --flow <template> [--flow-file <path>] --dir <path>");
    process.exit(1);
  }

  // Terminal transition (to === null): delegate to finalize
  if (to === null) {
    // Load persisted state for _flow_file resolution (same as non-terminal path)
    let terminalState = null;
    const termStatePath = join(dir, "flow-state.json");
    if (existsSync(termStatePath)) {
      try { terminalState = JSON.parse(readFileSync(termStatePath, "utf8")); } catch { /* will be caught later */ }
    }
    // Verify the edge actually goes to null in the template
    const resolvedTpl = resolveFlowTemplate(args, terminalState);
    if (!resolvedTpl.error) {
      const edges = resolvedTpl.template.edges[from];
      if (edges && edges[verdict] === null) {
        // ── Step 1.5: Structured result check for terminal gate transitions ──
        // Terminal PASS edges delegate to cmdFinalize, bypassing _cmdTransitionLocked.
        // We must check here to prevent finalize-path bypass.
        const nodeType = resolvedTpl.template.nodeTypes?.[from];
        if (nodeType === "gate" && verdict !== "FAIL") {
          const stPath = join(dir, "flow-state.json");
          let st = null;
          try { st = JSON.parse(readFileSync(stPath, "utf8")); } catch { /* handled below */ }
          if (st) {
            const synthReasons = collectGateVerdictReasons(dir, st, resolvedTpl.template, from, verdict);
            if (synthReasons.length > 0) {
              console.log(JSON.stringify({
                allowed: false,
                reason: `gate synthesize check failed: ${synthReasons.join("; ")}`,
                synthesizeFailReasons: synthReasons,
              }));
              return;
            }
            const failReasons = checkStructuredResults(dir, st, resolvedTpl.template, from);
            if (failReasons.length > 0) {
              console.log(JSON.stringify({
                allowed: false,
                reason: `Step 1.5 structural check failed: ${failReasons.join("; ")} — verdict must be FAIL, not ${verdict}`,
                structuredFailReasons: failReasons,
              }));
              return;
            }
          }
        }
        // Valid terminal edge — run finalize instead
        cmdFinalize(args);
        return;
      }
    }
    console.log(JSON.stringify({ allowed: false, reason: `no terminal edge '${from}' --${verdict}--> null` }));
    return;
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
    await _cmdTransitionLocked(from, to, verdict, flow, dir, template, statePath, args);
  } finally {
    lock.release();
  }
}

async function _cmdTransitionLocked(from, to, verdict, flow, dir, template, statePath, args) {
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
  // Structural checks block. Quality checks (eval artifacts) become warnings.
  if (!isGate) {
    const fromHandshakePath = nodeHandshakePath(dir, from);
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
    const sealedVerdict = normalizeHandshakeVerdict(hsData.verdict);
    if (sealedVerdict && sealedVerdict !== verdict) {
      hsErrors.push(`sealed verdict is '${sealedVerdict}', but requested transition verdict is '${verdict}'`);
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
    const structuredReasons = collectHandshakeStructuredReasons(dir, from, fromHandshakePath, hsData);
    if (structuredReasons.length > 0 && verdict !== "FAIL") {
      console.log(JSON.stringify({
        allowed: false,
        reason: `pre-transition structured result check failed: ${structuredReasons.join("; ")} — verdict must be FAIL, not ${verdict}`,
        structuredFailReasons: structuredReasons,
      }));
      return;
    }
  }

  // ── Test-design plan gate ──────────────────────────────────────
  if (!isGate && /^test[-_]design$/.test(from) && /^test[-_]execute$/.test(to) && verdict === "PASS") {
    const testPlanReasons = collectTestDesignPlanReasons(dir, from);
    if (testPlanReasons.length > 0) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `test-design gate failed: ${testPlanReasons.join("; ")}`,
        testPlanReasons,
      }));
      return;
    }
  }

  // ── OUT-2: Mandatory role enforcement when transitioning from review nodes ──
  if (!isGate && fromNodeType === "review") {
    const rolesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "roles");
    // roles directory is part of the package — if missing, something is very wrong
    let roleFiles;
    try {
      roleFiles = readdirSync(rolesDir).filter(f => f.endsWith(".md"));
    } catch (err) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `cannot read roles directory '${rolesDir}': ${err.message} — package may be corrupted`,
      }));
      return;
    }
    const mandatoryRoles = [];
    for (const rf of roleFiles) {
      const rawContent = readFileSync(join(rolesDir, rf), "utf8");
      const content = rawContent.replace(/\r\n/g, "\n");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = fmMatch[1];
        if (/mandatory:\s*true/i.test(fm)) {
          mandatoryRoles.push(rf.replace(/\.md$/, ""));
        }
      }
    }
    if (mandatoryRoles.length > 0) {
      const fromHandshakePath = nodeHandshakePath(dir, from);
      if (existsSync(fromHandshakePath)) {
        const hsData = JSON.parse(readFileSync(fromHandshakePath, "utf8"));
        const evalArtifacts = (hsData.artifacts || []).filter(a => a.type === "eval" || a.type === "evaluation");
        // Review nodes MUST have eval artifacts
        if (evalArtifacts.length === 0) {
          console.log(JSON.stringify({
            allowed: false,
            reason: `review node '${from}' has no eval-type artifacts — review nodes must produce evaluations`,
          }));
          return;
        }
        const allKnownRoles = new Set(roleFiles.map(f => f.replace(/\.md$/, "")));
        const presentRoles = new Set();
        for (const a of evalArtifacts) {
          const match = a.path.match(/eval-([^/]+)\.md$/);
          if (match) presentRoles.add(match[1]);
        }
        // Enforce mandatory roles when ANY present role is a known role from roles/ dir
        // (skip enforcement only when ALL roles are custom/test — no overlap with roles/ at all)
        const hasAnyKnownRole = [...presentRoles].some(r => allKnownRoles.has(r));
        if (hasAnyKnownRole) {
          const missingRoles = mandatoryRoles.filter(r => !presentRoles.has(r));
          if (missingRoles.length > 0) {
            console.log(JSON.stringify({
              allowed: false,
              error: `Missing mandatory role evaluations: [${missingRoles.join(", ")}]. Review node must include all mandatory roles.${mandatoryRoleHint(from)}`,
              missingRoles,
            }));
            return;
          }
        }
      }
    }
  }

  // ── Auto verdictAppend when leaving review node ──
  // Fire verdict.append so eval-extensions.json is written before validate checks it.
  // Only fires when there are actual eval files to supplement — avoids injecting
  // extension verdicts into empty review dirs (which would poison synthesize).
  if (!isGate && fromNodeType === "review") {
    try {
      const vConfig = loadOpcConfig(dir);
      Object.assign(vConfig, parseBypassArgs(args || []), { flowDir: dir });
      const vTask = readTaskFromAC(dir);
      const vRegistry = await loadExtensions(vConfig);
      const fromNodeCaps = template.nodeCapabilities?.[from] || [];
      if (fromNodeCaps.length > 0 && vRegistry.extensions?.length > 0) {
        const fromNodeDir = join(dir, "nodes", from);
        const latestRunDir = findLatestRunDir(fromNodeDir);
        if (latestRunDir) {
          // Check that real eval files exist (not just eval-extensions.md)
          let hasRealEvals = false;
          try {
            hasRealEvals = readdirSync(latestRunDir)
              .filter(f => /^eval-.*\.md$/.test(f) && f !== "eval-extensions.md")
              .length >= 2;
          } catch { /* best effort */ }
          if (hasRealEvals) {
            const vCtx = {
              node: from, nodeId: from, nodeType: fromNodeType,
              role: "verdict-auto", task: vTask, flowDir: resolve(dir),
              runDir: latestRunDir,
              devServerUrl: process.env.DEV_SERVER_URL || vConfig.devServerUrl || "",
              nodeCapabilities: fromNodeCaps,
            };
            await fireVerdictAppend(vRegistry, vCtx);
            saveRegistryCache(resolve(dir), vRegistry);
            const appliedExts = survivingExtensions(vRegistry);
            // Write extensionsApplied to run-level handshake
            const runHandshakePath = join(latestRunDir, "handshake.json");
            let runHandshake = {};
            try { runHandshake = JSON.parse(readFileSync(runHandshakePath, "utf8")); } catch { /* start fresh */ }
            runHandshake.extensionsApplied = appliedExts;
            writeFileSync(runHandshakePath, JSON.stringify(runHandshake, null, 2));
            // Also stamp node-level handshake (validate-chain checks this level)
            const nodeHandshakePath = join(fromNodeDir, "handshake.json");
            let nodeHandshake = {};
            try { nodeHandshake = JSON.parse(readFileSync(nodeHandshakePath, "utf8")); } catch { /* start fresh */ }
            nodeHandshake.extensionsApplied = appliedExts;
            writeFileSync(nodeHandshakePath, JSON.stringify(nodeHandshake, null, 2));
          }
        }
      }
    } catch (err) {
      console.error(`WARN: auto verdictAppend failed: ${err.message}`);
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
    const synthReasons = collectGateVerdictReasons(dir, state, template, from, verdict);
    if (synthReasons.length > 0) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `gate synthesize check failed: ${synthReasons.join("; ")}`,
        synthesizeFailReasons: synthReasons,
      }));
      return;
    }

    // ── Step 1.5: Structured result check (universal enforcement) ──
    // This runs on EVERY gate transition, regardless of entry path
    // (advance, pass, direct transition). Belt-and-suspenders with cmdAdvance.
    const structuredFailReasons = checkStructuredResults(dir, state, template, from);
    if (structuredFailReasons.length > 0 && verdict !== "FAIL") {
      console.log(JSON.stringify({
        allowed: false,
        reason: `Step 1.5 structural check failed: ${structuredFailReasons.join("; ")} — verdict must be FAIL, not ${verdict}`,
        structuredFailReasons,
      }));
      return;
    }

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
  try { writeCumulativeFindings(dir, state); } catch { /* best effort */ }

  let testCommandExecution = null;
  const toNodeType = template.nodeTypes?.[to] || null;
  if (toNodeType === "execute" && /^test[-_]execute$/.test(to) && (/^test[-_]design$/.test(from) || /^hotfix$/.test(from))) {
    const testSpecNode = /^hotfix$/.test(from) ? "test-design" : from;
    testCommandExecution = executeTestCommand(dir, to, runId, testSpecNode);
  }

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

  const autoReminder = state.autoMode ? "auto mode — do not pause, do not ask user, keep executing" : undefined;

  // ── Extension context for next node ────────────────────────────
  // Fire promptAppend so the orchestrator gets extension context without
  // having to remember to call prompt-context separately.
  let extensionContext = null;
  try {
    const config = loadOpcConfig(dir);
    Object.assign(config, parseBypassArgs(args || []), { flowDir: dir });
    const task = readTaskFromAC(dir);
    const registry = await loadExtensions(config);
    const nextNodeCaps = template.nodeCapabilities?.[to] || [];
    const nextNodeType = template.nodeTypes?.[to] || null;
    if (nextNodeCaps.length > 0 && registry.extensions?.length > 0) {
      const context = {
        node: to,
        nodeId: to,
        nodeType: nextNodeType,
        role: "transition-prefetch",
        task,
        flowDir: resolve(dir),
        devServerUrl: process.env.DEV_SERVER_URL || config.devServerUrl || "",
        nodeCapabilities: nextNodeCaps,
      };
      const append = [
        readCumulativeFindingsAppend(resolve(dir)),
        await firePromptAppend(registry, context),
      ].filter(Boolean).join("\n\n");
      extensionContext = {
        append,
        applied: survivingExtensions(registry),
        nodeCapabilities: nextNodeCaps,
      };
      saveRegistryCache(resolve(dir), registry);

      // Write to file so orchestrator can Read it instead of parsing stdout
      if (append) {
        const ctxDir = join(dir, "nodes", to);
        mkdirSync(ctxDir, { recursive: true });
        writeFileSync(join(ctxDir, "extension-context.md"), append, "utf8");
      }
    }
  } catch (err) {
    // Extension failures must not block transition
    console.error(`WARN: extension context prefetch failed: ${err.message}`);
  }

  console.log(JSON.stringify({
    allowed: true, reason: "ok", next: to, runId, state,
    ...(autoReminder ? { reminder: autoReminder } : {}),
    ...(testCommandExecution ? { testCommandExecution } : {}),
    ...(extensionContext?.append ? { extensionContextPath: resolve(join(dir, "nodes", to, "extension-context.md")) } : {}),
  }));
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

  // Load requiredExtensions from layered config (user → repo → cli).
  // validate-chain is post-hoc — it verifies claims, not environment state.
  let requiredExtensions = [];
  try {
    const cfg = loadOpcConfig(dir);
    if (Array.isArray(cfg.requiredExtensions)) requiredExtensions = cfg.requiredExtensions;
  } catch { /* best effort */ }

  // Resolve template for capability-aware enforcement
  let chainTemplate = null;
  if (state.flowTemplate) {
    if (state._flow_file) loadFlowFromFile(state._flow_file);
    chainTemplate = FLOW_TEMPLATES[state.flowTemplate] || null;
  }

  // ─── Bypass-aware requiredExtensions enforcement ─────────────────
  // If the flow was initialized under bypass (recorded in flow-state.bypassMode),
  // OR if the current invocation is under env/CLI bypass, the requiredExtensions
  // check is waived. Rationale: the bypass mechanism exists so a benchmark /
  // reproducible run on a vanilla machine can execute without any private
  // extensions; enforcing requiredExtensions after the fact would defeat that.
  // The bypass record persisted on flow-state is the audit trail.
  let bypassActive = false;
  let bypassSource = null;
  let waivedRequiredExtensions = [];
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
    waivedRequiredExtensions = requiredExtensions.slice();
    requiredExtensions = [];
  }

  for (const entry of state.history) {
    const nd = entry.node || entry.nodeId;
    const handshakePath = nodeHandshakePath(dir, nd);
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
        const hp = nodeHandshakePath(dir, nd);
        if (existsSync(hp)) {
          try {
            const data = JSON.parse(readFileSync(hp, "utf8"));
            if (!data.node && !data.nodeId) errors.push(`${nd}/handshake.json: missing node identifier`);
            if (!data.status) errors.push(`${nd}/handshake.json: missing status`);
            // Check extensionsApplied for required extensions — only on nodes with capabilities
            const isGateNode = nd.startsWith("gate") || data.node === "gate" || data.nodeId === "gate";
            const nodeType = data.nodeType || chainTemplate?.nodeTypes?.[nd] || "";
            const isPromptPhase = nodeType === "brief" || nodeType === "build";
            const nodeCaps = chainTemplate?.nodeCapabilities?.[nd] || [];
            if (requiredExtensions.length > 0 && !isGateNode && nodeCaps.length > 0) {
              if (!Object.hasOwn(data, "extensionsApplied")) {
                errors.push(`${nd}/handshake.json: extensionsApplied missing — run \`extension-verdict\` after review nodes`);
              } else {
                const applied = Array.isArray(data.extensionsApplied) ? data.extensionsApplied : [];
                for (const req of requiredExtensions) {
                  if (!applied.includes(req)) {
                    errors.push(`${nd}/handshake.json: required extension '${req}' missing from extensionsApplied`);
                  }
                }
                // Verify eval-extensions.json actually exists in the latest run dir
                // Prompt-phase nodes (brief, build) produce code, not evaluations —
                // they have extensionsApplied from prompt-context but no eval-extensions.json.
                // Only verdict-phase nodes (review, execute) produce eval artifacts.
                if (applied.length > 0 && !isPromptPhase) {
                  const latestRun = findLatestRunDir(join(nodesDir, nd));
                  if (!latestRun) {
                    errors.push(`${nd}: extensionsApplied claims [${applied.join(",")}] but no run directory exists`);
                  } else {
                    const evalExtPath = join(latestRun, "eval-extensions.json");
                    if (!existsSync(evalExtPath)) {
                      errors.push(`${nd}: extensionsApplied claims [${applied.join(",")}] but eval-extensions.json not found in ${basename(latestRun)}`);
                    }
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

  console.log(JSON.stringify({
    valid: errors.length === 0,
    errors,
    executedPath,
    bypassActive,
    bypassSource,
    waivedRequiredExtensions,
  }));
}

// ─── advance ──────────────────────────────────────────────────
// One-click gate advancement: synthesize upstream → route → transition/finalize.

export function cmdAdvance(args) {
  const dir = resolveDir(args);
  const statePath = join(dir, "flow-state.json");

  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ advanced: false, error: "flow-state.json not found" }));
    return;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ advanced: false, error: `corrupt flow-state.json: ${err.message}` }));
    return;
  }

  // Resolve template
  if (state._flow_file) loadFlowFromFile(state._flow_file);
  const template = FLOW_TEMPLATES[state.flowTemplate];
  if (!template) {
    console.log(JSON.stringify({ advanced: false, error: `unknown flow template: ${state.flowTemplate}` }));
    return;
  }

  const currentNode = state.currentNode;
  const nodeType = template.nodeTypes?.[currentNode] ||
    (currentNode === "gate" || currentNode.startsWith("gate-") ? "gate" : null);

  if (nodeType !== "gate") {
    console.log(JSON.stringify({
      advanced: false,
      error: `advance only works on gate nodes, current is '${currentNode}' (type: ${nodeType || "unknown"})`,
    }));
    return;
  }

  // Find upstream node: last non-gate entry in history
  const upstreamEntry = [...state.history].reverse().find(h => {
    const nt = template.nodeTypes?.[h.nodeId];
    return nt && nt !== "gate";
  });

  if (!upstreamEntry) {
    console.log(JSON.stringify({ advanced: false, error: "cannot find upstream non-gate node in history" }));
    return;
  }

  const upstreamNode = upstreamEntry.nodeId;

  // Step 1: synthesize
  console.error(`[advance] synthesizing ${upstreamNode}...`);
  let synthOutput;
  try {
    synthOutput = execFileSync(
      "node",
      [harnessPath(), "synthesize", "--node", upstreamNode, "--dir", dir, "--base", synthesizeBaseForState(state)],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch (err) {
    console.log(JSON.stringify({
      advanced: false,
      error: `synthesize failed: ${err.stderr || err.message}`,
      step: "synthesize",
    }));
    return;
  }

  let synthResult;
  synthResult = parseJsonLastLine(synthOutput) || {};
  let verdict = synthResult.verdict || "PASS";
  console.error(`[advance] synthesize verdict: ${verdict}`);

  // ── Step 1.5: Structured result check ──────────────────────────
  const structuredFailReasons = checkStructuredResults(dir, state, template, currentNode);
  if (structuredFailReasons.length > 0) {
    verdict = "FAIL";
    console.error(`[advance] Step 1.5 override → FAIL: ${structuredFailReasons.join("; ")}`);
  }

  // Step 2: route
  console.error(`[advance] routing ${currentNode} --${verdict}-->...`);
  let routeOutput;
  try {
    const routeArgs = [harnessPath(), "route", "--node", currentNode, "--verdict", verdict, "--flow", state.flowTemplate];
    if (state._flow_file) routeArgs.push("--flow-file", state._flow_file);
    routeArgs.push("--dir", dir);
    routeOutput = execFileSync(
      "node",
      routeArgs,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch (err) {
    console.log(JSON.stringify({
      advanced: false,
      error: `route failed: ${err.stderr || err.message}`,
      step: "route",
    }));
    return;
  }

  let routeResult;
  try {
    routeResult = JSON.parse(routeOutput.trim());
  } catch {
    console.log(JSON.stringify({ advanced: false, error: `route output not JSON: ${routeOutput}`, step: "route" }));
    return;
  }

  if (!routeResult.valid) {
    console.log(JSON.stringify({ advanced: false, error: `route invalid: ${routeResult.error}`, step: "route" }));
    return;
  }

  const next = routeResult.next;
  console.error(`[advance] next: ${next === null ? "null (terminal)" : next}`);

  // Step 3: transition (or finalize if terminal)
  const toArg = next === null ? "null" : next;
  console.error(`[advance] transitioning ${currentNode} → ${toArg}...`);
  try {
    const transArgs = [harnessPath, "transition", "--from", currentNode, "--to", toArg, "--verdict", verdict, "--flow", state.flowTemplate];
    if (state._flow_file) transArgs.push("--flow-file", state._flow_file);
    transArgs.push("--dir", dir);
    const transOutput = execFileSync(
      "node",
      transArgs,
      { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }
    );
    let transResult;
    try { transResult = JSON.parse(transOutput.trim().split("\n").pop()); } catch { transResult = {}; }

    console.log(JSON.stringify({
      advanced: true,
      verdict,
      upstream: upstreamNode,
      next,
      transition: transResult,
    }));
  } catch (err) {
    console.log(JSON.stringify({
      advanced: false,
      error: `transition failed: ${err.stderr || err.message}`,
      step: "transition",
    }));
  }
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

  const currentNodeType = template.nodeTypes?.[currentNode];
  const currentIsGate = currentNodeType === "gate" || currentNode === "gate" || currentNode.startsWith("gate-");
  if (currentIsGate) {
    const synthReasons = collectGateVerdictReasons(dir, state, template, currentNode, "PASS");
    const structuredReasons = checkStructuredResults(dir, state, template, currentNode);
    if (synthReasons.length > 0 || structuredReasons.length > 0) {
      console.log(JSON.stringify({
        finalized: false,
        error: [
          ...synthReasons.map(r => `gate verdict check failed: ${r}`),
          ...structuredReasons.map(r => `Step 1.5 structural check failed: ${r}`),
        ].join("; "),
        synthesizeFailReasons: synthReasons,
        structuredFailReasons: structuredReasons,
      }));
      return;
    }
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

  if (currentIsGate) {
    const terminalVerdict = normalizeHandshakeVerdict(hsData.verdict);
    if (terminalVerdict && terminalVerdict !== "PASS") {
      console.log(JSON.stringify({
        finalized: false,
        error: `terminal gate verdict is '${terminalVerdict}', expected PASS`,
      }));
      return;
    }
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
    try { writeCumulativeFindings(dir, freshState); } catch { /* best effort */ }

    // Post-finalize: GC old sessions (best-effort)
    try { gcSessions(); } catch { /* ignore */ }

    console.log(JSON.stringify({ finalized: true, flow, terminalNode: currentNode, totalSteps: freshState.totalSteps }));
  } finally {
    lock.release();
  }
}
