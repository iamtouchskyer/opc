import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MAX_NODE_WALL_MS,
  MAX_TOOL_CALLS,
  atomicCreateJson,
  atomicPublishJson,
  budgetPaths,
  claimToolSlot,
  createStopMarker,
  ensureBudgetContext,
  readSessionRegistry,
  registryPath,
  resolveCurrentRun,
  writeSessionRegistry,
} from "./runaway-guard.mjs";

const roots = [];

function tempRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `opc-runaway-${name}-`));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("run identity", () => {
  test("distinguishes initial execution from re-entry", () => {
    const initial = {
      entryNode: "build",
      currentNode: "build",
      totalSteps: 0,
      history: [],
      flowStartedAt: "2026-08-06T00:00:00.000Z",
    };
    assert.deepEqual(resolveCurrentRun(initial), {
      runId: "run_1",
      startedAt: initial.flowStartedAt,
      runKey: `initial:build:${initial.flowStartedAt}`,
    });

    const reentry = {
      ...initial,
      totalSteps: 2,
      history: [{
        nodeId: "build",
        runId: "run_1",
        timestamp: "2026-08-06T00:05:00.000Z",
      }],
    };
    assert.deepEqual(resolveCurrentRun(reentry), {
      runId: "run_1",
      startedAt: reentry.history[0].timestamp,
      runKey: `history:0:run_1:${reentry.history[0].timestamp}`,
    });
  });

  test("fails closed for unverifiable state", () => {
    const valid = {
      entryNode: "build",
      currentNode: "build",
      totalSteps: 0,
      history: [],
      flowStartedAt: "2026-08-06T00:00:00.000Z",
    };
    for (const state of [
      null,
      [],
      { ...valid, history: null },
      { ...valid, currentNode: "" },
      { ...valid, currentNode: "review" },
      { ...valid, flowStartedAt: null },
      { ...valid, flowStartedAt: "not-a-date" },
      { ...valid, flowStartedAt: "2026-02-30T00:00:00.000Z" },
      { ...valid, totalSteps: 1 },
      {
        history: [{ runId: "run_1", timestamp: valid.flowStartedAt }],
      },
      {
        ...valid,
        totalSteps: 1,
        history: [{ nodeId: "build", runId: "run_1" }],
      },
      {
        ...valid,
        totalSteps: 1,
        history: [{ nodeId: "review", runId: "run_1", timestamp: valid.flowStartedAt }],
      },
    ]) {
      assert.equal(resolveCurrentRun(state), null);
    }
  });
});

describe("stable paths and registry", () => {
  test("hashes untrusted identity components", () => {
    const home = tempRoot("paths");
    const registry = registryPath("../../session", home);
    assert.equal(dirname(registry), join(home, ".opc", "runtime"));
    assert.equal(registry.includes("session"), false);

    const first = budgetPaths(home, "build", "initial:build:t0");
    const second = budgetPaths(home, "build", "history:0:run_1:t1");
    assert.notEqual(first.dir, second.dir);
    assert.equal(first.context, join(first.dir, "context.json"));
    assert.equal(first.stop, join(first.dir, "guard-stop.json"));
    assert.equal(first.slots, join(first.dir, "slots"));
    assert.equal(MAX_NODE_WALL_MS, 1_800_000);
    assert.equal(MAX_TOOL_CALLS, 100);
  });

  test("round-trips a validated registry record", () => {
    const home = tempRoot("registry");
    const record = {
      sessionId: "session-a",
      sessionDir: join(home, "session"),
      projectRoot: join(home, "project"),
      registeredAt: "2026-08-06T00:00:00.000Z",
    };
    const path = writeSessionRegistry(record, home);
    assert.equal(path, registryPath(record.sessionId, home));
    assert.deepEqual(readSessionRegistry(record.sessionId, home), record);
    assert.equal(readSessionRegistry("missing", home), null);
  });

  test("rejects malformed or mismatched registry data", () => {
    const home = tempRoot("registry-invalid");
    const valid = {
      sessionId: "session-a",
      sessionDir: join(home, "session"),
      projectRoot: join(home, "project"),
      registeredAt: "2026-08-06T00:00:00.000Z",
    };
    for (const record of [
      null,
      [],
      { ...valid, sessionId: "" },
      { ...valid, sessionDir: "relative" },
      { ...valid, projectRoot: "" },
      { ...valid, registeredAt: "invalid" },
      { ...valid, registeredAt: "2026-08-06" },
      { ...valid, registeredAt: "2026-02-30T00:00:00.000Z" },
    ]) {
      assert.throws(() => writeSessionRegistry(record, home));
    }

    const path = registryPath("session-b", home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(valid));
    assert.throws(() => readSessionRegistry("session-b", home), /session ID mismatch/);
    writeFileSync(path, "not-json");
    assert.throws(() => readSessionRegistry("session-b", home), /cannot parse session registry/);
    rmSync(path);
    mkdirSync(path);
    assert.throws(() => readSessionRegistry("session-b", home), /cannot read session registry/);
  });
});

describe("atomic budget evidence", () => {
  test("atomic JSON creation is first-writer-wins", () => {
    const root = tempRoot("atomic-create");
    const path = join(root, "nested", "value.json");
    assert.equal(atomicCreateJson(path, { winner: 1 }), true);
    assert.equal(atomicCreateJson(path, { winner: 2 }), false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { winner: 1 });

    assert.throws(
      () => atomicCreateJson(
        join(root, "invalid-json.json"),
        { unsupported: 1n },
      ),
      /BigInt/,
    );
  });

  test("atomic publication exposes only a complete winner", () => {
    const root = tempRoot("atomic-publish");
    const path = join(root, "nested", "context.json");
    assert.equal(atomicPublishJson(path, { winner: 1 }), true);
    assert.equal(atomicPublishJson(path, { winner: 2 }), false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { winner: 1 });
    assert.deepEqual(readdirSync(dirname(path)), ["context.json"]);

    const failed = join(root, "nested", "failed.json");
    assert.throws(() => atomicPublishJson(failed, {}, () => {
      const error = new Error("publish failed");
      error.code = "EPERM";
      throw error;
    }), /publish failed/);
    assert.equal(existsSync(failed), false);
    assert.deepEqual(readdirSync(dirname(path)), ["context.json"]);
  });

  test("parallel processes preserve slot and first-writer invariants", async () => {
    const root = tempRoot("parallel");
    const slots = join(root, "slots");
    const context = join(root, "context.json");
    const marker = join(root, "guard-stop.json");
    const moduleUrl = new URL("./runaway-guard.mjs", import.meta.url).href;
    const worker = `
      const [moduleUrl, slots, context, marker, id] = process.argv.slice(1);
      const { atomicCreateJson, atomicPublishJson, claimToolSlot } = await import(moduleUrl);
      const slot = claimToolSlot({ slots }, { id }, 100);
      const contextWon = atomicPublishJson(context, { id });
      const markerWon = atomicCreateJson(marker, { id });
      process.stdout.write(JSON.stringify({ id, slot, contextWon, markerWon }));
    `;

    const results = await Promise.all(Array.from({ length: 120 }, (_, id) =>
      new Promise((resolve, reject) => {
        execFile(process.execPath, [
          "--input-type=module",
          "--eval",
          worker,
          moduleUrl,
          slots,
          context,
          marker,
          String(id),
        ], (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`${error.message}\n${stderr}`));
            return;
          }
          resolve(JSON.parse(stdout));
        });
      })));

    const claims = results.filter(({ slot }) => slot !== null);
    assert.equal(claims.length, 100);
    assert.equal(new Set(claims.map(({ slot }) => slot)).size, 100);
    assert.deepEqual(
      claims.map(({ slot }) => slot).sort((a, b) => a - b),
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    assert.equal(readdirSync(slots).length, 100);
    for (const file of readdirSync(slots)) {
      assert.doesNotThrow(() => JSON.parse(readFileSync(join(slots, file), "utf8")));
    }

    const contextWinners = results.filter(({ contextWon }) => contextWon);
    assert.equal(contextWinners.length, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(context, "utf8")),
      { id: contextWinners[0].id },
    );

    const markerWinners = results.filter(({ markerWon }) => markerWon);
    assert.equal(markerWinners.length, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(marker, "utf8")),
      { id: markerWinners[0].id },
    );
  });

  test("freezes context identity and limits", () => {
    const sessionDir = tempRoot("context");
    const paths = budgetPaths(sessionDir, "build", "initial:build:t0");
    const run = {
      runId: "run_1",
      runKey: "initial:build:t0",
      startedAt: "2026-08-06T00:00:00.000Z",
    };
    const first = ensureBudgetContext(paths, "build", run);
    assert.deepEqual(ensureBudgetContext(paths, "build", run), first);
    assert.equal(first.maxWallTimeSeconds, 1800);
    assert.equal(first.maxToolCalls, 100);
    assert.throws(
      () => ensureBudgetContext(paths, "review", run),
      /budget context mismatch/,
    );
    writeFileSync(paths.context, "bad-json");
    assert.throws(
      () => ensureBudgetContext(paths, "build", run),
      /cannot parse budget context/,
    );
  });

  test("claims immutable slots and treats corrupt slots as consumed", () => {
    const sessionDir = tempRoot("slots");
    const paths = budgetPaths(sessionDir, "build", "run");
    assert.equal(claimToolSlot(paths, { toolUseId: "a" }, 3), 1);
    writeFileSync(join(paths.slots, "000002.json"), "bad-json");
    assert.equal(claimToolSlot(paths, { toolUseId: "b" }, 3), 3);
    assert.equal(claimToolSlot(paths, { toolUseId: "c" }, 3), null);
  });

  test("stop marker preserves the first trigger", () => {
    const sessionDir = tempRoot("marker");
    const state = {
      entryNode: "build",
      currentNode: "build",
      totalSteps: 0,
      history: [],
      flowStartedAt: "2026-08-06T00:00:00.000Z",
      _claudeSessionId: "session-a",
    };
    const first = createStopMarker(sessionDir, state, {
      reason: "repair-edge-budget",
      edgeKey: "review→build",
      now: "2026-08-06T00:10:00.000Z",
    });
    const second = createStopMarker(sessionDir, state, {
      reason: "tool-call-budget",
      now: "2026-08-06T00:11:00.000Z",
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.deepEqual(JSON.parse(readFileSync(first.path, "utf8")), first.marker);
    assert.equal(first.marker.reason, "repair-edge-budget");
    assert.equal(first.marker.edgeKey, "review→build");
  });

  test("stop marker requires a current run and auto session identity", () => {
    const sessionDir = tempRoot("marker-invalid");
    assert.throws(
      () => createStopMarker(sessionDir, {
        entryNode: "build",
        currentNode: "review",
        totalSteps: 0,
        history: [],
      }, { reason: "tool-call-budget" }),
      /cannot resolve current run/,
    );
    assert.throws(
      () => createStopMarker(sessionDir, {
        entryNode: "build",
        currentNode: "build",
        totalSteps: 0,
        history: [],
        flowStartedAt: "2026-08-06T00:00:00.000Z",
      }, { reason: "tool-call-budget" }),
      /missing _claudeSessionId/,
    );
  });
});
