import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawnSync } from "node:child_process";
import {
  atomicCreateJson,
  budgetPaths,
  resolveCurrentRun,
  writeSessionRegistry,
} from "../lib/runaway-guard.mjs";
import { evaluatePreToolUse } from "./opc-pre-tool-budget.mjs";

const roots = [];
const now = "2026-08-06T00:10:00.000Z";
const hookFile = fileURLToPath(new URL("./opc-pre-tool-budget.mjs", import.meta.url));

function tempRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `opc-pre-tool-${name}-`));
  roots.push(root);
  return root;
}

function setupFlow(name, stateOverrides = {}, registryOverrides = {}) {
  const root = tempRoot(name);
  const home = join(root, "home");
  const projectRoot = join(root, "project");
  const sessionDir = join(root, "session");
  const cwd = join(projectRoot, "nested");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const sessionId = `session-${name}`;
  const state = {
    entryNode: "build",
    currentNode: "build",
    totalSteps: 0,
    history: [],
    flowStartedAt: "2026-08-06T00:00:00.000Z",
    autoMode: true,
    _claudeSessionId: sessionId,
    ...stateOverrides,
  };
  writeFileSync(join(sessionDir, "flow-state.json"), JSON.stringify(state));
  const registry = {
    sessionId,
    sessionDir,
    projectRoot,
    registeredAt: "2026-08-06T00:00:00.000Z",
    ...registryOverrides,
  };
  const registryFile = writeSessionRegistry(registry, home);
  const input = {
    session_id: sessionId,
    cwd,
    tool_use_id: "tool-1",
    tool_name: "Bash",
  };
  return { root, home, projectRoot, sessionDir, cwd, sessionId, state, registry, registryFile, input };
}

function evaluate(input, home, timestamp = now) {
  return evaluatePreToolUse(input, { home, now: timestamp });
}

function assertDenied(result) {
  assert.equal(result.allowed, false);
  assert.deepEqual(result.output, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "OPC accidental-runaway circuit breaker tripped for the current node/run. Stop and report. Recovery requires an external terminal transition or stop.",
    },
  });
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("PreToolUse activation", () => {
  test("allows sessions without a registry with zero side effects", () => {
    const home = tempRoot("unregistered");
    assert.deepEqual(evaluate({ session_id: "missing" }, home), { allowed: true });
    assert.deepEqual(evaluate(null, home), { allowed: true });
    assert.equal(existsSync(join(home, ".opc")), false);
  });

  test("allows out-of-project, interactive, completed, and stopped flows", () => {
    const outside = setupFlow("outside");
    const outsideCwd = join(outside.root, "other");
    mkdirSync(outsideCwd);
    assert.deepEqual(evaluate({ ...outside.input, cwd: outsideCwd }, outside.home), { allowed: true });
    assert.equal(existsSync(join(outside.sessionDir, "node-budget")), false);

    const rootCwd = setupFlow("root-cwd");
    assert.deepEqual(
      evaluate({ ...rootCwd.input, cwd: rootCwd.projectRoot }, rootCwd.home),
      { allowed: true },
    );

    for (const [name, stateOverrides] of [
      ["interactive", { autoMode: undefined }],
      ["completed", { status: "completed" }],
      ["stopped", { status: "stopped" }],
    ]) {
      const flow = setupFlow(name, stateOverrides);
      assert.deepEqual(evaluate(flow.input, flow.home), { allowed: true });
      assert.equal(existsSync(join(flow.sessionDir, "node-budget")), false);
    }
  });

  test("fails closed for registry, path, state, status, identity, run, and tool corruption", () => {
    const badRegistry = setupFlow("bad-registry");
    writeFileSync(badRegistry.registryFile, "bad-json");
    assertDenied(evaluate(badRegistry.input, badRegistry.home));

    const badPath = setupFlow("bad-path", {}, { projectRoot: join(tempRoot("absent"), "missing") });
    assertDenied(evaluate(badPath.input, badPath.home));

    const badCwd = setupFlow("bad-cwd");
    assertDenied(evaluate({ ...badCwd.input, cwd: "" }, badCwd.home));
    assertDenied(evaluate({ ...badCwd.input, cwd: "relative" }, badCwd.home));

    const missingState = setupFlow("missing-state");
    rmSync(join(missingState.sessionDir, "flow-state.json"));
    assertDenied(evaluate(missingState.input, missingState.home));

    const corruptState = setupFlow("corrupt-state");
    writeFileSync(join(corruptState.sessionDir, "flow-state.json"), "bad-json");
    assertDenied(evaluate(corruptState.input, corruptState.home));

    for (const [name, value] of [
      ["null-state", null],
      ["string-state", "invalid"],
      ["array-state", []],
    ]) {
      const flow = setupFlow(name);
      writeFileSync(join(flow.sessionDir, "flow-state.json"), JSON.stringify(value));
      assertDenied(evaluate(flow.input, flow.home));
    }

    for (const [name, overrides, inputOverrides] of [
      ["bad-status", { status: "unknown" }, {}],
      ["bad-auto-mode", { autoMode: "yes" }, {}],
      ["bad-identity", { _claudeSessionId: "other" }, {}],
      ["bad-run", { currentNode: "review" }, {}],
      ["bad-tool-id", {}, { tool_use_id: "" }],
      ["bad-tool-name", {}, { tool_name: null }],
      ["bad-agent-id", {}, { agent_id: 42 }],
    ]) {
      const flow = setupFlow(name, overrides);
      assertDenied(evaluate({ ...flow.input, ...inputOverrides }, flow.home));
    }
  });
});

describe("PreToolUse budgets", () => {
  test("freezes context and claims aggregate slots through the 100th call", () => {
    const flow = setupFlow("slots");
    const first = evaluate({ ...flow.input, agent_id: "agent-1" }, flow.home);
    assert.deepEqual(first, { allowed: true });

    const run = resolveCurrentRun(flow.state);
    const paths = budgetPaths(flow.sessionDir, "build", run.runKey);
    assert.deepEqual(JSON.parse(readFileSync(paths.context, "utf8")), {
      nodeId: "build",
      runId: "run_1",
      runKey: run.runKey,
      startedAt: flow.state.flowStartedAt,
      maxWallTimeSeconds: 1800,
      maxToolCalls: 100,
    });
    assert.deepEqual(JSON.parse(readFileSync(join(paths.slots, "000001.json"), "utf8")), {
      sessionId: flow.sessionId,
      toolUseId: "tool-1",
      toolName: "Bash",
      agentId: "agent-1",
      claimedAt: now,
    });

    for (let index = 2; index < 100; index++) {
      atomicCreateJson(join(paths.slots, `${String(index).padStart(6, "0")}.json`), { seeded: true });
    }
    assert.deepEqual(evaluate({ ...flow.input, tool_use_id: "tool-100" }, flow.home), { allowed: true });
    assert.equal(readdirSync(paths.slots).length, 100);

    const denied = evaluate({ ...flow.input, tool_use_id: "tool-101" }, flow.home);
    assertDenied(denied);
    assert.equal(JSON.parse(readFileSync(paths.stop, "utf8")).reason, "tool-call-budget");
    assertDenied(evaluate({ ...flow.input, tool_name: "Read", tool_use_id: "tool-102" }, flow.home));
    assert.equal(readdirSync(paths.slots).length, 100);
  });

  test("trips at the absolute wall-time boundary", () => {
    const flow = setupFlow("wall");
    assert.deepEqual(
      evaluate(flow.input, flow.home, "2026-08-06T00:29:59.999Z"),
      { allowed: true },
    );
    const denied = evaluate(
      { ...flow.input, tool_use_id: "tool-boundary" },
      flow.home,
      "2026-08-06T00:30:00.000Z",
    );
    assertDenied(denied);
    const paths = budgetPaths(flow.sessionDir, "build", resolveCurrentRun(flow.state).runKey);
    assert.equal(JSON.parse(readFileSync(paths.stop, "utf8")).reason, "wall-time-budget");
    assert.equal(readdirSync(paths.slots).length, 1);
  });

  test("fails closed on invalid time, future run, corrupt context, and slot I/O failure", () => {
    for (const [name, timestamp] of [
      ["empty-now", ""],
      ["invalid-now", "not-a-date"],
      ["normalized-now", "2026-02-30T00:10:00.000Z"],
    ]) {
      const flow = setupFlow(name);
      assertDenied(evaluate(flow.input, flow.home, timestamp));
    }

    const future = setupFlow("future", { flowStartedAt: "2026-08-06T00:11:00.000Z" });
    assertDenied(evaluate(future.input, future.home));

    const corrupt = setupFlow("bad-context");
    assert.deepEqual(evaluate(corrupt.input, corrupt.home), { allowed: true });
    const corruptPaths = budgetPaths(corrupt.sessionDir, "build", resolveCurrentRun(corrupt.state).runKey);
    writeFileSync(corruptPaths.context, "bad-json");
    assertDenied(evaluate({ ...corrupt.input, tool_use_id: "tool-2" }, corrupt.home));

    const blockedSlots = setupFlow("blocked-slots");
    assert.deepEqual(evaluate(blockedSlots.input, blockedSlots.home), { allowed: true });
    const blockedPaths = budgetPaths(blockedSlots.sessionDir, "build", resolveCurrentRun(blockedSlots.state).runKey);
    rmSync(blockedPaths.slots, { recursive: true });
    writeFileSync(blockedPaths.slots, "not-a-directory");
    assertDenied(evaluate({ ...blockedSlots.input, tool_use_id: "tool-2" }, blockedSlots.home));
  });

  test("a new run ignores the previous run marker", () => {
    const flow = setupFlow("new-run");
    const initialRun = resolveCurrentRun(flow.state);
    const initialPaths = budgetPaths(flow.sessionDir, "build", initialRun.runKey);
    atomicCreateJson(initialPaths.stop, { reason: "old" });
    assertDenied(evaluate(flow.input, flow.home));

    const nextState = {
      ...flow.state,
      totalSteps: 1,
      history: [{
        nodeId: "build",
        runId: "run_1",
        timestamp: "2026-08-06T00:05:00.000Z",
      }],
    };
    writeFileSync(join(flow.sessionDir, "flow-state.json"), JSON.stringify(nextState));
    assert.deepEqual(evaluate({ ...flow.input, tool_use_id: "tool-new" }, flow.home), { allowed: true });
    const nextPaths = budgetPaths(flow.sessionDir, "build", resolveCurrentRun(nextState).runKey);
    assert.equal(existsSync(nextPaths.stop), false);
    assert.equal(readdirSync(nextPaths.slots).length, 1);
  });
});

describe("PreToolUse CLI contract", () => {
  test("allows exactly 100 of 105 parallel hook invocations", async () => {
    const flow = setupFlow("cli-parallel", {
      flowStartedAt: new Date().toISOString(),
    });
    const outputs = await Promise.all(Array.from({ length: 105 }, (_, index) =>
      new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [hookFile], {
          encoding: "utf8",
          env: { ...process.env, HOME: flow.home },
        }, (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          assert.equal(stderr, "");
          resolve(stdout);
        });
        child.stdin.end(JSON.stringify({
          ...flow.input,
          tool_use_id: `parallel-${index}`,
        }));
      })));

    assert.equal(outputs.filter((output) => output === "").length, 100);
    const denials = outputs.filter((output) => output !== "");
    assert.equal(denials.length, 5);
    for (const output of denials) {
      assertDenied({ allowed: false, output: JSON.parse(output) });
    }
    const paths = budgetPaths(flow.sessionDir, "build", resolveCurrentRun(flow.state).runKey);
    assert.equal(readdirSync(paths.slots).length, 100);
    assert.equal(JSON.parse(readFileSync(paths.stop, "utf8")).reason, "tool-call-budget");
  });

  test("emits official deny JSON with exit zero", () => {
    const flow = setupFlow("cli-deny");
    const paths = budgetPaths(flow.sessionDir, "build", resolveCurrentRun(flow.state).runKey);
    atomicCreateJson(paths.stop, { reason: "existing" });
    const result = spawnSync(process.execPath, [hookFile], {
      input: JSON.stringify(flow.input),
      encoding: "utf8",
      env: { ...process.env, HOME: flow.home },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assertDenied({ allowed: false, output: JSON.parse(result.stdout) });
  });

  test("emits nothing for allow and malformed input", () => {
    const home = tempRoot("cli-allow");
    for (const input of [JSON.stringify({ session_id: "missing" }), "bad-json"]) {
      const result = spawnSync(process.execPath, [hookFile], {
        input,
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
  });
});
