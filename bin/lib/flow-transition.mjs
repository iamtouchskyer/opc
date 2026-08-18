// Flow transition commands: transition, validate-chain, finalize
// Depends on: flow-templates.mjs, flow-core.mjs (validateHandshakeData), viz-commands.mjs, util.mjs, file-lock.mjs

import { readFileSync, readdirSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { join, dirname, resolve, basename, isAbsolute, relative } from "path";
import { fileURLToPath } from "url";
import os from "os";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { resolveFlowTemplate } from "./flow-templates.mjs";
import { scanNodeArtifacts, validateHandshakeData } from "./flow-core.mjs";
import { getMarker } from "./viz-commands.mjs";
import {
  getFlag, resolveDir, atomicWriteSync, gcSessions, getProjectRoot,
  WRITER_SIG, IDEMPOTENCY_WINDOW_MS,
} from "./util.mjs";
import { lockFile } from "./file-lock.mjs";
import { AUTO_MODE_REMINDER, createStopMarker, resolveCurrentRun } from "./runaway-guard.mjs";
import { resolveBypass, loadExtensions, firePromptAppend, fireVerdictAppend, participatingExtensions, readFailureReportState, readVerdictExtensionState, saveRegistryCache, writeFailureReport } from "./extensions.mjs";
import { parseBypassArgs } from "./bypass-args.mjs";
import {
  collectPromptExtensionProvenanceErrors,
  loadOpcConfig,
  readTaskFromAC,
  resolveNodeExtensionContext,
  resolveSelectedRunDir,
  writePromptExtensionProvenance,
} from "./ext-commands.mjs";
import { collectGateCriteriaReasons } from "./gate-criteria.mjs";
import { evaluateFlowBudget, isRepairVerdict } from "./flow-budget.mjs";
import { collectDiVerdictReasons } from "./di-verdict-gate.mjs";
import {
  collectTestCommandBindingReasons,
  executeTestCommand,
  loadTestCommandSpec,
  testCommandHash,
} from "./test-command-execution.mjs";
import { collectExtensionStartupReasons } from "./extension-startup-gate.mjs";
import { collectTestDesignPlanReasons } from "./test-plan-gate.mjs";
import { readCumulativeFindingsAppend, writeCumulativeFindings } from "./cumulative-findings.mjs";
import { collectTestResultReasons } from "./test-result-gate.mjs";
import { stoppedFlowError } from "./flow-state-guard.mjs";
import { canonicalProjectionErrors, resolveExactRunHandshake, sessionAuthorityErrors } from "./flow-evidence.mjs";

function nodeHandshakePath(dir, nodeId, runId = null) {
  const nodeDir = join(dir, "nodes", nodeId);
  if (typeof runId === "string" && /^run_\d+$/.test(runId)) {
    return resolveExactRunHandshake(dir, nodeId, runId).path || join(nodeDir, runId, "handshake.json");
  }
  return join(nodeDir, "handshake.json");
}

function requireHistoryRun(entry, context) {
  if (/^run_\d+$/.test(entry?.runId || "")) return null;
  return `${context}: history entry for '${entry?.nodeId || "unknown"}' has missing or invalid runId '${entry?.runId}'`;
}

function resolveHistoryHandshake(dir, entry, context) {
  const runError = requireHistoryRun(entry, context);
  if (runError) return { error: runError };
  const exact = resolveExactRunHandshake(dir, entry.nodeId, entry.runId);
  if (exact.error) return { error: `${context}: ${exact.error}` };
  if (exact.missing || !exact.path || !existsSync(exact.path)) {
    return { error: `${context}: missing handshake for node '${entry.nodeId}' run '${entry.runId}'` };
  }
  return exact;
}

function strictHistoryEntries(state) {
  const history = Array.isArray(state.history) ? state.history : [];
  const entries = [];
  const seen = new Set();
  const entryNode = typeof state.entryNode === "string" ? state.entryNode : null;
  if (entryNode) {
    entries.push({ nodeId: entryNode, runId: "run_1", legacyInitial: true });
    seen.add(`${entryNode}\0run_1`);
  }
  for (const entry of history) {
    const key = `${entry?.nodeId || ""}\0${entry?.runId || ""}`;
    if (seen.has(key)) continue;
    entries.push(entry);
    seen.add(key);
  }
  return entries;
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
  const sourceRunId = handshake?.testEvidenceProvenance?.sourceRunId;
  if (!/^run_\d+$/.test(sourceRunId || "")) return {};
  const spec = loadTestCommandSpec(dir, sourceNode, sourceRunId);
  if (!spec) return {};
  return {
    expectedCommandHash: testCommandHash(spec.testCommand),
    expectedSourcePlanHash: spec.sourcePlanHash,
    allowVacuousChecks: spec.allowVacuousChecks,
  };
}

function runOrdinalArg(runId) {
  const match = /^run_(\d+)$/.exec(String(runId || ""));
  return match ? match[1] : null;
}

function latestHistoryEntryForNode(state, nodeId) {
  for (let i = (state.history || []).length - 1; i >= 0; i--) {
    const entry = state.history[i];
    if (entry?.nodeId === nodeId) return entry;
  }
  return null;
}

function handshakeBaseDir(hsPath) {
  const parent = dirname(hsPath);
  return /^run_\d+$/.test(basename(parent)) ? dirname(parent) : parent;
}

function handshakeValidationBaseDir(hsPath, handshake) {
  const parent = dirname(hsPath);
  if (!/^run_\d+$/.test(basename(parent))) return parent;
  const artifacts = Array.isArray(handshake?.artifacts) ? handshake.artifacts : [];
  return artifacts.some((artifact) =>
    typeof artifact?.path === "string" && !/^run_\d+\//.test(artifact.path)
  ) ? parent : dirname(parent);
}

const NODE_LEVEL_AUTHORITY_ARTIFACTS = new Set([
  "build-brief.md",
  "test-plan.md",
  "test-execution.json",
]);

function isWithinDir(base, target) {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function strictArtifactPath(hsPath, artifactPath) {
  if (typeof artifactPath !== "string" || artifactPath.length === 0) {
    return { error: "artifact path missing or invalid" };
  }
  if (artifactPath.includes("\0") || isAbsolute(artifactPath)) {
    return { error: `artifact path '${artifactPath}' must be relative` };
  }
  const parent = dirname(hsPath);
  const runScoped = /^run_\d+$/.test(basename(parent));
  if (runScoped && artifactPath.startsWith("../")) {
    const nodeLevel = artifactPath.slice(3);
    if (!NODE_LEVEL_AUTHORITY_ARTIFACTS.has(nodeLevel)) {
      return { error: `artifact path '${artifactPath}' escapes run directory` };
    }
    const nodeDir = dirname(parent);
    const target = resolve(parent, artifactPath);
    return isWithinDir(nodeDir, target) ? { path: target } : { error: `artifact path '${artifactPath}' escapes node directory` };
  }
  if (artifactPath.split(/[\\/]+/).includes("..")) {
    return { error: `artifact path '${artifactPath}' contains traversal` };
  }
  const base = runScoped ? parent : dirname(hsPath);
  const target = resolve(base, artifactPath);
  return isWithinDir(base, target) ? { path: target } : { error: `artifact path '${artifactPath}' escapes artifact root` };
}

function resolveHandshakeArtifactPath(hsPath, artifactPath) {
  const resolved = strictArtifactPath(hsPath, artifactPath);
  if (resolved.error) throw new Error(resolved.error);
  return resolved.path;
}

function synthesizeBaseForState(state) {
  if (typeof state?.projectRoot === "string" && state.projectRoot) return state.projectRoot;
  return getProjectRoot();
}

// Scope the gate's changeScope layer to the commits this flow actually produced.
// Always emit the flag (empty when nothing was recorded) so finalize/advance get
// the flow-scoped behavior instead of a blind HEAD~1 diff. Empty → skip cleanly.
function changeCommitsArgs(state) {
  const commits = Array.isArray(state?.producedCommits) ? state.producedCommits : [];
  return ["--change-commits", commits.join(",")];
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

export function allocateNextRunId(history, runEntries, nodeId) {
  let maxRun = 0n;
  for (const entry of Array.isArray(history) ? history : []) {
    if (entry?.nodeId !== nodeId) continue;
    const match = /^run_(\d+)$/.exec(entry.runId || "");
    if (match) {
      const run = BigInt(match[1]);
      if (run > maxRun) maxRun = run;
    }
  }
  for (const entry of Array.isArray(runEntries) ? runEntries : []) {
    const name = typeof entry === "string" ? entry : entry?.name;
    const match = /^run_(\d+)$/.exec(name || "");
    if (match) {
      const run = BigInt(match[1]);
      if (run > maxRun) maxRun = run;
    }
  }
  return `run_${maxRun + 1n}`;
}

export function reserveRunDirectory(dir, nodeId, runId) {
  const nodeDir = join(dir, "nodes", nodeId);
  mkdirSync(nodeDir, { recursive: true });
  const runDir = join(nodeDir, runId);
  mkdirSync(runDir);
  return runDir;
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

function collectReviewEvalArtifactReasons(hsPath, nodeId, handshake) {
  const artifacts = Array.isArray(handshake?.artifacts) ? handshake.artifacts : [];
  const evalArtifacts = artifacts.filter(a => a?.type === "eval" || a?.type === "evaluation");
  if (evalArtifacts.length === 0) {
    return [`review node ${nodeId} has no eval artifacts, cannot prove PASS`];
  }
  const reasons = [];
  for (const art of evalArtifacts) {
    if (typeof art.path !== "string" || art.path.length === 0) {
      reasons.push(`review eval artifact for ${nodeId} has no path — fail-closed`);
      continue;
    }
    try {
      readFileSync(resolveHandshakeArtifactPath(hsPath, art.path), "utf8");
    } catch (err) {
      reasons.push(`review eval artifact for ${nodeId} unreadable: ${art.path} — fail-closed: ${err.message}`);
    }
  }
  return reasons;
}

function collectExtensionProvenanceReasons(dir, template, requiredExtensions, nodeId, data) {
  const nodeType = template?.nodeTypes?.[nodeId] || "";
  const nodeCaps = template?.nodeCapabilities?.[nodeId] || [];
  if (requiredExtensions.length === 0 || nodeType === "gate" || nodeCaps.length === 0) return [];
  const reasons = [];
  if (!Object.hasOwn(data, "extensionsApplied")) {
    return [`${nodeId}/handshake.json: extensionsApplied missing — run \`extension-verdict\` after review nodes`];
  }
  const applied = Array.isArray(data.extensionsApplied) ? data.extensionsApplied : [];
  for (const req of requiredExtensions) {
    if (!applied.includes(req)) reasons.push(`${nodeId}/handshake.json: required extension '${req}' missing from extensionsApplied`);
  }
  if (applied.length === 0) return reasons;
  const runId = data.runId;
  if (!/^run_\d+$/.test(runId || "")) return [...reasons, `${nodeId}/handshake.json: runId missing or invalid for extension provenance`];
  const runDir = join(dir, "nodes", nodeId, runId);
  if (!existsSync(runDir)) return [...reasons, `${nodeId}: extensionsApplied claims [${applied.join(",")}] but ${runId} does not exist`];
  if (nodeType === "brief" || nodeType === "build") {
    return reasons.concat(collectPromptExtensionProvenanceErrors(runDir, {
      nodeId,
      runId,
      extensionsApplied: applied,
    }).map((error) => `${nodeId}/${error}`));
  }
  const evalExtPath = join(runDir, "eval-extensions.json");
  if (!existsSync(evalExtPath)) return [...reasons, `${nodeId}: extensionsApplied claims [${applied.join(",")}] but eval-extensions.json not found in ${runId}`];
  try {
    const evalExtensions = JSON.parse(readFileSync(evalExtPath, "utf8"));
    if (!Array.isArray(evalExtensions.extensionsApplied)) return [...reasons, `${nodeId}/${runId}/eval-extensions.json: extensionsApplied missing or invalid`];
    for (const ext of applied) {
      if (!evalExtensions.extensionsApplied.includes(ext)) reasons.push(`${nodeId}/handshake.json: extension '${ext}' is not corroborated by ${runId}/eval-extensions.json`);
    }
  } catch (err) {
    reasons.push(`${nodeId}/${runId}/eval-extensions.json: parse error: ${err.message}`);
  }
  return reasons;
}

function collectGateSynthesizeReasons(dir, state, template, currentNode, verdict) {
  if (verdict !== "PASS") return [];
  const reasons = [];
  const reviewsByNode = new Map();
  for (const entry of entriesSinceLastGate(state, template, currentNode)) {
    if (template.nodeTypes?.[entry.nodeId] === "review") reviewsByNode.set(entry.nodeId, entry);
  }
  for (const entry of reviewsByNode.values()) {
    const nodeId = entry.nodeId;
    const exact = resolveHistoryHandshake(dir, entry, `gate synthesize check for ${nodeId}`);
    if (exact.error) {
      reasons.push(exact.error);
      continue;
    }
    const hsPath = exact.path;
    const handshake = exact.data;
    const artifactReasons = collectReviewEvalArtifactReasons(hsPath, nodeId, handshake);
    if (artifactReasons.length > 0) {
      reasons.push(...artifactReasons);
      continue;
    }
    let output;
    try {
      const synthArgs = [harnessPath(), "synthesize", "--node", nodeId, "--dir", dir, "--base", synthesizeBaseForState(state), ...changeCommitsArgs(state)];
      const runArg = runOrdinalArg(entry.runId);
      if (runArg) synthArgs.push("--run", runArg);
      output = execFileSync(
        "node",
        synthArgs,
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
  const upstreamByNode = new Map();
  for (const entry of entriesSinceLastGate(state, template, currentNode)) {
    const nodeId = entry.nodeId;
    const nodeType = template.nodeTypes?.[nodeId];
    if (nodeType && nodeType !== "gate") upstreamByNode.set(nodeId, entry);
  }
  for (const entry of upstreamByNode.values()) {
    const nodeId = entry.nodeId;
    const exact = resolveHistoryHandshake(dir, entry, `gate handshake verdict check for ${nodeId}`);
    if (exact.error) {
      reasons.push(exact.error);
      continue;
    }
    const handshake = exact.data;
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

function collectGateAuthorityReasons(dir, state, template, currentNode) {
  const reasons = [];
  const upstreamByNode = new Map();
  for (const entry of entriesSinceLastGate(state, template, currentNode)) {
    const nt = template.nodeTypes?.[entry?.nodeId];
    if (nt && nt !== "gate") upstreamByNode.set(entry.nodeId, entry);
  }
  for (const entry of upstreamByNode.values()) {
    const exact = resolveHistoryHandshake(dir, entry, `gate authority check for ${entry.nodeId}`);
    if (exact.error) {
      reasons.push(exact.error);
      continue;
    }
    reasons.push(...collectHandshakeSchemaReasons(dir, template, entry.nodeId, exact.path, exact.data)
      .map((reason) => `gate authority check for ${entry.nodeId}: ${reason}`));
  }
  reasons.push(...canonicalProjectionErrors(
    dir,
    state,
    canonicalProjectionValidator(dir, template),
    { entries: [...upstreamByNode.values()] },
  ));
  return reasons;
}

function hasOpcTestCommandEvidence(handshake) {
  const prov = handshake?.testEvidenceProvenance;
  return handshake?.nodeType === "execute"
    && /^test[-_]execute$/.test(String(handshake?.nodeId || ""))
    && prov?.kind === "opc-test-command"
    && prov?.executionActor === "opc-harness:test-command"
    && /^run_\d+$/.test(prov?.sourceRunId || "")
    && typeof prov?.commandHash === "string"
    && typeof prov?.sourcePlanHash === "string"
    && handshake?.testEvidencePolicy
    && typeof handshake.testEvidencePolicy === "object"
    && !Array.isArray(handshake.testEvidencePolicy)
    && Array.isArray(handshake?.artifacts)
    && handshake.artifacts.some(a => a?.type === "test-result" && /\.json$/i.test(a?.path || ""));
}

function collectHandshakeStructuredReasons(dir, nodeId, hsPath, handshake) {
  const reasons = [];
  if (!Array.isArray(handshake?.artifacts)) return reasons;
  const evidenceContext = testEvidenceContext(dir, handshake);
  for (const art of handshake.artifacts) {
    if (art.type !== "test-result" || !/\.json$/i.test(art.path || "")) continue;
    let artPath;
    try {
      artPath = resolveHandshakeArtifactPath(hsPath, art.path);
    } catch (error) {
      reasons.push(`artifact ${art.path} invalid path — fail-closed: ${error.message}`);
      continue;
    }
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
      runId: handshake?.runId,
      artifact: art,
      artifactHash: sha256(text),
      sessionDir: dir,
      ...evidenceContext,
    }));
  }
  return reasons;
}

function collectHandshakeSchemaReasons(dir, template, nodeId, hsPath, handshake) {
  const reasons = [];
  const { errors } = validateHandshakeData(handshake, {
    checkEvidence: true,
    softEvidence: !!template?.softEvidence,
    baseDir: handshakeValidationBaseDir(hsPath, handshake),
  });
  reasons.push(...errors);
  const nodeType = template?.nodeTypes?.[nodeId] || null;
  if (nodeType && handshake?.nodeType && handshake.nodeType !== nodeType) {
    reasons.push(`nodeType '${handshake.nodeType}' does not match authoritative type '${nodeType}'`);
  }
  if (Array.isArray(handshake?.artifacts)) {
    for (const artifact of handshake.artifacts) {
      const resolved = strictArtifactPath(hsPath, artifact?.path);
      if (resolved.error) {
        reasons.push(`artifact path '${artifact?.path ?? ""}' invalid: ${resolved.error}`);
      } else if (!existsSync(resolved.path)) {
        reasons.push(`artifact path '${artifact.path}' not found at deterministic authority path`);
      }
    }
  }
  return reasons;
}

function canonicalProjectionValidator(dir, template) {
  return (data, path, nodeId) => collectHandshakeSchemaReasons(dir, template, nodeId, path, data);
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
  const upstreamByNode = new Map();
  for (const entry of entriesSinceLastGate(state, template, currentNode)) {
    const nt = template.nodeTypes?.[entry.nodeId];
    if (nt && nt !== "gate") upstreamByNode.set(entry.nodeId, entry);
  }
  const upstreamNodes = [...upstreamByNode.values()];

  let requiredTestCommandEvidenceFound = false;
  for (const entry of upstreamNodes) {
    const exact = resolveHistoryHandshake(dir, entry, `structured result check for ${entry.nodeId}`);
    if (exact.error) {
      structuredFailReasons.push(`${exact.error} — fail-closed`);
      continue;
    }
    const hsPath = exact.path;
    const hs = exact.data;
    if (!Array.isArray(hs.artifacts)) continue;
    if (template.requiredTestCommandEvidence && hasOpcTestCommandEvidence(hs)) {
      requiredTestCommandEvidenceFound = true;
    }

    for (const art of hs.artifacts) {
      if (art.type !== "report" && art.type !== "test-result") continue;
      let artPath;
      try {
        artPath = resolveHandshakeArtifactPath(hsPath, art.path);
      } catch (error) {
        structuredFailReasons.push(`artifact ${art.path} invalid path — fail-closed: ${error.message}`);
        continue;
      }
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
        runId: entry.runId,
        artifact: art,
        artifactHash: sha256(text),
        sessionDir: dir,
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
        const budget = evaluateFlowBudget({
          state: terminalState,
          template: resolvedTpl.template,
          from,
          to: null,
          verdict,
        });
        if (!budget.allowed) {
          console.log(JSON.stringify({ allowed: false, reason: budget.reason }));
          return;
        }

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
    const stopped = stoppedFlowError(state, "transition");
    if (stopped) {
      console.log(JSON.stringify({ allowed: false, reason: stopped }));
      return;
    }
  } else {
    console.log(JSON.stringify({
      allowed: false,
      reason: "flow-state.json not found — run init before transitioning",
    }));
    return;
  }

  const edgeKey = `${from}\u2192${to}`;
  const isAutoRepairAttempt = state.autoMode === true
    && (verdict === "FAIL" || verdict === "ITERATE");
  let autoRepairCount = 0;

  if (isAutoRepairAttempt) {
    const counts = state.autoRepairCounts;
    if (counts !== undefined && (!counts || typeof counts !== "object" || Array.isArray(counts))) {
      console.log(JSON.stringify({
        allowed: false,
        requiresHuman: true,
        reason: "autoRepairCounts is invalid",
      }));
      return;
    }

    const rawCount = counts?.[edgeKey];
    if (rawCount !== undefined && (!Number.isInteger(rawCount) || rawCount < 0)) {
      console.log(JSON.stringify({
        allowed: false,
        requiresHuman: true,
        reason: `auto repair count is invalid for '${edgeKey}'`,
      }));
      return;
    }
    autoRepairCount = rawCount ?? 0;

    if (autoRepairCount >= 1) {
      try {
        createStopMarker(dir, state, {
          reason: "repair-edge-budget",
          edgeKey,
        });
      } catch (error) {
        console.log(JSON.stringify({
          allowed: false,
          requiresHuman: true,
          reason: `auto repair budget reached for '${edgeKey}', but stop marker creation failed: ${error.message}`,
        }));
        return;
      }
      console.log(JSON.stringify({
        allowed: false,
        requiresHuman: true,
        reason: `auto repair budget reached for '${edgeKey}'`,
      }));
      return;
    }
  }

  const budget = evaluateFlowBudget({ state, template, from, to, verdict });
  if (!budget.allowed) {
    console.log(JSON.stringify({ allowed: false, reason: budget.reason }));
    return;
  }
  const edgeCount = budget.edgeCount;

  // ── Gate detection ──
  const fromNodeType = template.nodeTypes ? template.nodeTypes[from] : null;
  const isGate = fromNodeType === "gate" || (fromNodeType == null && (from === "gate" || from.startsWith("gate-")));
  let sourceRunForTransition = null;
  let testSpecForExecution = null;

  // ── Pre-transition handshake validation ──
  // Structural checks block. Quality checks (eval artifacts) become warnings.
  if (!isGate) {
    const sourceRun = resolveCurrentRun(state);
    if (!sourceRun) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `pre-transition check: cannot resolve current run for node '${from}'`,
      }));
      return;
    }
    sourceRunForTransition = sourceRun;
    const canonicalHandshakePath = join(dir, "nodes", from, "handshake.json");
    if (existsSync(canonicalHandshakePath)) {
      let canonicalHandshake;
      try {
        canonicalHandshake = JSON.parse(readFileSync(canonicalHandshakePath, "utf8"));
      } catch (err) {
        console.log(JSON.stringify({
          allowed: false,
          reason: `pre-transition check: cannot parse canonical handshake.json for '${from}': ${err.message}`,
        }));
        return;
      }
      if (!canonicalHandshake || typeof canonicalHandshake !== "object" || Array.isArray(canonicalHandshake)) {
        console.log(JSON.stringify({
          allowed: false,
          reason: `pre-transition check: canonical handshake.json for '${from}' must contain an object`,
        }));
        return;
      }
      if (canonicalHandshake.runId && canonicalHandshake.runId !== sourceRun.runId) {
        console.log(JSON.stringify({
          allowed: false,
          reason: `pre-transition check: canonical handshake runId is '${canonicalHandshake.runId}', expected '${sourceRun.runId}' for node '${from}'`,
        }));
        return;
      }
    }
    const selectedRunHandshakePath = join(dir, "nodes", from, sourceRun.runId, "handshake.json");
    if (existsSync(selectedRunHandshakePath)) {
      let selectedRunHandshake;
      try {
        selectedRunHandshake = JSON.parse(readFileSync(selectedRunHandshakePath, "utf8"));
      } catch (err) {
        console.log(JSON.stringify({
          allowed: false,
          reason: `pre-transition check: cannot parse handshake.json for '${from}': ${err.message}`,
        }));
        return;
      }
      if (!selectedRunHandshake || typeof selectedRunHandshake !== "object" || Array.isArray(selectedRunHandshake)) {
        console.log(JSON.stringify({
          allowed: false,
          reason: `pre-transition check: handshake.json for '${from}' must contain an object`,
        }));
        return;
      }
      if (selectedRunHandshake.nodeId && selectedRunHandshake.nodeId !== from) {
        console.log(JSON.stringify({
          allowed: false,
          reason: `pre-transition check: handshake nodeId is '${selectedRunHandshake.nodeId}', expected '${from}'`,
        }));
        return;
      }
      if (selectedRunHandshake.runId && selectedRunHandshake.runId !== sourceRun.runId) {
        console.log(JSON.stringify({
          allowed: false,
          reason: `pre-transition check: handshake runId is '${selectedRunHandshake.runId}', expected '${sourceRun.runId}' for node '${from}'`,
        }));
        return;
      }
    }
    const sourceExact = resolveHistoryHandshake(
      dir,
      { nodeId: from, runId: sourceRun.runId },
      `pre-transition check for ${from}`,
    );
    if (sourceExact.error) {
      console.log(JSON.stringify({
        allowed: false,
        reason: sourceExact.error,
      }));
      return;
    }
    const fromHandshakePath = sourceExact.path;
    let hsData;
    try {
      hsData = sourceExact.data || JSON.parse(readFileSync(fromHandshakePath, "utf8"));
    } catch (err) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `pre-transition check: cannot parse handshake.json for '${from}': ${err.message}`,
      }));
      return;
    }
    if (hsData.runId !== sourceRun.runId) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `pre-transition check: handshake runId is '${hsData.runId}', expected '${sourceRun.runId}' for node '${from}'`,
      }));
      return;
    }
    const softEv = !!(template.softEvidence);
    const { errors: hsErrors, warnings: hsWarnings } = validateHandshakeData(hsData, {
      checkEvidence: true,
      softEvidence: softEv,
      baseDir: handshakeValidationBaseDir(fromHandshakePath, hsData),
    });
    if (hsData.status !== "completed") {
      hsErrors.push(`status is '${hsData.status}', expected 'completed'`);
    }
    const sealedVerdict = normalizeHandshakeVerdict(hsData.verdict);
    const toNodeType = template.nodeTypes ? template.nodeTypes[to] : null;
    const structuralReviewGatePass = fromNodeType === "review" && toNodeType === "gate" && verdict === "PASS";
    if (sealedVerdict && sealedVerdict !== verdict && !structuralReviewGatePass) {
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

  if (isGate) {
    const authorityReasons = collectGateAuthorityReasons(dir, state, template, from);
    if (authorityReasons.length > 0) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `gate authority check failed: ${authorityReasons.join("; ")}`,
        authorityReasons,
      }));
      return;
    }
  }

  // ── Test-design plan gate ──────────────────────────────────────
  if (!isGate && /^test[-_]design$/.test(from) && /^test[-_]execute$/.test(to) && verdict === "PASS") {
    const testPlanReasons = collectTestDesignPlanReasons(dir, from, sourceRunForTransition?.runId);
    if (testPlanReasons.length > 0) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `test-design gate failed: ${testPlanReasons.join("; ")}`,
        testPlanReasons,
      }));
      return;
    }
  }

  const toNodeType = template.nodeTypes?.[to] || null;
  if (!isGate && toNodeType === "execute" && /^test[-_]execute$/.test(to) && (/^test[-_]design$/.test(from) || /^hotfix$/.test(from))) {
    const sourceNode = /^hotfix$/.test(from) ? "test-design" : from;
    const hotfixSourceEntry = /^hotfix$/.test(from) ? latestHistoryEntryForNode(state, "test-design") : null;
    const sourceRunId = hotfixSourceEntry ? hotfixSourceEntry.runId : sourceRunForTransition?.runId;
    if (!/^run_\d+$/.test(sourceRunId || "")) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `testCommand source binding failed: '${sourceNode}' history runId is missing or invalid`,
        testCommandBindingReasons: [`${sourceNode} history runId is missing or invalid`],
      }));
      return;
    }
    const sourceExact = resolveHistoryHandshake(
      dir,
      { nodeId: sourceNode, runId: sourceRunId },
      `testCommand source binding for ${sourceNode}`,
    );
    if (sourceExact.error) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `testCommand source binding failed: ${sourceExact.error}`,
        testCommandBindingReasons: [sourceExact.error],
      }));
      return;
    }
    const bindingReasons = collectTestCommandBindingReasons(dir, sourceNode, sourceRunId);
    if (bindingReasons.length > 0) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `testCommand source binding failed: ${bindingReasons.join("; ")}`,
        testCommandBindingReasons: bindingReasons,
      }));
      return;
    }
    testSpecForExecution = { sourceNode, sourceRunId };
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
      const selectedReviewRun = resolveCurrentRun(state);
      const exact = resolveHistoryHandshake(
        dir,
        { nodeId: from, runId: selectedReviewRun?.runId },
        `mandatory role check for ${from}`,
      );
      if (exact.error) {
        console.log(JSON.stringify({ allowed: false, reason: exact.error }));
        return;
      }
      if (existsSync(exact.path)) {
        const hsData = exact.data || JSON.parse(readFileSync(exact.path, "utf8"));
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

  let targetRunEntries = [];
  try {
    targetRunEntries = readdirSync(join(dir, "nodes", to), { withFileTypes: true });
  } catch { /* target node has no run directory yet */ }
  const runId = allocateNextRunId(state.history, targetRunEntries, to);

  // ── Backlog enforcement for 🟡 findings ──
  if (isGate && (verdict === "PASS" || verdict === "ITERATE")) {
    const backlogPath = join(dir, "backlog.md");
    const upstreamByNode = new Map();
    for (const entry of entriesSinceLastGate(state, template, from)) {
      const nt = template.nodeTypes?.[entry?.nodeId];
      if (nt && nt !== "gate") upstreamByNode.set(entry.nodeId, entry);
    }
    for (const entry of upstreamByNode.values()) {
      const exact = resolveHistoryHandshake(dir, entry, `backlog check for ${entry.nodeId}`);
      if (exact.error) {
        console.log(JSON.stringify({ allowed: false, reason: exact.error }));
        return;
      }
      const warningCount = exact.data?.findings?.warning || 0;
      if (warningCount <= 0) continue;
      if (!existsSync(backlogPath)) {
        console.log(JSON.stringify({
          allowed: false,
          reason: `upstream '${entry.nodeId}' has ${warningCount} \ud83d\udfe1 warning(s) but backlog.md does not exist — write findings to backlog before transitioning`,
          backlog_required: true, upstream: entry.nodeId, warnings: warningCount,
        }));
        return;
      }
      const backlogText = readFileSync(backlogPath, "utf8");
      const escapedUpstreamId = entry.nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = `^\\s*-\\s*\\[[ x]\\]\\s*[\ud83d\udd34\ud83d\udfe1\ud83d\udd35\u23ed\ufe0f].*\\[${escapedUpstreamId}\\]`;
      const matches = backlogText.match(new RegExp(pattern, "gm")) || [];
      if (matches.length === 0) {
        console.log(JSON.stringify({
          allowed: false,
          reason: `upstream '${entry.nodeId}' has ${warningCount} \ud83d\udfe1 warning(s) but backlog.md has no formatted entries from '${entry.nodeId}'`,
          backlog_required: true, upstream: entry.nodeId, warnings: warningCount,
        }));
        return;
      }
      if (matches.length < warningCount) {
        console.log(JSON.stringify({
          allowed: false,
          reason: `upstream '${entry.nodeId}' has ${warningCount} \ud83d\udfe1 warning(s) but backlog.md only has ${matches.length} entries — need ${warningCount}`,
          backlog_required: true,
          upstream: entry.nodeId,
          warnings: warningCount,
          backlog_entries: matches.length,
        }));
        return;
      }
    }
  }

  let gateHandshakeWrite = null;
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

    const sourceRun = resolveCurrentRun(state);
    if (!sourceRun) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `cannot resolve current run for gate '${from}'`,
      }));
      return;
    }

    const gateDir = join(dir, "nodes", from);
    const gateHandshake = {
      nodeId: from,
      nodeType: "gate",
      runId: sourceRun.runId,
      status: "completed",
      verdict,
      summary: `verdict=${verdict}, next=${to}`,
      timestamp: new Date().toISOString(),
      artifacts: [],
      findings: null,
    };
    gateHandshakeWrite = {
      path: join(gateDir, "handshake.json"),
      content: JSON.stringify(gateHandshake, null, 2) + "\n",
    };
  }

  let autoReviewEvidence = null;
  if (!isGate && fromNodeType === "review") {
    try {
      const selectedRunDir = resolveSelectedRunDir(dir, from);
      const hasRealEvals = readdirSync(selectedRunDir)
        .filter((file) => /^eval-.*\.md$/.test(file) && file !== "eval-extensions.md")
        .length >= 2;
      if (hasRealEvals) {
        const runHandshakePath = join(selectedRunDir, "handshake.json");
        let runHandshake = {};
        if (existsSync(runHandshakePath)) {
          try {
            runHandshake = JSON.parse(readFileSync(runHandshakePath, "utf8"));
          } catch (error) {
            throw new Error(`handshake.json parse error: ${error.message}`);
          }
          if (!runHandshake || typeof runHandshake !== "object" || Array.isArray(runHandshake)) {
            throw new Error("handshake.json schema error: root must be an object");
          }
        }
        const nodeHandshakePath = join(dir, "nodes", from, "handshake.json");
        let nodeHandshake;
        try {
          nodeHandshake = JSON.parse(readFileSync(nodeHandshakePath, "utf8"));
        } catch (error) {
          throw new Error(`canonical handshake.json parse error: ${error.message}`);
        }
        if (!nodeHandshake || typeof nodeHandshake !== "object" || Array.isArray(nodeHandshake)) {
          throw new Error("canonical handshake.json schema error: root must be an object");
        }
        readFailureReportState(selectedRunDir);
        readVerdictExtensionState(selectedRunDir);
        autoReviewEvidence = {
          selectedRunDir,
          runHandshakePath,
          runHandshake,
          nodeHandshakePath,
          nodeHandshake,
        };
      }
    } catch (error) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `auto verdictAppend evidence refresh failed: ${error.message}`,
      }));
      return;
    }
  }

  try {
    reserveRunDirectory(dir, to, runId);
  } catch (error) {
    console.log(JSON.stringify({
      allowed: false,
      reason: `cannot reserve run directory 'nodes/${to}/${runId}': ${error.message}`,
    }));
    return;
  }

  // ── Auto verdictAppend when leaving review node ──
  // Reserve the target first: a collision must not run extensions or rewrite
  // source evidence. After hooks run, rescan their outputs into the canonical
  // node handshake and validate every machine-readable artifact before state
  // advances.
  if (!isGate && fromNodeType === "review" && autoReviewEvidence) {
    try {
      const vConfig = loadOpcConfig(dir);
      Object.assign(vConfig, parseBypassArgs(args || []), { flowDir: dir });
      const vTask = readTaskFromAC(dir);
      const vRegistry = await loadExtensions(vConfig);
      const selectedContext = resolveNodeExtensionContext(dir, from, args || [], {
        role: "verdict-auto",
        task: vTask,
        runDir: autoReviewEvidence.selectedRunDir,
        devServerUrl: process.env.DEV_SERVER_URL || vConfig.devServerUrl || "",
      });
      if (selectedContext.nodeCapabilities.length > 0 && vRegistry.extensions?.length > 0) {
        await fireVerdictAppend(vRegistry, selectedContext);
        saveRegistryCache(resolve(dir), vRegistry);
        const appliedExts = participatingExtensions(vRegistry, selectedContext, ["verdict.append"]);
        const fromNodeDir = join(dir, "nodes", from);
        const artifacts = scanNodeArtifacts(
          fromNodeDir,
          autoReviewEvidence.selectedRunDir,
          fromNodeType
        );
        const nodeHandshake = {
          ...autoReviewEvidence.nodeHandshake,
          extensionsApplied: appliedExts,
          artifacts,
        };
        const { errors: provenanceErrors } = validateHandshakeData(nodeHandshake, {
          checkEvidence: true,
          softEvidence: !!template.softEvidence,
          baseDir: fromNodeDir,
        });
        for (const artifact of artifacts) {
          if (!/\.json$/i.test(artifact.path)) continue;
          try {
            JSON.parse(readFileSync(join(fromNodeDir, artifact.path), "utf8"));
          } catch (error) {
            provenanceErrors.push(`artifact ${artifact.path} is not valid JSON — fail-closed: ${error.message}`);
          }
        }
        if (provenanceErrors.length > 0) {
          console.log(JSON.stringify({
            allowed: false,
            reason: `transition evidence refresh failed: ${provenanceErrors.join("; ")}`,
            handshakeErrors: provenanceErrors,
          }));
          return;
        }

        atomicWriteSync(
          autoReviewEvidence.nodeHandshakePath,
          JSON.stringify(nodeHandshake, null, 2) + "\n"
        );
        atomicWriteSync(
          autoReviewEvidence.runHandshakePath,
          JSON.stringify({
            ...autoReviewEvidence.runHandshake,
            extensionsApplied: appliedExts,
          }, null, 2) + "\n"
        );
      }
    } catch (err) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `auto verdictAppend evidence refresh failed: ${err.message}`,
      }));
      return;
    }
  }

  if (gateHandshakeWrite) {
    mkdirSync(dirname(gateHandshakeWrite.path), { recursive: true });
    atomicWriteSync(gateHandshakeWrite.path, gateHandshakeWrite.content);
  }

  state.history.push({ nodeId: to, runId, timestamp: new Date().toISOString() });
  state.currentNode = to;
  state.totalSteps++;
  state.edgeCounts[edgeKey] = edgeCount + 1;
  if (isRepairVerdict(verdict)) {
    state.repairEdgeCounts[edgeKey] = budget.repairCount + 1;
  }
  if (isAutoRepairAttempt) {
    state.autoRepairCounts ??= {};
    state.autoRepairCounts[edgeKey] = autoRepairCount + 1;
  }
  state._written_by = WRITER_SIG;
  state._last_modified = new Date().toISOString();

  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");
  try { writeCumulativeFindings(dir, state); } catch { /* best effort */ }

  let testCommandExecution = null;
  if (testSpecForExecution) {
    testCommandExecution = executeTestCommand(
      dir,
      to,
      runId,
      testSpecForExecution.sourceNode,
      testSpecForExecution.sourceRunId,
    );
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

  const autoReminder = state.autoMode ? AUTO_MODE_REMINDER : undefined;

  // ── Extension context for next node ────────────────────────────
  // Fire promptAppend so the orchestrator gets extension context without
  // having to remember to call prompt-context separately.
  let extensionContext = null;
  try {
    const config = loadOpcConfig(dir);
    Object.assign(config, parseBypassArgs(args || []), { flowDir: dir });
    const task = readTaskFromAC(dir);
    const registry = await loadExtensions(config);
    const targetRunDir = join(dir, "nodes", to, runId);
    const context = resolveNodeExtensionContext(dir, to, args || [], {
      role: "transition-prefetch",
      task,
      runDir: targetRunDir,
      devServerUrl: process.env.DEV_SERVER_URL || config.devServerUrl || "",
    });
    const nextNodeCaps = context.nodeCapabilities;
    if (nextNodeCaps.length > 0 && registry.extensions?.length > 0) {
      const append = [
        readCumulativeFindingsAppend(resolve(dir)),
        await firePromptAppend(registry, context),
      ].filter(Boolean).join("\n\n");
      const applied = participatingExtensions(registry, context, ["prompt.append"]);
      writeFailureReport(registry, targetRunDir);
      writePromptExtensionProvenance(targetRunDir, context, applied);
      extensionContext = { append, applied, nodeCapabilities: nextNodeCaps, runDir: targetRunDir };
      saveRegistryCache(resolve(dir), registry);

      // Write to the selected run so re-entry cannot reuse stale node-level context.
      if (append) {
        writeFileSync(join(targetRunDir, "extension-context.md"), append, "utf8");
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
    ...(extensionContext?.append ? { extensionContextPath: resolve(extensionContext.runDir, "extension-context.md") } : {}),
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

  if (!state || typeof state !== "object" || Array.isArray(state)) {
    console.log(JSON.stringify({ valid: false, errors: ["flow-state.json must contain an object"], executedPath: [] }));
    return;
  }
  if (!Array.isArray(state.history)) {
    console.log(JSON.stringify({ valid: false, errors: ["flow-state.json history must be an array"], executedPath: [] }));
    return;
  }

  const errors = [];
  errors.push(...sessionAuthorityErrors(state));
  const executedPath = [];

  // Load requiredExtensions from layered config (user → repo → cli).
  // validate-chain is post-hoc — it verifies claims, not environment state.
  let requiredExtensions = [];
  try {
    const cfg = loadOpcConfig(dir);
    if (Array.isArray(cfg.requiredExtensions)) requiredExtensions = cfg.requiredExtensions;
  } catch { /* best effort */ }

  // Resolve template for capability-aware enforcement
  const chainResolved = resolveFlowTemplate(args, state);
  const chainTemplate = chainResolved.template || null;
  if (chainResolved.error) errors.push(chainResolved.error);

  // ─── Bypass audit metadata ───────────────────────────────────────
  // Bypass controls extension execution only. It never changes post-hoc quality
  // truth: required extension provenance remains mandatory.
  let bypassActive = false;
  let bypassSource = null;
  const waivedRequiredExtensions = [];
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
  for (const entry of strictHistoryEntries(state)) {
    const nd = entry.node || entry.nodeId;
    executedPath.push(nd);

    const exact = resolveExactRunHandshake(dir, nd, entry.runId);
    if (exact.error) {
      errors.push(`${nd}/${entry.runId || "unknown"}: ${exact.error}`);
      continue;
    }
    if (exact.missing || !existsSync(exact.path)) {
      if (nd === state.currentNode) continue;
      errors.push(`missing handshake for node '${nd}' run '${entry.runId}'`);
      continue;
    }
    const hsErrors = collectHandshakeSchemaReasons(dir, chainTemplate, nd, exact.path, exact.data);
    if (hsErrors.length > 0) {
      errors.push(...hsErrors.map((error) => `${nd}/${entry.runId}: ${error}`));
    }
    const structuredErrors = collectHandshakeStructuredReasons(dir, nd, exact.path, exact.data);
    if (structuredErrors.length > 0) {
      errors.push(...structuredErrors.map((error) => `${nd}/${entry.runId}: ${error}`));
    }
    if (chainTemplate) {
      errors.push(...collectExtensionProvenanceReasons(dir, chainTemplate, requiredExtensions, nd, exact.data));
    }
  }
  errors.push(...canonicalProjectionErrors(dir, state, canonicalProjectionValidator(dir, chainTemplate)));

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
  const stopped = stoppedFlowError(state, "advance");
  if (stopped) {
    console.log(JSON.stringify({ advanced: false, error: stopped }));
    return;
  }

  // Resolve template
  const resolved = resolveFlowTemplate(args, state);
  if (resolved.error) {
    console.log(JSON.stringify({ advanced: false, error: resolved.error }));
    return;
  }
  const { template, name: flow } = resolved;

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
  const upstreamRun = runOrdinalArg(upstreamEntry.runId);
  if (!upstreamRun) {
    console.log(JSON.stringify({
      advanced: false,
      error: `cannot synthesize '${upstreamNode}': history runId is missing or invalid`,
      step: "synthesize",
    }));
    return;
  }
  const upstreamExact = resolveHistoryHandshake(dir, upstreamEntry, `advance synthesize for ${upstreamNode}`);
  if (upstreamExact.error) {
    console.log(JSON.stringify({ advanced: false, error: upstreamExact.error, step: "synthesize" }));
    return;
  }

  // Step 1: synthesize
  console.error(`[advance] synthesizing ${upstreamNode}...`);
  let synthOutput;
  try {
    const synthArgs = [
      harnessPath(),
      "synthesize",
      "--node",
      upstreamNode,
      "--dir",
      dir,
      "--base",
      synthesizeBaseForState(state),
      ...changeCommitsArgs(state),
      "--run",
      upstreamRun,
    ];
    synthOutput = execFileSync(
      "node",
      synthArgs,
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
    const transArgs = [harnessPath(), "transition", "--from", currentNode, "--to", toArg, "--verdict", verdict, "--flow", state.flowTemplate];
    if (state._flow_file) transArgs.push("--flow-file", state._flow_file);
    transArgs.push("--dir", dir);
    const transOutput = execFileSync(
      "node",
      transArgs,
      { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }
    );
    let transResult;
    try { transResult = JSON.parse(transOutput.trim().split("\n").pop()); } catch { transResult = {}; }

    if (transResult.allowed === false) {
      console.log(JSON.stringify({
        advanced: false,
        verdict,
        upstream: upstreamNode,
        next,
        transition: transResult,
        ...(transResult.requiresHuman ? { requiresHuman: true } : {}),
        reason: transResult.reason || "transition denied",
      }));
      return;
    }

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

  const lock = lockFile(statePath, { command: "finalize" });
  if (!lock.acquired) {
    console.log(JSON.stringify({ finalized: false, error: "could not acquire lock", holder: lock.holder }));
    return;
  }
  try {
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
  const stopped = stoppedFlowError(state, "finalize");
  if (stopped) {
    console.log(JSON.stringify({ finalized: false, error: stopped }));
    return;
  }

  const resolved = resolveFlowTemplate(args, state);
  if (resolved.error) {
    console.log(JSON.stringify({ finalized: false, error: resolved.error }));
    return;
  }
  const { template, name: flow } = resolved;

  const currentNode = state.currentNode;
  const nodeEdges = template.edges[currentNode];
  if (!nodeEdges || nodeEdges.PASS !== null) {
    console.log(JSON.stringify({
      finalized: false,
      error: `currentNode '${currentNode}' is not a terminal node (PASS edge \u2192 ${nodeEdges?.PASS ?? "undefined"}, expected null)`,
    }));
    return;
  }

  const currentRun = resolveCurrentRun(state);
  if (!currentRun) {
    console.log(JSON.stringify({
      finalized: false,
      error: `cannot resolve current run for terminal node '${currentNode}'`,
    }));
    return;
  }

  const budget = evaluateFlowBudget({
    state,
    template,
    from: currentNode,
    to: null,
    verdict: "PASS",
  });
  if (!budget.allowed) {
    console.log(JSON.stringify({ finalized: false, error: budget.reason }));
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

  // --strict: validate every visited history run with exact selected-run authority.
  if (strict) {
    const chainErrors = sessionAuthorityErrors(state);
    for (const entry of strictHistoryEntries(state)) {
      const nodeId = entry.nodeId;
      const exact = resolveHistoryHandshake(dir, entry, `--strict chain validation for ${nodeId}`);
      if (exact.error) {
        chainErrors.push(exact.error);
        continue;
      }
      const hsErrors = collectHandshakeSchemaReasons(dir, template, nodeId, exact.path, exact.data);
      for (const e of hsErrors) {
        chainErrors.push(`${nodeId}/${entry.runId}: ${e}`);
      }
    }
    chainErrors.push(...canonicalProjectionErrors(dir, state, canonicalProjectionValidator(dir, template)));
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
  let terminalExact = resolveExactRunHandshake(dir, currentNode, currentRun.runId);
  if ((terminalExact.missing || !existsSync(terminalExact.path || "")) && !existsSync(handshakePath)) {
    const terminalNodeType = template.nodeTypes?.[currentNode];
    if (terminalNodeType === "gate" || currentNode === "gate" || currentNode.startsWith("gate-")) {
      mkdirSync(join(dir, "nodes", currentNode, currentRun.runId), { recursive: true });
      const autoHandshake = {
        nodeId: currentNode,
        nodeType: "gate",
        runId: currentRun.runId,
        status: "completed",
        verdict: "PASS",
        summary: `Terminal gate finalized (auto-created)`,
        timestamp: new Date().toISOString(),
        artifacts: [],
        findings: null,
      };
      atomicWriteSync(terminalExact.path, JSON.stringify(autoHandshake, null, 2) + "\n");
      atomicWriteSync(handshakePath, JSON.stringify(autoHandshake, null, 2) + "\n");
      terminalExact = resolveExactRunHandshake(dir, currentNode, currentRun.runId);
    }
  }
  if (terminalExact.error || terminalExact.missing || !existsSync(terminalExact.path || "")) {
    console.log(JSON.stringify({
      finalized: false,
      error: terminalExact.error || `terminal exact handshake missing for '${currentNode}' run '${currentRun.runId}'`,
    }));
    return;
  }
  if (!existsSync(handshakePath)) {
    console.log(JSON.stringify({
      finalized: false,
      error: `terminal node '${currentNode}' canonical handshake.json not found — complete the node before finalizing`,
    }));
    return;
  }

  const hsData = terminalExact.data;

  if (hsData.runId !== currentRun.runId) {
    console.log(JSON.stringify({
      finalized: false,
      error: `terminal handshake runId is '${hsData.runId}', expected '${currentRun.runId}'`,
    }));
    return;
  }

  const terminalValidation = validateHandshakeData(hsData, {
    checkEvidence: true,
    softEvidence: !!template.softEvidence,
    baseDir: handshakeValidationBaseDir(terminalExact.path, hsData),
  });
  const projectionErrors = canonicalProjectionErrors(dir, state, canonicalProjectionValidator(dir, template));
  const terminalErrors = [
    ...terminalValidation.errors,
    ...collectHandshakeStructuredReasons(dir, currentNode, terminalExact.path, hsData),
    ...projectionErrors,
  ];
  if (terminalErrors.length > 0) {
    console.log(JSON.stringify({
      finalized: false,
      error: `terminal handshake validation failed: ${terminalErrors.join("; ")}`,
      handshakeErrors: terminalErrors,
    }));
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

  const freshState = state;
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
