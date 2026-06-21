// flow-transition.test.mjs — Step 1.5 structured result check

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { checkStructuredResults } from "./flow-transition.mjs";

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
    const dir = setupDir("t8f-command-provenance", {
      "test-design": {
        artifacts: [],
        testCommand: command,
      },
      "test-execute": {
        testEvidenceProvenance: { kind: "opc-test-command", sourceNode: "test-design", commandHash },
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: {
            provenance: { kind: "opc-test-command", commandHash },
            checks: [{ id: "OUT-browser-render", pass: true, detail: { total: 1 } }],
          },
        }],
      },
    });
    const reasons = checkStructuredResults(dir, makeExecState(), EXEC_TEMPLATE, "gate");
    assert.equal(reasons.some(r => r.includes("testCommand provenance")), false);
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
    const dir = setupDir("t8h-mismatched-command-hash", {
      "test-design": {
        artifacts: [],
        testCommand: command,
      },
      "test-execute": {
        testEvidenceProvenance: { kind: "opc-test-command", sourceNode: "test-design", commandHash: "wrong" },
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: {
            provenance: { kind: "opc-test-command", commandHash: "wrong" },
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
    const dir = setupDir("t8i-test-design-vacuous-policy", {
      "test-design": {
        artifacts: [],
        testCommand: command,
        allowVacuousChecks: ["OUT-empty-state"],
      },
      "test-execute": {
        testEvidenceProvenance: { kind: "opc-test-command", sourceNode: "test-design", commandHash },
        artifacts: [{
          type: "test-result",
          path: "run_1/test-results.json",
          _content: {
            provenance: { kind: "opc-test-command", commandHash },
            checks: [{ id: "OUT-empty-state", pass: true, detail: { total: 0 } }],
          },
        }],
      },
    });
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
function createSession(name, { artifacts = [], failingReport = false, diVerdict = null } = {}) {
  const dir = join(TMPBASE, name);
  mkdirSync(join(dir, "nodes", "build", "run_1"), { recursive: true });
  mkdirSync(join(dir, "nodes", "code-review", "run_1"), { recursive: true });
  mkdirSync(join(dir, "nodes", "test-design", "run_1"), { recursive: true });
  mkdirSync(join(dir, "nodes", "test-execute", "run_1"), { recursive: true });
  mkdirSync(join(dir, "nodes", "gate"), { recursive: true });

  // Write eval files so synthesize produces a verdict
  writeFileSync(join(dir, "nodes", "test-execute", "run_1", "eval-engineer.md"),
    "# Engineer Review\n**Verdict: ✅ APPROVE**\nNo issues.\n");

  // Write handshakes for upstream nodes
  for (const nodeId of ["build", "code-review", "test-design", "test-execute"]) {
    const hs = {
      nodeId, nodeType: TEMPLATE.nodeTypes[nodeId] || "build", runId: "run_1",
      status: "completed", summary: "done", timestamp: new Date().toISOString(),
      artifacts: nodeId === "build" ? artifacts : [],
      verdict: null,
    };
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
