import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import {
  guardMissionMutation,
  missionPromptContext,
  prepareMissionState,
  sealMissionRuntimeState,
  verifyMissionIntegrity,
} from "./mission-contract.mjs";
import { appendProvenanceEvent } from "./provenance-ledger.mjs";
import { openMissionGate, sealPendingMissionGate } from "./trajectory-gate.mjs";

const HARNESS = resolve("bin/opc-harness.mjs");
const REQUEST = "请保留原始请求：修复 café 结账流程 🚀\n第二行也必须原样保存。";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function contract(overrides = {}) {
  return {
    schemaVersion: 1,
    version: 1,
    owner: "Mission owner",
    affectedParties: ["Users", "Maintainers"],
    mode: "explore",
    originalRequest: REQUEST,
    outcomes: [
      { id: "OUT-1", statement: "Unicode mission requests round-trip with exact pinned hashes." },
      { id: "OUT-2", statement: "Invalid mission inputs reject initialization without active state." },
      { id: "OUT-3", statement: "An end-to-end trigger verifies standard and loop mission initialization." },
    ],
    retiredCriteria: [],
    protectedFloors: [{ id: "FLOOR-1", statement: "Mission-less flows retain legacy behavior." }],
    nonGoals: ["Automatic evidence-graph construction"],
    appetite: { maxRepairCycles: 8, maxTokens: null, maxWallTimeHours: null, expiresAt: null },
    endToEndScenario: {
      id: "SCENARIO-1",
      statement: "Initialize both supported run types and compare their pins.",
      validatorTypes: ["e2e", "acceptance"],
    },
    realitySignals: [{ id: "SIG-1", required: true, observation: "Both state files carry matching hashes." }],
    guardrails: [{ id: "GUARD-1", metric: "State integrity", actionThreshold: "Pause on any hash mismatch." }],
    checkpoints: [{ type: "before_finalize" }],
    assumptions: [{ id: "ASM-1", statement: "The filesystem is readable.", freshUntil: null }],
    exitAndSalvage: "Retain the validated contract and deterministic test evidence.",
    ...overrides,
  };
}

function criteria(doc = contract()) {
  return [
    "## Outcomes",
    ...doc.outcomes.map(outcome => `- ${outcome.id}: ${outcome.statement}`),
    "",
    "## Verification",
    "- OUT-1: A unit test asserts exact Unicode bytes and matching SHA-256 hashes.",
    "- OUT-2: Negative tests assert invalid inputs reject initialization and no active state exists.",
    "- OUT-3: An end-to-end trigger invokes both real initialization commands and asserts their state.",
    "",
    "## Quality Constraints",
    "- State preparation is atomic and deterministic.",
    "",
    "## Out of Scope",
    "- Automatic evidence-graph construction.",
    "",
    "## Quality Baseline (functional)",
    "- Deterministic module and CLI verification.",
    "",
  ].join("\n");
}

function plan() {
  return [
    "## Task Scope",
    "- SCOPE-1: initialize mission-aware flows",
    "",
    "## Units",
    "- F1.1: implement — initialize mission-aware flows",
    "  - verify: node --test bin/lib/mission-contract.test.mjs",
    "- F1.2: review — review mission-aware flow initialization",
    "  - eval: verify state hashes and legacy compatibility",
    "- F1.3: e2e — run both initialization paths",
    "  - verify: node --test bin/lib/mission-contract.test.mjs",
    "",
  ].join("\n");
}

function fixture(prefix = "mission-contract-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const session = join(root, "session");
  const source = join(root, "source");
  mkdirSync(session);
  mkdirSync(source);
  const missionPath = join(source, "mission.json");
  const criteriaPath = join(session, "acceptance-criteria.md");
  const planPath = join(session, "plan.md");
  const missionText = `${JSON.stringify(contract(), null, 2)}\n`;
  writeFileSync(missionPath, missionText);
  writeFileSync(criteriaPath, criteria());
  writeFileSync(planPath, plan());
  return { root, session, source, missionPath, criteriaPath, planPath, missionText };
}

function writeState(session, filename, prepared, extra = {}) {
  const state = {
    ...extra,
    mission: prepared.mission,
    trajectory: prepared.trajectory,
    findingRegistry: prepared.findingRegistry,
    evidenceReceipts: prepared.evidenceReceipts,
    checkpointReceipts: prepared.checkpointReceipts,
  };
  const sealed = sealMissionRuntimeState({
    sessionDir: session,
    state,
    statePath: join(session, filename),
    reason: "test-fixture-init",
    allowUnsealed: true,
  });
  assert.equal(sealed.ok, true, sealed.error);
  return sealed.state;
}

function persistState(session, filename, state, reason) {
  const sealed = sealMissionRuntimeState({
    sessionDir: session,
    state,
    statePath: join(session, filename),
    reason,
  });
  assert.equal(sealed.ok, true, sealed.error);
  return sealed.state;
}

const DECISION_FILE_NAMES = {
  review: "mission-review.json",
  approval: "approval.txt",
  mission: "mission-contract.json",
  criteria: "acceptance-criteria.md",
  plan: "plan.md",
  evidence: "evidence.json",
};

function committedDecisionFixture(transformManifest = null) {
  const fx = fixture("mission-decision-commit-");
  const prepared = prepareMissionState({
    sessionDir: fx.session,
    missionPath: fx.missionPath,
    criteriaPath: fx.criteriaPath,
    planPath: fx.planPath,
  });
  assert.equal(prepared.ok, true, prepared.errors?.join("\n"));
  let state = writeState(fx.session, "flow-state.json", prepared);
  const canonicalSession = realpathSync(fx.session);
  const decisionId = "DEC-deterministic-test";
  const decisionDir = join(canonicalSession, "decisions", decisionId);
  mkdirSync(decisionDir, { recursive: true });
  const files = {};
  for (const [label, filename] of Object.entries(DECISION_FILE_NAMES)) {
    const path = join(decisionDir, filename);
    const bytes = Buffer.from(`staged ${label} bytes\n`, "utf8");
    writeFileSync(path, bytes);
    files[label] = { path, relativePath: relative(canonicalSession, path), sha256: hash(bytes) };
  }
  const manifest = {
    schemaVersion: 1,
    decisionId,
    action: "STOP_SALVAGE",
    actor: "human",
    files,
  };
  transformManifest?.({ fx, decisionDir, manifest });
  const manifestPath = join(decisionDir, "manifest.json");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(manifestPath, manifestBytes);
  const manifestRelativePath = relative(canonicalSession, manifestPath);
  const manifestSha256 = hash(manifestBytes);
  const provenance = appendProvenanceEvent(canonicalSession, {
    type: "decision_prepared",
    decisionId,
    action: manifest.action,
    actor: manifest.actor,
    manifestPath: manifestRelativePath,
    manifestSha256,
  });
  state.mission.decisionManifestPath = manifestRelativePath;
  state.mission.decisionManifestSha256 = manifestSha256;
  state.mission.decisionProvenanceRecordHash = provenance.recordHash;
  state.trajectory.lastDecision = {
    eventId: provenance.recordHash,
    action: manifest.action,
    actor: manifest.actor,
  };
  state = persistState(fx.session, "flow-state.json", state, "test-decision-commit");
  return { ...fx, state, files: manifest.files, manifest, manifestPath };
}

function runHarness(cwd, args) {
  const output = execFileSync(process.execPath, [HARNESS, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, OPC_DISABLE_EXTENSIONS: "1" },
  });
  return JSON.parse(output.trim().split("\n").at(-1));
}

test("Unicode request and exact UTF-8 mission bytes round-trip", () => {
  const fx = fixture();
  try {
    const prepared = prepareMissionState({
      sessionDir: fx.session,
      missionPath: fx.missionPath,
      criteriaPath: fx.criteriaPath,
      planPath: fx.planPath,
    });
    assert.equal(prepared.ok, true, prepared.errors?.join("\n"));
    const copied = readFileSync(join(fx.session, "mission-contract.json"));
    assert.deepEqual(copied, readFileSync(fx.missionPath));
    assert.equal(prepared.mission.sha256, hash(copied));
    assert.equal(prepared.contract.originalRequest, REQUEST);

    const state = writeState(fx.session, "flow-state.json", prepared);
    const verified = verifyMissionIntegrity({ sessionDir: fx.session, state });
    assert.equal(verified.ok, true, verified.errors?.join("\n"));
    const prompt = missionPromptContext({ sessionDir: fx.session, state });
    assert.match(prompt, /strategy epoch: 1/);
    assert.ok(prompt.includes(REQUEST));
    assert.match(prompt, /SCENARIO-1/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("schema and exact acceptance outcome parity reject without a copied contract", async (t) => {
  await t.test("invalid schema", () => {
    const fx = fixture();
    try {
      writeFileSync(fx.missionPath, `${JSON.stringify(contract({ outcomes: contract().outcomes.slice(0, 2) }))}\n`);
      const result = prepareMissionState({ sessionDir: fx.session, missionPath: fx.missionPath, criteriaPath: fx.criteriaPath, planPath: fx.planPath });
      assert.equal(result.ok, false);
      assert.match(result.errors.join("\n"), /outcomes must contain 3-10/);
      assert.equal(existsSync(join(fx.session, "mission-contract.json")), false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  await t.test("statement mismatch", () => {
    const fx = fixture();
    try {
      writeFileSync(fx.criteriaPath, criteria().replace("exact pinned hashes.", "different pinned hashes."));
      const result = prepareMissionState({ sessionDir: fx.session, missionPath: fx.missionPath, criteriaPath: fx.criteriaPath, planPath: fx.planPath });
      assert.equal(result.ok, false);
      assert.match(result.errors.join("\n"), /does not exactly match/);
      assert.equal(existsSync(join(fx.session, "mission-contract.json")), false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

test("mission, criteria, and plan tampering fail the shared guard", async (t) => {
  for (const [name, mutate] of [
    ["mission", fx => writeFileSync(join(fx.session, "mission-contract.json"), `${JSON.stringify(contract({ owner: "attacker" }))}\n`)],
    ["criteria", fx => writeFileSync(fx.criteriaPath, `${criteria()}\n<!-- changed -->\n`)],
    ["plan", fx => writeFileSync(fx.planPath, `${plan()}\n<!-- changed -->\n`)],
  ]) {
    await t.test(name, () => {
      const fx = fixture();
      try {
        const prepared = prepareMissionState({ sessionDir: fx.session, missionPath: fx.missionPath, criteriaPath: fx.criteriaPath, planPath: fx.planPath });
        assert.equal(prepared.ok, true, prepared.errors?.join("\n"));
        const state = writeState(fx.session, "flow-state.json", prepared);
        mutate(fx);
        const guarded = guardMissionMutation({ sessionDir: fx.session, state, command: "transition" });
        assert.equal(guarded.allowed, false);
        assert.match(guarded.reason, /hash mismatch|criterion hashes|original request/i);
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    });
  }
});

test("removing the Mission marker cannot downgrade a sealed session to legacy mode", () => {
  const fx = fixture("mission-marker-removal-");
  try {
    const prepared = prepareMissionState({
      sessionDir: fx.session,
      missionPath: fx.missionPath,
      criteriaPath: fx.criteriaPath,
      planPath: fx.planPath,
    });
    assert.equal(prepared.ok, true, prepared.errors?.join("\n"));
    const state = writeState(fx.session, "flow-state.json", prepared);
    delete state.mission;
    delete state._missionRuntimeSeal;
    writeFileSync(join(fx.session, "flow-state.json"), `${JSON.stringify(state, null, 2)}\n`);
    const guarded = guardMissionMutation({ sessionDir: fx.session, state, command: "transition" });
    assert.equal(guarded.allowed, false);
    assert.match(guarded.reason, /authority exists but state\.mission was removed/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("decision preflight re-hashes every staged manifest file", async (t) => {
  for (const label of Object.keys(DECISION_FILE_NAMES)) {
    await t.test(label, () => {
      const fx = committedDecisionFixture();
      try {
        const baseline = guardMissionMutation({ sessionDir: fx.session, state: fx.state, command: "transition" });
        assert.equal(baseline.allowed, true, baseline.reason);
        writeFileSync(fx.files[label].path, `tampered ${label} bytes\n`);
        const guarded = guardMissionMutation({ sessionDir: fx.session, state: fx.state, command: "transition" });
        assert.equal(guarded.allowed, false);
        assert.match(guarded.reason, new RegExp(`decision manifest file '${label}' hash mismatch`));
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    });
  }
});

test("decision preflight rejects missing and escaped staged files", async (t) => {
  await t.test("missing", () => {
    const fx = committedDecisionFixture();
    try {
      rmSync(fx.files.evidence.path);
      const guarded = guardMissionMutation({ sessionDir: fx.session, state: fx.state, command: "transition" });
      assert.equal(guarded.allowed, false);
      assert.match(guarded.reason, /decision manifest file 'evidence' is unreadable/);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  await t.test("escaped", () => {
    const fx = committedDecisionFixture(({ fx: fixtureState, manifest }) => {
      const escapedPath = join(fixtureState.root, "escaped-review.json");
      const escapedBytes = Buffer.from("signed but outside the canonical session\n", "utf8");
      writeFileSync(escapedPath, escapedBytes);
      manifest.files.review = {
        path: escapedPath,
        relativePath: relative(fixtureState.session, escapedPath),
        sha256: hash(escapedBytes),
      };
    });
    try {
      const guarded = guardMissionMutation({ sessionDir: fx.session, state: fx.state, command: "transition" });
      assert.equal(guarded.allowed, false);
      assert.match(guarded.reason, /decision manifest file 'review' escapes canonical session/);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

test("parent session remains canonical and a live pending parent fails closed", () => {
  const fx = fixture("mission-parent-");
  const child = join(fx.root, "child");
  const rejectedChild = join(fx.root, "rejected-child");
  mkdirSync(child);
  mkdirSync(rejectedChild);
  try {
    const parentPrepared = prepareMissionState({ sessionDir: fx.session, missionPath: fx.missionPath, criteriaPath: fx.criteriaPath, planPath: fx.planPath });
    assert.equal(parentPrepared.ok, true, parentPrepared.errors?.join("\n"));
    let parentState = writeState(fx.session, "loop-state.json", parentPrepared, { plan_file: fx.planPath });

    const childPrepared = prepareMissionState({ sessionDir: child, parentSession: fx.session });
    assert.equal(childPrepared.ok, true, childPrepared.errors?.join("\n"));
    assert.equal(childPrepared.mission.parentSession, real(fx.session));
    assert.equal(childPrepared.mission.sha256, parentPrepared.mission.sha256);
    assert.equal(existsSync(join(child, "mission-contract.json")), false);
    const childState = writeState(child, "flow-state.json", childPrepared);

    parentState = openMissionGate({
      sessionDir: null,
      state: parentState,
      missionContract: contract(),
      trigger: { reason: "MISSION_REVIEW_REQUIRED", retryable: true },
    }).state;
    const pendingSeal = sealPendingMissionGate({ sessionDir: fx.session, state: parentState });
    assert.equal(pendingSeal.ok, true, pendingSeal.error);
    parentState = persistState(fx.session, "loop-state.json", pendingSeal.state, "test-parent-pending");
    const guarded = guardMissionMutation({ sessionDir: child, state: childState, command: "transition" });
    assert.equal(guarded.allowed, false);
    assert.match(guarded.reason, /pending Mission Gate/);

    parentState.trajectory.pending = false;
    parentState.trajectory.terminal = true;
    parentState.trajectory.terminalAction = "STOP_SALVAGE";
    parentState.status = "terminated";
    parentState = persistState(fx.session, "loop-state.json", parentState, "test-parent-terminal");
    const terminalGuard = guardMissionMutation({ sessionDir: child, state: childState, command: "finalize", allowPending: true });
    assert.equal(terminalGuard.allowed, false);
    assert.match(terminalGuard.reason, /absorbing/);

    parentState.trajectory.terminal = false;
    parentState.trajectory.terminalAction = null;
    parentState.status = "initialized";
    parentState = openMissionGate({
      sessionDir: null,
      state: parentState,
      missionContract: contract(),
      trigger: { reason: "MISSION_REVIEW_REQUIRED", retryable: true },
    }).state;
    const rejectedPendingSeal = sealPendingMissionGate({ sessionDir: fx.session, state: parentState });
    assert.equal(rejectedPendingSeal.ok, true, rejectedPendingSeal.error);
    parentState = persistState(fx.session, "loop-state.json", rejectedPendingSeal.state, "test-parent-reopened");
    const rejected = prepareMissionState({ sessionDir: rejectedChild, parentSession: fx.session });
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join("\n"), /pending Mission Gate/);
    assert.equal(existsSync(join(rejectedChild, "flow-state.json")), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

function real(path) {
  return realpathSync(path);
}

test("real standard and loop init paths pin matching contract, criteria, and plan hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-init-paths-"));
  const standard = join(root, "standard");
  const loop = join(root, "loop");
  mkdirSync(standard);
  mkdirSync(loop);
  try {
    for (const dir of [standard, loop]) {
      mkdirSync(join(dir, "source"));
      writeFileSync(join(dir, "source", "mission.json"), `${JSON.stringify(contract(), null, 2)}\n`);
      writeFileSync(join(dir, "acceptance-criteria.md"), criteria());
      writeFileSync(join(dir, "plan.md"), plan());
    }

    const standardResult = runHarness(standard, [
      "init", "--dir", standard, "--flow", "quick",
      "--mission", join(standard, "source", "mission.json"),
      "--criteria", join(standard, "acceptance-criteria.md"),
      "--plan", join(standard, "plan.md"),
    ]);
    assert.equal(standardResult.created, true, standardResult.error);
    const loopResult = runHarness(loop, [
      "init-loop", "--dir", loop,
      "--mission", join(loop, "source", "mission.json"),
    ]);
    assert.equal(loopResult.initialized, true, loopResult.errors?.join("\n"));

    const flowState = JSON.parse(readFileSync(join(standard, "flow-state.json"), "utf8"));
    const loopState = JSON.parse(readFileSync(join(loop, "loop-state.json"), "utf8"));
    assert.equal(flowState.mission.sha256, loopState.mission.sha256);
    assert.equal(flowState.mission.acceptanceCriteriaSha256, loopState.mission.acceptanceCriteriaSha256);
    assert.equal(flowState.mission.planSha256, loopState.mission.planSha256);
    assert.deepEqual(flowState.trajectory, loopState.trajectory);
    assert.deepEqual(flowState.findingRegistry, []);
    assert.deepEqual(loopState.evidenceReceipts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mission-less preparation and initialization preserve the legacy state boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-legacy-"));
  try {
    const prepared = prepareMissionState({ sessionDir: root });
    assert.deepEqual(prepared, { ok: true, enabled: false });
    const result = runHarness(root, ["init", "--dir", root, "--flow", "quick"]);
    assert.equal(result.created, true, result.error);
    const state = JSON.parse(readFileSync(join(root, "flow-state.json"), "utf8"));
    assert.equal("mission" in state, false);
    assert.equal("trajectory" in state, false);
    const guard = guardMissionMutation({ sessionDir: root, state, command: "transition" });
    assert.equal(guard.allowed, true);
    assert.equal(guard.enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
