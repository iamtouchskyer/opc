// flow-transition.test.mjs — Step 1.5 structured result check

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, dirname, basename } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { allocateNextRunId, checkStructuredResults, cmdFinalize } from "./flow-transition.mjs";
import { findLatestRunDir } from "./ext-commands.mjs";
import { budgetPaths, resolveCurrentRun } from "./runaway-guard.mjs";
import { appendProvenanceEvent } from "./provenance-ledger.mjs";
import {
  evaluateFlowBudget,
  isRepairVerdict,
  nodeHasBudgetedExit,
  repairEdgeCount,
  seedRepairEdgeCounts,
} from "./flow-budget.mjs";

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
    const runId = hs.runId || "run_1";
    const fullHandshake = {
      nodeId,
      nodeType: TEMPLATE.nodeTypes[nodeId] || EXEC_TEMPLATE.nodeTypes[nodeId] || "build",
      runId,
      status: "completed",
      verdict: null,
      summary: `${nodeId} complete`,
      timestamp: new Date().toISOString(),
      ...hs,
    };
    writeFileSync(join(nodeDir, "handshake.json"), JSON.stringify(fullHandshake));
    const runDir = join(nodeDir, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "handshake.json"), JSON.stringify(fullHandshake));
    // Write artifact files referenced by handshake
    if (Array.isArray(fullHandshake.artifacts)) {
      for (const art of fullHandshake.artifacts) {
        if (art._content !== undefined) {
          const artDir = join(nodeDir, art.path.includes("/") ? art.path.split("/").slice(0, -1).join("/") : "");
          mkdirSync(artDir, { recursive: true });
          const runArtDir = join(runDir, art.path.includes("/") ? art.path.split("/").slice(0, -1).join("/") : "");
          mkdirSync(runArtDir, { recursive: true });
          const content = typeof art._content === "string" ? art._content : JSON.stringify(art._content);
          writeFileSync(join(nodeDir, art.path), content);
          writeFileSync(join(runDir, art.path), content);
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

function addTestLedger(dir, { nodeId = "test-execute", runId = "run_1", sourceNode = "test-design", sourceRunId = "run_1", commandHash, sourcePlanHash, resultHash, resultFile = "test-results.json" }) {
  const ledger = appendProvenanceEvent(dir, {
    eventType: "test-command-result",
    nodeId,
    runId,
    sourceNode,
    sourceRunId,
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
  const runHsPath = join(dir, "nodes", nodeId, runId, "handshake.json");
  if (existsSync(runHsPath)) {
    const runHs = JSON.parse(readFileSync(runHsPath, "utf8"));
    runHs.testEvidenceProvenance.ledger = ledger;
    writeFileSync(runHsPath, JSON.stringify(runHs));
  }
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

function writeNodeHandshake(dir, nodeId, handshake) {
  const runId = handshake.runId || "run_1";
  const nodeDir = join(dir, "nodes", nodeId);
  const runDir = join(nodeDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(nodeDir, "handshake.json"), JSON.stringify(handshake));
  const runHandshake = {
    ...handshake,
    artifacts: Array.isArray(handshake.artifacts)
      ? handshake.artifacts.map((art) => ({
        ...art,
        path: typeof art.path === "string" ? art.path.replace(new RegExp(`^${runId}/`), "") : art.path,
      }))
      : handshake.artifacts,
  };
  writeFileSync(join(runDir, "handshake.json"), JSON.stringify(runHandshake));
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
      provenance: { kind: "opc-test-command", sourceNode: "test-design", sourceRunId: "run_1", commandHash, sourcePlanHash, executionActor: "opc-harness:test-command" },
      checks: [{ id: "OUT-browser-render", pass: true, detail: { total: 1 } }],
    };
    const dir = setupDir("t8f-command-provenance", {
      "test-design": {
        artifacts: [{ type: "test-plan", path: "run_1/test-plan.md", _content: TEST_PLAN }],
        testCommand: command,
      },
      "test-execute": {
        testEvidenceProvenance: {
          kind: "opc-test-command", sourceNode: "test-design", sourceRunId: "run_1", commandHash,
          sourcePlanHash, resultHash: artifactHash(result), executionActor: "opc-harness:test-command",
        },
        testEvidencePolicy: { allowVacuousChecks: [] },
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
      provenance: { kind: "opc-test-command", sourceNode: "test-design", sourceRunId: "run_1", commandHash, sourcePlanHash, executionActor: "opc-harness:test-command" },
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
          kind: "opc-test-command", sourceNode: "test-design", sourceRunId: "run_1", commandHash,
          sourcePlanHash, resultHash: artifactHash(result), executionActor: "opc-harness:test-command",
        },
        testEvidencePolicy: { allowVacuousChecks: [] },
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
      provenance: { kind: "opc-test-command", sourceNode: "test-design", sourceRunId: "run_1", commandHash, sourcePlanHash, executionActor: "opc-harness:test-command" },
      checks: [{ id: "OUT-browser-render", pass: true, detail: { total: 1 } }],
    };
    const dir = setupDir("t8f1-command-provenance-no-ledger", {
      "test-design": {
        artifacts: [{ type: "test-plan", path: "run_1/test-plan.md", _content: TEST_PLAN }],
        testCommand: command,
      },
      "test-execute": {
        testEvidenceProvenance: {
          kind: "opc-test-command", sourceNode: "test-design", sourceRunId: "run_1", commandHash,
          sourcePlanHash, resultHash: artifactHash(result), executionActor: "opc-harness:test-command",
        },
        testEvidencePolicy: { allowVacuousChecks: [] },
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
      provenance: { kind: "opc-test-command", sourceNode: "test-design", sourceRunId: "run_1", commandHash, sourcePlanHash, executionActor: "opc-harness:test-command" },
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
          kind: "opc-test-command", sourceNode: "test-design", sourceRunId: "run_1", commandHash,
          sourcePlanHash, resultHash: artifactHash(original), executionActor: "opc-harness:test-command",
        },
        testEvidencePolicy: { allowVacuousChecks: [] },
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
      provenance: { kind: "opc-test-command", sourceNode: "test-design", sourceRunId: "run_1", commandHash, sourcePlanHash, executionActor: "opc-harness:test-command" },
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
          kind: "opc-test-command", sourceNode: "test-design", sourceRunId: "run_1", commandHash,
          sourcePlanHash, resultHash: artifactHash(result), executionActor: "opc-harness:test-command",
        },
        testEvidencePolicy: { allowVacuousChecks: ["OUT-empty-state"] },
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
    const defaultType = nodeId === "test-design" ? "review" : (TEMPLATE.nodeTypes[nodeId] || "build");
    const hs = {
      nodeId, nodeType: defaultType, runId: "run_1",
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
	    writeNodeHandshake(dir, nodeId, hs);
	    // test-execute needs evidence
	    if (nodeId === "test-execute") {
	      writeFileSync(join(dir, "nodes", nodeId, "run_1", "evidence.md"), "test passed");
	      hs.artifacts = [{ type: "cli-output", path: "run_1/evidence.md" }];
	      hs.nodeType = "execute";
	      writeNodeHandshake(dir, nodeId, hs);
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
	    writeNodeHandshake(dir, "build", buildHs);
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

describe("collision-safe transition run allocation", () => {
  test("allocator reserves exact run_N directories and regular files", () => {
    const nodeDir = join(TMPBASE, "allocator-unit", "nodes", "build");
    mkdirSync(join(nodeDir, "run_1"), { recursive: true });
    mkdirSync(join(nodeDir, "run_5"), { recursive: true });
    writeFileSync(join(nodeDir, "run_99"), "reserved regular file");

    assert.equal(allocateNextRunId([], readdirSync(nodeDir, { withFileTypes: true }), "build"), "run_100");
    assert.equal(allocateNextRunId([
      { nodeId: "build", runId: "run_108" },
      { nodeId: "other", runId: "run_120" },
    ], readdirSync(nodeDir, { withFileTypes: true }), "build"), "run_109");

    assert.equal(allocateNextRunId([
      { nodeId: "build", runId: "run_9007199254740992" },
    ], ["run_9007199254740993"], "build"), "run_9007199254740994");
  });

  test("allocator reserves exact run_N symlinks without following them", () => {
    const nodeDir = join(TMPBASE, "allocator-symlink", "nodes", "build");
    mkdirSync(join(nodeDir, "run_1"), { recursive: true });
    symlinkSync("run_1", join(nodeDir, "run_12"), "dir");

    assert.equal(allocateNextRunId([], readdirSync(nodeDir, { withFileTypes: true }), "build"), "run_13");
  });

  test("latest run selection remains exact beyond MAX_SAFE_INTEGER", () => {
    const nodeDir = join(TMPBASE, "latest-run-bigint", "nodes", "build");
    mkdirSync(join(nodeDir, "run_9007199254740992"), { recursive: true });
    mkdirSync(join(nodeDir, "run_9007199254740993"), { recursive: true });

    assert.equal(basename(findLatestRunDir(nodeDir)), "run_9007199254740993");
  });

  test("transition rejects an explicit built-in flow that differs from persisted identity", () => {
    const dir = join(TMPBASE, "persisted-built-in-flow-mismatch");
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, "flow-state.json");
    writeFileSync(statePath, JSON.stringify({
      version: "1.0",
      flowTemplate: "build-verify",
      currentNode: "build",
      entryNode: "brief",
      totalSteps: 1,
      maxTotalSteps: 25,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [{ nodeId: "build", runId: "run_1", timestamp: new Date().toISOString() }],
      edgeCounts: {},
      repairEdgeCounts: {},
      _written_by: "opc-harness",
      _write_nonce: "persisted-built-in-flow-mismatch",
    }, null, 2));
    const before = readFileSync(statePath, "utf8");

    const result = runHarness("transition", [
      "--from", "build", "--to", "code-review", "--verdict", "PASS",
      "--flow", "review", "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /persisted flow identity.*build-verify.*review/i);
    assert.equal(readFileSync(statePath, "utf8"), before);
    assert.equal(existsSync(join(dir, "nodes", "code-review")), false);
  });

  test("transition rejects an explicit flow file that differs from persisted identity", () => {
    const dir = join(TMPBASE, "persisted-flow-file-mismatch");
    const buildRun = join(dir, "nodes", "build", "run_1");
    mkdirSync(buildRun, { recursive: true });
    const handshake = {
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: null,
      summary: "ready",
      timestamp: new Date().toISOString(),
      artifacts: [],
    };
    writeNodeHandshake(dir, "build", handshake);

    const persistedFlowFile = join(dir, "persisted-flow.json");
    const substituteFlowFile = join(dir, "substitute-flow.json");
    const template = {
      opc_compat: ">=0.0",
      nodes: ["build", "review"],
      edges: { build: { PASS: "review" }, review: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { build: "build", review: "review" },
    };
    writeFileSync(persistedFlowFile, JSON.stringify(template));
    writeFileSync(substituteFlowFile, JSON.stringify(template));
    const statePath = join(dir, "flow-state.json");
    writeFileSync(statePath, JSON.stringify({
      version: "1.0",
      flowTemplate: "persisted-flow",
      currentNode: "build",
      entryNode: "build",
      totalSteps: 1,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [{ nodeId: "build", runId: "run_1", timestamp: new Date().toISOString() }],
      edgeCounts: {},
      repairEdgeCounts: {},
      _flow_file: persistedFlowFile,
      _written_by: "opc-harness",
      _write_nonce: "persisted-flow-file-mismatch",
    }, null, 2));
    const before = readFileSync(statePath, "utf8");

    const result = runHarness("transition", [
      "--from", "build", "--to", "review", "--verdict", "PASS",
      "--flow-file", substituteFlowFile, "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /persisted flow identity.*persisted-flow\.json.*substitute-flow\.json/i);
    assert.equal(readFileSync(statePath, "utf8"), before);
    assert.equal(existsSync(join(dir, "nodes", "review")), false);
  });

  test("first loopback to an unrecorded entry node creates run_2 without touching run_1", () => {
    const dir = join(TMPBASE, "allocator-loopback");
    const buildRun1 = join(dir, "nodes", "build", "run_1");
    const repairRun1 = join(dir, "nodes", "repair", "run_1");
    mkdirSync(buildRun1, { recursive: true });
    mkdirSync(repairRun1, { recursive: true });
    writeFileSync(join(buildRun1, "sentinel.txt"), "immutable run one");
    writeNodeHandshake(dir, "repair", {
      nodeId: "repair",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "ITERATE",
      summary: "repair requests entry-node loopback",
      timestamp: new Date().toISOString(),
      artifacts: [],
    });

    const flowFile = join(dir, "allocator-loop.json");
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["build", "repair"],
      edges: {
        build: { PASS: "repair" },
        repair: { ITERATE: "build" },
      },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { build: "build", repair: "build" },
    }));
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      version: "1.0",
      flowTemplate: "allocator-loop",
      currentNode: "repair",
      entryNode: "build",
      totalSteps: 1,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [{ nodeId: "repair", runId: "run_1", timestamp: new Date().toISOString() }],
      edgeCounts: { "build→repair": 1 },
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "allocator-loopback-test",
    }, null, 2));

    const result = runHarness("transition", [
      "--from", "repair", "--to", "build", "--verdict", "ITERATE",
      "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(result.allowed, true, JSON.stringify(result));
    assert.equal(result.runId, "run_2");
    assert.equal(readFileSync(join(buildRun1, "sentinel.txt"), "utf8"), "immutable run one");
    assert.equal(existsSync(join(dir, "nodes", "build", "run_2")), true);
    assert.equal(readState(dir).history.at(-1).runId, "run_2");
  });

  test("auto review verdict binds to the selected run and propagates functional applicability", () => {
    const dir = join(TMPBASE, "functional-transition-context");
    const reviewRun = join(dir, "nodes", "review", "run_1");
    const rogueRun = join(dir, "nodes", "review", "run_2");
    const extensionDir = join(dir, "extensions", "capture");
    mkdirSync(reviewRun, { recursive: true });
    mkdirSync(rogueRun, { recursive: true });
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, "hook.mjs"), `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      export const meta = { name: "capture", provides: ["capture-context@1"] };
      export function verdictAppend(ctx) {
        writeFileSync(join(ctx.runDir, "captured-transition-verdict.json"), JSON.stringify(ctx));
        return [];
      }
      export function promptAppend(ctx) {
        writeFileSync(join(ctx.flowDir, "captured-transition-prompt.json"), JSON.stringify(ctx));
        return "";
      }
    `);
    writeFileSync(join(reviewRun, "eval-custom-one.md"), "first independent review");
    writeFileSync(join(reviewRun, "eval-custom-two.md"), "second independent review");
    writeFileSync(join(rogueRun, "eval-rogue-one.md"), "rogue review");
    writeFileSync(join(rogueRun, "eval-rogue-two.md"), "rogue review");
    writeFileSync(join(rogueRun, "handshake.json"), JSON.stringify({ sentinel: "rogue" }));

    const handshake = {
      nodeId: "review",
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "ITERATE",
      summary: "functional review requests repair",
      timestamp: new Date().toISOString(),
      artifacts: [
        { type: "eval", path: "run_1/eval-custom-one.md" },
        { type: "eval", path: "run_1/eval-custom-two.md" },
      ],
    };
    writeNodeHandshake(dir, "review", handshake);
    writeFileSync(join(dir, "acceptance-criteria.md"), "# Functional transition context regression\n");

    const flowFile = join(dir, "functional-transition.json");
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["review", "build"],
      edges: {
        review: { ITERATE: "build" },
        build: { PASS: null },
      },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", build: "build" },
      nodeCapabilities: {
        review: ["capture-context@1"],
        build: ["capture-context@1"],
      },
    }));
    mkdirSync(join(dir, ".opc"), { recursive: true });
    writeFileSync(join(dir, ".opc", "config.json"), JSON.stringify({
      extensionsDir: join(dir, "extensions"),
    }));
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      version: "1.0",
      flowTemplate: "functional-transition",
      currentNode: "review",
      entryNode: "review",
      tier: "functional",
      totalSteps: 1,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [{ nodeId: "review", runId: "run_1", timestamp: new Date().toISOString() }],
      edgeCounts: {},
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "functional-transition-context-test",
    }, null, 2));

    const result = runHarness("transition", [
      "--from", "review", "--to", "build", "--verdict", "ITERATE",
      "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(result.allowed, true, JSON.stringify(result));
    const verdictCtx = JSON.parse(readFileSync(join(reviewRun, "captured-transition-verdict.json"), "utf8"));
    const promptCtx = JSON.parse(readFileSync(join(dir, "captured-transition-prompt.json"), "utf8"));
    for (const context of [verdictCtx, promptCtx]) {
      assert.equal(context.tier, "functional");
      assert.equal(context.visualEvaluationRequired, false);
      assert.equal(context.taskDescription, "Functional transition context regression");
      assert.equal(context.nodeCapabilitiesResolved, true);
    }
    assert.equal(verdictCtx.nodeId, "review");
    assert.equal(verdictCtx.nodeType, "review");
    assert.equal(promptCtx.nodeId, "build");
    assert.equal(promptCtx.nodeType, "build");

    const sealedHandshake = JSON.parse(readFileSync(join(dir, "nodes", "review", "handshake.json"), "utf8"));
    const sealedArtifacts = new Map(sealedHandshake.artifacts.map((artifact) => [artifact.path, artifact.type]));
    assert.equal(sealedArtifacts.get("run_1/captured-transition-verdict.json"), "report");
    assert.equal(sealedArtifacts.get("run_1/eval-extensions.json"), "report");
    assert.equal(sealedArtifacts.get("run_1/eval-extensions.md"), "eval");
    assert.equal(existsSync(join(rogueRun, "captured-transition-verdict.json")), false);
    assert.equal(existsSync(join(rogueRun, "eval-extensions.json")), false);
    assert.deepEqual(
      JSON.parse(readFileSync(join(rogueRun, "handshake.json"), "utf8")),
      { sentinel: "rogue" }
    );
  });

  test("auto review verdict preserves malformed selected-run handshake and records failed provenance", () => {
    const dir = join(TMPBASE, "review-malformed-run-handshake");
    const reviewRun = join(dir, "nodes", "review", "run_1");
    const extensionDir = join(dir, "extensions", "capture");
    mkdirSync(reviewRun, { recursive: true });
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, "hook.mjs"), `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      export const meta = { name: "capture", provides: ["capture-context@1"] };
      export function verdictAppend(ctx) {
        writeFileSync(join(ctx.runDir, "auto-verdict-ran.json"), "{}");
        return [];
      }
    `);
    writeFileSync(join(reviewRun, "eval-custom-one.md"), "first independent review");
    writeFileSync(join(reviewRun, "eval-custom-two.md"), "second independent review");
    writeFileSync(join(reviewRun, "handshake.json"), "{broken");

    const nodeHandshakePath = join(dir, "nodes", "review", "handshake.json");
    writeFileSync(nodeHandshakePath, JSON.stringify({
      nodeId: "review",
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "ITERATE",
      summary: "review requests repair",
      timestamp: new Date().toISOString(),
      artifacts: [
        { type: "eval", path: "run_1/eval-custom-one.md" },
        { type: "eval", path: "run_1/eval-custom-two.md" },
      ],
    }));
    const nodeHandshakeBefore = readFileSync(nodeHandshakePath, "utf8");

    const flowFile = join(dir, "review-malformed-run-handshake.json");
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["review", "build"],
      edges: { review: { ITERATE: "build" }, build: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", build: "build" },
      nodeCapabilities: { review: ["capture-context@1"] },
    }));
    mkdirSync(join(dir, ".opc"), { recursive: true });
    writeFileSync(join(dir, ".opc", "config.json"), JSON.stringify({
      extensionsDir: join(dir, "extensions"),
    }));
    const statePath = join(dir, "flow-state.json");
    writeFileSync(statePath, JSON.stringify({
      version: "1.0",
      flowTemplate: "review-malformed-run-handshake",
      currentNode: "review",
      entryNode: "review",
      tier: "functional",
      totalSteps: 1,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [{ nodeId: "review", runId: "run_1", timestamp: new Date().toISOString() }],
      edgeCounts: {},
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "review-malformed-run-handshake",
    }, null, 2));
    const stateBefore = readFileSync(statePath, "utf8");

    const result = runHarness("transition", [
      "--from", "review", "--to", "build", "--verdict", "ITERATE",
      "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /pre-transition check: cannot parse handshake\.json/);
    assert.equal(readFileSync(statePath, "utf8"), stateBefore);
    assert.equal(readFileSync(join(reviewRun, "handshake.json"), "utf8"), "{broken");
    assert.equal(existsSync(join(reviewRun, "auto-verdict-ran.json")), false);
    assert.equal(readFileSync(nodeHandshakePath, "utf8"), nodeHandshakeBefore);
    assert.equal(existsSync(join(dir, "nodes", "build", "run_1")), false);
  });

  test("review transition rejects malformed extension JSON and preserves canonical provenance", () => {
    const dir = join(TMPBASE, "review-malformed-extension-json");
    const reviewRun = join(dir, "nodes", "review", "run_1");
    const extensionDir = join(dir, "extensions", "capture");
    mkdirSync(reviewRun, { recursive: true });
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, "hook.mjs"), `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      export const meta = { name: "capture", provides: ["capture-context@1"] };
      export function verdictAppend(ctx) {
        writeFileSync(join(ctx.runDir, "test-execution.json"), "{broken");
        return [];
      }
    `);
    writeFileSync(join(reviewRun, "eval-custom-one.md"), "first independent review");
    writeFileSync(join(reviewRun, "eval-custom-two.md"), "second independent review");
    const handshakePath = join(dir, "nodes", "review", "handshake.json");
    writeNodeHandshake(dir, "review", {
      nodeId: "review",
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "ITERATE",
      summary: "review requests repair",
      timestamp: new Date().toISOString(),
      artifacts: [
        { type: "eval", path: "run_1/eval-custom-one.md" },
        { type: "eval", path: "run_1/eval-custom-two.md" },
      ],
    });
    const handshakeBefore = readFileSync(handshakePath, "utf8");
    const runHandshakeBefore = readFileSync(join(reviewRun, "handshake.json"), "utf8");

    const flowFile = join(dir, "review-malformed-extension-json.json");
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["review", "build"],
      edges: { review: { ITERATE: "build" }, build: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", build: "build" },
      nodeCapabilities: { review: ["capture-context@1"] },
    }));
    mkdirSync(join(dir, ".opc"), { recursive: true });
    writeFileSync(join(dir, ".opc", "config.json"), JSON.stringify({ extensionsDir: join(dir, "extensions") }));
    const statePath = join(dir, "flow-state.json");
    writeFileSync(statePath, JSON.stringify({
      version: "1.0",
      flowTemplate: "review-malformed-extension-json",
      currentNode: "review",
      entryNode: "review",
      tier: "functional",
      totalSteps: 1,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [{ nodeId: "review", runId: "run_1", timestamp: new Date().toISOString() }],
      edgeCounts: {},
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "review-malformed-extension-json",
    }, null, 2));
    const stateBefore = readFileSync(statePath, "utf8");

    const result = runHarness("transition", [
      "--from", "review", "--to", "build", "--verdict", "ITERATE",
      "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /transition evidence refresh failed/);
    assert.match(result.reason, /test-execution\.json/);
    assert.equal(readFileSync(statePath, "utf8"), stateBefore);
    assert.equal(readFileSync(handshakePath, "utf8"), handshakeBefore);
    assert.equal(readFileSync(join(reviewRun, "handshake.json"), "utf8"), runHandshakeBefore);
    assert.equal(readFileSync(join(reviewRun, "test-execution.json"), "utf8"), "{broken");
    assert.equal(existsSync(join(dir, "nodes", "build", "run_1")), true);
  });

  test("review transition reserves target before auto-verdict handshake side effects", () => {
    const dir = join(TMPBASE, "review-reservation-before-extension");
    const reviewRun = join(dir, "nodes", "review", "run_1");
    const extensionDir = join(dir, "extensions", "capture");
    mkdirSync(reviewRun, { recursive: true });
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, "hook.mjs"), `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      export const meta = { name: "capture", provides: ["capture-context@1"] };
      export function verdictAppend(ctx) {
        writeFileSync(join(ctx.runDir, "auto-verdict-ran.json"), "{}");
        return [];
      }
    `);
    writeFileSync(join(reviewRun, "eval-custom-one.md"), "first independent review");
    writeFileSync(join(reviewRun, "eval-custom-two.md"), "second independent review");
    const handshakePath = join(dir, "nodes", "review", "handshake.json");
    writeNodeHandshake(dir, "review", {
      nodeId: "review",
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "ITERATE",
      summary: "review requests repair",
      timestamp: new Date().toISOString(),
      artifacts: [
        { type: "eval", path: "run_1/eval-custom-one.md" },
        { type: "eval", path: "run_1/eval-custom-two.md" },
      ],
    });
    const handshakeBefore = readFileSync(handshakePath, "utf8");
    writeFileSync(join(dir, "nodes", "build"), "target node path is not a directory");

    const flowFile = join(dir, "review-reservation-before-extension.json");
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["review", "build"],
      edges: { review: { ITERATE: "build" }, build: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", build: "build" },
      nodeCapabilities: { review: ["capture-context@1"] },
    }));
    mkdirSync(join(dir, ".opc"), { recursive: true });
    writeFileSync(join(dir, ".opc", "config.json"), JSON.stringify({ extensionsDir: join(dir, "extensions") }));
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      version: "1.0",
      flowTemplate: "review-reservation-before-extension",
      currentNode: "review",
      entryNode: "review",
      tier: "functional",
      totalSteps: 1,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [{ nodeId: "review", runId: "run_1", timestamp: new Date().toISOString() }],
      edgeCounts: {},
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "review-reservation-before-extension",
    }, null, 2));

    const result = runHarness("transition", [
      "--from", "review", "--to", "build", "--verdict", "ITERATE",
      "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /cannot reserve run directory/);
    assert.equal(existsSync(join(reviewRun, "auto-verdict-ran.json")), false);
    assert.equal(readFileSync(handshakePath, "utf8"), handshakeBefore);
  });

  test("goto allocates after the highest target-node directory without overwriting evidence", () => {
    const dir = join(TMPBASE, "allocator-goto");
    const buildRun2 = join(dir, "nodes", "build", "run_2");
    mkdirSync(join(dir, "nodes", "build", "run_1"), { recursive: true });
    mkdirSync(buildRun2, { recursive: true });
    writeFileSync(join(buildRun2, "sentinel.txt"), "immutable run two");
    writeFileSync(join(dir, "nodes", "build", "run_99"), "not a directory");

    const flowFile = join(dir, "allocator-goto.json");
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["build", "review"],
      edges: {
        build: { PASS: "review" },
        review: { ITERATE: "build" },
      },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { build: "build", review: "build" },
    }));
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      version: "1.0",
      flowTemplate: "allocator-goto",
      currentNode: "review",
      entryNode: "build",
      totalSteps: 2,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [
        { nodeId: "build", runId: "run_1", timestamp: new Date().toISOString() },
        { nodeId: "review", runId: "run_1", timestamp: new Date().toISOString() },
      ],
      edgeCounts: { "build→review": 1 },
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "allocator-goto-test",
    }, null, 2));

    const result = runHarness("goto", ["build", "--dir", dir]);

    assert.equal(result.goto, "build", JSON.stringify(result));
    assert.equal(result.runId, "run_100");
    assert.equal(readFileSync(join(buildRun2, "sentinel.txt"), "utf8"), "immutable run two");
    assert.equal(existsSync(join(dir, "nodes", "build", "run_100")), true);
    assert.equal(readState(dir).history.at(-1).runId, "run_100");
  });

  test("skip allocates from target filesystem reservations", () => {
    const dir = join(TMPBASE, "allocator-skip");
    const reviewDir = join(dir, "nodes", "review");
    mkdirSync(join(dir, "nodes", "build", "run_1"), { recursive: true });
    mkdirSync(join(reviewDir, "run_1"), { recursive: true });
    writeFileSync(join(reviewDir, "run_7"), "reserved regular file");

    const flowFile = join(dir, "allocator-skip.json");
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["build", "review"],
      edges: { build: { PASS: "review" }, review: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { build: "build", review: "build" },
    }));
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      version: "1.0",
      flowTemplate: "allocator-skip",
      currentNode: "build",
      entryNode: "build",
      totalSteps: 0,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [{ nodeId: "build", runId: "run_1", timestamp: new Date().toISOString() }],
      edgeCounts: {},
      repairEdgeCounts: {},
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "allocator-skip-test",
    }, null, 2));

    const result = runHarness("skip", ["--dir", dir]);

    assert.equal(result.skipped, "build", JSON.stringify(result));
    assert.equal(result.runId, "run_8");
    assert.equal(existsSync(join(reviewDir, "run_8")), true);
    assert.equal(readState(dir).history.at(-1).runId, "run_8");
  });

  test("transition, goto, and skip do not advance state when run reservation fails", () => {
    for (const command of ["transition", "goto", "skip"]) {
      const dir = join(TMPBASE, `allocator-reservation-failure-${command}`);
      const buildDir = join(dir, "nodes", "build");
      mkdirSync(join(buildDir, "run_1"), { recursive: true });
      writeFileSync(join(buildDir, "handshake.json"), JSON.stringify({
        nodeId: "build",
        nodeType: "build",
        runId: "run_1",
        status: "completed",
        verdict: null,
        summary: "ready",
        timestamp: new Date().toISOString(),
        artifacts: [],
      }));
      writeFileSync(join(dir, "nodes", "review"), "target node path is not a directory");

      const flowFile = join(dir, `allocator-reservation-failure-${command}.json`);
      writeFileSync(flowFile, JSON.stringify({
        opc_compat: ">=0.0",
        nodes: ["build", "review"],
        edges: { build: { PASS: "review" }, review: { PASS: null } },
        limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
        nodeTypes: { build: "build", review: "build" },
      }));
      const statePath = join(dir, "flow-state.json");
      writeFileSync(statePath, JSON.stringify({
        version: "1.0",
        flowTemplate: `allocator-reservation-failure-${command}`,
        currentNode: "build",
        entryNode: "build",
        totalSteps: 0,
        maxTotalSteps: 10,
        maxLoopsPerEdge: 3,
        maxNodeReentry: 5,
        history: [{ nodeId: "build", runId: "run_1", timestamp: new Date().toISOString() }],
        edgeCounts: {},
        repairEdgeCounts: {},
        _flow_file: flowFile,
        _written_by: "opc-harness",
        _write_nonce: `allocator-reservation-failure-${command}`,
      }, null, 2));
      const before = readFileSync(statePath, "utf8");

      const args = command === "transition"
        ? ["--from", "build", "--to", "review", "--verdict", "PASS", "--flow-file", flowFile, "--dir", dir]
        : command === "goto"
          ? ["review", "--dir", dir]
          : ["--dir", dir];
      const result = runHarness(command, args);

      assert.equal(readFileSync(statePath, "utf8"), before, `${command}: ${JSON.stringify(result)}`);
    }
  });

  test("non-gate transition rejects a stale canonical source handshake before side effects", () => {
    const dir = join(TMPBASE, "stale-source-runid-transition");
    const reviewRun1 = join(dir, "nodes", "review", "run_1");
    const reviewRun2 = join(dir, "nodes", "review", "run_2");
    const extensionDir = join(dir, "extensions", "capture");
    mkdirSync(reviewRun1, { recursive: true });
    mkdirSync(reviewRun2, { recursive: true });
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, "hook.mjs"), `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      export const meta = { name: "capture", provides: ["capture-context@1"] };
      export function verdictAppend(ctx) {
        writeFileSync(join(ctx.flowDir, "stale-source-hook-ran"), "unexpected");
        return [];
      }
    `);

    const staleHandshake = {
      nodeId: "review",
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "ITERATE",
      summary: "stale review evidence",
      timestamp: new Date().toISOString(),
      artifacts: [
        { type: "eval", path: "run_1/eval-custom-one.md" },
        { type: "eval", path: "run_1/eval-custom-two.md" },
      ],
    };
    writeFileSync(join(reviewRun1, "eval-custom-one.md"), "first stale evaluation");
    writeFileSync(join(reviewRun1, "eval-custom-two.md"), "second stale evaluation");
    writeNodeHandshake(dir, "review", staleHandshake);

    const currentHandshake = {
      ...staleHandshake,
      runId: "run_2",
      summary: "current review evidence",
      artifacts: [
        { type: "eval", path: "run_2/eval-custom-one.md" },
        { type: "eval", path: "run_2/eval-custom-two.md" },
      ],
    };
    writeFileSync(join(reviewRun2, "eval-custom-one.md"), "first current evaluation");
    writeFileSync(join(reviewRun2, "eval-custom-two.md"), "second current evaluation");
    writeFileSync(join(reviewRun2, "handshake.json"), JSON.stringify(currentHandshake));

    const flowFile = join(dir, "stale-source-runid-transition.json");
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["review", "build"],
      edges: { review: { ITERATE: "build" }, build: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", build: "build" },
      nodeCapabilities: { review: ["capture-context@1"] },
    }));
    mkdirSync(join(dir, ".opc"), { recursive: true });
    writeFileSync(join(dir, ".opc", "config.json"), JSON.stringify({
      extensionsDir: join(dir, "extensions"),
    }));
    const statePath = join(dir, "flow-state.json");
    writeFileSync(statePath, JSON.stringify({
      version: "1.0",
      flowTemplate: "stale-source-runid-transition",
      currentNode: "review",
      entryNode: "review",
      tier: "functional",
      totalSteps: 1,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [{ nodeId: "review", runId: "run_2", timestamp: new Date().toISOString() }],
      edgeCounts: {},
      repairEdgeCounts: {},
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "stale-source-runid-transition",
    }, null, 2));
    const stateBefore = readFileSync(statePath, "utf8");
    const canonicalBefore = readFileSync(join(dir, "nodes", "review", "handshake.json"), "utf8");

    const result = runHarness("transition", [
      "--from", "review", "--to", "build", "--verdict", "ITERATE",
      "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /runId.*run_1.*run_2|run_1.*expected.*run_2/);
    assert.equal(readFileSync(statePath, "utf8"), stateBefore);
    assert.equal(readFileSync(join(dir, "nodes", "review", "handshake.json"), "utf8"), canonicalBefore);
    assert.equal(existsSync(join(dir, "stale-source-hook-ran")), false);
    assert.equal(existsSync(join(dir, "nodes", "build")), false);
  });

  test("gate transition binds source handshake to the exact current run", () => {
    const dir = join(TMPBASE, "source-runid-transition");
    const sourceRunId = "run_9007199254740993";
    mkdirSync(join(dir, "nodes", "gate", sourceRunId), { recursive: true });

    const flowFile = join(dir, "source-runid-transition.json");
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["gate", "build"],
      edges: { gate: { PASS: "build" }, build: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { gate: "gate", build: "build" },
    }));
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      version: "1.0",
      flowTemplate: "source-runid-transition",
      currentNode: "gate",
      entryNode: "gate",
      totalSteps: 1,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [{ nodeId: "gate", runId: sourceRunId, timestamp: new Date().toISOString() }],
      edgeCounts: {},
      repairEdgeCounts: {},
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "source-runid-transition",
    }, null, 2));

    const result = runHarness("transition", [
      "--from", "gate", "--to", "build", "--verdict", "PASS",
      "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(result.allowed, true, JSON.stringify(result));
    assert.equal(
      JSON.parse(readFileSync(join(dir, "nodes", "gate", "handshake.json"), "utf8")).runId,
      sourceRunId,
    );
  });

  test("skip binds source handshake to the exact current run", () => {
    const dir = join(TMPBASE, "source-runid-skip");
    const sourceRunId = "run_9007199254740993";
    mkdirSync(join(dir, "nodes", "build", sourceRunId), { recursive: true });

    const flowFile = join(dir, "source-runid-skip.json");
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["build", "review"],
      edges: { build: { PASS: "review" }, review: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { build: "build", review: "review" },
    }));
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      version: "1.0",
      flowTemplate: "source-runid-skip",
      currentNode: "build",
      entryNode: "build",
      totalSteps: 1,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [{ nodeId: "build", runId: sourceRunId, timestamp: new Date().toISOString() }],
      edgeCounts: {},
      repairEdgeCounts: {},
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "source-runid-skip",
    }, null, 2));

    const result = runHarness("skip", ["--dir", dir]);

    assert.equal(result.skipped, "build", JSON.stringify(result));
    assert.equal(
      JSON.parse(readFileSync(join(dir, "nodes", "build", "handshake.json"), "utf8")).runId,
      sourceRunId,
    );
  });

  test("finalize auto-handshake binds to the exact terminal run", () => {
    const dir = join(TMPBASE, "source-runid-finalize");
    const sourceRunId = "run_9007199254740993";
    mkdirSync(join(dir, "nodes", "gate", sourceRunId), { recursive: true });

    const flowFile = join(dir, "source-runid-finalize.json");
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["gate"],
      edges: { gate: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { gate: "gate" },
    }));
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      version: "1.0",
      flowTemplate: "source-runid-finalize",
      currentNode: "gate",
      entryNode: "gate",
      totalSteps: 1,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [{ nodeId: "gate", runId: sourceRunId, timestamp: new Date().toISOString() }],
      edgeCounts: {},
      repairEdgeCounts: {},
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "source-runid-finalize",
    }, null, 2));

    const result = runHarness("finalize", ["--dir", dir]);

    assert.equal(result.finalized, true, JSON.stringify(result));
    assert.equal(
      JSON.parse(readFileSync(join(dir, "nodes", "gate", "handshake.json"), "utf8")).runId,
      sourceRunId,
    );
  });

  test("seal preserves matched no-op prompt participant from the selected run", () => {
    const dir = join(TMPBASE, "prompt-participant-seal");
    const runDir = join(dir, "nodes", "build", "run_1");
    const extensionDir = join(dir, "extensions", "capture");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(runDir, "output.md"), "build output");
    writeFileSync(join(runDir, "handshake.json"), JSON.stringify({
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: null,
      summary: "built",
      timestamp: new Date().toISOString(),
      artifacts: [],
    }));
    writeFileSync(join(extensionDir, "hook.mjs"), `
      export const meta = { name: "capture", provides: ["capture-context@1"] };
      export function promptAppend() { return ""; }
    `);
    const flowFile = join(dir, "prompt-participant-seal.json");
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["build"],
      edges: { build: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { build: "build" },
      nodeCapabilities: { build: ["capture-context@1"] },
    }));
    mkdirSync(join(dir, ".opc"), { recursive: true });
    writeFileSync(join(dir, ".opc", "config.json"), JSON.stringify({
      extensionsDir: join(dir, "extensions"),
      requiredExtensions: ["capture"],
    }));
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      version: "1.0",
      flowTemplate: "prompt-participant-seal",
      currentNode: "build",
      entryNode: "build",
      tier: "functional",
      totalSteps: 0,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [{ nodeId: "build", runId: "run_1", timestamp: new Date().toISOString() }],
      edgeCounts: {},
      repairEdgeCounts: {},
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "prompt-participant-seal",
    }, null, 2));

    const prompt = runHarness("prompt-context", [
      "--node", "build", "--role", "implementer", "--flow-file", flowFile, "--dir", dir,
    ]);
    assert.deepEqual(prompt.applied, ["capture"], JSON.stringify(prompt));
    const seal = runHarness("seal", ["--node", "build", "--run", "1", "--dir", dir]);
    assert.equal(seal.sealed, true, JSON.stringify(seal));
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, "nodes", "build", "handshake.json"), "utf8")).extensionsApplied,
      ["capture"],
    );
    const promptSidecar = JSON.parse(readFileSync(join(runDir, "prompt-extensions.json"), "utf8"));
    assert.equal(promptSidecar.nodeId, "build");
    assert.equal(promptSidecar.runId, "run_1");
    assert.deepEqual(promptSidecar.extensionsApplied, ["capture"]);
    assert.equal(runHarness("validate-chain", ["--dir", dir]).valid, true);

    const rogueRun = join(dir, "nodes", "build", "run_2");
    mkdirSync(rogueRun, { recursive: true });
    writeFileSync(join(rogueRun, "prompt-extensions.json"), JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      nodeId: "build",
      runId: "run_2",
      extensionsApplied: ["capture"],
    }));
    rmSync(join(runDir, "prompt-extensions.json"));

    const missingSelectedSidecar = runHarness("seal", ["--node", "build", "--run", "1", "--dir", dir]);
    assert.equal(missingSelectedSidecar.sealed, false, JSON.stringify(missingSelectedSidecar));
    assert.match(missingSelectedSidecar.validationErrors.join(" "), /prompt-extensions\.json.*not found|not found.*prompt-extensions\.json/);
    const missingChain = runHarness("validate-chain", ["--dir", dir]);
    assert.equal(missingChain.valid, false, JSON.stringify(missingChain));
    assert.match(missingChain.errors.join(" "), /run_1\/prompt-extensions\.json.*not found/);

    writeFileSync(join(runDir, "prompt-extensions.json"), "{broken");
    const malformedSelectedSidecar = runHarness("seal", ["--node", "build", "--run", "1", "--dir", dir]);
    assert.equal(malformedSelectedSidecar.sealed, false, JSON.stringify(malformedSelectedSidecar));
    assert.match(malformedSelectedSidecar.validationErrors.join(" "), /prompt-extensions\.json.*parse error/);
    const malformedChain = runHarness("validate-chain", ["--dir", dir]);
    assert.equal(malformedChain.valid, false, JSON.stringify(malformedChain));
    assert.match(malformedChain.errors.join(" "), /run_1\/prompt-extensions\.json.*parse error/);

    writeFileSync(join(runDir, "prompt-extensions.json"), JSON.stringify(promptSidecar));
    writeFileSync(join(runDir, "handshake.json"), "{broken");
    const malformedRunHandshake = runHarness("seal", ["--node", "build", "--run", "1", "--dir", dir]);
    assert.equal(malformedRunHandshake.sealed, false, JSON.stringify(malformedRunHandshake));
    assert.match(malformedRunHandshake.validationErrors.join(" "), /run_1\/handshake\.json.*parse error/);
    assert.equal(readFileSync(join(runDir, "handshake.json"), "utf8"), "{broken");
  });

  test("validate-chain rejects an unknown flow template", () => {
    const dir = join(TMPBASE, "unknown-template-chain");
    mkdirSync(join(dir, ".opc"), { recursive: true });
    writeFileSync(join(dir, ".opc", "config.json"), JSON.stringify({
      requiredExtensions: ["required-extension"],
    }));
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      version: "1.0",
      flowTemplate: "does-not-exist",
      currentNode: "build",
      entryNode: "build",
      totalSteps: 0,
      history: [],
      edgeCounts: {},
      repairEdgeCounts: {},
    }));

    const result = runHarness("validate-chain", ["--dir", dir]);
    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join(" "), /unknown flow template: does-not-exist/);
  });
});

describe("semantic flow budgets", () => {
  const template = {
    edges: {
      build: { PASS: "review" },
      review: { ITERATE: "build" },
      terminal: { PASS: null },
    },
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 12, maxNodeReentry: 5 },
  };

  function budgetState(overrides = {}) {
    return {
      totalSteps: 3,
      maxTotalSteps: 12,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [],
      edgeCounts: {},
      repairEdgeCounts: {},
      ...overrides,
    };
  }

  test("only FAIL and ITERATE are repair verdicts", () => {
    assert.equal(isRepairVerdict("FAIL"), true);
    assert.equal(isRepairVerdict("iterate"), true);
    assert.equal(isRepairVerdict("PASS"), false);
    assert.equal(isRepairVerdict(null), false);
  });

  test("forward PASS ignores traversal count while repair edges enforce their semantic count", () => {
    const state = budgetState({
      edgeCounts: { "build→review": 3, "review→build": 9 },
      repairEdgeCounts: { "review→build": 2 },
    });
    const forward = evaluateFlowBudget({ state, template, from: "build", to: "review", verdict: "PASS" });
    const repair = evaluateFlowBudget({ state, template, from: "review", to: "build", verdict: "ITERATE" });

    assert.equal(forward.allowed, true);
    assert.equal(repair.allowed, true);
    assert.equal(repair.repairCount, 2);

    state.repairEdgeCounts["review→build"] = 3;
    const exhausted = evaluateFlowBudget({ state, template, from: "review", to: "build", verdict: "FAIL" });
    assert.equal(exhausted.allowed, false);
    assert.match(exhausted.reason, /repair edge 'review→build'/);
  });

  test("legacy states derive repair counts from edgeCounts and seed the new counter map", () => {
    const state = budgetState({ edgeCounts: { "review→build": 2 } });
    delete state.repairEdgeCounts;

    assert.deepEqual(repairEdgeCount(state, "review→build"), { count: 2 });
    const seeded = seedRepairEdgeCounts(state, template);
    assert.deepEqual(seeded, { "review→build": 2 });
    assert.equal(seedRepairEdgeCounts(state, template), seeded);
  });

  test("invalid counters, total-step exhaustion, and node reentry fail closed", () => {
    for (const repairEdgeCounts of [null, "invalid", []]) {
      assert.match(
        repairEdgeCount({ repairEdgeCounts }, "review→build").error,
        /repairEdgeCounts is invalid/,
      );
      assert.match(
        evaluateFlowBudget({
          state: budgetState({ repairEdgeCounts }),
          template,
          from: "build",
          to: "review",
          verdict: "PASS",
        }).reason,
        /repairEdgeCounts is invalid/,
      );
    }

    for (const edgeCounts of [null, "invalid", []]) {
      assert.match(
        evaluateFlowBudget({
          state: budgetState({ edgeCounts }),
          template,
          from: "build",
          to: "review",
          verdict: "PASS",
        }).reason,
        /edgeCounts is invalid/,
      );
    }

    for (const totalSteps of [-1, 1.5, "1"]) {
      assert.match(
        evaluateFlowBudget({
          state: budgetState({ totalSteps }),
          template,
          from: "build",
          to: "review",
          verdict: "PASS",
        }).reason,
        /totalSteps must be a non-negative integer/,
      );
    }

    const unrelatedTraversal = budgetState({ edgeCounts: { "unrelated→edge": -1 } });
    assert.match(
      evaluateFlowBudget({ state: unrelatedTraversal, template, from: "build", to: "review", verdict: "PASS" }).reason,
      /unrelated→edge/,
    );

    const unrelatedRepair = budgetState({ repairEdgeCounts: { "unrelated→edge": -1 } });
    assert.match(
      evaluateFlowBudget({ state: unrelatedRepair, template, from: "build", to: "review", verdict: "PASS" }).reason,
      /repairEdgeCounts count is invalid for edge 'unrelated→edge'/,
    );

    const invalidCount = budgetState({ repairEdgeCounts: { "review→build": -1 } });
    assert.match(repairEdgeCount(invalidCount, "review→build").error, /count is invalid/);

    const legacyInvalid = budgetState({ edgeCounts: { "review→build": -1 } });
    delete legacyInvalid.repairEdgeCounts;
    assert.throws(() => seedRepairEdgeCounts(legacyInvalid, template), /edgeCounts count is invalid/);

    const maxSteps = budgetState({ totalSteps: 12 });
    assert.match(
      evaluateFlowBudget({ state: maxSteps, template, from: "build", to: "review", verdict: "PASS" }).reason,
      /maxTotalSteps/,
    );

    const maxReentry = budgetState({
      history: Array.from({ length: 5 }, () => ({ nodeId: "review" })),
    });
    assert.match(
      evaluateFlowBudget({ state: maxReentry, template, from: "build", to: "review", verdict: "PASS" }).reason,
      /maxNodeReentry/,
    );

    assert.deepEqual(
      evaluateFlowBudget({ state: maxSteps, template, from: "terminal", to: null, verdict: "PASS" }),
      { allowed: true, terminal: true },
    );

    for (const [state, expected] of [
      [budgetState({ totalSteps: "corrupt" }), /totalSteps/],
      [budgetState({ edgeCounts: { "unrelated→edge": -1 } }), /edgeCounts/],
      [budgetState({ repairEdgeCounts: { "unrelated→edge": -1 } }), /repairEdgeCounts/],
      [budgetState({ maxTotalSteps: null }), /maxTotalSteps/],
    ]) {
      const result = evaluateFlowBudget({ state, template, from: "terminal", to: null, verdict: "PASS" });
      assert.equal(result.allowed, false);
      assert.match(result.reason, expected);
    }
  });

  test("malformed state and history fail closed for terminal and nonterminal edges", () => {
    for (const state of [null, [], "invalid"]) {
      const result = evaluateFlowBudget({ state, template, from: "terminal", to: null, verdict: "PASS" });
      assert.equal(result.allowed, false);
      assert.match(result.reason, /state is invalid/);
    }

    for (const history of [null, {}, "invalid"]) {
      for (const to of [null, "review"]) {
        const result = evaluateFlowBudget({
          state: budgetState({ history }),
          template,
          from: to === null ? "terminal" : "build",
          to,
          verdict: "PASS",
        });
        assert.equal(result.allowed, false);
        assert.match(result.reason, /history is invalid/);
      }
    }
  });

  test("finalize revalidates fresh state under the acquired lock", () => {
    const dir = createSession("finalize-lock-revalidation");
    const statePath = join(dir, "flow-state.json");
    const before = readFileSync(statePath, "utf8");
    const mutated = {
      ...JSON.parse(before),
      currentNode: "build",
      _written_by: "external-writer",
    };
    const originalReadFileSync = fs.readFileSync;
    const output = [];
    const originalLog = console.log;

    fs.readFileSync = (path, ...args) => {
      if (String(path) === statePath && existsSync(`${statePath}.lock`)) {
        return JSON.stringify(mutated, null, 2);
      }
      return originalReadFileSync(path, ...args);
    };
    syncBuiltinESMExports();
    console.log = (...args) => output.push(args.join(" "));
    try {
      cmdFinalize(["--dir", dir]);
    } finally {
      console.log = originalLog;
      fs.readFileSync = originalReadFileSync;
      syncBuiltinESMExports();
    }

    const result = JSON.parse(output.at(-1));
    assert.equal(result.finalized, false, JSON.stringify(result));
    assert.match(result.error, /not written by opc-harness|not a terminal node/);
    assert.equal(readFileSync(statePath, "utf8"), before);
  });

  test("terminal transition and finalize reject malformed limits without mutating state", () => {
    for (const command of ["transition", "finalize"]) {
      const dir = createSession(`terminal-malformed-limit-${command}`);
      const statePath = join(dir, "flow-state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.maxTotalSteps = null;
      writeFileSync(statePath, JSON.stringify(state, null, 2));
      const before = readFileSync(statePath, "utf8");

      const args = command === "transition"
        ? [
            "--from", "gate", "--to", "null", "--verdict", "PASS",
            "--flow", "build-verify", "--dir", dir,
          ]
        : ["--dir", dir];
      const result = runHarness(command, args);

      assert.equal(command === "transition" ? result.allowed : result.finalized, false, JSON.stringify(result));
      assert.match(command === "transition" ? result.reason : result.error, /maxTotalSteps/);
      assert.equal(readFileSync(statePath, "utf8"), before);
    }
  });

  test("defaults, malformed limits, and sparse templates fail closed deterministically", () => {
    const templateOnlyState = { totalSteps: 0, history: [], edgeCounts: {} };
    assert.equal(
      evaluateFlowBudget({ state: templateOnlyState, template, from: "build", to: "review", verdict: "PASS" }).allowed,
      true,
    );

    for (const [overrides, expected] of [
      [{ maxTotalSteps: 0 }, /maxTotalSteps/],
      [{ maxLoopsPerEdge: 1.5 }, /maxLoopsPerEdge/],
      [{ maxNodeReentry: "5" }, /maxNodeReentry/],
    ]) {
      const result = evaluateFlowBudget({
        state: budgetState(overrides),
        template,
        from: "build",
        to: "review",
        verdict: "PASS",
      });
      assert.equal(result.allowed, false);
      assert.match(result.reason, expected);
    }

    assert.deepEqual(repairEdgeCount({ edgeCounts: undefined }, "missing→edge"), { count: 0 });
    assert.throws(
      () => seedRepairEdgeCounts({ repairEdgeCounts: null }, template),
      /repairEdgeCounts is invalid/,
    );
    assert.throws(
      () => seedRepairEdgeCounts({ repairEdgeCounts: { "review→build": -1 } }, template),
      /repairEdgeCounts count is invalid/,
    );

    const noEdgesState = { edgeCounts: {} };
    assert.deepEqual(seedRepairEdgeCounts(noEdgesState, {}), {});
    const missingLegacyCounts = {};
    assert.deepEqual(seedRepairEdgeCounts(missingLegacyCounts, {
      edges: { review: { ITERATE: "build" } },
    }), { "review→build": 0 });
    const sparseState = { edgeCounts: {} };
    assert.deepEqual(seedRepairEdgeCounts(sparseState, {
      edges: {
        absent: null,
        forward: { PASS: "review", FAIL: null },
      },
    }), {});

    const emptyRepair = evaluateFlowBudget({
      state: budgetState(),
      template,
      from: "review",
      to: "build",
      verdict: "ITERATE",
    });
    assert.equal(emptyRepair.allowed, true);
    assert.equal(emptyRepair.repairCount, 0);

    const nullThenForward = nodeHasBudgetedExit({
      state: budgetState(),
      template: {
        edges: { review: { FAIL: null, PASS: "build" } },
        limits: template.limits,
      },
      node: "review",
    });
    assert.equal(nullThenForward.available, true);
    assert.equal(nullThenForward.verdict, "PASS");
  });

  test("goto exit checks allow terminal/forward exits and reject fully exhausted targets", () => {
    assert.deepEqual(
      nodeHasBudgetedExit({ state: budgetState({ totalSteps: 12 }), template, node: "terminal" }),
      { available: true, terminal: true },
    );

    const forward = nodeHasBudgetedExit({
      state: budgetState({ edgeCounts: { "build→review": 99 } }),
      template,
      node: "build",
    });
    assert.equal(forward.available, true);
    assert.equal(forward.verdict, "PASS");

    const exhausted = nodeHasBudgetedExit({
      state: budgetState({ repairEdgeCounts: { "review→build": 3 } }),
      template,
      node: "review",
    });
    assert.equal(exhausted.available, false);
    assert.equal(exhausted.reasons.length, 1);

    assert.deepEqual(
      nodeHasBudgetedExit({ state: budgetState(), template: { edges: {}, limits: template.limits }, node: "missing" }),
      { available: false, reasons: [] },
    );
  });

  test("corrupt state makes route and transition fail closed with the same reason", () => {
    const dir = join(TMPBASE, "semantic-corrupt-state");
    const flowFile = join(dir, "semantic-corrupt.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["build", "review"],
      edges: { build: { PASS: "review" }, review: { ITERATE: "build" } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { build: "build", review: "build" },
    }));
    writeFileSync(join(dir, "flow-state.json"), "{");

    const route = runHarness("route", [
      "--node", "build", "--verdict", "PASS", "--flow-file", flowFile, "--dir", dir,
    ]);
    const transition = runHarness("transition", [
      "--from", "build", "--to", "review", "--verdict", "PASS",
      "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(route.valid, false, JSON.stringify(route));
    assert.equal(transition.allowed, false, JSON.stringify(transition));
    assert.equal(route.error, transition.reason);
    assert.match(route.error, /corrupt flow-state\.json/);
  });

  test("malformed counters reject route, transition, goto, and skip before side effects", () => {
    const flow = {
      opc_compat: ">=0.0",
      nodes: ["build", "review"],
      edges: { build: { PASS: "review" }, review: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { build: "build", review: "build" },
    };
    const scenarios = [
      { name: "edge-map", patch: { edgeCounts: [] }, expected: /edgeCounts is invalid/ },
      { name: "total-steps", patch: { totalSteps: "0" }, expected: /totalSteps must be a non-negative integer/ },
      {
        name: "unrelated-traversal",
        patch: { edgeCounts: { "unrelated→edge": -1 } },
        expected: /edgeCounts count is invalid for edge 'unrelated→edge'/,
      },
      {
        name: "unrelated-repair",
        patch: { repairEdgeCounts: { "unrelated→edge": -1 } },
        expected: /repairEdgeCounts count is invalid for edge 'unrelated→edge'/,
      },
    ];

    for (const scenario of scenarios) {
      for (const command of ["transition", "goto", "skip"]) {
        const dir = join(TMPBASE, `semantic-invalid-${scenario.name}-${command}`);
        const buildDir = join(dir, "nodes", "build");
        mkdirSync(join(buildDir, "run_1"), { recursive: true });
        writeFileSync(join(buildDir, "handshake.json"), JSON.stringify({
          nodeId: "build",
          nodeType: "build",
          runId: "run_1",
          status: "completed",
          verdict: null,
          summary: "ready",
          timestamp: new Date().toISOString(),
          artifacts: [],
        }));
        const flowFile = join(dir, `semantic-invalid-${scenario.name}.json`);
        writeFileSync(flowFile, JSON.stringify(flow));
        const statePath = join(dir, "flow-state.json");
        writeFileSync(statePath, JSON.stringify({
          version: "1.0",
          flowTemplate: `semantic-invalid-${scenario.name}`,
          currentNode: "build",
          entryNode: "build",
          totalSteps: 0,
          maxTotalSteps: 10,
          maxLoopsPerEdge: 3,
          maxNodeReentry: 5,
          history: [{ nodeId: "build", runId: "run_1", timestamp: new Date().toISOString() }],
          edgeCounts: {},
          repairEdgeCounts: {},
          _flow_file: flowFile,
          _written_by: "opc-harness",
          _write_nonce: `semantic-invalid-${scenario.name}-${command}`,
          ...scenario.patch,
        }, null, 2));
        const before = readFileSync(statePath, "utf8");

        if (command === "transition") {
          const route = runHarness("route", [
            "--node", "build", "--verdict", "PASS", "--flow-file", flowFile, "--dir", dir,
          ]);
          const transition = runHarness("transition", [
            "--from", "build", "--to", "review", "--verdict", "PASS",
            "--flow-file", flowFile, "--dir", dir,
          ]);
          assert.equal(route.valid, false, JSON.stringify(route));
          assert.equal(transition.allowed, false, JSON.stringify(transition));
          assert.equal(route.error, transition.reason);
          assert.match(route.error, scenario.expected);
        } else {
          const result = command === "goto"
            ? runHarness("goto", ["review", "--dir", dir])
            : runHarness("skip", ["--dir", dir]);
          assert.match(result.error, scenario.expected, JSON.stringify(result));
        }

        assert.equal(readFileSync(statePath, "utf8"), before, `${scenario.name}:${command}`);
        assert.equal(
          existsSync(join(dir, "nodes", "review", "run_1")),
          false,
          `${scenario.name}:${command}`,
        );
      }
    }
  });

  test("invalid limits and unrelated legacy repair counts reject before side effects", () => {
    const dir = join(TMPBASE, "semantic-invalid-state");
    const flowFile = join(dir, "semantic-invalid.json");
    const statePath = join(dir, "flow-state.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["build", "review", "gate", "brief"],
      edges: {
        build: { PASS: "review" },
        review: { ITERATE: "build" },
        gate: { FAIL: "brief" },
        brief: { PASS: "gate" },
      },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { build: "build", review: "build", gate: "build", brief: "build" },
    }));
    const baseState = {
      version: "1.0",
      flowTemplate: "semantic-invalid",
      currentNode: "review",
      entryNode: "build",
      totalSteps: 0,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 0,
      maxNodeReentry: 5,
      history: [],
      edgeCounts: { "review→build": 0 },
      repairEdgeCounts: {},
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "semantic-invalid-state-test",
    };
    writeFileSync(statePath, JSON.stringify(baseState, null, 2));
    const beforeInvalidLimit = readFileSync(statePath, "utf8");

    const route = runHarness("route", [
      "--node", "review", "--verdict", "ITERATE", "--flow-file", flowFile, "--dir", dir,
    ]);
    const transition = runHarness("transition", [
      "--from", "review", "--to", "build", "--verdict", "ITERATE",
      "--flow-file", flowFile, "--dir", dir,
    ]);
    assert.equal(route.valid, false, JSON.stringify(route));
    assert.equal(transition.allowed, false, JSON.stringify(transition));
    assert.equal(route.error, transition.reason);
    assert.match(route.error, /maxLoopsPerEdge must be a positive integer/);
    assert.equal(readFileSync(statePath, "utf8"), beforeInvalidLimit);

    const legacyState = {
      ...baseState,
      maxLoopsPerEdge: 3,
      edgeCounts: { "review→build": 0, "gate→brief": -1 },
    };
    delete legacyState.repairEdgeCounts;
    writeFileSync(statePath, JSON.stringify(legacyState, null, 2));
    const beforeLegacyMigration = readFileSync(statePath, "utf8");
    const legacyRoute = runHarness("route", [
      "--node", "review", "--verdict", "ITERATE", "--flow-file", flowFile, "--dir", dir,
    ]);
    const legacyTransition = runHarness("transition", [
      "--from", "review", "--to", "build", "--verdict", "ITERATE",
      "--flow-file", flowFile, "--dir", dir,
    ]);
    assert.equal(legacyRoute.valid, false, JSON.stringify(legacyRoute));
    assert.equal(legacyTransition.allowed, false, JSON.stringify(legacyTransition));
    assert.equal(legacyRoute.error, legacyTransition.reason);
    assert.match(legacyTransition.reason, /gate→brief/);
    assert.equal(readFileSync(statePath, "utf8"), beforeLegacyMigration);
    assert.equal(existsSync(join(dir, "nodes", "build")), false);
  });

  test("goto accepts a terminal target with a PASS-to-null exit", () => {
    const dir = join(TMPBASE, "semantic-terminal-goto");
    const flowFile = join(dir, "semantic-terminal.json");
    mkdirSync(join(dir, "nodes", "build", "run_1"), { recursive: true });
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["build", "terminal"],
      edges: { build: { PASS: "terminal" }, terminal: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { build: "build", terminal: "gate" },
    }));
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      version: "1.0",
      flowTemplate: "semantic-terminal",
      currentNode: "build",
      entryNode: "build",
      totalSteps: 0,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 5,
      history: [],
      edgeCounts: {},
      repairEdgeCounts: {},
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "semantic-terminal-goto-test",
    }, null, 2));

    const result = runHarness("goto", ["terminal", "--dir", dir]);
    assert.equal(result.goto, "terminal", JSON.stringify(result));
    assert.equal(readState(dir).currentNode, "terminal");
    assert.equal(existsSync(join(dir, "nodes", "terminal", "run_1")), true);
  });

  test("three repair rounds allow the fourth forward review but reject a fourth repair", () => {
    const dir = join(TMPBASE, "semantic-repair-lifecycle");
    const flowFile = join(dir, "semantic-repair.json");
    mkdirSync(join(dir, "nodes", "build", "run_1"), { recursive: true });
    mkdirSync(join(dir, "nodes", "review"), { recursive: true });
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["build", "review"],
      edges: {
        build: { PASS: "review" },
        review: { ITERATE: "build" },
      },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 20, maxNodeReentry: 10 },
      nodeTypes: { build: "build", review: "build" },
    }));
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      version: "1.0",
      flowTemplate: "semantic-repair",
      currentNode: "build",
      entryNode: "build",
      totalSteps: 0,
      maxTotalSteps: 20,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 10,
      history: [{ nodeId: "build", runId: "run_1", timestamp: new Date().toISOString() }],
      edgeCounts: {},
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "semantic-repair-lifecycle-test",
    }, null, 2));

    const writeHandshake = (nodeId, verdict, runId) => {
      writeNodeHandshake(dir, nodeId, {
        nodeId,
        nodeType: "build",
        runId,
        status: "completed",
        verdict,
        summary: `${nodeId} ${verdict}`,
        timestamp: new Date().toISOString(),
        artifacts: [],
      });
    };

    for (let round = 1; round <= 3; round++) {
      writeHandshake("build", null, `run_${round}`);
      const forward = runHarness("transition", [
        "--from", "build", "--to", "review", "--verdict", "PASS",
        "--flow-file", flowFile, "--dir", dir,
      ]);
      assert.equal(forward.allowed, true, JSON.stringify(forward));

      writeHandshake("review", "ITERATE", `run_${round}`);
      const repair = runHarness("transition", [
        "--from", "review", "--to", "build", "--verdict", "ITERATE",
        "--flow-file", flowFile, "--dir", dir,
      ]);
      assert.equal(repair.allowed, true, JSON.stringify(repair));
    }

    writeHandshake("build", null, "run_4");
    const finalRoute = runHarness("route", [
      "--node", "build", "--verdict", "PASS", "--flow-file", flowFile, "--dir", dir,
    ]);
    assert.equal(finalRoute.valid, true, JSON.stringify(finalRoute));
    assert.equal(finalRoute.next, "review");

    const finalForward = runHarness("transition", [
      "--from", "build", "--to", "review", "--verdict", "PASS",
      "--flow-file", flowFile, "--dir", dir,
    ]);
    assert.equal(finalForward.allowed, true, JSON.stringify(finalForward));
    assert.equal(finalForward.runId, "run_4");

    writeHandshake("review", "ITERATE", "run_4");
    const blockedRoute = runHarness("route", [
      "--node", "review", "--verdict", "ITERATE", "--flow-file", flowFile, "--dir", dir,
    ]);
    const blockedTransition = runHarness("transition", [
      "--from", "review", "--to", "build", "--verdict", "ITERATE",
      "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(blockedRoute.valid, false, JSON.stringify(blockedRoute));
    assert.equal(blockedTransition.allowed, false, JSON.stringify(blockedTransition));
    assert.equal(blockedRoute.error, blockedTransition.reason);

    const state = readState(dir);
    assert.equal(state.edgeCounts["build→review"], 4);
    assert.equal(state.edgeCounts["review→build"], 3);
    assert.equal(state.repairEdgeCounts["review→build"], 3);
  });

  test("goto ignores saturated manual-edge traffic but rejects a budget dead end", () => {
    const dir = join(TMPBASE, "semantic-goto-budget");
    const flowFile = join(dir, "semantic-goto.json");
    mkdirSync(join(dir, "nodes", "build", "run_1"), { recursive: true });
    mkdirSync(join(dir, "nodes", "review"), { recursive: true });
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["build", "review"],
      edges: {
        build: { PASS: "review" },
        review: { ITERATE: "build" },
      },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 8 },
      nodeTypes: { build: "build", review: "build" },
    }));
    const statePath = join(dir, "flow-state.json");
    writeFileSync(statePath, JSON.stringify({
      version: "1.0",
      flowTemplate: "semantic-goto",
      currentNode: "review",
      entryNode: "build",
      totalSteps: 2,
      maxTotalSteps: 10,
      maxLoopsPerEdge: 3,
      maxNodeReentry: 8,
      history: [{ nodeId: "review", runId: "run_1" }],
      edgeCounts: { "review→build": 3 },
      repairEdgeCounts: { "review→build": 3 },
      _flow_file: flowFile,
      _written_by: "opc-harness",
      _write_nonce: "semantic-goto-budget-test",
    }, null, 2));

    const allowed = runHarness("goto", ["build", "--dir", dir]);
    assert.equal(allowed.goto, "build", JSON.stringify(allowed));

    const afterGoto = readState(dir);
    afterGoto.currentNode = "build";
    afterGoto._write_nonce = "semantic-goto-budget-test-2";
    writeFileSync(statePath, JSON.stringify(afterGoto, null, 2));
    const blocked = runHarness("goto", ["review", "--dir", dir]);
    assert.match(blocked.error, /no budgeted exit/);
    assert.equal(readState(dir).currentNode, "build");
  });
});

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
  writeNodeHandshake(dir, "review", {
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
  });
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
