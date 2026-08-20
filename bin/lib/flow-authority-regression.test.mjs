import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { resolveNodeExtensionContext } from "./ext-commands.mjs";
import { checkStructuredResults } from "./flow-transition.mjs";
import { buildCumulativeFindingsMarkdown } from "./cumulative-findings.mjs";

const TMPBASE = mkdtempSync(join(homedir(), ".opc", "sessions", "opc-authority-"));
const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "..", "opc-harness.mjs");

after(() => rmSync(TMPBASE, { recursive: true, force: true }));

function runHarness(command, args, options = {}) {
  try {
    const output = execFileSync("node", [HARNESS, command, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(options.env || {}) },
    });
    return JSON.parse(output.trim().split("\n").pop());
  } catch (error) {
    const output = String(error.stdout || "").trim();
    if (output) return JSON.parse(output.split("\n").pop());
    return { error: error.message, stderr: String(error.stderr || "") };
  }
}

function runHarnessRaw(command, args, options = {}) {
  try {
    return {
      status: 0,
      stdout: execFileSync("node", [HARNESS, command, ...args], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(options.env || {}) },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      status: error.status || 1,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
    };
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
    history: [{ nodeId: "build", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" }],
    edgeCounts: {},
    repairEdgeCounts: {},
    _written_by: "opc-harness",
    _write_nonce: "authority-test",
    _last_modified: "2026-01-01T00:00:00.000Z",
    ...state,
  }, null, 2));
}

function writeBuildHandshake(dir, runId = "run_1") {
  mkdirSync(join(dir, "nodes", "build", runId), { recursive: true });
  writeFileSync(join(dir, "nodes", "build", runId, "output.md"), "built");
  const handshake = {
    nodeId: "build",
    nodeType: "build",
    runId,
    status: "completed",
    verdict: null,
    summary: "built",
    timestamp: "2026-01-01T00:00:00.000Z",
    artifacts: [{ type: "source", path: `${runId}/output.md` }],
  };
  writeFileSync(join(dir, "nodes", "build", runId, "handshake.json"), JSON.stringify({
    ...handshake,
    artifacts: [{ type: "source", path: "output.md" }],
  }, null, 2));
  writeFileSync(join(dir, "nodes", "build", "handshake.json"), JSON.stringify(handshake, null, 2));
}

function writeReviewRun(dir, nodeId, runId, options = {}) {
  const runDir = join(dir, "nodes", nodeId, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "eval-a.md"), "# Review A\n\nNo blocking findings.\n");
  writeFileSync(join(runDir, "eval-b.md"), "# Review B\n\nIndependent approval.\n");
  const handshake = {
    nodeId,
    nodeType: "review",
    runId,
    status: "completed",
    verdict: "PASS",
    summary: "review passed",
    timestamp: "2026-01-01T00:00:00.000Z",
    artifacts: [
      { type: "eval", path: "eval-a.md" },
      { type: "eval", path: "eval-b.md" },
    ],
    ...options,
  };
  writeFileSync(join(runDir, "handshake.json"), JSON.stringify(handshake, null, 2));
  return handshake;
}

function writeTerminalHandshake(dir, nodeId, runId, nodeType = "build") {
  mkdirSync(join(dir, "nodes", nodeId, runId), { recursive: true });
  const handshake = {
    nodeId,
    nodeType,
    runId,
    status: "completed",
    verdict: "PASS",
    summary: "terminal node passed",
    timestamp: "2026-01-01T00:00:00.000Z",
    artifacts: [],
  };
  writeFileSync(join(dir, "nodes", nodeId, runId, "handshake.json"), JSON.stringify(handshake, null, 2));
  writeFileSync(join(dir, "nodes", nodeId, "handshake.json"), JSON.stringify(handshake, null, 2));
}

function writeFlowFile(dir, name, flow) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ opc_compat: ">=0.0", ...flow }, null, 2));
  return path;
}

function completeTestPlan() {
  return [
    "# Test Plan",
    "",
    "Covers unit smoke checks with npm test.",
    "Covers contract schema validation and edge case behavior.",
    "Covers integration workflow and e2e flow behavior.",
    "Covers UI visual screenshot responsive a11y and playwright checks.",
    "Covers tier baseline polish, dark mode, navigation, and favicon checks.",
    "",
    "Run:",
    "npm test",
    "",
  ].join("\n");
}

describe("flow authority regressions", () => {
  test("missing tier is treated as unknown/non-visual", () => {
    const dir = join(TMPBASE, "missing-tier");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "acceptance-criteria.md"), "# Backend task\n");
    const flowFile = join(dir, "flow.json");
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["build"],
      edges: { build: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { build: "build" },
      nodeCapabilities: { build: ["design-intelligence@1"] },
    }));
    writeState(dir, {
      flowTemplate: "flow",
      _flow_file: flowFile,
      tier: undefined,
      totalSteps: 0,
      history: [],
    });

    const context = resolveNodeExtensionContext(dir, "build", ["--dir", dir]);

    assert.equal(context.tier, null);
    assert.equal(context.visualEvaluationRequired, false);
    assert.equal(context.nodeCapabilitiesResolved, true);
  });

  test("seal uses the state-selected run, not filesystem latest", () => {
    const dir = join(TMPBASE, "seal-selected-run");
    writeState(dir);
    writeBuildHandshake(dir, "run_1");
    mkdirSync(join(dir, "nodes", "build", "run_2"), { recursive: true });
    writeFileSync(join(dir, "nodes", "build", "run_2", "rogue.md"), "rogue");

    const sealed = runHarness("seal", ["--node", "build", "--dir", dir]);

    assert.equal(sealed.sealed, true, JSON.stringify(sealed));
    const handshake = JSON.parse(readFileSync(join(dir, "nodes", "build", "handshake.json"), "utf8"));
    assert.equal(handshake.runId, "run_1");
    assert.ok(!handshake.artifacts.some((artifact) => artifact.path.includes("run_2")));

    const rogue = runHarness("seal", ["--node", "build", "--run", "2", "--dir", dir]);
    assert.equal(rogue.sealed, false, JSON.stringify(rogue));
    assert.match(rogue.error, /does not match selected run/);
  });

  test("seal validation failure leaves canonical handshake unchanged", () => {
    const dir = join(TMPBASE, "seal-no-mutation");
    writeState(dir);
    mkdirSync(join(dir, "nodes", "build", "run_1"), { recursive: true });
    writeFileSync(join(dir, "nodes", "build", "run_1", "broken.json"), "{broken");
    writeBuildHandshake(dir, "run_1");
    const handshakePath = join(dir, "nodes", "build", "handshake.json");
    const before = readFileSync(handshakePath, "utf8");

    const sealed = runHarness("seal", ["--node", "build", "--dir", dir]);

    assert.equal(sealed.sealed, false, JSON.stringify(sealed));
    assert.match(sealed.validationErrors.join("\n"), /broken\.json/);
    assert.equal(readFileSync(handshakePath, "utf8"), before);
  });

  test("seal refuses to overwrite malformed canonical handshake", () => {
    const dir = join(TMPBASE, "seal-malformed-canonical");
    writeState(dir);
    mkdirSync(join(dir, "nodes", "build", "run_1"), { recursive: true });
    writeFileSync(join(dir, "nodes", "build", "run_1", "output.md"), "built");
    writeFileSync(join(dir, "nodes", "build", "run_1", "handshake.json"), JSON.stringify({
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: null,
      summary: "selected run",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [{ type: "source", path: "output.md" }],
    }, null, 2));
    const handshakePath = join(dir, "nodes", "build", "handshake.json");
    writeFileSync(handshakePath, "{broken");

    const sealed = runHarness("seal", ["--node", "build", "--dir", dir]);

    assert.equal(sealed.sealed, false, JSON.stringify(sealed));
    assert.match(sealed.validationErrors.join("\n"), /canonical handshake\.json parse error/);
    assert.equal(readFileSync(handshakePath, "utf8"), "{broken");
  });

  test("stopped flows reject mutating commands", () => {
    const dir = join(TMPBASE, "stopped");
    writeState(dir, { status: "stopped" });
    writeBuildHandshake(dir, "run_1");

    assert.match(runHarness("skip", ["--dir", dir]).error, /flow is stopped/);
    assert.match(runHarness("goto", ["code-review", "--dir", dir]).error, /flow is stopped/);
    assert.match(runHarness("seal", ["--node", "build", "--dir", dir]).error, /flow is stopped/);
    assert.match(
      runHarness("transition", [
        "--from", "build", "--to", "code-review", "--verdict", "PASS", "--dir", dir,
      ]).reason,
      /flow is stopped/,
    );
  });

  test("stopped flows reject extension lifecycle writes and stop is idempotent", () => {
    const dir = join(TMPBASE, "stopped-extensions");
    writeState(dir, { status: "stopped", stoppedAt: "2026-01-01T00:00:00.000Z" });
    writeBuildHandshake(dir, "run_1");
    const statePath = join(dir, "flow-state.json");
    const before = readFileSync(statePath, "utf8");

    assert.match(runHarness("prompt-context", ["--node", "build", "--role", "tester", "--dir", dir]).stderr, /flow is stopped/);
    assert.match(runHarness("extension-verdict", ["--node", "build", "--dir", dir]).stderr, /flow is stopped/);
    assert.match(runHarness("extension-artifact", ["--node", "build", "--dir", dir]).stderr, /flow is stopped/);
    assert.match(runHarness("node-preflight", ["--node", "build", "--dir", dir]).stderr, /flow is stopped/);

    const stoppedAgain = runHarness("stop", ["--dir", dir]);
    assert.equal(stoppedAgain.alreadyStopped, true, JSON.stringify(stoppedAgain));
    assert.equal(readFileSync(statePath, "utf8"), before);
  });

  test("stopped extension commands do not load extension top-level or startup code", () => {
    const dir = join(TMPBASE, "stopped-extension-load");
    const extDir = join(dir, "exts");
    const markerDir = join(dir, "markers");
    const ext = join(extDir, "marker-ext");
    writeState(dir, { status: "stopped", stoppedAt: "2026-01-01T00:00:00.000Z" });
    writeBuildHandshake(dir, "run_1");
    mkdirSync(ext, { recursive: true });
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(ext, "hook.mjs"), `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      if (process.env.OPC_MARKER_DIR) writeFileSync(join(process.env.OPC_MARKER_DIR, "top-level"), "loaded");
      export default {
        meta: { name: "marker-ext", provides: ["design-system-injection@1"] },
        startup: {
          check() {
            writeFileSync(join(process.env.OPC_MARKER_DIR, "startup"), "checked");
            return { ok: true };
          }
        },
        hooks: { "prompt.append": () => "marker" }
      };
    `);

    const result = runHarness("prompt-context", ["--node", "build", "--role", "tester", "--dir", dir], {
      env: { OPC_EXTENSIONS_DIR: extDir, OPC_MARKER_DIR: markerDir },
    });

    assert.match(result.stderr, /flow is stopped/);
    assert.equal(existsSync(join(markerDir, "top-level")), false);
    assert.equal(existsSync(join(markerDir, "startup")), false);
  });

  test("seal explicit empty --run fails before rewriting canonical bytes", () => {
    const dir = join(TMPBASE, "seal-empty-run");
    writeState(dir);
    writeBuildHandshake(dir, "run_1");
    const handshakePath = join(dir, "nodes", "build", "handshake.json");
    const before = readFileSync(handshakePath, "utf8");

    const eqEmpty = runHarness("seal", ["--node", "build", "--run=", "--dir", dir]);
    const trailing = runHarness("seal", ["--node", "build", "--dir", dir, "--run"]);

    assert.equal(eqEmpty.sealed, false, JSON.stringify(eqEmpty));
    assert.match(eqEmpty.error, /--run must be a positive numeric ordinal/);
    assert.equal(trailing.sealed, false, JSON.stringify(trailing));
    assert.match(trailing.error, /--run must be a positive numeric ordinal/);
    assert.equal(readFileSync(handshakePath, "utf8"), before);
  });

  test("seal rejects parsed but invalid canonical handshake roots without rewriting", () => {
    for (const [name, content, pattern] of [
      ["null", "null\n", /root must be a non-null object/],
      ["array", "[]\n", /root must be a non-null object/],
      ["scalar", "\"x\"\n", /root must be a non-null object/],
      ["empty-object", "{}\n", /nodeId.*expected 'build'/],
      ["partial-object", JSON.stringify({ nodeId: "build", runId: "run_1", status: "completed", artifacts: [] }), /missing or empty required field: nodeType|missing or empty required field: summary|missing or empty required field: timestamp/],
      ["wrong-run", JSON.stringify({ nodeId: "build", nodeType: "build", runId: "run_2", status: "completed", artifacts: [] }), /runId.*expected 'run_1'/],
    ]) {
      const dir = join(TMPBASE, `seal-invalid-canonical-${name}`);
      writeState(dir);
      mkdirSync(join(dir, "nodes", "build", "run_1"), { recursive: true });
      writeFileSync(join(dir, "nodes", "build", "run_1", "output.md"), "built");
      const handshakePath = join(dir, "nodes", "build", "handshake.json");
      writeFileSync(handshakePath, content);
      const result = runHarness("seal", ["--node", "build", "--dir", dir]);
      assert.equal(result.sealed, false, `${name}: ${JSON.stringify(result)}`);
      assert.match(result.validationErrors.join("\n"), pattern, name);
      assert.equal(readFileSync(handshakePath, "utf8"), content, name);
    }
  });

  test("state-backed commands reject explicit flow identity mismatch", () => {
    const dir = join(TMPBASE, "flow-identity");
    writeState(dir);
    writeBuildHandshake(dir, "run_1");

    const skip = runHarness("skip", ["--flow", "quick", "--dir", dir]);
    assert.match(skip.error, /persisted flow identity.*build-verify.*quick/);

    const chain = runHarness("validate-chain", ["--flow", "quick", "--dir", dir]);
    assert.equal(chain.valid, false, JSON.stringify(chain));
    assert.match(chain.errors.join("\n"), /persisted flow identity.*build-verify.*quick/);
  });

  test("viz refuses explicit graph substitution when state has persisted flow identity", () => {
    const dir = join(TMPBASE, "viz-flow-identity");
    writeState(dir);

    const result = runHarnessRaw("viz", ["--flow", "quick", "--dir", dir]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /persisted flow identity.*build-verify.*quick/);
  });

  test("validate and validate-chain reject canonical handshake run mismatch", () => {
    const dir = join(TMPBASE, "validate-run-mismatch");
    writeState(dir);
    mkdirSync(join(dir, "nodes", "build", "run_1"), { recursive: true });
    writeFileSync(join(dir, "nodes", "build", "run_1", "output.md"), "built");
    writeFileSync(join(dir, "nodes", "build", "run_1", "handshake.json"), JSON.stringify({
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: null,
      summary: "selected run",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [{ type: "source", path: "output.md" }],
    }, null, 2));
    writeFileSync(join(dir, "nodes", "build", "handshake.json"), JSON.stringify({
      nodeId: "build",
      nodeType: "build",
      runId: "run_2",
      status: "completed",
      verdict: null,
      summary: "wrong run",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [{ type: "source", path: "run_1/output.md" }],
    }, null, 2));

    const positional = runHarness("validate", [join(dir, "nodes", "build", "handshake.json")]);
    const defaultValidate = runHarness("validate", ["--dir", dir]);
    const chain = runHarness("validate-chain", ["--dir", dir]);

    assert.equal(positional.valid, false, JSON.stringify(positional));
    assert.match(positional.errors.join("\n"), /runId.*expected 'run_1'/);
    assert.equal(defaultValidate.valid, false, JSON.stringify(defaultValidate));
    assert.match(defaultValidate.errors.join("\n"), /runId.*expected 'run_1'/);
    assert.equal(chain.valid, false, JSON.stringify(chain));
    assert.match(chain.errors.join("\n"), /runId.*expected 'run_1'/);
  });

  test("positional run-scoped validate cannot self-authorize a non-selected run", () => {
    const dir = join(TMPBASE, "validate-positional-run-scope");
    writeState(dir);
    const run2 = join(dir, "nodes", "build", "run_2");
    mkdirSync(run2, { recursive: true });
    writeFileSync(join(run2, "handshake.json"), JSON.stringify({
      nodeId: "build",
      nodeType: "build",
      runId: "run_2",
      status: "completed",
      verdict: null,
      summary: "valid but not selected",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [],
    }, null, 2));

    const result = runHarness("validate", [join(run2, "handshake.json")]);

    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join("\n"), /path run is 'run_2', expected 'run_1'/);
  });

  test("pass synthesizes authoritative upstream run instead of rogue latest run", () => {
    const dir = join(TMPBASE, "pass-exact-upstream");
    const flowFile = join(dir, "authority-pass-flow.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(flowFile, JSON.stringify({
      opc_compat: ">=0.0",
      nodes: ["review", "gate", "done"],
      edges: { review: { PASS: "gate" }, gate: { PASS: "done" }, done: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", gate: "gate", done: "build" },
    }));
    writeState(dir, {
      flowTemplate: "authority-pass-flow",
      _flow_file: flowFile,
      currentNode: "gate",
      entryNode: "review",
      history: [
        { nodeId: "review", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
      edgeCounts: { "review→gate": 1 },
    });
    const run1 = join(dir, "nodes", "review", "run_1");
    const run2 = join(dir, "nodes", "review", "run_2");
    mkdirSync(run1, { recursive: true });
    mkdirSync(run2, { recursive: true });
    const passEval = (title, noun) => [
      `# ${title}`,
      "",
      "## Evidence Scope",
      ...Array.from({ length: 24 }, (_, i) => `${noun} scope check ${i + 1}: reviewed selected run_1 evidence for the force-pass guard.`),
      "",
      "## Authority Notes",
      ...Array.from({ length: 24 }, (_, i) => `${noun} authority note ${i + 1}: rogue run_2 content is intentionally outside the accepted source run.`),
      "",
      "## Verdict",
      ...Array.from({ length: 8 }, (_, i) => `${noun} closing note ${i + 1}: no blocking issue found in authoritative run_1.`),
      "VERDICT: PASS FINDINGS[0]",
    ].join("\n");
    writeFileSync(join(run1, "eval-skeptic-owner.md"), passEval("Skeptic Owner", "ownership"));
    writeFileSync(join(run1, "eval-peer.md"), passEval("Peer", "peer"));
    writeFileSync(join(run2, "eval-a.md"), "# A\n\n🔴 Bug — file.js:1 — rogue\n→ fix\nReasoning: rogue\nVERDICT: FAIL FINDINGS[1]\n");
    const reviewHandshake = {
      nodeId: "review",
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "authoritative run",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [
        { type: "eval", path: "run_1/eval-skeptic-owner.md" },
        { type: "eval", path: "run_1/eval-peer.md" },
      ],
    };
    writeFileSync(join(run1, "handshake.json"), JSON.stringify({
      ...reviewHandshake,
      artifacts: [
        { type: "eval", path: "eval-skeptic-owner.md" },
        { type: "eval", path: "eval-peer.md" },
      ],
    }, null, 2));
    writeFileSync(join(dir, "nodes", "review", "handshake.json"), JSON.stringify(reviewHandshake, null, 2));
    mkdirSync(join(dir, "nodes", "gate"), { recursive: true });
    writeFileSync(join(dir, "nodes", "gate", "handshake.json"), JSON.stringify({
      nodeId: "gate",
      nodeType: "gate",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "gate",
      timestamp: "2026-01-01T00:00:01.000Z",
      artifacts: [],
    }, null, 2));

    const result = runHarness("pass", ["--dir", dir]);

    assert.equal(result.allowed, true, JSON.stringify(result));
    const state = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
    assert.equal(state.currentNode, "done");
  });

  test("historical evidence fallback is bound to the history runId", () => {
    const dir = join(TMPBASE, "history-run-authority");
    const rogueRun = join(dir, "nodes", "review", "run_2");
    mkdirSync(rogueRun, { recursive: true });
    writeFileSync(join(rogueRun, "handshake.json"), JSON.stringify({
      nodeId: "review",
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "forged latest run",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [],
    }));
    const state = {
      history: [
        { nodeId: "review", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
    };
    const template = {
      nodeTypes: { review: "review", gate: "gate" },
      requiredTestCommandEvidence: false,
    };

    const reasons = checkStructuredResults(dir, state, template, "gate");

    assert.ok(reasons.some((reason) => /missing handshake for node 'review' run 'run_1'/.test(reason)), reasons.join("\n"));
  });

  test("validate-chain binds required extension provenance to the history run", () => {
    const dir = join(TMPBASE, "validate-chain-extension-history-run");
    const flowFile = writeFlowFile(dir, "authority-extension-flow", {
      nodes: ["code-review", "gate"],
      edges: { "code-review": { PASS: "gate" }, gate: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { "code-review": "review", gate: "gate" },
      nodeCapabilities: { "code-review": ["code-quality-check@1"] },
    });
    mkdirSync(join(dir, ".opc"), { recursive: true });
    writeFileSync(join(dir, ".opc", "config.json"), JSON.stringify({ requiredExtensions: ["req-ext"] }));
    writeState(dir, {
      flowTemplate: "authority-extension-flow",
      _flow_file: flowFile,
      currentNode: "gate",
      entryNode: "code-review",
      history: [
        { nodeId: "code-review", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
      edgeCounts: { "code-review→gate": 1 },
    });
    writeReviewRun(dir, "code-review", "run_1", { extensionsApplied: ["req-ext"] });
    const rogueRun = join(dir, "nodes", "code-review", "run_2");
    mkdirSync(rogueRun, { recursive: true });
    writeFileSync(join(rogueRun, "eval-extensions.json"), JSON.stringify({
      version: 1,
      extensionsApplied: ["req-ext"],
      findings: [],
    }, null, 2));

    const result = runHarness("validate-chain", ["--dir", dir]);

    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join("\n"), /eval-extensions\.json not found in run_1/);
  });

  test("strict finalize validates history exact runs instead of node-level canonical latest", () => {
    const dir = join(TMPBASE, "strict-finalize-history-run");
    const flowFile = writeFlowFile(dir, "strict-finalize-flow", {
      nodes: ["review", "done"],
      edges: { review: { PASS: "done" }, done: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", done: "build" },
    });
    writeState(dir, {
      flowTemplate: "strict-finalize-flow",
      _flow_file: flowFile,
      currentNode: "done",
      entryNode: "review",
      history: [
        { nodeId: "review", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "done", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
      edgeCounts: { "review→done": 1 },
    });
    const canonicalReview = {
      nodeId: "review",
      nodeType: "review",
      runId: "run_2",
      status: "completed",
      verdict: "PASS",
      summary: "wrong canonical run",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [],
    };
    mkdirSync(join(dir, "nodes", "review"), { recursive: true });
    writeFileSync(join(dir, "nodes", "review", "handshake.json"), JSON.stringify(canonicalReview, null, 2));
    writeTerminalHandshake(dir, "done", "run_1");
    const stateBefore = readFileSync(join(dir, "flow-state.json"), "utf8");

    const result = runHarness("finalize", ["--strict", "--dir", dir]);

    assert.equal(result.finalized, false, JSON.stringify(result));
    assert.match(result.error, /missing handshake.*run_1|expected 'run_1'/);
    assert.equal(readFileSync(join(dir, "flow-state.json"), "utf8"), stateBefore);
  });

  test("structured evidence rejects canonical handshake runId mismatch", () => {
    const dir = join(TMPBASE, "canonical-run-mismatch");
    const nodeDir = join(dir, "nodes", "test-execute");
    mkdirSync(join(nodeDir, "run_1"), { recursive: true });
    writeFileSync(join(nodeDir, "run_1", "result.json"), "{}");
    writeFileSync(join(nodeDir, "run_1", "handshake.json"), JSON.stringify({
      nodeId: "test-execute",
      nodeType: "execute",
      runId: "run_2",
      status: "completed",
      verdict: "PASS",
      summary: "newer run",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [{ type: "test-result", path: "result.json" }],
    }));
    const state = {
      history: [
        { nodeId: "test-execute", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
    };
    const template = {
      nodeTypes: { "test-execute": "execute", gate: "gate" },
      requiredTestCommandEvidence: false,
    };

    const reasons = checkStructuredResults(dir, state, template, "gate");

    assert.ok(reasons.some((reason) => /expected 'run_1'/.test(reason)), reasons.join("\n"));
  });

  test("test-design plan gate uses the state-selected run, not filesystem latest", () => {
    const dir = join(TMPBASE, "test-plan-selected-run");
    writeState(dir, {
      currentNode: "test-design",
      entryNode: "test-design",
      history: [{ nodeId: "test-design", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" }],
    });
    const selectedRun = join(dir, "nodes", "test-design", "run_1");
    const rogueRun = join(dir, "nodes", "test-design", "run_2");
    mkdirSync(selectedRun, { recursive: true });
    mkdirSync(rogueRun, { recursive: true });
    writeFileSync(join(selectedRun, "eval-a.md"), "# Eval A\n");
    writeFileSync(join(selectedRun, "eval-b.md"), "# Eval B\n");
    writeFileSync(join(rogueRun, "test-plan.md"), completeTestPlan());
    writeFileSync(join(dir, "nodes", "test-design", "handshake.json"), JSON.stringify({
      nodeId: "test-design",
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "selected run has evals but no test plan",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [
        { type: "eval", path: "run_1/eval-a.md" },
        { type: "eval", path: "run_1/eval-b.md" },
      ],
    }, null, 2));
    writeFileSync(join(selectedRun, "handshake.json"), JSON.stringify({
      nodeId: "test-design",
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "selected run has evals but no test plan",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [
        { type: "eval", path: "eval-a.md" },
        { type: "eval", path: "eval-b.md" },
      ],
    }, null, 2));

    const result = runHarness("transition", [
      "--from", "test-design", "--to", "test-execute", "--verdict", "PASS", "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /test-design test-plan\.md missing/);
    assert.equal(existsSync(join(dir, "nodes", "test-execute", "run_1")), false);
  });

  test("unbound node-level testCommand is rejected before target run or shell marker", () => {
    const dir = join(TMPBASE, "unbound-test-command");
    const marker = join(dir, "shell-marker");
    writeState(dir, {
      currentNode: "test-design",
      entryNode: "test-design",
      history: [{ nodeId: "test-design", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" }],
    });
    const selectedRun = join(dir, "nodes", "test-design", "run_1");
    mkdirSync(selectedRun, { recursive: true });
    writeFileSync(join(selectedRun, "eval-a.md"), "# Eval A\n");
    writeFileSync(join(selectedRun, "eval-b.md"), "# Eval B\n");
    writeFileSync(join(selectedRun, "test-plan.md"), completeTestPlan());
    writeFileSync(join(dir, "nodes", "test-design", "test-execution.json"), JSON.stringify({
      testCommand: `touch ${marker}`,
    }));
    writeFileSync(join(dir, "nodes", "test-design", "handshake.json"), JSON.stringify({
      nodeId: "test-design",
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "selected run",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [
        { type: "eval", path: "run_1/eval-a.md" },
        { type: "eval", path: "run_1/eval-b.md" },
        { type: "test-plan", path: "run_1/test-plan.md" },
      ],
    }, null, 2));
    writeFileSync(join(selectedRun, "handshake.json"), JSON.stringify({
      nodeId: "test-design",
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "selected run",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [
        { type: "eval", path: "eval-a.md" },
        { type: "eval", path: "eval-b.md" },
        { type: "test-plan", path: "test-plan.md" },
      ],
    }, null, 2));

    const beforeState = readFileSync(join(dir, "flow-state.json"), "utf8");
    const result = runHarness("transition", [
      "--from", "test-design", "--to", "test-execute", "--verdict", "PASS", "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /testCommand source binding failed/);
    assert.equal(readFileSync(join(dir, "flow-state.json"), "utf8"), beforeState);
    assert.equal(existsSync(join(dir, "nodes", "test-execute", "run_1")), false);
    assert.equal(existsSync(marker), false);
  });

  test("pass rejects malformed upstream history runId instead of synthesizing latest run", () => {
    const dir = join(TMPBASE, "pass-malformed-history-run");
    const flowFile = writeFlowFile(dir, "pass-malformed-history-flow", {
      nodes: ["review", "gate", "done"],
      edges: { review: { PASS: "gate" }, gate: { PASS: "done" }, done: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", gate: "gate", done: "build" },
    });
    writeState(dir, {
      flowTemplate: "pass-malformed-history-flow",
      _flow_file: flowFile,
      currentNode: "gate",
      entryNode: "review",
      history: [
        { nodeId: "review", runId: "bad", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
      edgeCounts: { "review→gate": 1 },
    });
    writeReviewRun(dir, "review", "run_2");
    const stateBefore = readFileSync(join(dir, "flow-state.json"), "utf8");

    const result = runHarness("pass", ["--dir", dir]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.error, /missing or invalid runId/);
    assert.equal(readFileSync(join(dir, "flow-state.json"), "utf8"), stateBefore);
    assert.equal(existsSync(join(dir, "nodes", "done")), false);
  });

  test("advance rejects missing upstream history runId instead of synthesizing latest run", () => {
    const dir = join(TMPBASE, "advance-missing-history-run");
    const flowFile = writeFlowFile(dir, "advance-missing-history-flow", {
      nodes: ["review", "gate", "done"],
      edges: { review: { PASS: "gate" }, gate: { PASS: "done" }, done: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", gate: "gate", done: "build" },
    });
    writeState(dir, {
      flowTemplate: "advance-missing-history-flow",
      _flow_file: flowFile,
      currentNode: "gate",
      entryNode: "review",
      history: [
        { nodeId: "review", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
      edgeCounts: { "review→gate": 1 },
    });
    writeReviewRun(dir, "review", "run_2");
    const stateBefore = readFileSync(join(dir, "flow-state.json"), "utf8");

    const result = runHarness("advance", ["--dir", dir]);

    assert.equal(result.advanced, false, JSON.stringify(result));
    assert.equal(result.step, "synthesize");
    assert.match(result.error, /missing or invalid/);
    assert.equal(readFileSync(join(dir, "flow-state.json"), "utf8"), stateBefore);
    assert.equal(existsSync(join(dir, "nodes", "done")), false);
  });

  test("validate fails closed when session state is malformed", () => {
    const dir = join(TMPBASE, "validate-corrupt-session-authority");
    mkdirSync(join(dir, "nodes", "build", "run_2"), { recursive: true });
    writeFileSync(join(dir, "flow-state.json"), "{not-json");
    const hsPath = join(dir, "nodes", "build", "run_2", "handshake.json");
    writeFileSync(hsPath, JSON.stringify({
      nodeId: "build",
      nodeType: "build",
      runId: "run_2",
      status: "completed",
      verdict: null,
      summary: "standalone-looking rogue evidence",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [],
    }, null, 2));

    const result = runHarness("validate", [hsPath]);

    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join("\n"), /cannot parse flow-state\.json/);
  });

  test("positional validate checks the whole session authority", () => {
    const dir = join(TMPBASE, "validate-whole-session-authority");
    writeState(dir, {
      currentNode: "build",
      history: [
        { nodeId: "build", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "review", runId: "bad", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
    });
    writeBuildHandshake(dir, "run_1");

    const result = runHarness("validate", [join(dir, "nodes", "build", "run_1", "handshake.json")]);

    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join("\n"), /history\[1\]\.runId missing or invalid/);
  });

  test("default validate cannot use canonical when exact selected run is missing", () => {
    const dir = join(TMPBASE, "validate-missing-exact-run");
    writeState(dir);
    mkdirSync(join(dir, "nodes", "build"), { recursive: true });
    writeFileSync(join(dir, "nodes", "build", "output.md"), "canonical output");
    writeFileSync(join(dir, "nodes", "build", "handshake.json"), JSON.stringify({
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: null,
      summary: "canonical impersonation",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [{ type: "source", path: "output.md" }],
    }, null, 2));

    const result = runHarness("validate", ["--dir", dir]);

    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join("\n"), /missing exact selected-run handshake/);
  });

  test("validate-chain rejects repeated-node canonical projection conflict", () => {
    const dir = join(TMPBASE, "validate-chain-canonical-projection");
    writeState(dir, {
      currentNode: "gate",
      entryNode: "review",
      history: [
        { nodeId: "review", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
        { nodeId: "review", runId: "run_2", timestamp: "2026-01-01T00:00:02.000Z" },
        { nodeId: "gate", runId: "run_2", timestamp: "2026-01-01T00:00:03.000Z" },
      ],
      edgeCounts: { "review→gate": 2, "gate→review": 1 },
    });
    writeReviewRun(dir, "review", "run_1");
    writeReviewRun(dir, "review", "run_2");
    for (const runId of ["run_1", "run_2"]) {
      mkdirSync(join(dir, "nodes", "gate", runId), { recursive: true });
      writeFileSync(join(dir, "nodes", "gate", runId, "handshake.json"), JSON.stringify({
        nodeId: "gate",
        nodeType: "gate",
        runId,
        status: "completed",
        verdict: "PASS",
        summary: "gate",
        timestamp: "2026-01-01T00:00:03.000Z",
        artifacts: [],
      }, null, 2));
    }
    writeFileSync(join(dir, "nodes", "review", "handshake.json"), JSON.stringify({
      nodeId: "review",
      nodeType: "review",
      runId: "run_3",
      status: "completed",
      verdict: "PASS",
      summary: "rogue canonical",
      timestamp: "2026-01-01T00:00:04.000Z",
      artifacts: [],
    }, null, 2));

    const result = runHarness("validate-chain", ["--dir", dir]);

    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join("\n"), /canonical .*runId is 'run_3', expected 'run_2'/);
  });

  test("validate-chain rejects partial canonical projection schema", () => {
    const dir = join(TMPBASE, "validate-chain-partial-canonical");
    writeState(dir, {
      currentNode: "gate",
      entryNode: "review",
      history: [
        { nodeId: "review", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
      edgeCounts: { "review→gate": 1 },
    });
    writeReviewRun(dir, "review", "run_1");
    mkdirSync(join(dir, "nodes", "gate", "run_1"), { recursive: true });
    writeFileSync(join(dir, "nodes", "gate", "run_1", "handshake.json"), JSON.stringify({
      nodeId: "gate",
      nodeType: "gate",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "gate",
      timestamp: "2026-01-01T00:00:01.000Z",
      artifacts: [],
    }, null, 2));
    writeFileSync(join(dir, "nodes", "review", "handshake.json"), JSON.stringify({
      nodeId: "review",
      runId: "run_1",
      status: "completed",
      artifacts: [],
    }, null, 2));

    const result = runHarness("validate-chain", ["--dir", dir]);

    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join("\n"), /canonical .*missing or empty required field: nodeType/);
  });

  test("strict finalize rejects canonical conflict before writing completed state", () => {
    const dir = join(TMPBASE, "strict-finalize-canonical-projection");
    const flowFile = writeFlowFile(dir, "strict-finalize-canonical-flow", {
      nodes: ["review", "done"],
      edges: { review: { PASS: "done" }, done: { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", done: "build" },
    });
    writeState(dir, {
      flowTemplate: "strict-finalize-canonical-flow",
      _flow_file: flowFile,
      currentNode: "done",
      entryNode: "review",
      history: [
        { nodeId: "review", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "done", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
      edgeCounts: { "review→done": 1 },
    });
    writeReviewRun(dir, "review", "run_1");
    writeFileSync(join(dir, "nodes", "review", "handshake.json"), JSON.stringify({
      nodeId: "review",
      nodeType: "review",
      runId: "run_2",
      status: "completed",
      verdict: "PASS",
      summary: "rogue canonical",
      timestamp: "2026-01-01T00:00:02.000Z",
      artifacts: [],
    }, null, 2));
    writeTerminalHandshake(dir, "done", "run_1");
    const before = readFileSync(join(dir, "flow-state.json"), "utf8");

    const result = runHarness("finalize", ["--strict", "--dir", dir]);

    assert.equal(result.finalized, false, JSON.stringify(result));
    assert.match(result.error, /expected 'run_1'/);
    assert.equal(readFileSync(join(dir, "flow-state.json"), "utf8"), before);
  });

  test("strict finalize rejects terminal partial test provenance before completion", () => {
    const dir = join(TMPBASE, "strict-finalize-terminal-provenance");
    const flowFile = writeFlowFile(dir, "strict-terminal-provenance-flow", {
      nodes: ["test-execute"],
      edges: { "test-execute": { PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { "test-execute": "execute" },
    });
    writeState(dir, {
      flowTemplate: "strict-terminal-provenance-flow",
      _flow_file: flowFile,
      currentNode: "test-execute",
      entryNode: "test-execute",
      history: [{ nodeId: "test-execute", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" }],
    });
    const runDir = join(dir, "nodes", "test-execute", "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "test-command-result.json"), JSON.stringify({
      checks: [{ id: "smoke", pass: true, total: 1 }],
      provenance: { kind: "opc-test-command", executionActor: "opc-harness:test-command" },
    }, null, 2));
    const handshake = {
      nodeId: "test-execute",
      nodeType: "execute",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "partial provenance",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [{ type: "test-result", path: "test-command-result.json" }],
      testEvidenceProvenance: {
        kind: "opc-test-command",
        sourceNode: "test-design",
        commandHash: "abc",
        sourcePlanHash: "def",
        resultHash: "ghi",
        executionActor: "opc-harness:test-command",
      },
    };
    writeFileSync(join(runDir, "handshake.json"), JSON.stringify(handshake, null, 2));
    writeFileSync(join(dir, "nodes", "test-execute", "handshake.json"), JSON.stringify({
      ...handshake,
      artifacts: [{ type: "test-result", path: "run_1/test-command-result.json" }],
    }, null, 2));
    const before = readFileSync(join(dir, "flow-state.json"), "utf8");

    const result = runHarness("finalize", ["--strict", "--flow-file", flowFile, "--dir", dir]);

    assert.equal(result.finalized, false, JSON.stringify(result));
    assert.match(result.error, /testEvidenceProvenance\.sourceRunId/);
    assert.equal(readFileSync(join(dir, "flow-state.json"), "utf8"), before);
  });

  test("hotfix retest rejects missing historical test-design run before shell spawn", () => {
    const dir = join(TMPBASE, "hotfix-missing-test-design-run");
    const marker = join(dir, "hotfix-marker");
    const flowFile = writeFlowFile(dir, "hotfix-retest-flow", {
      nodes: ["test-design", "test-execute", "hotfix"],
      edges: {
        "test-design": { PASS: "test-execute" },
        "test-execute": { ITERATE: "hotfix", PASS: null },
        hotfix: { PASS: "test-execute" },
      },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { "test-design": "review", "test-execute": "execute", hotfix: "build" },
    });
    writeState(dir, {
      flowTemplate: "hotfix-retest-flow",
      _flow_file: flowFile,
      currentNode: "hotfix",
      entryNode: "test-design",
      history: [
        { nodeId: "test-design", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "test-execute", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
        { nodeId: "hotfix", runId: "run_1", timestamp: "2026-01-01T00:00:02.000Z" },
      ],
      edgeCounts: { "test-design→test-execute": 1, "test-execute→hotfix": 1 },
    });
    mkdirSync(join(dir, "nodes", "hotfix", "run_1"), { recursive: true });
    writeFileSync(join(dir, "nodes", "hotfix", "run_1", "fix.md"), "fix");
    const hotfixHandshake = {
      nodeId: "hotfix",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "fix",
      timestamp: "2026-01-01T00:00:02.000Z",
      artifacts: [{ type: "source", path: "run_1/fix.md" }],
    };
    writeFileSync(join(dir, "nodes", "hotfix", "run_1", "handshake.json"), JSON.stringify({
      ...hotfixHandshake,
      artifacts: [{ type: "source", path: "fix.md" }],
    }, null, 2));
    writeFileSync(join(dir, "nodes", "hotfix", "handshake.json"), JSON.stringify(hotfixHandshake, null, 2));
    mkdirSync(join(dir, "nodes", "test-design", "run_2"), { recursive: true });
    writeFileSync(join(dir, "nodes", "test-design", "run_2", "test-execution.json"), JSON.stringify({
      runId: "run_2",
      testCommand: `touch ${marker}`,
    }));
    const before = readFileSync(join(dir, "flow-state.json"), "utf8");

    const result = runHarness("transition", [
      "--from", "hotfix", "--to", "test-execute", "--verdict", "PASS", "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /testCommand source binding failed/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(dir, "nodes", "test-execute", "run_2")), false);
    assert.equal(readFileSync(join(dir, "flow-state.json"), "utf8"), before);
  });

  test("hotfix retest rejects malformed newest test-design history instead of older run", () => {
    const dir = join(TMPBASE, "hotfix-malformed-newest-test-design");
    const marker = join(dir, "hotfix-newest-marker");
    const flowFile = writeFlowFile(dir, "hotfix-newest-flow", {
      nodes: ["test-design", "test-execute", "hotfix"],
      edges: {
        "test-design": { PASS: "test-execute" },
        "test-execute": { ITERATE: "hotfix", PASS: null },
        hotfix: { PASS: "test-execute" },
      },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { "test-design": "review", "test-execute": "execute", hotfix: "build" },
    });
    writeState(dir, {
      flowTemplate: "hotfix-newest-flow",
      _flow_file: flowFile,
      currentNode: "hotfix",
      entryNode: "test-design",
      history: [
        { nodeId: "test-design", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "test-execute", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
        { nodeId: "test-design", runId: "bad", timestamp: "2026-01-01T00:00:02.000Z" },
        { nodeId: "hotfix", runId: "run_1", timestamp: "2026-01-01T00:00:03.000Z" },
      ],
      edgeCounts: { "test-design→test-execute": 1, "test-execute→test-design": 1, "test-design→hotfix": 1 },
    });
    const tdRun = join(dir, "nodes", "test-design", "run_1");
    mkdirSync(tdRun, { recursive: true });
    writeFileSync(join(tdRun, "test-plan.md"), completeTestPlan());
    writeFileSync(join(tdRun, "test-execution.json"), JSON.stringify({
      runId: "run_1",
      testCommand: `touch ${marker}`,
    }));
    writeReviewRun(dir, "test-design", "run_1", {
      artifacts: [
        { type: "eval", path: "eval-a.md" },
        { type: "eval", path: "eval-b.md" },
        { type: "test-plan", path: "test-plan.md" },
      ],
    });
    mkdirSync(join(dir, "nodes", "test-execute", "run_1"), { recursive: true });
    writeFileSync(join(dir, "nodes", "test-execute", "run_1", "handshake.json"), JSON.stringify({
      nodeId: "test-execute",
      nodeType: "execute",
      runId: "run_1",
      status: "completed",
      verdict: "ITERATE",
      summary: "needs hotfix",
      timestamp: "2026-01-01T00:00:01.000Z",
      artifacts: [{ type: "cli-output", path: "log.txt" }],
    }, null, 2));
    mkdirSync(join(dir, "nodes", "hotfix", "run_1"), { recursive: true });
    writeFileSync(join(dir, "nodes", "hotfix", "run_1", "handshake.json"), JSON.stringify({
      nodeId: "hotfix",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "fix",
      timestamp: "2026-01-01T00:00:03.000Z",
      artifacts: [],
    }, null, 2));
    const before = readFileSync(join(dir, "flow-state.json"), "utf8");

    const result = runHarness("transition", [
      "--from", "hotfix", "--to", "test-execute", "--verdict", "PASS", "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /history runId is missing or invalid/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(dir, "nodes", "test-execute", "run_2")), false);
    assert.equal(readFileSync(join(dir, "flow-state.json"), "utf8"), before);
  });

  test("gate backlog rejects unbound canonical warnings before mutation", () => {
    const dir = join(TMPBASE, "backlog-exact-upstream");
    const flowFile = writeFlowFile(dir, "backlog-exact-flow", {
      nodes: ["review", "gate"],
      edges: { review: { PASS: "gate" }, gate: { PASS: null, ITERATE: "review" } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", gate: "gate" },
    });
    writeState(dir, {
      flowTemplate: "backlog-exact-flow",
      _flow_file: flowFile,
      currentNode: "gate",
      entryNode: "review",
      history: [
        { nodeId: "review", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
      edgeCounts: { "review→gate": 1 },
    });
    writeReviewRun(dir, "review", "run_1", { findings: { critical: 0, warning: 0, suggestion: 0 } });
    writeFileSync(join(dir, "nodes", "review", "handshake.json"), JSON.stringify({
      nodeId: "review",
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "rogue warning mirror",
      timestamp: "2026-01-01T00:00:02.000Z",
      artifacts: [
        { type: "eval", path: "run_1/eval-a.md" },
        { type: "eval", path: "run_1/eval-b.md" },
      ],
      findings: { critical: 0, warning: 1, suggestion: 0 },
    }, null, 2));
    mkdirSync(join(dir, "nodes", "gate"), { recursive: true });
    writeFileSync(join(dir, "nodes", "gate", "handshake.json"), JSON.stringify({
      nodeId: "gate",
      nodeType: "gate",
      runId: "run_1",
      status: "completed",
      verdict: "ITERATE",
      summary: "gate",
      timestamp: "2026-01-01T00:00:01.000Z",
      artifacts: [],
    }, null, 2));

    const result = runHarness("transition", [
      "--from", "gate", "--to", "review", "--verdict", "ITERATE", "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /not exact-run projection/);
  });

  test("cumulative findings keeps orphan run findings out of reviewer context", () => {
    const dir = join(TMPBASE, "cumulative-orphan-runs");
    writeState(dir, {
      currentNode: "code-review",
      entryNode: "build",
      history: [
        { nodeId: "build", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "code-review", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
    });
    writeBuildHandshake(dir, "run_1");
    writeReviewRun(dir, "code-review", "run_1");
    const orphan = join(dir, "nodes", "code-review", "run_2");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "eval-orphan.md"), [
      "# Orphan",
      "",
      "🔴 Orphan-only critical — rogue.js:1",
      "→ Do not inject this into reviewer context.",
      "Reasoning: This run is not state-selected.",
    ].join("\n"));

    const markdown = buildCumulativeFindingsMarkdown(dir, JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8")));

    assert.match(markdown, /Forensic Orphan Runs/);
    assert.match(markdown, /code-review\/run_2/);
    assert.doesNotMatch(markdown, /Orphan-only critical/);
  });

  test("cumulative findings keeps orphan fixesApplied out of reviewer context", () => {
    const dir = join(TMPBASE, "cumulative-orphan-fixes");
    writeState(dir, {
      currentNode: "code-review",
      entryNode: "build",
      history: [
        { nodeId: "build", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "code-review", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
    });
    writeBuildHandshake(dir, "run_1");
    writeReviewRun(dir, "code-review", "run_1");
    mkdirSync(join(dir, "nodes", "code-review", "run_2"), { recursive: true });
    writeFileSync(join(dir, "nodes", "code-review", "run_2", "handshake.json"), JSON.stringify({
      nodeId: "code-review",
      nodeType: "review",
      runId: "run_2",
      status: "completed",
      verdict: "PASS",
      summary: "orphan retry",
      timestamp: "2026-01-01T00:00:02.000Z",
      artifacts: [],
      fixesApplied: ["Orphan-only fix must not enter reviewer prompt"],
    }, null, 2));

    const markdown = buildCumulativeFindingsMarkdown(dir, JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8")));

    assert.match(markdown, /Forensic Orphan Runs/);
    assert.match(markdown, /code-review\/run_2/);
    assert.doesNotMatch(markdown, /Orphan-only fix/);
  });

  test("seal rejects partial testEvidenceProvenance without rewriting canonical bytes", () => {
    const dir = join(TMPBASE, "seal-partial-test-provenance");
    writeState(dir, {
      flowTemplate: "build-verify",
      currentNode: "test-execute",
      entryNode: "test-execute",
      history: [{ nodeId: "test-execute", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" }],
    });
    const nodeDir = join(dir, "nodes", "test-execute");
    const runDir = join(nodeDir, "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "test-command-result.json"), JSON.stringify({
      checks: [{ id: "smoke", pass: true, total: 1 }],
      provenance: { kind: "opc-test-command", executionActor: "opc-harness:test-command" },
    }, null, 2));
    const handshakePath = join(nodeDir, "handshake.json");
    const canonical = {
      nodeId: "test-execute",
      nodeType: "execute",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "partial provenance",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [{ type: "test-result", path: "run_1/test-command-result.json" }],
      testEvidenceProvenance: {
        kind: "opc-test-command",
        executionActor: "opc-harness:test-command",
      },
    };
    writeFileSync(handshakePath, JSON.stringify(canonical, null, 2));
    const before = readFileSync(handshakePath, "utf8");

    const result = runHarness("seal", ["--node", "test-execute", "--dir", dir]);

    assert.equal(result.sealed, false, JSON.stringify(result));
    assert.match(result.validationErrors.join("\n"), /testEvidenceProvenance\.commandHash missing/);
    assert.equal(readFileSync(handshakePath, "utf8"), before);
  });

  test("seal requires sourceRunId and non-null policy in test evidence provenance", () => {
    const dir = join(TMPBASE, "seal-source-run-required");
    writeState(dir, {
      flowTemplate: "build-verify",
      currentNode: "test-execute",
      entryNode: "test-execute",
      history: [{ nodeId: "test-execute", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" }],
    });
    const nodeDir = join(dir, "nodes", "test-execute");
    const runDir = join(nodeDir, "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "test-command-result.json"), JSON.stringify({
      checks: [{ id: "smoke", pass: true, total: 1 }],
      provenance: {
        kind: "opc-test-command",
        sourceNode: "test-design",
        commandHash: "cmd",
        sourcePlanHash: "plan",
        executionActor: "opc-harness:test-command",
      },
    }, null, 2));
    const handshakePath = join(nodeDir, "handshake.json");
    writeFileSync(handshakePath, JSON.stringify({
      nodeId: "test-execute",
      nodeType: "execute",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "missing source run",
      timestamp: "2026-01-01T00:00:00.000Z",
      artifacts: [{ type: "test-result", path: "run_1/test-command-result.json" }],
      testEvidenceProvenance: {
        kind: "opc-test-command",
        sourceNode: "test-design",
        commandHash: "cmd",
        sourcePlanHash: "plan",
        resultHash: "result",
        executionActor: "opc-harness:test-command",
        ledger: { kind: "opc-hmac-ledger", recordHash: "missing" },
      },
      testEvidencePolicy: null,
    }, null, 2));
    const before = readFileSync(handshakePath, "utf8");

    const result = runHarness("seal", ["--node", "test-execute", "--dir", dir]);

    assert.equal(result.sealed, false, JSON.stringify(result));
    assert.match(result.validationErrors.join("\n"), /sourceRunId/);
    assert.match(result.validationErrors.join("\n"), /testEvidencePolicy/);
    assert.equal(readFileSync(handshakePath, "utf8"), before);
  });

  test("direct gate FAIL rejects invalid upstream authority before mutation", () => {
    const dir = join(TMPBASE, "direct-gate-fail-authority");
    const flowFile = writeFlowFile(dir, "direct-gate-fail-flow", {
      nodes: ["review", "gate"],
      edges: { review: { PASS: "gate" }, gate: { FAIL: "review", PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", gate: "gate" },
    });
    writeState(dir, {
      flowTemplate: "direct-gate-fail-flow",
      _flow_file: flowFile,
      currentNode: "gate",
      entryNode: "review",
      history: [
        { nodeId: "review", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
      edgeCounts: { "review→gate": 1 },
      repairEdgeCounts: {},
    });
    writeReviewRun(dir, "review", "run_2", { verdict: "FAIL", findings: { critical: 1, warning: 0, suggestion: 0 } });
    const before = readFileSync(join(dir, "flow-state.json"), "utf8");

    const result = runHarness("transition", [
      "--from", "gate", "--to", "review", "--verdict", "FAIL", "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /gate authority check failed/);
    assert.equal(readFileSync(join(dir, "flow-state.json"), "utf8"), before);
    assert.equal(existsSync(join(dir, "nodes", "review", "run_3")), false);
  });

  test("direct gate FAIL rejects partial canonical projection before mutation", () => {
    const dir = join(TMPBASE, "direct-gate-partial-canonical");
    const flowFile = writeFlowFile(dir, "direct-gate-partial-flow", {
      nodes: ["review", "gate"],
      edges: { review: { PASS: "gate" }, gate: { FAIL: "review", PASS: null } },
      limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
      nodeTypes: { review: "review", gate: "gate" },
    });
    writeState(dir, {
      flowTemplate: "direct-gate-partial-flow",
      _flow_file: flowFile,
      currentNode: "gate",
      entryNode: "review",
      history: [
        { nodeId: "review", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
      edgeCounts: { "review→gate": 1 },
      repairEdgeCounts: {},
    });
    writeReviewRun(dir, "review", "run_1", { verdict: "FAIL", findings: { critical: 1, warning: 0, suggestion: 0 } });
    mkdirSync(join(dir, "nodes", "gate", "run_1"), { recursive: true });
    writeFileSync(join(dir, "nodes", "gate", "run_1", "handshake.json"), JSON.stringify({
      nodeId: "gate",
      nodeType: "gate",
      runId: "run_1",
      status: "completed",
      verdict: "FAIL",
      summary: "gate",
      timestamp: "2026-01-01T00:00:01.000Z",
      artifacts: [],
    }, null, 2));
    writeFileSync(join(dir, "nodes", "review", "handshake.json"), JSON.stringify({
      nodeId: "review",
      runId: "run_1",
      status: "completed",
      artifacts: [],
    }, null, 2));
    const before = readFileSync(join(dir, "flow-state.json"), "utf8");

    const result = runHarness("transition", [
      "--from", "gate", "--to", "review", "--verdict", "FAIL", "--flow-file", flowFile, "--dir", dir,
    ]);

    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /gate authority check failed/);
    assert.equal(readFileSync(join(dir, "flow-state.json"), "utf8"), before);
    assert.equal(existsSync(join(dir, "nodes", "review", "run_2")), false);
  });
});
