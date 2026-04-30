// tests/verify-flow-state-machine.test.mjs — V351-V550 (200 tests)
// Deep state machine verification for flow-commands.mjs
// Uses node:test + node:assert/strict, temp directories for all file I/O.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Console/exit capture ────────────────────────────────────────

let tmpDir;
let captured;
let origLog, origError, origExit;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-sm-"));
  captured = { stdout: [], stderr: [], exitCode: null };
  origLog = console.log;
  origError = console.error;
  origExit = process.exit;
  console.log = (...a) => captured.stdout.push(a.join(" "));
  console.error = (...a) => captured.stderr.push(a.join(" "));
  process.exit = (code) => { captured.exitCode = code; throw new Error(`EXIT_${code}`); };
}

function teardown() {
  console.log = origLog;
  console.error = origError;
  process.exit = origExit;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

function out() {
  if (captured.stdout.length === 0) return null;
  return JSON.parse(captured.stdout[captured.stdout.length - 1]);
}

function lastOut() {
  return captured.stdout.length > 0
    ? JSON.parse(captured.stdout[captured.stdout.length - 1])
    : null;
}

// ── Module under test ───────────────────────────────────────────

const { cmdRoute, cmdInit, cmdTransition, cmdValidate, cmdValidateChain } =
  await import(path.join(process.cwd(), "bin/lib/flow-commands.mjs"));

import { FLOW_TEMPLATES } from "../bin/lib/flow-templates.mjs";

// ── Helpers ─────────────────────────────────────────────────────

function initFlow(flow, entry, dir) {
  dir = dir || tmpDir;
  const args = ["--flow", flow, "--dir", dir];
  if (entry) args.push("--entry", entry);
  captured.stdout = [];
  captured.stderr = [];
  cmdInit(args);
}

function transition(from, to, verdict, flow, dir) {
  dir = dir || tmpDir;
  captured.stdout = [];
  captured.stderr = [];
  cmdTransition(["--from", from, "--to", to, "--verdict", verdict, "--flow", flow, "--dir", dir]);
  return lastOut();
}

function route(node, verdict, flow) {
  captured.stdout = [];
  captured.stderr = [];
  cmdRoute(["--node", node, "--verdict", verdict, "--flow", flow]);
  return lastOut();
}

function readState(dir) {
  dir = dir || tmpDir;
  return JSON.parse(fs.readFileSync(path.join(dir, "flow-state.json"), "utf8"));
}

// ══════════════════════════════════════════════════════════════════
// 1. EXHAUSTIVE ROUTE TABLE (V351-V410, 60 tests)
// ══════════════════════════════════════════════════════════════════

describe("1 — Exhaustive route table", () => {
  beforeEach(setup);
  afterEach(teardown);

  const VERDICTS = ["PASS", "FAIL", "ITERATE", "BLOCKED"];
  let vNum = 351;

  for (const [tName, tmpl] of Object.entries(FLOW_TEMPLATES)) {
    for (const node of tmpl.nodes) {
      const edges = tmpl.edges[node] || {};
      for (const verdict of VERDICTS) {
        const v = vNum++;
        if (v > 410) break; // cap at 60

        if (verdict in edges) {
          // Edge exists — should return valid:true with correct next
          const expected = edges[verdict];
          it(`V${v} — route ${tName}/${node}/${verdict} → ${expected ?? "null (terminal)"}`, () => {
            const r = route(node, verdict, tName);
            assert.equal(r.valid, true, `expected valid=true for ${tName}/${node}/${verdict}`);
            assert.equal(r.next, expected);
          });
        } else {
          // Edge missing — should return valid:false
          it(`V${v} — route ${tName}/${node}/${verdict} → error (no edge)`, () => {
            const r = route(node, verdict, tName);
            assert.equal(r.valid, false);
            assert.ok(r.error);
          });
        }
      }
    }
  }
});

// ══════════════════════════════════════════════════════════════════
// 2. STATE INVARIANTS ACROSS TRANSITIONS (V411-V450, 40 tests)
// ══════════════════════════════════════════════════════════════════

describe("2 — State invariants across transitions", () => {
  beforeEach(setup);
  afterEach(teardown);

  // Helper: init + one transition, return before/after state
  function initAndTransition(flow, from, to, verdict) {
    initFlow(flow, from);
    const s0 = readState();
    const r = transition(from, to, verdict, flow);
    const s1 = readState();
    return { s0, s1, r };
  }

  it("V411 — totalSteps increments by 1 after one transition (legacy-linear)", () => {
    const { s0, s1 } = initAndTransition("legacy-linear", "design", "plan", "PASS");
    assert.equal(s1.totalSteps, s0.totalSteps + 1);
  });

  it("V412 — history length increments by 1 (legacy-linear)", () => {
    const { s0, s1 } = initAndTransition("legacy-linear", "design", "plan", "PASS");
    assert.equal(s1.history.length, s0.history.length + 1);
  });

  it("V413 — currentNode equals 'to' node (legacy-linear)", () => {
    const { s1 } = initAndTransition("legacy-linear", "design", "plan", "PASS");
    assert.equal(s1.currentNode, "plan");
  });

  it("V414 — edgeCounts[from→to] increments (legacy-linear)", () => {
    const { s1 } = initAndTransition("legacy-linear", "design", "plan", "PASS");
    assert.equal(s1.edgeCounts["design→plan"], 1);
  });

  it("V415 — flow-state.json is valid JSON after transition", () => {
    initAndTransition("legacy-linear", "design", "plan", "PASS");
    const raw = fs.readFileSync(path.join(tmpDir, "flow-state.json"), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
  });

  it("V416 — totalSteps increments by 1 (build-verify)", () => {
    const { s0, s1 } = initAndTransition("build-verify", "build", "code-review", "PASS");
    assert.equal(s1.totalSteps, s0.totalSteps + 1);
  });

  it("V417 — history length increments by 1 (build-verify)", () => {
    const { s0, s1 } = initAndTransition("build-verify", "build", "code-review", "PASS");
    assert.equal(s1.history.length, s0.history.length + 1);
  });

  it("V418 — currentNode equals 'to' (build-verify)", () => {
    const { s1 } = initAndTransition("build-verify", "build", "code-review", "PASS");
    assert.equal(s1.currentNode, "code-review");
  });

  it("V419 — edgeCounts correct (build-verify)", () => {
    const { s1 } = initAndTransition("build-verify", "build", "code-review", "PASS");
    assert.equal(s1.edgeCounts["build→code-review"], 1);
  });

  it("V420 — flow-state.json valid after build-verify transition", () => {
    initAndTransition("build-verify", "build", "code-review", "PASS");
    assert.doesNotThrow(() => readState());
  });

  it("V421 — totalSteps increments (full-stack)", () => {
    const { s0, s1 } = initAndTransition("full-stack", "discuss", "build", "PASS");
    assert.equal(s1.totalSteps, s0.totalSteps + 1);
  });

  it("V422 — history length increments (full-stack)", () => {
    const { s0, s1 } = initAndTransition("full-stack", "discuss", "build", "PASS");
    assert.equal(s1.history.length, s0.history.length + 1);
  });

  it("V423 — currentNode updated (full-stack)", () => {
    const { s1 } = initAndTransition("full-stack", "discuss", "build", "PASS");
    assert.equal(s1.currentNode, "build");
  });

  it("V424 — edgeCounts correct (full-stack)", () => {
    const { s1 } = initAndTransition("full-stack", "discuss", "build", "PASS");
    assert.equal(s1.edgeCounts["discuss→build"], 1);
  });

  it("V425 — two sequential transitions: totalSteps = 2", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    transition("plan", "build", "PASS", "legacy-linear");
    const s = readState();
    assert.equal(s.totalSteps, 2);
  });

  it("V426 — two sequential: history length = 2", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    transition("plan", "build", "PASS", "legacy-linear");
    assert.equal(readState().history.length, 2);
  });

  it("V427 — two sequential: currentNode = build", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    transition("plan", "build", "PASS", "legacy-linear");
    assert.equal(readState().currentNode, "build");
  });

  it("V428 — two sequential: both edge counts = 1", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    transition("plan", "build", "PASS", "legacy-linear");
    const s = readState();
    assert.equal(s.edgeCounts["design→plan"], 1);
    assert.equal(s.edgeCounts["plan→build"], 1);
  });

  it("V429 — loopback edge increments edgeCounts correctly", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    const s = readState();
    assert.equal(s.edgeCounts["gate→build"], 1);
  });

  it("V430 — loopback: totalSteps = 4", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    assert.equal(readState().totalSteps, 4);
  });

  it("V431 — loopback: currentNode = build after gate→build", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    assert.equal(readState().currentNode, "build");
  });

  it("V432 — history records correct nodeIds in order", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    transition("plan", "build", "PASS", "legacy-linear");
    const h = readState().history.map((e) => e.nodeId);
    assert.deepEqual(h, ["plan", "build"]);
  });

  it("V433 — history entries have timestamps", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    const entry = readState().history[0];
    assert.ok(entry.timestamp);
    assert.ok(!isNaN(Date.parse(entry.timestamp)));
  });

  it("V434 — history entries have runIds", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    assert.ok(readState().history[0].runId.startsWith("run_"));
  });

  it("V435 — flowTemplate preserved after transition", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(readState().flowTemplate, "legacy-linear");
  });

  it("V436 — version preserved after transition", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(readState().version, "1.0");
  });

  it("V437 — node run directory created for target node", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    const r = lastOut();
    assert.ok(fs.existsSync(path.join(tmpDir, "nodes", "plan", r.runId)));
  });

  it("V438 — pre-release invariants: totalSteps after 2 transitions", () => {
    initFlow("pre-release", "acceptance");
    transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    transition("gate-acceptance", "audit", "PASS", "pre-release");
    assert.equal(readState().totalSteps, 2);
  });

  it("V439 — quick-review invariants: currentNode after PASS", () => {
    initFlow("quick-review", "code-review");
    transition("code-review", "gate", "PASS", "quick-review");
    assert.equal(readState().currentNode, "gate");
  });

  it("V440 — multiple loopbacks accumulate edgeCounts", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "ITERATE", "build-verify");
    const s = readState();
    assert.equal(s.edgeCounts["gate→build"], 2);
  });

  it("V441 — entryNode stays unchanged after transitions", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    transition("plan", "build", "PASS", "legacy-linear");
    assert.equal(readState().entryNode, "design");
  });

  it("V442 — maxTotalSteps preserved in state", () => {
    initFlow("legacy-linear", "design");
    assert.equal(readState().maxTotalSteps, 20);
  });

  it("V443 — maxLoopsPerEdge preserved in state", () => {
    initFlow("legacy-linear", "design");
    assert.equal(readState().maxLoopsPerEdge, 3);
  });

  it("V444 — maxNodeReentry preserved in state", () => {
    initFlow("legacy-linear", "design");
    assert.equal(readState().maxNodeReentry, 5);
  });

  it("V445 — full-stack limits: maxTotalSteps=30", () => {
    initFlow("full-stack", "discuss");
    assert.equal(readState().maxTotalSteps, 30);
  });

  it("V446 — quick-review limits: maxTotalSteps=10", () => {
    initFlow("quick-review", "code-review");
    assert.equal(readState().maxTotalSteps, 10);
  });

  it("V447 — edgeCounts empty object on init", () => {
    initFlow("legacy-linear", "design");
    assert.deepEqual(readState().edgeCounts, {});
  });

  it("V448 — history empty array on init", () => {
    initFlow("legacy-linear", "design");
    assert.deepEqual(readState().history, []);
  });

  it("V449 — totalSteps 0 on init", () => {
    initFlow("legacy-linear", "design");
    assert.equal(readState().totalSteps, 0);
  });

  it("V450 — three transitions: all edgeCounts accurate", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    transition("plan", "build", "PASS", "legacy-linear");
    transition("build", "evaluate", "PASS", "legacy-linear");
    const s = readState();
    assert.equal(s.edgeCounts["design→plan"], 1);
    assert.equal(s.edgeCounts["plan→build"], 1);
    assert.equal(s.edgeCounts["build→evaluate"], 1);
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. LIMIT EXHAUSTION (V451-V480, 30 tests)
// ══════════════════════════════════════════════════════════════════

describe("3 — Limit exhaustion", () => {
  beforeEach(setup);
  afterEach(teardown);

  // Helper: run a full loop in build-verify: build→cr→tv→gate→build
  function loopBuildVerify(flow) {
    flow = flow || "build-verify";
    transition("build", "code-review", "PASS", flow);
    transition("code-review", "test-verify", "PASS", flow);
    transition("test-verify", "gate", "PASS", flow);
    transition("gate", "build", "FAIL", flow);
  }

  it("V451 — maxLoopsPerEdge: 3rd traversal of gate→build is blocked (limit=3, count already 3)", () => {
    initFlow("build-verify", "build");
    // Manually set edgeCounts to exactly the limit
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.edgeCounts = { "gate→build": 3 };
    s.currentNode = "gate";
    s.totalSteps = 6;
    s.history = [{ nodeId: "gate", runId: "run_1", timestamp: new Date().toISOString() }];
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("gate", "build", "FAIL", "build-verify");
    assert.equal(r.allowed, false);
    assert.ok(r.reason.includes("maxLoopsPerEdge"));
  });

  it("V452 — maxLoopsPerEdge: the 2nd loop succeeds (edge gate→build)", () => {
    initFlow("build-verify", "build");
    loopBuildVerify(); // count = 1
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    const r = transition("gate", "build", "FAIL", "build-verify");
    assert.equal(r.allowed, true);
  });

  it("V453 — maxLoopsPerEdge: 1st loop succeeds", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    const r = transition("gate", "build", "FAIL", "build-verify");
    assert.equal(r.allowed, true);
  });

  it("V454 — maxTotalSteps: N-1 transition succeeds (quick-review, limit=10)", () => {
    // quick-review has limit 10. We'll create artificial state near limit.
    initFlow("quick-review", "code-review");
    // Manually set totalSteps to 8
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.totalSteps = 9;
    s.currentNode = "code-review";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("code-review", "gate", "PASS", "quick-review");
    assert.equal(r.allowed, true);
  });

  it("V455 — maxTotalSteps: N-th transition fails (quick-review, limit=10)", () => {
    initFlow("quick-review", "code-review");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.totalSteps = 10;
    s.currentNode = "code-review";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("code-review", "gate", "PASS", "quick-review");
    assert.equal(r.allowed, false);
    assert.ok(r.reason.includes("maxTotalSteps"));
  });

  it("V456 — maxTotalSteps boundary: exactly at limit", () => {
    initFlow("legacy-linear", "design");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.totalSteps = 20; // at limit
    s.currentNode = "design";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, false);
  });

  it("V457 — maxTotalSteps boundary: one below limit", () => {
    initFlow("legacy-linear", "design");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.totalSteps = 19;
    s.currentNode = "design";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, true);
  });

  it("V458 — maxNodeReentry: N-1 entries succeed (limit=5)", () => {
    initFlow("build-verify", "build");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    // Pre-fill history with 4 entries to 'build'
    s.history = Array.from({ length: 4 }, (_, i) => ({
      nodeId: "build", runId: `run_${i + 1}`, timestamp: new Date().toISOString(),
    }));
    s.currentNode = "gate";
    s.totalSteps = 8;
    s.edgeCounts = { "gate→build": 1 };
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("gate", "build", "FAIL", "build-verify");
    assert.equal(r.allowed, true);
  });

  it("V459 — maxNodeReentry: N-th entry fails (limit=5)", () => {
    initFlow("build-verify", "build");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.history = Array.from({ length: 5 }, (_, i) => ({
      nodeId: "build", runId: `run_${i + 1}`, timestamp: new Date().toISOString(),
    }));
    s.currentNode = "gate";
    s.totalSteps = 10;
    s.edgeCounts = { "gate→build": 1 };
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("gate", "build", "FAIL", "build-verify");
    assert.equal(r.allowed, false);
    assert.ok(r.reason.includes("maxNodeReentry"));
  });

  it("V460 — maxLoopsPerEdge with ITERATE verdict at limit", () => {
    initFlow("build-verify", "build");
    // Manually set count to exactly 3 (the limit)
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.edgeCounts = { "gate→build": 3 };
    s.currentNode = "gate";
    s.totalSteps = 6;
    s.history = [{ nodeId: "gate", runId: "run_1", timestamp: new Date().toISOString() }];
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("gate", "build", "ITERATE", "build-verify");
    assert.equal(r.allowed, false);
    assert.ok(r.reason.includes("maxLoopsPerEdge"));
  });

  it("V461 — full-stack maxTotalSteps = 30", () => {
    initFlow("full-stack", "discuss");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.totalSteps = 30;
    s.currentNode = "discuss";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("discuss", "build", "PASS", "full-stack");
    assert.equal(r.allowed, false);
  });

  it("V462 — full-stack: 29 steps, still allowed", () => {
    initFlow("full-stack", "discuss");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.totalSteps = 29;
    s.currentNode = "discuss";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("discuss", "build", "PASS", "full-stack");
    assert.equal(r.allowed, true);
  });

  it("V463 — pre-release maxLoopsPerEdge exhaustion", () => {
    initFlow("pre-release", "acceptance");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.edgeCounts = { "gate-acceptance→acceptance": 3 };
    s.currentNode = "gate-acceptance";
    s.totalSteps = 5;
    s.history = [{ nodeId: "gate-acceptance", runId: "run_1", timestamp: new Date().toISOString() }];
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("gate-acceptance", "acceptance", "FAIL", "pre-release");
    assert.equal(r.allowed, false);
  });

  it("V464 — pre-release: 2 loops still allowed", () => {
    initFlow("pre-release", "acceptance");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.edgeCounts = { "gate-acceptance→acceptance": 2 };
    s.currentNode = "gate-acceptance";
    s.totalSteps = 5;
    s.history = [{ nodeId: "gate-acceptance", runId: "run_1", timestamp: new Date().toISOString() }];
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("gate-acceptance", "acceptance", "FAIL", "pre-release");
    assert.equal(r.allowed, true);
  });

  it("V465 — maxNodeReentry: 0 prior entries means reentry is allowed", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    const r = transition("gate", "build", "FAIL", "build-verify");
    // build was the initial node (no history entry for it via init), 1 entry will come from this transition
    assert.equal(r.allowed, true);
  });

  it("V466 — error message includes limit value for maxTotalSteps", () => {
    initFlow("quick-review", "code-review");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.totalSteps = 10;
    s.currentNode = "code-review";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("code-review", "gate", "PASS", "quick-review");
    assert.ok(r.reason.includes("10"));
  });

  it("V467 — error message includes limit value for maxLoopsPerEdge", () => {
    initFlow("build-verify", "build");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.edgeCounts = { "build→code-review": 3 };
    s.currentNode = "build";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("build", "code-review", "PASS", "build-verify");
    assert.ok(r.reason.includes("3"));
  });

  it("V468 — error message includes limit value for maxNodeReentry", () => {
    initFlow("build-verify", "build");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.history = Array.from({ length: 5 }, (_, i) => ({
      nodeId: "build", runId: `run_${i}`, timestamp: new Date().toISOString(),
    }));
    s.currentNode = "gate";
    s.totalSteps = 6;
    s.edgeCounts = {};
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("gate", "build", "FAIL", "build-verify");
    assert.ok(r.reason.includes("5"));
  });

  it("V469 — maxLoopsPerEdge: different edges tracked independently", () => {
    initFlow("build-verify", "build");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.edgeCounts = { "gate→build": 3, "build→code-review": 0 };
    s.currentNode = "build";
    s.totalSteps = 5;
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("build", "code-review", "PASS", "build-verify");
    assert.equal(r.allowed, true);
  });

  it("V470 — combined limits: nodeReentry hit before totalSteps", () => {
    initFlow("legacy-linear", "design");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.history = Array.from({ length: 5 }, (_, i) => ({
      nodeId: "plan", runId: `run_${i}`, timestamp: new Date().toISOString(),
    }));
    s.currentNode = "design";
    s.totalSteps = 6;
    s.edgeCounts = {};
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, false);
    assert.ok(r.reason.includes("maxNodeReentry"));
  });

  it("V471 — combined limits: edgeLoop hit before totalSteps", () => {
    initFlow("legacy-linear", "design");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.edgeCounts = { "design→plan": 3 };
    s.currentNode = "design";
    s.totalSteps = 5;
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, false);
    assert.ok(r.reason.includes("maxLoopsPerEdge"));
  });

  it("V472 — totalSteps check uses >= comparison", () => {
    initFlow("quick-review", "code-review");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.totalSteps = 10;
    s.currentNode = "code-review";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("code-review", "gate", "PASS", "quick-review");
    assert.equal(r.allowed, false);
  });

  it("V473 — edgeCount check uses >= comparison", () => {
    initFlow("legacy-linear", "design");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.edgeCounts = { "design→plan": 3 };
    s.currentNode = "design";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, false);
  });

  it("V474 — nodeReentry check uses >= comparison", () => {
    initFlow("legacy-linear", "design");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.history = Array.from({ length: 5 }, (_, i) => ({
      nodeId: "plan", runId: `run_${i}`, timestamp: new Date().toISOString(),
    }));
    s.currentNode = "design";
    s.totalSteps = 6;
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, false);
  });

  it("V475 — pre-release: maxTotalSteps = 20, step 19 ok", () => {
    initFlow("pre-release", "acceptance");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.totalSteps = 19;
    s.currentNode = "acceptance";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    assert.equal(r.allowed, true);
  });

  it("V476 — pre-release: maxTotalSteps = 20, step 20 blocked", () => {
    initFlow("pre-release", "acceptance");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.totalSteps = 20;
    s.currentNode = "acceptance";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    assert.equal(r.allowed, false);
  });

  it("V477 — build-verify: maxTotalSteps = 20", () => {
    initFlow("build-verify", "build");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.totalSteps = 20;
    s.currentNode = "build";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("build", "code-review", "PASS", "build-verify");
    assert.equal(r.allowed, false);
  });

  it("V478 — edge counts for ITERATE and FAIL share the same edge key", () => {
    // gate→build is the target for both FAIL and ITERATE in build-verify
    initFlow("build-verify", "build");
    loopBuildVerify(); // FAIL -> gate→build count=1
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "ITERATE", "build-verify"); // gate→build count=2
    const s = readState();
    assert.equal(s.edgeCounts["gate→build"], 2);
  });

  it("V479 — limit values are read from state, not template (overridden state)", () => {
    initFlow("quick-review", "code-review");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.maxTotalSteps = 2; // override to 2 (template says 10)
    s.currentNode = "code-review";
    s.totalSteps = 2;
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("code-review", "gate", "PASS", "quick-review");
    assert.equal(r.allowed, false);
  });

  it("V480 — overridden maxLoopsPerEdge in state respected", () => {
    initFlow("legacy-linear", "design");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.maxLoopsPerEdge = 1;
    s.edgeCounts = { "design→plan": 1 };
    s.currentNode = "design";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, false);
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. CONCURRENT STATE (V481-V500, 20 tests)
// ══════════════════════════════════════════════════════════════════

describe("4 — Concurrent state", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("V481 — two rapid transitions succeed when sequential", () => {
    initFlow("legacy-linear", "design");
    const r1 = transition("design", "plan", "PASS", "legacy-linear");
    const r2 = transition("plan", "build", "PASS", "legacy-linear");
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, true);
  });

  it("V482 — transition from wrong currentNode fails", () => {
    initFlow("legacy-linear", "design");
    const r = transition("plan", "build", "PASS", "legacy-linear");
    assert.equal(r.allowed, false);
    assert.ok(r.reason.includes("currentNode"));
  });

  it("V483 — state file modified externally: totalSteps incremented", () => {
    initFlow("legacy-linear", "design");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.totalSteps = 15;
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, true);
    assert.equal(readState().totalSteps, 16);
  });

  it("V484 — state file modified externally: currentNode changed", () => {
    initFlow("legacy-linear", "design");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.currentNode = "plan";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, false);
  });

  it("V485 — state file deleted mid-flow: transition creates new state", () => {
    initFlow("legacy-linear", "design");
    fs.unlinkSync(path.join(tmpDir, "flow-state.json"));
    // Transition without existing state file — should create fresh state
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, true);
    assert.ok(fs.existsSync(path.join(tmpDir, "flow-state.json")));
  });

  it("V486 — state file deleted: new state has totalSteps=1 after transition", () => {
    initFlow("legacy-linear", "design");
    fs.unlinkSync(path.join(tmpDir, "flow-state.json"));
    transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(readState().totalSteps, 1);
  });

  it("V487 — state file with corrupted JSON: transition to non-existent state file dir", () => {
    const subDir = path.join(tmpDir, "sub");
    // No init — transition creates directory
    const r = transition("design", "plan", "PASS", "legacy-linear", subDir);
    assert.equal(r.allowed, true);
  });

  it("V488 — rapid same-node transitions: first succeeds, second fails from wrong node", () => {
    initFlow("build-verify", "build");
    const r1 = transition("build", "code-review", "PASS", "build-verify");
    assert.equal(r1.allowed, true);
    // Try same transition again (build→code-review) but currentNode is now code-review
    const r2 = transition("build", "code-review", "PASS", "build-verify");
    assert.equal(r2.allowed, false);
  });

  it("V489 — external edgeCounts modification respected", () => {
    initFlow("legacy-linear", "design");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.edgeCounts["design→plan"] = 2;
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, true);
    assert.equal(readState().edgeCounts["design→plan"], 3);
  });

  it("V490 — external edgeCounts at limit: transition blocked", () => {
    initFlow("legacy-linear", "design");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.edgeCounts["design→plan"] = 3;
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, false);
  });

  it("V491 — transition with stale edgeCounts (reset externally to 0)", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.edgeCounts = {};
    s.currentNode = "code-review";
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("code-review", "test-verify", "PASS", "build-verify");
    assert.equal(r.allowed, true);
    assert.equal(readState().edgeCounts["code-review→test-verify"], 1);
  });

  it("V492 — external history modification: added fake entries", () => {
    initFlow("legacy-linear", "design");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.history = Array.from({ length: 4 }, (_, i) => ({
      nodeId: "plan", runId: `run_${i}`, timestamp: new Date().toISOString(),
    }));
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, true);
    assert.equal(readState().history.length, 5);
  });

  it("V493 — external history: 5 entries for target node blocks reentry", () => {
    initFlow("legacy-linear", "design");
    const sp = path.join(tmpDir, "flow-state.json");
    const s = readState();
    s.history = Array.from({ length: 5 }, (_, i) => ({
      nodeId: "plan", runId: `run_${i}`, timestamp: new Date().toISOString(),
    }));
    fs.writeFileSync(sp, JSON.stringify(s));
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, false);
  });

  it("V494 — nodes directory missing: transition recreates it", () => {
    initFlow("legacy-linear", "design");
    fs.rmSync(path.join(tmpDir, "nodes"), { recursive: true, force: true });
    const r = transition("design", "plan", "PASS", "legacy-linear");
    assert.equal(r.allowed, true);
    assert.ok(fs.existsSync(path.join(tmpDir, "nodes", "plan")));
  });

  it("V495 — init on existing flow-state.json fails", () => {
    initFlow("legacy-linear", "design");
    captured.stdout = [];
    cmdInit(["--flow", "legacy-linear", "--dir", tmpDir]);
    const r = lastOut();
    assert.equal(r.created, false);
    assert.ok(r.error.includes("already exists"));
  });

  it("V496 — init with unknown template fails", () => {
    cmdInit(["--flow", "nonexistent", "--dir", tmpDir]);
    const r = lastOut();
    assert.equal(r.created, false);
    assert.ok(r.error.includes("unknown"));
  });

  it("V497 — init with invalid entry node fails", () => {
    cmdInit(["--flow", "legacy-linear", "--entry", "bogus", "--dir", tmpDir]);
    const r = lastOut();
    assert.equal(r.created, false);
    assert.ok(r.error.includes("not in flow"));
  });

  it("V498 — transition with unknown template returns error", () => {
    const r = transition("a", "b", "PASS", "no-such-flow");
    assert.equal(r.allowed, false);
    assert.ok(r.reason.includes("unknown"));
  });

  it("V499 — transition with invalid edge returns error", () => {
    initFlow("legacy-linear", "design");
    const r = transition("design", "evaluate", "PASS", "legacy-linear");
    assert.equal(r.allowed, false);
    assert.ok(r.reason.includes("not in flow"));
  });

  it("V500 — transition with wrong verdict for edge returns error", () => {
    initFlow("legacy-linear", "design");
    const r = transition("design", "plan", "FAIL", "legacy-linear");
    assert.equal(r.allowed, false);
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. FULL PIPELINE TRAVERSALS (V501-V530, 30 tests)
// ══════════════════════════════════════════════════════════════════

describe("5 — Full pipeline traversals", () => {
  beforeEach(setup);
  afterEach(teardown);

  // ── legacy-linear ──

  it("V501 — legacy-linear happy path: design→plan→build→evaluate→deliver", () => {
    initFlow("legacy-linear", "design");
    assert.equal(transition("design", "plan", "PASS", "legacy-linear").allowed, true);
    assert.equal(transition("plan", "build", "PASS", "legacy-linear").allowed, true);
    assert.equal(transition("build", "evaluate", "PASS", "legacy-linear").allowed, true);
    assert.equal(transition("evaluate", "deliver", "PASS", "legacy-linear").allowed, true);
    assert.equal(readState().currentNode, "deliver");
  });

  it("V502 — legacy-linear: evaluate FAIL loops back to build", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    transition("plan", "build", "PASS", "legacy-linear");
    transition("build", "evaluate", "PASS", "legacy-linear");
    const r = transition("evaluate", "build", "FAIL", "legacy-linear");
    assert.equal(r.allowed, true);
    assert.equal(readState().currentNode, "build");
  });

  it("V503 — legacy-linear: evaluate ITERATE loops back to build", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    transition("plan", "build", "PASS", "legacy-linear");
    transition("build", "evaluate", "PASS", "legacy-linear");
    const r = transition("evaluate", "build", "ITERATE", "legacy-linear");
    assert.equal(r.allowed, true);
    assert.equal(readState().currentNode, "build");
  });

  it("V504 — legacy-linear: FAIL then recover to deliver", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    transition("plan", "build", "PASS", "legacy-linear");
    transition("build", "evaluate", "PASS", "legacy-linear");
    transition("evaluate", "build", "FAIL", "legacy-linear");
    transition("build", "evaluate", "PASS", "legacy-linear");
    transition("evaluate", "deliver", "PASS", "legacy-linear");
    assert.equal(readState().currentNode, "deliver");
    assert.equal(readState().totalSteps, 6);
  });

  it("V505 — legacy-linear: terminal node (deliver PASS → null)", () => {
    const r = route("deliver", "PASS", "legacy-linear");
    assert.equal(r.valid, true);
    assert.equal(r.next, null);
  });

  // ── quick-review ──

  it("V506 — quick-review happy path: code-review→gate", () => {
    initFlow("quick-review", "code-review");
    assert.equal(transition("code-review", "gate", "PASS", "quick-review").allowed, true);
    assert.equal(readState().currentNode, "gate");
  });

  it("V507 — quick-review: gate PASS is terminal (next=null)", () => {
    const r = route("gate", "PASS", "quick-review");
    assert.equal(r.valid, true);
    assert.equal(r.next, null);
  });

  it("V508 — quick-review: full traversal totalSteps = 1", () => {
    initFlow("quick-review", "code-review");
    transition("code-review", "gate", "PASS", "quick-review");
    assert.equal(readState().totalSteps, 1);
  });

  // ── build-verify ──

  it("V509 — build-verify happy path: build→cr→tv→gate (PASS=null)", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    assert.equal(readState().currentNode, "gate");
  });

  it("V510 — build-verify: gate FAIL → build (loopback)", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    const r = transition("gate", "build", "FAIL", "build-verify");
    assert.equal(r.allowed, true);
    assert.equal(readState().currentNode, "build");
  });

  it("V511 — build-verify: gate ITERATE → build", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    const r = transition("gate", "build", "ITERATE", "build-verify");
    assert.equal(r.allowed, true);
  });

  it("V512 — build-verify: full loop + pass", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    assert.equal(readState().currentNode, "gate");
    assert.equal(readState().totalSteps, 7);
  });

  // ── full-stack ──

  it("V513 — full-stack happy path all PASS", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "acceptance", "PASS", "full-stack");
    transition("acceptance", "gate-acceptance", "PASS", "full-stack");
    transition("gate-acceptance", "audit", "PASS", "full-stack");
    transition("audit", "gate-audit", "PASS", "full-stack");
    transition("gate-audit", "e2e-user", "PASS", "full-stack");
    transition("e2e-user", "gate-e2e", "PASS", "full-stack");
    transition("gate-e2e", "post-launch-sim", "PASS", "full-stack");
    transition("post-launch-sim", "gate-final", "PASS", "full-stack");
    assert.equal(readState().currentNode, "gate-final");
    assert.equal(readState().totalSteps, 12);
  });

  it("V514 — full-stack: gate-test FAIL → discuss", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    const r = transition("gate-test", "discuss", "FAIL", "full-stack");
    assert.equal(r.allowed, true);
    assert.equal(readState().currentNode, "discuss");
  });

  it("V515 — full-stack: gate-acceptance FAIL → discuss", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "acceptance", "PASS", "full-stack");
    transition("acceptance", "gate-acceptance", "PASS", "full-stack");
    const r = transition("gate-acceptance", "discuss", "FAIL", "full-stack");
    assert.equal(r.allowed, true);
    assert.equal(readState().currentNode, "discuss");
  });

  it("V516 — full-stack: gate-audit ITERATE → discuss", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "acceptance", "PASS", "full-stack");
    transition("acceptance", "gate-acceptance", "PASS", "full-stack");
    transition("gate-acceptance", "audit", "PASS", "full-stack");
    transition("audit", "gate-audit", "PASS", "full-stack");
    const r = transition("gate-audit", "discuss", "ITERATE", "full-stack");
    assert.equal(r.allowed, true);
  });

  it("V517 — full-stack: gate-e2e FAIL → discuss", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "acceptance", "PASS", "full-stack");
    transition("acceptance", "gate-acceptance", "PASS", "full-stack");
    transition("gate-acceptance", "audit", "PASS", "full-stack");
    transition("audit", "gate-audit", "PASS", "full-stack");
    transition("gate-audit", "e2e-user", "PASS", "full-stack");
    transition("e2e-user", "gate-e2e", "PASS", "full-stack");
    const r = transition("gate-e2e", "discuss", "FAIL", "full-stack");
    assert.equal(r.allowed, true);
  });

  it("V518 — full-stack: gate-final FAIL → discuss", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "acceptance", "PASS", "full-stack");
    transition("acceptance", "gate-acceptance", "PASS", "full-stack");
    transition("gate-acceptance", "audit", "PASS", "full-stack");
    transition("audit", "gate-audit", "PASS", "full-stack");
    transition("gate-audit", "e2e-user", "PASS", "full-stack");
    transition("e2e-user", "gate-e2e", "PASS", "full-stack");
    transition("gate-e2e", "post-launch-sim", "PASS", "full-stack");
    transition("post-launch-sim", "gate-final", "PASS", "full-stack");
    const r = transition("gate-final", "discuss", "FAIL", "full-stack");
    assert.equal(r.allowed, true);
    assert.equal(readState().currentNode, "discuss");
  });

  it("V519 — full-stack: gate-final ITERATE → discuss", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "acceptance", "PASS", "full-stack");
    transition("acceptance", "gate-acceptance", "PASS", "full-stack");
    transition("gate-acceptance", "audit", "PASS", "full-stack");
    transition("audit", "gate-audit", "PASS", "full-stack");
    transition("gate-audit", "e2e-user", "PASS", "full-stack");
    transition("e2e-user", "gate-e2e", "PASS", "full-stack");
    transition("gate-e2e", "post-launch-sim", "PASS", "full-stack");
    transition("post-launch-sim", "gate-final", "PASS", "full-stack");
    const r = transition("gate-final", "discuss", "ITERATE", "full-stack");
    assert.equal(r.allowed, true);
  });

  // ── pre-release ──

  it("V520 — pre-release happy path all PASS", () => {
    initFlow("pre-release", "acceptance");
    transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    transition("gate-acceptance", "audit", "PASS", "pre-release");
    transition("audit", "gate-audit", "PASS", "pre-release");
    transition("gate-audit", "e2e-user", "PASS", "pre-release");
    transition("e2e-user", "gate-e2e", "PASS", "pre-release");
    assert.equal(readState().currentNode, "gate-e2e");
    assert.equal(readState().totalSteps, 5);
  });

  it("V521 — pre-release: gate-acceptance FAIL → acceptance", () => {
    initFlow("pre-release", "acceptance");
    transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    const r = transition("gate-acceptance", "acceptance", "FAIL", "pre-release");
    assert.equal(r.allowed, true);
    assert.equal(readState().currentNode, "acceptance");
  });

  it("V522 — pre-release: gate-audit FAIL → acceptance", () => {
    initFlow("pre-release", "acceptance");
    transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    transition("gate-acceptance", "audit", "PASS", "pre-release");
    transition("audit", "gate-audit", "PASS", "pre-release");
    const r = transition("gate-audit", "acceptance", "FAIL", "pre-release");
    assert.equal(r.allowed, true);
  });

  it("V523 — pre-release: gate-e2e ITERATE → acceptance", () => {
    initFlow("pre-release", "acceptance");
    transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    transition("gate-acceptance", "audit", "PASS", "pre-release");
    transition("audit", "gate-audit", "PASS", "pre-release");
    transition("gate-audit", "e2e-user", "PASS", "pre-release");
    transition("e2e-user", "gate-e2e", "PASS", "pre-release");
    const r = transition("gate-e2e", "acceptance", "ITERATE", "pre-release");
    assert.equal(r.allowed, true);
  });

  it("V524 — pre-release: loopback then recover", () => {
    initFlow("pre-release", "acceptance");
    transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    transition("gate-acceptance", "acceptance", "FAIL", "pre-release");
    transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    transition("gate-acceptance", "audit", "PASS", "pre-release");
    assert.equal(readState().currentNode, "audit");
  });

  it("V525 — legacy-linear: double FAIL loop then pass", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    transition("plan", "build", "PASS", "legacy-linear");
    transition("build", "evaluate", "PASS", "legacy-linear");
    transition("evaluate", "build", "FAIL", "legacy-linear");
    transition("build", "evaluate", "PASS", "legacy-linear");
    transition("evaluate", "build", "FAIL", "legacy-linear");
    transition("build", "evaluate", "PASS", "legacy-linear");
    transition("evaluate", "deliver", "PASS", "legacy-linear");
    assert.equal(readState().currentNode, "deliver");
  });

  it("V526 — legacy-linear: ITERATE loop then PASS", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    transition("plan", "build", "PASS", "legacy-linear");
    transition("build", "evaluate", "PASS", "legacy-linear");
    transition("evaluate", "build", "ITERATE", "legacy-linear");
    transition("build", "evaluate", "PASS", "legacy-linear");
    transition("evaluate", "deliver", "PASS", "legacy-linear");
    assert.equal(readState().currentNode, "deliver");
  });

  it("V527 — full-stack: early gate failure, recover, complete", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "discuss", "FAIL", "full-stack");
    // Recover
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "acceptance", "PASS", "full-stack");
    assert.equal(readState().currentNode, "acceptance");
  });

  it("V528 — build-verify: two FAIL loops then PASS through gate", () => {
    initFlow("build-verify", "build");
    // Loop 1
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    // Loop 2
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "ITERATE", "build-verify");
    // Final pass
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    assert.equal(readState().currentNode, "gate");
    assert.equal(readState().totalSteps, 11);
  });

  it("V529 — pre-release: multiple different gates fail back to acceptance", () => {
    initFlow("pre-release", "acceptance");
    transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    transition("gate-acceptance", "acceptance", "FAIL", "pre-release");
    transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    transition("gate-acceptance", "audit", "PASS", "pre-release");
    transition("audit", "gate-audit", "PASS", "pre-release");
    transition("gate-audit", "acceptance", "FAIL", "pre-release");
    assert.equal(readState().currentNode, "acceptance");
  });

  it("V530 — full-stack: gate-final PASS is terminal", () => {
    const r = route("gate-final", "PASS", "full-stack");
    assert.equal(r.valid, true);
    assert.equal(r.next, null);
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. GATE HANDSHAKE AUTO-CREATION (V531-V550, 20 tests)
// ══════════════════════════════════════════════════════════════════

describe("6 — Gate handshake auto-creation", () => {
  beforeEach(setup);
  afterEach(teardown);

  function gateHandshake(gateNode) {
    const p = path.join(tmpDir, "nodes", gateNode, "handshake.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  // ── build-verify gate ──

  it("V531 — build-verify: gate FAIL creates handshake.json", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    const hs = gateHandshake("gate");
    assert.ok(hs, "handshake.json should exist");
  });

  it("V532 — build-verify: gate handshake has correct verdict (FAIL)", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    assert.equal(gateHandshake("gate").verdict, "FAIL");
  });

  it("V533 — build-verify: gate handshake nodeType = gate", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    assert.equal(gateHandshake("gate").nodeType, "gate");
  });

  it("V534 — build-verify: gate handshake status = completed", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    assert.equal(gateHandshake("gate").status, "completed");
  });

  it("V535 — build-verify: gate ITERATE creates handshake with ITERATE verdict", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "ITERATE", "build-verify");
    assert.equal(gateHandshake("gate").verdict, "ITERATE");
  });

  // ── full-stack gates ──

  it("V536 — full-stack: gate-test FAIL creates handshake", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "discuss", "FAIL", "full-stack");
    assert.ok(gateHandshake("gate-test"));
    assert.equal(gateHandshake("gate-test").nodeType, "gate");
  });

  it("V537 — full-stack: gate-test handshake verdict = FAIL", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "discuss", "FAIL", "full-stack");
    assert.equal(gateHandshake("gate-test").verdict, "FAIL");
  });

  it("V538 — full-stack: gate-acceptance PASS creates handshake", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "acceptance", "PASS", "full-stack");
    transition("acceptance", "gate-acceptance", "PASS", "full-stack");
    transition("gate-acceptance", "audit", "PASS", "full-stack");
    assert.ok(gateHandshake("gate-acceptance"));
    assert.equal(gateHandshake("gate-acceptance").verdict, "PASS");
  });

  it("V539 — full-stack: gate-audit ITERATE creates handshake", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "acceptance", "PASS", "full-stack");
    transition("acceptance", "gate-acceptance", "PASS", "full-stack");
    transition("gate-acceptance", "audit", "PASS", "full-stack");
    transition("audit", "gate-audit", "PASS", "full-stack");
    transition("gate-audit", "discuss", "ITERATE", "full-stack");
    assert.ok(gateHandshake("gate-audit"));
    assert.equal(gateHandshake("gate-audit").verdict, "ITERATE");
  });

  it("V540 — full-stack: gate-e2e FAIL creates handshake", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "acceptance", "PASS", "full-stack");
    transition("acceptance", "gate-acceptance", "PASS", "full-stack");
    transition("gate-acceptance", "audit", "PASS", "full-stack");
    transition("audit", "gate-audit", "PASS", "full-stack");
    transition("gate-audit", "e2e-user", "PASS", "full-stack");
    transition("e2e-user", "gate-e2e", "PASS", "full-stack");
    transition("gate-e2e", "discuss", "FAIL", "full-stack");
    assert.ok(gateHandshake("gate-e2e"));
    assert.equal(gateHandshake("gate-e2e").nodeType, "gate");
  });

  it("V541 — full-stack: gate-final FAIL creates handshake", () => {
    initFlow("full-stack", "discuss");
    transition("discuss", "build", "PASS", "full-stack");
    transition("build", "code-review", "PASS", "full-stack");
    transition("code-review", "test-verify", "PASS", "full-stack");
    transition("test-verify", "gate-test", "PASS", "full-stack");
    transition("gate-test", "acceptance", "PASS", "full-stack");
    transition("acceptance", "gate-acceptance", "PASS", "full-stack");
    transition("gate-acceptance", "audit", "PASS", "full-stack");
    transition("audit", "gate-audit", "PASS", "full-stack");
    transition("gate-audit", "e2e-user", "PASS", "full-stack");
    transition("e2e-user", "gate-e2e", "PASS", "full-stack");
    transition("gate-e2e", "post-launch-sim", "PASS", "full-stack");
    transition("post-launch-sim", "gate-final", "PASS", "full-stack");
    transition("gate-final", "discuss", "FAIL", "full-stack");
    assert.ok(gateHandshake("gate-final"));
    assert.equal(gateHandshake("gate-final").verdict, "FAIL");
  });

  // ── pre-release gates ──

  it("V542 — pre-release: gate-acceptance FAIL creates handshake", () => {
    initFlow("pre-release", "acceptance");
    transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    transition("gate-acceptance", "acceptance", "FAIL", "pre-release");
    assert.ok(gateHandshake("gate-acceptance"));
    assert.equal(gateHandshake("gate-acceptance").verdict, "FAIL");
  });

  it("V543 — pre-release: gate-acceptance handshake status = completed", () => {
    initFlow("pre-release", "acceptance");
    transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    transition("gate-acceptance", "acceptance", "FAIL", "pre-release");
    assert.equal(gateHandshake("gate-acceptance").status, "completed");
  });

  it("V544 — pre-release: gate-audit FAIL creates handshake", () => {
    initFlow("pre-release", "acceptance");
    transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    transition("gate-acceptance", "audit", "PASS", "pre-release");
    transition("audit", "gate-audit", "PASS", "pre-release");
    transition("gate-audit", "acceptance", "FAIL", "pre-release");
    assert.ok(gateHandshake("gate-audit"));
    assert.equal(gateHandshake("gate-audit").nodeType, "gate");
  });

  it("V545 — pre-release: gate-e2e ITERATE creates handshake", () => {
    initFlow("pre-release", "acceptance");
    transition("acceptance", "gate-acceptance", "PASS", "pre-release");
    transition("gate-acceptance", "audit", "PASS", "pre-release");
    transition("audit", "gate-audit", "PASS", "pre-release");
    transition("gate-audit", "e2e-user", "PASS", "pre-release");
    transition("e2e-user", "gate-e2e", "PASS", "pre-release");
    transition("gate-e2e", "acceptance", "ITERATE", "pre-release");
    assert.ok(gateHandshake("gate-e2e"));
    assert.equal(gateHandshake("gate-e2e").verdict, "ITERATE");
  });

  it("V546 — gate handshake has timestamp", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    const hs = gateHandshake("gate");
    assert.ok(hs.timestamp);
    assert.ok(!isNaN(Date.parse(hs.timestamp)));
  });

  it("V547 — gate handshake has nodeId matching gate name", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    assert.equal(gateHandshake("gate").nodeId, "gate");
  });

  it("V548 — gate handshake has runId", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    assert.ok(gateHandshake("gate").runId.startsWith("run_"));
  });

  it("V549 — gate handshake artifacts is empty array", () => {
    initFlow("build-verify", "build");
    transition("build", "code-review", "PASS", "build-verify");
    transition("code-review", "test-verify", "PASS", "build-verify");
    transition("test-verify", "gate", "PASS", "build-verify");
    transition("gate", "build", "FAIL", "build-verify");
    assert.deepEqual(gateHandshake("gate").artifacts, []);
  });

  it("V550 — non-gate node transition does NOT create handshake", () => {
    initFlow("legacy-linear", "design");
    transition("design", "plan", "PASS", "legacy-linear");
    const p = path.join(tmpDir, "nodes", "design", "handshake.json");
    assert.equal(fs.existsSync(p), false);
  });
});
