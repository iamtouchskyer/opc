// Loop tick completion command: complete-tick
// Depends on: loop-helpers.mjs, util.mjs

import {
  readFileSync, appendFileSync, existsSync, lstatSync, realpathSync,
  statSync, writeFileSync, mkdirSync,
} from "fs";
import { join, dirname, isAbsolute, relative, resolve, sep } from "path";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import {
  parsePlan,
  hashContent,
  getGitHeadHash,
  checkScopeCoverage,
  revalidateMissionEvidenceReceipts,
} from "./loop-helpers.mjs";
import { getFlag, resolveDir, atomicWriteSync, WRITER_SIG, TERMINAL_LOOP_STATUSES } from "./util.mjs";
import { lockFile } from "./file-lock.mjs";
import { resolveCallerIdentity, checkOwnership, makeOwner, ownershipEnforcementWarning } from "./driver-owner.mjs";
import {
  checkEvalDistinctness,
  parseEvaluation,
  validateReviewClaimDispositions,
} from "./eval-parser.mjs";
import {
  guardMissionMutation,
  missionPromptContext,
  sealMissionRuntimeState,
  verifyMissionIntegrity,
} from "./mission-contract.mjs";
import {
  commitTrajectoryObservation,
  evaluateTrajectory,
  openMissionGate,
  registerFindingBatch,
  sealPendingMissionGate,
} from "./trajectory-gate.mjs";

function _missionStatePath(dir) {
  const loopPath = join(dir, "loop-state.json");
  return existsSync(loopPath) ? loopPath : join(dir, "flow-state.json");
}

function _openReviewQualityMissionGate({ dir, statePath, state, integrity, trigger }) {
  const canonicalDir = integrity.canonicalDir;
  const canonicalStatePath = _missionStatePath(canonicalDir);
  let parentLock = null;
  if (canonicalDir !== dir) {
    parentLock = lockFile(canonicalStatePath, { command: "complete-tick-mission-parent" });
    if (!parentLock.acquired) {
      return {
        ok: false,
        reason: "could not acquire canonical parent Mission state lock",
        holder: parentLock.holder,
      };
    }
  }
  try {
    const currentPath = canonicalDir === dir ? statePath : canonicalStatePath;
    const fresh = JSON.parse(readFileSync(currentPath, "utf8"));
    if (canonicalDir !== dir && fresh._last_modified !== integrity.canonicalState._last_modified) {
      return { ok: false, reason: "canonical Mission state changed while opening the gate; retry" };
    }
    const opened = openMissionGate({
      sessionDir: null,
      state: canonicalDir === dir ? state : integrity.canonicalState,
      missionContract: integrity.contract,
      trigger: {
        ...trigger,
        origin: {
          command: "next-tick",
          sessionSha256: hashContent(resolve(dir)),
          fromNode: null,
          nextUnit: state.next_unit ?? null,
          edgeKey: trigger?.edgeKey || null,
        },
      },
    });
    const sealed = sealPendingMissionGate({ sessionDir: canonicalDir, state: opened.state });
    if (!sealed.ok) return { ok: false, reason: `cannot seal Mission Gate: ${sealed.error}` };
    sealed.state._written_by = WRITER_SIG;
    sealed.state._last_modified = new Date().toISOString();
    const canonicalRuntimeSeal = sealMissionRuntimeState({
      sessionDir: canonicalDir,
      state: sealed.state,
      statePath: currentPath,
      reason: "complete-tick-review-quality-gate",
    });
    if (!canonicalRuntimeSeal.ok) return { ok: false, reason: canonicalRuntimeSeal.error };
    atomicWriteSync(currentPath, JSON.stringify(canonicalRuntimeSeal.state, null, 2) + "\n");
    if (canonicalDir !== dir) {
      state._written_by = WRITER_SIG;
      state._last_modified = new Date().toISOString();
      const localRuntimeSeal = sealMissionRuntimeState({
        sessionDir: dir,
        state,
        statePath,
        reason: "complete-tick-review-quality-local",
      });
      if (!localRuntimeSeal.ok) return { ok: false, reason: localRuntimeSeal.error };
      state = localRuntimeSeal.state;
      atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");
    }
    return { ok: true, packet: opened.packet };
  } finally {
    parentLock?.release();
  }
}

// ─── complete-tick ──────────────────────────────────────────────

export function cmdCompleteTick(args) {
  const dir = resolveDir(args);
  const unit = getFlag(args, "unit");
  const artifactsRaw = getFlag(args, "artifacts", "");
  const description = getFlag(args, "description", "");
  const status = getFlag(args, "status", "completed");
  const delta = getFlag(args, "delta", "");
  const scenarioId = getFlag(args, "scenario", null);
  const requestedValidatorType = getFlag(args, "validator-type", null);
  const satisfies = [...new Set(
    String(getFlag(args, "satisfies", "") || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean),
  )];

  const VALID_TICK_STATUSES = new Set(["completed", "blocked", "failed"]);

  if (!unit) {
    console.error("Usage: opc-harness complete-tick --unit <id> --artifacts <comma-sep> --description <text> --dir <path>");
    process.exit(1);
  }

  if (!VALID_TICK_STATUSES.has(status)) {
    console.log(JSON.stringify({ completed: false, errors: [`invalid status '${status}' — must be one of: ${[...VALID_TICK_STATUSES].join(", ")}`] }));
    return;
  }

  if (status === "blocked" && (!description || description.trim().length === 0)) {
    console.log(JSON.stringify({ completed: false, errors: ["blocked status requires --description explaining the blocker"] }));
    return;
  }

  const statePath = join(dir, "loop-state.json");
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ completed: false, errors: ["loop-state.json not found"] }));
    return;
  }

  const lock = lockFile(statePath, { command: "complete-tick" });
  if (!lock.acquired) {
    console.log(JSON.stringify({ completed: false, errors: ["could not acquire lock on loop-state.json", lock.holder ? `held by: ${lock.holder.command || lock.holder.pid}` : ""].filter(Boolean) }));
    return;
  }
  try {

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ completed: false, errors: [`corrupt loop-state.json: ${err.message}`] }));
    return;
  }
  const errors = [];
  const warnings = [];

  const missionGuard = guardMissionMutation({ sessionDir: dir, state, command: "complete-tick" });
  if (!missionGuard.allowed) {
    console.log(JSON.stringify({
      completed: false,
      errors: [missionGuard.reason],
      rebet_required: missionGuard.rebet_required,
      missionIntegrityErrors: missionGuard.errors,
    }));
    return;
  }
  let missionIntegrity = null;
  if (state.mission) {
    missionIntegrity = verifyMissionIntegrity({ sessionDir: dir, state });
    if (!missionIntegrity.ok) {
      console.log(JSON.stringify({ completed: false, errors: missionIntegrity.errors }));
      return;
    }
  }

  // ── Session-ownership gate ───────────────────────────────────
  // The compaction double-drive bug slips in here: a resumed agent that jumps
  // straight to complete-tick bypasses next-tick's in_progress guard. Refuse
  // when a different, still-live Claude session owns the loop.
  const caller = resolveCallerIdentity();
  const foWarn = ownershipEnforcementWarning(caller);
  if (foWarn) warnings.push(foWarn);
  const ownership = checkOwnership(state, caller, { force: args.includes("--force-takeover") });
  if (ownership.decision === "BLOCKED") {
    console.log(JSON.stringify({
      completed: false,
      errors: [`not the loop owner — ${ownership.reason}`],
      owner_conflict: true,
      hint: "this loop is being driven by another Claude session. If that session is gone, re-run with --force-takeover to reclaim.",
    }));
    return;
  }
  if (ownership.decision === "TAKEOVER") {
    state._owner = makeOwner(caller, state._owner && state._owner.token);
    warnings.push(`reclaimed loop ownership — ${ownership.reason}`);
  }

  if (state.mission && state.trajectory?.retryGrant) {
    console.log(JSON.stringify({
      completed: false,
      errors: ["sealed Mission retry must be claimed by next-tick before complete-tick"],
      rebet_required: false,
    }));
    return;
  }

  // Rule 7: terminated pipeline
  if (TERMINAL_LOOP_STATUSES.has(state.status)) {
    console.log(JSON.stringify({
      completed: false,
      errors: [`loop is '${state.status}' — cannot complete ticks on a terminated pipeline`],
      status: "terminal",
      reason: `pipeline is in terminal status '${state.status}'`,
      detail: `The loop entered '${state.status}' state and cannot accept new tick completions. This is a permanent state.`,
      hint: "re-initialize the loop with init-loop to start a fresh pipeline, or use reinit-loop to decompose stalled units",
    }));
    return;
  }

  // Tamper: writer signature + nonce
  if (state._written_by !== WRITER_SIG || !state._write_nonce) {
    errors.push("state was not written by opc-harness — possible direct edit detected");
  }

  // Tamper: plan hash
  const planFile = state.plan_file || join(dir, "plan.md");
  if (state._plan_hash && existsSync(planFile)) {
    const currentPlanHash = hashContent(readFileSync(planFile, "utf8"));
    if (currentPlanHash !== state._plan_hash) {
      errors.push(`plan.md was modified after init-loop (hash ${state._plan_hash} \u2192 ${currentPlanHash}) — re-run init-loop`);
    }
  }

  // Unit sequence
  if (state.next_unit !== unit) {
    errors.push(`expected unit '${state.next_unit}', got '${unit}'`);
  }

  // Determine unit type
  let unitType = "unknown";
  let unitSpec = null;
  let allUnits = [];
  if (existsSync(planFile)) {
    allUnits = parsePlan(readFileSync(planFile, "utf8"));
    const found = allUnits.find(u => u.id === unit);
    if (found) {
      unitSpec = found;
      unitType = found.type;
    }
  }

  const artifacts = artifactsRaw ? artifactsRaw.split(",").map(a => a.trim()).filter(Boolean) : [];

  let reviewVerdict = undefined;
  let reviewFindings = [];
  let reviewQualityOk = true;
  let reviewClaims = [];
  let reviewEvalFiles = [];
  let reviewClaimDisposition = { ok: true, required: false, errors: [], dispositions: [], path: null };
  let integratedEvidence = null;
  const integratedUnit = unitType.startsWith("e2e") || unitType.startsWith("accept") || unitType.startsWith("ux-sim");
  const integratedClaimRequested = Boolean(state.mission && scenarioId && integratedUnit);
  const effectiveValidatorType = requestedValidatorType ||
    (unitType.startsWith("e2e") ? "e2e" : unitType.startsWith("accept") ? "acceptance" : "ux-sim");

  if (status === "completed") {
    // ── Rule 2+3+6: Evidence validation per unit type ──
    if (unitType.startsWith("implement") || unitType.startsWith("build")) {
      validateImplementArtifacts(unit, unitType, artifacts, errors, warnings, state, dir);
    } else if (unitType.startsWith("review")) {
      const reviewResult = validateReviewArtifacts(unit, artifacts, errors, warnings, state, dir);
      reviewVerdict = reviewResult?.verdict;
      reviewFindings = reviewResult?.findings || [];
      reviewQualityOk = reviewResult?.reviewQualityOk !== false;
      reviewClaims = reviewResult?.reviewClaims || [];
      reviewEvalFiles = reviewResult?.evalFiles || [];
    } else if (unitType.startsWith("fix")) {
      validateFixArtifacts(unit, artifacts, errors, warnings, state, dir);
    } else if (integratedUnit) {
      integratedEvidence = validateIntegratedArtifacts(unit, unitType, artifacts, errors, {
        requireContainedEvidence: integratedClaimRequested,
        allowHarnessOnly: integratedClaimRequested,
        state,
        sessionDir: dir,
      });
    }
  }

  // Mission integrated evidence is a harness execution of the verify command
  // pinned by the immutable plan hash. Caller-authored result JSON is only a
  // supplemental artifact and can never establish PASS.
  if (state.mission && status === "completed" && integratedUnit) {
    if (satisfies.length > 0 && !scenarioId) {
      errors.push("--satisfies requires --scenario so criterion claims are backed by integrated evidence");
    }
    if (scenarioId) {
      if (scenarioId !== state.mission.endToEndScenario?.id) {
        errors.push(`scenario '${scenarioId}' does not match mission scenario '${state.mission.endToEndScenario?.id}'`);
      }
      const allowedTypes = new Set(state.mission.endToEndScenario?.validatorTypes || []);
      if (!allowedTypes.has(effectiveValidatorType)) {
        errors.push(`validator type '${effectiveValidatorType}' is not allowed by the mission end-to-end scenario`);
      }
      if (!unitSpec?.scenario || unitSpec.scenario !== scenarioId) {
        errors.push(`--scenario must exactly match plan unit '${unit}' frozen scenario: mapping (${unitSpec?.scenario || "missing"})`);
      }
      if (!unitSpec?.validatorType || unitSpec.validatorType !== effectiveValidatorType) {
        errors.push(`--validator-type must exactly match plan unit '${unit}' frozen validator-type: mapping (${unitSpec?.validatorType || "missing"})`);
      }
      const unknownCriteria = satisfies.filter(id => !Object.hasOwn(state.mission.criterionHashes || {}, id));
      if (unknownCriteria.length > 0) errors.push(`--satisfies contains unknown criteria: ${unknownCriteria.join(", ")}`);
      if (unitSpec?.satisfiesError) {
        errors.push(`plan unit '${unit}' has an invalid frozen satisfies: mapping: ${unitSpec.satisfiesError}`);
      } else if (!Array.isArray(unitSpec?.satisfies) || unitSpec.satisfies.length === 0) {
        errors.push(`plan unit '${unit}' must declare a frozen satisfies: mapping before integrated execution`);
      } else {
        const frozen = [...unitSpec.satisfies].sort();
        const claimed = [...satisfies].sort();
        if (JSON.stringify(frozen) !== JSON.stringify(claimed)) {
          errors.push(
            `--satisfies must exactly match plan unit '${unit}' frozen mapping (${unitSpec.satisfies.join(",")})`,
          );
        }
      }
      if (!unitSpec?.verify) {
        errors.push(`plan unit '${unit}' must declare a verify: command for harness-owned integrated evidence`);
      }

      if (errors.length === 0) {
        const testResult = _runTestScript(
          unitSpec.verify,
          dir,
          state.tick || 0,
          state.projectDir,
          `integrated-${unit.replace(/[^a-z0-9_-]/gi, "-")}`,
        );
        if (testResult.exitCode !== 0) {
          const reason = testResult.timedOut ? "TIMED OUT (120s)" : `exit ${testResult.exitCode}`;
          errors.push(`verify command '${unitSpec.verify}' failed (${reason}) — integrated Mission evidence cannot PASS. Log: ${testResult.logPath}`);
        } else if (!testResult.nonVacuous) {
          errors.push(
            `verify command '${unitSpec.verify}' exited 0 without a non-vacuous OPC_ORACLE result — integrated Mission evidence cannot PASS. Log: ${testResult.logPath}`,
          );
        } else {
          const canonicalLog = realpathSync(testResult.logPath);
          const hash = `sha256:${createHash("sha256").update(readFileSync(canonicalLog)).digest("hex")}`;
          integratedEvidence ||= { artifacts: [], artifactHashes: [], artifactBindings: [] };
          integratedEvidence.artifacts.push(canonicalLog);
          integratedEvidence.artifactHashes.push(hash);
          integratedEvidence.artifactBindings ||= [];
          integratedEvidence.artifactBindings.push({
            path: canonicalLog,
            sha256: hash,
            type: "test-result",
            proof: "opc-loop-verify",
            commandSha256: createHash("sha256").update(unitSpec.verify).digest("hex"),
          });
        }
      }
    }
  }

  if (state.mission && unitType.startsWith("review")) {
    state.trajectory ||= {};
    const qualityScope = `${state.mission.strategyEpoch ?? "unknown"}:${unit}`;
    const priorClaims = state.trajectory.reviewQualityScope === qualityScope
      && Array.isArray(state.trajectory.reviewQualityClaims)
      ? state.trajectory.reviewQualityClaims
      : [];
    if (priorClaims.length > 0 && reviewQualityOk && errors.length === 0) {
      reviewClaimDisposition = _reviewClaimDispositionStatus({
        sessionDir: dir,
        evalFiles: reviewEvalFiles,
        priorClaims,
        parsedFindings: reviewFindings,
        state,
      });
      if (!reviewClaimDisposition.ok) {
        reviewQualityOk = false;
        reviewClaims = priorClaims;
        errors.push(...reviewClaimDisposition.errors);
      }
    } else if (priorClaims.length > 0 && !reviewQualityOk) {
      reviewClaimDisposition = {
        ok: false,
        required: true,
        errors: ["fresh reevaluation is invalid before prior claims can be dispositioned"],
        dispositions: [],
        path: null,
      };
    }
    state.trajectory.reviewQualityDisposition = {
      scope: qualityScope,
      required: reviewClaimDisposition.required,
      ok: reviewClaimDisposition.ok,
      path: reviewClaimDisposition.path,
      errors: reviewClaimDisposition.errors,
      dispositionedClaimHashes: reviewClaimDisposition.dispositions
        .map(item => item?.claimHash || item?.claim_hash)
        .filter(Boolean),
    };
    if (reviewClaimDisposition.path) {
      state.declaredArtifacts = [...new Set([
        ...(state.declaredArtifacts || []),
        reviewClaimDisposition.path,
      ])];
    }
  }

  if (state.mission && unitType.startsWith("review") && !reviewQualityOk) {
    state.trajectory ||= {};
    const qualityScope = `${state.mission.strategyEpoch ?? "unknown"}:${unit}`;
    if (state.trajectory.reviewQualityScope !== qualityScope) {
      state.trajectory.reviewQualityScope = qualityScope;
      state.trajectory.reviewQualityFailures = 0;
      state.trajectory.reviewQualityClaimHashes = [];
      state.trajectory.reviewQualityClaimArtifacts = [];
      state.trajectory.reviewQualityClaims = [];
    }
    state.trajectory.reviewQualityFailures = (state.trajectory.reviewQualityFailures || 0) + 1;
    const claimAttempt = state.trajectory.reviewQualityFailures;
    const claimsPath = join(dir, `review-claims-tick-${(state.tick || 0) + 1}-attempt-${claimAttempt}.json`);
    const priorClaimHashes = [...new Set(state.trajectory.reviewQualityClaimHashes || [])];
    atomicWriteSync(claimsPath, JSON.stringify({
      schemaVersion: 1,
      routing: false,
      unit,
      strategyEpoch: state.mission.strategyEpoch,
      attempt: claimAttempt,
      priorClaimHashes,
      claims: reviewClaims,
      claimDisposition: state.trajectory.reviewQualityDisposition,
    }, null, 2) + "\n");
    state.trajectory.reviewQualityClaimHashes = [...new Set([
      ...priorClaimHashes,
      ...reviewClaims.map(claim => claim.claim_hash).filter(Boolean),
    ])];
    const claimsByHash = new Map(
      (state.trajectory.reviewQualityClaims || []).map(claim => [claim.claim_hash, claim]),
    );
    for (const claim of reviewClaims) {
      if (claim?.claim_hash) claimsByHash.set(claim.claim_hash, claim);
    }
    state.trajectory.reviewQualityClaims = [...claimsByHash.values()];
    state.trajectory.reviewQualityClaimArtifacts = [
      ...(state.trajectory.reviewQualityClaimArtifacts || []),
      claimsPath,
    ];
    state.declaredArtifacts = [...new Set([...(state.declaredArtifacts || []), claimsPath])];
    state._written_by = WRITER_SIG;
    state._last_modified = new Date().toISOString();
    if (state.trajectory.reviewQualityFailures >= 2) {
      const opened = _openReviewQualityMissionGate({
        dir,
        statePath,
        state,
        integrity: missionIntegrity,
        trigger: {
          action: "OPEN_MISSION_GATE",
          reason: "REVIEW_QUALITY_STALL",
          retryable: false,
          findingRefs: [],
        },
      });
      if (!opened.ok) {
        console.log(JSON.stringify({
          completed: false,
          errors: [...errors, opened.reason],
          review_quality_ok: false,
          reevaluate_required: false,
          rebet_required: false,
          claims: claimsPath,
          holder: opened.holder,
        }));
        return;
      }
      console.log(JSON.stringify({
        completed: false,
        errors,
        review_quality_ok: false,
        reevaluate_required: false,
        rebet_required: true,
        triggerId: opened.packet.triggerId,
        reason: "REVIEW_QUALITY_STALL",
        claims: claimsPath,
        claim_disposition: state.trajectory.reviewQualityDisposition,
      }));
      return;
    }
    const runtimeSealed = sealMissionRuntimeState({
      sessionDir: dir,
      state,
      statePath,
      reason: "complete-tick-review-quality-failure",
    });
    if (!runtimeSealed.ok) {
      console.log(JSON.stringify({ completed: false, errors: [...errors, runtimeSealed.error] }));
      return;
    }
    state = runtimeSealed.state;
    atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");
    console.log(JSON.stringify({
      completed: false,
      errors,
      review_quality_ok: false,
      reevaluate_required: true,
      rebet_required: false,
      claims: claimsPath,
      claim_disposition: state.trajectory.reviewQualityDisposition,
    }));
    return;
  }

  if (errors.length > 0) {
    console.log(JSON.stringify({ completed: false, errors, warnings: warnings.length > 0 ? warnings : undefined }));
    return;
  }

  // Reset the consecutive-invalid counter only after a structurally valid
  // review batch has passed every other artifact check. An unrelated malformed
  // batch must not provide an infinite way to clear the one-reevaluation bound.
  if (state.mission && unitType.startsWith("review") && reviewQualityOk) {
    state.trajectory ||= {};
    state.trajectory.reviewQualityScope = `${state.mission.strategyEpoch ?? "unknown"}:${unit}`;
    state.trajectory.reviewQualityFailures = 0;
    state.trajectory.reviewQualityClaimHashes = [];
    state.trajectory.reviewQualityClaimArtifacts = [];
    state.trajectory.reviewQualityClaims = [];
  }

  if (state.mission && unitType.startsWith("review") && reviewVerdict && reviewVerdict !== "PASS") {
    // Re-hash prior integrated PASS evidence immediately before the trajectory
    // decision. Mutating a prior result cannot masquerade as progress on this
    // repair edge.
    state = revalidateMissionEvidenceReceipts(state).state;
    const registered = registerFindingBatch({
      registry: state.findingRegistry || [],
      findings: reviewFindings,
      criterionHashes: state.mission.criterionHashes || {},
    });
    if (!registered.ok) {
      console.log(JSON.stringify({
        completed: false,
        errors: registered.errors.map(error => `review finding registry: ${error}`),
        review_quality_ok: false,
        reevaluate_required: true,
      }));
      return;
    }
    state.findingRegistry = registered.registry;
    const uniqueRoutingFindings = [];
    const seenGateKeys = new Set();
    for (const finding of registered.findings) {
      const unlinkedFloorRisk = _isEvidencedUnlinkedGoalSpecRisk(finding);
      if ((!finding.routing_eligible && !unlinkedFloorRisk) ||
          (finding.criterion === "UNLINKED" && !unlinkedFloorRisk) ||
          seenGateKeys.has(finding.gateKey)) continue;
      seenGateKeys.add(finding.gateKey);
      uniqueRoutingFindings.push(finding);
    }
    const currentPlanIndex = allUnits.findIndex(candidate => candidate.id === unit);
    const nextPlanUnit = currentPlanIndex >= 0 ? allUnits[currentPlanIndex + 1] : null;
    const isRepairEdge = Boolean(nextPlanUnit?.type?.startsWith("fix"));
    // Bind all review→fix pairs to one semantic edge. Unit IDs and reviewer
    // fingerprints may vary, but a second repair attempt without new integrated
    // evidence is still the same local-search trajectory.
    const repairEdgeKey = isRepairEdge ? "review→fix" : null;
    const decision = evaluateTrajectory({
      state,
      findings: uniqueRoutingFindings,
      verdict: reviewVerdict,
      edgeKey: repairEdgeKey,
      isRepairEdge,
    });
    state = commitTrajectoryObservation({
      state,
      findings: uniqueRoutingFindings,
      verdict: reviewVerdict,
      edgeKey: repairEdgeKey,
      isRepairEdge,
      chargeRepairCycle: !isRepairEdge,
      recordFindingFailures: true,
      consumeRetry: decision.authorizedRetry === true && (state.trajectory?.retryAllowance || 0) > 0,
    });
    if (isRepairEdge) {
      decision.edgeKey = repairEdgeKey;
      decision.observedRepairEdgeFailures = state.trajectory?.repairEdgeFailures?.[repairEdgeKey] || 0;
    }
    state.trajectory ||= {};
    state.trajectory.pendingDecision = decision;
    reviewFindings = registered.findings;
  }

  let evidenceReceipt = null;
  if (state.mission && status === "completed" &&
      (unitType.startsWith("e2e") || unitType.startsWith("accept") || unitType.startsWith("ux-sim"))) {
    const validatorType = effectiveValidatorType;
    const allowedTypes = new Set(state.mission.endToEndScenario?.validatorTypes || []);
    if (scenarioId && scenarioId !== state.mission.endToEndScenario?.id) {
      console.log(JSON.stringify({
        completed: false,
        errors: [`scenario '${scenarioId}' does not match mission scenario '${state.mission.endToEndScenario?.id}'`],
      }));
      return;
    }
    if (scenarioId && !allowedTypes.has(validatorType)) {
      console.log(JSON.stringify({
        completed: false,
        errors: [`validator type '${validatorType}' is not allowed by the mission end-to-end scenario`],
      }));
      return;
    }
    const unknownCriteria = satisfies.filter(id => !Object.hasOwn(state.mission.criterionHashes || {}, id));
    if (unknownCriteria.length > 0) {
      console.log(JSON.stringify({
        completed: false,
        errors: [`--satisfies contains unknown criteria: ${unknownCriteria.join(", ")}`],
      }));
      return;
    }
    if (satisfies.length > 0 && !scenarioId) {
      console.log(JSON.stringify({
        completed: false,
        errors: ["--satisfies requires --scenario so criterion claims are backed by integrated evidence"],
      }));
      return;
    }
    const currentReceipts = Array.isArray(state.evidenceReceipts) ? state.evidenceReceipts : [];
    const nextReceiptNumber = currentReceipts.reduce((max, receipt) => {
      const match = String(receipt?.id || "").match(/^EV-(\d+)$/);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    evidenceReceipt = {
      id: `EV-${nextReceiptNumber}`,
      sliceId: unit,
      scenarioId: scenarioId || null,
      scope: scenarioId ? "integrated" : "local",
      validatorType,
      validator: unit,
      result: "PASS",
      satisfies,
      artifactHashes: [],
      artifactBindings: [],
      strategyEpoch: state.mission.strategyEpoch,
      observedAt: new Date().toISOString(),
    };
    const receiptArtifacts = integratedEvidence?.artifacts || artifacts;
    const receiptHashes = integratedEvidence?.artifactHashes || receiptArtifacts.map(path =>
      `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`
    );
    evidenceReceipt.artifactHashes = receiptHashes;
    evidenceReceipt.artifactBindings = integratedEvidence?.artifactBindings || receiptArtifacts.map((path, index) => ({
      path: realpathSync(path),
      sha256: receiptHashes[index],
      type: "artifact",
      proof: null,
    }));
    state.evidenceReceipts = [...currentReceipts, evidenceReceipt];
  }

  // ── Rule 13: Backlog auto-accumulation from review findings ──
  if (unitType.startsWith("review") && reviewVerdict && reviewVerdict !== "PASS") {
    if (state.mission) _accumulateMissionFindings(dir, unit, reviewFindings, warnings);
    else _accumulateBacklog(dir, unit, artifacts, warnings);
  }

  // Only advance to next unit on successful completion
  let nextUnit = null;
  if (status === "completed") {
    const currentIdx = allUnits.findIndex(u => u.id === unit);
    nextUnit = currentIdx >= 0 && currentIdx < allUnits.length - 1
      ? allUnits[currentIdx + 1].id
      : null;
  } else {
    nextUnit = unit;
  }

  // ── Summary lint: reject deferral language on final tick ──
  if (nextUnit === null && description) {
    const DEFERRAL_NEGATION = /\b(not?\s+defer|no\s+deferral|nothing\s+defer|without\s+defer|zero\s+defer|isn't\s+defer)/i;
    const DEFERRAL_PATTERNS = /\b(defer(?:red)?|next\s+loop|future\s+work|follow[\s-]?up\s+loop|punt(?:ed)?|later\s+loop|TODO\s*:?\s*next)\b/i;
    if (DEFERRAL_PATTERNS.test(description) && !DEFERRAL_NEGATION.test(description)) {
      errors.push(
        `final tick description contains deferral language ("${description.match(DEFERRAL_PATTERNS)[0]}") — the loop must finish what it starts. Rewrite without deferral or explain specifically what remains and why.`
      );
    }
  }

  // ── Scope coverage check on final tick ──
  const skipScopeCheck = args.includes("--skip-scope-check");
  if (nextUnit === null && state._task_scope && state._task_scope.length > 0 && !skipScopeCheck) {
    const tickHistory = [...(state._tick_history || []), { unit, tick: (state.tick || 0) + 1, status, verdict: reviewVerdict, description: description || undefined }];
    const uncovered = checkScopeCoverage(state._task_scope, tickHistory, allUnits);
    if (uncovered.length > 0) {
      errors.push(
        `pipeline cannot complete — ${uncovered.length} scope item(s) not covered by any completed unit: ${uncovered.map(s => s.id).join(", ")}. ` +
        `Uncovered: ${uncovered.map(s => `${s.id}: ${s.text}`).join("; ")}. ` +
        `Use --skip-scope-check to bypass.`
      );
    }
  }

  // Check for errors accumulated by summary lint
  if (errors.length > 0) {
    console.log(JSON.stringify({ completed: false, errors, warnings: warnings.length > 0 ? warnings : undefined }));
    return;
  }

  // Update state
  const newTick = (state.tick || 0) + 1;
  state.tick = newTick;
  state.unit = unit;
  state.description = description || `Completed unit ${unit} (${unitType})`;
  state.status = status;
  if (state.mission) {
    const currentArtifacts = integratedEvidence?.artifacts || artifacts;
    state.currentArtifacts = currentArtifacts;
    // Mission final binding needs all declared evidence/deliverable paths, not
    // only whichever tick happened to finish last.
    state.artifacts = [...new Set([...(state.artifacts || []), ...currentArtifacts])];
  } else {
    state.artifacts = artifacts;
  }
  state.next_unit = nextUnit;
  state.review_of_previous = "";
  state._written_by = WRITER_SIG;
  state._last_modified = new Date().toISOString();
  state._git_head = getGitHeadHash(state.projectDir);

  if (!Array.isArray(state._tick_history)) state._tick_history = [];
  state._tick_history.push({
    unit,
    tick: newTick,
    status,
    verdict: reviewVerdict,
    description: description || undefined,
    delta: delta || undefined,
    strategyEpoch: state.mission?.strategyEpoch,
    findings: reviewFindings.length > 0
      ? reviewFindings.map(finding => ({
        class: finding.class,
        criterion: finding.criterion,
        findingRef: finding.finding_ref,
        fingerprint: finding.fingerprint,
        gateKey: finding.gateKey,
      }))
      : undefined,
    evidenceReceiptId: evidenceReceipt?.id,
    satisfies: evidenceReceipt?.satisfies?.length > 0 ? evidenceReceipt.satisfies : undefined,
    artifacts: integratedEvidence?.artifacts || artifacts,
  });

  if (state.mission) {
    const runtimeSealed = sealMissionRuntimeState({
      sessionDir: dir,
      state,
      statePath,
      reason: "complete-tick",
    });
    if (!runtimeSealed.ok) {
      console.log(JSON.stringify({ completed: false, errors: [runtimeSealed.error] }));
      return;
    }
    state = runtimeSealed.state;
  }
  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

  // Rule 14: append to progress.md
  const progressPath = join(dir, "progress.md");
  const progressLine = `- **Tick ${newTick}** [${unit}] (${unitType}): ${description || status} \u2014 ${new Date().toISOString()}\n`;
  try {
    appendFileSync(progressPath, progressLine);
  } catch {
    warnings.push("failed to append to progress.md");
  }

  // ── Checkpoint: tick-N-summary.md ──
  _writeCheckpoint(dir, {
    tick: newTick,
    unit,
    unitType,
    status,
    description: description || `Completed unit ${unit} (${unitType})`,
    verdict: reviewVerdict,
    artifacts,
    nextUnit,
    planFile,
    allUnits,
    state,
    delta,
  }, warnings);

  const finalReviewPending = Boolean(state.mission && status === "completed" && nextUnit === null);
  console.log(JSON.stringify({
    completed: true,
    tick: newTick,
    unit,
    unitType,
    next_unit: nextUnit,
    terminate: nextUnit === null && !finalReviewPending,
    final_review_pending: finalReviewPending || undefined,
    verdict: reviewVerdict,
    evidence_receipt: evidenceReceipt,
    warnings: warnings.length > 0 ? warnings : undefined,
  }));

  } finally {
    lock.release();
  }
}

// ── Validation helpers ──────────────────────────────────────────

const MAX_ARTIFACT_SIZE = 10 * 1024 * 1024; // 10 MB

function _runTestScript(cmd, loopDir, tick, projectDir, label = "test") {
  const evidenceDir = join(loopDir, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = join(evidenceDir, `tick-${tick + 1}-${label}.log`);

  // Resolve project root: use explicit projectDir, or walk up from loopDir
  let projectRoot = projectDir || loopDir;
  if (!projectDir) {
    let d = loopDir;
    while (d !== dirname(d)) {
      if (existsSync(join(d, "package.json")) || existsSync(join(d, ".git"))) {
        projectRoot = d;
        break;
      }
      d = dirname(d);
    }
  }

  let stdout = "", stderr = "", exitCode = 0, timedOut = false;
  try {
    stdout = execFileSync("sh", ["-c", cmd], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    });
  } catch (err) {
    if (err.killed || err.signal === "SIGTERM") {
      timedOut = true;
      exitCode = 124; // conventional timeout exit code (like GNU timeout)
    } else {
      exitCode = err.status || 1;
    }
    stdout = err.stdout || "";
    stderr = err.stderr || "";
  }

  let nonVacuous = false;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const marker = line.match(/^OPC_ORACLE\s+(.+)$/);
    if (!marker) continue;
    try {
      const oracle = JSON.parse(marker[1]);
      const checks = Array.isArray(oracle?.checks) ? oracle.checks : [];
      nonVacuous = checks.length > 0 && checks.every(check =>
        check?.pass === true && Number.isFinite(Number(check.total)) && Number(check.total) > 0
      );
    } catch { /* malformed oracle remains vacuous */ }
  }
  if (!nonVacuous) {
    const tapTests = String(stdout || "").match(/^# tests\s+(\d+)\s*$/m);
    const tapFailures = String(stdout || "").match(/^# fail\s+(\d+)\s*$/m);
    nonVacuous = Number(tapTests?.[1] || 0) > 0 && Number(tapFailures?.[1] || 0) === 0;
  }

  const log = [
    `# Harness-owned test execution`,
    `# Command: ${cmd}`,
    `# CWD: ${projectRoot}`,
    `# Exit code: ${exitCode}`,
    `# Non-vacuous oracle: ${nonVacuous}`,
    timedOut ? `# TIMED OUT after 120s` : "",
    `# Timestamp: ${new Date().toISOString()}`,
    ``,
    `--- stdout ---`,
    stdout,
    `--- stderr ---`,
    stderr,
  ].filter(Boolean).join("\n");

  try { writeFileSync(logPath, log); } catch { /* best effort */ }
  return { exitCode, logPath, timedOut, nonVacuous };
}

function _checkArtifactSize(a, errors) {
  const sz = statSync(a).size;
  if (sz > MAX_ARTIFACT_SIZE) {
    errors.push(`artifact too large (${Math.round(sz / 1024 / 1024)}MB, max 10MB): ${a}`);
    return false;
  }
  return true;
}

function _isContainedPath(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function validateIntegratedArtifacts(
  unit,
  unitType,
  artifacts,
  errors,
  { requireContainedEvidence = false, allowHarnessOnly = false, state = null, sessionDir = null } = {},
) {
  if (artifacts.length === 0 && !allowHarnessOnly) {
    errors.push(`${unitType} unit '${unit}' has no artifacts — must have verification evidence`);
    return { artifacts: [], artifactHashes: [], artifactBindings: [] };
  }
  let sessionRoot = null;
  if (requireContainedEvidence) {
    if (state?.status !== "in_progress" || state?.next_unit !== unit || !state?._in_progress_since) {
      errors.push(
        `integrated evidence for '${unit}' requires the current unit to be claimed by next-tick`,
      );
    }
    try {
      sessionRoot = realpathSync(sessionDir);
    } catch (error) {
      errors.push(`session evidence root is unreadable: ${sessionDir} (${error.message})`);
    }
  }
  const tickStartedAt = state?._in_progress_since || state?._last_modified || null;
  const tickStartMs = tickStartedAt && !Number.isNaN(Date.parse(tickStartedAt))
    ? Date.parse(tickStartedAt)
    : null;
  const canonicalArtifacts = [];
  const artifactHashes = [];
  const artifactBindings = [];
  for (const artifact of artifacts) {
    const absolute = resolve(artifact);
    if (!existsSync(absolute)) {
      errors.push(`artifact not found: ${artifact}`);
      continue;
    }
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      errors.push(`artifact is unreadable: ${artifact} (${error.message})`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      errors.push(`artifact is a symbolic link, not a contained regular file: ${artifact}`);
      continue;
    }
    if (!stat.isFile()) {
      errors.push(`artifact is not a regular file: ${artifact}`);
      continue;
    }
    let canonical;
    try {
      canonical = realpathSync(absolute);
    } catch (error) {
      errors.push(`artifact cannot be canonicalized: ${artifact} (${error.message})`);
      continue;
    }
    if (requireContainedEvidence && (!sessionRoot || !_isContainedPath(sessionRoot, canonical))) {
      errors.push(`integrated evidence artifact escapes the loop session: ${artifact}`);
      continue;
    }
    if (!_checkArtifactSize(canonical, errors)) continue;
    if (stat.size === 0 || readFileSync(canonical, "utf8").trim().length === 0) {
      errors.push(`artifact is empty: ${artifact}`);
      continue;
    }
    if (requireContainedEvidence && tickStartMs !== null && stat.mtimeMs < tickStartMs) {
      errors.push(
        `integrated evidence artifact '${artifact}' is stale (mtime ${new Date(stat.mtimeMs).toISOString()} < tick start ${tickStartedAt})`,
      );
      continue;
    }
    const artifactHash = `sha256:${createHash("sha256").update(readFileSync(canonical)).digest("hex")}`;
    canonicalArtifacts.push(canonical);
    artifactHashes.push(artifactHash);
    artifactBindings.push({ path: canonical, sha256: artifactHash, type: "artifact", proof: null });
  }
  return { artifacts: canonicalArtifacts, artifactHashes, artifactBindings };
}

function validateImplementArtifacts(unit, unitType, artifacts, errors, warnings, state, dir) {
  if (artifacts.length === 0) {
    errors.push(`implement unit '${unit}' has no artifacts — must have test evidence`);
  }
  for (const a of artifacts) {
    if (!existsSync(a)) {
      errors.push(`artifact not found: ${a}`);
    } else if (!_checkArtifactSize(a, errors)) {
      continue;
    } else {
      const content = readFileSync(a, "utf8");
      if (content.trim().length === 0) {
        errors.push(`artifact is empty: ${a}`);
      } else if (a.endsWith(".json")) {
        try {
          const data = JSON.parse(content);
          const hasTestFields = data.tests_run != null || data.testsRun != null ||
            data.passed != null || data.failures != null || data.exitCode != null ||
            data.pass != null || data.fail != null || data.total != null;
          if (!hasTestFields) {
            warnings.push(`artifact '${a}' is JSON but has no test-result fields`);
          }
          if (hasTestFields) {
            if (!data._command && !data.command) {
              warnings.push(`artifact '${a}' has no _command field — test results should record what command was executed`);
            }
            if (data.durationMs != null && data.durationMs <= 0) {
              errors.push(`artifact '${a}' has durationMs=${data.durationMs} — test runs must take positive time`);
            }
            if (data._timestamp) {
              const ts = new Date(data._timestamp).getTime();
              const now = Date.now();
              if (ts > now + 60000) {
                errors.push(`artifact '${a}' has future timestamp — evidence must be from current tick`);
              } else if (now - ts > 30 * 60 * 1000) {
                warnings.push(`artifact '${a}' timestamp is >30min old — may be stale evidence`);
              }
            }
            try {
              const fstat = statSync(a);
              const fileAge = Date.now() - fstat.mtimeMs;
              if (fileAge > 30 * 60 * 1000) {
                warnings.push(`artifact '${a}' file mtime is >30min ago — may be reused from previous run`);
              }
            } catch { /* stat fail is non-fatal */ }
          }
        } catch { /* raw output ok */ }
      }
    }
  }

  // Rule 6: UI implement needs screenshot
  if (unitType.includes("ui") || unitType.includes("frontend") || unitType.includes("fe")) {
    const hasScreenshot = artifacts.some(a => a.endsWith(".png") || a.endsWith(".jpg") || a.endsWith(".jpeg"));
    if (!hasScreenshot) {
      errors.push(`UI implement unit '${unit}' has no screenshot artifact (.png/.jpg) — UI changes require visual verification`);
    }
  }

  // Rule 3: atomic commit
  const currentHead = getGitHeadHash(state.projectDir);
  if (currentHead && state._git_head && currentHead === state._git_head) {
    errors.push(`git HEAD unchanged since last tick — implement unit must produce a commit`);
  }

  // Rule 7b: reject .gitkeep-only or trivial commits
  const HEX_HASH_RE = /^[0-9a-f]{4,40}$/i;
  if (currentHead && state._git_head && currentHead !== state._git_head) {
    if (!HEX_HASH_RE.test(state._git_head) || !HEX_HASH_RE.test(currentHead)) {
      warnings.push("git HEAD hash failed format validation — skipping commit content check");
    } else {
      try {
        const diffStat = execFileSync("git", ["diff", "--name-only", `${state._git_head}..${currentHead}`], { encoding: "utf8", timeout: 5000, cwd: state.projectDir || undefined }).trim();
        const changedFiles = diffStat.split("\n").filter(Boolean);
        const substantiveFiles = changedFiles.filter(f => !f.endsWith(".gitkeep") && !f.endsWith(".keep"));
        if (substantiveFiles.length === 0 && changedFiles.length > 0) {
          errors.push(`commit only modifies .gitkeep files — implement unit must produce substantive code changes`);
        }
      } catch {
        warnings.push("git diff failed (old HEAD may be unreachable after rebase) — .gitkeep guard skipped");
      }
    }
  }

  // Rule 9: external validator enforcement — harness-owned test execution
  if (state._external_validators) {
    if (!state._external_validators.pre_commit_hooks) {
      warnings.push("no pre-commit hooks detected — git commit has no external quality gate (lint/typecheck/format)");
    }
    if (state._external_validators.test_script) {
      const testResult = _runTestScript(state._external_validators.test_script, dir, state.tick || 0, state.projectDir);
      if (testResult.exitCode !== 0) {
        const reason = testResult.timedOut ? "TIMED OUT (120s)" : `exit ${testResult.exitCode}`;
        errors.push(`test_script '${state._external_validators.test_script}' failed (${reason}) — implement unit must pass tests. Log: ${testResult.logPath}`);
      } else {
        warnings.push(`test_script passed (exit 0). Log: ${testResult.logPath}`);
      }
    }
    if (state._external_validators.lint_script) {
      const lintResult = _runTestScript(state._external_validators.lint_script, dir, state.tick || 0, state.projectDir, "lint");
      if (lintResult.exitCode !== 0) {
        const reason = lintResult.timedOut ? "TIMED OUT (120s)" : `exit ${lintResult.exitCode}`;
        errors.push(`lint_script '${state._external_validators.lint_script}' failed (${reason}) — code must pass lint. Log: ${lintResult.logPath}`);
      }
    }
    if (state._external_validators.typecheck_script) {
      const tcResult = _runTestScript(state._external_validators.typecheck_script, dir, state.tick || 0, state.projectDir, "typecheck");
      if (tcResult.exitCode !== 0) {
        const reason = tcResult.timedOut ? "TIMED OUT (120s)" : `exit ${tcResult.exitCode}`;
        errors.push(`typecheck_script '${state._external_validators.typecheck_script}' failed (${reason}) — code must pass type checking. Log: ${tcResult.logPath}`);
      }
    }
  }

  // Rule 10: evidence timestamp freshness — artifacts must be newer than tick start
  const tickStart = state._last_modified ? new Date(state._last_modified).getTime() : 0;
  if (tickStart > 0) {
    for (const a of artifacts) {
      if (!existsSync(a)) continue;
      const mtime = statSync(a).mtimeMs;
      if (mtime < tickStart) {
        errors.push(`artifact '${a}' is stale (mtime ${new Date(mtime).toISOString()} < tick start ${state._last_modified}) — evidence must be produced during this tick, not reused from a prior run`);
      }
    }
  }
}

function validateReviewArtifacts(unit, artifacts, errors, warnings, state, dir) {
  if (artifacts.length === 0) {
    errors.push(`review unit '${unit}' has no artifacts — must have eval-*.md files`);
  }
  const evalFiles = artifacts.filter(a => a.endsWith(".md"));
  if (evalFiles.length < 2) {
    errors.push(`review unit '${unit}' has ${evalFiles.length} eval file(s) — need \u22652 for independent review (separate subagents)`);
  }
  const evalContents = [];
  for (const a of artifacts) {
    if (!existsSync(a)) {
      errors.push(`artifact not found: ${a}`);
    } else if (!_checkArtifactSize(a, errors)) {
      continue;
    } else {
      const content = readFileSync(a, "utf8");
      if (content.trim().length === 0) {
        errors.push(`artifact is empty: ${a}`);
      } else if (a.endsWith(".md")) {
        evalContents.push({ path: a, content });
        const hasSeverity = /[\ud83d\udd34\ud83d\udfe1\ud83d\udd35]/.test(content) || /LGTM/i.test(content) ||
          /critical|warning|suggestion/i.test(content);
        if (!hasSeverity) {
          errors.push(`eval '${a}' has no severity markers (\ud83d\udd34\ud83d\udfe1\ud83d\udd35) or LGTM — review must produce structured findings`);
        }
      }
    }
  }

  // Distinctness check — delegate to shared function
  if (evalContents.length >= 2) {
    const dc = checkEvalDistinctness(evalContents);
    errors.push(...dc.errors);
    warnings.push(...dc.warnings);
  }

  // Rule 5: hash eval files for tamper detection
  const evalHashes = {};
  for (const a of evalFiles) {
    if (existsSync(a)) {
      evalHashes[a] = hashContent(readFileSync(a, "utf8"));
    }
  }
  state._last_review_evals = evalHashes;

  // Synthesize verdict from eval files (reuse parseEvaluation from eval-parser)
  if (evalContents.length === 0) return undefined;

  let totalCritical = 0, totalWarning = 0, totalSuggestion = 0;
  const findings = [];
  const reviewClaims = [];
  let reviewQualityOk = true;
  for (const { content } of evalContents) {
    const parsed = parseEvaluation(content, state.mission ? {
      mission: {
        criterionHashes: state.mission.criterionHashes || {},
        findingRegistry: state.findingRegistry || [],
      },
    } : {});
    totalCritical += parsed.critical;
    totalWarning += parsed.warning;
    totalSuggestion += parsed.suggestion;
    findings.push(...(parsed.findings || []).filter(finding =>
      finding.severity === "critical" || finding.severity === "warning"
    ));
    if (parsed.review_quality_ok === false) {
      reviewQualityOk = false;
      reviewClaims.push(...(parsed.review_claims || []));
    }
  }

  if (!reviewQualityOk) {
    errors.push("review metadata is invalid; fresh evaluation required");
    return {
      verdict: "BLOCKED",
      findings: [],
      reviewQualityOk: false,
      reviewClaims,
      evalFiles: evalContents.map(item => item.path),
    };
  }

  let verdict = "PASS";
  if (totalCritical > 0) verdict = "FAIL";
  else if (totalWarning > 0) verdict = "ITERATE";

  return {
    verdict,
    findings,
    reviewQualityOk: true,
    reviewClaims: [],
    evalFiles: evalContents.map(item => item.path),
  };
}

function _isEvidencedUnlinkedGoalSpecRisk(finding) {
  return finding?.class === "GOAL_SPEC"
    && finding?.criterion === "UNLINKED"
    && typeof finding?.file === "string"
    && finding.file.length > 0
    && Number.isInteger(finding?.line)
    && finding.line > 0
    && typeof finding?.reasoning === "string"
    && finding.reasoning.trim().length > 0;
}

function _reviewClaimDispositionStatus({ sessionDir, evalFiles, priorClaims, parsedFindings, state }) {
  if (!Array.isArray(priorClaims) || priorClaims.length === 0) {
    return { ok: true, required: false, errors: [], dispositions: [], path: null };
  }
  const errors = [];
  let sessionRoot;
  try {
    sessionRoot = realpathSync(sessionDir);
  } catch (error) {
    return {
      ok: false,
      required: true,
      errors: [`review claim disposition session is unreadable: ${error.message}`],
      dispositions: [],
      path: null,
    };
  }
  const runDirs = new Set();
  for (const evalFile of evalFiles || []) {
    try {
      const evalStat = lstatSync(resolve(evalFile));
      if (!evalStat.isFile() || evalStat.isSymbolicLink()) {
        errors.push(`fresh reevaluation artifact must be a regular non-symlink file: ${evalFile}`);
        continue;
      }
      const canonicalEval = realpathSync(resolve(evalFile));
      if (!_isContainedPath(sessionRoot, canonicalEval)) {
        errors.push(`review artifact escapes the loop session: ${evalFile}`);
        continue;
      }
      const priorAttemptAt = state?._last_modified && !Number.isNaN(Date.parse(state._last_modified))
        ? Date.parse(state._last_modified)
        : null;
      if (priorAttemptAt !== null && evalStat.mtimeMs < priorAttemptAt) {
        errors.push(`fresh reevaluation artifact is stale relative to the prior invalid review: ${evalFile}`);
      }
      runDirs.add(dirname(canonicalEval));
    } catch (error) {
      errors.push(`review artifact is unreadable while resolving claim dispositions: ${evalFile} (${error.message})`);
    }
  }
  if (runDirs.size !== 1) {
    errors.push("fresh reevaluation artifacts must share one run directory for review-claim-dispositions.json");
    return { ok: false, required: true, errors, dispositions: [], path: null };
  }
  const runDir = [...runDirs][0];
  const dispositionPath = join(runDir, "review-claim-dispositions.json");
  if (!existsSync(dispositionPath)) {
    errors.push("fresh reevaluation must provide review-claim-dispositions.json for every prior invalid claim");
    return { ok: false, required: true, errors, dispositions: [], path: dispositionPath };
  }
  let canonicalDisposition;
  let dispositionStat;
  try {
    dispositionStat = lstatSync(dispositionPath);
    if (!dispositionStat.isFile() || dispositionStat.isSymbolicLink()) {
      errors.push("review-claim-dispositions.json must be a contained regular file");
      return { ok: false, required: true, errors, dispositions: [], path: dispositionPath };
    }
    canonicalDisposition = realpathSync(dispositionPath);
    if (!_isContainedPath(sessionRoot, canonicalDisposition) || dirname(canonicalDisposition) !== runDir) {
      errors.push("review-claim-dispositions.json escapes the current reevaluation run");
      return { ok: false, required: true, errors, dispositions: [], path: dispositionPath };
    }
    const priorAttemptAt = state?._last_modified && !Number.isNaN(Date.parse(state._last_modified))
      ? Date.parse(state._last_modified)
      : null;
    if (priorAttemptAt !== null && dispositionStat.mtimeMs < priorAttemptAt) {
      errors.push("review-claim-dispositions.json is stale relative to the prior invalid review");
    }
  } catch (error) {
    errors.push(`review-claim-dispositions.json is unreadable: ${error.message}`);
    return { ok: false, required: true, errors, dispositions: [], path: dispositionPath };
  }
  let data;
  try {
    data = JSON.parse(readFileSync(canonicalDisposition, "utf8"));
  } catch (error) {
    errors.push(`review claim dispositions are unreadable: ${error.message}`);
    return { ok: false, required: true, errors, dispositions: [], path: canonicalDisposition };
  }
  const dispositions = Array.isArray(data?.dispositions) ? data.dispositions : [];
  if (data?.schemaVersion !== 1) errors.push("review-claim-dispositions.json schemaVersion must equal 1");
  if (!Array.isArray(data?.dispositions)) errors.push("review-claim-dispositions.json requires a dispositions array");
  const validated = validateReviewClaimDispositions({
    pendingClaims: priorClaims,
    dispositions,
    findings: parsedFindings || [],
  });
  errors.push(...validated.errors);
  return {
    ok: errors.length === 0,
    required: true,
    errors,
    dispositions: validated.dispositions,
    path: canonicalDisposition,
  };
}

function validateFixArtifacts(unit, artifacts, errors, warnings, state, dir) {
  // Rule 5: verify eval file integrity from previous review
  if (state._last_review_evals && typeof state._last_review_evals === "object") {
    for (const [evalPath, expectedHash] of Object.entries(state._last_review_evals)) {
      if (existsSync(evalPath)) {
        const actualHash = hashContent(readFileSync(evalPath, "utf8"));
        if (actualHash !== expectedHash) {
          errors.push(`eval file '${evalPath}' was modified after review (hash ${expectedHash} \u2192 ${actualHash}) — review findings must not be altered before fix`);
        }
      } else {
        errors.push(`eval file '${evalPath}' from previous review was deleted — review findings must persist through fix`);
      }
    }
  }

  // Rule 17: fix must reference upstream review findings
  if (artifacts.length > 0) {
    let referencesFindings = false;
    for (const a of artifacts) {
      if (existsSync(a) && _checkArtifactSize(a, errors)) {
        const content = readFileSync(a, "utf8");
        if (/[\ud83d\udd34\ud83d\udfe1\ud83d\udd35]/.test(content) || /\w+\.\w+:\d+/.test(content)) {
          referencesFindings = true;
        }
      }
    }
    if (!referencesFindings) {
      warnings.push(`fix unit '${unit}' artifacts don't reference review findings — fixes should trace to specific \ud83d\udd34/\ud83d\udfe1 items or file:line refs`);
    }
  }

  // Rule 3: fix should also commit
  const currentHead = getGitHeadHash(state.projectDir);
  if (currentHead && state._git_head && currentHead === state._git_head) {
    errors.push(`git HEAD unchanged — fix unit must produce a commit`);
  }

  // Rule 9: fix must also pass tests + lint + typecheck
  if (state._external_validators) {
    if (state._external_validators.test_script) {
      const testResult = _runTestScript(state._external_validators.test_script, dir, state.tick || 0, state.projectDir);
      if (testResult.exitCode !== 0) {
        const reason = testResult.timedOut ? "TIMED OUT (120s)" : `exit ${testResult.exitCode}`;
        errors.push(`test_script '${state._external_validators.test_script}' failed (${reason}) — fix unit must pass tests. Log: ${testResult.logPath}`);
      }
    }
    if (state._external_validators.lint_script) {
      const lintResult = _runTestScript(state._external_validators.lint_script, dir, state.tick || 0, state.projectDir, "lint");
      if (lintResult.exitCode !== 0) {
        const reason = lintResult.timedOut ? "TIMED OUT (120s)" : `exit ${lintResult.exitCode}`;
        errors.push(`lint_script '${state._external_validators.lint_script}' failed (${reason}) — fix must pass lint. Log: ${lintResult.logPath}`);
      }
    }
    if (state._external_validators.typecheck_script) {
      const tcResult = _runTestScript(state._external_validators.typecheck_script, dir, state.tick || 0, state.projectDir, "typecheck");
      if (tcResult.exitCode !== 0) {
        const reason = tcResult.timedOut ? "TIMED OUT (120s)" : `exit ${tcResult.exitCode}`;
        errors.push(`typecheck_script '${state._external_validators.typecheck_script}' failed (${reason}) — fix must pass type checking. Log: ${tcResult.logPath}`);
      }
    }
  }
}

// ── Backlog auto-accumulation ──────────────────────────────────

// Detect lines that contain a severity emoji but carry no actual finding content —
// e.g. markdown headers ("### 🔴 Critical"), label-only lines ("🟡 Warning:"),
// and empty-section markers ("🔴 None.", "🟡 N/A"). These should NOT inflate
// the backlog because the review produced no issue of that severity.
function _isEmptySeverityLine(trimmed) {
  if (!trimmed) return true;
  // Markdown header — structural, not a finding
  if (/^#{1,6}\s/.test(trimmed)) return true;
  // Strip severity emojis + list markers + formatting to examine remainder
  const stripped = trimmed
    .replace(/^[-*]\s+/, "")
    .replace(/[🔴🟡🔵]/g, "")
    .replace(/[*_`\[\]()]/g, "")
    .trim();
  // Bare severity labels with optional colon / em-dash / parenthetical source
  const LABEL_ONLY = /^(critical|warning|suggestion|major|minor|must\s*fix|recommended|nit|info)\s*:?\s*(—.*)?$/i;
  // Explicit emptiness markers ("None.", "N/A", "N.A.", "—")
  const EMPTY_MARKER = /^(none|n\/?a|n\.a\.?|nothing|—|-)\s*\.?$/i;
  return stripped.length === 0 || LABEL_ONLY.test(stripped) || EMPTY_MARKER.test(stripped);
}

function _accumulateBacklog(dir, unit, artifacts, warnings) {
  const backlogPath = join(dir, "backlog.md");
  const findingLines = [];

  for (const a of artifacts) {
    if (!a.endsWith(".md") || !existsSync(a)) continue;
    let content;
    try {
      content = readFileSync(a, "utf8");
    } catch {
      warnings.push(`backlog: could not read ${a}`);
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      // Extract both 🔴 (critical) and 🟡 (iterate) findings
      if (/🔴/.test(trimmed) || /🟡/.test(trimmed)) {
        // Skip empty severity headers / labels / "None." markers
        if (_isEmptySeverityLine(trimmed)) continue;
        // Also skip if next non-blank line is an explicit emptiness marker
        // (e.g. "🟡 Warning:" header followed by "- None.")
        if (/:\s*$/.test(trimmed)) {
          let j = i + 1;
          while (j < lines.length && lines[j].trim().length === 0) j++;
          if (j < lines.length) {
            const next = lines[j].trim().replace(/^[-*]\s+/, "");
            if (/^(none|n\/?a|n\.a\.?)\s*\.?$/i.test(next)) continue;
          }
        }
        // Strip leading list markers to avoid double-prefix: "- 🟡 foo" → "🟡 foo"
        const cleaned = trimmed.replace(/^[-*]\s+/, "");
        findingLines.push({ text: cleaned, source: a });
      }
    }
  }

  if (findingLines.length === 0) return;

  // Ensure file starts with a top-level heading if it doesn't exist yet
  const needsHeader = !existsSync(backlogPath);

  const sectionHeader = `\n## From review unit ${unit} — ${new Date().toISOString()}\n`;
  const items = findingLines.map(f => `- [ ] ${f.text} _(from ${f.source})_`).join("\n") + "\n";

  try {
    const content = (needsHeader ? "# Backlog\n" : "") + sectionHeader + items;
    appendFileSync(backlogPath, content);
  } catch {
    warnings.push("failed to append to backlog.md");
  }
}

function _accumulateMissionFindings(dir, unit, findings, warnings) {
  const artifactFindings = findings.filter(finding =>
    finding.class === "ARTIFACT" && finding.criterion !== "UNLINKED"
  );
  const deferredFindings = findings.filter(finding =>
    finding.class !== "ARTIFACT" || finding.criterion === "UNLINKED"
  );
  const append = (path, heading, entries) => {
    if (entries.length === 0) return;
    const needsHeader = !existsSync(path);
    const items = entries.map(finding => {
      const emoji = finding.severity === "critical" ? "🔴" : "🟡";
      const ref = finding.finding_ref || "UNREGISTERED";
      return `- [ ] ${emoji} [${unit}] [${finding.class}/${finding.criterion}] ${ref}: ${finding.issue}`;
    }).join("\n");
    try {
      appendFileSync(
        path,
        `${needsHeader ? `# ${heading}\n` : ""}\n## ${unit} — ${new Date().toISOString()}\n${items}\n`,
      );
    } catch {
      warnings.push(`failed to append ${path}`);
    }
  };
  append(join(dir, "backlog.md"), "Backlog", artifactFindings);
  append(join(dir, "mission-deferred-findings.md"), "Mission Deferred Findings", deferredFindings);
}

// ── Checkpoint writer ──────────────────────────────────────────
// Writes tick-N-summary.md — a self-contained snapshot that lets
// a new session resume without conversation history.

function _writeCheckpoint(dir, ctx, warnings) {
  const {
    tick, unit, unitType, status, description,
    verdict, artifacts, nextUnit, planFile, allUnits, state, delta,
  } = ctx;

  const fileName = `tick-${tick}-summary.md`;
  const filePath = join(dir, fileName);

  // Collect previous tick summaries for context chain
  const prevTicks = (state._tick_history || [])
    .filter(t => t.tick < tick)
    .slice(-3)  // last 3 for brevity
    .map(t => `  - Tick ${t.tick}: ${t.unit} (${t.status})${t.description ? ` — ${t.description}` : ""}`)
    .join("\n");

  // Remaining units from pre-parsed plan
  let remainingUnits = "";
  const currentIdx = allUnits.findIndex(u => u.id === unit);
  const remaining = allUnits.slice(currentIdx + 1);
  if (remaining.length > 0) {
    remainingUnits = remaining.map(u => `  - ${u.id}: ${u.type} — ${u.description}`).join("\n");
  } else {
    remainingUnits = "  (none — this was the final unit)";
  }

  const md = [
    `# Checkpoint: Tick ${tick}`,
    "",
    `> Auto-generated by opc-harness complete-tick — ${new Date().toISOString()}`,
    "",
    `## Current`,
    `- **Unit**: ${unit} (${unitType})`,
    `- **Status**: ${status}`,
    `- **Verdict**: ${verdict || "n/a"}`,
    `- **Description**: ${description}`,
    "",
    `## Artifacts`,
    artifacts.length > 0
      ? artifacts.map(a => `- ${a}`).join("\n")
      : "- (none)",
    "",
    delta ? `## Technical Delta\n${delta}` : "",
    "",
    `## Recent History`,
    prevTicks || "  (first tick)",
    "",
    `## Next`,
    nextUnit ? `- **Next unit**: ${nextUnit}` : "- **Pipeline complete** — no more units",
    "",
    `## Remaining Units`,
    remainingUnits || "  (unknown — plan file not found)",
    "",
    `## Resume Context`,
    `- Loop state: ${join(dir, "loop-state.json")}`,
    `- Plan: ${planFile}`,
    `- Progress: ${join(dir, "progress.md")}`,
    state._task_scope && state._task_scope.length > 0
      ? `- Task scope: ${state._task_scope.map(s => s.id).join(", ")}`
      : "",
    state.mission ? "" : null,
    state.mission ? missionPromptContext({ sessionDir: dir, state }) : null,
    "",
  ].filter(Boolean).join("\n") + "\n";

  try {
    atomicWriteSync(filePath, md);
  } catch {
    warnings.push(`failed to write checkpoint ${fileName}`);
  }
}
