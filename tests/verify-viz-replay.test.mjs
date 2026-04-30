// tests/verify-viz-replay.test.mjs — V851-V900 (50 tests)
// Verification of visualization and replay data

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { getMarker, cmdViz, cmdReplayData } from "../bin/lib/viz-commands.mjs";
import { FLOW_TEMPLATES } from "../bin/lib/flow-templates.mjs";

function capture(fn) {
  const logs = [];
  const errs = [];
  let exitCode = null;
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  process.exit = (code) => { exitCode = code; throw new Error(`EXIT_${code}`); };
  let result;
  try { result = fn(); } catch (e) { if (!e.message.startsWith("EXIT_")) throw e; }
  finally { console.log = origLog; console.error = origErr; process.exit = origExit; }
  return { logs, errs, exitCode, output: logs.join("\n") };
}

function parseOutput(c) { return c.logs.length ? JSON.parse(c.output) : null; }

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "opc-viz-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function writeFlowState(dir, state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "flow-state.json"), JSON.stringify(state, null, 2));
}

function writeHandshake(dir, nodeId, hs) {
  const nodeDir = join(dir, "nodes", nodeId);
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(nodeDir, "handshake.json"), JSON.stringify(hs));
}

function writeRunFile(dir, nodeId, runName, fileName, content) {
  const runDir = join(dir, "nodes", nodeId, runName);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, fileName), content);
}

// ══════════════════════════════════════════════════════════════════
// 1. Marker state transitions (V851-V865)
// ══════════════════════════════════════════════════════════════════
describe("Marker state transitions", () => {
  it("V851 — no state → all nodes show ○", () => {
    assert.equal(getMarker("build", null), "○");
    assert.equal(getMarker("gate", null), "○");
  });

  it("V852 — current node shows ▶", () => {
    const state = { currentNode: "build", history: [], entryNode: "build" };
    assert.equal(getMarker("build", state), "▶");
  });

  it("V853 — non-current node without history shows ○", () => {
    const state = { currentNode: "build", history: [], entryNode: "build" };
    assert.equal(getMarker("gate", state), "○");
  });

  it("V854 — node in history shows ✅", () => {
    const state = {
      currentNode: "code-review",
      history: [{ nodeId: "build", runId: "run_1" }],
      entryNode: "build",
    };
    assert.equal(getMarker("build", state), "✅");
  });

  it("V855 — entry node shows ✅ when moved away", () => {
    const state = {
      currentNode: "code-review",
      history: [],
      entryNode: "build",
    };
    assert.equal(getMarker("build", state), "✅");
  });

  it("V856 — entry node shows ▶ when still current", () => {
    const state = {
      currentNode: "build",
      history: [],
      entryNode: "build",
    };
    assert.equal(getMarker("build", state), "▶");
  });

  it("V857 — only one ▶ marker at a time in full walk", () => {
    const template = FLOW_TEMPLATES["build-verify"];
    const state = {
      currentNode: "code-review",
      history: [{ nodeId: "build", runId: "run_1" }],
      entryNode: "build",
    };
    const markers = template.nodes.map(n => getMarker(n, state));
    assert.equal(markers.filter(m => m === "▶").length, 1);
  });

  it("V858 — walk through build-verify: step 1 at build", () => {
    const state = { currentNode: "build", history: [], entryNode: "build" };
    assert.equal(getMarker("build", state), "▶");
    assert.equal(getMarker("code-review", state), "○");
    assert.equal(getMarker("test-verify", state), "○");
    assert.equal(getMarker("gate", state), "○");
  });

  it("V859 — walk through build-verify: step 2 at code-review", () => {
    const state = {
      currentNode: "code-review",
      history: [{ nodeId: "code-review", runId: "run_1" }],
      entryNode: "build",
    };
    assert.equal(getMarker("build", state), "✅");
    assert.equal(getMarker("code-review", state), "▶");
    assert.equal(getMarker("test-verify", state), "○");
    assert.equal(getMarker("gate", state), "○");
  });

  it("V860 — walk through build-verify: step 3 at test-verify", () => {
    const state = {
      currentNode: "test-verify",
      history: [
        { nodeId: "code-review", runId: "run_1" },
        { nodeId: "test-verify", runId: "run_1" },
      ],
      entryNode: "build",
    };
    assert.equal(getMarker("build", state), "✅");
    assert.equal(getMarker("code-review", state), "✅");
    assert.equal(getMarker("test-verify", state), "▶");
    assert.equal(getMarker("gate", state), "○");
  });

  it("V861 — walk through build-verify: step 4 at gate", () => {
    const state = {
      currentNode: "gate",
      history: [
        { nodeId: "code-review", runId: "run_1" },
        { nodeId: "test-verify", runId: "run_1" },
        { nodeId: "gate", runId: "run_1" },
      ],
      entryNode: "build",
    };
    assert.equal(getMarker("build", state), "✅");
    assert.equal(getMarker("code-review", state), "✅");
    assert.equal(getMarker("test-verify", state), "✅");
    assert.equal(getMarker("gate", state), "▶");
  });

  it("V862 — loop back: gate FAIL → back at build shows build as ▶ again", () => {
    const state = {
      currentNode: "build",
      history: [
        { nodeId: "code-review", runId: "run_1" },
        { nodeId: "test-verify", runId: "run_1" },
        { nodeId: "gate", runId: "run_1" },
        { nodeId: "build", runId: "run_2" },
      ],
      entryNode: "build",
    };
    assert.equal(getMarker("build", state), "▶");
    assert.equal(getMarker("gate", state), "✅");
  });

  it("V863 — quick-review: entry at code-review shows ▶", () => {
    const state = { currentNode: "code-review", history: [], entryNode: "code-review" };
    assert.equal(getMarker("code-review", state), "▶");
    assert.equal(getMarker("gate", state), "○");
  });

  it("V864 — full-stack: all 13 nodes have markers", () => {
    const template = FLOW_TEMPLATES["full-stack"];
    const state = { currentNode: "discuss", history: [], entryNode: "discuss" };
    const markers = template.nodes.map(n => getMarker(n, state));
    assert.equal(markers.length, 13);
    assert.equal(markers.filter(m => m === "▶").length, 1);
  });

  it("V865 — unknown node with state → ○", () => {
    const state = { currentNode: "build", history: [], entryNode: "build" };
    assert.equal(getMarker("nonexistent-node", state), "○");
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. Viz output consistency (V866-V880)
// ══════════════════════════════════════════════════════════════════
describe("Viz output consistency", () => {
  it("V866 — JSON output has all nodes from build-verify", () => {
    const c = capture(() => cmdViz(["--flow", "build-verify", "--json"]));
    const out = parseOutput(c);
    const ids = out.nodes.map(n => n.id);
    assert.deepEqual(ids, ["build", "code-review", "test-verify", "gate"]);
  });

  it("V867 — JSON output has all nodes from quick-review", () => {
    const c = capture(() => cmdViz(["--flow", "quick-review", "--json"]));
    const out = parseOutput(c);
    assert.deepEqual(out.nodes.map(n => n.id), ["code-review", "gate"]);
  });

  it("V868 — JSON output has all nodes from full-stack", () => {
    const c = capture(() => cmdViz(["--flow", "full-stack", "--json"]));
    const out = parseOutput(c);
    assert.equal(out.nodes.length, 13);
  });

  it("V869 — JSON output has all nodes from legacy-linear", () => {
    const c = capture(() => cmdViz(["--flow", "legacy-linear", "--json"]));
    const out = parseOutput(c);
    assert.deepEqual(out.nodes.map(n => n.id), ["design", "plan", "build", "evaluate", "deliver"]);
  });

  it("V870 — JSON output has all nodes from pre-release", () => {
    const c = capture(() => cmdViz(["--flow", "pre-release", "--json"]));
    const out = parseOutput(c);
    assert.equal(out.nodes.length, 6);
  });

  it("V871 — loopback detection for build-verify gate", () => {
    const c = capture(() => cmdViz(["--flow", "build-verify", "--json"]));
    const out = parseOutput(c);
    const gateLoopbacks = out.loopbacks.filter(lb => lb.gate === "gate");
    assert.ok(gateLoopbacks.length >= 1);
    assert.ok(gateLoopbacks.some(lb => lb.verdict === "FAIL" && lb.target === "build"));
  });

  it("V872 — loopback detection for full-stack gates", () => {
    const c = capture(() => cmdViz(["--flow", "full-stack", "--json"]));
    const out = parseOutput(c);
    const gates = ["gate-test", "gate-acceptance", "gate-audit", "gate-e2e", "gate-final"];
    for (const g of gates) {
      assert.ok(out.loopbacks.some(lb => lb.gate === g), `missing loopback for ${g}`);
    }
  });

  it("V873 — quick-review has no loopbacks (gate only has PASS)", () => {
    const c = capture(() => cmdViz(["--flow", "quick-review", "--json"]));
    const out = parseOutput(c);
    assert.equal(out.loopbacks.length, 0);
  });

  it("V874 — ASCII output contains all node names from build-verify", () => {
    const c = capture(() => cmdViz(["--flow", "build-verify"]));
    const ascii = c.logs.join("\n");
    for (const n of ["build", "code-review", "test-verify", "gate"]) {
      assert.ok(ascii.includes(n), `missing node ${n} in ASCII`);
    }
  });

  it("V875 — ASCII output shows FAIL edge for gate in build-verify", () => {
    const c = capture(() => cmdViz(["--flow", "build-verify"]));
    const ascii = c.logs.join("\n");
    assert.ok(ascii.includes("FAIL"));
    assert.ok(ascii.includes("build"));
  });

  it("V876 — JSON node status is ○ when no state dir", () => {
    const c = capture(() => cmdViz(["--flow", "build-verify", "--json"]));
    const out = parseOutput(c);
    assert.ok(out.nodes.every(n => n.status === "○"));
  });

  it("V877 — JSON node status reflects state when dir provided", () => {
    writeFlowState(tmp, {
      flowTemplate: "build-verify",
      currentNode: "code-review",
      entryNode: "build",
      history: [{ nodeId: "code-review", runId: "run_1" }],
    });
    const c = capture(() => cmdViz(["--flow", "build-verify", "--dir", tmp, "--json"]));
    const out = parseOutput(c);
    const buildNode = out.nodes.find(n => n.id === "build");
    const crNode = out.nodes.find(n => n.id === "code-review");
    assert.equal(buildNode.status, "✅");
    assert.equal(crNode.status, "▶");
  });

  it("V878 — unknown flow template → exits with error", () => {
    const c = capture(() => cmdViz(["--flow", "nonexistent", "--json"]));
    assert.equal(c.exitCode, 1);
  });

  it("V879 — missing --flow → exits with error", () => {
    const c = capture(() => cmdViz([]));
    assert.equal(c.exitCode, 1);
  });

  it("V880 — ITERATE edge shown in loopbacks", () => {
    const c = capture(() => cmdViz(["--flow", "build-verify", "--json"]));
    const out = parseOutput(c);
    assert.ok(out.loopbacks.some(lb => lb.verdict === "ITERATE"));
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. Replay data completeness (V881-V900)
// ══════════════════════════════════════════════════════════════════
describe("Replay data completeness", () => {
  it("V881 — replay data has all nodes from template", () => {
    writeFlowState(tmp, {
      flowTemplate: "build-verify",
      currentNode: "gate",
      entryNode: "build",
      totalSteps: 3,
      history: [
        { nodeId: "build", runId: "run_1" },
        { nodeId: "code-review", runId: "run_1" },
        { nodeId: "gate", runId: "run_1" },
      ],
    });
    mkdirSync(join(tmp, "nodes"), { recursive: true });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.deepEqual(out.nodes, ["build", "code-review", "test-verify", "gate"]);
  });

  it("V882 — replay data includes handshakes", () => {
    writeFlowState(tmp, {
      flowTemplate: "build-verify",
      currentNode: "code-review",
      entryNode: "build",
      totalSteps: 1,
      history: [{ nodeId: "code-review", runId: "run_1" }],
    });
    writeHandshake(tmp, "build", {
      nodeId: "build", nodeType: "build", runId: "run_1",
      status: "completed", summary: "built", timestamp: "2026-01-01T00:00:00Z",
      artifacts: [],
    });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.ok(out.handshakes.build);
    assert.equal(out.handshakes.build.nodeId, "build");
  });

  it("V883 — replay data includes run files (.md)", () => {
    writeFlowState(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 1,
      history: [{ nodeId: "gate", runId: "run_1" }],
    });
    writeHandshake(tmp, "code-review", {
      nodeId: "code-review", nodeType: "review", runId: "run_1",
      status: "completed", summary: "reviewed", timestamp: "2026-01-01T00:00:00Z",
      artifacts: [],
    });
    writeRunFile(tmp, "code-review", "run_1", "eval-security.md", "# Eval\nVERDICT: PASS\n");
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    const details = out.handshakes["code-review"].details;
    assert.ok(details.some(d => d.file === "eval-security.md"));
  });

  it("V884 — replay data includes run files (.txt)", () => {
    writeFlowState(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 1,
      history: [{ nodeId: "gate", runId: "run_1" }],
    });
    writeHandshake(tmp, "code-review", {
      nodeId: "code-review", nodeType: "review", runId: "run_1",
      status: "completed", summary: "reviewed", timestamp: "2026-01-01T00:00:00Z",
      artifacts: [],
    });
    writeRunFile(tmp, "code-review", "run_1", "notes.txt", "some notes");
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.ok(out.handshakes["code-review"].details.some(d => d.file === "notes.txt"));
  });

  it("V885 — replay data run file has content", () => {
    writeFlowState(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 1,
      history: [{ nodeId: "gate", runId: "run_1" }],
    });
    writeHandshake(tmp, "code-review", {
      nodeId: "code-review", nodeType: "review", runId: "run_1",
      status: "completed", summary: "reviewed", timestamp: "2026-01-01T00:00:00Z",
      artifacts: [],
    });
    writeRunFile(tmp, "code-review", "run_1", "eval.md", "# Content here");
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    const detail = out.handshakes["code-review"].details.find(d => d.file === "eval.md");
    assert.ok(detail.content.includes("Content here"));
  });

  it("V886 — replay data includes run name", () => {
    writeFlowState(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 1,
      history: [{ nodeId: "gate", runId: "run_1" }],
    });
    writeHandshake(tmp, "code-review", {
      nodeId: "code-review", nodeType: "review", runId: "run_1",
      status: "completed", summary: "reviewed", timestamp: "2026-01-01T00:00:00Z",
      artifacts: [],
    });
    writeRunFile(tmp, "code-review", "run_1", "eval.md", "data");
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.ok(out.handshakes["code-review"].details[0].run === "run_1");
  });

  it("V887 — empty run dir → no details for that node", () => {
    writeFlowState(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 1,
      history: [{ nodeId: "gate", runId: "run_1" }],
    });
    writeHandshake(tmp, "code-review", {
      nodeId: "code-review", nodeType: "review", runId: "run_1",
      status: "completed", summary: "reviewed", timestamp: "2026-01-01T00:00:00Z",
      artifacts: [],
    });
    mkdirSync(join(tmp, "nodes", "code-review", "run_1"), { recursive: true });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.equal(out.handshakes["code-review"].details.length, 0);
  });

  it("V888 — runs with only .js files → no details (only .md/.txt collected)", () => {
    writeFlowState(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 1,
      history: [{ nodeId: "gate", runId: "run_1" }],
    });
    writeHandshake(tmp, "code-review", {
      nodeId: "code-review", nodeType: "review", runId: "run_1",
      status: "completed", summary: "reviewed", timestamp: "2026-01-01T00:00:00Z",
      artifacts: [],
    });
    writeRunFile(tmp, "code-review", "run_1", "output.js", "console.log('hi')");
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.equal(out.handshakes["code-review"].details.length, 0);
  });

  it("V889 — multiple run directories enumerated", () => {
    writeFlowState(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 2,
      history: [
        { nodeId: "code-review", runId: "run_1" },
        { nodeId: "code-review", runId: "run_2" },
      ],
    });
    writeHandshake(tmp, "code-review", {
      nodeId: "code-review", nodeType: "review", runId: "run_2",
      status: "completed", summary: "reviewed", timestamp: "2026-01-01T00:00:00Z",
      artifacts: [],
    });
    writeRunFile(tmp, "code-review", "run_1", "eval-a.md", "round 1");
    writeRunFile(tmp, "code-review", "run_2", "eval-a.md", "round 2");
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    const details = out.handshakes["code-review"].details;
    assert.ok(details.some(d => d.run === "run_1"));
    assert.ok(details.some(d => d.run === "run_2"));
  });

  it("V890 — replay data has flowTemplate", () => {
    writeFlowState(tmp, {
      flowTemplate: "build-verify",
      currentNode: "build",
      entryNode: "build",
      totalSteps: 0,
      history: [],
    });
    mkdirSync(join(tmp, "nodes"), { recursive: true });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(parseOutput(c).flowTemplate, "build-verify");
  });

  it("V891 — replay data has entryNode", () => {
    writeFlowState(tmp, {
      flowTemplate: "build-verify",
      currentNode: "build",
      entryNode: "build",
      totalSteps: 0,
      history: [],
    });
    mkdirSync(join(tmp, "nodes"), { recursive: true });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(parseOutput(c).entryNode, "build");
  });

  it("V892 — replay data has currentNode", () => {
    writeFlowState(tmp, {
      flowTemplate: "build-verify",
      currentNode: "code-review",
      entryNode: "build",
      totalSteps: 1,
      history: [{ nodeId: "code-review", runId: "run_1" }],
    });
    mkdirSync(join(tmp, "nodes"), { recursive: true });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(parseOutput(c).currentNode, "code-review");
  });

  it("V893 — replay data has totalSteps", () => {
    writeFlowState(tmp, {
      flowTemplate: "build-verify",
      currentNode: "gate",
      entryNode: "build",
      totalSteps: 3,
      history: [],
    });
    mkdirSync(join(tmp, "nodes"), { recursive: true });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(parseOutput(c).totalSteps, 3);
  });

  it("V894 — replay data has history array", () => {
    const history = [
      { nodeId: "build", runId: "run_1" },
      { nodeId: "code-review", runId: "run_1" },
    ];
    writeFlowState(tmp, {
      flowTemplate: "build-verify",
      currentNode: "code-review",
      entryNode: "build",
      totalSteps: 2,
      history,
    });
    mkdirSync(join(tmp, "nodes"), { recursive: true });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(parseOutput(c).history.length, 2);
  });

  it("V895 — replay data has edges from template", () => {
    writeFlowState(tmp, {
      flowTemplate: "build-verify",
      currentNode: "build",
      entryNode: "build",
      totalSteps: 0,
      history: [],
    });
    mkdirSync(join(tmp, "nodes"), { recursive: true });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.ok(out.edges.gate);
    assert.equal(out.edges.gate.FAIL, "build");
  });

  it("V896 — replay data has loopbacks", () => {
    writeFlowState(tmp, {
      flowTemplate: "build-verify",
      currentNode: "build",
      entryNode: "build",
      totalSteps: 0,
      history: [],
    });
    mkdirSync(join(tmp, "nodes"), { recursive: true });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.ok(out.loopbacks.length > 0);
    assert.ok(out.loopbacks.some(lb => lb.gate === "gate"));
  });

  it("V897 — missing flow-state.json → exits with error", () => {
    mkdirSync(tmp, { recursive: true });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(c.exitCode, 1);
  });

  it("V898 — invalid JSON in flow-state.json → exits with error", () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "flow-state.json"), "NOT JSON{{{");
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(c.exitCode, 1);
  });

  it("V899 — unknown flowTemplate in state → exits with error", () => {
    writeFlowState(tmp, {
      flowTemplate: "does-not-exist",
      currentNode: "x",
      entryNode: "x",
      totalSteps: 0,
      history: [],
    });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(c.exitCode, 1);
  });

  it("V900 — nodes without handshakes have empty handshake entry", () => {
    writeFlowState(tmp, {
      flowTemplate: "build-verify",
      currentNode: "build",
      entryNode: "build",
      totalSteps: 0,
      history: [],
    });
    mkdirSync(join(tmp, "nodes"), { recursive: true });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    // Nodes without handshake files should not appear in handshakes map
    assert.equal(out.handshakes.build, undefined);
  });
});
