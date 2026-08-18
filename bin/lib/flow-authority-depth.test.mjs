import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TMPBASE = mkdtempSync(join(homedir(), ".opc", "sessions", "opc-authority-depth-"));
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
    currentNode: "gate",
    entryNode: "test-execute",
    totalSteps: 1,
    maxTotalSteps: 25,
    maxLoopsPerEdge: 3,
    maxNodeReentry: 5,
    history: [{ nodeId: "test-execute", runId: "run_1", timestamp: TS0 }],
    edgeCounts: {},
    repairEdgeCounts: {},
    _written_by: "opc-harness",
    _write_nonce: "authority-depth-test",
    _last_modified: TS0,
    ...state,
  }, null, 2));
}

function writeFlowFile(dir, name, flow) {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ opc_compat: ">=0.0", ...flow }, null, 2));
  return path;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function writeExactAndCanonical(dir, nodeId, runId, exact) {
  const runDir = join(dir, "nodes", nodeId, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "handshake.json"), JSON.stringify(exact, null, 2));
  const canonical = {
    ...exact,
    artifacts: exact.artifacts.map((artifact) => ({
      ...artifact,
      path: artifact.path.startsWith("../") ? artifact.path.slice(3) : `${runId}/${artifact.path}`,
    })),
  };
  writeFileSync(join(dir, "nodes", nodeId, "handshake.json"), JSON.stringify(canonical, null, 2));
}

function writeExactHandshake(dir, nodeId, runId, exact) {
  const runDir = join(dir, "nodes", nodeId, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "handshake.json"), JSON.stringify(exact, null, 2));
}

function passEval(name) {
  return [
    `# ${name}`,
    "",
    `${name} independently reviewed the artifact and found no blocker.`,
    `${name} checked authority metadata, artifact references, and verdict routing.`,
    "",
    "VERDICT: PASS FINDINGS[0]",
    "",
  ].join("\n");
}

function treeSnapshot(dir) {
  const out = {};
  function walk(rel) {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out[child] = readFileSync(join(dir, child), "utf8");
    }
  }
  walk("");
  return out;
}

describe("deep authority invariants", () => {
  test("validate-chain rejects test-result without deep OPC provenance", () => {
    const dir = join(TMPBASE, "chain-provenance");
    const runDir = join(dir, "nodes", "test-execute", "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "test-result.json"), JSON.stringify({
      checks: [{ id: "smoke", pass: true, total: 1 }],
      summary: { failed: [] },
    }, null, 2));
    writeState(dir);
    writeExactAndCanonical(dir, "test-execute", "run_1", {
      nodeId: "test-execute",
      nodeType: "execute",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "execute passed",
      timestamp: TS0,
      artifacts: [{ type: "test-result", path: "test-result.json" }],
    });

    const result = runHarness("validate-chain", ["--dir", dir]);

    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join("\n"), /testCommand provenance|signed provenance ledger/);
  });

  test("seal rejects current-run canonical that lacks exact-run corroboration", () => {
    const dir = join(TMPBASE, "seal-current-impersonation");
    const runDir = join(dir, "nodes", "test-execute", "run_1");
    mkdirSync(runDir, { recursive: true });
    const resultText = JSON.stringify({ checks: [{ id: "smoke", pass: true, total: 1 }] }, null, 2);
    writeFileSync(join(runDir, "test-command-result.json"), resultText);
    writeState(dir, { currentNode: "test-execute" });
    writeFileSync(join(dir, "nodes", "test-execute", "handshake.json"), JSON.stringify({
      nodeId: "test-execute",
      nodeType: "execute",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "forged current canonical",
      timestamp: TS0,
      artifacts: [{ type: "test-result", path: "run_1/test-command-result.json" }],
      testEvidenceProvenance: {
        kind: "opc-test-command",
        sourceNode: "test-design",
        sourceRunId: "run_1",
        commandHash: sha256("npm test"),
        sourcePlanHash: "plan",
        resultHash: sha256(resultText),
        executionActor: "opc-harness:test-command",
        ledger: { kind: "opc-hmac-ledger", recordHash: "forged" },
      },
      testEvidencePolicy: { allowVacuousChecks: [] },
    }, null, 2));

    const result = runHarness("seal", ["--node", "test-execute", "--dir", dir]);

    assert.equal(result.sealed, false, JSON.stringify(result));
    assert.match(result.validationErrors.join("\n"), /exact handshake missing|not exact-run projection/);
  });

  test("validate-chain rejects absolute artifact path authority aliases", () => {
    const dir = join(TMPBASE, "artifact-alias");
    mkdirSync(dir, { recursive: true });
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "outside artifact\n");
    writeState(dir, {
      currentNode: "build",
      entryNode: "build",
      history: [{ nodeId: "build", runId: "run_1", timestamp: TS0 }],
    });
    writeExactAndCanonical(dir, "build", "run_1", {
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "absolute path artifact",
      timestamp: TS0,
      artifacts: [{ type: "source", path: outside }],
    });

    const result = runHarness("validate-chain", ["--dir", dir]);

    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join("\n"), /must be relative|invalid/);
  });

  test("review sealed FAIL can structurally advance to gate", () => {
    const dir = join(TMPBASE, "review-fail-to-gate");
    writeState(dir, {
      flowTemplate: "review",
      currentNode: "review",
      entryNode: "review",
      history: [{ nodeId: "review", runId: "run_1", timestamp: TS0 }],
    });
    const runDir = join(dir, "nodes", "review", "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "eval-alpha.md"), passEval("alpha"));
    writeFileSync(join(runDir, "eval-beta.md"), passEval("beta"));
    writeExactAndCanonical(dir, "review", "run_1", {
      nodeId: "review",
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "FAIL",
      summary: "review found blockers",
      timestamp: TS0,
      artifacts: [
        { type: "eval", path: "eval-alpha.md" },
        { type: "eval", path: "eval-beta.md" },
      ],
    });

    const result = runHarness("transition", [
      "--from", "review", "--to", "gate", "--verdict", "PASS", "--flow", "review", "--dir", dir,
    ]);

    assert.equal(result.allowed, true, JSON.stringify(result));
    const state = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
    assert.equal(state.currentNode, "gate");
  });

  test("seal rejects malformed stale canonical without mutating fixture tree", () => {
    const dir = join(TMPBASE, "stale-malformed-canonical");
    const run2 = join(dir, "nodes", "build", "run_2");
    mkdirSync(run2, { recursive: true });
    writeFileSync(join(run2, "payload.md"), "new payload\n");
    writeState(dir, {
      currentNode: "build",
      entryNode: "build",
      history: [
        { nodeId: "build", runId: "run_1", timestamp: TS0 },
        { nodeId: "build", runId: "run_2", timestamp: "2026-01-01T00:01:00.000Z" },
      ],
    });
    writeExactHandshake(dir, "build", "run_1", {
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "prior exact run exists",
      timestamp: TS0,
      artifacts: [],
    });
    writeFileSync(join(dir, "nodes", "build", "handshake.json"), JSON.stringify({ runId: "run_1" }, null, 2));
    const before = treeSnapshot(dir);

    const result = runHarness("seal", ["--node", "build", "--dir", dir]);

    assert.equal(result.sealed, false, JSON.stringify(result));
    assert.doesNotMatch(result.validationErrors.join("\n"), /exact handshake missing/);
    assert.match(result.validationErrors.join("\n"), /canonical/);
    assert.deepEqual(treeSnapshot(dir), before);
  });

  test("seal rejects stale canonical projection conflict without mutating fixture tree", () => {
    const dir = join(TMPBASE, "stale-projection-conflict");
    const run1 = join(dir, "nodes", "build", "run_1");
    const run2 = join(dir, "nodes", "build", "run_2");
    mkdirSync(run1, { recursive: true });
    mkdirSync(run2, { recursive: true });
    writeFileSync(join(run1, "payload.md"), "prior exact payload\n");
    writeFileSync(join(run2, "payload.md"), "new payload\n");
    writeState(dir, {
      currentNode: "build",
      entryNode: "build",
      history: [
        { nodeId: "build", runId: "run_1", timestamp: TS0 },
        { nodeId: "build", runId: "run_2", timestamp: "2026-01-01T00:01:00.000Z" },
      ],
    });
    writeExactHandshake(dir, "build", "run_1", {
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "prior exact run",
      timestamp: TS0,
      artifacts: [{ type: "source", path: "payload.md" }],
    });
    writeFileSync(join(dir, "nodes", "build", "handshake.json"), JSON.stringify({
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "stale canonical lies about prior exact",
      timestamp: TS0,
      artifacts: [{ type: "source", path: "run_1/payload.md" }],
    }, null, 2));
    const before = treeSnapshot(dir);

    const result = runHarness("seal", ["--node", "build", "--dir", dir]);

    assert.equal(result.sealed, false, JSON.stringify(result));
    assert.match(result.validationErrors.join("\n"), /not exact-run projection/);
    assert.deepEqual(treeSnapshot(dir), before);
  });

  test("seal rejects orphan stale canonical even when orphan exact exists", () => {
    const dir = join(TMPBASE, "stale-orphan-canonical");
    const run1 = join(dir, "nodes", "build", "run_1");
    const run2 = join(dir, "nodes", "build", "run_2");
    mkdirSync(run1, { recursive: true });
    mkdirSync(run2, { recursive: true });
    writeFileSync(join(run1, "payload.md"), "orphan payload\n");
    writeFileSync(join(run2, "payload.md"), "new payload\n");
    writeState(dir, {
      currentNode: "build",
      entryNode: "build",
      history: [{ nodeId: "build", runId: "run_2", timestamp: TS0 }],
    });
    writeExactAndCanonical(dir, "build", "run_1", {
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "orphan stale run",
      timestamp: TS0,
      artifacts: [{ type: "source", path: "payload.md" }],
    });
    const before = treeSnapshot(dir);

    const result = runHarness("seal", ["--node", "build", "--dir", dir]);

    assert.equal(result.sealed, false, JSON.stringify(result));
    assert.match(result.validationErrors.join("\n"), /not recorded in authoritative history/);
    assert.deepEqual(treeSnapshot(dir), before);
  });

  test("validate-chain rejects dot-slash artifact aliases", () => {
    const dir = join(TMPBASE, "dot-slash-alias");
    const runDir = join(dir, "nodes", "build", "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "payload.md"), "exact payload\n");
    writeFileSync(join(dir, "nodes", "build", "payload.md"), "canonical payload\n");
    writeState(dir, {
      currentNode: "build",
      entryNode: "build",
      history: [{ nodeId: "build", runId: "run_1", timestamp: TS0 }],
    });
    writeExactAndCanonical(dir, "build", "run_1", {
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "dot alias",
      timestamp: TS0,
      artifacts: [{ type: "source", path: "./payload.md" }],
    });
    const before = treeSnapshot(dir);

    const result = runHarness("validate-chain", ["--dir", dir]);

    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join("\n"), /clean relative path|invalid/);
    assert.deepEqual(treeSnapshot(dir), before);
  });

  test("validate-chain rejects artifact paths pinned to the wrong run_N", () => {
    const dir = join(TMPBASE, "wrong-run-alias");
    const runDir = join(dir, "nodes", "build", "run_1", "run_2");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "payload.md"), "wrong nested payload\n");
    writeState(dir, {
      currentNode: "build",
      entryNode: "build",
      history: [{ nodeId: "build", runId: "run_1", timestamp: TS0 }],
    });
    writeExactAndCanonical(dir, "build", "run_1", {
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "wrong run path",
      timestamp: TS0,
      artifacts: [{ type: "source", path: "run_2/payload.md" }],
    });
    const before = treeSnapshot(dir);

    const result = runHarness("validate-chain", ["--dir", dir]);

    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join("\n"), /run_N-prefixed|must start with 'run_1\/'/);
    assert.deepEqual(treeSnapshot(dir), before);
  });

  test("validate-chain rejects traversal structured paths without stack trace", () => {
    const dir = join(TMPBASE, "structured-traversal");
    const runDir = join(dir, "nodes", "test-execute", "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "test-result.json"), JSON.stringify({ checks: [] }, null, 2));
    writeState(dir);
    writeExactAndCanonical(dir, "test-execute", "run_1", {
      nodeId: "test-execute",
      nodeType: "execute",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "bad structured path",
      timestamp: TS0,
      artifacts: [{ type: "test-result", path: "../test-result.json" }],
    });
    const before = treeSnapshot(dir);

    const result = runHarness("validate-chain", ["--dir", dir]);

    assert.equal(result.valid, false, JSON.stringify(result));
    assert.equal(result.stderr || "", "");
    assert.match(result.errors.join("\n"), /traversal|escapes run directory|invalid path/);
    assert.deepEqual(treeSnapshot(dir), before);
  });

  test("gate transition rejects absolute structured path without stack trace", () => {
    const dir = join(TMPBASE, "gate-absolute-structured");
    const runDir = join(dir, "nodes", "test-execute", "run_1");
    mkdirSync(runDir, { recursive: true });
    const absolute = join(runDir, "test-result.json");
    writeFileSync(absolute, JSON.stringify({ checks: [] }, null, 2));
    writeState(dir, {
      currentNode: "gate",
      entryNode: "test-execute",
      history: [
        { nodeId: "test-execute", runId: "run_1", timestamp: TS0 },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:01:00.000Z" },
      ],
    });
    writeExactAndCanonical(dir, "test-execute", "run_1", {
      nodeId: "test-execute",
      nodeType: "execute",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "absolute structured path",
      timestamp: TS0,
      artifacts: [{ type: "test-result", path: absolute }],
    });
    writeExactAndCanonical(dir, "gate", "run_1", {
      nodeId: "gate",
      nodeType: "gate",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "ready",
      timestamp: TS0,
      artifacts: [],
    });
    const before = treeSnapshot(dir);

    const result = runHarness("transition", [
      "--from", "gate", "--to", "null", "--verdict", "PASS", "--flow", "build-verify", "--dir", dir,
    ]);

    assert.notEqual(result.allowed, true, JSON.stringify(result));
    assert.notEqual(result.finalized, true, JSON.stringify(result));
    assert.equal(result.stderr || "", "");
    assert.match(JSON.stringify(result), /must be relative|fail-closed|invalid/);
    assert.deepEqual(treeSnapshot(dir), before);
  });

  test("validate-chain allows whitelisted node-level authority artifact", () => {
    const dir = join(TMPBASE, "node-level-control");
    const runDir = join(dir, "nodes", "build", "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(dir, "nodes", "build", "build-brief.md"), "brief\n");
    writeState(dir, {
      currentNode: "build",
      entryNode: "build",
      history: [{ nodeId: "build", runId: "run_1", timestamp: TS0 }],
    });
    writeExactAndCanonical(dir, "build", "run_1", {
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "node artifact",
      timestamp: TS0,
      artifacts: [{ type: "brief", path: "../build-brief.md" }],
    });

    const result = runHarness("validate-chain", ["--dir", dir]);

    assert.equal(result.valid, true, JSON.stringify(result));
  });
});
