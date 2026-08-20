import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const TEST_BASE = join(homedir(), ".opc", "sessions");
mkdirSync(TEST_BASE, { recursive: true });
const KEY_DIR = mkdtempSync(join(TEST_BASE, "mission-decision-key-"));
process.env.OPC_PROVENANCE_KEY_FILE = join(KEY_DIR, "key");

const {
  cmdMissionDecision,
  cmdRecordMissionReview,
  missionReviewClaimsSha256,
  selectLoopResumeCursor,
} = await import("./mission-decision.mjs");
const {
  guardMissionMutation,
  prepareMissionState,
  sealMissionRuntimeState,
} = await import("./mission-contract.mjs");
const { cmdRecordCommit } = await import("./flow-core.mjs");
const { cmdStop } = await import("./flow-escape.mjs");
const {
  currentMissionBindings,
  openMissionGate,
  sealPendingMissionGate,
} = await import("./trajectory-gate.mjs");
const { appendProvenanceEvent, findProvenanceEvent } = await import("./provenance-ledger.mjs");
const { parsePlan } = await import("./loop-helpers.mjs");

const REQUEST = "Preserve this exact mission request.";

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

function mission(overrides = {}) {
  return {
    schemaVersion: 1,
    version: 1,
    owner: "Mission owner",
    affectedParties: ["Users", "Maintainers"],
    mode: "explore",
    originalRequest: REQUEST,
    outcomes: [
      { id: "OUT-1", statement: "A pending Mission Gate records one durable steering decision." },
      { id: "OUT-2", statement: "Invalid decisions leave the active state bytes unchanged." },
      { id: "OUT-3", statement: "A bounded retry cannot be granted twice by one decision." },
    ],
    retiredCriteria: [],
    protectedFloors: [{ id: "FLOOR-1", statement: "The original request hash never changes." }],
    nonGoals: ["Automatic evidence-graph construction"],
    appetite: { maxRepairCycles: 8, maxTokens: null, maxWallTimeHours: null, expiresAt: null },
    endToEndScenario: {
      id: "SCENARIO-1",
      statement: "Record a decision and verify the committed state.",
      validatorTypes: ["e2e", "acceptance"],
    },
    realitySignals: [{ id: "SIG-1", required: true, observation: "The state reflects the selected route." }],
    guardrails: [{ id: "GUARD-1", metric: "State atomicity", actionThreshold: "Pause on any mixed hash." }],
    checkpoints: [{ type: "before_finalize" }],
    assumptions: [{ id: "ASM-1", statement: "Local files are readable.", freshUntil: null }],
    exitAndSalvage: "Keep decision manifests and validated artifacts.",
    ...overrides,
  };
}

function criteria(doc = mission()) {
  return [
    "## Outcomes",
    ...doc.outcomes.map(item => `- ${item.id}: ${item.statement}`),
    "",
    "## Verification",
    ...doc.outcomes.map(item => `- ${item.id}: A deterministic test verifies ${item.id} state and hashes.`),
    "",
    "## Quality Constraints",
    "- Active state updates are atomic and deterministic.",
    "",
    "## Out of Scope",
    "- Automatic evidence-graph construction.",
    "",
    "## Quality Baseline (functional)",
    "- Deterministic module verification.",
    "",
  ].join("\n");
}

function plan(label = "first") {
  return [
    "## Task Scope",
    `- SCOPE-1: ${label} mission implementation`,
    "",
    "## Units",
    `- F1.1: implement — ${label} mission implementation`,
    "  - verify: node --test bin/lib/mission-decision.test.mjs",
    `- F1.2: review — review ${label} mission implementation`,
    "  - eval: verify the decision state and hashes",
    "- F1.3: e2e — exercise mission decision command",
    "  - verify: node --test bin/lib/mission-decision.test.mjs",
    "",
  ].join("\n");
}

function makeWritable(path) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    chmodSync(path, 0o600);
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeWritable(join(path, name));
}

function cleanup(root) {
  makeWritable(root);
  rmSync(root, { recursive: true, force: true });
}

after(() => cleanup(KEY_DIR));

function fixture({ loop = false, pending = true } = {}) {
  const root = mkdtempSync(join(TEST_BASE, "mission-decision-test-"));
  const session = join(root, "session");
  const projectRoot = join(root, "project");
  mkdirSync(session);
  mkdirSync(projectRoot);
  execFileSync("git", ["init", "-q"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.email", "mission-test@example.invalid"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.name", "Mission Test"], { cwd: projectRoot });
  writeFileSync(join(projectRoot, "artifact.txt"), "stable fixture\n");
  execFileSync("git", ["add", "artifact.txt"], { cwd: projectRoot });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: projectRoot });
  const contract = mission();
  const missionPath = join(root, "mission.json");
  const criteriaPath = join(session, "acceptance-criteria.md");
  const planPath = join(session, "plan.md");
  writeFileSync(missionPath, JSON.stringify(contract, null, 2) + "\n");
  writeFileSync(criteriaPath, criteria(contract));
  writeFileSync(planPath, plan());
  const prepared = prepareMissionState({ sessionDir: session, missionPath, criteriaPath, planPath });
  assert.equal(prepared.ok, true, prepared.errors?.join("\n"));
  let state = {
    ...(loop
      ? { tick: 0, next_unit: "F1.1", status: "initialized", plan_file: planPath, _tick_history: [] }
      : { currentNode: "gate", history: [], status: "in_progress" }),
    mission: prepared.mission,
    trajectory: prepared.trajectory,
    findingRegistry: prepared.findingRegistry,
    evidenceReceipts: prepared.evidenceReceipts,
    checkpointReceipts: prepared.checkpointReceipts,
    projectRoot,
    _written_by: "opc-harness",
    _write_nonce: "fixture",
  };
  if (pending) {
    state = openMissionGate({
      sessionDir: null,
      state,
      missionContract: contract,
      trigger: { reason: "MISSION_REVIEW_REQUIRED", findingRefs: ["FIND-1"], retryable: true },
    }).state;
    const sealed = sealPendingMissionGate({ sessionDir: session, state });
    assert.equal(sealed.ok, true, sealed.error);
    state = sealed.state;
  }
  const stateName = loop ? "loop-state.json" : "flow-state.json";
  const statePath = join(session, stateName);
  const runtimeSeal = sealMissionRuntimeState({
    sessionDir: session,
    state,
    statePath,
    reason: "test-fixture-init",
    allowUnsealed: true,
  });
  assert.equal(runtimeSeal.ok, true, runtimeSeal.error);
  state = runtimeSeal.state;
  return { root, session, statePath, state, contract, missionPath, criteriaPath, planPath, projectRoot };
}

function persistFixtureState(fx, state, reason) {
  const sealed = sealMissionRuntimeState({
    sessionDir: fx.session,
    state,
    statePath: fx.statePath,
    reason,
  });
  assert.equal(sealed.ok, true, sealed.error);
  fx.state = sealed.state;
  return sealed.state;
}

function coldReview(fx, recommendation, overrides = {}) {
  const runId = overrides.runId || fx.state.trajectory.pendingPacket.reviewRequest.runId;
  return {
    schemaVersion: 1,
    triggerId: fx.state.trajectory.triggerId,
    reviewer: { runId, contextMode: "cold" },
    bindings: currentMissionBindings(fx.state),
    classification: recommendation === "CONTINUE_CURRENT"
      ? "ARTIFACT"
      : new Set(["RECON", "RESTORE"]).has(recommendation) ? "ENVIRONMENT" : "PLAN",
    realitySignals: [{ id: "SIG-1", status: "INSUFFICIENT", evidenceReceiptIds: [] }],
    recommendation,
    rationale: "The cold evidence supports this bounded route.",
    localFixesIncluded: false,
    reviewedAt: new Date().toISOString(),
    ...overrides.review,
  };
}

function signedReview(fx, recommendation, overrides = {}) {
  const review = coldReview(fx, recommendation, overrides);
  const runId = review.reviewer.runId;
  const provenance = appendProvenanceEvent(fx.session, {
    type: "mission_review",
    runId,
    triggerId: review.triggerId,
    reviewClaimsSha256: missionReviewClaimsSha256(review),
  });
  review.reviewer.provenanceRecordHash = provenance.recordHash;
  return review;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  return path;
}

function intentBindings(fx, intent, action) {
  const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
  return {
    schemaVersion: 1,
    action,
    intentEventId: intent.intent_id,
    triggerId: state.trajectory.triggerId,
    missionSha256: state.mission.sha256,
    planSha256: state.mission.planSha256 ?? null,
    strategyEpoch: state.mission.strategyEpoch,
  };
}

function measuredGitStatusProbe(fx) {
  const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
  const command = ["git", "status", "--porcelain", "--untracked-files=all"];
  const measured = spawnSync(command[0], command.slice(1), {
    cwd: state.projectRoot, encoding: null, shell: false, stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    command,
    cwd: state.projectRoot,
    timeoutMs: 5000,
    exitCode: measured.status,
    stdoutSha256: sha256(measured.stdout || Buffer.alloc(0)),
    stderrSha256: sha256(measured.stderr || Buffer.alloc(0)),
  };
}

function reconBaseline(fx) {
  const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
  return {
    schemaVersion: 1,
    action: "RECON",
    type: "environment_baseline",
    triggerId: state.trajectory.triggerId,
    missionSha256: state.mission.sha256,
    planSha256: state.mission.planSha256 ?? null,
    strategyEpoch: state.mission.strategyEpoch,
    probe: measuredGitStatusProbe(fx),
  };
}

function invoke(args) {
  const original = console.log;
  console.log = () => {};
  try {
    return cmdMissionDecision(args);
  } finally {
    console.log = original;
  }
}

function invokeRecord(args) {
  const original = console.log;
  console.log = () => {};
  try {
    return cmdRecordMissionReview(args);
  } finally {
    console.log = original;
  }
}

function invokeRecordCommit(args) {
  const original = console.log;
  let output = null;
  console.log = value => { output = JSON.parse(value); };
  try {
    cmdRecordCommit(args);
    return output;
  } finally {
    console.log = original;
  }
}

function invokeStop(args) {
  const original = console.log;
  let output = null;
  console.log = value => { output = JSON.parse(value); };
  try {
    cmdStop(args);
    return output;
  } finally {
    console.log = original;
  }
}

test("public review recording seals claims for mission-decision", () => {
  const fx = fixture();
  try {
    const sourceReview = coldReview(fx, "CONTINUE_CURRENT");
    const sourcePath = writeJson(join(fx.root, "cold-review.json"), sourceReview);
    const recorded = invokeRecord(["--review", sourcePath, "--dir", fx.session]);
    assert.equal(recorded.recorded, true, recorded.error);
    assert.equal(existsSync(recorded.review), true);
    const sealed = JSON.parse(readFileSync(recorded.review, "utf8"));
    assert.equal(sealed.reviewer.provenanceRecordHash, recorded.provenance_record_hash);
    const event = findProvenanceEvent(fx.session, recorded.provenance_record_hash);
    assert.equal(event.ok, true, event.error);
    assert.equal(event.event.type, "mission_review");
    assert.equal(event.event.reviewClaimsSha256, missionReviewClaimsSha256(sealed));

    const duplicate = invokeRecord(["--review", sourcePath, "--dir", fx.session]);
    assert.equal(duplicate.recorded, true, duplicate.error);
    assert.equal(duplicate.already, true);
    assert.equal(duplicate.review, recorded.review);

    const decided = invoke([
      "--action", "CONTINUE_CURRENT", "--actor", "agent", "--review", recorded.review, "--dir", fx.session,
    ]);
    assert.equal(decided.decided, true, decided.error);
  } finally {
    cleanup(fx.root);
  }
});

test("review recording recovers an orphaned signed event without appending a second event", () => {
  const fx = fixture();
  try {
    const sourceReview = coldReview(fx, "CONTINUE_CURRENT");
    const sourcePath = writeJson(join(fx.root, "orphan-review.json"), sourceReview);
    const packet = JSON.parse(readFileSync(fx.statePath, "utf8")).trajectory.pendingPacket;
    const boundReview = structuredClone(sourceReview);
    boundReview.triggerContext = {
      reason: packet.reason || null,
      findingRefs: [...new Set(packet.findingRefs || [])].sort(),
      edgeKey: packet.edgeKey || null,
      evidenceDeltaSha256: sha256(Buffer.from(canonical(packet.evidenceDelta || []), "utf8")),
      environmentDeltaSha256: packet.environmentDelta?.sha256 || null,
    };
    const orphan = appendProvenanceEvent(fx.session, {
      type: "mission_review",
      runId: sourceReview.reviewer.runId,
      triggerId: sourceReview.triggerId,
      reviewClaimsSha256: missionReviewClaimsSha256(boundReview),
      sourceSha256: sha256(readFileSync(sourcePath)),
    });
    const recovered = invokeRecord(["--review", sourcePath, "--dir", fx.session]);
    assert.equal(recovered.recorded, true, recovered.error);
    assert.equal(recovered.provenance_record_hash, orphan.recordHash);
    assert.equal(existsSync(recovered.review), true);
    const events = readFileSync(join(fx.session, ".opc-provenance.jsonl"), "utf8")
      .split(/\n/).filter(Boolean).map(line => JSON.parse(line))
      .filter(record => record.type === "mission_review" && record.triggerId === sourceReview.triggerId);
    assert.equal(events.length, 1);
  } finally {
    cleanup(fx.root);
  }
});

test("CONTINUE_CURRENT commits one retry and cannot be applied twice", () => {
  const fx = fixture();
  try {
    const reviewPath = writeJson(join(fx.root, "review.json"), signedReview(fx, "CONTINUE_CURRENT"));
    const decided = invoke(["--action", "CONTINUE_CURRENT", "--actor", "agent", "--review", reviewPath, "--dir", fx.session]);
    assert.equal(decided.decided, true, decided.error);
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.trajectory.pending, false);
    assert.equal(state.trajectory.retryAllowance, 1);
    assert.match(state.mission.decisionManifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(existsSync(join(fx.session, decided.manifest)), true);
    const manifest = JSON.parse(readFileSync(join(fx.session, decided.manifest), "utf8"));
    assert.equal(manifest.intendedStateDelta.trajectory.retryAllowance, 1);
    assert.match(manifest.files.review.sha256, /^[0-9a-f]{64}$/);
    assert.equal(findProvenanceEvent(fx.session, decided.event_id).event.type, "decision_prepared");

    const beforeSecond = readFileSync(fx.statePath);
    const second = invoke(["--action", "CONTINUE_CURRENT", "--actor", "agent", "--review", reviewPath, "--dir", fx.session]);
    assert.equal(second.decided, false);
    assert.match(second.error, /no Mission Gate is pending/);
    assert.deepEqual(readFileSync(fx.statePath), beforeSecond);
  } finally {
    cleanup(fx.root);
  }
});

test("the next protected mutation authenticates the committed decision manifest", () => {
  const fx = fixture();
  try {
    const reviewPath = writeJson(join(fx.root, "review.json"), signedReview(fx, "CONTINUE_CURRENT"));
    const decided = invoke(["--action", "CONTINUE_CURRENT", "--actor", "agent", "--review", reviewPath, "--dir", fx.session]);
    assert.equal(decided.decided, true, decided.error);
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    const manifestPath = join(fx.session, state.mission.decisionManifestPath);

    chmodSync(manifestPath, 0o600);
    writeFileSync(manifestPath, `${readFileSync(manifestPath, "utf8")}\n`);
    const guarded = guardMissionMutation({ sessionDir: fx.session, state, command: "transition" });
    assert.equal(guarded.allowed, false);
    assert.match(guarded.reason, /decision manifest hash mismatch/);
  } finally {
    cleanup(fx.root);
  }
});

test("STOP_SALVAGE works for a human and records terminal state", () => {
  const fx = fixture();
  try {
    const decided = invoke(["--action", "STOP_SALVAGE", "--actor", "human", "--note", "retain artifacts", "--dir", fx.session]);
    assert.equal(decided.decided, true, decided.error);
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.status, "stopped");
    assert.equal(state.trajectory.pending, false);
    assert.equal(state.trajectory.lastDecision.action, "STOP_SALVAGE");
    assert.equal(state.trajectory.terminal, true);
    assert.equal(state.trajectory.terminalAction, "STOP_SALVAGE");
    assert.equal(decided.exit_and_salvage, fx.contract.exitAndSalvage);
    assert.equal(state.trajectory.salvageInstructions, fx.contract.exitAndSalvage);
    const guarded = guardMissionMutation({ sessionDir: fx.session, state, command: "finalize", allowPending: true });
    assert.equal(guarded.allowed, false);
    assert.match(guarded.reason, /absorbing/);
    const beforeCommit = readFileSync(fx.statePath);
    const commit = invokeRecordCommit(["--sha", "HEAD", "--dir", fx.session]);
    assert.equal(commit.recorded, false);
    assert.equal(commit.error, "flow is stopped - record-commit cannot mutate state");
    assert.deepEqual(readFileSync(fx.statePath), beforeCommit);
    const stoppedAgain = invokeStop(["--dir", fx.session]);
    assert.equal(stoppedAgain.stopped, false);
    assert.match(stoppedAgain.error, /absorbing/);
    assert.deepEqual(readFileSync(fx.statePath), beforeCommit);
    const repeated = invoke(["--action", "STOP_SALVAGE", "--actor", "human", "--dir", fx.session]);
    assert.equal(repeated.decided, false);
    assert.match(repeated.error, /absorbing/);
  } finally {
    cleanup(fx.root);
  }
});

test("invalid action and invalid actor leave active state bytes unchanged", () => {
  const fx = fixture();
  try {
    const before = readFileSync(fx.statePath);
    assert.equal(invoke(["--action", "BOGUS", "--actor", "agent", "--dir", fx.session]).decided, false);
    assert.deepEqual(readFileSync(fx.statePath), before);
    assert.equal(invoke(["--action", "STOP_SALVAGE", "--actor", "robot", "--dir", fx.session]).decided, false);
    assert.deepEqual(readFileSync(fx.statePath), before);
  } finally {
    cleanup(fx.root);
  }
});

test("stale review and missing signed provenance are rejected without state mutation", async (t) => {
  await t.test("stale binding", () => {
    const fx = fixture();
    try {
      const review = signedReview(fx, "CONTINUE_CURRENT");
      review.bindings.strategyEpoch += 1;
      const path = writeJson(join(fx.root, "stale.json"), review);
      const before = readFileSync(fx.statePath);
      const result = invoke(["--action", "CONTINUE_CURRENT", "--actor", "agent", "--review", path, "--dir", fx.session]);
      assert.equal(result.decided, false);
      assert.match(result.error, /strategyEpoch.*stale or mismatched/);
      assert.deepEqual(readFileSync(fx.statePath), before);
    } finally {
      cleanup(fx.root);
    }
  });

  await t.test("missing provenance", () => {
    const fx = fixture();
    try {
      const review = signedReview(fx, "CONTINUE_CURRENT");
      review.reviewer.provenanceRecordHash = "0".repeat(64);
      const path = writeJson(join(fx.root, "unsigned.json"), review);
      const before = readFileSync(fx.statePath);
      const result = invoke(["--action", "CONTINUE_CURRENT", "--actor", "agent", "--review", path, "--dir", fx.session]);
      assert.equal(result.decided, false);
      assert.match(result.error, /provenance/);
      assert.deepEqual(readFileSync(fx.statePath), before);
    } finally {
      cleanup(fx.root);
    }
  });
});

test("a review runId reused by flow history is rejected", () => {
  const fx = fixture();
  try {
    const review = signedReview(fx, "CONTINUE_CURRENT", { runId: "run_1" });
    let state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    state.history.push({ nodeId: "review", runId: "run_1" });
    state = persistFixtureState(fx, state, "test-history-update");
    review.bindings = currentMissionBindings(state);
    const path = writeJson(join(fx.root, "reused.json"), review);
    const before = readFileSync(fx.statePath);
    const result = invoke(["--action", "CONTINUE_CURRENT", "--actor", "agent", "--review", path, "--dir", fx.session]);
    assert.equal(result.decided, false);
    assert.match(result.error, /runId was already used/);
    assert.deepEqual(readFileSync(fx.statePath), before);
  } finally {
    cleanup(fx.root);
  }
});

test("RESHAPE_SMALLER stages and pins a validated plan and increments epoch", () => {
  const fx = fixture({ loop: true });
  try {
    fx.state.tick = 2;
    fx.state.next_unit = "F1.3";
    fx.state._tick_history = [
      { unit: "F1.1", tick: 1, status: "completed" },
      { unit: "F1.2", tick: 2, status: "completed" },
    ];
    fx.state.evidenceReceipts.push({
      id: "EV-1", scope: "integrated", result: "PASS", satisfies: ["OUT-1"], strategyEpoch: 1,
    });
    fx.state.trajectory.pending = false;
    fx.state.trajectory.pendingPacket = null;
    fx.state.trajectory.pendingPacketSha256 = null;
    fx.state.trajectory.pendingPacketProvenanceRecordHash = null;
    fx.state = openMissionGate({
      sessionDir: null,
      state: fx.state,
      missionContract: fx.contract,
      trigger: { reason: "PLAN_FINDING", classification: "PLAN", findingRefs: ["FIND-1"], retryable: true },
    }).state;
    const resealed = sealPendingMissionGate({ sessionDir: fx.session, state: fx.state });
    assert.equal(resealed.ok, true, resealed.error);
    fx.state = resealed.state;
    persistFixtureState(fx, fx.state, "test-reshape-setup");
    const reviewPath = writeJson(join(fx.root, "review.json"), signedReview(fx, "RESHAPE_SMALLER"));
    const revisedPlan = join(fx.root, "revised-plan.md");
    writeFileSync(revisedPlan, plan().replace(
      "- F1.2: review — review first mission implementation",
      [
        "- F1.1a: review — inspect the newly inserted boundary",
        "  - eval: verify the inserted boundary before continuing",
        "- F1.2: review — review first mission implementation",
      ].join("\n"),
    ));
    const decided = invoke([
      "--action", "RESHAPE_SMALLER", "--actor", "agent", "--review", reviewPath,
      "--plan", revisedPlan, "--dir", fx.session,
    ]);
    assert.equal(decided.decided, true, decided.error);
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.mission.strategyEpoch, 2);
    assert.equal(state.mission.planSha256, sha256(readFileSync(revisedPlan)));
    assert.match(state.mission.planPath, /^decisions\/DEC-/);
    assert.equal(state.plan_file, join(fx.session, state.mission.planPath));
    assert.match(state._plan_hash, /^[0-9a-f]{16}$/);
    assert.equal(state.trajectory.pending, false);
    assert.equal(state.status, "initialized");
    assert.equal(state.evidenceReceipts[0].stale, true);
    assert.equal(decided.resume_unit, "F1.1a");
    assert.equal(state.next_unit, "F1.1a");
    assert.equal(state.unit, "F1.1");
    assert.deepEqual(state.mission.planResume, {
      completedPrefixLength: 1,
      resumeUnit: "F1.1a",
      allComplete: false,
    });
    assert.equal(state._tick_history[0].stale, undefined);
    assert.equal(state._tick_history[1].stale, true);
  } finally {
    cleanup(fx.root);
  }
});

test("loop lineage selection detects edits, reorder, insertion, and an all-complete prefix", () => {
  const oldUnits = parsePlan(plan());
  const completeHistory = oldUnits.map((unit, index) => ({ unit: unit.id, tick: index + 1, status: "completed" }));
  assert.deepEqual(selectLoopResumeCursor({ oldUnits, newUnits: oldUnits, tickHistory: completeHistory }), {
    prefixLength: oldUnits.length,
    resumeUnit: null,
    allComplete: true,
    reusableTickIndexes: [0, 1, 2],
    priorUnit: "F1.3",
  });

  const edited = structuredClone(oldUnits);
  edited[1].description = "changed review definition";
  assert.equal(selectLoopResumeCursor({ oldUnits, newUnits: edited, tickHistory: completeHistory }).resumeUnit, "F1.2");

  const reordered = [oldUnits[1], oldUnits[0], oldUnits[2]];
  assert.equal(selectLoopResumeCursor({ oldUnits, newUnits: reordered, tickHistory: completeHistory }).resumeUnit, "F1.2");

  const inserted = [oldUnits[0], { ...oldUnits[1], id: "F1.1a" }, ...oldUnits.slice(1)];
  const insertion = selectLoopResumeCursor({ oldUnits, newUnits: inserted, tickHistory: completeHistory });
  assert.equal(insertion.prefixLength, 1);
  assert.equal(insertion.resumeUnit, "F1.1a");
});

test("human steering can open its own Mission Gate before reshaping", () => {
  const fx = fixture({ loop: true, pending: false });
  try {
    const revisedPlan = join(fx.root, "human-plan.md");
    writeFileSync(revisedPlan, plan("human-directed smaller"));
    const decided = invoke([
      "--action", "RESHAPE_SMALLER", "--actor", "human", "--plan", revisedPlan,
      "--note", "Human observed global drift", "--dir", fx.session,
    ]);
    assert.equal(decided.decided, true, decided.error);
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.trajectory.lastDecision.action, "RESHAPE_SMALLER");
    assert.equal(state.trajectory.pending, false);
    assert.equal(state.mission.strategyEpoch, 2);
    const manifest = JSON.parse(readFileSync(join(fx.session, decided.manifest), "utf8"));
    assert.match(manifest.triggerId, /^TRJ-/);
    assert.equal(manifest.files.plan.sha256, state.mission.planSha256);
  } finally {
    cleanup(fx.root);
  }
});

test("RESHAPE_SMALLER rejects an invalid loop plan without changing state", () => {
  const fx = fixture({ loop: true });
  try {
    const reviewPath = writeJson(join(fx.root, "review.json"), signedReview(fx, "RESHAPE_SMALLER"));
    const beforeNoop = readFileSync(fx.statePath);
    const noop = invoke([
      "--action", "RESHAPE_SMALLER", "--actor", "agent", "--review", reviewPath,
      "--plan", fx.planPath, "--dir", fx.session,
    ]);
    assert.equal(noop.decided, false);
    assert.match(noop.error, /requires a changed plan/);
    assert.deepEqual(readFileSync(fx.statePath), beforeNoop);

    const badPlan = join(fx.root, "bad-plan.md");
    writeFileSync(badPlan, "- F1.1: implement — no review follows\n");
    const before = readFileSync(fx.statePath);
    const decided = invoke([
      "--action", "RESHAPE_SMALLER", "--actor", "agent", "--review", reviewPath,
      "--plan", badPlan, "--dir", fx.session,
    ]);
    assert.equal(decided.decided, false);
    assert.match(decided.error, /no review unit follows/);
    assert.deepEqual(readFileSync(fx.statePath), before);
  } finally {
    cleanup(fx.root);
  }
});

test("HUMAN_REBET requires approval, preserves request hash, and commits matched mission/criteria", () => {
  const fx = fixture();
  try {
    const intent = invoke(["--action", "HUMAN_REBET", "--actor", "human", "--phase", "intent", "--dir", fx.session]);
    assert.equal(intent.decided, true, intent.error);
    assert.equal(intent.pending, true);
    assert.ok(intent.intent_id);

    const oldStatement = fx.contract.outcomes[0].statement;
    const revised = mission({
      version: 2,
      outcomes: [
        fx.contract.outcomes[1],
        fx.contract.outcomes[2],
        { id: "OUT-4", statement: "Human approval records the revised observable outcome." },
      ],
      retiredCriteria: [{ id: "OUT-1", statementSha256: sha256(Buffer.from(oldStatement)) }],
    });
    const revisedMission = writeJson(join(fx.root, "revised-mission.json"), revised);
    const revisedCriteria = join(fx.root, "revised-criteria.md");
    writeFileSync(revisedCriteria, criteria(revised));
    const approval = join(fx.root, "approval.txt");
    writeFileSync(approval, "I approve replacing OUT-1 with OUT-4.\n");

    const beforeMissingApproval = readFileSync(fx.statePath);
    const rejected = invoke([
      "--action", "HUMAN_REBET", "--actor", "human", "--phase", "resume", "--intent", intent.intent_id,
      "--mission", revisedMission, "--criteria", revisedCriteria, "--dir", fx.session,
    ]);
    assert.equal(rejected.decided, false);
    assert.match(rejected.error, /require --approval/);
    assert.deepEqual(readFileSync(fx.statePath), beforeMissingApproval);

    const decided = invoke([
      "--action", "HUMAN_REBET", "--actor", "human", "--phase", "resume", "--intent", intent.intent_id,
      "--mission", revisedMission, "--criteria", revisedCriteria, "--approval", approval, "--dir", fx.session,
    ]);
    assert.equal(decided.decided, true, decided.error);
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.trajectory.pending, false);
    assert.equal(state.mission.version, 2);
    assert.equal(state.mission.strategyEpoch, 2);
    assert.equal(state.mission.originalRequestSha256, fx.state.mission.originalRequestSha256);
    assert.equal(Object.hasOwn(state.mission.criterionHashes, "OUT-1"), false);
    assert.equal(Object.hasOwn(state.mission.criterionHashes, "OUT-4"), true);
    const manifest = JSON.parse(readFileSync(join(fx.session, decided.manifest), "utf8"));
    assert.equal(manifest.files.approval.sha256, sha256(readFileSync(approval)));
  } finally {
    cleanup(fx.root);
  }
});

test("a retired criterion cannot be reactivated by a later contract version", () => {
  const fx = fixture();
  try {
    const firstIntent = invoke([
      "--action", "HUMAN_REBET", "--actor", "human", "--phase", "intent", "--dir", fx.session,
    ]);
    assert.equal(firstIntent.decided, true, firstIntent.error);

    const retiredStatement = fx.contract.outcomes[0].statement;
    const version2 = mission({
      version: 2,
      outcomes: [
        fx.contract.outcomes[1],
        fx.contract.outcomes[2],
        { id: "OUT-4", statement: "A revised mission keeps retired criterion history durable." },
      ],
      retiredCriteria: [{ id: "OUT-1", statementSha256: sha256(Buffer.from(retiredStatement)) }],
    });
    const version2Mission = writeJson(join(fx.root, "mission-v2.json"), version2);
    const version2Criteria = join(fx.root, "criteria-v2.md");
    writeFileSync(version2Criteria, criteria(version2));
    const approval = join(fx.root, "approval.txt");
    writeFileSync(approval, "I approve retiring OUT-1 in mission version 2.\n");
    const committed = invoke([
      "--action", "HUMAN_REBET", "--actor", "human", "--phase", "resume",
      "--intent", firstIntent.intent_id, "--mission", version2Mission, "--criteria", version2Criteria,
      "--approval", approval, "--dir", fx.session,
    ]);
    assert.equal(committed.decided, true, committed.error);

    const secondIntent = invoke([
      "--action", "HUMAN_REBET", "--actor", "human", "--phase", "intent", "--dir", fx.session,
    ]);
    assert.equal(secondIntent.decided, true, secondIntent.error);
    const version3 = mission({
      version: 3,
      outcomes: [
        { id: "OUT-1", statement: "OUT-1 has been silently assigned a new meaning." },
        version2.outcomes[0],
        version2.outcomes[1],
        version2.outcomes[2],
      ],
      retiredCriteria: [],
    });
    const version3Mission = writeJson(join(fx.root, "mission-v3.json"), version3);
    const version3Criteria = join(fx.root, "criteria-v3.md");
    writeFileSync(version3Criteria, criteria(version3));
    writeFileSync(approval, "I approve mission version 3.\n");
    const before = readFileSync(fx.statePath);
    const rejected = invoke([
      "--action", "HUMAN_REBET", "--actor", "human", "--phase", "resume",
      "--intent", secondIntent.intent_id, "--mission", version3Mission, "--criteria", version3Criteria,
      "--approval", approval, "--dir", fx.session,
    ]);
    assert.equal(rejected.decided, false);
    assert.match(rejected.error, /retired criterion 'OUT-1' cannot be reactivated/);
    assert.deepEqual(readFileSync(fx.statePath), before);
  } finally {
    cleanup(fx.root);
  }
});

test("two-phase intent stays pending and mismatched resume is rejected", () => {
  const fx = fixture();
  try {
    const intent = invoke(["--action", "RESTORE", "--actor", "human", "--phase", "intent", "--dir", fx.session]);
    assert.equal(intent.decided, true, intent.error);
    assert.equal(intent.pending, true);
    assert.equal(intent.intent_id, intent.event_id);
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.trajectory.pendingAction, "RESTORE");
    assert.equal(state.trajectory.pendingActionEventId, intent.intent_id);

    const before = readFileSync(fx.statePath);
    const rejected = invoke([
      "--action", "RECON", "--actor", "human", "--phase", "resume", "--intent", intent.intent_id,
      "--dir", fx.session,
    ]);
    assert.equal(rejected.decided, false);
    assert.match(rejected.error, /does not match/);
    assert.deepEqual(readFileSync(fx.statePath), before);
  } finally {
    cleanup(fx.root);
  }
});

test("STOP_SALVAGE can supersede a pending two-phase intent", () => {
  const fx = fixture({ loop: true });
  try {
    const intent = invoke([
      "--action", "RESTORE", "--actor", "human", "--phase", "intent", "--dir", fx.session,
    ]);
    assert.equal(intent.decided, true, intent.error);
    const stopped = invoke([
      "--action", "STOP_SALVAGE", "--actor", "human", "--note", "preserve the staged intent",
      "--dir", fx.session,
    ]);
    assert.equal(stopped.decided, true, stopped.error);
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.status, "terminated");
    assert.equal(state.trajectory.pending, false);
    assert.equal(state.trajectory.lastSupersededIntent.action, "RESTORE");
    assert.equal(state.trajectory.lastSupersededIntent.eventId, intent.intent_id);
    assert.match(state.trajectory.lastSupersededIntent.supersededAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    cleanup(fx.root);
  }
});

test("RESTORE resume requires bound evidence and restores the selected loop unit", () => {
  const fx = fixture({ loop: true });
  try {
    const intent = invoke(["--action", "RESTORE", "--actor", "human", "--phase", "intent", "--dir", fx.session]);
    assert.equal(intent.decided, true, intent.error);
    const evidencePath = join(fx.root, "restore-evidence.json");
    writeJson(evidencePath, {
      ...intentBindings(fx, intent, "RESTORE"),
      type: "restore",
      gitTreeSha: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: fx.projectRoot, encoding: "utf8" }).trim(),
    });
    const beforeNoop = readFileSync(fx.statePath);
    const noop = invoke([
      "--action", "RESTORE", "--actor", "human", "--phase", "resume", "--intent", intent.intent_id,
      "--evidence", evidencePath, "--resume-unit", "F1.1", "--dir", fx.session,
    ]);
    assert.equal(noop.decided, false);
    assert.match(noop.error, /clean tree change from the intent baseline/);
    assert.deepEqual(readFileSync(fx.statePath), beforeNoop);
    writeFileSync(join(fx.projectRoot, "artifact.txt"), "restored target fixture\n");
    execFileSync("git", ["add", "artifact.txt"], { cwd: fx.projectRoot });
    execFileSync("git", ["commit", "-q", "-m", "restore target"], { cwd: fx.projectRoot });
    const restoreEvidence = {
      ...intentBindings(fx, intent, "RESTORE"),
      type: "restore",
      gitTreeSha: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: fx.projectRoot, encoding: "utf8" }).trim(),
    };
    writeJson(evidencePath, { ...restoreEvidence, gitTreeSha: "0".repeat(40) });
    const beforeRejected = readFileSync(fx.statePath);
    const rejected = invoke([
      "--action", "RESTORE", "--actor", "human", "--phase", "resume", "--intent", intent.intent_id,
      "--evidence", evidencePath, "--resume-unit", "F1.1", "--dir", fx.session,
    ]);
    assert.equal(rejected.decided, false);
    assert.match(rejected.error, /active Git tree/);
    assert.deepEqual(readFileSync(fx.statePath), beforeRejected);
    writeJson(evidencePath, restoreEvidence);
    const decided = invoke([
      "--action", "RESTORE", "--actor", "human", "--phase", "resume", "--intent", intent.intent_id,
      "--evidence", evidencePath, "--resume-unit", "F1.1", "--dir", fx.session,
    ]);
    assert.equal(decided.decided, true, decided.error);
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.trajectory.pending, false);
    assert.equal(state.trajectory.pendingAction, null);
    assert.equal(state.next_unit, "F1.1");
    assert.equal(state.status, "initialized");
  } finally {
    cleanup(fx.root);
  }
});

test("RECON resume binds measured evidence and opens ENVIRONMENT_RECLASSIFY", () => {
  const fx = fixture();
  try {
    const baselinePath = writeJson(join(fx.root, "recon-baseline.json"), reconBaseline(fx));
    const intent = invoke([
      "--action", "RECON", "--actor", "human", "--phase", "intent",
      "--evidence", baselinePath, "--dir", fx.session,
    ]);
    assert.equal(intent.decided, true, intent.error);
    const evidencePath = join(fx.root, "recon-evidence.json");
    writeJson(evidencePath, {
      ...intentBindings(fx, intent, "RECON"),
      type: "environment_delta",
      observation: "No measurable change has happened yet.",
      probe: measuredGitStatusProbe(fx),
    });
    const beforeNoDelta = readFileSync(fx.statePath);
    const noDelta = invoke([
      "--action", "RECON", "--actor", "human", "--phase", "resume", "--intent", intent.intent_id,
      "--evidence", evidencePath, "--dir", fx.session,
    ]);
    assert.equal(noDelta.decided, false);
    assert.match(noDelta.error, /no measured delta/);
    assert.deepEqual(readFileSync(fx.statePath), beforeNoDelta);
    writeFileSync(join(fx.projectRoot, "environment-delta.txt"), "runtime policy v2\n");
    const reconEvidence = {
      ...intentBindings(fx, intent, "RECON"),
      type: "environment_delta",
      observation: "Runtime policy changed from v1 to v2.",
      probe: measuredGitStatusProbe(fx),
    };
    writeJson(evidencePath, {
      ...reconEvidence,
      probe: { ...reconEvidence.probe, stdoutSha256: "0".repeat(64) },
    });
    const beforeRejected = readFileSync(fx.statePath);
    const rejected = invoke([
      "--action", "RECON", "--actor", "human", "--phase", "resume", "--intent", intent.intent_id,
      "--evidence", evidencePath, "--dir", fx.session,
    ]);
    assert.equal(rejected.decided, false);
    assert.match(rejected.error, /stdout hash/);
    assert.deepEqual(readFileSync(fx.statePath), beforeRejected);
    writeJson(evidencePath, reconEvidence);
    const decided = invoke([
      "--action", "RECON", "--actor", "human", "--phase", "resume", "--intent", intent.intent_id,
      "--evidence", evidencePath, "--dir", fx.session,
    ]);
    assert.equal(decided.decided, true, decided.error);
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.trajectory.pending, true);
    assert.equal(state.trajectory.pendingAction, null);
    assert.equal(state.trajectory.reason, "ENVIRONMENT_RECLASSIFY");
    assert.equal(state.trajectory.reconCount, 1);
    assert.equal(state.mission.strategyEpoch, 2);
    assert.match(state.mission.environmentBaselineSha256, /^[0-9a-f]{64}$/);
    const packet = JSON.parse(readFileSync(join(fx.session, "trajectory-review-request.json"), "utf8"));
    assert.equal(packet.reason, "ENVIRONMENT_RECLASSIFY");
    assert.equal(packet.bindings.strategyEpoch, 2);
    assert.equal(packet.evidenceSha256, state.mission.environmentBaselineSha256);
    const secondRecon = invoke(["--action", "RECON", "--actor", "human", "--phase", "intent", "--dir", fx.session]);
    assert.equal(secondRecon.decided, false);
    assert.match(secondRecon.error, /RECON limit reached/);
  } finally {
    cleanup(fx.root);
  }
});

test("agent two-phase resume carries the single cold review bound at intent", () => {
  const fx = fixture();
  try {
    const reviewPath = writeJson(join(fx.root, "recon-review.json"), signedReview(fx, "RECON"));
    const baselinePath = writeJson(join(fx.root, "agent-recon-baseline.json"), reconBaseline(fx));
    const intent = invoke([
      "--action", "RECON", "--actor", "agent", "--phase", "intent",
      "--review", reviewPath, "--evidence", baselinePath, "--dir", fx.session,
    ]);
    assert.equal(intent.decided, true, intent.error);
    writeFileSync(join(fx.projectRoot, "agent-environment-delta.txt"), "dependency contract v2\n");
    const intentState = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(intentState.trajectory.usedReviewRunIds.length, 1);
    const evidencePath = writeJson(join(fx.root, "agent-recon-evidence.json"), {
      ...intentBindings(fx, intent, "RECON"),
      type: "environment_delta",
      observation: "The runtime dependency now exposes a measured v2 contract.",
      probe: measuredGitStatusProbe(fx),
    });
    const duplicateReview = invoke([
      "--action", "RECON", "--actor", "agent", "--phase", "resume",
      "--intent", intent.intent_id, "--review", reviewPath, "--evidence", evidencePath, "--dir", fx.session,
    ]);
    assert.equal(duplicateReview.decided, false);
    assert.match(duplicateReview.error, /do not supply a second review/);
    const resumed = invoke([
      "--action", "RECON", "--actor", "agent", "--phase", "resume",
      "--intent", intent.intent_id, "--evidence", evidencePath, "--dir", fx.session,
    ]);
    assert.equal(resumed.decided, true, resumed.error);
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.trajectory.usedReviewRunIds.length, 1);
    assert.equal(state.trajectory.reason, "ENVIRONMENT_RECLASSIFY");
  } finally {
    cleanup(fx.root);
  }
});

test("a human intent without review cannot be resumed by an agent as carried review", () => {
  const fx = fixture();
  try {
    const baselinePath = writeJson(join(fx.root, "human-recon-baseline.json"), reconBaseline(fx));
    const intent = invoke([
      "--action", "RECON", "--actor", "human", "--phase", "intent",
      "--evidence", baselinePath, "--dir", fx.session,
    ]);
    assert.equal(intent.decided, true, intent.error);
    writeFileSync(join(fx.projectRoot, "human-environment-delta.txt"), "measured environment change\n");
    const intentState = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(intentState.trajectory.pendingActionActor, "human");
    assert.equal(intentState.trajectory.pendingActionReviewSha256, null);
    const evidencePath = writeJson(join(fx.root, "human-intent-recon.json"), {
      ...intentBindings(fx, intent, "RECON"),
      type: "environment_delta",
      observation: "The measured environment differs from the pinned baseline.",
      probe: measuredGitStatusProbe(fx),
    });
    const before = readFileSync(fx.statePath);
    const forgedCarry = invoke([
      "--action", "RECON", "--actor", "agent", "--phase", "resume",
      "--intent", intent.intent_id, "--evidence", evidencePath, "--dir", fx.session,
    ]);
    assert.equal(forgedCarry.decided, false);
    assert.match(forgedCarry.error, /agent decisions.*require --review/);
    assert.deepEqual(readFileSync(fx.statePath), before);
  } finally {
    cleanup(fx.root);
  }
});

test("decision invoked from a child session redirects to canonical parent authority", () => {
  const parent = fixture({ pending: false });
  try {
    const childDir = join(parent.root, "child");
    mkdirSync(childDir);
    const childPrepared = prepareMissionState({ sessionDir: childDir, parentSession: parent.session });
    assert.equal(childPrepared.ok, true, childPrepared.errors?.join("\n"));
    const childState = {
      currentNode: "gate",
      history: [],
      mission: childPrepared.mission,
      trajectory: childPrepared.trajectory,
      findingRegistry: childPrepared.findingRegistry,
      evidenceReceipts: childPrepared.evidenceReceipts,
      checkpointReceipts: childPrepared.checkpointReceipts,
      _written_by: "opc-harness",
      _write_nonce: "child",
    };
    const childPath = join(childDir, "flow-state.json");
    const sealedChild = sealMissionRuntimeState({
      sessionDir: childDir,
      state: childState,
      statePath: childPath,
      reason: "test-child-init",
      allowUnsealed: true,
    });
    assert.equal(sealedChild.ok, true, sealedChild.error);

    parent.state = openMissionGate({
      sessionDir: null,
      state: parent.state,
      missionContract: parent.contract,
      trigger: { reason: "MISSION_REVIEW_REQUIRED", retryable: true },
    }).state;
    const sealedParent = sealPendingMissionGate({ sessionDir: parent.session, state: parent.state });
    assert.equal(sealedParent.ok, true, sealedParent.error);
    parent.state = persistFixtureState(parent, sealedParent.state, "test-parent-gate");
    const reviewPath = writeJson(join(parent.root, "parent-review.json"), signedReview(parent, "CONTINUE_CURRENT"));
    const childBefore = readFileSync(childPath);

    const decided = invoke([
      "--action", "CONTINUE_CURRENT", "--actor", "agent", "--review", reviewPath, "--dir", childDir,
    ]);
    assert.equal(decided.decided, true, decided.error);
    assert.equal(decided.redirected_from_child, true);
    assert.equal(JSON.parse(readFileSync(parent.statePath, "utf8")).trajectory.retryAllowance, 1);
    assert.deepEqual(readFileSync(childPath), childBefore);
  } finally {
    cleanup(parent.root);
  }
});
