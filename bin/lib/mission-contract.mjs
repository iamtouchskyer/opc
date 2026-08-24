// Mission contract preparation, integrity verification, and prompt context.
// Mission support is opt-in: callers without state.mission retain legacy behavior.

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "fs";
import { createHash } from "crypto";
import { dirname, isAbsolute, join, resolve, relative, sep } from "path";
import { atomicWriteSync } from "./util.mjs";
import { runLint } from "./criteria-lint.mjs";
import { findProvenanceEvent } from "./provenance-ledger.mjs";
import { validatePendingMissionGateSeal } from "./trajectory-gate.mjs";
import {
  validateMissionRuntimeStateSeal,
} from "./mission-runtime-seal.mjs";

export { sealMissionRuntimeState } from "./mission-runtime-seal.mjs";

const MISSION_FILE = "mission-contract.json";
const CRITERIA_FILE = "acceptance-criteria.md";
const MODES = new Set(["steady", "explore", "launch", "incident", "regulated"]);
const INTEGRATED_VALIDATORS = new Set(["e2e", "acceptance", "ux-sim"]);
const PROTECTED_COMMANDS = new Set([
  "transition", "advance", "finalize", "pass", "skip", "goto",
  "complete-tick", "next-tick", "reinit-loop", "record-commit", "stop",
]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const DECISION_FILE_LABELS = new Set([
  "review", "approval", "mission", "criteria", "plan", "evidence",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashFileBytes(path) {
  return sha256(readFileSync(path));
}

function decodeUtf8(bytes, label, errors) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    errors.push(`${label} is not valid UTF-8`);
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateStringArray(value, label, errors, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.some(item => !nonEmptyString(item))) {
    errors.push(`${label} must be an array of${min > 0 ? ` at least ${min}` : ""} non-empty strings`);
    return false;
  }
  return true;
}

function validateIdentifiedStatements(value, label, idPattern, errors, { min = 1, max = Infinity } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    errors.push(`${label} must contain ${min}${Number.isFinite(max) ? `-${max}` : "+"} entries`);
    return [];
  }
  const seen = new Set();
  for (const entry of value) {
    if (!isObject(entry) || !idPattern.test(entry.id || "") || !nonEmptyString(entry.statement)) {
      errors.push(`${label} entries require a valid id and non-empty statement`);
      continue;
    }
    if (seen.has(entry.id)) errors.push(`${label} contains duplicate id '${entry.id}'`);
    seen.add(entry.id);
  }
  return value;
}

function validNullablePositiveNumber(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

export function validateMissionContract(contract) {
  const errors = [];
  if (!isObject(contract)) return { ok: false, errors: ["mission contract must be a JSON object"] };

  if (contract.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  if (!Number.isInteger(contract.version) || contract.version < 1) errors.push("version must be a positive integer");
  if (!nonEmptyString(contract.owner)) errors.push("owner must be a non-empty string");
  validateStringArray(contract.affectedParties, "affectedParties", errors, { min: 1 });
  if (!MODES.has(contract.mode)) errors.push(`mode must be one of: ${[...MODES].join(", ")}`);
  if (!nonEmptyString(contract.originalRequest)) errors.push("originalRequest must be a non-empty string");

  const outcomes = validateIdentifiedStatements(
    contract.outcomes, "outcomes", /^OUT-[1-9]\d*$/, errors, { min: 3, max: 10 },
  );
  const floors = validateIdentifiedStatements(
    contract.protectedFloors, "protectedFloors", /^FLOOR-[1-9]\d*$/, errors,
  );

  if (!isObject(contract.appetite)) {
    errors.push("appetite must be an object");
  } else {
    if (!Number.isInteger(contract.appetite.maxRepairCycles) || contract.appetite.maxRepairCycles < 1) {
      errors.push("appetite.maxRepairCycles must be a positive integer");
    }
    if (!validNullablePositiveNumber(contract.appetite.maxTokens)) {
      errors.push("appetite.maxTokens must be null or a positive number");
    }
    if (!validNullablePositiveNumber(contract.appetite.maxWallTimeHours)) {
      errors.push("appetite.maxWallTimeHours must be null or a positive number");
    }
    if (contract.appetite.expiresAt !== null &&
        (!nonEmptyString(contract.appetite.expiresAt) || Number.isNaN(Date.parse(contract.appetite.expiresAt)))) {
      errors.push("appetite.expiresAt must be null or a valid date-time string");
    }
  }

  const scenario = contract.endToEndScenario;
  if (!isObject(scenario) || !nonEmptyString(scenario.id) || !nonEmptyString(scenario.statement) ||
      !Array.isArray(scenario.validatorTypes) || scenario.validatorTypes.length === 0 ||
      scenario.validatorTypes.some(type => !INTEGRATED_VALIDATORS.has(type))) {
    errors.push("endToEndScenario requires id, statement, and validatorTypes drawn from e2e, acceptance, or ux-sim");
  }

  if (!Array.isArray(contract.realitySignals) || contract.realitySignals.length < 1) {
    errors.push("realitySignals must contain at least one entry");
  } else {
    const ids = new Set();
    for (const signal of contract.realitySignals) {
      if (!isObject(signal) || !/^SIG-[1-9]\d*$/.test(signal.id || "") ||
          typeof signal.required !== "boolean" || !nonEmptyString(signal.observation)) {
        errors.push("realitySignals entries require SIG-N id, boolean required, and non-empty observation");
        continue;
      }
      if (ids.has(signal.id)) errors.push(`realitySignals contains duplicate id '${signal.id}'`);
      ids.add(signal.id);
    }
  }

  if (!Array.isArray(contract.guardrails) || contract.guardrails.length < 1) {
    errors.push("guardrails must contain at least one entry");
  } else {
    const ids = new Set();
    for (const guardrail of contract.guardrails) {
      if (!isObject(guardrail) || !/^GUARD-[1-9]\d*$/.test(guardrail.id || "") ||
          !nonEmptyString(guardrail.metric) || !nonEmptyString(guardrail.actionThreshold)) {
        errors.push("guardrails entries require GUARD-N id, metric, and actionThreshold");
        continue;
      }
      if (ids.has(guardrail.id)) errors.push(`guardrails contains duplicate id '${guardrail.id}'`);
      ids.add(guardrail.id);
    }
  }

  if (!nonEmptyString(contract.exitAndSalvage)) errors.push("exitAndSalvage must be a non-empty string");
  if (contract.nonGoals !== undefined) validateStringArray(contract.nonGoals, "nonGoals", errors);
  if (contract.assumptions !== undefined) {
    if (!Array.isArray(contract.assumptions)) {
      errors.push("assumptions must be an array when present");
    } else {
      const ids = new Set();
      for (const assumption of contract.assumptions) {
        if (!isObject(assumption) || !/^ASM-[1-9]\d*$/.test(assumption.id || "") ||
            !nonEmptyString(assumption.statement) ||
            (assumption.freshUntil !== null &&
              (!nonEmptyString(assumption.freshUntil) || Number.isNaN(Date.parse(assumption.freshUntil))))) {
          errors.push("assumptions entries require ASM-N id, statement, and null or valid freshUntil");
          continue;
        }
        if (ids.has(assumption.id)) errors.push(`assumptions contains duplicate id '${assumption.id}'`);
        ids.add(assumption.id);
      }
    }
  }
  if (contract.checkpoints !== undefined) {
    if (!Array.isArray(contract.checkpoints)) {
      errors.push("checkpoints must be an array when present");
    } else {
      for (const checkpoint of contract.checkpoints) {
        const valid = isObject(checkpoint) &&
          ((checkpoint.type === "before_finalize" && checkpoint.id === undefined) ||
           (checkpoint.type === "loop_unit" && nonEmptyString(checkpoint.id)));
        if (!valid) errors.push("checkpoints entries must be before_finalize or a loop_unit with an id");
      }
    }
  }

  const activeIds = new Set([...outcomes, ...floors].map(entry => entry?.id).filter(Boolean));
  if (contract.retiredCriteria !== undefined) {
    if (!Array.isArray(contract.retiredCriteria)) {
      errors.push("retiredCriteria must be an array");
    } else {
      const retiredIds = new Set();
      for (const retired of contract.retiredCriteria) {
        const retiredHash = retired?.statementSha256 ?? retired?.sha256;
        if (!isObject(retired) || !/^(?:OUT|FLOOR)-[1-9]\d*$/.test(retired.id || "") || !SHA256_RE.test(retiredHash || "")) {
          errors.push("retiredCriteria entries require an OUT-N/FLOOR-N id and statementSha256");
          continue;
        }
        if (activeIds.has(retired.id)) errors.push(`retired criterion id '${retired.id}' cannot be active`);
        if (retiredIds.has(retired.id)) errors.push(`retiredCriteria contains duplicate id '${retired.id}'`);
        retiredIds.add(retired.id);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function parseAcceptanceOutcomes(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.trimEnd() === "## Outcomes");
  if (start < 0) return { ok: false, outcomes: [], errors: ["acceptance criteria has no ## Outcomes section"] };
  const sectionLines = [];
  for (let index = start + 1; index < lines.length; index++) {
    if (/^## /.test(lines[index])) break;
    sectionLines.push(lines[index]);
  }
  const outcomes = [];
  const errors = [];
  const seen = new Set();
  const linePattern = /^-\s+(OUT-[1-9]\d*): (.*)$/gm;
  let match;
  while ((match = linePattern.exec(sectionLines.join("\n"))) !== null) {
    if (seen.has(match[1])) errors.push(`acceptance criteria contains duplicate id '${match[1]}'`);
    seen.add(match[1]);
    outcomes.push({ id: match[1], statement: match[2] });
  }
  if (outcomes.length === 0) errors.push("acceptance criteria has no OUT-N outcome bullets");
  return { ok: errors.length === 0, outcomes, errors };
}

function validateOutcomeParity(contract, criteriaText) {
  const parsed = parseAcceptanceOutcomes(criteriaText);
  const errors = [...parsed.errors];
  const contractById = new Map(contract.outcomes.map(outcome => [outcome.id, outcome.statement]));
  const criteriaById = new Map(parsed.outcomes.map(outcome => [outcome.id, outcome.statement]));
  for (const [id, statement] of contractById) {
    if (!criteriaById.has(id)) errors.push(`acceptance criteria is missing '${id}'`);
    else if (criteriaById.get(id) !== statement) errors.push(`acceptance criteria statement for '${id}' does not exactly match the mission contract`);
  }
  for (const id of criteriaById.keys()) {
    if (!contractById.has(id)) errors.push(`acceptance criteria contains outcome '${id}' absent from the mission contract`);
  }
  return { ok: errors.length === 0, errors };
}

function readJsonUtf8(path, label, errors) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    errors.push(`${label} is unreadable: ${error.message}`);
    return null;
  }
  const text = decodeUtf8(bytes, label, errors);
  if (text === null) return null;
  try {
    return { bytes, text, value: JSON.parse(text) };
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function readUtf8(path, label, errors) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    errors.push(`${label} is unreadable: ${error.message}`);
    return null;
  }
  const text = decodeUtf8(bytes, label, errors);
  return text === null ? null : { bytes, text };
}

function canonicalExistingDir(path, label, errors) {
  if (!isAbsolute(path || "")) {
    errors.push(`${label} must be an absolute path`);
    return null;
  }
  try {
    return realpathSync(path);
  } catch (error) {
    errors.push(`${label} is unreadable: ${error.message}`);
    return null;
  }
}

function readSessionState(dir, errors) {
  for (const name of ["loop-state.json", "flow-state.json"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const parsed = readJsonUtf8(path, `${name} in parent session`, errors);
    if (parsed && isObject(parsed.value)) return parsed.value;
    return null;
  }
  errors.push("parent session contains no readable loop-state.json or flow-state.json");
  return null;
}

function resolvePinnedPath(canonicalDir, storedPath, fallback) {
  const raw = storedPath || fallback;
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(canonicalDir, raw);
}

function isContainedPath(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function validateDecisionManifestFiles(canonicalDir, manifestPath, manifest, errors) {
  if (!isObject(manifest?.files)) {
    errors.push("decision manifest files must be an object");
    return;
  }

  const decisionDir = dirname(manifestPath);
  let canonicalDecisionDir;
  try {
    canonicalDecisionDir = realpathSync(decisionDir);
  } catch (error) {
    errors.push(`decision staging directory is unreadable: ${error.message}`);
    return;
  }
  if (!isContainedPath(canonicalDir, canonicalDecisionDir)) {
    errors.push("decision staging directory escapes canonical session");
    return;
  }

  for (const [label, entry] of Object.entries(manifest.files)) {
    if (!DECISION_FILE_LABELS.has(label)) {
      errors.push(`decision manifest contains unsupported file label '${label}'`);
      continue;
    }
    if (!isObject(entry)) {
      errors.push(`decision manifest file '${label}' must be an object`);
      continue;
    }
    if (!nonEmptyString(entry.relativePath) || isAbsolute(entry.relativePath)) {
      errors.push(`decision manifest file '${label}' relativePath must be a relative path`);
      continue;
    }
    if (!nonEmptyString(entry.path) || !isAbsolute(entry.path)) {
      errors.push(`decision manifest file '${label}' path must be an absolute path`);
      continue;
    }
    if (!SHA256_RE.test(entry.sha256 || "")) {
      errors.push(`decision manifest file '${label}' sha256 is invalid`);
      continue;
    }

    const relativeTarget = resolve(canonicalDir, entry.relativePath);
    const absoluteTarget = resolve(entry.path);
    if (!isContainedPath(canonicalDir, relativeTarget) || !isContainedPath(canonicalDir, absoluteTarget)) {
      errors.push(`decision manifest file '${label}' escapes canonical session`);
      continue;
    }
    if (relativeTarget !== absoluteTarget) {
      errors.push(`decision manifest file '${label}' path and relativePath disagree`);
      continue;
    }
    if (!isContainedPath(decisionDir, relativeTarget)) {
      errors.push(`decision manifest file '${label}' escapes its decision staging directory`);
      continue;
    }

    let realTarget;
    try {
      realTarget = realpathSync(relativeTarget);
    } catch (error) {
      errors.push(`decision manifest file '${label}' is unreadable: ${error.message}`);
      continue;
    }
    if (!isContainedPath(canonicalDir, realTarget) || !isContainedPath(canonicalDecisionDir, realTarget)) {
      errors.push(`decision manifest file '${label}' resolves outside its decision staging directory`);
      continue;
    }
    try {
      if (!lstatSync(relativeTarget).isFile()) {
        errors.push(`decision manifest file '${label}' is not a regular staged file`);
        continue;
      }
      if (sha256(readFileSync(relativeTarget)) !== entry.sha256) {
        errors.push(`decision manifest file '${label}' hash mismatch (possible tampering)`);
      }
    } catch (error) {
      errors.push(`decision manifest file '${label}' is unreadable: ${error.message}`);
    }
  }
}

function validateDecisionCommit(canonicalDir, state, errors) {
  const mission = state?.mission || {};
  const fields = [
    mission.decisionManifestPath,
    mission.decisionManifestSha256,
    mission.decisionProvenanceRecordHash,
  ];
  if (fields.every(value => value == null)) return;
  if (fields.some(value => !nonEmptyString(value))) {
    errors.push("decision commit metadata is incomplete");
    return;
  }
  if (!SHA256_RE.test(mission.decisionManifestSha256) ||
      !SHA256_RE.test(mission.decisionProvenanceRecordHash)) {
    errors.push("decision commit hashes are invalid");
    return;
  }

  const manifestPath = resolve(canonicalDir, mission.decisionManifestPath);
  if (isAbsolute(mission.decisionManifestPath) || relative(canonicalDir, manifestPath).startsWith("..")) {
    errors.push("decision manifest path escapes canonical session");
    return;
  }
  const manifestDoc = readJsonUtf8(manifestPath, "pinned decision manifest", errors);
  if (!manifestDoc) return;
  const manifestHashMatches = sha256(manifestDoc.bytes) === mission.decisionManifestSha256;
  if (!manifestHashMatches) {
    errors.push("decision manifest hash mismatch (possible tampering)");
  }

  const provenance = findProvenanceEvent(canonicalDir, mission.decisionProvenanceRecordHash);
  if (!provenance.ok) {
    errors.push(`decision provenance is invalid: ${provenance.error}`);
    return;
  }
  const event = provenance.event;
  if (event.type !== "decision_prepared") errors.push("decision provenance event type must be decision_prepared");
  if (event.manifestPath !== mission.decisionManifestPath) errors.push("decision provenance manifest path mismatch");
  if (event.manifestSha256 !== mission.decisionManifestSha256) errors.push("decision provenance manifest hash mismatch");
  if (event.decisionId !== manifestDoc.value?.decisionId) errors.push("decision provenance decisionId mismatch");
  if (event.action !== manifestDoc.value?.action || event.actor !== manifestDoc.value?.actor) {
    errors.push("decision provenance route mismatch");
  }
  if (state.trajectory?.lastDecision?.eventId !== mission.decisionProvenanceRecordHash) {
    errors.push("active decision is not bound to its provenance record");
  }
  if (state.trajectory?.lastDecision?.action !== manifestDoc.value?.action ||
      state.trajectory?.lastDecision?.actor !== manifestDoc.value?.actor) {
    errors.push("active decision does not match its manifest");
  }
  if (state.trajectory?.pendingAction) {
    if (state.trajectory.pendingAction !== manifestDoc.value?.action ||
        state.trajectory.pendingActionActor !== manifestDoc.value?.actor) {
      errors.push("pending action does not match its committed intent manifest");
    }
    const reviewHash = manifestDoc.value?.files?.review?.sha256 || null;
    if ((state.trajectory.pendingActionReviewSha256 || null) !== reviewHash ||
        (event.reviewSha256 || null) !== reviewHash) {
      errors.push("pending action review binding does not match its committed intent");
    }
    if (state.trajectory.pendingActionEventId !== mission.decisionProvenanceRecordHash ||
        state.trajectory.pendingActionTriggerId !== manifestDoc.value?.triggerId ||
        state.trajectory.pendingActionTriggerId !== event.triggerId ||
        state.trajectory.pendingActionMissionSha256 !== manifestDoc.value?.oldMissionSha256 ||
        state.trajectory.pendingActionMissionSha256 !== event.oldMissionSha256 ||
        (state.trajectory.pendingActionPlanSha256 ?? null) !== (manifestDoc.value?.oldPlanSha256 ?? null) ||
        (state.trajectory.pendingActionPlanSha256 ?? null) !== (event.oldPlanSha256 ?? null) ||
        state.trajectory.pendingActionStrategyEpoch !== manifestDoc.value?.oldStrategyEpoch ||
        state.trajectory.pendingActionStrategyEpoch !== event.oldStrategyEpoch) {
      errors.push("pending action intent/trigger/mission/plan/epoch binding does not match its committed intent");
    }
  }
  if (manifestHashMatches) {
    validateDecisionManifestFiles(canonicalDir, manifestPath, manifestDoc.value, errors);
  }
}

function missionStateFromInputs(contract, missionHash, criteriaPath, criteriaHash, planPath, planHash, parentSession = null) {
  return {
    path: MISSION_FILE,
    parentSession,
    sha256: missionHash,
    originalRequestSha256: sha256(Buffer.from(contract.originalRequest, "utf8")),
    acceptanceCriteriaPath: criteriaPath,
    acceptanceCriteriaSha256: criteriaHash,
    planPath: planPath || null,
    planSha256: planHash,
    criterionHashes: Object.fromEntries(
      [...contract.outcomes, ...contract.protectedFloors]
        .map(entry => [entry.id, sha256(Buffer.from(entry.statement, "utf8"))]),
    ),
    // Small policy inputs needed by the pure trajectory evaluator. The copied
    // contract remains authoritative and integrity checks reject divergence.
    appetite: structuredClone(contract.appetite),
    endToEndScenario: structuredClone(contract.endToEndScenario),
    realitySignals: structuredClone(contract.realitySignals),
    version: contract.version,
    strategyEpoch: 1,
  };
}

function emptyTrajectoryState() {
  return {
    pending: false,
    triggerId: null,
    reason: null,
    pendingAction: null,
    pendingActionEventId: null,
    pendingActionActor: null,
    pendingActionReviewSha256: null,
    pendingActionReviewProvenanceRecordHash: null,
    pendingActionTriggerId: null,
    pendingActionMissionSha256: null,
    pendingActionPlanSha256: null,
    pendingActionStrategyEpoch: null,
    lastDecision: null,
    retryAllowance: 0,
    retryGrant: null,
    evidenceGateCursor: 0,
    evidenceGateReceiptIds: [],
    continuedFindingRefs: [],
    agentReshapedFindingRefs: [],
    repairEvidenceSeenIds: {},
    terminal: false,
    terminalAction: null,
    reconCount: 0,
  };
}

function missionAdditions(mission) {
  return {
    mission,
    trajectory: emptyTrajectoryState(),
    findingRegistry: [],
    evidenceReceipts: [],
    checkpointReceipts: [],
  };
}

/**
 * Validate and pin a mission before an active state file is written.
 * The copied contract preserves the exact source bytes.
 */
export function prepareMissionState({ sessionDir, missionPath, criteriaPath, planPath = null, parentSession = null }) {
  const errors = [];
  const canonicalSession = canonicalExistingDir(resolve(sessionDir), "sessionDir", errors);
  if (!canonicalSession) return { ok: false, enabled: true, errors, error: errors[0] };
  if (missionPath && parentSession) {
    return { ok: false, enabled: true, errors: ["missionPath and parentSession are mutually exclusive"], error: "missionPath and parentSession are mutually exclusive" };
  }
  if (!missionPath && !parentSession) return { ok: true, enabled: false };

  if (parentSession) {
    const canonicalParent = canonicalExistingDir(parentSession, "parentSession", errors);
    if (!canonicalParent) return { ok: false, enabled: true, errors, error: errors[0] };
    if (canonicalParent === canonicalSession) errors.push("parentSession cannot be the child session itself");
    const parentState = errors.length === 0 ? readSessionState(canonicalParent, errors) : null;
    if (parentState && !parentState.mission) errors.push("parent session is not mission-enabled");
    if (parentState?.trajectory?.pending === true) errors.push("parent session has a pending Mission Gate");
    if (errors.length > 0) return { ok: false, enabled: true, errors, error: errors[0] };

    const verified = verifyMissionIntegrity({ sessionDir: canonicalParent, state: parentState });
    if (!verified.ok) {
      return { ok: false, enabled: true, errors: verified.errors, error: verified.errors[0] };
    }
    const mission = {
      ...parentState.mission,
      parentSession: canonicalParent,
      sha256: verified.canonicalState.mission.sha256,
      originalRequestSha256: verified.canonicalState.mission.originalRequestSha256,
      acceptanceCriteriaSha256: verified.canonicalState.mission.acceptanceCriteriaSha256,
      planSha256: verified.canonicalState.mission.planSha256,
      criterionHashes: { ...verified.canonicalState.mission.criterionHashes },
      version: verified.canonicalState.mission.version,
      strategyEpoch: verified.canonicalState.mission.strategyEpoch,
    };
    return { ok: true, enabled: true, canonicalDir: canonicalParent, contract: verified.contract, ...missionAdditions(mission) };
  }

  const sourceMissionPath = resolve(missionPath);
  const sourceCriteriaPath = criteriaPath ? resolve(criteriaPath) : join(canonicalSession, CRITERIA_FILE);
  const sourcePlanPath = planPath ? resolve(planPath) : null;
  const missionDoc = readJsonUtf8(sourceMissionPath, "mission contract", errors);
  if (missionDoc) {
    const schema = validateMissionContract(missionDoc.value);
    errors.push(...schema.errors);
  }
  const criteriaDoc = readUtf8(sourceCriteriaPath, "acceptance criteria", errors);
  if (missionDoc && criteriaDoc) {
    const parity = validateOutcomeParity(missionDoc.value, criteriaDoc.text);
    errors.push(...parity.errors);
    const lint = runLint(criteriaDoc.text);
    errors.push(...lint.failures.map(failure => `criteria-lint [${failure.check}]: ${failure.message}`));
  }
  let planDoc = null;
  if (sourcePlanPath) planDoc = readUtf8(sourcePlanPath, "plan", errors);
  if (errors.length > 0) return { ok: false, enabled: true, errors, error: errors[0] };

  const targetMissionPath = join(canonicalSession, MISSION_FILE);
  try {
    if (resolve(sourceMissionPath) !== resolve(targetMissionPath)) {
      atomicWriteSync(targetMissionPath, missionDoc.bytes);
    }
  } catch (error) {
    const writeErrors = [`cannot copy validated mission contract: ${error.message}`];
    return { ok: false, enabled: true, errors: writeErrors, error: writeErrors[0] };
  }
  const missionHash = sha256(missionDoc.bytes);
  const criteriaHash = sha256(criteriaDoc.bytes);
  const planHash = planDoc ? sha256(planDoc.bytes) : null;
  const storedCriteriaPath = relative(canonicalSession, sourceCriteriaPath).startsWith("..")
    ? sourceCriteriaPath
    : relative(canonicalSession, sourceCriteriaPath) || CRITERIA_FILE;
  const storedPlanPath = sourcePlanPath
    ? (relative(canonicalSession, sourcePlanPath).startsWith("..") ? sourcePlanPath : relative(canonicalSession, sourcePlanPath))
    : null;
  const mission = missionStateFromInputs(
    missionDoc.value, missionHash, storedCriteriaPath, criteriaHash, storedPlanPath, planHash,
  );
  return { ok: true, enabled: true, canonicalDir: canonicalSession, contract: missionDoc.value, ...missionAdditions(mission) };
}

function integrityFailure(errors, canonicalDir = null) {
  return { ok: false, enabled: true, canonicalDir, contract: null, errors };
}

/** Verify live canonical mission, criteria, and plan bytes against their pins. */
export function verifyMissionIntegrity({
  sessionDir,
  state,
  statePath = null,
  allowLegacyCorruptUnsealed = false,
}) {
  const errors = [];
  const localDir = canonicalExistingDir(resolve(sessionDir), "sessionDir", errors);
  if (!localDir) return integrityFailure(errors);

  // The runtime seal is checked before trusting state.mission.  Otherwise a
  // direct edit could remove the Mission marker itself and fall through to the
  // legacy, mission-less path.
  const localRuntime = validateMissionRuntimeStateSeal({
    sessionDir: localDir,
    state,
    statePath,
    allowLegacyCorruptUnsealed,
  });
  if (!localRuntime.ok) return integrityFailure(localRuntime.errors, localDir);
  state = localRuntime.state || state;
  if (!state?.mission) {
    return { ok: true, enabled: false, canonicalDir: localDir, contract: null, errors: [], localState: state };
  }

  let canonicalDir = localDir;
  let canonicalState = state;
  if (state.mission.parentSession) {
    canonicalDir = canonicalExistingDir(state.mission.parentSession, "parentSession", errors);
    if (!canonicalDir) return integrityFailure(errors);
    canonicalState = readSessionState(canonicalDir, errors);
    if (canonicalState) {
      const canonicalRuntime = validateMissionRuntimeStateSeal({
        sessionDir: canonicalDir,
        state: canonicalState,
      });
      if (!canonicalRuntime.ok) errors.push(...canonicalRuntime.errors.map(error => `canonical parent ${error}`));
      else canonicalState = canonicalRuntime.state || canonicalState;
    }
    if (!canonicalState?.mission) errors.push("canonical parent session is not mission-enabled");
    if (canonicalState?.mission?.parentSession) errors.push("canonical parent session cannot itself delegate mission authority");
    for (const field of ["sha256", "originalRequestSha256", "acceptanceCriteriaSha256", "planSha256", "version", "strategyEpoch"]) {
      if (canonicalState?.mission?.[field] !== state.mission[field]) errors.push(`child mission pin '${field}' differs from canonical parent`);
    }
    if (JSON.stringify(canonicalState?.mission?.criterionHashes) !== JSON.stringify(state.mission.criterionHashes)) {
      errors.push("child criterion hashes differ from canonical parent");
    }
    for (const field of ["appetite", "endToEndScenario", "realitySignals"]) {
      if (JSON.stringify(canonicalState?.mission?.[field]) !== JSON.stringify(state.mission[field])) {
        errors.push(`child mission policy field '${field}' differs from canonical parent`);
      }
    }
  }
  if (errors.length > 0) return integrityFailure(errors, canonicalDir);

  const contractPath = resolvePinnedPath(canonicalDir, canonicalState.mission.path, MISSION_FILE);
  if (relative(canonicalDir, contractPath).startsWith("..")) errors.push("mission contract path escapes canonical session");
  const missionDoc = errors.length === 0 ? readJsonUtf8(contractPath, "pinned mission contract", errors) : null;
  if (missionDoc && sha256(missionDoc.bytes) !== canonicalState.mission.sha256) errors.push("mission contract hash mismatch (possible tampering)");
  if (missionDoc) {
    const schema = validateMissionContract(missionDoc.value);
    errors.push(...schema.errors.map(error => `mission schema: ${error}`));
    const requestHash = sha256(Buffer.from(missionDoc.value.originalRequest || "", "utf8"));
    if (requestHash !== canonicalState.mission.originalRequestSha256) errors.push("original request hash mismatch");
    if (missionDoc.value.version !== canonicalState.mission.version) errors.push("mission version differs from pinned state");
    const expectedCriteria = Object.fromEntries(
      [...(missionDoc.value.outcomes || []), ...(missionDoc.value.protectedFloors || [])]
        .map(entry => [entry.id, sha256(Buffer.from(entry.statement, "utf8"))]),
    );
    const expectedCriterionEntries = Object.entries(expectedCriteria).sort(([a], [b]) => a.localeCompare(b));
    const pinnedCriterionEntries = Object.entries(canonicalState.mission.criterionHashes || {}).sort(([a], [b]) => a.localeCompare(b));
    if (JSON.stringify(expectedCriterionEntries) !== JSON.stringify(pinnedCriterionEntries)) {
      errors.push("criterion hashes differ from pinned state");
    }
    for (const field of ["appetite", "endToEndScenario", "realitySignals"]) {
      if (JSON.stringify(missionDoc.value[field]) !== JSON.stringify(canonicalState.mission[field])) {
        errors.push(`mission policy field '${field}' differs from the copied contract`);
      }
    }
  }

  const criteriaPath = resolvePinnedPath(canonicalDir, canonicalState.mission.acceptanceCriteriaPath, CRITERIA_FILE);
  const criteriaDoc = readUtf8(criteriaPath, "pinned acceptance criteria", errors);
  if (criteriaDoc && sha256(criteriaDoc.bytes) !== canonicalState.mission.acceptanceCriteriaSha256) {
    errors.push("acceptance criteria hash mismatch (possible tampering)");
  }
  if (missionDoc && criteriaDoc) {
    errors.push(...validateOutcomeParity(missionDoc.value, criteriaDoc.text).errors);
  }

  if (canonicalState.mission.planSha256 !== null && canonicalState.mission.planSha256 !== undefined) {
    const planPath = resolvePinnedPath(
      canonicalDir,
      canonicalState.mission.planPath || canonicalState.plan_file,
      "plan.md",
    );
    const planDoc = readUtf8(planPath, "pinned plan", errors);
    if (planDoc && sha256(planDoc.bytes) !== canonicalState.mission.planSha256) {
      errors.push("plan hash mismatch (possible tampering)");
    }
  }

  validateDecisionCommit(canonicalDir, canonicalState, errors);
  const gateSeal = validatePendingMissionGateSeal({
    sessionDir: canonicalDir,
    state: canonicalState,
  });
  errors.push(...gateSeal.errors);

  if (errors.length > 0) return integrityFailure(errors, canonicalDir);
  return {
    ok: true,
    enabled: true,
    canonicalDir,
    canonicalState,
    localState: state,
    contract: missionDoc.value,
    errors: [],
    pending: canonicalState.trajectory?.pending === true,
  };
}

/** Shared fail-closed guard for protected state mutation. */
export function guardMissionMutation({ sessionDir, state, command, allowPending = false }) {
  const integrity = verifyMissionIntegrity({ sessionDir, state });
  if (!integrity.ok) {
    return {
      allowed: false,
      enabled: true,
      reason: integrity.errors.join("; "),
      errors: integrity.errors,
      rebet_required: state?.trajectory?.pending === true,
      canonicalDir: integrity.canonicalDir,
    };
  }
  if (!integrity.enabled) {
    return { allowed: true, enabled: false, reason: null, rebet_required: false, canonicalDir: resolve(sessionDir) };
  }
  state = integrity.localState || state;
  const canonicalTrajectory = integrity.canonicalState.trajectory || {};
  const localTrajectory = state.trajectory || {};
  const pendingChildTransition = canonicalTrajectory.pendingChildTransition || null;
  if (pendingChildTransition) {
    const origin = pendingChildTransition.origin || {};
    const child = pendingChildTransition.child || {};
    let completionError = null;
    try {
      const childDir = realpathSync(resolve(origin.childSession || ""));
      if (childDir !== origin.childSession || sha256(childDir) !== origin.childSessionSha256) {
        completionError = "child session identity mismatch";
      } else {
        const childStatePath = join(childDir, "flow-state.json");
        const stat = lstatSync(childStatePath);
        if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(dirname(childStatePath)) !== childDir) {
          completionError = "child active state is not a contained regular file";
        } else {
          const childState = JSON.parse(readFileSync(childStatePath, "utf8"));
          const sealedChild = validateMissionRuntimeStateSeal({
            sessionDir: childDir,
            state: childState,
            statePath: childStatePath,
          });
          const receipt = sealedChild.state?._parentTransitionReceipt;
          const childSeal = sealedChild.state?._missionRuntimeSeal;
          if (!sealedChild.ok) completionError = sealedChild.errors.join("; ");
          else if (receipt?.schemaVersion !== 1
              || receipt.transactionId !== pendingChildTransition.transactionId
              || receipt.parentSessionSha256 !== sha256(integrity.canonicalDir)
              || receipt.originSha256 !== sha256(JSON.stringify(origin))) {
            completionError = "child transition receipt does not match the pending transition";
          } else if (!Number.isInteger(childSeal?.generation)
              || !Number.isInteger(child.preSealGeneration)
              || childSeal.generation < child.preSealGeneration + 1) {
            completionError = "child runtime seal does not descend from the pending transition pre-state";
          }
        }
      }
    } catch (error) {
      completionError = error.message;
    }
    if (completionError) {
      return {
        allowed: false,
        enabled: true,
        reason: `A pending parent-linked child transition blocks protected mutation until exact recovery: ${completionError}`,
        rebet_required: false,
        recovery_required: true,
        canonicalDir: integrity.canonicalDir,
        protected: PROTECTED_COMMANDS.has(command),
      };
    }
  }
  const terminal = canonicalTrajectory.terminal === true || localTrajectory.terminal === true ||
    canonicalTrajectory.terminalAction === "STOP_SALVAGE" || localTrajectory.terminalAction === "STOP_SALVAGE" ||
    (canonicalTrajectory.lastDecision?.action === "STOP_SALVAGE" && new Set(["stopped", "terminated"]).has(integrity.canonicalState.status)) ||
    (localTrajectory.lastDecision?.action === "STOP_SALVAGE" && new Set(["stopped", "terminated"]).has(state.status));
  if (terminal) {
    return {
      allowed: false,
      enabled: true,
      reason: "Mission was terminated by STOP_SALVAGE; terminal mission state is absorbing",
      rebet_required: false,
      canonicalDir: integrity.canonicalDir,
      protected: PROTECTED_COMMANDS.has(command),
    };
  }
  const pending = integrity.canonicalState.trajectory?.pending === true || state.trajectory?.pending === true;
  if (pending && !allowPending) {
    return {
      allowed: false,
      enabled: true,
      reason: "A pending Mission Gate blocks protected mutation; record a mission decision, stop, or salvage first",
      rebet_required: true,
      canonicalDir: integrity.canonicalDir,
    };
  }
  return {
    allowed: true,
    enabled: true,
    reason: null,
    rebet_required: false,
    canonicalDir: integrity.canonicalDir,
    protected: PROTECTED_COMMANDS.has(command),
  };
}

/** Compact shared prompt section; the full contract stays file-backed. */
export function missionPromptContext({ sessionDir, state }) {
  const integrity = verifyMissionIntegrity({ sessionDir, state });
  if (!integrity.ok) {
    return `## Mission Context\n- integrity: INVALID\n- reason: ${integrity.errors.join("; ")}`;
  }
  if (!integrity.enabled) return "";
  const { contract, canonicalDir, canonicalState } = integrity;
  const lines = [
    "## Mission Context",
    `- contract: ${join(canonicalDir, canonicalState.mission.path || MISSION_FILE)}`,
    `- version: ${contract.version}`,
    `- strategy epoch: ${canonicalState.mission.strategyEpoch}`,
    `- owner: ${contract.owner}`,
    `- mode: ${contract.mode}`,
    `- original request: ${contract.originalRequest}`,
    "- outcomes:",
    ...contract.outcomes.map(outcome => `  - ${outcome.id}: ${outcome.statement}`),
    "- protected floors:",
    ...contract.protectedFloors.map(floor => `  - ${floor.id}: ${floor.statement}`),
    "- finding registry:",
    ...(canonicalState.findingRegistry || []).map(entry =>
      `  - ${entry.id}: ${entry.criterion} / ${entry.fingerprint} — ${entry.invariant}`
    ),
    `- end-to-end scenario: ${contract.endToEndScenario.id}: ${contract.endToEndScenario.statement}`,
  ];
  return lines.join("\n");
}
