// flow-transition.test.mjs — Step 1.5 structured result check

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { checkStructuredResults } from "./flow-transition.mjs";
import { budgetPaths, resolveCurrentRun } from "./runaway-guard.mjs";
import { appendProvenanceEvent } from "./provenance-ledger.mjs";

const TMPBASE = join(os.homedir(), ".opc", "sessions", `ft-test-${Date.now()}`);
const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "..", "opc-harness.mjs");

// Minimal template with build-verify topology
const TEMPLATE = {
  nodeTypes: {
    build: "build",
    "code-review": "review",
    gate: "gate",
  },
};

const EXEC_TEMPLATE = {
  nodeTypes: {
    "test-execute": "execute",
    gate: "gate",
  },
};

// Minimal flow state: build → code-review → gate
function makeState() {
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

function makeExecState() {
  return {
    flowTemplate: "build-verify",
    currentNode: "gate",
    history: [
      { nodeId: "test-execute", runId: "run_1" },
      { nodeId: "gate", runId: "run_1" },
    ],
  };
}

function setupDir(name, handshakes) {
  const dir = join(TMPBASE, name);
  for (const [nodeId, hs] of Object.entries(handshakes)) {
    const nodeDir = join(dir, "nodes", nodeId);
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, "handshake.json"), JSON.stringify(hs));
    // Write artifact files referenced by handshake
    if (Array.isArray(hs.artifacts)) {
      for (const art of hs.artifacts) {
        if (art._content !== undefined) {
          const artDir = join(nodeDir, art.path.includes("/") ? art.path.split("/").slice(0, -1).join("/") : "");
          mkdirSync(artDir, { recursive: true });
          const content = typeof art._content === "string" ? art._content : JSON.stringify(art._content);
          writeFileSync(join(nodeDir, art.path), content);
        }
      }
    }
  }
  return dir;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function artifactHash(content) {
  return sha256(typeof content === "string" ? content : JSON.stringify(content));
}

function addTestLedger(dir, { nodeId = "test-execute", runId = "run_1", sourceNode = "test-design", commandHash, sourcePlanHash, resultHash, resultFile = "test-results.json" }) {
  const ledger = appendProvenanceEvent(dir, {
    eventType: "test-command-result",
    nodeId,
    runId,
    sourceNode,
    commandHash,
    sourcePlanHash,
    resultHash,
    resultPath: `nodes/${nodeId}/${runId}/${resultFile}`,
    exitCode: 0,
  });
  const hsPath = join(dir, "nodes", nodeId, "handshake.json");
  const hs = JSON.parse(readFileSync(hsPath, "utf8"));
  hs.testEvidenceProvenance.ledger = ledger;
  writeFileSync(hsPath, JSON.stringify(hs));
}

const TEST_PLAN = "# Test Plan\n\n### TC-TESTER-01\n- **Priority**: P0\n- **Steps**: run command\n";
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

function cleanPassEval(title, focus) {
  const lines = [`# ${title}`, "", "## Scope Review"];
  for (let i = 1; i <= 18; i++) {
    lines.push(`${focus} scope item ${i}: reviewed without blocking findings.`);
  }
  lines.push("", "## Evidence Review");
  for (let i = 1; i <= 18; i++) {
    lines.push(`${focus} evidence item ${i}: handshake and artifact context are consistent.`);
  }
  lines.push("", "## Quality Review");
  for (let i = 1; i <= 18; i++) {
    lines.push(`${focus} quality item ${i}: no critical or warning issue was found.`);
  }
  lines.push("", "## Summary", "LGTM. No findings. Ready for gate PASS.", "VERDICT: PASS FINDINGS[0]", "");
  return lines.join("\n");
}

function writeDiVerdict(dir, nodeId, runId, verdict) {
  const verdictDir = join(dir, "nodes", nodeId, runId, "ext-design-intelligence");
  mkdirSync(verdictDir, { recursive: true });
  writeFileSync(join(verdictDir, "verdict.json"), JSON.stringify(verdict, null, 2));
}

// Cleanup after all tests
test.after(() => {
  try { rmSync(TMPBASE, { recursive: true, force: true }); } catch {}
});

describe("checkStructuredResults — Step 1.5", () => {
  test("no artifacts → empty reasons (backward compat)", () => {
    const dir = setupDir("t1-no-artifacts", {
      build: { artifacts: [] },
      "code-review": { artifacts: [] },
    });
    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.equal(reasons.length, 0, "should pass with no artifacts");
  });

  test("test_fail_count=3 → FAIL", () => {
    const dir = setupDir("t2-test-fail", {
      build: {
        artifacts: [{
          type: "test-result",
          path: "run_1/test-report.json",
          _content: { test_fail_count: 3, dead_test_count: 0 },
        }],
      },
      "code-review": { artifacts: [] },
    });
    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.ok(reasons.length > 0, "should have fail reasons");
    assert.ok(reasons.some(r => r.includes("3 test(s) failed")));
  });

  test("dead_test_count=5 → FAIL", () => {
    const dir = setupDir("t3-dead-tests", {
      build: {
        artifacts: [{
          type: "test-result",
          path: "run_1/test-report.json",
          _content: { test_fail_count: 0, dead_test_count: 5 },
        }],
      },
      "code-review": { artifacts: [] },
    });
    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("5 dead test(s)")));
  });

  test("p0_count=2 → FAIL", () => {
    const dir = setupDir("t4-p0", {
      build: {
        artifacts: [{
          type: "report",
          path: "run_1/report.json",
          _content: { p0_count: 2 },
        }],
      },
      "code-review": { artifacts: [] },
    });
    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("2 P0 issue(s)")));
  });

  test("sync_check_status=FAIL → FAIL", () => {
    const dir = setupDir("t5-sync-fail", {
      build: {
        artifacts: [{
          type: "report",
          path: "run_1/sync-report.json",
          _content: { sync_check_status: "FAIL", test_fail_count: 0 },
        }],
      },
      "code-review": { artifacts: [] },
    });
    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("sync-check failed")));
  });

  test("malformed artifact JSON → fail-closed FAIL", () => {
    const dir = setupDir("t6-malformed", {
      build: {
        artifacts: [{
          type: "report",
          path: "run_1/bad-report.json",
          _content: "NOT VALID JSON{{{",
        }],
      },
      "code-review": { artifacts: [] },
    });
    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("unreadable")));
  });

  test("all zeros → empty reasons (PASS)", () => {
    const dir = setupDir("t7-all-zero", {
      build: {
        artifacts: [{
          type: "test-result",
          path: "run_1/test-report.json",
          _content: { test_fail_count: 0, dead_test_count: 0, p0_count: 0, sync_check_status: "PASS" },
        }],
      },
      "code-review": { artifacts: [] },
    });
    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.equal(reasons.length, 0, "all zeros should pass");
  });

  test("string type coercion: test_fail_count='3' → FAIL", () => {
    const dir = setupDir("t8-string-coerce", {
      build: {
        artifacts: [{
          type: "test-result",
          path: "run_1/test-report.json",
          _content: { test_fail_count: "3" },
        }],
      },
      "code-review": { artifacts: [] },
    });
    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("3 test(s) failed")));
  });

  test("checks[].pass=false → FAIL", () => {
    const dir = setupDir("t8b-checks-fail", {
      build: {
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: { checks: [{ id: "OUT-real", pass: false, detail: "broken" }] },
        }],
      },
      "code-review": { artifacts: [] },
    });
    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("structured check(s) failed")));
  });

  test("checks[] total=0 pass is vacuous → FAIL", () => {
    const dir = setupDir("t8c-vacuous-check", {
      build: {
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: { checks: [{ id: "OUT-star-aria", pass: true, detail: { total: 0, withal: 0 } }] },
        }],
      },
      "code-review": { artifacts: [] },
    });
    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("vacuous PASS")));
    assert.ok(reasons.some(r => r.includes("OUT-star-aria")));
  });

  test("checks[] result-level allowVacuous is ignored", () => {
    const dir = setupDir("t8d-vacuous-result-allow-ignored", {
      build: {
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: { checks: [{ id: "OUT-empty-state", pass: true, allowVacuous: true, detail: { total: 0 } }] },
        }],
      },
      "code-review": { artifacts: [] },
    });
    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("vacuous PASS")));
  });

  test("test-execute checks without testCommand provenance → FAIL", () => {
    const dir = setupDir("t8e-self-authored-checks", {
      "test-execute": {
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: { checks: [{ id: "OUT-browser-render", pass: true, detail: { total: 1 } }] },
        }],
      },
    });
    const reasons = checkStructuredResults(dir, makeExecState(), EXEC_TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("matching OPC testCommand provenance")));
  });

  test("test-execute checks with matching testCommand provenance pass", () => {
    const command = "node -e \"process.exit(0)\"";
    const commandHash = sha256(command);
    const sourcePlanHash = sha256(TEST_PLAN);
    const result = {
      provenance: { kind: "opc-test-command", commandHash, sourcePlanHash, executionActor: "opc-harness:test-command" },
      checks: [{ id: "OUT-browser-render", pass: true, detail: { total: 1 } }],
    };
    const dir = setupDir("t8f-command-provenance", {
      "test-design": {
        artifacts: [{ type: "test-plan", path: "run_1/test-plan.md", _content: TEST_PLAN }],
        testCommand: command,
      },
      "test-execute": {
        testEvidenceProvenance: {
          kind: "opc-test-command", sourceNode: "test-design", commandHash,
          sourcePlanHash, resultHash: artifactHash(result), executionActor: "opc-harness:test-command",
        },
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: result,
        }],
      },
    });
    addTestLedger(dir, { commandHash, sourcePlanHash, resultHash: artifactHash(result) });
    const reasons = checkStructuredResults(dir, makeExecState(), EXEC_TEMPLATE, "gate");
    assert.equal(reasons.some(r => r.includes("testCommand provenance")), false);
    assert.equal(reasons.some(r => r.includes("provenance ledger")), false);
  });

  test("test-execute re-run via goto validates against handshake runId, not stale history entry", () => {
    // Regression: a goto re-run leaves an earlier test-execute entry in history.
    // The dedup keeps that stale (run_1) entry, but the handshake on disk is the
    // latest run (run_2). Validation must use the handshake's own runId so the
    // signed run_2 ledger event is not compared against the stale run_1.
    const command = "node -e \"process.exit(0)\"";
    const commandHash = sha256(command);
    const sourcePlanHash = sha256(TEST_PLAN);
    const result = {
      provenance: { kind: "opc-test-command", commandHash, sourcePlanHash, executionActor: "opc-harness:test-command" },
      checks: [{ id: "OUT-browser-render", pass: true, detail: { total: 1 } }],
    };
    const dir = setupDir("t8f-rerun-goto-runid", {
      "test-design": {
        artifacts: [{ type: "test-plan", path: "run_2/test-plan.md", _content: TEST_PLAN }],
        testCommand: command,
      },
      "test-execute": {
        runId: "run_2",
        testEvidenceProvenance: {
          kind: "opc-test-command", sourceNode: "test-design", commandHash,
          sourcePlanHash, resultHash: artifactHash(result), executionActor: "opc-harness:test-command",
        },
        artifacts: [{
          type: "test-result",
          path: "run_2/test-results.json",
          _content: result,
        }],
      },
    });
    addTestLedger(dir, { runId: "run_2", commandHash, sourcePlanHash, resultHash: artifactHash(result) });
    const rerunState = {
      flowTemplate: "build-verify",
      currentNode: "gate",
      history: [
        { nodeId: "test-execute", runId: "run_1" },
        { nodeId: "gate", runId: "run_1" },
        { nodeId: "test-execute", runId: "run_2" },
        { nodeId: "gate", runId: "run_2" },
      ],
    };
    const reasons = checkStructuredResults(dir, rerunState, EXEC_TEMPLATE, "gate");
    assert.equal(reasons.some(r => r.includes("node/run mismatch")), false);
    assert.equal(reasons.some(r => r.includes("provenance ledger")), false);
  });

  test("test-execute public-hash provenance without signed ledger → FAIL", () => {
    const command = "node -e \"process.exit(0)\"";
    const commandHash = sha256(command);
    const sourcePlanHash = sha256(TEST_PLAN);
    const result = {
      provenance: { kind: "opc-test-command", commandHash, sourcePlanHash, executionActor: "opc-harness:test-command" },
      checks: [{ id: "OUT-browser-render", pass: true, detail: { total: 1 } }],
    };
    const dir = setupDir("t8f1-command-provenance-no-ledger", {
      "test-design": {
        artifacts: [{ type: "test-plan", path: "run_1/test-plan.md", _content: TEST_PLAN }],
        testCommand: command,
      },
      "test-execute": {
        testEvidenceProvenance: {
          kind: "opc-test-command", sourceNode: "test-design", commandHash,
          sourcePlanHash, resultHash: artifactHash(result), executionActor: "opc-harness:test-command",
        },
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: result,
        }],
      },
    });
    const reasons = checkStructuredResults(dir, makeExecState(), EXEC_TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("signed provenance ledger")));
  });

  test("test-execute command provenance without source test-plan hash → FAIL", () => {
    const command = "node -e \"process.exit(0)\"";
    const commandHash = sha256(command);
    const dir = setupDir("t8f2-command-without-plan-provenance", {
      "test-design": {
        artifacts: [{ type: "test-plan", path: "run_1/test-plan.md", _content: TEST_PLAN }],
        testCommand: command,
      },
      "test-execute": {
        testEvidenceProvenance: {
          kind: "opc-test-command", sourceNode: "test-design", commandHash,
          executionActor: "opc-harness:test-command",
        },
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: {
            provenance: { kind: "opc-test-command", commandHash, executionActor: "opc-harness:test-command" },
            checks: [{ id: "OUT-browser-render", pass: true, detail: { total: 1 } }],
          },
        }],
      },
    });
    const reasons = checkStructuredResults(dir, makeExecState(), EXEC_TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("source test-plan hash")));
  });

  test("test-execute checks with forged result-only provenance → FAIL", () => {
    const dir = setupDir("t8g-forged-result-provenance", {
      "test-execute": {
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: {
            provenance: { kind: "opc-test-command", commandHash: "abc123" },
            checks: [{ id: "OUT-browser-render", pass: true, detail: { total: 1 } }],
          },
        }],
      },
    });
    const reasons = checkStructuredResults(dir, makeExecState(), EXEC_TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("matching OPC testCommand provenance")));
  });

  test("test-execute result tamper after harness run → FAIL", () => {
    const command = "node -e \"process.exit(0)\"";
    const commandHash = sha256(command);
    const sourcePlanHash = sha256(TEST_PLAN);
    const original = {
      provenance: { kind: "opc-test-command", commandHash, sourcePlanHash, executionActor: "opc-harness:test-command" },
      test_fail_count: 1,
    };
    const tampered = {
      provenance: { kind: "opc-test-command", commandHash, sourcePlanHash, executionActor: "opc-harness:test-command" },
      test_fail_count: 0,
    };
    const dir = setupDir("t8g3-tampered-result-hash", {
      "test-design": {
        artifacts: [{ type: "test-plan", path: "run_1/test-plan.md", _content: TEST_PLAN }],
        testCommand: command,
      },
      "test-execute": {
        testEvidenceProvenance: {
          kind: "opc-test-command", sourceNode: "test-design", commandHash,
          sourcePlanHash, resultHash: artifactHash(original), executionActor: "opc-harness:test-command",
        },
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: tampered,
        }],
      },
    });
    addTestLedger(dir, { commandHash, sourcePlanHash, resultHash: artifactHash(original) });
    const reasons = checkStructuredResults(dir, makeExecState(), EXEC_TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("result hash")));
  });

  test("test-execute test-result without checks still needs command provenance", () => {
    const dir = setupDir("t8g2-self-authored-zero-tests", {
      "test-execute": {
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: { test_fail_count: 0, dead_test_count: 0 },
        }],
      },
    });
    const reasons = checkStructuredResults(dir, makeExecState(), EXEC_TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("matching OPC testCommand provenance")));
  });

  test("test-execute checks with mismatched testCommand hash → FAIL", () => {
    const command = "node -e \"process.exit(0)\"";
    const sourcePlanHash = sha256(TEST_PLAN);
    const dir = setupDir("t8h-mismatched-command-hash", {
      "test-design": {
        artifacts: [{ type: "test-plan", path: "run_1/test-plan.md", _content: TEST_PLAN }],
        testCommand: command,
      },
      "test-execute": {
        testEvidenceProvenance: {
          kind: "opc-test-command", sourceNode: "test-design", commandHash: "wrong",
          sourcePlanHash, executionActor: "opc-harness:test-command",
        },
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: {
            provenance: { kind: "opc-test-command", commandHash: "wrong", sourcePlanHash, executionActor: "opc-harness:test-command" },
            checks: [{ id: "OUT-browser-render", pass: true, detail: { total: 1 } }],
          },
        }],
      },
    });
    const reasons = checkStructuredResults(dir, makeExecState(), EXEC_TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("matching OPC testCommand provenance")));
  });

  test("test-design allowVacuousChecks can authorize known empty check", () => {
    const command = "node -e \"process.exit(0)\"";
    const commandHash = sha256(command);
    const sourcePlanHash = sha256(TEST_PLAN);
    const result = {
      provenance: { kind: "opc-test-command", commandHash, sourcePlanHash, executionActor: "opc-harness:test-command" },
      checks: [{ id: "OUT-empty-state", pass: true, detail: { total: 0 } }],
    };
    const dir = setupDir("t8i-test-design-vacuous-policy", {
      "test-design": {
        artifacts: [{ type: "test-plan", path: "run_1/test-plan.md", _content: TEST_PLAN }],
        testCommand: command,
        allowVacuousChecks: ["OUT-empty-state"],
      },
      "test-execute": {
        testEvidenceProvenance: {
          kind: "opc-test-command", sourceNode: "test-design", commandHash,
          sourcePlanHash, resultHash: artifactHash(result), executionActor: "opc-harness:test-command",
        },
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: result,
        }],
      },
    });
    addTestLedger(dir, { commandHash, sourcePlanHash, resultHash: artifactHash(result) });
    const reasons = checkStructuredResults(dir, makeExecState(), EXEC_TEMPLATE, "gate");
    assert.equal(reasons.some(r => r.includes("vacuous PASS")), false);
    assert.equal(reasons.some(r => r.includes("testCommand provenance")), false);
  });

  test("artifact type=screenshot → ignored (PASS)", () => {
    const dir = setupDir("t9-screenshot-ignored", {
      build: {
        artifacts: [{
          type: "screenshot",
          path: "run_1/screenshot.png",
          _content: "binary-data-irrelevant",
        }],
      },
      "code-review": { artifacts: [] },
    });
    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.equal(reasons.length, 0, "screenshot artifacts should be ignored");
  });

  test("hard DI AI smell verdict blocks PASS", () => {
    const dir = setupDir("t10-di-ai-smell", {
      build: { artifacts: [] },
      "code-review": { artifacts: [] },
    });
    writeDiVerdict(dir, "build", "run_1", {
      pass: false,
      recommendation: "FAIL",
      aiSmellErrors: 1,
    });

    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("DI AI smell verdict")));
  });

  test("DI ITERATE verdict blocks gate PASS even when pass=true", () => {
    const dir = setupDir("t10b-di-iterate", {
      build: { artifacts: [] },
      "code-review": { artifacts: [] },
    });
    writeDiVerdict(dir, "build", "run_1", {
      pass: true,
      recommendation: "ITERATE",
      aiSmellErrors: 0,
    });

    const reasons = checkStructuredResults(dir, makeState(), TEMPLATE, "gate");
    assert.ok(reasons.some(r => r.includes("DI verdict failed")));
    assert.ok(reasons.some(r => r.includes("ITERATE")));
  });

  test("DI verdict sidecar uses latest run per node", () => {
    const dir = setupDir("t11-di-ai-smell-retry", {
      build: { artifacts: [] },
      "code-review": { artifacts: [] },
    });
    writeDiVerdict(dir, "build", "run_1", {
      pass: false,
      recommendation: "FAIL",
      aiSmellErrors: 1,
    });
    writeDiVerdict(dir, "build", "run_2", {
      pass: true,
      recommendation: "PASS",
      aiSmellErrors: 0,
    });
    const state = {
      flowTemplate: "build-verify",
      currentNode: "gate",
      history: [
        { nodeId: "build", runId: "run_1" },
        { nodeId: "build", runId: "run_2" },
        { nodeId: "code-review", runId: "run_1" },
        { nodeId: "gate", runId: "run_1" },
      ],
    };

    const reasons = checkStructuredResults(dir, state, TEMPLATE, "gate");
    assert.equal(reasons.some(r => r.includes("DI AI smell verdict")), false);
  });
});

// ─── Integration: bypass path enforcement via harness CLI ─────────────

/** Create a full session dir that cmdTransition/cmdPass will accept. */
function createSession(name, {
  artifacts = [],
  failingReport = false,
  diVerdict = null,
  autoMode = false,
  autoRepairCounts,
} = {}) {
  const dir = join(TMPBASE, name);
  mkdirSync(join(dir, "nodes", "build", "run_1"), { recursive: true });
  mkdirSync(join(dir, "nodes", "code-review", "run_1"), { recursive: true });
  mkdirSync(join(dir, "nodes", "test-design", "run_1"), { recursive: true });
  mkdirSync(join(dir, "nodes", "test-execute", "run_1"), { recursive: true });
  mkdirSync(join(dir, "nodes", "gate"), { recursive: true });

  // Write eval files so synthesize produces a verdict
  for (const nodeId of ["code-review", "test-design"]) {
    writeFileSync(join(dir, "nodes", nodeId, "run_1", "eval-skeptic-owner.md"),
      cleanPassEval("Skeptic-Owner Evaluation", nodeId));
    writeFileSync(join(dir, "nodes", nodeId, "run_1", "eval-peer.md"),
      cleanPassEval("Peer Evaluation", nodeId));
  }
  writeFileSync(join(dir, "nodes", "test-design", "run_1", "test-plan.md"), COMPLETE_TEST_PLAN);

  // Write handshakes for upstream nodes
  for (const nodeId of ["build", "code-review", "test-design", "test-execute"]) {
    const hs = {
      nodeId, nodeType: TEMPLATE.nodeTypes[nodeId] || "build", runId: "run_1",
      status: "completed", summary: "done", timestamp: new Date().toISOString(),
      artifacts: nodeId === "build" ? artifacts : [
        { type: "eval", path: "run_1/eval-skeptic-owner.md" },
        { type: "eval", path: "run_1/eval-peer.md" },
      ],
      verdict: null,
    };
    if (nodeId === "test-design") {
      hs.artifacts.push({ type: "test-plan", path: "run_1/test-plan.md" });
    }
    writeFileSync(join(dir, "nodes", nodeId, "handshake.json"), JSON.stringify(hs));
    // test-execute needs evidence
    if (nodeId === "test-execute") {
      writeFileSync(join(dir, "nodes", nodeId, "run_1", "evidence.md"), "test passed");
      hs.artifacts = [{ type: "log", path: "run_1/evidence.md" }];
      hs.nodeType = "execute";
      writeFileSync(join(dir, "nodes", nodeId, "handshake.json"), JSON.stringify(hs));
    }
  }

  // Write failing test report if requested
  if (failingReport) {
    const reportPath = join(dir, "nodes", "build", "run_1", "test-report.json");
    writeFileSync(reportPath, JSON.stringify({ test_fail_count: 3, dead_test_count: 0 }));
    // Update build handshake with artifact reference
    const buildHs = JSON.parse(
      readFileSync(join(dir, "nodes", "build", "handshake.json"), "utf8")
    );
    buildHs.artifacts = [{ type: "test-result", path: "run_1/test-report.json" }];
    writeFileSync(join(dir, "nodes", "build", "handshake.json"), JSON.stringify(buildHs));
  }
  if (diVerdict) writeDiVerdict(dir, "build", "run_1", diVerdict);

  // flow-state.json: currentNode = gate
  const flowState = {
    version: "1.0",
    flowTemplate: "build-verify",
    currentNode: "gate",
    entryNode: "brief",
    totalSteps: 4,
    maxTotalSteps: 25,
    maxLoopsPerEdge: 3,
    maxNodeReentry: 5,
    edgeCounts: {},
    history: [
      { nodeId: "build", runId: "run_1", timestamp: new Date().toISOString() },
      { nodeId: "code-review", runId: "run_1", timestamp: new Date().toISOString() },
      { nodeId: "test-design", runId: "run_1", timestamp: new Date().toISOString() },
      { nodeId: "test-execute", runId: "run_1", timestamp: new Date().toISOString() },
      { nodeId: "gate", runId: "run_1", timestamp: new Date().toISOString() },
    ],
    flowStartedAt: new Date().toISOString(),
    autoMode: autoMode || undefined,
    ...(autoRepairCounts === undefined ? {} : { autoRepairCounts }),
    _claudeSessionId: autoMode ? `session-${name}` : undefined,
    _written_by: "opc-harness",
    _write_nonce: `test-${Date.now()}`,
    _last_modified: new Date().toISOString(),
  };
  writeFileSync(join(dir, "flow-state.json"), JSON.stringify(flowState, null, 2));
  return dir;
}

function runHarness(cmd, args) {
  try {
    const output = execFileSync("node", [HARNESS, cmd, ...args], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = output.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  } catch (err) {
    const stdout = err.stdout || "";
    const lines = stdout.trim().split("\n");
    try { return JSON.parse(lines[lines.length - 1]); } catch {
      return { error: err.message, stderr: err.stderr };
    }
  }
}

describe("Step 1.5 bypass enforcement — cmdTransition", () => {
  test("direct transition PASS with failing artifacts → rejected", () => {
    const dir = createSession("bypass-transition", { failingReport: true });
    const result = runHarness("transition", [
      "--from", "gate", "--to", "null", "--verdict", "PASS",
      "--flow", "build-verify", "--dir", dir,
    ]);
    assert.equal(result.allowed, false, `should be rejected, got: ${JSON.stringify(result)}`);
    assert.ok(
      result.reason?.includes("Step 1.5") || result.reason?.includes("structural"),
      `reason should mention Step 1.5, got: ${result.reason}`
    );
  });

  test("direct transition PASS with hard DI AI smell verdict → rejected", () => {
    const dir = createSession("bypass-transition-di-smell", {
      diVerdict: { pass: false, recommendation: "FAIL", aiSmellErrors: 1 },
    });
    const result = runHarness("transition", [
      "--from", "gate", "--to", "null", "--verdict", "PASS",
      "--flow", "build-verify", "--dir", dir,
    ]);
    assert.equal(result.allowed, false, `should be rejected, got: ${JSON.stringify(result)}`);
    assert.ok(
      result.reason?.includes("DI AI smell verdict"),
      `reason should mention DI AI smell verdict, got: ${result.reason}`
    );
  });

  test("direct gate PASS with upstream synthesize ITERATE → rejected", () => {
    const dir = createSession("bypass-transition-synthesize");
    writeFileSync(join(dir, "nodes", "code-review", "run_1", "eval-skeptic-owner.md"), [
      "# Skeptic Owner Review",
      "",
      "[WARNING] package.json:1 — Package metadata needs review",
      "Reasoning: package metadata is part of the committed source and is being checked.",
      "→ Keep package metadata aligned with the release contract.",
      "",
      "VERDICT: FINDINGS[1]",
    ].join("\n"));
    const result = runHarness("transition", [
      "--from", "gate", "--to", "null", "--verdict", "PASS",
      "--flow", "build-verify", "--dir", dir,
    ]);
    assert.equal(result.allowed, false, `should be rejected, got: ${JSON.stringify(result)}`);
    assert.ok(
      result.reason?.includes("gate synthesize check failed"),
      `reason should mention synthesize gate, got: ${result.reason}`
    );
  });

  test("direct transition FAIL with failing artifacts → allowed (correct verdict)", () => {
    const dir = createSession("bypass-transition-fail", { failingReport: true });
    const result = runHarness("transition", [
      "--from", "gate", "--to", "brief", "--verdict", "FAIL",
      "--flow", "build-verify", "--dir", dir,
    ]);
    assert.equal(result.allowed, true, `FAIL verdict should be allowed, got: ${JSON.stringify(result)}`);
  });

  test("direct transition PASS with clean artifacts → allowed (finalized)", () => {
    const dir = createSession("bypass-transition-clean");
    const result = runHarness("transition", [
      "--from", "gate", "--to", "null", "--verdict", "PASS",
      "--flow", "build-verify", "--dir", dir,
    ]);
    // Terminal PASS → delegates to cmdFinalize, returns {finalized: true}
    const allowed = result.allowed === true || result.finalized === true;
    assert.ok(allowed, `clean PASS should be allowed/finalized, got: ${JSON.stringify(result)}`);
  });
});

describe("Step 1.5 bypass enforcement — cmdPass", () => {
  test("/opc pass with failing artifacts → rejected", () => {
    const dir = createSession("bypass-pass", { failingReport: true });
    const result = runHarness("pass", ["--dir", dir]);
    // cmdPass either returns {error: ...} or delegates to transition which returns {allowed: false}
    const rejected = result.allowed === false || result.error != null;
    assert.ok(rejected, `should be rejected, got: ${JSON.stringify(result)}`);
  });
});

function readState(dir) {
  return JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
}

function runGateRepair(dir) {
  return runHarness("transition", [
    "--from", "gate", "--to", "brief", "--verdict", "FAIL",
    "--flow", "build-verify", "--dir", dir,
  ]);
}

describe("exact auto repair-edge budget", () => {
  test("first successful auto repair consumes the exact edge", () => {
    const dir = createSession("repair-first", { autoMode: true });
    const result = runGateRepair(dir);

    assert.equal(result.allowed, true, JSON.stringify(result));
    assert.equal(readState(dir).autoRepairCounts["gate→brief"], 1);
  });

  test("second exact repair trips durably before graph limits or transition side effects", () => {
    const dir = createSession("repair-second", {
      autoMode: true,
      autoRepairCounts: { "gate→brief": 1 },
    });
    const state = readState(dir);
    state.maxTotalSteps = state.totalSteps;
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify(state, null, 2));
    const before = readFileSync(join(dir, "flow-state.json"), "utf8");

    const result = runGateRepair(dir);

    assert.equal(result.allowed, false);
    assert.equal(result.requiresHuman, true);
    assert.match(result.reason, /auto repair budget reached.*gate→brief/);
    assert.equal(readFileSync(join(dir, "flow-state.json"), "utf8"), before);
    assert.equal(existsSync(join(dir, "nodes", "brief")), false);

    const run = resolveCurrentRun(state);
    const paths = budgetPaths(dir, "gate", run.runKey);
    assert.deepEqual(JSON.parse(readFileSync(paths.stop, "utf8")), {
      sessionId: "session-repair-second",
      nodeId: "gate",
      runKey: run.runKey,
      reason: "repair-edge-budget",
      edgeKey: "gate→brief",
      createdAt: JSON.parse(readFileSync(paths.stop, "utf8")).createdAt,
    });
  });

  test("different exact repair edges remain independent", () => {
    const dir = createSession("repair-independent", {
      autoMode: true,
      autoRepairCounts: { "code-review→build": 1 },
    });

    const result = runGateRepair(dir);

    assert.equal(result.allowed, true, JSON.stringify(result));
    assert.deepEqual(readState(dir).autoRepairCounts, {
      "code-review→build": 1,
      "gate→brief": 1,
    });
  });

  test("interactive transitions ignore auto repair counts", () => {
    const dir = createSession("repair-interactive", {
      autoRepairCounts: { "gate→brief": 1 },
    });

    const result = runGateRepair(dir);

    assert.equal(result.allowed, true, JSON.stringify(result));
    assert.equal(readState(dir).autoRepairCounts["gate→brief"], 1);
  });

  test("failed graph validation does not consume a repair", () => {
    const dir = createSession("repair-validation", { autoMode: true });
    const state = readState(dir);
    state.maxNodeReentry = 0;
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify(state, null, 2));

    const result = runGateRepair(dir);

    assert.equal(result.allowed, false);
    assert.match(result.reason, /maxNodeReentry/);
    assert.equal(readState(dir).autoRepairCounts, undefined);
  });

  test("malformed repair counters and marker I/O failure fail closed", () => {
    for (const [index, autoRepairCounts] of [null, "invalid", []].entries()) {
      const malformedDir = createSession(`repair-malformed-${index}`, {
        autoMode: true,
        autoRepairCounts,
      });
      const malformed = runGateRepair(malformedDir);
      assert.equal(malformed.allowed, false);
      assert.equal(malformed.requiresHuman, true);
      assert.match(malformed.reason, /autoRepairCounts is invalid/);
    }

    for (const [index, count] of [1.5, -1].entries()) {
      const malformedDir = createSession(`repair-count-${index}`, {
        autoMode: true,
        autoRepairCounts: { "gate→brief": count },
      });
      const malformed = runGateRepair(malformedDir);
      assert.equal(malformed.allowed, false);
      assert.equal(malformed.requiresHuman, true);
      assert.match(malformed.reason, /auto repair count is invalid/);
    }

    const blockedDir = createSession("repair-marker-failure", {
      autoMode: true,
      autoRepairCounts: { "gate→brief": 1 },
    });
    writeFileSync(join(blockedDir, "node-budget"), "not-a-directory");
    const before = readFileSync(join(blockedDir, "flow-state.json"), "utf8");
    const blocked = runGateRepair(blockedDir);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.requiresHuman, true);
    assert.match(blocked.reason, /stop marker creation failed/);
    assert.equal(readFileSync(join(blockedDir, "flow-state.json"), "utf8"), before);
  });

  test("auto PASS does not consume repair budget", () => {
    const dir = createSession("repair-pass", {
      autoMode: true,
      autoRepairCounts: { "gate→brief": 0 },
    });
    const result = runHarness("transition", [
      "--from", "gate", "--to", "null", "--verdict", "PASS",
      "--flow", "build-verify", "--dir", dir,
    ]);

    assert.equal(result.finalized, true, JSON.stringify(result));
    assert.deepEqual(readState(dir).autoRepairCounts, { "gate→brief": 0 });
  });
});

function createAdvanceRepairSession(name) {
  const dir = join(TMPBASE, name);
  const reviewRun = join(dir, "nodes", "review", "run_1");
  mkdirSync(reviewRun, { recursive: true });
  mkdirSync(join(dir, "nodes", "gate"), { recursive: true });
  writeFileSync(join(reviewRun, "eval-skeptic-owner.md"), [
    "# Skeptic Owner Review",
    "",
    "[WARNING] package.json:1 — metadata needs another review",
    "Reasoning: the current metadata is incomplete.",
    "→ Repair the metadata before delivery.",
    "",
    "VERDICT: FINDINGS[1]",
  ].join("\n"));
  writeFileSync(join(reviewRun, "eval-peer.md"), cleanPassEval("Peer Evaluation", "review"));
  writeFileSync(join(dir, "nodes", "review", "handshake.json"), JSON.stringify({
    nodeId: "review",
    nodeType: "review",
    runId: "run_1",
    status: "completed",
    verdict: "ITERATE",
    summary: "needs repair",
    timestamp: new Date().toISOString(),
    artifacts: [
      { type: "eval", path: "run_1/eval-skeptic-owner.md" },
      { type: "eval", path: "run_1/eval-peer.md" },
    ],
  }));
  const now = new Date().toISOString();
  writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
    version: "1.0",
    flowTemplate: "review",
    currentNode: "gate",
    entryNode: "review",
    totalSteps: 1,
    maxTotalSteps: 10,
    maxLoopsPerEdge: 3,
    maxNodeReentry: 5,
    edgeCounts: { "review→gate": 1 },
    history: [
      { nodeId: "review", runId: "run_1", timestamp: now },
      { nodeId: "gate", runId: "run_1", timestamp: now },
    ],
    flowStartedAt: now,
    autoMode: true,
    autoRepairCounts: { "gate→review": 1 },
    _claudeSessionId: `session-${name}`,
    _written_by: "opc-harness",
    _write_nonce: `test-${Date.now()}`,
    _last_modified: now,
  }, null, 2));
  return dir;
}

describe("advance repair denial propagation", () => {
  test("reports advanced=false when the nested transition requires a human", () => {
    const dir = createAdvanceRepairSession("repair-advance");

    const result = runHarness("advance", ["--dir", dir]);

    assert.equal(result.advanced, false, JSON.stringify(result));
    assert.equal(result.requiresHuman, true);
    assert.equal(result.transition.allowed, false);
    assert.match(result.reason, /auto repair budget reached.*gate→review/);
  });
});
