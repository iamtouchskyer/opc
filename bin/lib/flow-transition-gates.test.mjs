import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { checkStructuredResults } from "./flow-transition.mjs";

const TMPBASE = join(os.homedir(), ".opc", "sessions", `ft-gates-test-${Date.now()}`);
const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "..", "opc-harness.mjs");

const TEMPLATE_WITH_CAPS = {
  nodeTypes: { build: "build", "code-review": "review", gate: "gate" },
  nodeCapabilities: {
    build: ["design-system-injection@1"],
    "code-review": ["visual-consistency-check@1"],
  },
};

function makeGateState() {
  return {
    flowTemplate: "build-verify",
    currentNode: "gate",
    history: [
      { nodeId: "build", runId: "run_1" },
      { nodeId: "code-review", runId: "run_1" },
      { nodeId: "gate", runId: "run_1" },
    ],
  };
}

function setupDir(name) {
  const dir = join(TMPBASE, name);
  mkdirSync(join(dir, "nodes", "build"), { recursive: true });
  mkdirSync(join(dir, "nodes", "code-review"), { recursive: true });
  return dir;
}

function runHarness(cmd, args) {
  try {
    const output = execFileSync("node", [HARNESS, cmd, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(output.trim().split("\n").at(-1));
  } catch (err) {
    const lines = String(err.stdout || "").trim().split("\n");
    try { return JSON.parse(lines.at(-1)); } catch {
      return { error: err.message, stderr: String(err.stderr || "") };
    }
  }
}

function createTestDesignSession(name, testPlan) {
  const dir = join(TMPBASE, name);
  const nodeDir = join(dir, "nodes", "test-design");
  const runDir = join(nodeDir, "run_1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "eval-skeptic-owner.md"), "# Skeptic\n**Verdict: APPROVE**\nNo issues.\n");
  writeFileSync(join(runDir, "eval-tester.md"), "# Tester\n**Verdict: APPROVE**\nNo issues.\n");
  if (testPlan !== null) writeFileSync(join(runDir, "test-plan.md"), testPlan);
  const canonical = {
    nodeId: "test-design",
    nodeType: "review",
    runId: "run_1",
    status: "completed",
    verdict: "PASS",
    summary: "test plan ready",
    timestamp: new Date().toISOString(),
    testCommand: "printf ok",
    artifacts: [
      { type: "eval", path: "run_1/eval-skeptic-owner.md" },
      { type: "eval", path: "run_1/eval-tester.md" },
    ],
  };
  const runScoped = {
    ...canonical,
    artifacts: canonical.artifacts.map((artifact) => ({
      ...artifact,
      path: artifact.path.replace(/^run_1\//, ""),
    })),
  };
  writeFileSync(join(nodeDir, "handshake.json"), JSON.stringify(canonical));
  writeFileSync(join(runDir, "handshake.json"), JSON.stringify(runScoped));
  writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
    version: "1.0",
    flowTemplate: "build-verify",
    currentNode: "test-design",
    entryNode: "brief",
    totalSteps: 3,
    maxTotalSteps: 25,
    maxLoopsPerEdge: 3,
    maxNodeReentry: 5,
    edgeCounts: {},
    history: [
      { nodeId: "build", runId: "run_1", timestamp: new Date().toISOString() },
      { nodeId: "code-review", runId: "run_1", timestamp: new Date().toISOString() },
      { nodeId: "test-design", runId: "run_1", timestamp: new Date().toISOString() },
    ],
    _written_by: "opc-harness",
    _write_nonce: `test-${Date.now()}`,
    _last_modified: new Date().toISOString(),
  }, null, 2));
  return dir;
}

const COMPLETE_TEST_PLAN = `
# Test Plan

## Unit smoke
Run npm test for unit coverage.
Cover module smoke behavior.
Assert basic render success.

## Contract edge case
Validate schema boundaries.
Cover invalid input.
Assert error code stability.

## Integration e2e flow
Run playwright test through the workflow.
Cover multi-step happy path.
Assert persisted state.

## UI visual accessibility
Capture screenshot at desktop and mobile viewport.
Check responsive layout.
Run a11y smoke checks.

## Tier baseline polish
Check typography hierarchy.
Check navigation affordance.
Check dark mode baseline.
`;

const OUT_OF_RANGE_ANCHOR_PLAN = `
${COMPLETE_TEST_PLAN}
### TC-UNIT-001
Priority: P0
Anchor: package.json:9999
Run npm test.
Expect unit suite to pass.
`;

const BULLET_RANGE_ANCHOR_PLAN = `
${COMPLETE_TEST_PLAN}
- **TC-UNIT-002**
  Priority: P0
  Anchor: package.json:1-1
  Run npm test.
  Expect unit suite to pass.
`;

const BAD_BULLET_RANGE_ANCHOR_PLAN = `
${COMPLETE_TEST_PLAN}
- **TC-UNIT-003**
  Priority: P1
  Anchor: package.json:1-9999
  Run npm test.
  Expect unit suite to pass.
`;

test.after(() => {
  try { rmSync(TMPBASE, { recursive: true, force: true }); } catch {}
});

describe("extension startup gate", () => {
  test("startup.check ok:false for requested capability blocks gate PASS", () => {
    const dir = setupDir("startup-gap");
    writeFileSync(join(dir, ".ext-registry.json"), JSON.stringify({
      applied: [],
      startupFailures: [{
        ext: "design-intelligence",
        hook: "startup.check",
        kind: "ok-false",
        message: "startup.check returned ok:false: themes missing",
        provides: ["design-system-injection@1"],
      }],
    }));
    const reasons = checkStructuredResults(dir, makeGateState(), TEMPLATE_WITH_CAPS, "gate");
    assert.ok(reasons.some(r => r.includes("extension startup failed")));
    assert.ok(reasons.some(r => r.includes("design-system-injection@1")));
  });

  test("startup.check failure for unrelated capability does not block gate", () => {
    const dir = setupDir("startup-unrelated");
    writeFileSync(join(dir, ".ext-registry.json"), JSON.stringify({
      applied: [],
      startupFailures: [{ ext: "dataviz-x", kind: "ok-false", provides: ["dataviz-lint@1"] }],
    }));
    const reasons = checkStructuredResults(dir, makeGateState(), TEMPLATE_WITH_CAPS, "gate");
    assert.equal(reasons.some(r => r.includes("extension startup failed")), false);
  });
});

describe("test-design transition gate", () => {
  test("blocks missing test plan", () => {
    const result = transitionWithPlan("test-design-missing-plan", null);
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("test-plan.md missing"));
  });

  test("blocks incomplete test plan", () => {
    const result = transitionWithPlan("test-design-bad-plan", "# Test Plan\n\n## Unit\nonly one line\n");
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("missing layers"));
  });

  test("allows complete test plan", () => {
    const result = transitionWithPlan("test-design-good-plan", COMPLETE_TEST_PLAN);
    assert.equal(result.allowed, true, JSON.stringify(result));
    assert.equal(result.next, "test-execute");
  });

  test("blocks out-of-range P0 anchor", () => {
    const result = transitionWithPlan("test-design-bad-anchor", OUT_OF_RANGE_ANCHOR_PLAN);
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("line out of range"));
  });

  test("allows bullet-form test case with valid range anchor", () => {
    const result = transitionWithPlan("test-design-bullet-range-anchor", BULLET_RANGE_ANCHOR_PLAN);
    assert.equal(result.allowed, true, JSON.stringify(result));
  });

  test("blocks bullet-form test case with out-of-range range anchor", () => {
    const result = transitionWithPlan("test-design-bad-bullet-range-anchor", BAD_BULLET_RANGE_ANCHOR_PLAN);
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("range out of range"));
  });
});

function transitionWithPlan(name, plan) {
  const dir = createTestDesignSession(name, plan);
  return runHarness("transition", [
    "--from", "test-design",
    "--to", "test-execute",
    "--verdict", "PASS",
    "--flow", "build-verify",
    "--dir", dir,
  ]);
}
