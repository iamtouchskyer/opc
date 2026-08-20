// Flow transition commands: transition, validate-chain, finalize
// Depends on: flow-templates.mjs, flow-core.mjs (validateHandshakeData), viz-commands.mjs, util.mjs, file-lock.mjs

import {
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  lstatSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
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
import { compareRunIds } from "./run-id.mjs";
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
import {
  parsePlanEvidenceMapping,
  revalidateMissionEvidenceReceipts,
} from "./loop-helpers.mjs";
import { parseEvaluation, validateReviewClaimDispositions } from "./eval-parser.mjs";
import {
  guardMissionMutation,
  missionPromptContext,
  sealMissionRuntimeState,
  verifyMissionIntegrity,
} from "./mission-contract.mjs";
import {
  missionRuntimeStateDigest,
  validateMissionRuntimeStateSeal,
} from "./mission-runtime-seal.mjs";
import {
  commitTrajectoryObservation,
  consumeMissionRetryGrant,
  evaluateTrajectory,
  hasCurrentFinalCheckpoint,
  missionRetryGrantMatches,
  openMissionGate,
  registerFindingBatch,
  sealPendingMissionGate,
} from "./trajectory-gate.mjs";

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

function transitionGateTrigger(trigger, { dir, from, to }) {
  return {
    ...trigger,
    origin: {
      command: "transition",
      sessionSha256: sha256(resolve(dir)),
      fromNode: from,
      edgeKey: trigger?.edgeKey || `${from}→${to}`,
    },
  };
}

const CHILD_TRANSITION_STAGE_FILE = ".opc-child-transition-stage.json";
const CHILD_TRANSITION_RECEIPT_FIELD = "_parentTransitionReceipt";
const CHILD_TRANSITION_FAULT_ENV = "OPC_TEST_CHILD_TRANSITION_FAULT";

function maybeInjectChildTransitionFault(phase) {
  if (process.env[CHILD_TRANSITION_FAULT_ENV] === phase) {
    throw new Error(`injected child transition fault: ${phase}`);
  }
}

function currentRuntimeBinding(state) {
  const seal = state?._missionRuntimeSeal || null;
  return {
    sealId: seal?.sealId || null,
    generation: seal?.generation ?? null,
    authoritativeStateSha256: seal?.authoritativeStateSha256 || null,
  };
}

function transitionSourceManifest(dir, from, runId = null) {
  const sessionDir = realpathSync(resolve(dir));
  const nodesDir = resolve(sessionDir, "nodes");
  const unresolvedNodeDir = resolve(nodesDir, from);
  const path = nodeHandshakePath(sessionDir, from, runId);
  if (!existsSync(path)) return { ok: false, error: `source handshake '${from}' is missing` };
  try {
    const nodeStat = lstatSync(unresolvedNodeDir);
    if (!nodeStat.isDirectory() || nodeStat.isSymbolicLink()) {
      return { ok: false, error: `source node '${from}' is not a contained regular directory` };
    }
    const nodeDir = realpathSync(unresolvedNodeDir);
    if (!pathIsWithin(nodesDir, nodeDir)) {
      return { ok: false, error: `source node '${from}' escapes the child session` };
    }
    const handshakeStat = lstatSync(path);
    if (!handshakeStat.isFile() || handshakeStat.isSymbolicLink()
        || !pathIsWithin(nodeDir, realpathSync(path))) {
      return { ok: false, error: `source handshake '${from}' is not a contained regular file` };
    }
    const bytes = readFileSync(path);
    const handshake = JSON.parse(bytes.toString("utf8"));
    if (handshake.nodeId !== from || !/^run_\d+$/.test(String(handshake.runId || ""))
        || (runId && handshake.runId !== runId)) {
      return { ok: false, error: `source handshake '${from}' has an invalid node/run identity` };
    }
    const declaredArtifacts = Array.isArray(handshake.artifacts) ? handshake.artifacts : [];
    const unresolvedRunDir = resolve(nodeDir, handshake.runId);
    let runDir = null;
    if (existsSync(unresolvedRunDir)) {
      const runStat = lstatSync(unresolvedRunDir);
      if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
        return { ok: false, error: `source run '${from}/${handshake.runId}' is not a regular directory` };
      }
      runDir = realpathSync(unresolvedRunDir);
      if (!pathIsWithin(nodeDir, runDir)) {
        return { ok: false, error: `source run '${from}/${handshake.runId}' escapes its node directory` };
      }
    } else if (declaredArtifacts.length > 0) {
      return { ok: false, error: `source run '${from}/${handshake.runId}' is missing` };
    }
    const candidates = new Map();
    const addCandidate = (candidate, label, type = null, allowNodeLevel = false) => {
      const absolute = resolve(candidate);
      const contained = allowNodeLevel
        ? pathIsWithin(nodeDir, absolute)
        : Boolean(runDir && pathIsWithin(runDir, absolute));
      if (!contained || !existsSync(absolute)) {
        throw new Error(`source artifact '${label}' is not contained in its authoritative scope`);
      }
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`source artifact '${label}' is not a regular file`);
      }
      const real = realpathSync(absolute);
      if (!(allowNodeLevel ? pathIsWithin(nodeDir, real) : pathIsWithin(runDir, real))) {
        throw new Error(`source artifact '${label}' escapes its authoritative scope`);
      }
      const candidateRecord = {
        path: relative(nodeDir, real),
        type,
        sha256: sha256(readFileSync(real)),
      };
      const existing = candidates.get(real);
      if (!existing || (existing.type === null && type !== null)) candidates.set(real, candidateRecord);
    };
    for (const artifact of declaredArtifacts) {
      if (!artifact || typeof artifact.path !== "string" || !artifact.path.trim() || isAbsolute(artifact.path)) {
        return { ok: false, error: `source artifact declaration for '${from}' is invalid` };
      }
      let resolvedArtifact;
      try { resolvedArtifact = resolveHandshakeArtifactPath(path, artifact.path); } catch { resolvedArtifact = null; }
      if (!resolvedArtifact || !existsSync(resolvedArtifact)) {
        return { ok: false, error: `source artifact '${artifact.path}' is missing from '${handshake.runId}'` };
      }
      addCandidate(
        resolvedArtifact,
        artifact.path,
        artifact.type || null,
        !pathIsWithin(runDir, resolve(resolvedArtifact)),
      );
    }
    // Review and evidence validation consume run-local disposition, extension,
    // and provenance sidecars in addition to declared artifacts. Bind the
    // entire regular-file tree so none can change after parent publication.
    if (runDir) {
      const visitRun = current => {
        for (const name of readdirSync(current).sort()) {
          const candidate = join(current, name);
          const stat = lstatSync(candidate);
          if (stat.isSymbolicLink()) throw new Error(`source run entry '${relative(runDir, candidate)}' is a symlink`);
          if (stat.isDirectory()) {
            if (!pathIsWithin(runDir, realpathSync(candidate))) {
              throw new Error(`source run entry '${relative(runDir, candidate)}' escapes the current run`);
            }
            visitRun(candidate);
          } else if (stat.isFile()) {
            addCandidate(candidate, relative(runDir, candidate), null);
          }
        }
      };
      visitRun(runDir);
    }
    const testExecutionPath = join(nodeDir, "test-execution.json");
    if (existsSync(testExecutionPath)) {
      const stat = lstatSync(testExecutionPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { ok: false, error: `source test-execution.json for '${from}' is not a regular file` };
      }
      candidates.set(realpathSync(testExecutionPath), {
        path: "@node/test-execution.json",
        type: "test-execution",
        sha256: sha256(readFileSync(testExecutionPath)),
      });
    }
    const artifacts = [...candidates.values()].sort((a, b) =>
      a.path.localeCompare(b.path) || String(a.type).localeCompare(String(b.type)));
    return {
      ok: true,
      runId: handshake.runId,
      handshakeSha256: sha256(bytes),
      artifacts,
      artifactsSha256: sha256(JSON.stringify(artifacts)),
    };
  } catch (error) {
    return { ok: false, error: `source manifest for '${from}' is unreadable: ${error.message}` };
  }
}

function transitionInputManifest(dir, from, template, routeState) {
  const nodeRuns = new Map();
  const currentRun = resolveCurrentRun(routeState);
  if (!currentRun || routeState?.currentNode !== from || !/^run_\d+$/.test(currentRun.runId || "")) {
    return { ok: false, error: `cannot resolve authoritative source run for '${from}'` };
  }
  nodeRuns.set(from, currentRun.runId);
  if (template?.nodeTypes?.[from] === "gate") {
    for (const entry of entriesSinceLastGate(routeState, template, from)) {
      if (template.nodeTypes?.[entry.nodeId] !== "gate" && /^run_\d+$/.test(entry?.runId || "")) {
        nodeRuns.set(entry.nodeId, entry.runId);
      }
    }
  }
  const nodes = [];
  for (const nodeId of [...nodeRuns.keys()].sort()) {
    const manifest = transitionSourceManifest(dir, nodeId, nodeRuns.get(nodeId));
    if (!manifest.ok) return manifest;
    nodes.push({
      nodeId,
      runId: manifest.runId,
      handshakeSha256: manifest.handshakeSha256,
      artifacts: manifest.artifacts,
      artifactsSha256: manifest.artifactsSha256,
    });
  }
  return {
    ok: true,
    nodes,
    sha256: sha256(JSON.stringify(nodes)),
    primary: nodes.find(node => node.nodeId === from),
  };
}

function childTransitionStagePath(dir) {
  return join(realpathSync(resolve(dir)), CHILD_TRANSITION_STAGE_FILE);
}

function validChildTransitionJournal(journal) {
  const origin = journal?.origin;
  const child = journal?.child;
  const parent = journal?.parent;
  const mission = journal?.mission;
  return journal?.schemaVersion === 1
    && /^PCT-[a-f0-9]{32}$/.test(String(journal.transactionId || ""))
    && origin?.command === "transition"
    && typeof origin.childSession === "string"
    && /^[a-f0-9]{64}$/.test(String(origin.childSessionSha256 || ""))
    && typeof origin.flow === "string"
    && typeof origin.sourceNode === "string"
    && typeof origin.sourceRunId === "string"
    && typeof origin.edgeKey === "string"
    && typeof origin.targetNode === "string"
    && typeof origin.targetRunId === "string"
    && ["PASS", "FAIL", "ITERATE"].includes(origin.verdict)
    && /^[a-f0-9]{64}$/.test(String(origin.sourceHandshakeSha256 || ""))
    && Array.isArray(origin.sourceArtifacts)
    && /^[a-f0-9]{64}$/.test(String(origin.sourceArtifactsSha256 || ""))
    && Array.isArray(origin.inputManifests)
    && /^[a-f0-9]{64}$/.test(String(origin.inputManifestSha256 || ""))
    && typeof child?.preSealId === "string"
    && Number.isInteger(child?.preSealGeneration)
    && /^[a-f0-9]{64}$/.test(String(child?.preStateSha256 || ""))
    && child?.stageFile === CHILD_TRANSITION_STAGE_FILE
    && /^[a-f0-9]{64}$/.test(String(child?.stageSha256 || ""))
    && /^[a-f0-9]{64}$/.test(String(child?.postStateSha256 || ""))
    && typeof parent?.previousSealId === "string"
    && Number.isInteger(parent?.previousSealGeneration)
    && /^[a-f0-9]{64}$/.test(String(parent?.stateWithoutJournalSha256 || ""))
    && /^[a-f0-9]{64}$/.test(String(mission?.missionSha256 || ""))
    && (mission?.planSha256 === null || /^[a-f0-9]{64}$/.test(String(mission?.planSha256 || "")))
    && Number.isInteger(mission?.strategyEpoch);
}

function revalidateJournalInputManifest(dir, origin) {
  const expectedNodes = origin?.inputManifests;
  if (!Array.isArray(expectedNodes) || expectedNodes.length === 0) return { ok: false };
  const nodeIds = expectedNodes.map(node => node?.nodeId);
  if (nodeIds.some(nodeId => typeof nodeId !== "string" || !nodeId)
      || new Set(nodeIds).size !== nodeIds.length
      || JSON.stringify(nodeIds) !== JSON.stringify([...nodeIds].sort())) {
    return { ok: false };
  }
  const actualNodes = [];
  for (const expected of expectedNodes) {
    const manifest = transitionSourceManifest(dir, expected.nodeId, expected.runId);
    if (!manifest.ok) return { ok: false };
    const actual = {
      nodeId: expected.nodeId,
      runId: manifest.runId,
      handshakeSha256: manifest.handshakeSha256,
      artifacts: manifest.artifacts,
      artifactsSha256: manifest.artifactsSha256,
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return { ok: false };
    actualNodes.push(actual);
  }
  const inputSha256 = sha256(JSON.stringify(actualNodes));
  if (inputSha256 !== origin.inputManifestSha256) return { ok: false };
  return {
    ok: true,
    nodes: actualNodes,
    sha256: inputSha256,
    primary: actualNodes.find(node => node.nodeId === origin.sourceNode),
  };
}

function childTransitionAttemptMatches(journal, { dir, flow, from, to, verdict }) {
  if (!validChildTransitionJournal(journal)) return false;
  const origin = journal.origin;
  // Recovery must use the frozen, parent-signed node set. Re-deriving that set
  // from a post-transition history can accidentally add the new target node.
  const input = revalidateJournalInputManifest(dir, origin);
  const source = input.primary;
  return input.ok === true
    && source
    && origin.command === "transition"
    && origin.childSession === realpathSync(resolve(dir))
    && origin.childSessionSha256 === sha256(realpathSync(resolve(dir)))
    && origin.flow === flow
    && origin.sourceNode === from
    && origin.sourceRunId === source.runId
    && origin.sourceHandshakeSha256 === source.handshakeSha256
    && origin.sourceArtifactsSha256 === source.artifactsSha256
    && JSON.stringify(origin.sourceArtifacts) === JSON.stringify(source.artifacts)
    && origin.inputManifestSha256 === input.sha256
    && JSON.stringify(origin.inputManifests) === JSON.stringify(input.nodes)
    && origin.edgeKey === `${from}→${to}`
    && origin.targetNode === to
    && origin.verdict === verdict;
}

function childTransitionReceiptIdentityMatches(state, journal) {
  const receipt = state?.[CHILD_TRANSITION_RECEIPT_FIELD];
  return receipt?.schemaVersion === 1
    && receipt.transactionId === journal?.transactionId
    && receipt.parentSessionSha256 === sha256(resolve(state?.mission?.parentSession || ""))
    && receipt.originSha256 === sha256(JSON.stringify(journal?.origin || {}));
}

function childTransitionExactPostMatches(state, journal) {
  return childTransitionReceiptIdentityMatches(state, journal)
    && missionRuntimeStateDigest(state) === journal?.child?.postStateSha256;
}

function childTransitionDescendantMatches(state, journal) {
  const seal = state?._missionRuntimeSeal;
  return childTransitionReceiptIdentityMatches(state, journal)
    && Number.isInteger(seal?.generation)
    && seal.generation >= journal.child.preSealGeneration + 1;
}

function readCompletedJournalChild(journal) {
  if (!validChildTransitionJournal(journal)) {
    return { ok: false, error: "pending child transition journal is malformed" };
  }
  let childDir;
  try {
    childDir = realpathSync(resolve(journal.origin.childSession));
  } catch {
    return { ok: false, error: "pending child transition session is missing or unreadable" };
  }
  if (childDir !== journal.origin.childSession || sha256(childDir) !== journal.origin.childSessionSha256) {
    return { ok: false, error: "pending child transition session identity mismatch" };
  }
  const childStatePath = join(childDir, "flow-state.json");
  try {
    const stat = lstatSync(childStatePath);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(dirname(childStatePath)) !== childDir) {
      return { ok: false, error: "pending child transition active state is not a contained regular file" };
    }
    const childState = JSON.parse(readFileSync(childStatePath, "utf8"));
    const sealed = validateMissionRuntimeStateSeal({ sessionDir: childDir, state: childState, statePath: childStatePath });
    if (!sealed.ok) return { ok: false, error: sealed.errors.join("; ") };
    if (!childTransitionDescendantMatches(sealed.state, journal)) {
      return { ok: false, error: "pending child transition has no durable receipt-bearing child descendant" };
    }
    return { ok: true, state: sealed.state, dir: childDir, statePath: childStatePath };
  } catch (error) {
    return { ok: false, error: `pending child transition active state is unreadable: ${error.message}` };
  }
}

function archiveCompletedChildTransition(parentState) {
  const next = structuredClone(parentState);
  const journal = next.trajectory?.pendingChildTransition || null;
  if (!journal) return { ok: true, state: next };
  const completed = readCompletedJournalChild(journal);
  if (!completed.ok) return completed;
  next.trajectory.lastCompletedChildTransition = {
    ...journal,
    completedChildSeal: currentRuntimeBinding(completed.state),
  };
  delete next.trajectory.pendingChildTransition;
  return { ok: true, state: next };
}

function stagePendingChildTransition({
  dir,
  flow,
  from,
  to,
  verdict,
  targetRunId,
  childCandidate,
  parentState,
  lockedParentState,
  evidenceReceiptId = null,
  template,
}) {
  const archived = archiveCompletedChildTransition(parentState);
  if (!archived.ok) return archived;
  let parentBase = archived.state;
  if (parentBase.trajectory?.pendingChildTransition) {
    return { ok: false, error: "an incomplete child transition journal already exists" };
  }
  const childDir = realpathSync(resolve(dir));
  const activeChild = JSON.parse(readFileSync(join(childDir, "flow-state.json"), "utf8"));
  const childIntegrity = verifyMissionIntegrity({
    sessionDir: childDir,
    state: activeChild,
    statePath: join(childDir, "flow-state.json"),
  });
  if (!childIntegrity.ok) return { ok: false, error: childIntegrity.errors.join("; ") };
  const preChild = currentRuntimeBinding(childIntegrity.localState);
  if (!preChild.sealId || !Number.isInteger(preChild.generation) || !preChild.authoritativeStateSha256) {
    return { ok: false, error: "child transition requires a current Mission runtime seal" };
  }
  const input = transitionInputManifest(childDir, from, template, childIntegrity.localState);
  if (!input.ok) return input;
  const source = input.primary;
  const origin = {
    command: "transition",
    childSession: childDir,
    childSessionSha256: sha256(childDir),
    flow,
    sourceNode: from,
    sourceRunId: source.runId,
    sourceHandshakeSha256: source.handshakeSha256,
    sourceArtifacts: source.artifacts,
    sourceArtifactsSha256: source.artifactsSha256,
    inputManifests: input.nodes,
    inputManifestSha256: input.sha256,
    edgeKey: `${from}→${to}`,
    targetNode: to,
    targetRunId,
    verdict,
  };
  const previousParentSeal = currentRuntimeBinding(lockedParentState);
  parentBase._written_by = WRITER_SIG;
  parentBase._last_modified = new Date().toISOString();
  const parentWithoutJournalSha256 = missionRuntimeStateDigest(parentBase);
  const transactionSeed = {
    origin,
    mission: {
      missionSha256: parentBase.mission.sha256,
      planSha256: parentBase.mission.planSha256 ?? null,
      strategyEpoch: parentBase.mission.strategyEpoch,
    },
    parent: {
      previousSealId: previousParentSeal.sealId,
      previousSealGeneration: previousParentSeal.generation,
      stateWithoutJournalSha256: parentWithoutJournalSha256,
    },
    child: {
      preSealId: preChild.sealId,
      preSealGeneration: preChild.generation,
      preStateSha256: preChild.authoritativeStateSha256,
    },
  };
  const transactionId = `PCT-${sha256(JSON.stringify(transactionSeed)).slice(0, 32)}`;
  const originSha256 = sha256(JSON.stringify(origin));
  const stagedState = structuredClone(childCandidate);
  stagedState[CHILD_TRANSITION_RECEIPT_FIELD] = {
    schemaVersion: 1,
    transactionId,
    parentSessionSha256: sha256(resolve(stagedState.mission.parentSession)),
    originSha256,
  };
  const stageBytes = Buffer.from(`${JSON.stringify(stagedState, null, 2)}\n`, "utf8");
  const stagePath = childTransitionStagePath(childDir);
  atomicWriteSync(stagePath, stageBytes);
  const stageStat = lstatSync(stagePath);
  if (!stageStat.isFile() || stageStat.isSymbolicLink() || realpathSync(dirname(stagePath)) !== childDir) {
    return { ok: false, error: "child transition stage is not a contained regular file" };
  }
  const journal = {
    schemaVersion: 1,
    transactionId,
    origin,
    mission: transactionSeed.mission,
    parent: transactionSeed.parent,
    child: {
      ...transactionSeed.child,
      stageFile: CHILD_TRANSITION_STAGE_FILE,
      stageSha256: sha256(stageBytes),
      postStateSha256: missionRuntimeStateDigest(stagedState),
    },
    evidenceReceiptId,
    createdAt: parentBase._last_modified,
  };
  parentBase.trajectory ||= {};
  parentBase.trajectory.pendingChildTransition = journal;
  return { ok: true, parentState: parentBase, stagedState, stagePath, journal };
}

function readBoundChildTransitionStage(dir, journal) {
  const childDir = realpathSync(resolve(dir));
  const stagePath = childTransitionStagePath(childDir);
  try {
    const stat = lstatSync(stagePath);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(dirname(stagePath)) !== childDir) {
      return { ok: false, error: "child transition stage is not a contained regular file" };
    }
    const bytes = readFileSync(stagePath);
    if (sha256(bytes) !== journal.child.stageSha256) {
      return { ok: false, error: "child transition stage hash differs from the signed parent journal" };
    }
    const state = JSON.parse(bytes.toString("utf8"));
    if (missionRuntimeStateDigest(state) !== journal.child.postStateSha256) {
      return { ok: false, error: "child transition staged state digest differs from the signed parent journal" };
    }
    if (state?._missionRuntimeSeal?.sealId !== journal.child.preSealId
        || state?._missionRuntimeSeal?.generation !== journal.child.preSealGeneration
        || state?._missionRuntimeSeal?.authoritativeStateSha256 !== journal.child.preStateSha256) {
      return { ok: false, error: "child transition stage is not based on the bound pre-child seal" };
    }
    if (!childTransitionExactPostMatches(state, journal)) {
      return { ok: false, error: "child transition stage has no exact transaction receipt" };
    }
    return { ok: true, state, stagePath };
  } catch (error) {
    return { ok: false, error: `child transition stage is unreadable: ${error.message}` };
  }
}

function validatePublishedChildTransitionParent(parentState, journal) {
  if (!validChildTransitionJournal(journal)) {
    return { ok: false, error: "pending child transition journal is malformed" };
  }
  const rawSeal = parentState?._missionRuntimeSeal;
  if (rawSeal?.previousSealId !== journal.parent.previousSealId
      || rawSeal?.generation !== journal.parent.previousSealGeneration + 1) {
    return { ok: false, error: "pending child transition is not the immediate parent seal successor" };
  }
  const withoutJournal = structuredClone(parentState);
  delete withoutJournal.trajectory.pendingChildTransition;
  if (missionRuntimeStateDigest(withoutJournal) !== journal.parent.stateWithoutJournalSha256) {
    return { ok: false, error: "canonical parent state differs from the journal-bound transition effects" };
  }
  return { ok: true };
}

function promoteBoundChildTransition({ dir, statePath, journal }) {
  const active = JSON.parse(readFileSync(statePath, "utf8"));
  const integrity = verifyMissionIntegrity({ sessionDir: dir, state: active, statePath });
  if (!integrity.ok) return { ok: false, error: integrity.errors.join("; ") };
  const current = integrity.localState;
  if (missionRuntimeStateDigest(current) === journal.child.postStateSha256
      && childTransitionExactPostMatches(current, journal)) {
    return { ok: true, state: current, alreadyPublished: true };
  }
  const binding = currentRuntimeBinding(current);
  if (binding.sealId !== journal.child.preSealId
      || binding.generation !== journal.child.preSealGeneration
      || binding.authoritativeStateSha256 !== journal.child.preStateSha256) {
    return { ok: false, error: "child state is neither the journal-bound pre-state nor exact post-state" };
  }
  const staged = readBoundChildTransitionStage(dir, journal);
  if (!staged.ok) return staged;
  const sealed = sealMissionRuntimeState({
    sessionDir: dir,
    state: staged.state,
    statePath,
    reason: "transition-child-journal-commit",
  });
  if (!sealed.ok) return sealed;
  if (missionRuntimeStateDigest(sealed.state) !== journal.child.postStateSha256
      || !childTransitionExactPostMatches(sealed.state, journal)) {
    return { ok: false, error: "sealed child state differs from the signed transition journal" };
  }
  atomicWriteSync(statePath, JSON.stringify(sealed.state, null, 2) + "\n");
  return { ok: true, state: sealed.state, alreadyPublished: false };
}

function finishChildTransitionSideEffects({ dir, journal, state }) {
  try {
    mkdirSync(join(dir, "nodes", journal.origin.targetNode, journal.origin.targetRunId), { recursive: true });
  } catch (error) {
    return { ok: false, error: `could not finish recovered child run setup: ${error.message}` };
  }
  try { writeCumulativeFindings(dir, state); } catch { /* best effort, as in the normal transition path */ }
  return { ok: true };
}

function recoverPendingChildTransition({ dir, state, statePath, flow, from, to, verdict }) {
  if (!state?.mission?.parentSession) return { handled: false };
  const initialIntegrity = verifyMissionIntegrity({ sessionDir: dir, state, statePath });
  if (!initialIntegrity.ok) {
    return { handled: true, response: missionDenied(initialIntegrity.errors.join("; ")) };
  }
  const initialJournal = initialIntegrity.canonicalState.trajectory?.pendingChildTransition || null;
  if (!initialJournal) return { handled: false };

  const parentDir = initialIntegrity.canonicalDir;
  const parentStatePath = missionStatePath(parentDir);
  const parentLock = lockFile(parentStatePath, { command: "transition-child-journal-recovery" });
  if (!parentLock.acquired) {
    return {
      handled: true,
      response: missionDenied("could not acquire canonical parent Mission state lock", { holder: parentLock.holder }),
    };
  }
  try {
    const freshParent = JSON.parse(readFileSync(parentStatePath, "utf8"));
    const parentIntegrity = verifyMissionIntegrity({
      sessionDir: parentDir,
      state: freshParent,
      statePath: parentStatePath,
    });
    if (!parentIntegrity.ok) {
      return { handled: true, response: missionDenied(parentIntegrity.errors.join("; ")) };
    }
    const parentTerminal = parentIntegrity.canonicalState.trajectory?.terminal === true
      || parentIntegrity.canonicalState.trajectory?.terminalAction === "STOP_SALVAGE";
    if (parentTerminal) {
      return { handled: true, response: missionDenied("canonical parent Mission was terminated before child recovery") };
    }
    const journal = parentIntegrity.canonicalState.trajectory?.pendingChildTransition || null;
    if (!journal) return { handled: false };
    if (!validChildTransitionJournal(journal)) {
      return { handled: true, response: missionDenied("pending child transition journal is malformed") };
    }
    const exactAttempt = childTransitionAttemptMatches(journal, {
      dir,
      flow,
      from,
      to,
      verdict,
    });
    // Completion belongs to the journal-bound child, not whichever sibling is
    // currently invoking transition against the shared canonical parent.
    const completed = readCompletedJournalChild(journal);
    if (completed.ok) {
      if (!exactAttempt) return { handled: false, completedJournal: journal };
      try { rmSync(childTransitionStagePath(dir), { force: true }); } catch { /* completion is child-receipt bound */ }
      const finished = finishChildTransitionSideEffects({ dir: completed.dir, journal, state: completed.state });
      if (!finished.ok) return { handled: true, response: missionDenied(finished.error) };
      const receipt = journal.evidenceReceiptId
        ? (parentIntegrity.canonicalState.evidenceReceipts || []).find(item => item?.id === journal.evidenceReceiptId)
        : null;
      return {
        handled: true,
        response: {
          allowed: true,
          reason: "recovered already-published parent-linked child transition",
          recovered: true,
          duplicate: true,
          next: journal.origin.targetNode,
          runId: journal.origin.targetRunId,
          state: completed.state,
          ...(receipt ? { evidenceReceipt: receipt } : {}),
        },
      };
    }
    // Before the child receipt exists, no other protected parent mutation is
    // allowed. The journal must therefore still be the immediate parent-seal
    // successor and its non-journal effects must match exactly. Once the child
    // receipt exists, later legitimate parent successors do not invalidate
    // idempotent replay of the completed transaction.
    const published = validatePublishedChildTransitionParent(parentIntegrity.canonicalState, journal);
    if (!published.ok) return { handled: true, response: missionDenied(published.error) };
    if (!exactAttempt) {
      return {
        handled: true,
        response: missionDenied("pending child transition is bound to a different command, session, source, edge, verdict, or run"),
      };
    }
    const expectedTargetRunId = `run_${state.history.filter(entry => entry.nodeId === to).length + 1}`;
    if (journal.origin.targetRunId !== expectedTargetRunId) {
      return { handled: true, response: missionDenied("pending child transition target run no longer matches the child cursor") };
    }
    if (journal.mission.missionSha256 !== state.mission.sha256
        || journal.mission.planSha256 !== (state.mission.planSha256 ?? null)
        || journal.mission.strategyEpoch !== state.mission.strategyEpoch) {
      return { handled: true, response: missionDenied("pending child transition mission bindings no longer match") };
    }
    const promoted = promoteBoundChildTransition({ dir, statePath, journal });
    if (!promoted.ok) return { handled: true, response: missionDenied(promoted.error) };
    maybeInjectChildTransitionFault("after-child-publish");
    try { rmSync(childTransitionStagePath(dir), { force: true }); } catch { /* child receipt remains authoritative */ }
    const finished = finishChildTransitionSideEffects({ dir, journal, state: promoted.state });
    if (!finished.ok) return { handled: true, response: missionDenied(finished.error) };
    const receipt = journal.evidenceReceiptId
      ? (parentIntegrity.canonicalState.evidenceReceipts || []).find(item => item?.id === journal.evidenceReceiptId)
      : null;
    return {
      handled: true,
      response: {
        allowed: true,
        reason: "recovered parent-linked child transition from signed journal",
        recovered: true,
        next: journal.origin.targetNode,
        runId: journal.origin.targetRunId,
        state: promoted.state,
        ...(receipt ? { evidenceReceipt: receipt } : {}),
      },
    };
  } finally {
    parentLock.release();
  }
}

function missionParserContext(state) {
  return {
    criterionHashes: state?.mission?.criterionHashes || {},
    findingRegistry: state?.findingRegistry || [],
  };
}

function missionStatePath(dir) {
  const loopPath = join(dir, "loop-state.json");
  if (existsSync(loopPath)) return loopPath;
  return join(dir, "flow-state.json");
}

function parseEvidenceCriteria(raw) {
  if (raw == null || raw === "") return { ok: true, criteria: [] };
  const values = Array.isArray(raw) ? raw : (typeof raw === "string" ? raw.split(",") : null);
  if (!values || values.some(value => typeof value !== "string" || !value.trim())) {
    return { ok: false, error: "evidence.satisfies must be an array or comma-separated list of criterion IDs" };
  }
  return { ok: true, criteria: [...new Set(values.map(value => value.trim()))] };
}

function pathIsWithin(base, candidate) {
  const rel = relative(base, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}

function currentRunEvidenceArtifact({ dir, from, handshake, artifact }) {
  if (!artifact || typeof artifact.path !== "string" || !artifact.path.trim()) {
    return { ok: false, error: "evidence artifact path is missing" };
  }
  if (isAbsolute(artifact.path)) {
    return { ok: false, error: `evidence artifact must be relative to the current node run: ${artifact.path}` };
  }
  if (handshake.nodeId !== from || !/^run_\d+$/.test(String(handshake.runId || ""))) {
    return { ok: false, error: "evidence handshake node/run identity is invalid" };
  }
  const nodeDir = resolve(dir, "nodes", from);
  const runDir = resolve(nodeDir, handshake.runId);
  const artifactPath = [resolve(nodeDir, artifact.path), resolve(runDir, artifact.path)]
    .find(candidate => pathIsWithin(runDir, candidate) && existsSync(candidate));
  if (!artifactPath) {
    return { ok: false, error: `evidence artifact is not from current run '${handshake.runId}': ${artifact.path}` };
  }
  try {
    const runStat = lstatSync(runDir);
    const artifactStat = lstatSync(artifactPath);
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
      return { ok: false, error: `current evidence run is not a regular directory: ${handshake.runId}` };
    }
    if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
      return { ok: false, error: `evidence artifact is not a regular file: ${artifact.path}` };
    }
    const realNodeDir = realpathSync(nodeDir);
    const realRunDir = realpathSync(runDir);
    const realArtifactPath = realpathSync(artifactPath);
    if (!pathIsWithin(realNodeDir, realRunDir) || !pathIsWithin(realRunDir, realArtifactPath)) {
      return { ok: false, error: `evidence artifact escapes the current run: ${artifact.path}` };
    }
    return { ok: true, path: realArtifactPath };
  } catch {
    return { ok: false, error: `evidence artifact not found: ${artifact.path}` };
  }
}

function machinePassArtifact(path) {
  let content;
  try { content = readFileSync(path, "utf8"); } catch { return false; }
  if (!path.endsWith(".json")) return false;
  try {
    const data = JSON.parse(content);
    if (data.exitCode === 0 || data.pass === true) return true;
    if (["PASS", "PASSED", "SUCCESS"].includes(String(data.result || data.status || "").toUpperCase())) return true;
    const executed = Number(data.tests_run ?? data.testsRun ?? data.total ?? data.passed ?? 0);
    return executed > 0 && Number(data.failures ?? data.failed ?? data.fail ?? 0) === 0;
  } catch {
    return false;
  }
}

function nonVacuousMachineOracle(path) {
  let data;
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch { return false; }
  const checks = Array.isArray(data?.checks) ? data.checks : [];
  if (checks.length > 0 && checks.every(check =>
    check?.pass === true && Number.isFinite(Number(check.total)) && Number(check.total) > 0
  )) return true;
  const stdout = String(data?.stdout || "");
  for (const line of stdout.split(/\r?\n/)) {
    const marker = line.match(/^OPC_ORACLE\s+(.+)$/);
    if (!marker) continue;
    try {
      const oracle = JSON.parse(marker[1]);
      const oracleChecks = Array.isArray(oracle?.checks) ? oracle.checks : [];
      if (oracleChecks.length > 0 && oracleChecks.every(check =>
        check?.pass === true && Number.isFinite(Number(check.total)) && Number(check.total) > 0
      )) return true;
    } catch { /* malformed markers do not prove a non-vacuous PASS */ }
  }
  const tests = stdout.match(/^# tests\s+(\d+)\s*$/m);
  const failures = stdout.match(/^# fail\s+(\d+)\s*$/m);
  return Number(tests?.[1] || 0) > 0 && Number(failures?.[1] || 0) === 0;
}

function frozenStandardCriteriaMapping({ dir, handshake }) {
  const sourceNode = handshake?.testEvidenceProvenance?.sourceNode;
  if (!sourceNode) return { ok: false, error: "integrated evidence has no signed source test-plan node" };
  const sourceRunId = handshake?.testEvidenceProvenance?.sourceRunId;
  if (!/^run_\d+$/.test(sourceRunId || "")) {
    return { ok: false, error: "integrated evidence has no exact source test-plan run" };
  }
  const sourceHandshakePath = nodeHandshakePath(dir, sourceNode, sourceRunId);
  if (!existsSync(sourceHandshakePath)) return { ok: false, error: `source test-plan handshake '${sourceNode}' is missing` };
  let sourceHandshake;
  try { sourceHandshake = JSON.parse(readFileSync(sourceHandshakePath, "utf8")); } catch (error) {
    return { ok: false, error: `source test-plan handshake is unreadable: ${error.message}` };
  }
  const planArtifact = (sourceHandshake.artifacts || []).find(artifact => artifact?.type === "test-plan");
  if (!planArtifact) return { ok: false, error: "source test-plan handshake has no test-plan artifact" };
  const resolvedPlan = currentRunEvidenceArtifact({
    dir,
    from: sourceNode,
    handshake: sourceHandshake,
    artifact: planArtifact,
  });
  if (!resolvedPlan.ok) return resolvedPlan;
  const planText = readFileSync(resolvedPlan.path, "utf8");
  const planHash = sha256(planText);
  if (planHash !== handshake.testEvidenceProvenance.sourcePlanHash) {
    return { ok: false, error: "source test-plan changed after harness execution" };
  }
  const parsed = parsePlanEvidenceMapping(planText);
  if (parsed.error) return { ok: false, error: parsed.error };
  return {
    ok: true,
    criteria: parsed.criteria,
    scenarioId: parsed.scenarioId,
    validatorType: parsed.validatorType,
    planHash,
    path: resolvedPlan.path,
  };
}

function trustedHarnessExecutionRecord({ dir, nodeId, runId }) {
  const handshakePath = nodeHandshakePath(dir, nodeId, runId);
  let handshake;
  try { handshake = JSON.parse(readFileSync(handshakePath, "utf8")); } catch { return null; }
  if (handshake.runId !== runId || handshake.verdict !== "PASS" || !hasOpcTestCommandEvidence(handshake)) return null;
  const mapping = frozenStandardCriteriaMapping({ dir, handshake });
  if (!mapping.ok) return null;
  const artifact = (handshake.artifacts || []).find(item => item?.type === "test-result" && /\.json$/i.test(item.path || ""));
  if (!artifact) return null;
  const resolvedArtifact = currentRunEvidenceArtifact({ dir, from: nodeId, handshake, artifact });
  if (!resolvedArtifact.ok || !machinePassArtifact(resolvedArtifact.path) || !nonVacuousMachineOracle(resolvedArtifact.path)) return null;
  const text = readFileSync(resolvedArtifact.path, "utf8");
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const reasons = collectTestResultReasons(data, {
    handshake,
    nodeId,
    runId,
    artifact,
    artifactHash: sha256(text),
    sessionDir: dir,
    ...testEvidenceContext(dir, handshake),
  });
  if (reasons.length > 0) return null;
  return {
    nodeId,
    runId,
    sourceNode: handshake.testEvidenceProvenance.sourceNode,
    commandHash: handshake.testEvidenceProvenance.commandHash,
    sourcePlanHash: handshake.testEvidenceProvenance.sourcePlanHash,
    resultHash: handshake.testEvidenceProvenance.resultHash,
    scenarioId: mapping.scenarioId,
    validatorType: mapping.validatorType,
    satisfies: mapping.criteria,
    recordedAt: new Date().toISOString(),
  };
}

function recordStandardEvidenceReceipt({
  dir,
  state,
  template,
  from,
  verdict,
  canonicalState = null,
}) {
  if (!state?.mission || verdict !== "PASS" || template.nodeTypes?.[from] !== "execute") {
    return { state, canonicalUpdate: null, receipt: null };
  }
  const currentRun = resolveCurrentRun(state);
  if (!currentRun || state.currentNode !== from || !/^run_\d+$/.test(currentRun.runId || "")) {
    return { state, canonicalUpdate: null, receipt: null };
  }
  const handshakePath = nodeHandshakePath(dir, from, currentRun.runId);
  if (!existsSync(handshakePath)) return { state, canonicalUpdate: null, receipt: null };
  let handshake;
  try { handshake = JSON.parse(readFileSync(handshakePath, "utf8")); } catch {
    return { state, canonicalUpdate: null, receipt: null };
  }
  const evidenceArtifacts = (handshake.artifacts || []).filter(artifact =>
    ["test-result", "screenshot", "cli-output"].includes(artifact.type)
  );
  if (evidenceArtifacts.length === 0) return { state, canonicalUpdate: null, receipt: null };

  const integrity = verifyMissionIntegrity({ sessionDir: dir, state });
  if (!integrity.ok) return { error: integrity.errors.join("; ") };
  // A parent-linked child may already have a deferred trajectory mutation
  // (for example stale-receipt revalidation or retry consumption). Compose
  // the new receipt onto that exact canonical snapshot instead of starting
  // over from the on-disk parent and dropping one of the two updates.
  const working = structuredClone(canonicalState || integrity.canonicalState);
  const evidence = handshake.evidence && typeof handshake.evidence === "object" ? handshake.evidence : {};
  const scenarioId = evidence.scenarioId || handshake.scenarioId || null;
  const validatorType = evidence.validatorType || handshake.validatorType || null;
  const expectedScenario = working.mission.endToEndScenario?.id;
  const allowedTypes = new Set(working.mission.endToEndScenario?.validatorTypes || []);
  if (scenarioId && scenarioId !== expectedScenario) {
    return { error: `evidence scenario '${scenarioId}' does not match mission scenario '${expectedScenario}'` };
  }
  if (scenarioId && !allowedTypes.has(validatorType)) {
    return { error: `evidence validator type '${validatorType || "missing"}' is not allowed by the mission end-to-end scenario` };
  }
  const integrated = Boolean(scenarioId && validatorType && scenarioId === expectedScenario && allowedTypes.has(validatorType));
  const parsedCriteria = parseEvidenceCriteria(evidence.satisfies ?? handshake.satisfies ?? null);
  if (!parsedCriteria.ok) return { error: parsedCriteria.error };
  const unknownCriteria = parsedCriteria.criteria.filter(id => !Object.hasOwn(working.mission.criterionHashes || {}, id));
  if (unknownCriteria.length > 0) return { error: `evidence.satisfies contains unknown criteria: ${unknownCriteria.join(", ")}` };
  if (parsedCriteria.criteria.length > 0 && !integrated) {
    return { error: "criterion evidence requires the pinned end-to-end scenario and an allowed validator type" };
  }
  let frozenMapping = null;
  let trustedExecution = null;
  if (integrated) {
    if (!hasOpcTestCommandEvidence(handshake)) {
      const builtInOpcBoundary = template.requiredTestCommandEvidence === true && /^test[-_]execute$/.test(from);
      return {
        error: builtInOpcBoundary
          ? "integrated mission evidence requires harness-owned OPC testCommand provenance"
          : "integrated mission evidence requires a current hash-bound result minted by a trusted harness execution boundary",
      };
    }
    frozenMapping = frozenStandardCriteriaMapping({ dir, handshake });
    if (!frozenMapping.ok) return { error: frozenMapping.error };
    if (frozenMapping.scenarioId !== scenarioId) {
      return { error: `evidence scenario must exactly match the source test-plan frozen mapping (${frozenMapping.scenarioId})` };
    }
    if (frozenMapping.validatorType !== validatorType) {
      return { error: `evidence validator type must exactly match the source test-plan frozen mapping (${frozenMapping.validatorType})` };
    }
    const frozen = [...frozenMapping.criteria].sort();
    const claimed = [...parsedCriteria.criteria].sort();
    if (JSON.stringify(frozen) !== JSON.stringify(claimed)) {
      return {
        error: `evidence.satisfies must exactly match the source test-plan frozen mapping (${frozenMapping.criteria.join(",")})`,
      };
    }
    trustedExecution = (Array.isArray(state?._harnessEvidenceExecutions) ? state._harnessEvidenceExecutions : [])
      .find(record => record?.nodeId === from
        && record?.runId === handshake.runId
        && record?.sourceNode === handshake.testEvidenceProvenance.sourceNode
        && record?.commandHash === handshake.testEvidenceProvenance.commandHash
        && record?.sourcePlanHash === handshake.testEvidenceProvenance.sourcePlanHash
        && record?.resultHash === handshake.testEvidenceProvenance.resultHash);
    if (!trustedExecution) {
      return { error: "integrated mission evidence was not produced by this flow's trusted harness execution boundary" };
    }
    if (trustedExecution.scenarioId !== scenarioId || trustedExecution.validatorType !== validatorType ||
        JSON.stringify([...trustedExecution.satisfies].sort()) !== JSON.stringify([...parsedCriteria.criteria].sort())) {
      return { error: "execute handshake evidence metadata differs from the mapping frozen before harness execution" };
    }
  }
  const receipts = Array.isArray(working.evidenceReceipts) ? working.evidenceReceipts : [];
  const nextId = receipts.reduce((max, receipt) => {
    const match = String(receipt?.id || "").match(/^EV-(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
  const artifactHashes = [];
  const artifactPaths = [];
  const artifactBindings = [];
  const passingResultPaths = [];
  for (const artifact of evidenceArtifacts) {
    const resolvedArtifact = currentRunEvidenceArtifact({ dir, from, handshake, artifact });
    if (!resolvedArtifact.ok) return { error: resolvedArtifact.error };
    const artifactPath = resolvedArtifact.path;
    artifactPaths.push(artifactPath);
    const artifactText = readFileSync(artifactPath);
    const artifactHash = `sha256:${createHash("sha256").update(artifactText).digest("hex")}`;
    artifactHashes.push(artifactHash);
    const binding = { path: artifactPath, sha256: artifactHash, type: artifact.type, proof: null };
    if (artifact.type === "test-result" && machinePassArtifact(artifactPath) && nonVacuousMachineOracle(artifactPath)) {
      if (!integrated) {
        passingResultPaths.push(artifactPath);
      } else {
        let data;
        try { data = JSON.parse(artifactText.toString("utf8")); } catch { data = null; }
        const structuredReasons = data ? collectTestResultReasons(data, {
          handshake,
          nodeId: from,
          runId: handshake.runId,
          artifact,
          artifactHash: artifactHash.slice("sha256:".length),
          sessionDir: dir,
          ...testEvidenceContext(dir, handshake),
        }) : ["test-result is not valid JSON"];
        if (structuredReasons.length === 0) {
          passingResultPaths.push(artifactPath);
          binding.proof = "opc-test-command";
          binding.provenanceRecordHash = handshake.testEvidenceProvenance?.ledger?.recordHash || null;
        }
      }
    }
    artifactBindings.push(binding);
  }
  if (integrated && passingResultPaths.length === 0) {
    return { error: "integrated mission evidence requires a current-run machine-readable passing test-result artifact" };
  }
  const sourceExecution = integrated ? {
    sessionSha256: sha256(resolve(dir)),
    nodeId: from,
    runId: handshake.runId,
    resultSha256: trustedExecution.resultHash,
  } : null;
  const duplicateReceipt = sourceExecution ? receipts.find(existing =>
    existing?.sourceExecution?.sessionSha256 === sourceExecution.sessionSha256
    && existing?.sourceExecution?.nodeId === sourceExecution.nodeId
    && existing?.sourceExecution?.runId === sourceExecution.runId
    && existing?.sourceExecution?.resultSha256 === sourceExecution.resultSha256
  ) : null;
  if (duplicateReceipt) {
    if (duplicateReceipt.stale === true) {
      return { error: `harness execution ${from}/${handshake.runId} was already consumed by stale receipt ${duplicateReceipt.id}; run fresh evidence` };
    }
    const sameCoverage = duplicateReceipt.scenarioId === scenarioId
      && duplicateReceipt.validatorType === validatorType
      && JSON.stringify([...(duplicateReceipt.satisfies || [])].sort()) === JSON.stringify([...parsedCriteria.criteria].sort())
      && JSON.stringify([...(duplicateReceipt.artifactHashes || [])].sort()) === JSON.stringify([...artifactHashes].sort());
    if (!sameCoverage) {
      return { error: `harness execution ${from}/${handshake.runId} already has a conflicting evidence receipt` };
    }
    // Crash recovery: a parent receipt may have committed before the child
    // cursor.  Replaying that exact source execution must complete the child
    // transition without appending a second EV-N that looks like progress.
    return { state, canonicalUpdate: null, receipt: duplicateReceipt, duplicate: true };
  }
  const receipt = {
    id: `EV-${nextId}`,
    sliceId: evidence.sliceId || from,
    scenarioId,
    scope: integrated ? "integrated" : "local",
    validatorType: validatorType || "execute",
    validator: evidence.validator || from,
    result: "PASS",
    satisfies: parsedCriteria.criteria,
    artifactHashes,
    artifactBindings,
    criteriaMappingSha256: frozenMapping ? sha256(JSON.stringify(frozenMapping.criteria)) : null,
    sourceExecution,
    strategyEpoch: working.mission.strategyEpoch,
    observedAt: new Date().toISOString(),
  };
  // Keep the evidence files themselves in the artifact binding, not only the
  // hashes copied into the receipt. A later edit/deletion must stale a cold
  // review or final checkpoint instead of leaving a valid-looking old hash in
  // state.
  working.artifacts = [...new Set([...(working.artifacts || []), ...artifactPaths])];
  working.evidenceReceipts = [...receipts, receipt];
  if (resolve(integrity.canonicalDir) === resolve(dir)) {
    return { state: working, canonicalUpdate: null, receipt };
  }
  return {
    state,
    canonicalUpdate: {
      dir: integrity.canonicalDir,
      statePath: missionStatePath(integrity.canonicalDir),
      state: working,
    },
    receipt,
  };
}

function missionReviewParseErrors(parsed) {
  const errors = [];
  if (parsed.review_quality_ok === false) errors.push("mission finding metadata is invalid");
  if (!parsed.verdict_present) errors.push("missing VERDICT line");
  if (parsed.verdict_count_match !== true) errors.push("VERDICT FINDINGS count does not match parsed findings");
  if ((parsed.formatErrors || []).length > 0) errors.push("one or more findings are unstructured");
  if ((parsed.findingsWithoutReasoning || 0) > 0) errors.push("one or more findings are missing Reasoning");
  if ((parsed.findingsWithoutFix || 0) > 0) errors.push("one or more findings are missing Fix");
  if (parsed.aspirationalClaims) errors.push("finding fixes are aspirational rather than actionable");
  if ((parsed.hedging_detected || []).length > 0) errors.push("finding text contains hedging language");
  if ((parsed.findings || []).some(finding =>
    finding.severity !== "suggestion" && (!finding.file || !Number.isInteger(finding.line)))) {
    errors.push("critical/warning findings require an exact file:line reference");
  }
  return errors;
}

function nonRoutingReviewClaim(finding, errors) {
  const claim = {
    routing: false,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    issue: finding.issue,
    class: finding.class,
    criterion: finding.criterion,
    finding_ref: finding.finding_ref,
    fingerprint: finding.fingerprint,
    invariant: finding.invariant,
    evidence: finding.evidence,
    errors,
  };
  return { claim_hash: sha256(JSON.stringify(claim)), ...claim };
}

function authoritativeRunDirectories(dir, nodeId, routeState) {
  const runIds = new Set();
  for (const entry of strictHistoryEntries(routeState)) {
    if (entry?.nodeId === nodeId && /^run_\d+$/.test(entry?.runId || "")) {
      runIds.add(entry.runId);
    }
  }
  return [...runIds]
    .sort((a, b) => compareRunIds(b, a))
    .map(runId => join(dir, "nodes", nodeId, runId));
}

function priorInvalidClaims(runs, latestRun, strategyEpoch) {
  const currentIndex = runs.findIndex(runDir => resolve(runDir) === resolve(latestRun));
  const previousRun = currentIndex >= 0 ? runs[currentIndex + 1] : null;
  if (!previousRun) return [];
  let quality;
  let claims;
  try { quality = JSON.parse(readFileSync(join(previousRun, "review-quality.json"), "utf8")); } catch { return []; }
  if (quality.reviewQualityOk !== false || quality.strategyEpoch !== (strategyEpoch ?? null)) return [];
  try { claims = JSON.parse(readFileSync(join(previousRun, "review-claims.json"), "utf8")); } catch { return []; }
  if (claims.strategyEpoch !== undefined && claims.strategyEpoch !== (strategyEpoch ?? null)) return [];
  return Array.isArray(claims.claims) ? claims.claims : [];
}

function claimDispositionStatus(runDir, priorClaims, parsedFindings) {
  const dispositionPath = join(runDir, "review-claim-dispositions.json");
  let dispositions = [];
  const envelopeErrors = [];
  try {
    if (existsSync(dispositionPath)) {
      const dispositionStat = lstatSync(dispositionPath);
      if (!dispositionStat.isFile() || dispositionStat.isSymbolicLink()) {
        envelopeErrors.push("review-claim-dispositions.json must be a regular non-symlink file in the sealed review run");
      }
      const canonicalDisposition = realpathSync(dispositionPath);
      if (dirname(canonicalDisposition) !== realpathSync(runDir)) {
        envelopeErrors.push("review-claim-dispositions.json escapes the sealed review run");
      }
      const data = JSON.parse(readFileSync(dispositionPath, "utf8"));
      if (data?.schemaVersion !== 1) {
        envelopeErrors.push("review-claim-dispositions.json schemaVersion must equal 1");
      }
      if (!Array.isArray(data?.dispositions)) {
        envelopeErrors.push("review-claim-dispositions.json requires a dispositions array");
      }
      dispositions = Array.isArray(data?.dispositions) ? data.dispositions : [];
    }
  } catch (error) {
    return { ok: false, required: true, errors: [`claim dispositions are unreadable: ${error.message}`], dispositions: [] };
  }
  const validated = validateReviewClaimDispositions({
    pendingClaims: priorClaims,
    dispositions,
    findings: parsedFindings,
  });
  return {
    ...validated,
    ok: envelopeErrors.length === 0 && validated.ok,
    errors: [...envelopeErrors, ...validated.errors],
  };
}

function sealedReviewRun(dir, nodeId, runId) {
  if (!/^run_\d+$/.test(runId || "")) {
    return { ok: false, error: `sealed review run identity is invalid for '${nodeId}'` };
  }
  const handshakePath = nodeHandshakePath(dir, nodeId, runId);
  let handshake;
  try { handshake = JSON.parse(readFileSync(handshakePath, "utf8")); } catch (error) {
    return { ok: false, error: `sealed review handshake is unreadable: ${error.message}` };
  }
  if (handshake.nodeId !== nodeId || handshake.nodeType !== "review" || handshake.runId !== runId) {
    return { ok: false, error: "sealed review handshake node/run identity is invalid" };
  }
  const runDir = join(dir, "nodes", nodeId, handshake.runId);
  const evalArtifacts = (Array.isArray(handshake.artifacts) ? handshake.artifacts : [])
    .filter(artifact => artifact?.type === "eval" || artifact?.type === "evaluation");
  if (evalArtifacts.length === 0) {
    return { ok: false, error: "sealed review handshake has no evaluation artifacts", runDir };
  }
  const evalFiles = [];
  for (const artifact of evalArtifacts) {
    const resolvedArtifact = currentRunEvidenceArtifact({ dir, from: nodeId, handshake, artifact });
    if (!resolvedArtifact.ok) return { ok: false, error: resolvedArtifact.error, runDir };
    evalFiles.push(resolvedArtifact.path);
  }
  return { ok: true, handshake, runDir, evalFiles };
}

function collectMissionReviewBatch(dir, nodeId, state, runId, routeState) {
  const sealed = sealedReviewRun(dir, nodeId, runId);
  if (!sealed.ok) {
    return {
      findings: [],
      reviewQualityOk: false,
      invalidRuns: 1,
      qualityErrors: [sealed.error],
      claims: [],
    };
  }
  const latestRun = sealed.runDir;
  let existingQuality = null;
  let existingClaims = null;
  try { existingQuality = JSON.parse(readFileSync(join(latestRun, "review-quality.json"), "utf8")); } catch { /* first evaluation */ }
  try { existingClaims = JSON.parse(readFileSync(join(latestRun, "review-claims.json"), "utf8")); } catch { /* no prior claims */ }
  if (existingQuality?.reviewQualityOk === false
      && existingQuality.strategyEpoch === (state.mission?.strategyEpoch ?? null)) {
    return {
      findings: [],
      reviewQualityOk: false,
      invalidRuns: 2,
      qualityErrors: ["invalid-review claims are sealed; reevaluation requires a fresh run id"],
      claims: Array.isArray(existingClaims?.claims) ? existingClaims.claims : [],
    };
  }

  const parseRun = (runDir, sealedEvalFiles = null) => {
    let evalFiles = [];
    if (sealedEvalFiles) {
      evalFiles = sealedEvalFiles;
    } else try {
      evalFiles = readdirSync(runDir)
        .filter(name => /^eval(?:-[^/]+)?\.md$/.test(name) && name !== "eval-extensions.md")
        .map(name => join(runDir, name));
    } catch { /* validation elsewhere reports missing eval artifacts */ }
    const parsed = evalFiles.map(path => parseEvaluation(readFileSync(path, "utf8"), {
      mission: missionParserContext(state),
    }));
    const parseErrors = parsed.map(missionReviewParseErrors);
    const qualityErrors = parseErrors.flatMap((errors, index) =>
      errors.map(error => `eval ${index + 1}: ${error}`));
    const claims = parsed.flatMap((result, index) => {
      if ((result.review_claims || []).length > 0) return result.review_claims;
      if (parseErrors[index].length === 0) return [];
      return (result.findings || [])
        .filter(finding => finding.severity !== "suggestion")
        .map(finding => nonRoutingReviewClaim(finding, parseErrors[index]));
    });
    return {
      parsed,
      findings: parsed.flatMap(result => result.findings || [])
        .filter(finding => finding.severity === "critical" || finding.severity === "warning"),
      reviewQualityOk: qualityErrors.length === 0,
      qualityErrors,
      claims,
    };
  };

  const current = parseRun(latestRun, sealed.evalFiles);
  const authoritativeRuns = authoritativeRunDirectories(dir, nodeId, routeState);
  const priorClaims = priorInvalidClaims(authoritativeRuns, latestRun, state.mission?.strategyEpoch);
  const disposition = claimDispositionStatus(latestRun, priorClaims, current.findings);
  current.reviewQualityOk = current.reviewQualityOk && disposition.ok;
  current.qualityErrors = [...current.qualityErrors, ...disposition.errors];
  if (!current.reviewQualityOk && current.claims.length === 0 && priorClaims.length > 0) {
    current.claims = priorClaims;
  }
  atomicWriteSync(join(latestRun, "review-quality.json"), JSON.stringify({
    schemaVersion: 1,
    strategyEpoch: state.mission?.strategyEpoch ?? null,
    reviewQualityOk: current.reviewQualityOk,
    qualityErrors: current.qualityErrors,
    claimDispositionRequired: disposition.required,
    claimDispositionOk: disposition.ok,
    dispositionedClaimHashes: disposition.dispositions
      .map(item => item?.claimHash || item?.claim_hash)
      .filter(Boolean),
  }, null, 2) + "\n");
  if (!current.reviewQualityOk) {
    atomicWriteSync(join(latestRun, "review-claims.json"), JSON.stringify({
      schemaVersion: 1,
      strategyEpoch: state.mission?.strategyEpoch ?? null,
      routing: false,
      claims: current.claims,
    }, null, 2) + "\n");
  }

  let invalidRuns = 0;
  try {
    const currentIndex = authoritativeRuns.findIndex(runDir => resolve(runDir) === resolve(latestRun));
    for (const runDir of currentIndex >= 0 ? authoritativeRuns.slice(currentIndex) : [latestRun]) {
      let marker = null;
      try { marker = JSON.parse(readFileSync(join(runDir, "review-quality.json"), "utf8")); } catch { /* legacy run */ }
      if (marker && marker.strategyEpoch !== (state.mission?.strategyEpoch ?? null)) break;
      const qualityOk = marker ? marker.reviewQualityOk !== false : parseRun(runDir).reviewQualityOk;
      if (qualityOk) break;
      invalidRuns++;
    }
  } catch { /* current run remains authoritative */ }
  return { ...current, invalidRuns };
}

function collectGateMissionReviewBatch(dir, routeState, missionState, template, currentGate) {
  const reviewRuns = new Map();
  for (const entry of entriesSinceLastGate(routeState, template, currentGate)) {
    if (template.nodeTypes?.[entry.nodeId] !== "review") continue;
    reviewRuns.set(entry.nodeId, entry.runId);
  }
  const batches = [...reviewRuns].map(([nodeId, runId]) => ({
    nodeId,
    ...collectMissionReviewBatch(dir, nodeId, missionState, runId, routeState),
  }));
  return {
    findings: batches.flatMap(batch => batch.findings),
    reviewQualityOk: batches.every(batch => batch.reviewQualityOk),
    invalidRuns: batches.reduce((max, batch) => Math.max(max, batch.invalidRuns || 0), 0),
    qualityErrors: batches.flatMap(batch =>
      (batch.qualityErrors || []).map(error => `${batch.nodeId}: ${error}`)),
    claims: batches.flatMap(batch => batch.claims || []),
    reviewNodes: [...reviewRuns.keys()],
  };
}

function isRepairDestination(template, to) {
  const nodeType = template.nodeTypes?.[to];
  return nodeType === "build" || nodeType === "hotfix" || /^(?:build|hotfix|fix)$/.test(String(to));
}

function missionDenied(reason, extra = {}) {
  return {
    allowed: false,
    reason,
    rebet_required: extra.rebet_required === true,
    ...extra,
  };
}

function persistCanonicalMissionState({
  canonicalDir,
  localDir,
  expectedState,
  nextState,
  command,
  localLockHeld = false,
  canonicalLockHeld = false,
}) {
  const targetPath = missionStatePath(canonicalDir);
  const sameState = resolve(canonicalDir) === resolve(localDir);
  let lock = null;
  if (!canonicalLockHeld && !(sameState && localLockHeld)) {
    lock = lockFile(targetPath, { command });
    if (!lock.acquired) return { ok: false, reason: "could not acquire canonical Mission state lock", holder: lock.holder };
  }
  try {
    const fresh = JSON.parse(readFileSync(targetPath, "utf8"));
    if (expectedState?._last_modified && fresh._last_modified !== expectedState._last_modified) {
      return { ok: false, reason: "canonical Mission state changed during protected mutation; retry" };
    }
    let persistedState = nextState;
    if (persistedState?.trajectory?.pending) {
      const sealed = sealPendingMissionGate({ sessionDir: canonicalDir, state: persistedState });
      if (!sealed.ok) return { ok: false, reason: `cannot seal Mission Gate: ${sealed.error}` };
      persistedState = sealed.state;
    }
    persistedState._written_by = WRITER_SIG;
    persistedState._last_modified = new Date().toISOString();
    const runtimeSealed = sealMissionRuntimeState({
      sessionDir: canonicalDir,
      state: persistedState,
      statePath: targetPath,
      reason: command,
    });
    if (!runtimeSealed.ok) return { ok: false, reason: runtimeSealed.error };
    persistedState = runtimeSealed.state;
    atomicWriteSync(targetPath, JSON.stringify(persistedState, null, 2) + "\n");
    return { ok: true, statePath: targetPath, state: persistedState };
  } catch (error) {
    return { ok: false, reason: `cannot persist canonical Mission state: ${error.message}` };
  } finally {
    lock?.release();
  }
}

function enforceMissionFinalization({ dir, state, localLockHeld = false }) {
  const guard = guardMissionMutation({ sessionDir: dir, state, command: "finalize" });
  if (!guard.allowed) return missionDenied(guard.reason, {
    finalized: false,
    rebet_required: guard.rebet_required,
    missionIntegrityErrors: guard.errors,
  });
  if (!guard.enabled) return { allowed: true };

  const integrity = verifyMissionIntegrity({ sessionDir: dir, state });
  if (!integrity.ok) return missionDenied(integrity.errors.join("; "), { finalized: false });
  const evidenceValidation = revalidateMissionEvidenceReceipts(integrity.canonicalState);
  if (evidenceValidation.changed) {
    const persisted = persistCanonicalMissionState({
      canonicalDir: integrity.canonicalDir,
      localDir: dir,
      expectedState: integrity.canonicalState,
      nextState: evidenceValidation.state,
      command: "finalize-evidence-revalidation",
      localLockHeld,
    });
    if (!persisted.ok) return missionDenied(persisted.reason, { finalized: false });
    return missionDenied(
      `integrated PASS evidence became stale: ${evidenceValidation.staleReceiptIds.join(", ")} — recapture harness-owned evidence`,
      { finalized: false, staleEvidenceReceiptIds: evidenceValidation.staleReceiptIds },
    );
  }
  const appetiteDecision = evaluateTrajectory({
    state: integrity.canonicalState,
    missionContract: integrity.contract,
  });
  if (appetiteDecision.action === "OPEN_MISSION_GATE") {
    const opened = openMissionGate({
      sessionDir: null,
      state: integrity.canonicalState,
      missionContract: integrity.contract,
      trigger: appetiteDecision,
    });
    const persisted = persistCanonicalMissionState({
      canonicalDir: integrity.canonicalDir,
      localDir: dir,
      expectedState: integrity.canonicalState,
      nextState: opened.state,
      command: "finalize-mission-appetite",
      localLockHeld,
    });
    if (!persisted.ok) return missionDenied(persisted.reason, { finalized: false });
    return missionDenied(`Mission Gate opened: ${appetiteDecision.reason}`, {
      finalized: false,
      rebet_required: true,
      triggerId: opened.packet.triggerId,
      trajectoryReason: appetiteDecision.reason,
    });
  }
  if (hasCurrentFinalCheckpoint(integrity.canonicalState)) return { allowed: true };

  const opened = openMissionGate({
    sessionDir: null,
    state: integrity.canonicalState,
    missionContract: integrity.contract,
    trigger: {
      reason: "FINAL_REVIEW_REQUIRED",
      checkpoint: "before_finalize",
      retryable: false,
      findingRefs: [],
    },
  });
  const persisted = persistCanonicalMissionState({
    canonicalDir: integrity.canonicalDir,
    localDir: dir,
    expectedState: integrity.canonicalState,
    nextState: opened.state,
    command: "finalize-mission-gate",
    localLockHeld,
  });
  if (!persisted.ok) return missionDenied(persisted.reason, { finalized: false });
  return missionDenied("Mission Gate opened: final cold Mission review is required", {
    finalized: false,
    rebet_required: true,
    triggerId: opened.packet.triggerId,
    trajectoryReason: "FINAL_REVIEW_REQUIRED",
  });
}

/**
 * Evaluate the side-band gate after normal transition validation but before
 * handshake/state mutation. Parent-linked children return a deferred canonical
 * state update which the caller writes immediately before the child commit.
 */
function checkMissionTrajectory({
  dir,
  state,
  statePath,
  template,
  from,
  to,
  verdict,
  canonicalLockHeld = false,
}) {
  if (!state?.mission) return { allowed: true, state, canonicalUpdate: null, authorizedRetry: false };
  const integrity = verifyMissionIntegrity({ sessionDir: dir, state });
  if (!integrity.ok) return missionDenied(integrity.errors.join("; "));

  const canonicalDir = integrity.canonicalDir;
  const canonicalStatePath = missionStatePath(canonicalDir);
  const evidenceValidation = revalidateMissionEvidenceReceipts(integrity.canonicalState);
  let working = evidenceValidation.state;
  const evidenceStateChanged = evidenceValidation.changed;
  const appetiteDecision = evaluateTrajectory({
    state: working,
    missionContract: integrity.contract,
  });
  if (appetiteDecision.action === "OPEN_MISSION_GATE") {
    const opened = openMissionGate({
      sessionDir: null,
      state: working,
      missionContract: integrity.contract,
      trigger: transitionGateTrigger(appetiteDecision, { dir, from, to }),
    });
    const persisted = persistCanonicalMissionState({
      canonicalDir,
      localDir: dir,
      expectedState: working,
      nextState: opened.state,
      command: "transition-mission-appetite",
      localLockHeld: resolve(canonicalDir) === resolve(dir),
      canonicalLockHeld,
    });
    if (!persisted.ok) return missionDenied(persisted.reason);
    return missionDenied(`Mission Gate opened: ${appetiteDecision.reason}`, {
      rebet_required: true,
      triggerId: opened.packet.triggerId,
      trajectoryReason: appetiteDecision.reason,
    });
  }
  const nodeType = template.nodeTypes?.[from];
  const negative = verdict === "FAIL" || verdict === "ITERATE";
  // Built-in review/full-stack/pre-release flows synthesize review verdicts at
  // a gate. Their negative gate edge is the repair claim, even when its graph
  // destination is another review/brief node rather than a node typed build.
  const repairEdge = negative && (nodeType === "gate" || isRepairDestination(template, to));
  const edgeKey = `${from}→${to}`;
  let findings = [];
  let recordFindingFailures = false;
  const retryGrant = working.trajectory?.retryGrant || null;
  const retryScopeFindings = Array.isArray(working.trajectory?.activeFindings)
    ? working.trajectory.activeFindings
    : [];
  const retryGrantMatchesSource = retryGrant
    ? missionRetryGrantMatches({
      state: working,
      findings: retryScopeFindings,
      edgeKey,
      command: "transition",
      fromNode: from,
      sessionSha256: sha256(resolve(dir)),
    })
    : false;
  if (retryGrant && !retryGrantMatchesSource) {
    return missionDenied("Mission retry grant is bound to a different transition source or scope");
  }

  if (negative && (nodeType === "review" || nodeType === "gate")) {
    const batch = nodeType === "gate"
      ? collectGateMissionReviewBatch(dir, state, working, template, from)
      : collectMissionReviewBatch(dir, from, working, resolveCurrentRun(state)?.runId, state);
    if (!batch.reviewQualityOk) {
      if (batch.invalidRuns >= 2) {
        const opened = openMissionGate({
          sessionDir: null,
          state: working,
          missionContract: integrity.contract,
          trigger: transitionGateTrigger(
            { reason: "REVIEW_QUALITY_STALL", retryable: false, findingRefs: [] },
            { dir, from, to },
          ),
        });
        const persisted = persistCanonicalMissionState({
          canonicalDir,
          localDir: dir,
          expectedState: working,
          nextState: opened.state,
          command: "transition-review-quality-gate",
          localLockHeld: resolve(canonicalDir) === resolve(dir),
          canonicalLockHeld,
        });
        if (!persisted.ok) return missionDenied(persisted.reason);
        return missionDenied("review quality failed twice; Mission review required", {
          rebet_required: true,
          triggerId: opened.packet.triggerId,
          review_quality_ok: false,
          reevaluate_required: false,
        });
      }
      return missionDenied("review metadata is invalid; fresh evaluation required", {
        review_quality_ok: false,
        reevaluate_required: true,
        reviewQualityErrors: batch.qualityErrors || [],
      });
    }
    const registered = registerFindingBatch({
      registry: working.findingRegistry || [],
      findings: batch.findings,
      criterionHashes: working.mission.criterionHashes || {},
    });
    if (!registered.ok) {
      return missionDenied(`review finding registry validation failed: ${registered.errors.join("; ")}`, {
        review_quality_ok: false,
        reevaluate_required: true,
      });
    }
    working = { ...working, findingRegistry: registered.registry };
    // Ordinary UNLINKED findings remain auditable but cannot steer artifact
    // repair. GOAL_SPEC+UNLINKED is the explicit protected-floor-risk escape:
    // it must reach the human re-bet gate instead of silently disappearing.
    findings = registered.findings.filter(finding =>
      finding.criterion !== "UNLINKED" || finding.class === "GOAL_SPEC");
    recordFindingFailures = true;
  } else if (repairEdge) {
    findings = Array.isArray(working.trajectory?.activeFindings)
      ? working.trajectory.activeFindings
      : [];
  }

  if (!negative || (!recordFindingFailures && !repairEdge)) {
    if (!retryGrantMatchesSource && !evidenceStateChanged) {
      return { allowed: true, state, canonicalUpdate: null, authorizedRetry: false };
    }
    if (retryGrantMatchesSource) working = consumeMissionRetryGrant(working);
    const canonicalUpdate = resolve(canonicalDir) === resolve(dir)
      ? null
      : { dir: canonicalDir, statePath: canonicalStatePath, state: working };
    return {
      allowed: true,
      state: canonicalUpdate ? state : working,
      canonicalUpdate,
      authorizedRetry: true,
    };
  }

  const retryGrantMatchesAttempt = retryGrant
    ? missionRetryGrantMatches({
      state: working,
      findings: findings.length > 0 ? findings : retryScopeFindings,
      edgeKey,
      command: "transition",
      fromNode: from,
      sessionSha256: sha256(resolve(dir)),
    })
    : false;
  const hasMissionLevelFinding = findings.some(finding =>
    finding?.class && finding.class !== "ARTIFACT");
  if (retryGrant && !retryGrantMatchesAttempt && !hasMissionLevelFinding) {
    return missionDenied("Mission retry grant does not authorize this negative transition scope");
  }

  const decision = evaluateTrajectory({
    state: working,
    missionContract: integrity.contract,
    findings,
    edgeKey,
    verdict,
    isRepairEdge: repairEdge,
  });
  if (decision.action === "OPEN_MISSION_GATE") {
    const opened = openMissionGate({
      sessionDir: null,
      state: working,
      missionContract: integrity.contract,
      trigger: transitionGateTrigger(decision, { dir, from, to }),
    });
    const persisted = persistCanonicalMissionState({
      canonicalDir,
      localDir: dir,
      expectedState: working,
      nextState: opened.state,
      command: "transition-mission-gate",
      localLockHeld: resolve(canonicalDir) === resolve(dir),
      canonicalLockHeld,
    });
    if (!persisted.ok) return missionDenied(persisted.reason);
    return missionDenied(`Mission Gate opened: ${decision.reason}`, {
      rebet_required: true,
      triggerId: opened.packet.triggerId,
      trajectoryReason: decision.reason,
      findingRefs: decision.findingRefs || [],
    });
  }

  working = commitTrajectoryObservation({
    state: working,
    findings,
    edgeKey,
    verdict,
    isRepairEdge: repairEdge,
    recordFindingFailures,
    consumeRetry: decision.consumeRetry === true || retryGrantMatchesAttempt,
  });
  const canonicalUpdate = resolve(canonicalDir) === resolve(dir)
    ? null
    : { dir: canonicalDir, statePath: canonicalStatePath, state: working };
  return {
    allowed: true,
    state: canonicalUpdate ? state : working,
    canonicalUpdate,
    authorizedRetry: decision.authorizedRetry === true,
  };
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
    if (state._written_by !== WRITER_SIG || !state._write_nonce) {
      console.log(JSON.stringify({ allowed: false, reason: "flow-state.json was not written by opc-harness — possible direct edit" }));
      return;
    }
    const recovery = recoverPendingChildTransition({ dir, state, statePath, flow, from, to, verdict });
    if (recovery.handled) {
      console.log(JSON.stringify(recovery.response));
      return;
    }
    if (state.currentNode !== from) {
      console.log(JSON.stringify({ allowed: false, reason: `currentNode is '${state.currentNode}', not '${from}' — cannot transition from a node you are not at` }));
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

  const missionGuard = guardMissionMutation({ sessionDir: dir, state, command: "transition" });
  if (!missionGuard.allowed) {
    console.log(JSON.stringify(missionDenied(missionGuard.reason, {
      rebet_required: missionGuard.rebet_required,
      missionIntegrityErrors: missionGuard.errors,
    })));
    return;
  }
  const parentLinkedMission = Boolean(state?.mission?.parentSession);

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

    if (autoRepairCount >= 1 && !state.mission) {
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
    const limitMatch = /^(maxTotalSteps|maxLoopsPerEdge|maxNodeReentry) \((\d+)\) reached/.exec(budget.reason || "");
    if (!state.mission || !limitMatch) {
      console.log(JSON.stringify({ allowed: false, reason: budget.reason }));
      return;
    }
    const integrity = verifyMissionIntegrity({ sessionDir: dir, state });
    if (!integrity.ok) {
      console.log(JSON.stringify(missionDenied(integrity.errors.join("; "))));
      return;
    }
    const evidenceValidation = revalidateMissionEvidenceReceipts(integrity.canonicalState);
    const opened = openMissionGate({
      sessionDir: null,
      state: evidenceValidation.state,
      missionContract: integrity.contract,
      trigger: transitionGateTrigger({
        action: "OPEN_MISSION_GATE",
        reason: "LEGACY_FLOW_LIMIT_REACHED",
        retryable: false,
        findingRefs: [],
        edgeKey,
        limit: { name: limitMatch[1], value: Number(limitMatch[2]) },
      }, { dir, from, to }),
    });
    const persisted = persistCanonicalMissionState({
      canonicalDir: integrity.canonicalDir,
      localDir: dir,
      expectedState: integrity.canonicalState,
      nextState: opened.state,
      command: "transition-legacy-limit-gate",
      localLockHeld: resolve(integrity.canonicalDir) === resolve(dir),
    });
    if (!persisted.ok) {
      console.log(JSON.stringify(missionDenied(persisted.reason)));
      return;
    }
    console.log(JSON.stringify(missionDenied(`Mission Gate opened before ${budget.reason}`, {
      rebet_required: true,
      triggerId: opened.packet.triggerId,
      trajectoryReason: "LEGACY_FLOW_LIMIT_REACHED",
    })));
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

  let missionTransition = null;

  // ── Backlog enforcement for 🟡 findings ──
  const checkTransitionBacklog = () => {
    if (!(isGate && (verdict === "PASS" || verdict === "ITERATE"))) return true;
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
        return false;
      }
      const warningCount = exact.data?.findings?.warning || 0;
      if (warningCount <= 0) continue;
      if (!existsSync(backlogPath)) {
        console.log(JSON.stringify({
          allowed: false,
          reason: `upstream '${entry.nodeId}' has ${warningCount} \ud83d\udfe1 warning(s) but backlog.md does not exist — write findings to backlog before transitioning`,
          backlog_required: true, upstream: entry.nodeId, warnings: warningCount,
        }));
        return false;
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
        return false;
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
        return false;
      }
    }
    return true;
  };

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
      paths: [
        join(gateDir, sourceRun.runId, "handshake.json"),
        join(gateDir, "handshake.json"),
      ],
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

  const prepareTransitionRun = async () => {
    try {
    reserveRunDirectory(dir, to, runId);
    } catch (error) {
      console.log(JSON.stringify({
        allowed: false,
        reason: `cannot reserve run directory 'nodes/${to}/${runId}': ${error.message}`,
      }));
      return false;
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
          return false;
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
      return false;
    }
    }

  if (gateHandshakeWrite) {
      for (const path of gateHandshakeWrite.paths) {
        mkdirSync(dirname(path), { recursive: true });
        atomicWriteSync(path, gateHandshakeWrite.content);
      }
  }
    return true;
  };

  // Parent evidence must be derived while the canonical parent lock is held.
  // Local and missionless transitions keep the direct path.
  let evidenceUpdate = { state, canonicalUpdate: null, receipt: null };

  // Resolve and lock a canonical parent before *any* child-side effect. It is
  // too late to discover a competing STOP after a test command or handshake
  // has already run. Even a transition with no parent update holds this lock
  // until both authoritative states have committed.
  let parentBoundary = missionTransition?.canonicalUpdate || null;
  if (!parentBoundary && state?.mission?.parentSession) {
    const parentIntegrity = verifyMissionIntegrity({ sessionDir: dir, state });
    if (!parentIntegrity.ok) {
      console.log(JSON.stringify({ allowed: false, reason: parentIntegrity.errors.join("; ") }));
      return;
    }
    if (resolve(parentIntegrity.canonicalDir) !== resolve(dir)) {
      parentBoundary = {
        dir: parentIntegrity.canonicalDir,
        statePath: missionStatePath(parentIntegrity.canonicalDir),
        state: null,
        expectedState: parentIntegrity.canonicalState,
      };
    }
  }
  let parentLock = null;
  let lockedCanonicalState = null;
  if (parentBoundary) {
    parentLock = lockFile(parentBoundary.statePath, { command: "transition-mission-parent-child-commit" });
    if (!parentLock.acquired) {
      console.log(JSON.stringify({
        allowed: false,
        reason: "could not acquire canonical parent Mission state lock",
        holder: parentLock.holder,
      }));
      return;
    }
    const freshParent = JSON.parse(readFileSync(parentBoundary.statePath, "utf8"));
    const expectedLastModified = parentBoundary.state?._last_modified || parentBoundary.expectedState?._last_modified;
    if (expectedLastModified && freshParent._last_modified !== expectedLastModified) {
      parentLock.release();
      console.log(JSON.stringify({
        allowed: false,
        reason: "canonical parent Mission state changed before child transition; retry",
      }));
      return;
    }
    const lockedIntegrity = verifyMissionIntegrity({ sessionDir: parentBoundary.dir, state: freshParent });
    const parentTerminal = lockedIntegrity.ok && (
      lockedIntegrity.canonicalState.trajectory?.terminal === true
      || lockedIntegrity.canonicalState.trajectory?.terminalAction === "STOP_SALVAGE"
    );
    if (!lockedIntegrity.ok || parentTerminal) {
      parentLock.release();
      console.log(JSON.stringify({
        allowed: false,
        reason: parentTerminal
          ? "canonical parent Mission was terminated before child transition"
          : lockedIntegrity.errors.join("; "),
      }));
      return;
    }
    lockedCanonicalState = lockedIntegrity.canonicalState;
  }

  let testCommandExecution = null;
  let stagedChildTransition = null;
  try {
    let trajectoryState = null;
    // Upstream exact-run authority reserves the target before hooks or any
    // Mission review sidecar can mutate source evidence. Parent-linked flows
    // do this while the canonical parent lock is held.
    if (!await prepareTransitionRun()) return;

    if (parentLinkedMission) {
      // Re-evaluate from the now-locked canonical parent so artifact
      // revalidation and retry consumption cannot race the receipt append.
      missionTransition = checkMissionTrajectory({
        dir,
        state,
        statePath,
        template,
        from,
        to,
        verdict,
        canonicalLockHeld: true,
      });
      if (!missionTransition.allowed) {
        console.log(JSON.stringify(missionTransition));
        return;
      }
      state = missionTransition.state;
      trajectoryState = missionTransition.canonicalUpdate?.state || lockedCanonicalState;
    } else {
      missionTransition = checkMissionTrajectory({
        dir, state, statePath, template, from, to, verdict,
      });
      if (!missionTransition.allowed) {
        console.log(JSON.stringify(missionTransition));
        return;
      }
      state = missionTransition.state;
    }

    if (!checkTransitionBacklog()) return;

    if (parentLinkedMission) {
      evidenceUpdate = recordStandardEvidenceReceipt({
        dir,
        state,
        template,
        from,
        verdict,
        canonicalState: trajectoryState,
      });
      if (evidenceUpdate.error) {
        console.log(JSON.stringify({ allowed: false, reason: evidenceUpdate.error }));
        return;
      }
      state = evidenceUpdate.state;
      // A duplicate receipt is intentionally a no-op. Preserve any deferred
      // trajectory update (notably retry consumption) while avoiding a second
      // EV-N append on crash replay.
      parentBoundary.state = evidenceUpdate.canonicalUpdate?.state
        || missionTransition.canonicalUpdate?.state
        || lockedCanonicalState;
      missionTransition.canonicalUpdate = parentBoundary.state
        ? { ...parentBoundary, state: parentBoundary.state }
        : null;
    } else {
      evidenceUpdate = recordStandardEvidenceReceipt({ dir, state, template, from, verdict });
      if (evidenceUpdate.error) {
        console.log(JSON.stringify({ allowed: false, reason: evidenceUpdate.error }));
        return;
      }
      state = evidenceUpdate.state;
      if (evidenceUpdate.canonicalUpdate) missionTransition.canonicalUpdate = evidenceUpdate.canonicalUpdate;
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

    if (testSpecForExecution) {
      testCommandExecution = executeTestCommand(
        dir,
        to,
        runId,
        testSpecForExecution.sourceNode,
        testSpecForExecution.sourceRunId,
      );
      if (testCommandExecution?.verdict === "PASS") {
        const trustedRecord = trustedHarnessExecutionRecord({ dir, nodeId: to, runId });
        if (trustedRecord) {
          for (const executeHandshakePath of [
            nodeHandshakePath(dir, to, runId),
            nodeHandshakePath(dir, to),
          ]) {
            const executeHandshake = JSON.parse(readFileSync(executeHandshakePath, "utf8"));
            executeHandshake.evidence = {
              ...(executeHandshake.evidence && typeof executeHandshake.evidence === "object"
                ? executeHandshake.evidence
                : {}),
              scenarioId: trustedRecord.scenarioId,
              validatorType: trustedRecord.validatorType,
              satisfies: trustedRecord.satisfies,
            };
            // Keep the legacy top-level mirrors for protocol consumers while
            // the nested evidence mapping remains authoritative.
            executeHandshake.scenarioId = trustedRecord.scenarioId;
            executeHandshake.validatorType = trustedRecord.validatorType;
            executeHandshake.satisfies = trustedRecord.satisfies;
            atomicWriteSync(executeHandshakePath, JSON.stringify(executeHandshake, null, 2) + "\n");
          }
          state._harnessEvidenceExecutions = [
            ...(Array.isArray(state._harnessEvidenceExecutions) ? state._harnessEvidenceExecutions : [])
              .filter(record => !(record?.nodeId === to && record?.runId === runId)),
            trustedRecord,
          ];
        }
      }
    }

    if (parentBoundary?.state) {
        let parentState = parentBoundary.state;
        if (parentState?.trajectory?.pending) {
          const sealed = sealPendingMissionGate({ sessionDir: parentBoundary.dir, state: parentState });
          if (!sealed.ok) {
            console.log(JSON.stringify({ allowed: false, reason: `cannot seal Mission Gate: ${sealed.error}` }));
            return;
          }
          parentState = sealed.state;
        }
        if (parentLinkedMission) {
          stagedChildTransition = stagePendingChildTransition({
            dir,
            flow,
            from,
            to,
            verdict,
            targetRunId: runId,
            childCandidate: state,
            parentState,
            lockedParentState: lockedCanonicalState,
            evidenceReceiptId: evidenceUpdate.receipt?.id || null,
            template,
          });
          if (!stagedChildTransition.ok) {
            console.log(JSON.stringify({ allowed: false, reason: stagedChildTransition.error }));
            return;
          }
          parentState = stagedChildTransition.parentState;
        } else {
          parentState._written_by = WRITER_SIG;
          parentState._last_modified = new Date().toISOString();
        }
        const parentRuntimeSeal = sealMissionRuntimeState({
          sessionDir: parentBoundary.dir,
          state: parentState,
          statePath: parentBoundary.statePath,
          reason: "transition-parent-commit",
        });
        if (!parentRuntimeSeal.ok) {
          console.log(JSON.stringify({ allowed: false, reason: parentRuntimeSeal.error }));
          return;
        }
        parentState = parentRuntimeSeal.state;
        atomicWriteSync(parentBoundary.statePath, JSON.stringify(parentState, null, 2) + "\n");
        maybeInjectChildTransitionFault("after-parent-publish");
    }
    if (stagedChildTransition) {
      const promoted = promoteBoundChildTransition({
        dir,
        statePath,
        journal: stagedChildTransition.journal,
      });
      if (!promoted.ok) {
        console.log(JSON.stringify({ allowed: false, reason: promoted.error, recovery_required: true }));
        return;
      }
      state = promoted.state;
      maybeInjectChildTransitionFault("after-child-publish");
      try { rmSync(stagedChildTransition.stagePath, { force: true }); } catch { /* child receipt remains authoritative */ }
    } else if (state.mission) {
      const childRuntimeSeal = sealMissionRuntimeState({
        sessionDir: dir,
        state,
        statePath,
        reason: "transition-child-commit",
      });
      if (!childRuntimeSeal.ok) {
        console.log(JSON.stringify({ allowed: false, reason: childRuntimeSeal.error }));
        return;
      }
      state = childRuntimeSeal.state;
    }
    atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");
    try { writeCumulativeFindings(dir, state); } catch { /* best effort */ }
  } finally {
    parentLock?.release();
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
        missionPromptContext({ sessionDir: dir, state }),
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
    ...(evidenceUpdate.receipt ? { evidenceReceipt: evidenceUpdate.receipt } : {}),
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

  const missionGuard = guardMissionMutation({ sessionDir: dir, state, command: "advance" });
  if (!missionGuard.allowed) {
    console.log(JSON.stringify({
      advanced: false,
      reason: missionGuard.reason,
      rebet_required: missionGuard.rebet_required,
      missionIntegrityErrors: missionGuard.errors,
    }));
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
  let finalizedMissionIntegrity = null;
  if (state.mission) {
    const integrity = verifyMissionIntegrity({ sessionDir: dir, state });
    if (!integrity.ok) {
      console.log(JSON.stringify({ finalized: false, error: integrity.errors.join("; ") }));
      return;
    }
    finalizedMissionIntegrity = integrity;
    const evidenceValidation = revalidateMissionEvidenceReceipts(integrity.canonicalState);
    if (evidenceValidation.changed) {
      const persisted = persistCanonicalMissionState({
        canonicalDir: integrity.canonicalDir,
        localDir: dir,
        expectedState: integrity.canonicalState,
        nextState: evidenceValidation.state,
        command: "finalize-preflight-evidence-revalidation",
        localLockHeld: true,
      });
      console.log(JSON.stringify({
        finalized: false,
        error: persisted.ok
          ? `integrated PASS evidence became stale: ${evidenceValidation.staleReceiptIds.join(", ")} — recapture harness-owned evidence`
          : persisted.reason,
        staleEvidenceReceiptIds: evidenceValidation.staleReceiptIds,
      }));
      return;
    }
  }
  if (state.status === "completed" && state.mission &&
      !hasCurrentFinalCheckpoint(finalizedMissionIntegrity?.canonicalState || state)) {
    console.log(JSON.stringify({
      finalized: false,
      error: "completed Mission state no longer has a current final checkpoint — success remains invalidated",
    }));
    return;
  }
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

  if (state.status === "completed" && !state.mission) {
    console.log(JSON.stringify({
      finalized: true, flow, terminalNode: currentNode, totalSteps: state.totalSteps, note: "already finalized",
    }));
    return;
  }

    // All finalize checks and the final write share the outer state lock.
    let freshState = state;
    const freshMissionFinal = enforceMissionFinalization({ dir, state: freshState, localLockHeld: true });
    if (!freshMissionFinal.allowed) {
      console.log(JSON.stringify(freshMissionFinal));
      return;
    }
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

    if (freshState.mission) {
      const runtimeSealed = sealMissionRuntimeState({
        sessionDir: dir,
        state: freshState,
        statePath,
        reason: "finalize",
      });
      if (!runtimeSealed.ok) {
        console.log(JSON.stringify({ finalized: false, error: runtimeSealed.error }));
        return;
      }
      freshState = runtimeSealed.state;
    }

    atomicWriteSync(statePath, JSON.stringify(freshState, null, 2) + "\n");
    try { writeCumulativeFindings(dir, freshState); } catch { /* best effort */ }

    // Post-finalize: GC old sessions (best-effort)
    try { gcSessions(); } catch { /* ignore */ }

    console.log(JSON.stringify({ finalized: true, flow, terminalNode: currentNode, totalSteps: freshState.totalSteps }));
  } finally {
    lock.release();
  }
}
