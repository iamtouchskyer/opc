import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sealMissionRuntimeState,
  validateMissionRuntimeStateSeal,
} from "./mission-runtime-seal.mjs";

function baseState() {
  return {
    mission: {
      sha256: "a".repeat(64),
      strategyEpoch: 1,
      criterionHashes: { "OUT-1": "b".repeat(64) },
    },
    trajectory: {
      pending: false,
      continuedFindingRefs: ["FIND-1"],
      agentReshapedFindingRefs: [],
      findingFailureCounts: { "FIND-1": 1 },
      repairEdgeFailures: { "review→fix": 1 },
      repairCycles: 1,
      evidenceGateCursor: 1,
      evidenceGateReceiptIds: ["EV-1"],
      terminal: false,
    },
    findingRegistry: [{ id: "FIND-1", fingerprint: "same-bug" }],
    evidenceReceipts: [{ id: "EV-1", result: "PASS", strategyEpoch: 1 }],
    checkpointReceipts: [{ id: "CP-1", result: "PASS", strategyEpoch: 1 }],
    status: "initialized",
    currentNode: "review",
    totalSteps: 2,
    history: [{ nodeId: "review", runId: "run_1" }],
    edgeCounts: { "build→review": 1 },
    _written_by: "opc-harness",
    _write_nonce: "fixture",
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mission-runtime-seal-"));
  const initial = sealMissionRuntimeState({
    sessionDir: dir,
    state: baseState(),
    allowUnsealed: true,
    reason: "test-init",
  });
  assert.equal(initial.ok, true, initial.error);
  return { dir, path: join(dir, "flow-state.json"), state: initial.state };
}

function cleanup(fx) {
  rmSync(fx.dir, { recursive: true, force: true });
}

function directEdit(fx, mutate) {
  const state = JSON.parse(readFileSync(fx.path, "utf8"));
  mutate(state);
  writeFileSync(fx.path, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

test("authoritative Mission side-band and completion fields reject direct edits", async t => {
  const cases = [
    ["continuedFindingRefs", state => { state.trajectory.continuedFindingRefs = []; }],
    ["agentReshapedFindingRefs", state => { state.trajectory.agentReshapedFindingRefs = ["FIND-1"]; }],
    ["findingFailureCounts", state => { state.trajectory.findingFailureCounts["FIND-1"] = 0; }],
    ["repairEdgeFailures", state => { state.trajectory.repairEdgeFailures = {}; }],
    ["repairCycles", state => { state.trajectory.repairCycles = 0; }],
    ["evidenceReceipts", state => { state.evidenceReceipts = []; }],
    ["checkpointReceipts", state => { state.checkpointReceipts = []; }],
    ["findingRegistry", state => { state.findingRegistry[0].fingerprint = "different-bug"; }],
    ["status", state => { state.status = "completed"; }],
    ["cursor", state => { state.currentNode = "gate"; }],
    ["history", state => { state.history = []; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const fx = fixture();
      try {
        const edited = directEdit(fx, mutate);
        const result = validateMissionRuntimeStateSeal({ sessionDir: fx.dir, state: edited });
        assert.equal(result.ok, false);
        assert.match(result.error, /digest\/seal mismatch/);
      } finally {
        cleanup(fx);
      }
    });
  }
});

test("removing Mission mode or rolling state back to an older signed snapshot fails closed", async t => {
  await t.test("Mission marker removal", () => {
    const fx = fixture();
    try {
      const edited = directEdit(fx, state => {
        delete state.mission;
        delete state._missionRuntimeSeal;
      });
      const result = validateMissionRuntimeStateSeal({ sessionDir: fx.dir, state: edited });
      assert.equal(result.ok, false);
      assert.match(result.error, /authority exists but state\.mission was removed/);
    } finally {
      cleanup(fx);
    }
  });

  await t.test("older valid snapshot", () => {
    const fx = fixture();
    try {
      const oldBytes = readFileSync(fx.path);
      const next = JSON.parse(oldBytes.toString("utf8"));
      next.trajectory.repairCycles = 2;
      const sealed = sealMissionRuntimeState({ sessionDir: fx.dir, state: next, reason: "test-next" });
      assert.equal(sealed.ok, true, sealed.error);
      writeFileSync(fx.path, oldBytes);
      const rolledBack = JSON.parse(oldBytes.toString("utf8"));
      const result = validateMissionRuntimeStateSeal({ sessionDir: fx.dir, state: rolledBack });
      assert.equal(result.ok, false);
      assert.match(result.error, /digest\/seal mismatch|newest committed seal/);
    } finally {
      cleanup(fx);
    }
  });

  await t.test("allowUnsealed cannot reset existing authority", () => {
    const fx = fixture();
    try {
      const replacement = baseState();
      replacement.trajectory.repairCycles = 0;
      replacement.history = [];
      const result = sealMissionRuntimeState({
        sessionDir: fx.dir,
        state: replacement,
        allowUnsealed: true,
        reason: "attempt-authority-reset",
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /newest committed state/);
      assert.equal(JSON.parse(readFileSync(fx.path, "utf8")).trajectory.repairCycles, 1);
    } finally {
      cleanup(fx);
    }
  });
});

test("legacy corrupt state is replaceable only when no signed Mission authority exists", async t => {
  await t.test("unsealed legacy state", () => {
    const dir = mkdtempSync(join(tmpdir(), "mission-runtime-legacy-corrupt-"));
    const path = join(dir, "loop-state.json");
    try {
      writeFileSync(path, "not json\n");
      const result = validateMissionRuntimeStateSeal({
        sessionDir: dir,
        state: {},
        statePath: path,
        allowLegacyCorruptUnsealed: true,
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.enabled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("signed Mission authority with corrupt active state", () => {
    const fx = fixture();
    try {
      writeFileSync(fx.path, "not json\n");
      const result = validateMissionRuntimeStateSeal({
        sessionDir: fx.dir,
        state: {},
        statePath: fx.path,
        allowLegacyCorruptUnsealed: true,
      });
      assert.equal(result.ok, false);
      assert.equal(result.enabled, true);
      assert.match(result.error, /not valid JSON|authority|seal/i);
    } finally {
      cleanup(fx);
    }
  });
});

test("two-phase runtime sealing recovers every filesystem/ledger crash boundary", async t => {
  for (const phase of ["after-stage", "after-prepare", "after-state-write", "after-commit"]) {
    await t.test(phase, () => {
      const fx = fixture();
      try {
        const next = JSON.parse(readFileSync(fx.path, "utf8"));
        next.trajectory.repairCycles = 2;
        const interrupted = sealMissionRuntimeState({
          sessionDir: fx.dir,
          state: next,
          reason: `crash-test:${phase}`,
          faultInjector: reached => {
            if (reached === phase) throw new Error(`simulated crash ${phase}`);
          },
        });
        assert.equal(interrupted.ok, false);

        const active = JSON.parse(readFileSync(fx.path, "utf8"));
        const verified = validateMissionRuntimeStateSeal({ sessionDir: fx.dir, state: active });
        assert.equal(verified.ok, true, verified.error);
        assert.equal(
          verified.state.trajectory.repairCycles,
          phase === "after-stage" ? 1 : 2,
          "an unsigned stage is discarded; a signed PREPARE is completed",
        );
        assert.equal(existsSync(`${fx.path}.mission-runtime-stage`), false);
      } finally {
        cleanup(fx);
      }
    });
  }
});
