import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TMPBASE = mkdtempSync(join(homedir(), ".opc", "sessions", "opc-projection-"));
const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "..", "opc-harness.mjs");
const TS0 = "2026-01-01T00:00:00.000Z";

after(() => rmSync(TMPBASE, { recursive: true, force: true }));

function runHarness(command, args) {
  try {
    const out = execFileSync("node", [HARNESS, command, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(out.trim().split("\n").pop());
  } catch (error) {
    const out = String(error.stdout || "").trim();
    if (out) return JSON.parse(out.split("\n").pop());
    return { error: error.message, stderr: String(error.stderr || "") };
  }
}

function writeState(dir, state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
    version: "1.0",
    flowTemplate: "build-verify",
    currentNode: "build",
    entryNode: "build",
    totalSteps: 1,
    maxTotalSteps: 25,
    maxLoopsPerEdge: 3,
    maxNodeReentry: 5,
    history: [{ nodeId: "build", runId: "run_1", timestamp: TS0 }],
    edgeCounts: {},
    repairEdgeCounts: {},
    _written_by: "opc-harness",
    _write_nonce: "projection-test",
    _last_modified: TS0,
    ...state,
  }, null, 2));
}

function writeFlowFile(dir, name, flow) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ opc_compat: ">=0.0", ...flow }, null, 2));
  return path;
}

function passEval(name) {
  return [
    `# ${name}`,
    "",
    "Reviewed the selected exact run and found no blocking issues.",
    "The evidence is internally consistent for this regression case.",
    "",
    "VERDICT: PASS FINDINGS[0]",
  ].join("\n");
}

function writeBuildRun(dir) {
  const runDir = join(dir, "nodes", "build", "run_1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "output.md"), "built\n");
  const exact = {
    nodeId: "build",
    nodeType: "build",
    runId: "run_1",
    status: "completed",
    verdict: "PASS",
    summary: "built",
    timestamp: TS0,
    artifacts: [{ type: "source", path: "output.md" }],
  };
  writeFileSync(join(runDir, "handshake.json"), JSON.stringify(exact, null, 2));
  writeFileSync(join(dir, "nodes", "build", "handshake.json"), JSON.stringify({
    ...exact,
    artifacts: [{ type: "source", path: "run_1/output.md" }],
  }, null, 2));
}

function writeReviewRun(dir, canonicalVerdict = "PASS") {
  const runDir = join(dir, "nodes", "review", "run_1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "eval-a.md"), passEval("Review A"));
  writeFileSync(join(runDir, "eval-b.md"), passEval("Review B"));
  const exact = {
    nodeId: "review",
    nodeType: "review",
    runId: "run_1",
    status: "completed",
    verdict: "PASS",
    summary: "review passed",
    timestamp: TS0,
    artifacts: [
      { type: "eval", path: "eval-a.md" },
      { type: "eval", path: "eval-b.md" },
    ],
  };
  writeFileSync(join(runDir, "handshake.json"), JSON.stringify(exact, null, 2));
  writeFileSync(join(dir, "nodes", "review", "handshake.json"), JSON.stringify({
    ...exact,
    verdict: canonicalVerdict,
    artifacts: exact.artifacts.map((a) => ({ ...a, path: `run_1/${a.path}` })),
  }, null, 2));
}

describe("canonical projection authority", () => {
  test("validate-chain rejects canonical fields that differ from exact run", () => {
    const dir = join(TMPBASE, "validate-chain");
    writeState(dir);
    writeBuildRun(dir);
    const path = join(dir, "nodes", "build", "handshake.json");
    const canonical = JSON.parse(readFileSync(path, "utf8"));
    canonical.verdict = "FAIL";
    writeFileSync(path, JSON.stringify(canonical, null, 2));

    const result = runHarness("validate-chain", ["--dir", dir]);

    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join("\n"), /not exact-run projection/);
    assert.match(result.errors.join("\n"), /\$\.verdict/);
  });

  test("gate transition rejects upstream canonical projection mismatch", () => {
    const dir = join(TMPBASE, "gate-transition");
    const flowFile = writeFlowFile(dir, "projection-flow", {
      nodes: ["review", "gate", "done"],
      edges: { review: { PASS: "gate" }, gate: { PASS: "done" }, done: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", gate: "gate", done: "build" },
    });
    writeState(dir, {
      flowTemplate: "projection-flow",
      _flow_file: flowFile,
      currentNode: "gate",
      entryNode: "review",
      history: [
        { nodeId: "review", runId: "run_1", timestamp: TS0 },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
      edgeCounts: { "review->gate": 1 },
    });
    writeReviewRun(dir, "FAIL");

    const result = runHarness("transition", [
      "--from", "gate", "--to", "done", "--verdict", "PASS", "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /gate authority check failed/);
    assert.match(result.reason, /not exact-run projection/);
  });

  test("seal selected loopback run replaces stale canonical", () => {
    const dir = join(TMPBASE, "seal-loopback");
    writeState(dir, {
      flowTemplate: "review",
      currentNode: "review",
      entryNode: "review",
      totalSteps: 2,
      history: [
        { nodeId: "review", runId: "run_1", timestamp: TS0 },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
        { nodeId: "review", runId: "run_2", timestamp: "2026-01-01T00:00:02.000Z" },
      ],
    });
    writeReviewRun(dir);
    const run2 = join(dir, "nodes", "review", "run_2");
    mkdirSync(run2, { recursive: true });
    writeFileSync(join(run2, "eval-a.md"), passEval("Review A"));
    writeFileSync(join(run2, "eval-b.md"), passEval("Review B"));

    const result = runHarness("seal", ["--node", "review", "--dir", dir]);

    assert.equal(result.sealed, true, JSON.stringify(result));
    const canonical = JSON.parse(readFileSync(join(dir, "nodes", "review", "handshake.json"), "utf8"));
    const exact = JSON.parse(readFileSync(join(run2, "handshake.json"), "utf8"));
    assert.equal(canonical.runId, "run_2");
    assert.equal(exact.runId, "run_2");
    assert.ok(canonical.artifacts.every((a) => a.path.startsWith("run_2/")));
    assert.ok(exact.artifacts.every((a) => !a.path.startsWith("run_2/")));
  });

  test("strict finalize rejects exact terminal run missing evidence policy", () => {
    const dir = join(TMPBASE, "finalize-exact");
    const flowFile = writeFlowFile(dir, "terminal-execute-flow", {
      nodes: ["test-execute"],
      edges: { "test-execute": { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { "test-execute": "execute" },
    });
    writeState(dir, {
      flowTemplate: "terminal-execute-flow",
      _flow_file: flowFile,
      currentNode: "test-execute",
      entryNode: "test-execute",
      history: [{ nodeId: "test-execute", runId: "run_1", timestamp: TS0 }],
    });
    const runDir = join(dir, "nodes", "test-execute", "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "test-command-result.json"), JSON.stringify({
      summary: { failed: [] },
      checks: [{ id: "smoke", pass: true, total: 1 }],
    }, null, 2));
    const base = {
      nodeId: "test-execute",
      nodeType: "execute",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "terminal execute",
      timestamp: TS0,
      artifacts: [{ type: "test-result", path: "test-command-result.json" }],
      testEvidenceProvenance: {
        kind: "opc-test-command",
        executionActor: "opc-harness:test-command",
        sourceNode: "test-design",
        sourceRunId: "run_1",
        commandHash: "cmd",
        sourcePlanHash: "plan",
        resultHash: "result",
        ledger: { kind: "opc-hmac-ledger", recordHash: "record" },
      },
    };
    writeFileSync(join(runDir, "handshake.json"), JSON.stringify({ ...base, testEvidencePolicy: null }, null, 2));
    writeFileSync(join(dir, "nodes", "test-execute", "handshake.json"), JSON.stringify({
      ...base,
      artifacts: [{ type: "test-result", path: "run_1/test-command-result.json" }],
      testEvidencePolicy: { allowVacuousChecks: [] },
    }, null, 2));

    const result = runHarness("finalize", ["--strict", "--dir", dir]);

    assert.equal(result.finalized, false, JSON.stringify(result));
    assert.match(result.error, /testEvidencePolicy must be a non-null object|not exact-run projection/);
    const state = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
    assert.notEqual(state.status, "completed");
  });
});
