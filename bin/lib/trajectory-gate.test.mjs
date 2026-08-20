import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "node:child_process";
import {
  applyMissionDecision,
  commitTrajectoryObservation,
  createTrajectoryPacket,
  currentMissionBindings,
  consumeMissionRetryGrant,
  evaluateTrajectory,
  hasCurrentFinalCheckpoint,
  missionRetryGrantMatches,
  openMissionGate,
  registerFindingBatch,
  sealPendingMissionGate,
  validateColdMissionReview,
  validatePendingMissionGateSeal,
} from "./trajectory-gate.mjs";

function missionState() {
  return {
    currentNode: "review",
    history: [{ nodeId: "review", runId: "eval-run-1" }],
    mission: {
      path: "mission-contract.json",
      sha256: "mission-sha",
      originalRequestSha256: "request-sha",
      acceptanceCriteriaSha256: "criteria-sha",
      planSha256: "plan-sha",
      criterionHashes: { "OUT-1": "out-1-sha", "FLOOR-1": "floor-1-sha" },
      version: 1,
      strategyEpoch: 1,
      owner: "Mission owner",
      affectedParties: ["Users", "Maintainers"],
      mode: "explore",
      originalRequest: "Preserve the global mission.",
      outcomes: [{ id: "OUT-1", statement: "The integrated outcome works." }],
      protectedFloors: [{ id: "FLOOR-1", statement: "State integrity is preserved." }],
      nonGoals: ["Unrelated packaging"],
      appetite: { maxRepairCycles: 8, expiresAt: null },
      endToEndScenario: { id: "SCENARIO-1" },
      realitySignals: [{ id: "SIG-1", required: true }],
      guardrails: [{ id: "GUARD-1", metric: "Integrity", actionThreshold: "Pause on mismatch." }],
      assumptions: [{ id: "ASM-1", statement: "The baseline is current.", freshUntil: null }],
      exitAndSalvage: "Keep validated evidence and stop the run.",
    },
    trajectory: {
      pending: false,
      retryAllowance: 0,
      retryGrant: null,
      findingFailureCounts: {},
      repairEdgeFailures: {},
      repairEvidenceCursor: {},
    },
    findingRegistry: [],
    findingHistory: [],
    evidenceReceipts: [],
    checkpointReceipts: [],
  };
}

function artifactFinding(overrides = {}) {
  return {
    class: "ARTIFACT",
    criterion: "OUT-1",
    finding_ref: "NEW",
    fingerprint: "checkout-total-rounding",
    invariant: "Displayed total equals the persisted total.",
    ...overrides,
  };
}

test("mission-less trajectory remains a no-op", () => {
  assert.deepEqual(evaluateTrajectory({ state: {}, findings: [artifactFinding()], verdict: "FAIL" }), {
    action: "ALLOW_LOCAL",
    missionEnabled: false,
  });
});

test("finding registry assignment is deterministic and exact invariant matches coalesce", () => {
  const criteria = { "OUT-1": "out-1-sha" };
  const a = artifactFinding();
  const b = artifactFinding({ fingerprint: "alternate-reviewer-slug" });
  const c = artifactFinding({ invariant: "Persisted total uses the same currency precision." });
  const forward = registerFindingBatch({ findings: [a, b, c], criterionHashes: criteria });
  const reverse = registerFindingBatch({ findings: [c, b, a], criterionHashes: criteria });
  assert.equal(forward.ok, true);
  assert.equal(forward.registry.length, 2);
  assert.equal(forward.findings[0].finding_ref, forward.findings[1].finding_ref);
  assert.notEqual(forward.findings[0].finding_ref, forward.findings[2].finding_ref);
  assert.deepEqual(
    forward.registry.map(entry => [entry.id, entry.invariantHash]),
    reverse.registry.map(entry => [entry.id, entry.invariantHash]),
  );
});

test("same fresh slug with different invariants gets separate IDs, but committed reuse collides", () => {
  const criteria = { "OUT-1": "out-1-sha" };
  const firstBatch = registerFindingBatch({
    findings: [
      artifactFinding(),
      artifactFinding({ invariant: "Displayed total includes shipping." }),
    ],
    criterionHashes: criteria,
  });
  assert.equal(firstBatch.ok, true);
  assert.equal(firstBatch.registry.length, 2);

  const collision = registerFindingBatch({
    registry: [firstBatch.registry[0]],
    findings: [artifactFinding({ invariant: "A new meaning under the old slug." })],
    criterionHashes: criteria,
  });
  assert.equal(collision.ok, false);
  assert.match(collision.errors[0], /collision/);
});

test("registered FIND-N reuse retains canonical gate key", () => {
  const criteria = { "OUT-1": "out-1-sha" };
  const created = registerFindingBatch({ findings: [artifactFinding()], criterionHashes: criteria });
  const reused = registerFindingBatch({
    registry: created.registry,
    findings: [artifactFinding({ finding_ref: created.findings[0].finding_ref })],
    criterionHashes: criteria,
  });
  assert.equal(reused.ok, true);
  assert.equal(reused.findings[0].gateKey, created.findings[0].gateKey);

  const rediscovered = registerFindingBatch({
    registry: created.registry,
    findings: [artifactFinding({ finding_ref: "NEW", fingerprint: "independent-reviewer-slug" })],
    criterionHashes: criteria,
  });
  assert.equal(rediscovered.ok, true);
  assert.equal(rediscovered.registry.length, 1);
  assert.equal(rediscovered.findings[0].finding_ref, created.findings[0].finding_ref);

  const reclassified = registerFindingBatch({
    registry: created.registry,
    findings: [artifactFinding({ finding_ref: created.findings[0].finding_ref, class: "PLAN" })],
    criterionHashes: criteria,
  });
  assert.equal(reclassified.ok, false);
  assert.match(reclassified.errors.join("; "), /belongs to class ARTIFACT/);

  const changedInvariant = registerFindingBatch({
    registry: created.registry,
    findings: [artifactFinding({ finding_ref: created.findings[0].finding_ref, invariant: "A different invariant." })],
    criterionHashes: criteria,
  });
  assert.equal(changedInvariant.ok, false);
  assert.match(changedInvariant.errors.join("; "), /invariant differs/);
});

test("first artifact failure is allowed and second canonical failure opens the Mission Gate", () => {
  const state = missionState();
  const registered = registerFindingBatch({
    findings: [artifactFinding()],
    criterionHashes: state.mission.criterionHashes,
  });
  const finding = registered.findings[0];
  state.findingRegistry = registered.registry;

  const first = evaluateTrajectory({ state, findings: [finding], verdict: "FAIL" });
  assert.equal(first.action, "ALLOW_LOCAL");
  const afterFirst = commitTrajectoryObservation({ state, findings: [finding], verdict: "FAIL" });
  const second = evaluateTrajectory({ state: afterFirst, findings: [finding], verdict: "FAIL" });
  assert.equal(second.action, "OPEN_MISSION_GATE");
  assert.equal(second.reason, "REPEATED_CANONICAL_FINDING");
});

test("PLAN, GOAL_SPEC, and ENVIRONMENT findings open immediately", () => {
  for (const findingClass of ["PLAN", "GOAL_SPEC", "ENVIRONMENT"]) {
    const state = missionState();
    const registered = registerFindingBatch({
      findings: [artifactFinding({ class: findingClass, fingerprint: `failure-${findingClass.toLowerCase().replace("_", "-")}` })],
      criterionHashes: state.mission.criterionHashes,
    });
    const result = evaluateTrajectory({ state, findings: registered.findings, verdict: "FAIL" });
    assert.equal(result.action, "OPEN_MISSION_GATE");
    assert.equal(result.reason, `${findingClass}_FINDING`);
  }
});

test("second repair-edge failure is suppressed only by new current-epoch integrated PASS evidence", () => {
  let state = missionState();
  const edgeKey = "gate→build";
  state = commitTrajectoryObservation({ state, edgeKey, verdict: "FAIL", isRepairEdge: true, recordFindingFailures: false });
  assert.equal(evaluateTrajectory({ state, edgeKey, verdict: "FAIL", isRepairEdge: true }).action, "OPEN_MISSION_GATE");

  state.evidenceReceipts.push({ id: "EV-1", scope: "integrated", result: "PASS", strategyEpoch: 1 });
  assert.equal(evaluateTrajectory({ state, edgeKey, verdict: "FAIL", isRepairEdge: true }).action, "ALLOW_LOCAL");
  const committed = commitTrajectoryObservation({ state, edgeKey, verdict: "FAIL", isRepairEdge: true, recordFindingFailures: false });
  committed.evidenceReceipts.push({ id: "EV-old", scope: "integrated", result: "PASS", strategyEpoch: 0 });
  assert.equal(evaluateTrajectory({ state: committed, edgeKey, verdict: "FAIL", isRepairEdge: true }).action, "OPEN_MISSION_GATE");
});

test("a scoped retry authorizes only its canonical finding and is consumed exactly once", () => {
  const state = missionState();
  const registered = registerFindingBatch({ findings: [artifactFinding()], criterionHashes: state.mission.criterionHashes });
  const finding = registered.findings[0];
  state.trajectory.findingFailureCounts[finding.gateKey] = 1;
  state.trajectory.retryAllowance = 1;
  state.trajectory.retryGrant = {
    triggerId: "TRJ-1",
    strategyEpoch: 1,
    scopeTokens: [finding.finding_ref],
    edgeKey: "gate→build",
    command: "transition",
    sourceNode: "review",
    nextUnit: null,
    remaining: 1,
  };

  const reviewTransition = evaluateTrajectory({ state, findings: [finding], verdict: "FAIL", isRepairEdge: false });
  assert.equal(reviewTransition.authorizedRetry, true);
  assert.equal(reviewTransition.consumeRetry, false);
  const afterReview = commitTrajectoryObservation({ state, findings: [finding], verdict: "FAIL", consumeRetry: false });
  assert.equal(afterReview.trajectory.retryAllowance, 1);

  const repair = evaluateTrajectory({ state: afterReview, findings: [finding], edgeKey: "gate→build", verdict: "FAIL", isRepairEdge: true });
  assert.equal(repair.consumeRetry, true);
  const afterRepair = commitTrajectoryObservation({
    state: afterReview,
    findings: [finding],
    edgeKey: "gate→build",
    verdict: "FAIL",
    isRepairEdge: true,
    recordFindingFailures: false,
    consumeRetry: repair.consumeRetry,
  });
  assert.equal(afterRepair.trajectory.retryAllowance, 0);
  assert.equal(afterRepair.trajectory.retryGrant, null);
  assert.equal(evaluateTrajectory({ state: afterRepair, findings: [finding], verdict: "FAIL" }).action, "OPEN_MISSION_GATE");

  const unrelated = registerFindingBatch({
    registry: registered.registry,
    findings: [artifactFinding({ fingerprint: "other-invariant", invariant: "A different invariant remains true." })],
    criterionHashes: state.mission.criterionHashes,
  }).findings[0];
  assert.equal(missionRetryGrantMatches({
    state,
    findings: [unrelated],
    edgeKey: "gate→build",
    command: "transition",
    fromNode: "review",
  }), false);
  const consumed = consumeMissionRetryGrant(state);
  assert.equal(consumed.trajectory.retryGrant, null);
  assert.equal(consumed.trajectory.retryAllowance, 0);
});

test("opening a gate writes a bound packet without advancing the node", () => {
  const dir = mkdtempSync(join(tmpdir(), "opc-trajectory-"));
  try {
    const state = missionState();
    const registered = registerFindingBatch({
      findings: [artifactFinding()],
      criterionHashes: state.mission.criterionHashes,
    });
    state.findingRegistry = registered.registry;
    state.evidenceReceipts.push({
      id: "EV-1",
      scenarioId: "SCENARIO-1",
      validatorType: "e2e",
      scope: "integrated",
      result: "PASS",
      satisfies: ["OUT-1"],
      artifactHashes: ["artifact-sha"],
      strategyEpoch: 1,
    });
    const opened = openMissionGate({
      sessionDir: null,
      state,
      trigger: {
        reason: "REPEATED_CANONICAL_FINDING",
        classification: "ARTIFACT",
        findingRefs: [registered.findings[0].finding_ref],
      },
      now: "2026-08-15T12:00:00.000Z",
    });
    const sealed = sealPendingMissionGate({ sessionDir: dir, state: opened.state });
    assert.equal(sealed.ok, true, sealed.error);
    assert.equal(sealed.state.currentNode, "review");
    assert.equal(sealed.state.trajectory.pending, true);
    assert.match(sealed.state.trajectory.pendingPacketSha256, /^[0-9a-f]{64}$/);
    assert.match(sealed.state.trajectory.pendingPacketProvenanceRecordHash, /^[0-9a-f]{64}$/);
    const disk = JSON.parse(readFileSync(join(dir, "trajectory-review-request.json"), "utf8"));
    assert.equal(disk.triggerId, sealed.state.trajectory.triggerId);
    assert.match(disk.reviewRequest.runId, /^mission-review-[0-9a-f]{24}$/);
    assert.deepEqual(disk.bindings, currentMissionBindings(state));
    assert.equal(disk.mission.owner, "Mission owner");
    assert.deepEqual(disk.mission.affectedParties, ["Users", "Maintainers"]);
    assert.equal(disk.mission.mode, "explore");
    assert.deepEqual(disk.mission.assumptions, state.mission.assumptions);
    assert.deepEqual(disk.mission.guardrails, state.mission.guardrails);
    assert.equal(disk.mission.exitAndSalvage, state.mission.exitAndSalvage);
    assert.equal(disk.triggerClassification, "ARTIFACT");
    assert.deepEqual(disk.allowedDecisions, [
      "CONTINUE_CURRENT", "RESHAPE_SMALLER", "RESTORE", "RECON", "HUMAN_REBET", "STOP_SALVAGE",
    ]);
    assert.equal(disk.findingSummary.count, 1);
    assert.deepEqual(disk.findingSummary.entries[0], state.findingRegistry[0]);
    assert.equal(disk.evidenceDelta.length, 1);
    assert.equal(disk.evidenceDelta[0].id, "EV-1");
    assert.match(disk.evidenceDelta[0].receiptSha256, /^[0-9a-f]{64}$/);
    assert.equal(disk.artifactSummary.manifestSha256, disk.bindings.artifactManifestSha256);
    assert.deepEqual(disk.artifactSummary.changedArtifactHashes, ["artifact-sha"]);
    assert.equal(sealed.state.trajectory.evidenceGateCursor, 1);
    assert.equal(validatePendingMissionGateSeal({ sessionDir: dir, state: sealed.state }).ok, true);

    disk.allowedDecisions = ["CONTINUE_CURRENT"];
    writeFileSync(join(dir, "trajectory-review-request.json"), `${JSON.stringify(disk, null, 2)}\n`);
    assert.match(
      validatePendingMissionGateSeal({ sessionDir: dir, state: sealed.state }).errors.join("; "),
      /differs from the signed pending packet/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a later gate packet contains only integrated evidence since the previous gate", () => {
  const state = missionState();
  state.evidenceReceipts.push({ id: "EV-1", scope: "integrated", result: "PASS", strategyEpoch: 1 });
  const first = openMissionGate({ state, trigger: { reason: "MISSION_CHECKPOINT" } }).state;
  first.trajectory.pending = false;
  first.trajectory.pendingPacket = null;
  first.evidenceReceipts[0].stale = true;
  first.mission.strategyEpoch = 2;
  first.evidenceReceipts.push({ id: "EV-2", scope: "integrated", result: "PASS", strategyEpoch: 2 });
  const second = openMissionGate({ state: first, trigger: { reason: "MISSION_CHECKPOINT" } });
  assert.deepEqual(second.packet.evidenceDelta.map(receipt => receipt.id), ["EV-2"]);
});

test("an expired frozen assumption opens an environment-level Mission Gate", () => {
  const state = missionState();
  const contract = {
    ...state.mission,
    assumptions: [{ id: "ASM-1", statement: "The API baseline is current.", freshUntil: "2026-08-14T00:00:00.000Z" }],
  };
  const decision = evaluateTrajectory({
    state,
    missionContract: contract,
    now: "2026-08-15T00:00:00.000Z",
  });
  assert.equal(decision.action, "OPEN_MISSION_GATE");
  assert.equal(decision.reason, "ASSUMPTION_EXPIRED");
  assert.deepEqual(decision.assumptionIds, ["ASM-1"]);
});

test("measured wall-time appetite opens a non-retryable Mission Gate", () => {
  const state = missionState();
  state._started_at = "2026-08-15T00:00:00.000Z";
  const decision = evaluateTrajectory({
    state,
    missionContract: {
      ...state.mission,
      appetite: { ...state.mission.appetite, maxWallTimeHours: 1 },
    },
    now: "2026-08-15T02:00:00.000Z",
  });
  assert.equal(decision.action, "OPEN_MISSION_GATE");
  assert.equal(decision.reason, "WALL_TIME_APPETITE_REACHED");
  assert.equal(decision.retryable, false);
});

function coldRouteReview(state, recommendation, runId) {
  return {
    schemaVersion: 1,
    triggerId: state.trajectory.pendingPacket.triggerId,
    reviewer: {
      runId: state.trajectory.pendingPacket.reviewRequest.runId,
      contextMode: "cold",
      provenanceRecordHash: `prov-${runId}`,
    },
    bindings: currentMissionBindings(state),
    classification: recommendation === "RESHAPE_SMALLER" ? "PLAN" : "ARTIFACT",
    realitySignals: [{ id: "SIG-1", status: "INSUFFICIENT", evidenceReceiptIds: [] }],
    recommendation,
    rationale: "Route the invariant at mission altitude.",
    localFixesIncluded: false,
  };
}

test("cold review validates signal settlement and the classification route matrix", () => {
  const opened = openMissionGate({
    state: missionState(),
    trigger: { reason: "PLAN_FINDING", findingRefs: ["FIND-8"] },
  }).state;
  const invalidRoute = coldRouteReview(opened, "CONTINUE_CURRENT", "mission-review-invalid-route");
  invalidRoute.classification = "GOAL_SPEC";
  assert.match(
    validateColdMissionReview({ state: opened, review: invalidRoute }).errors.join("; "),
    /invalid for GOAL_SPEC/,
  );

  const missingSignal = coldRouteReview(opened, "RESHAPE_SMALLER", "mission-review-missing-signal");
  missingSignal.realitySignals = [];
  assert.match(
    validateColdMissionReview({ state: opened, review: missingSignal }).errors.join("; "),
    /SIG-1.*not settled/,
  );

  const unsupportedClaim = coldRouteReview(opened, "RESHAPE_SMALLER", "mission-review-unsupported-claim");
  unsupportedClaim.realitySignals[0] = { id: "SIG-1", status: "SUPPORTS", evidenceReceiptIds: [] };
  assert.match(
    validateColdMissionReview({ state: opened, review: unsupportedClaim }).errors.join("; "),
    /SUPPORTS requires current evidence/,
  );

  const artifactOpened = openMissionGate({
    state: missionState(),
    trigger: { reason: "REPEATED_CANONICAL_FINDING", classification: "ARTIFACT", findingRefs: ["FIND-1"] },
  }).state;
  const reclassified = coldRouteReview(artifactOpened, "RESHAPE_SMALLER", "mission-review-reclassify");
  assert.equal(reclassified.classification, "PLAN");
  assert.equal(validateColdMissionReview({ state: artifactOpened, review: reclassified }).ok, true);
});

test("one canonical invariant cannot receive a second CONTINUE_CURRENT retry", () => {
  const opened = openMissionGate({
    state: missionState(),
    trigger: { reason: "REPEATED_CANONICAL_FINDING", findingRefs: ["FIND-1"] },
  }).state;
  const first = applyMissionDecision({
    state: opened,
    action: "CONTINUE_CURRENT",
    actor: "agent",
    review: coldRouteReview(opened, "CONTINUE_CURRENT", "mission-review-1"),
  });
  assert.equal(first.ok, true);
  const reopened = openMissionGate({
    state: first.state,
    trigger: { reason: "REPEATED_CANONICAL_FINDING", findingRefs: ["FIND-1"] },
  }).state;
  const second = applyMissionDecision({
    state: reopened,
    action: "CONTINUE_CURRENT",
    actor: "agent",
    review: coldRouteReview(reopened, "CONTINUE_CURRENT", "mission-review-2"),
  });
  assert.equal(second.ok, false);
  assert.match(second.errors.join("; "), /already granted/);
});

test("a canonical invariant surviving one agent reshape requires human re-bet or stop", () => {
  const opened = openMissionGate({
    state: missionState(),
    trigger: { reason: "PLAN_FINDING", findingRefs: ["FIND-9"] },
  }).state;
  const reshaped = applyMissionDecision({
    state: opened,
    action: "RESHAPE_SMALLER",
    actor: "agent",
    review: coldRouteReview(opened, "RESHAPE_SMALLER", "mission-review-plan-1"),
  });
  assert.equal(reshaped.ok, true);
  const reopened = openMissionGate({
    state: reshaped.state,
    trigger: { reason: "REPEATED_CANONICAL_FINDING", findingRefs: ["FIND-9"] },
  }).state;
  const secondReshape = applyMissionDecision({
    state: reopened,
    action: "RESHAPE_SMALLER",
    actor: "agent",
    review: coldRouteReview(reopened, "RESHAPE_SMALLER", "mission-review-plan-2"),
  });
  assert.equal(secondReshape.ok, false);
  assert.match(secondReshape.errors.join("; "), /survived its one agent reshape/);
});

function finalReviewFor(state) {
  const packet = createTrajectoryPacket({
    state,
    trigger: { triggerId: "TRJ-1", reason: "FINAL_REVIEW_REQUIRED", checkpoint: "before_finalize" },
  });
  state.trajectory.pending = true;
  state.trajectory.triggerId = packet.triggerId;
  state.trajectory.pendingPacket = packet;
  state.evidenceReceipts.push({
    id: "EV-17",
    scenarioId: "SCENARIO-1",
    scope: "integrated",
    result: "PASS",
    satisfies: ["OUT-1", "FLOOR-1"],
    strategyEpoch: 1,
  });
  // Evidence changed after packet creation, so refresh the pending binding.
  state.trajectory.pendingPacket.bindings = currentMissionBindings(state);
  return {
    schemaVersion: 1,
    triggerId: "TRJ-1",
    reviewer: {
      runId: state.trajectory.pendingPacket.reviewRequest.runId,
      contextMode: "cold",
      provenanceRecordHash: "prov-1",
    },
    bindings: currentMissionBindings(state),
    classification: "NONE",
    realitySignals: [{ id: "SIG-1", status: "SUPPORTS", evidenceReceiptIds: ["EV-17"] }],
    recommendation: "CONTINUE_CURRENT",
    localFixesIncluded: false,
  };
}

test("cold review rejects stale bindings and final success without supported reality signals", () => {
  const state = missionState();
  const review = finalReviewFor(state);
  assert.equal(validateColdMissionReview({ state, review, requireFinalPass: true }).ok, true);

  const uncovered = structuredClone(state);
  uncovered.evidenceReceipts[0].satisfies = ["OUT-1"];
  uncovered.trajectory.pendingPacket.bindings = currentMissionBindings(uncovered);
  const uncoveredReview = structuredClone(review);
  uncoveredReview.bindings = currentMissionBindings(uncovered);
  assert.match(
    validateColdMissionReview({ state: uncovered, review: uncoveredReview, requireFinalPass: true }).errors.join("; "),
    /FLOOR-1.*lacks current integrated PASS evidence/,
  );

  const stale = structuredClone(review);
  stale.bindings.planSha256 = "stale";
  assert.equal(validateColdMissionReview({ state, review: stale, requireFinalPass: true }).ok, false);

  const insufficient = structuredClone(review);
  insufficient.realitySignals[0] = { id: "SIG-1", status: "INSUFFICIENT", evidenceReceiptIds: [] };
  assert.equal(validateColdMissionReview({ state, review: insufficient, requireFinalPass: true }).ok, false);
});

test("final CONTINUE_CURRENT creates one bound checkpoint receipt instead of a retry", () => {
  const state = missionState();
  const review = finalReviewFor(state);
  const decision = applyMissionDecision({
    state,
    action: "CONTINUE_CURRENT",
    actor: "agent",
    review,
    decisionEventId: "DEC-1",
    now: "2026-08-15T12:10:00.000Z",
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.state.trajectory.retryAllowance, 0);
  assert.equal(decision.state.trajectory.pending, false);
  assert.equal(hasCurrentFinalCheckpoint(decision.state), true);
});

test("a final checkpoint is invalidated by a tracked workspace change", () => {
  const root = mkdtempSync(join(tmpdir(), "opc-artifact-manifest-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "opc@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "OPC Test"], { cwd: root });
    const tracked = join(root, "artifact.txt");
    writeFileSync(tracked, "reviewed bytes\n");
    execFileSync("git", ["add", "artifact.txt"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root });

    const state = missionState();
    state.projectRoot = root;
    const bindings = currentMissionBindings(state);
    assert.match(bindings.artifactManifestSha256, /^[0-9a-f]{64}$/);
    state.checkpointReceipts.push({
      checkpointId: "before_finalize",
      ...bindings,
      missionReviewSha256: "review-sha",
      provenanceRecordHash: "provenance-sha",
    });
    assert.equal(hasCurrentFinalCheckpoint(state), true);
    writeFileSync(tracked, "changed after review\n");
    assert.equal(hasCurrentFinalCheckpoint(state), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a final checkpoint is invalidated when a declared evidence artifact changes", () => {
  const root = mkdtempSync(join(tmpdir(), "opc-declared-artifact-"));
  try {
    const artifact = join(root, "evidence.json");
    writeFileSync(artifact, '{"exitCode":0}\n');
    const state = missionState();
    state.projectRoot = root;
    state.artifacts = [artifact];
    const bindings = currentMissionBindings(state);
    state.checkpointReceipts.push({
      checkpointId: "before_finalize",
      ...bindings,
      missionReviewSha256: "review-sha",
      provenanceRecordHash: "provenance-sha",
    });
    assert.equal(hasCurrentFinalCheckpoint(state), true);
    writeFileSync(artifact, '{"exitCode":1}\n');
    assert.equal(hasCurrentFinalCheckpoint(state), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-retryable appetite gates cannot grant CONTINUE_CURRENT", () => {
  const state = missionState();
  const packet = createTrajectoryPacket({
    state,
    trigger: { triggerId: "TRJ-HARD", reason: "APPETITE_EXPIRED", retryable: false },
  });
  state.trajectory.pending = true;
  state.trajectory.triggerId = packet.triggerId;
  state.trajectory.pendingPacket = packet;
  assert.deepEqual(packet.allowedDecisions, ["HUMAN_REBET", "STOP_SALVAGE"]);
  const review = {
    schemaVersion: 1,
    triggerId: packet.triggerId,
    reviewer: {
      runId: packet.reviewRequest.runId,
      contextMode: "cold",
      provenanceRecordHash: "prov-hard",
    },
    bindings: currentMissionBindings(state),
    classification: "ARTIFACT",
    realitySignals: [{ id: "SIG-1", status: "INSUFFICIENT", evidenceReceiptIds: [] }],
    recommendation: "CONTINUE_CURRENT",
    localFixesIncluded: false,
  };
  const decision = applyMissionDecision({ state, action: "CONTINUE_CURRENT", actor: "agent", review });
  assert.equal(decision.ok, false);
  assert.match(decision.errors.join("; "), /non-retryable/);
});

test("trajectory evaluation stays bounded for 100 findings", () => {
  const state = missionState();
  const findings = Array.from({ length: 100 }, (_, i) => ({
    ...artifactFinding({ fingerprint: `finding-${i}`, invariant: `Invariant ${i}` }),
  }));
  const registered = registerFindingBatch({ findings, criterionHashes: state.mission.criterionHashes });
  const started = performance.now();
  const result = evaluateTrajectory({ state, findings: registered.findings, verdict: "FAIL" });
  const elapsed = performance.now() - started;
  assert.equal(result.action, "ALLOW_LOCAL");
  assert.ok(elapsed < 100, `evaluation took ${elapsed.toFixed(2)}ms`);
});

test("standard transition opens a durable Mission Gate on the second canonical artifact failure", () => {
  const sessionsBase = join(homedir(), ".opc", "sessions");
  mkdirSync(sessionsBase, { recursive: true });
  const dir = mkdtempSync(join(sessionsBase, "mission-transition-test-"));
  const harness = new URL("../opc-harness.mjs", import.meta.url).pathname;
  const missionPath = join(dir, "source-mission.json");
  const criteriaPath = join(dir, "acceptance-criteria.md");
  const outcomes = [
    "The repeated-finding scenario returns rebet_required=true on the second matching review failure.",
    "The first matching artifact review failure transitions from code-review to build.",
    "A blocked second review leaves currentNode equal to code-review and writes trajectory-review-request.json.",
  ];
  const runHarness = (command, args) => {
    try {
      const output = execFileSync("node", [harness, command, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return JSON.parse(output.trim().split("\n").at(-1));
    } catch (error) {
      const output = String(error.stdout || "").trim().split("\n").at(-1);
      return output ? JSON.parse(output) : { error: error.message, stderr: String(error.stderr || "") };
    }
  };
  const writeReview = (runId, role, prose) => {
    const runDir = join(dir, "nodes", "code-review", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, `eval-${role}.md`), [
      `# ${role} review`,
      "",
      "## Finding",
      "🔴 bin/lib/trajectory-gate.mjs:1 — the persisted total can diverge from the displayed total",
      "class: ARTIFACT",
      "criterion: OUT-1",
      "finding_ref: NEW",
      "fingerprint: checkout-total-rounding",
      "invariant: Displayed total equals the persisted total.",
      `Reasoning: ${prose}`,
      "Fix: Use the persisted precision for the displayed total.",
      "",
      "VERDICT: FAIL — FINDINGS[1]",
      "",
    ].join("\n"));
  };
  const writeAuthoritativeHandshake = (nodeId, handshake) => {
    const nodeDir = join(dir, "nodes", nodeId);
    const runDir = join(nodeDir, handshake.runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(nodeDir, "handshake.json"), JSON.stringify(handshake));
    writeFileSync(join(runDir, "handshake.json"), JSON.stringify({
      ...handshake,
      artifacts: handshake.artifacts.map(artifact => ({
        ...artifact,
        path: artifact.path.startsWith(`${handshake.runId}/`)
          ? artifact.path.slice(handshake.runId.length + 1)
          : artifact.path,
      })),
    }));
  };
  const writeReviewHandshake = (runId) => {
    const handshake = {
      nodeId: "code-review",
      nodeType: "review",
      runId,
      status: "completed",
      verdict: "FAIL",
      summary: "artifact invariant failed",
      timestamp: new Date().toISOString(),
      artifacts: [
        { type: "eval", path: `${runId}/eval-alpha.md` },
        { type: "eval", path: `${runId}/eval-beta.md` },
      ],
    };
    writeAuthoritativeHandshake("code-review", handshake);
  };

  try {
    writeFileSync(missionPath, JSON.stringify({
      schemaVersion: 1,
      version: 1,
      owner: "test-owner",
      affectedParties: ["test-user"],
      mode: "explore",
      originalRequest: "Exercise the standard Mission transition gate.",
      outcomes: outcomes.map((statement, index) => ({ id: `OUT-${index + 1}`, statement })),
      retiredCriteria: [],
      protectedFloors: [{ id: "FLOOR-1", statement: "Legacy mission-less transitions retain their existing behavior." }],
      nonGoals: ["Exercise finalization."],
      appetite: { maxRepairCycles: 8, maxTokens: null, maxWallTimeHours: null, expiresAt: null },
      endToEndScenario: {
        id: "SCENARIO-1",
        statement: "A repeated canonical review failure opens the Mission Gate.",
        validatorTypes: ["acceptance"],
      },
      realitySignals: [{ id: "SIG-1", required: true, observation: "The pending packet exists on disk." }],
      guardrails: [{ id: "GUARD-1", metric: "node mutation", actionThreshold: "Block before the second repair transition." }],
      checkpoints: [{ type: "before_finalize" }],
      assumptions: [],
      exitAndSalvage: "Preserve the packet and current node for a human decision.",
    }, null, 2));
    writeFileSync(criteriaPath, [
      "## Outcomes",
      ...outcomes.map((statement, index) => `- OUT-${index + 1}: ${statement}`),
      "",
      "## Verification",
      "- OUT-1: Assert the second response contains rebet_required=true.",
      "- OUT-2: Assert the first response returns allowed=true and currentNode becomes build.",
      "- OUT-3: Assert currentNode equals code-review and the packet file exists.",
      "",
      "## Quality Constraints",
      "- The test uses the real standard transition command.",
      "",
      "## Out of Scope",
      "- Finalization decisions.",
      "",
    ].join("\n"));

    const initialized = runHarness("init", [
      "--flow", "build-verify", "--entry", "code-review", "--dir", dir,
      "--mission", missionPath, "--criteria", criteriaPath, "--no-extensions",
    ]);
    assert.equal(initialized.created, true, JSON.stringify(initialized));

    writeReview("run_1", "alpha", "The storage path rounds at a different precision than the view.");
    writeReview("run_1", "beta", "The view formatting loses precision before storage comparison.");
    writeReviewHandshake("run_1");
    const first = runHarness("transition", [
      "--from", "code-review", "--to", "build", "--verdict", "FAIL",
      "--flow", "build-verify", "--dir", dir, "--no-extensions",
    ]);
    assert.equal(first.allowed, true, JSON.stringify(first));

    writeAuthoritativeHandshake("build", {
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "local repair completed",
      timestamp: new Date().toISOString(),
      artifacts: [],
    });
    const returned = runHarness("transition", [
      "--from", "build", "--to", "code-review", "--verdict", "PASS",
      "--flow", "build-verify", "--dir", dir, "--no-extensions",
    ]);
    assert.equal(returned.allowed, true, JSON.stringify(returned));

    writeReview(returned.runId, "alpha", "The repair still compares values after applying different precision rules.");
    writeReview(returned.runId, "beta", "The second review observes the same persisted-versus-displayed invariant failure.");
    writeReviewHandshake(returned.runId);
    const second = runHarness("transition", [
      "--from", "code-review", "--to", "build", "--verdict", "FAIL",
      "--flow", "build-verify", "--dir", dir, "--no-extensions",
    ]);
    const state = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
    assert.equal(second.allowed, false, JSON.stringify(second));
    assert.equal(second.rebet_required, true, JSON.stringify(second));
    assert.equal(second.trajectoryReason, "REPEATED_CANONICAL_FINDING", JSON.stringify(second));
    assert.equal(state.currentNode, "code-review");
    assert.equal(state.trajectory.pending, true);
    assert.equal(existsSync(join(dir, "trajectory-review-request.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
