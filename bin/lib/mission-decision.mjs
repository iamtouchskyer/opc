// Durable Mission Gate decision command. Validation and staging occur under
// the canonical session lock; the active state write is the commit point.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { getFlag, resolveDir, atomicWriteSync, WRITER_SIG } from "./util.mjs";
import { lockFile } from "./file-lock.mjs";
import {
  guardMissionMutation,
  parseAcceptanceOutcomes,
  sealMissionRuntimeState,
  validateMissionContract,
  verifyMissionIntegrity,
} from "./mission-contract.mjs";
import {
  MISSION_ACTIONS,
  applyMissionDecision,
  currentMissionBindings,
  openMissionGate,
  sealPendingMissionGate,
  validateColdMissionReview,
} from "./trajectory-gate.mjs";
import { appendProvenanceEvent, findProvenanceEvent } from "./provenance-ledger.mjs";
import { hashContent, parsePlan, validatePlanStructure } from "./loop-helpers.mjs";
import { runLint } from "./criteria-lint.mjs";

const ACTORS = new Set(["agent", "human"]);
const TWO_PHASE_ACTIONS = new Set(["RESTORE", "RECON", "HUMAN_REBET"]);
const FILE_FLAGS = ["review", "approval", "mission", "criteria", "plan", "evidence"];
const MAX_RECON_COUNT = 1;
const SHA256_RE = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function missionReviewClaimsSha256(review) {
  const claims = structuredClone(review || {});
  if (claims.reviewer && typeof claims.reviewer === "object") {
    delete claims.reviewer.provenanceRecordHash;
  }
  return sha256(Buffer.from(canonical(claims), "utf8"));
}

function result(payload) {
  console.log(JSON.stringify(payload));
  return payload;
}

function failure(error, extra = {}) {
  return result({ decided: false, error, ...extra });
}

function readState(dir) {
  for (const name of ["loop-state.json", "flow-state.json"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      const state = JSON.parse(readFileSync(path, "utf8"));
      return { ok: true, state, path, name };
    } catch (error) {
      return { ok: false, error: `${name} is corrupt: ${error.message}` };
    }
  }
  return { ok: false, error: "no loop-state.json or flow-state.json found" };
}

function readableFile(raw, label, { json = false } = {}) {
  if (!raw) return { ok: true, present: false, label };
  const path = resolve(raw);
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return { ok: false, error: `${label} is unreadable: ${error.message}` };
  }
  let value = null;
  if (json) {
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      return { ok: false, error: `${label} is not valid UTF-8 JSON: ${error.message}` };
    }
  }
  return { ok: true, present: true, label, path, bytes, sha256: sha256(bytes), value };
}

function reviewProvenance(canonicalDir, review) {
  if (!review) return { ok: true };
  const hash = review.reviewer?.provenanceRecordHash;
  const found = findProvenanceEvent(canonicalDir, hash);
  if (!found.ok) return { ok: false, error: `mission review provenance is invalid: ${found.error}` };
  const eventRunId = found.event?.runId || found.event?.reviewerRunId || found.event?.reviewer?.runId;
  if (found.event?.type !== "mission_review") {
    return { ok: false, error: "mission review provenance event type must be mission_review" };
  }
  if (found.event?.triggerId !== review.triggerId) {
    return { ok: false, error: "mission review provenance triggerId does not match the review" };
  }
  if (eventRunId !== review.reviewer?.runId) {
    return { ok: false, error: "mission review provenance runId does not match the review" };
  }
  if (found.event?.reviewClaimsSha256 !== missionReviewClaimsSha256(review)) {
    return { ok: false, error: "mission review claims do not match the signed provenance event" };
  }
  return { ok: true, event: found.event };
}

function validateReviewShape(review) {
  const errors = [];
  if (!new Set(["ARTIFACT", "PLAN", "GOAL_SPEC", "ENVIRONMENT", "NONE"]).has(review?.classification)) {
    errors.push("mission review classification is invalid");
  }
  if (!MISSION_ACTIONS.has(review?.recommendation)) errors.push("mission review recommendation is invalid");
  if (typeof review?.rationale !== "string" || !review.rationale.trim()) errors.push("mission review rationale is required");
  if (!Array.isArray(review?.realitySignals)) errors.push("mission review realitySignals must be an array");
  return { ok: errors.length === 0, errors };
}

function sealedMissionReviews(canonicalDir) {
  const reviewsDir = join(canonicalDir, "mission-reviews");
  if (!existsSync(reviewsDir)) return { ok: true, reviews: [] };
  const reviews = [];
  for (const name of readdirSync(reviewsDir).filter(name => name.endsWith(".json")).sort()) {
    const path = join(reviewsDir, name);
    try {
      const review = JSON.parse(readFileSync(path, "utf8"));
      reviews.push({ path, review });
    } catch (error) {
      return { ok: false, error: `sealed mission review '${name}' is unreadable: ${error.message}` };
    }
  }
  return { ok: true, reviews };
}

function missionReviewEvents(canonicalDir, triggerId) {
  const ledgerPath = join(canonicalDir, ".opc-provenance.jsonl");
  if (!existsSync(ledgerPath)) return { ok: true, events: [] };
  const events = [];
  let lines;
  try {
    lines = readFileSync(ledgerPath, "utf8").split(/\n/).filter(Boolean);
  } catch (error) {
    return { ok: false, error: `provenance ledger is unreadable: ${error.message}` };
  }
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return { ok: false, error: "provenance ledger is corrupt" };
    }
    const verified = findProvenanceEvent(canonicalDir, record.recordHash);
    if (!verified.ok) return { ok: false, error: `provenance ledger is invalid: ${verified.error}` };
    if (verified.event?.type === "mission_review" && verified.event.triggerId === triggerId) {
      events.push({ recordHash: record.recordHash, event: verified.event });
    }
  }
  return { ok: true, events };
}

function outcomeParity(contract, criteriaText) {
  const parsed = parseAcceptanceOutcomes(criteriaText);
  const errors = [...parsed.errors];
  const contractOutcomes = new Map((contract.outcomes || []).map(item => [item.id, item.statement]));
  const criteriaOutcomes = new Map(parsed.outcomes.map(item => [item.id, item.statement]));
  for (const [id, statement] of contractOutcomes) {
    if (!criteriaOutcomes.has(id)) errors.push(`criteria is missing '${id}'`);
    else if (criteriaOutcomes.get(id) !== statement) errors.push(`criteria statement for '${id}' does not exactly match`);
  }
  for (const id of criteriaOutcomes.keys()) {
    if (!contractOutcomes.has(id)) errors.push(`criteria contains unknown outcome '${id}'`);
  }
  return errors;
}

function criterionHashes(contract) {
  return Object.fromEntries(
    [...(contract.outcomes || []), ...(contract.protectedFloors || [])]
      .map(item => [item.id, sha256(Buffer.from(item.statement, "utf8"))]),
  );
}

function readPinnedMissionContract(state) {
  try {
    const path = isAbsolute(state.mission.path || "")
      ? state.mission.path
      : resolve(state.__canonicalDir, state.mission.path || "mission-contract.json");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function validateContractRevision(state, contractDoc, criteriaDoc) {
  const errors = [];
  if (!contractDoc.present || !criteriaDoc.present) {
    return { ok: false, errors: ["revised mission and criteria must be supplied together"] };
  }
  const contract = contractDoc.value;
  errors.push(...validateMissionContract(contract).errors);
  const requestHash = sha256(Buffer.from(contract?.originalRequest || "", "utf8"));
  if (requestHash !== state.mission.originalRequestSha256) errors.push("revised mission changes the original request");
  if (contract?.version !== state.mission.version + 1) errors.push("revised mission version must increment by exactly 1");
  const criteriaText = new TextDecoder("utf-8", { fatal: true }).decode(criteriaDoc.bytes);
  errors.push(...outcomeParity(contract || {}, criteriaText));
  errors.push(...runLint(criteriaText).failures.map(item => `criteria-lint [${item.check}]: ${item.message}`));

  const oldHashes = state.mission.criterionHashes || {};
  const nextHashes = criterionHashes(contract || {});
  const retired = new Map((contract?.retiredCriteria || []).map(item => [item.id, item.statementSha256 || item.sha256]));
  let currentContract = null;
  try {
    const currentPath = isAbsolute(state.mission.path || "")
      ? state.mission.path
      : resolve(state.__canonicalDir, state.mission.path || "mission-contract.json");
    currentContract = JSON.parse(readFileSync(currentPath, "utf8"));
  } catch (error) {
    errors.push(`current mission contract history is unreadable: ${error.message}`);
  }
  const priorRetired = new Map(
    (currentContract?.retiredCriteria || []).map(item => [item.id, item.statementSha256 || item.sha256]),
  );
  for (const [id, oldHash] of Object.entries(oldHashes)) {
    if (nextHashes[id] && nextHashes[id] !== oldHash) errors.push(`criterion '${id}' changes meaning; allocate a new id`);
    if (!nextHashes[id] && retired.get(id) !== oldHash) errors.push(`retired criterion '${id}' must preserve its prior statement hash`);
  }
  for (const [id, retiredHash] of priorRetired) {
    if (nextHashes[id]) errors.push(`retired criterion '${id}' cannot be reactivated`);
    if (retired.get(id) !== retiredHash) errors.push(`retired criterion history for '${id}' must be preserved unchanged`);
  }
  return { ok: errors.length === 0, errors, contract, criteriaText, nextHashes };
}

function planLineages(units) {
  let predecessorLineage = null;
  return units.map(unit => {
    const definition = {
      id: unit.id,
      type: unit.type,
      description: unit.description,
      verify: unit.verify ?? null,
      eval: unit.eval ?? null,
    };
    const lineage = sha256(Buffer.from(canonical({ definition, predecessorLineage }), "utf8"));
    predecessorLineage = lineage;
    return { id: unit.id, lineage };
  });
}

export function selectLoopResumeCursor({ oldUnits = [], newUnits = [], tickHistory = [] } = {}) {
  const oldLineages = planLineages(oldUnits);
  const newLineages = planLineages(newUnits);
  const completed = tickHistory
    .map((tick, index) => ({ tick, index }))
    .filter(({ tick }) => tick?.status === "completed" && tick?.stale !== true);
  const reusableTickIndexes = [];
  let prefixLength = 0;
  while (prefixLength < oldLineages.length &&
         prefixLength < newLineages.length &&
         prefixLength < completed.length) {
    const oldUnit = oldLineages[prefixLength];
    const newUnit = newLineages[prefixLength];
    const completedTick = completed[prefixLength];
    if (completedTick.tick.unit !== oldUnit.id || oldUnit.lineage !== newUnit.lineage) break;
    reusableTickIndexes.push(completedTick.index);
    prefixLength++;
  }
  return {
    prefixLength,
    resumeUnit: newUnits[prefixLength]?.id || null,
    allComplete: prefixLength === newUnits.length,
    reusableTickIndexes,
    priorUnit: prefixLength > 0 ? newUnits[prefixLength - 1].id : null,
  };
}

function validatePlanRevision(state, planDoc) {
  if (!planDoc.present) return { ok: false, errors: ["RESHAPE_SMALLER requires --plan"] };
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(planDoc.bytes);
  } catch (error) {
    return { ok: false, errors: [`plan is not valid UTF-8: ${error.message}`] };
  }
  if (!text.trim()) return { ok: false, errors: ["plan must not be empty"] };
  if (state.mission?.planSha256 && planDoc.sha256 === state.mission.planSha256) {
    return { ok: false, errors: ["RESHAPE_SMALLER requires a changed plan; the proposed plan is byte-identical"] };
  }
  if (Object.hasOwn(state, "next_unit") || state.plan_file) {
    const units = parsePlan(text);
    if (units.length === 0) return { ok: false, errors: ["loop plan has no parseable units"] };
    const structure = validatePlanStructure(units);
    if (structure.errors.length > 0) return { ok: false, errors: structure.errors };
    const activePlanPath = state.mission?.planPath || state.plan_file;
    const absoluteActivePlan = isAbsolute(activePlanPath || "")
      ? activePlanPath
      : resolve(state.__canonicalDir, activePlanPath || "plan.md");
    let oldUnits;
    try {
      oldUnits = parsePlan(readFileSync(absoluteActivePlan, "utf8"));
    } catch (error) {
      return { ok: false, errors: [`active loop plan is unreadable: ${error.message}`] };
    }
    if (canonical(planLineages(oldUnits)) === canonical(planLineages(units))) {
      return { ok: false, errors: ["RESHAPE_SMALLER requires a semantic plan change"] };
    }
    const resumeSelection = selectLoopResumeCursor({
      oldUnits,
      newUnits: units,
      tickHistory: state._tick_history || [],
    });
    return { ok: true, text, units, oldUnits, resumeSelection };
  }
  return { ok: true, text, units: [] };
}

function currentGitTree(state) {
  const cwd = state.projectRoot || state.projectDir || state.__canonicalDir;
  try {
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (dirty) return null;
    return execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function verifyMeasuredProbe(probe, state) {
  const errors = [];
  const command = probe?.command;
  if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== "string" || !part)) {
    return { ok: false, errors: ["RECON probe.command must be a non-empty argv array"] };
  }
  const allowed = (command[0] === "node" && command.length === 2 && command[1] === "--version") ||
    (command[0] === "git" && command.length >= 2 && new Set(["--version", "rev-parse", "status"]).has(command[1])) ||
    (command[0] === "uname") || command[0] === "sw_vers";
  if (!allowed) return { ok: false, errors: ["RECON probe command is not in the read-only verifier allowlist"] };
  let projectRoot;
  let cwd;
  try {
    projectRoot = realpathSync(resolve(state.projectRoot || state.projectDir || state.__canonicalDir));
    cwd = realpathSync(resolve(probe.cwd || projectRoot));
  } catch (error) {
    return { ok: false, errors: [`RECON probe cwd is unreadable: ${error.message}`] };
  }
  if (cwd !== projectRoot && !relative(projectRoot, cwd).split(/[\\/]/).every(part => part !== "..")) {
    return { ok: false, errors: ["RECON probe cwd must remain inside the project root"] };
  }
  const timeoutMs = probe.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) {
    return { ok: false, errors: ["RECON probe timeoutMs must be an integer from 1 through 15000"] };
  }
  if (!Number.isInteger(probe.exitCode) || !SHA256_RE.test(probe.stdoutSha256 || "") || !SHA256_RE.test(probe.stderrSha256 || "")) {
    return { ok: false, errors: ["RECON probe requires exitCode and stdout/stderr SHA-256 hashes"] };
  }
  const measured = spawnSync(command[0], command.slice(1), {
    cwd, encoding: null, timeout: timeoutMs, shell: false, stdio: ["ignore", "pipe", "pipe"],
  });
  if (measured.error || measured.signal) errors.push(`RECON probe could not be reproduced: ${measured.error?.message || measured.signal}`);
  if (measured.status !== probe.exitCode) errors.push("RECON probe exitCode does not match the reproduced measurement");
  if (sha256(measured.stdout || Buffer.alloc(0)) !== probe.stdoutSha256) errors.push("RECON probe stdout hash does not match the reproduced measurement");
  if (sha256(measured.stderr || Buffer.alloc(0)) !== probe.stderrSha256) errors.push("RECON probe stderr hash does not match the reproduced measurement");
  return { ok: errors.length === 0, errors };
}

function validateReconBaseline(evidenceDoc, state) {
  if (!evidenceDoc.present) return { ok: false, errors: ["RECON intent requires --evidence with a measured environment baseline"] };
  const evidence = evidenceDoc.value;
  const errors = [];
  if (!evidence || evidence.schemaVersion !== 1) errors.push("RECON baseline evidence schemaVersion must be 1");
  if (evidence?.action !== "RECON" || evidence?.type !== "environment_baseline") {
    errors.push("RECON intent evidence requires action=RECON and type=environment_baseline");
  }
  if (evidence?.triggerId !== state.trajectory.triggerId) errors.push("RECON baseline triggerId does not match the pending gate");
  if (evidence?.missionSha256 !== state.mission.sha256) errors.push("RECON baseline mission hash does not match the pending gate");
  if ((evidence?.planSha256 ?? null) !== (state.mission.planSha256 ?? null)) errors.push("RECON baseline plan hash does not match the pending gate");
  if (evidence?.strategyEpoch !== state.mission.strategyEpoch) errors.push("RECON baseline strategy epoch does not match the pending gate");
  if (errors.length > 0) return { ok: false, errors };
  const measured = verifyMeasuredProbe(evidence.probe, state);
  return measured.ok
    ? { ok: true, errors: [], evidence, probe: structuredClone(evidence.probe) }
    : measured;
}

function validateEvidence(action, evidenceDoc, resumeUnit, state, intent, intentEvent) {
  if (!evidenceDoc.present) return { ok: false, errors: [`${action} resume requires --evidence`] };
  const evidence = evidenceDoc.value;
  if (!evidence || evidence.schemaVersion !== 1) return { ok: false, errors: ["evidence schemaVersion must be 1"] };
  const bindingErrors = [];
  if (evidence.action !== action || evidence.intentEventId !== intent ||
      evidence.triggerId !== state.trajectory.triggerId || evidence.triggerId !== intentEvent?.triggerId) {
    bindingErrors.push(`${action} evidence does not match the pending action, intent, and trigger`);
  }
  if (evidence.missionSha256 !== state.mission.sha256 || evidence.missionSha256 !== intentEvent?.oldMissionSha256) {
    bindingErrors.push(`${action} evidence mission hash does not match the intent`);
  }
  if ((evidence.planSha256 ?? null) !== (state.mission.planSha256 ?? null) ||
      (evidence.planSha256 ?? null) !== (intentEvent?.oldPlanSha256 ?? null)) {
    bindingErrors.push(`${action} evidence plan hash does not match the intent`);
  }
  if (evidence.strategyEpoch !== state.mission.strategyEpoch || evidence.strategyEpoch !== intentEvent?.oldStrategyEpoch) {
    bindingErrors.push(`${action} evidence strategy epoch does not match the intent`);
  }
  if (bindingErrors.length > 0) return { ok: false, errors: bindingErrors };
  if (action === "RESTORE") {
    if (evidence.type !== "restore" || !(evidence.gitTreeSha || evidence.checkpointId)) {
      return { ok: false, errors: ["RESTORE evidence requires type=restore and gitTreeSha or checkpointId"] };
    }
    if (!resumeUnit) return { ok: false, errors: ["RESTORE resume requires --resume-unit"] };
    const planPath = state.mission.planPath || state.plan_file;
    if (!planPath) return { ok: false, errors: ["RESTORE has no active plan"] };
    const absolutePlan = isAbsolute(planPath) ? planPath : resolve(state.__canonicalDir, planPath);
    const units = parsePlan(readFileSync(absolutePlan, "utf8"));
    if (!units.some(unit => unit.id === resumeUnit)) return { ok: false, errors: [`resume unit '${resumeUnit}' is not in the active plan`] };
    if (evidence.gitTreeSha) {
      const actual = currentGitTree(state);
      if (!actual) return { ok: false, errors: ["RESTORE git tree cannot be measured in the active project"] };
      if (evidence.gitTreeSha !== actual) return { ok: false, errors: ["RESTORE gitTreeSha does not match the active Git tree"] };
      if (!evidence.checkpointId && (!intentEvent?.oldGitTreeSha || evidence.gitTreeSha === intentEvent.oldGitTreeSha)) {
        return { ok: false, errors: ["RESTORE gitTreeSha must prove a clean tree change from the intent baseline or name a bound checkpoint"] };
      }
    }
    if (evidence.checkpointId) {
      const liveBindings = currentMissionBindings(state);
      const receipt = (state.checkpointReceipts || []).find(item =>
        item?.checkpointId === evidence.checkpointId && item?.stale !== true &&
        ["missionSha256", "acceptanceCriteriaSha256", "planSha256", "evidenceSetSha256", "artifactManifestSha256", "strategyEpoch"]
          .every(field => (item?.[field] ?? null) === (liveBindings[field] ?? null))
      );
      if (!receipt) return { ok: false, errors: ["RESTORE checkpointId does not name a current bound checkpoint receipt"] };
      if (evidence.checkpointReceiptSha256 !== sha256(Buffer.from(canonical(receipt), "utf8"))) {
        return { ok: false, errors: ["RESTORE checkpoint receipt hash does not match the known checkpoint"] };
      }
    }
    return { ok: true, errors: [], evidence, units };
  }
  if (action === "RECON" && (evidence.type !== "environment_delta" || !evidence.observation)) {
    return { ok: false, errors: ["RECON evidence requires type=environment_delta and observation"] };
  }
  if (action === "RECON") {
    const probe = verifyMeasuredProbe(evidence.probe, state);
    if (!probe.ok) return { ok: false, errors: probe.errors };
    const baselineProbe = intentEvent?.reconBaselineProbe;
    if (!baselineProbe) return { ok: false, errors: ["RECON intent has no signed baseline probe"] };
    const baselineIdentity = canonical({
      command: baselineProbe.command,
      cwd: baselineProbe.cwd || null,
    });
    const observedIdentity = canonical({
      command: evidence.probe?.command,
      cwd: evidence.probe?.cwd || null,
    });
    if (baselineIdentity !== observedIdentity) {
      return { ok: false, errors: ["RECON delta probe must use the same command and cwd as the signed intent baseline"] };
    }
    const changed = baselineProbe.exitCode !== evidence.probe.exitCode
      || baselineProbe.stdoutSha256 !== evidence.probe.stdoutSha256
      || baselineProbe.stderrSha256 !== evidence.probe.stderrSha256;
    if (!changed) return { ok: false, errors: ["RECON evidence reproduces the intent baseline and contains no measured delta"] };
  }
  return { ok: true, errors: [], evidence };
}

function intendedStateDelta(state, action, phase, docs, resumeUnit) {
  if (phase === "intent") return { trajectory: { pending: true, pendingAction: action } };
  if (action === "CONTINUE_CURRENT") {
    const finalCheckpoint = state.trajectory.pendingPacket?.checkpoint === "before_finalize";
    return { trajectory: { pending: false, retryAllowance: finalCheckpoint ? 0 : 1 }, checkpointReceipt: finalCheckpoint };
  }
  if (action === "STOP_SALVAGE") return { trajectory: { pending: false }, status: Object.hasOwn(state, "next_unit") ? "terminated" : "stopped" };
  if (action === "RESHAPE_SMALLER") {
    return { mission: { strategyEpoch: state.mission.strategyEpoch + 1, planSha256: docs.plan.sha256 }, trajectory: { pending: false, retryAllowance: 0 } };
  }
  if (action === "RESTORE") return { trajectory: { pending: false, retryAllowance: 0 }, next_unit: resumeUnit };
  if (action === "RECON") return { mission: { strategyEpoch: state.mission.strategyEpoch + 1 }, trajectory: { pending: true, reason: "ENVIRONMENT_RECLASSIFY" } };
  if (action === "HUMAN_REBET") {
    return { mission: { strategyEpoch: state.mission.strategyEpoch + 1, sha256: docs.mission.sha256 }, trajectory: { pending: false, retryAllowance: 0 } };
  }
  return {};
}

function copyName(label, sourcePath) {
  if (label === "review") return "mission-review.json";
  if (label === "approval") return "approval.txt";
  if (label === "mission") return "mission-contract.json";
  if (label === "criteria") return "acceptance-criteria.md";
  if (label === "plan") return "plan.md";
  if (label === "evidence") return "evidence.json";
  return basename(sourcePath);
}

function stageDecision(canonicalDir, decisionId, docs, manifestBase) {
  const decisionsDir = join(canonicalDir, "decisions");
  mkdirSync(decisionsDir, { recursive: true, mode: 0o700 });
  const decisionDir = join(decisionsDir, decisionId);
  mkdirSync(decisionDir, { recursive: false, mode: 0o700 });
  const staged = {};
  for (const doc of docs) {
    if (!doc.present) continue;
    const name = copyName(doc.label, doc.path);
    const path = join(decisionDir, name);
    writeFileSync(path, doc.bytes, { flag: "wx", mode: 0o600 });
    staged[doc.label] = { path, relativePath: relative(canonicalDir, path), sha256: doc.sha256 };
  }
  const manifest = { ...manifestBase, files: staged };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const manifestPath = join(decisionDir, "manifest.json");
  writeFileSync(manifestPath, manifestBytes, { flag: "wx", mode: 0o600 });
  for (const entry of Object.values(staged)) chmodSync(entry.path, 0o400);
  chmodSync(manifestPath, 0o400);
  chmodSync(decisionDir, 0o500);
  return {
    decisionDir,
    staged,
    manifest,
    manifestPath,
    manifestRelativePath: relative(canonicalDir, manifestPath),
    manifestSha256: sha256(manifestBytes),
  };
}

function applyStagedState({ state, decision, action, actor, review, phase, contractRevision, planValidation, evidenceValidation, resumeUnit }) {
  let next = decision.state;
  const staged = decision.staged;
  let reconTrigger = null;
  if (action === "STOP_SALVAGE") {
    next.trajectory.salvageInstructions = readPinnedMissionContract(state)?.exitAndSalvage || null;
    next.trajectory.terminal = true;
    next.trajectory.terminalAction = "STOP_SALVAGE";
    next.trajectory.terminalAt = next.trajectory.lastDecision?.decidedAt || new Date().toISOString();
    next.trajectory.pendingActionTriggerId = null;
    next.trajectory.pendingActionMissionSha256 = null;
    next.trajectory.pendingActionPlanSha256 = null;
    next.trajectory.pendingActionStrategyEpoch = null;
  }
  if (staged.plan && (action === "RESHAPE_SMALLER" || action === "HUMAN_REBET")) {
    next.mission.planPath = staged.plan.relativePath;
    next.mission.planSha256 = staged.plan.sha256;
    if (Object.hasOwn(next, "plan_file")) {
      next.plan_file = staged.plan.path;
      next._plan_hash = hashContent(planValidation.text);
      if (planValidation?.units?.length > 0) {
        next.unit_ids = planValidation.units.map(unit => unit.id);
        next.units_total = planValidation.units.length;
      }
      if (planValidation?.resumeSelection) {
        const selection = planValidation.resumeSelection;
        const reusable = new Set(selection.reusableTickIndexes);
        next.next_unit = selection.resumeUnit;
        next.unit = selection.priorUnit;
        next.status = "initialized";
        next._tick_history = (next._tick_history || []).map((tick, index) =>
          reusable.has(index) ? tick : { ...tick, stale: true }
        );
        next.mission.planResume = {
          completedPrefixLength: selection.prefixLength,
          resumeUnit: selection.resumeUnit,
          allComplete: selection.allComplete,
        };
      }
    }
  }
  if (contractRevision?.ok) {
    next.mission.path = staged.mission.relativePath;
    next.mission.sha256 = staged.mission.sha256;
    next.mission.acceptanceCriteriaPath = staged.criteria.relativePath;
    next.mission.acceptanceCriteriaSha256 = staged.criteria.sha256;
    next.mission.version = contractRevision.contract.version;
    next.mission.criterionHashes = contractRevision.nextHashes;
    next.mission.appetite = structuredClone(contractRevision.contract.appetite);
    next.mission.endToEndScenario = structuredClone(contractRevision.contract.endToEndScenario);
    next.mission.realitySignals = structuredClone(contractRevision.contract.realitySignals);
    next.mission.strategyEpoch = state.mission.strategyEpoch + 1;
  }

  if (phase === "intent") {
    next.trajectory.pendingActionActor = actor;
    next.trajectory.pendingActionReviewSha256 = staged.review?.sha256 || null;
    next.trajectory.pendingActionReviewProvenanceRecordHash = review?.reviewer?.provenanceRecordHash || null;
    next.trajectory.pendingActionTriggerId = state.trajectory.triggerId;
    next.trajectory.pendingActionMissionSha256 = state.mission.sha256;
    next.trajectory.pendingActionPlanSha256 = state.mission.planSha256 ?? null;
    next.trajectory.pendingActionStrategyEpoch = state.mission.strategyEpoch;
  }

  if (phase === "resume" && action === "RESTORE") {
    next.trajectory.pending = false;
    next.trajectory.pendingAction = null;
    next.trajectory.pendingActionEventId = null;
    next.trajectory.pendingActionActor = null;
    next.trajectory.pendingActionReviewSha256 = null;
    next.trajectory.pendingActionReviewProvenanceRecordHash = null;
    next.trajectory.pendingActionTriggerId = null;
    next.trajectory.pendingActionMissionSha256 = null;
    next.trajectory.pendingActionPlanSha256 = null;
    next.trajectory.pendingActionStrategyEpoch = null;
    next.trajectory.pendingPacket = null;
    next.trajectory.retryAllowance = 0;
    next.checkpointReceipts = (next.checkpointReceipts || []).map(receipt => ({ ...receipt, stale: true }));
    if (Object.hasOwn(next, "next_unit")) {
      next.next_unit = resumeUnit;
      next.status = "initialized";
      const units = evidenceValidation?.units || [];
      const resumeIndex = units.findIndex(unit => unit.id === resumeUnit);
      const isAtOrAfter = unitId => {
        const index = units.findIndex(unit => unit.id === unitId);
        return index === -1 || index >= resumeIndex;
      };
      next.evidenceReceipts = (next.evidenceReceipts || []).map(receipt =>
        isAtOrAfter(receipt.sliceId || receipt.unit) ? { ...receipt, stale: true } : receipt
      );
      next._tick_history = (next._tick_history || []).map(tick =>
        isAtOrAfter(tick.unit) ? { ...tick, stale: true } : tick
      );
    }
  } else if (phase === "resume" && action === "RECON") {
    next.mission.strategyEpoch = state.mission.strategyEpoch + 1;
    next.trajectory.pending = false;
    next.trajectory.pendingAction = null;
    next.trajectory.pendingActionEventId = null;
    next.trajectory.pendingActionActor = null;
    next.trajectory.pendingActionReviewSha256 = null;
    next.trajectory.pendingActionReviewProvenanceRecordHash = null;
    next.trajectory.pendingActionTriggerId = null;
    next.trajectory.pendingActionMissionSha256 = null;
    next.trajectory.pendingActionPlanSha256 = null;
    next.trajectory.pendingActionStrategyEpoch = null;
    next.trajectory.reconCount = (state.trajectory.reconCount || 0) + 1;
    next.trajectory.reason = "ENVIRONMENT_RECLASSIFY";
    next.trajectory.triggerId = `${state.trajectory.triggerId || "TRJ"}-RECON-${next.mission.strategyEpoch}`;
    next.trajectory.pendingPacket = null;
    reconTrigger = {
      triggerId: next.trajectory.triggerId,
      reason: "ENVIRONMENT_RECLASSIFY",
      retryable: true,
      findingRefs: state.trajectory.pendingPacket?.findingRefs || [],
      affectedCriteria: state.trajectory.pendingPacket?.affectedCriteria || [],
      environmentDelta: {
        sha256: staged.evidence.sha256,
        type: evidenceValidation?.evidence?.type || "environment_delta",
        observation: evidenceValidation?.evidence?.observation || null,
      },
    };
    next.mission.environmentBaselineSha256 = staged.evidence.sha256;
  } else if (phase === "resume" && action === "HUMAN_REBET") {
    next.trajectory.pending = false;
    next.trajectory.pendingAction = null;
    next.trajectory.pendingActionEventId = null;
    next.trajectory.pendingActionActor = null;
    next.trajectory.pendingActionReviewSha256 = null;
    next.trajectory.pendingActionReviewProvenanceRecordHash = null;
    next.trajectory.pendingActionTriggerId = null;
    next.trajectory.pendingActionMissionSha256 = null;
    next.trajectory.pendingActionPlanSha256 = null;
    next.trajectory.pendingActionStrategyEpoch = null;
    // A human-approved contract revision starts a new bounded bet. RECON is
    // capped once within each bet, rather than once for the lifetime of a task.
    next.trajectory.reconCount = 0;
    next.trajectory.pendingPacket = null;
    next.trajectory.retryAllowance = 0;
    if (Object.hasOwn(next, "next_unit") && next.status === "mission_pending") next.status = "initialized";
  }
  if (next.mission.strategyEpoch !== state.mission.strategyEpoch) {
    next.evidenceReceipts = (next.evidenceReceipts || []).map(receipt =>
      receipt?.strategyEpoch === next.mission.strategyEpoch ? receipt : { ...receipt, stale: true }
    );
    next.checkpointReceipts = (next.checkpointReceipts || []).map(receipt =>
      receipt?.strategyEpoch === next.mission.strategyEpoch ? receipt : { ...receipt, stale: true }
    );
  }
  if (reconTrigger) {
    const contract = readPinnedMissionContract(next);
    next = openMissionGate({
      sessionDir: null,
      state: next,
      missionContract: contract,
      trigger: reconTrigger,
    }).state;
  }
  if (!next.trajectory.pending && next.status === "mission_pending") next.status = "initialized";
  return next;
}

function immutableStateMetadata(next, manifest, provenanceHash, now) {
  next.mission.decisionManifestPath = manifest.manifestRelativePath;
  next.mission.decisionManifestSha256 = manifest.manifestSha256;
  next.mission.decisionProvenanceRecordHash = provenanceHash;
  next._written_by = WRITER_SIG;
  next._last_modified = now;
  next._write_nonce = randomBytes(8).toString("hex");
}

/** Validate, sign, and seal a cold review for subsequent mission-decision use. */
export function cmdRecordMissionReview(args) {
  const recordFailure = (error, extra = {}) => result({ recorded: false, error, ...extra });
  const requestedDir = resolveDir(args);
  const source = readableFile(getFlag(args, "review", null), "review", { json: true });
  if (!source.ok) return recordFailure(source.error);
  if (!source.present) return recordFailure("record-mission-review requires --review");
  const local = readState(requestedDir);
  if (!local.ok) return recordFailure(local.error);
  if (!local.state.mission) return recordFailure("mission is not enabled");

  const initialGuard = guardMissionMutation({
    sessionDir: requestedDir,
    state: local.state,
    command: "record-mission-review",
    allowPending: true,
  });
  if (!initialGuard.allowed) return recordFailure(initialGuard.reason, { rebet_required: initialGuard.rebet_required });

  let canonicalDir;
  try {
    canonicalDir = realpathSync(initialGuard.canonicalDir);
  } catch (error) {
    return recordFailure(`canonical session is unreadable: ${error.message}`);
  }
  const canonicalState = readState(canonicalDir);
  if (!canonicalState.ok) return recordFailure(canonicalState.error);
  const lock = lockFile(canonicalState.path, { command: "record-mission-review" });
  if (!lock.acquired) return recordFailure("could not acquire canonical mission state lock", { holder: lock.holder });

  try {
    const fresh = readState(canonicalDir);
    if (!fresh.ok) return recordFailure(fresh.error);
    const state = fresh.state;
    const guard = guardMissionMutation({
      sessionDir: canonicalDir,
      state,
      command: "record-mission-review",
      allowPending: true,
    });
    if (!guard.allowed) return recordFailure(guard.reason, { rebet_required: guard.rebet_required });
    if (!state.trajectory?.pending) return recordFailure("no Mission Gate is pending");

    const review = structuredClone(source.value);
    if (review.reviewer?.provenanceRecordHash) {
      return recordFailure("source mission review must not provide provenanceRecordHash; the harness signs it");
    }
    if (review.triggerContext !== undefined) {
      return recordFailure("source mission review must not provide triggerContext; the harness binds it");
    }
    const shape = validateReviewShape(review);
    if (!shape.ok) return recordFailure(shape.errors.join("; "));
    const sealed = sealedMissionReviews(canonicalDir);
    if (!sealed.ok) return recordFailure(sealed.error);
    const packet = state.trajectory.pendingPacket || {};
    const findingRefs = [...new Set(Array.isArray(packet.findingRefs) ? packet.findingRefs : [])].sort();
    const priorSameScope = sealed.reviews.find(entry => {
      if (entry.review?.triggerId === review.triggerId) return false;
      const priorRefs = new Set(entry.review?.triggerContext?.findingRefs || []);
      if (findingRefs.some(ref => priorRefs.has(ref))) return true;
      return packet.edgeKey && entry.review?.triggerContext?.edgeKey === packet.edgeKey;
    });
    const hasNewEvidence = Array.isArray(packet.evidenceDelta) && packet.evidenceDelta.length > 0;
    const hasMeasuredEnvironmentDelta = Boolean(packet.environmentDelta?.sha256);
    const humanSteered = packet.reason === "HUMAN_INTERVENTION";
    if (priorSameScope && !hasNewEvidence && !hasMeasuredEnvironmentDelta && !humanSteered) {
      return recordFailure(
        "this invariant already received a cold review; new integrated evidence, a measured environment delta, or explicit human steering is required",
      );
    }
    review.reviewer ||= {};
    review.reviewer.provenanceRecordHash = "pending";
    const cold = validateColdMissionReview({ state, review });
    delete review.reviewer.provenanceRecordHash;
    if (!cold.ok) return recordFailure(cold.errors.join("; "));

    review.triggerContext = {
      reason: packet.reason || null,
      findingRefs,
      edgeKey: packet.edgeKey || null,
      evidenceDeltaSha256: sha256(Buffer.from(canonical(packet.evidenceDelta || []), "utf8")),
      environmentDeltaSha256: packet.environmentDelta?.sha256 || null,
    };

    const reviewClaimsSha256 = missionReviewClaimsSha256(review);
    const existingEvents = missionReviewEvents(canonicalDir, review.triggerId);
    if (!existingEvents.ok) return recordFailure(existingEvents.error);
    if (existingEvents.events.length > 1) {
      return recordFailure("Mission Gate trigger has multiple signed review events; manual recovery is required");
    }
    const sameTrigger = sealed.reviews.find(entry => entry.review?.triggerId === review.triggerId);
    if (sameTrigger) {
      if (missionReviewClaimsSha256(sameTrigger.review) !== reviewClaimsSha256) {
        return recordFailure("this Mission Gate trigger already has a different sealed cold review", { review: sameTrigger.path });
      }
      const signed = reviewProvenance(canonicalDir, sameTrigger.review);
      if (!signed.ok) return recordFailure(signed.error);
      if (signed.event.sourceSha256 && signed.event.sourceSha256 !== source.sha256) {
        return recordFailure("retry source bytes do not match the sealed cold review");
      }
      chmodSync(sameTrigger.path, 0o400);
      return result({
        recorded: true,
        already: true,
        review: sameTrigger.path,
        provenance_record_hash: sameTrigger.review.reviewer.provenanceRecordHash,
        review_claims_sha256: reviewClaimsSha256,
        canonical_dir: canonicalDir,
        redirected_from_child: canonicalDir !== realpathSync(requestedDir),
      });
    }

    let provenance;
    if (existingEvents.events.length === 1) {
      const existing = existingEvents.events[0];
      if (existing.event.reviewClaimsSha256 !== reviewClaimsSha256 ||
          existing.event.sourceSha256 !== source.sha256 ||
          existing.event.runId !== review.reviewer.runId) {
        return recordFailure("signed review event for this trigger does not match the retry source");
      }
      provenance = { recordHash: existing.recordHash };
    } else {
      provenance = appendProvenanceEvent(canonicalDir, {
        type: "mission_review",
        runId: review.reviewer.runId,
        triggerId: review.triggerId,
        reviewClaimsSha256,
        sourceSha256: source.sha256,
      });
    }
    review.reviewer.provenanceRecordHash = provenance.recordHash;
    const reviewsDir = join(canonicalDir, "mission-reviews");
    mkdirSync(reviewsDir, { recursive: true, mode: 0o700 });
    const sealedPath = join(reviewsDir, `review-${sha256(Buffer.from(review.triggerId, "utf8"))}.json`);
    atomicWriteSync(sealedPath, JSON.stringify(review, null, 2) + "\n");
    chmodSync(sealedPath, 0o400);
    return result({
      recorded: true,
      review: sealedPath,
      provenance_record_hash: provenance.recordHash,
      review_claims_sha256: reviewClaimsSha256,
      canonical_dir: canonicalDir,
      redirected_from_child: canonicalDir !== realpathSync(requestedDir),
    });
  } catch (error) {
    return recordFailure(`record-mission-review failed: ${error.message}`);
  } finally {
    lock.release();
  }
}

export function cmdMissionDecision(args) {
  const requestedDir = resolveDir(args);
  const action = String(getFlag(args, "action", "")).toUpperCase();
  const actor = String(getFlag(args, "actor", "")).toLowerCase();
  const rawPhase = getFlag(args, "phase", null);
  const phase = rawPhase ? String(rawPhase).toLowerCase() : (TWO_PHASE_ACTIONS.has(action) ? "intent" : "commit");
  const intent = getFlag(args, "intent", null);
  const note = getFlag(args, "note", "") || "";
  const resumeUnit = getFlag(args, "resume-unit", null);

  if (!MISSION_ACTIONS.has(action)) return failure(`invalid mission action '${action || "(missing)"}'`);
  if (!ACTORS.has(actor)) return failure("actor must be agent or human");
  if (TWO_PHASE_ACTIONS.has(action)) {
    if (!new Set(["intent", "resume"]).has(phase)) return failure(`${action} phase must be intent or resume`);
    if (phase === "resume" && !intent) return failure(`${action} resume requires --intent`);
    if (phase === "intent" && intent) return failure(`${action} intent must not supply --intent`);
  } else if (rawPhase) {
    return failure(`${action} does not accept --phase`);
  }

  const local = readState(requestedDir);
  if (!local.ok) return failure(local.error);
  if (!local.state.mission) return failure("mission is not enabled");
  const initialGuard = guardMissionMutation({ sessionDir: requestedDir, state: local.state, command: "mission-decision", allowPending: true });
  if (!initialGuard.allowed) return failure(initialGuard.reason, { rebet_required: initialGuard.rebet_required });

  let canonicalDir;
  try {
    canonicalDir = realpathSync(initialGuard.canonicalDir);
  } catch (error) {
    return failure(`canonical session is unreadable: ${error.message}`);
  }
  const canonical = readState(canonicalDir);
  if (!canonical.ok) return failure(canonical.error);
  const lock = lockFile(canonical.path, { command: "mission-decision" });
  if (!lock.acquired) return failure("could not acquire canonical mission state lock", { holder: lock.holder });

  try {
    const fresh = readState(canonicalDir);
    if (!fresh.ok) return failure(fresh.error);
    let state = fresh.state;
    state.__canonicalDir = canonicalDir;
    const stateBytes = readFileSync(fresh.path);
    const stateSha256 = sha256(stateBytes);
    const guard = guardMissionMutation({ sessionDir: canonicalDir, state, command: "mission-decision", allowPending: true });
    if (!guard.allowed) return failure(guard.reason, { rebet_required: guard.rebet_required });
    // Integrity validation may recover/replace the supplied state object with
    // the newest committed runtime snapshot. Re-attach this in-memory-only
    // path after that boundary; it is removed again before durable sealing.
    state.__canonicalDir = canonicalDir;
    if (!state.trajectory?.pending) {
      if (actor !== "human" || action === "CONTINUE_CURRENT") {
        return failure("no Mission Gate is pending");
      }
      const integrity = verifyMissionIntegrity({ sessionDir: canonicalDir, state });
      if (!integrity.ok) return failure(integrity.errors.join("; "));
      state = openMissionGate({
        sessionDir: null,
        state,
        missionContract: integrity.contract,
        trigger: {
          reason: "HUMAN_INTERVENTION",
          retryable: action !== "STOP_SALVAGE",
        },
      }).state;
      state.__canonicalDir = canonicalDir;
    }

    if (phase === "resume" &&
        (state.trajectory.pendingAction !== action || state.trajectory.pendingActionEventId !== intent)) {
      return failure("resume intent does not match the pending action and trigger");
    }
    let intentEvent = null;
    if (phase === "resume") {
      const foundIntent = findProvenanceEvent(canonicalDir, intent);
      if (!foundIntent.ok) return failure(`resume intent provenance is invalid: ${foundIntent.error}`);
      intentEvent = foundIntent.event;
      if (intentEvent?.type !== "decision_prepared" || intentEvent.phase !== "intent" ||
          intentEvent.action !== action || intentEvent.triggerId !== state.trajectory.triggerId ||
          state.trajectory.pendingActionTriggerId !== intentEvent.triggerId ||
          state.trajectory.pendingActionMissionSha256 !== intentEvent.oldMissionSha256 ||
          (state.trajectory.pendingActionPlanSha256 ?? null) !== (intentEvent.oldPlanSha256 ?? null) ||
          state.trajectory.pendingActionStrategyEpoch !== intentEvent.oldStrategyEpoch) {
        return failure("resume intent is stale or does not match the pending mission/plan/epoch binding");
      }
    }
    if (state.trajectory.pendingAction && phase !== "resume" && action !== "STOP_SALVAGE") {
      return failure(`pending action '${state.trajectory.pendingAction}' must be resumed before another intent`);
    }
    if (action === "RECON" && phase === "intent" && (state.trajectory.reconCount || 0) >= MAX_RECON_COUNT) {
      return failure(`RECON limit reached (${MAX_RECON_COUNT}); choose HUMAN_REBET or STOP_SALVAGE`);
    }
    if (state.trajectory.pendingPacket?.retryable === false &&
        state.trajectory.pendingPacket?.checkpoint !== "before_finalize" &&
        !new Set(["HUMAN_REBET", "STOP_SALVAGE"]).has(action)) {
      return failure("this Mission Gate is non-retryable; choose HUMAN_REBET or STOP_SALVAGE");
    }

    const docs = {};
    for (const flag of FILE_FLAGS) {
      docs[flag] = readableFile(getFlag(args, flag, null), flag, { json: new Set(["review", "mission", "evidence"]).has(flag) });
      if (!docs[flag].ok) return failure(docs[flag].error);
    }
    const review = docs.review.present ? docs.review.value : null;
    const approval = docs.approval.present ? { path: docs.approval.path, sha256: docs.approval.sha256 } : null;
    const carriesIntentReview = phase === "resume" && actor === "agent" &&
      state.trajectory.pendingAction === action &&
      state.trajectory.pendingActionEventId === intent &&
      state.trajectory.pendingActionActor === "agent" &&
      typeof state.trajectory.pendingActionReviewSha256 === "string" &&
      typeof state.trajectory.pendingActionReviewProvenanceRecordHash === "string";

    if (docs.approval.present && docs.approval.bytes.toString("utf8").trim().length === 0) {
      return failure("approval artifact must contain the verbatim human approval");
    }

    if (carriesIntentReview && review) {
      return failure("two-phase resume uses the review bound at intent; do not supply a second review");
    }
    if ((actor === "agent" || action === "CONTINUE_CURRENT") && !review && !carriesIntentReview) {
      return failure(`${actor === "agent" ? "agent decisions" : "CONTINUE_CURRENT"} require --review`);
    }
    if (review) {
      const shape = validateReviewShape(review);
      if (!shape.ok) return failure(shape.errors.join("; "));
      const cold = validateColdMissionReview({ state, review });
      if (!cold.ok) return failure(cold.errors.join("; "));
      const provenance = reviewProvenance(canonicalDir, review);
      if (!provenance.ok) return failure(provenance.error);
    }
    const isOverride = review && review.recommendation !== action;
    const hasContractInputs = docs.mission.present || docs.criteria.present;
    if ((isOverride || hasContractInputs) && actor !== "human") return failure("goal changes and review overrides require actor=human");
    if ((isOverride || hasContractInputs) && !approval) return failure("goal changes and review overrides require --approval");
    if (hasContractInputs && !(action === "HUMAN_REBET" && phase === "resume")) {
      return failure("revised mission and criteria are only accepted by HUMAN_REBET resume");
    }
    if (action === "HUMAN_REBET" && phase === "resume" && !hasContractInputs) {
      return failure("HUMAN_REBET resume requires revised --mission and --criteria");
    }

    let contractRevision = null;
    if (hasContractInputs) {
      contractRevision = validateContractRevision(state, docs.mission, docs.criteria);
      if (!contractRevision.ok) return failure(contractRevision.errors.join("; "));
    }
    let planValidation = null;
    if (action === "RESHAPE_SMALLER" || docs.plan.present) {
      planValidation = validatePlanRevision(state, docs.plan);
      if (!planValidation.ok) return failure(planValidation.errors.join("; "));
    }
    let reconBaselineValidation = null;
    if (phase === "intent" && action === "RECON") {
      reconBaselineValidation = validateReconBaseline(docs.evidence, state);
      if (!reconBaselineValidation.ok) return failure(reconBaselineValidation.errors.join("; "));
    }
    let evidenceValidation = null;
    if (phase === "resume" && (action === "RESTORE" || action === "RECON")) {
      evidenceValidation = validateEvidence(action, docs.evidence, resumeUnit, state, intent, intentEvent);
      if (!evidenceValidation.ok) return failure(evidenceValidation.errors.join("; "));
    }

    // Decision policy is pure. Check it before staging files or appending a
    // provenance event so a boundedness rejection leaves no prepared debris.
    const policyPreview = applyMissionDecision({
      state,
      action,
      actor,
      review,
      carryIntentReview: carriesIntentReview,
      approval,
      decisionEventId: "preflight",
    });
    if (!policyPreview.ok) return failure(policyPreview.errors.join("; "));

    const now = new Date().toISOString();
    const decisionId = `DEC-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const intendedDelta = intendedStateDelta(state, action, phase, docs, resumeUnit);
    if (planValidation?.resumeSelection) {
      intendedDelta.next_unit = planValidation.resumeSelection.resumeUnit;
      intendedDelta.completedPrefixLength = planValidation.resumeSelection.prefixLength;
      intendedDelta.resumeAtFinalCheckpoint = planValidation.resumeSelection.allComplete;
    }
    const manifestBase = {
      schemaVersion: 1,
      decisionId,
      triggerId: state.trajectory.triggerId,
      action,
      actor,
      phase,
      intent: intent || null,
      note,
      priorStateSha256: stateSha256,
      oldMissionSha256: state.mission.sha256,
      oldPlanSha256: state.mission.planSha256 ?? null,
      oldStrategyEpoch: state.mission.strategyEpoch,
      newMissionSha256: docs.mission.present ? docs.mission.sha256 : state.mission.sha256,
      newCriteriaSha256: docs.criteria.present ? docs.criteria.sha256 : state.mission.acceptanceCriteriaSha256,
      newPlanSha256: docs.plan.present ? docs.plan.sha256 : state.mission.planSha256 ?? null,
      newStrategyEpoch: state.mission.strategyEpoch + ((action === "RESHAPE_SMALLER" || contractRevision || (phase === "resume" && action === "RECON")) ? 1 : 0),
      intendedStateDelta: intendedDelta,
      preparedAt: now,
    };
    let staged;
    try {
      staged = stageDecision(canonicalDir, decisionId, Object.values(docs), manifestBase);
    } catch (error) {
      return failure(`cannot stage decision: ${error.message}`);
    }

    const prepared = appendProvenanceEvent(canonicalDir, {
      type: "decision_prepared",
      decisionId,
      triggerId: state.trajectory.triggerId,
      action,
      actor,
      phase,
      intent: intent || null,
      note,
      priorStateSha256: stateSha256,
      manifestPath: staged.manifestRelativePath,
      manifestSha256: staged.manifestSha256,
      reviewSha256: staged.staged.review?.sha256 || null,
      approvalSha256: staged.staged.approval?.sha256 || null,
      oldMissionSha256: state.mission.sha256,
      newMissionSha256: staged.staged.mission?.sha256 || state.mission.sha256,
      oldPlanSha256: state.mission.planSha256 ?? null,
      newPlanSha256: staged.staged.plan?.sha256 || state.mission.planSha256 || null,
      oldStrategyEpoch: state.mission.strategyEpoch,
      newStrategyEpoch: state.mission.strategyEpoch + ((action === "RESHAPE_SMALLER" || contractRevision || (phase === "resume" && action === "RECON")) ? 1 : 0),
      evidenceSha256: staged.staged.evidence?.sha256 || null,
      oldGitTreeSha: currentGitTree(state),
      reconBaselineProbe: reconBaselineValidation?.probe || null,
    });

    const applied = applyMissionDecision({
      state,
      action,
      actor,
      review,
      carryIntentReview: carriesIntentReview,
      approval,
      decisionEventId: prepared.recordHash,
      now,
    });
    if (!applied.ok) return failure(applied.errors.join("; "), { decision_id: decisionId });
    applied.staged = staged.staged;
    let next = applyStagedState({
      state,
      decision: applied,
      action,
      actor,
      review,
      phase,
      contractRevision,
      planValidation,
      evidenceValidation,
      resumeUnit,
    });
    delete next.__canonicalDir;
    immutableStateMetadata(next, staged, prepared.recordHash, now);
    if (next.trajectory?.pending && next.trajectory?.pendingPacket) {
      const sealedGate = sealPendingMissionGate({ sessionDir: canonicalDir, state: next });
      if (!sealedGate.ok) {
        return failure(`cannot seal pending Mission Gate: ${sealedGate.error}`, { decision_id: decisionId });
      }
      next = sealedGate.state;
    }
    const sealedRuntime = sealMissionRuntimeState({
      sessionDir: canonicalDir,
      state: next,
      statePath: fresh.path,
      reason: `mission-decision:${action}:${phase}`,
    });
    if (!sealedRuntime.ok) {
      return failure(`cannot seal Mission runtime state: ${sealedRuntime.error}`, { decision_id: decisionId });
    }
    next = sealedRuntime.state;
    atomicWriteSync(fresh.path, JSON.stringify(next, null, 2) + "\n");

    return result({
      decided: true,
      action,
      actor,
      phase,
      decision_id: decisionId,
      event_id: prepared.recordHash,
      canonical_dir: canonicalDir,
      redirected_from_child: canonicalDir !== realpathSync(requestedDir),
      pending: next.trajectory?.pending === true,
      retry_allowance: next.trajectory?.retryAllowance || 0,
      strategy_epoch: next.mission.strategyEpoch,
      intent_id: TWO_PHASE_ACTIONS.has(action) && phase === "intent" ? prepared.recordHash : undefined,
      resume_unit: planValidation?.resumeSelection?.resumeUnit ?? resumeUnit ?? undefined,
      resume_at_final_checkpoint: planValidation?.resumeSelection?.allComplete || undefined,
      exit_and_salvage: action === "STOP_SALVAGE" ? next.trajectory?.salvageInstructions || undefined : undefined,
      manifest: staged.manifestRelativePath,
    });
  } catch (error) {
    return failure(`mission-decision failed: ${error.message}`);
  } finally {
    lock.release();
  }
}
