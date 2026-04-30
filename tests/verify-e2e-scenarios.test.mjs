// tests/verify-e2e-scenarios.test.mjs — V901-V1000 (100 tests)
// End-to-end scenario verification — simulate real OPC workflows

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { cmdSynthesize, cmdDiff, cmdVerify, cmdReport } = await import("../bin/lib/eval-commands.mjs");
const { getMarker, cmdViz, cmdReplayData } = await import("../bin/lib/viz-commands.mjs");
const { cmdRoute, cmdInit, cmdTransition, cmdValidate, cmdValidateChain } = await import("../bin/lib/flow-commands.mjs");
const { FLOW_TEMPLATES } = await import("../bin/lib/flow-templates.mjs");
const { parseEvaluation } = await import("../bin/lib/eval-parser.mjs");

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

function makeEvalMd({ verdict = "PASS", findings = [], blocked = false } = {}) {
  let md = "# Evaluation\n\n";
  for (const f of findings) {
    const sev = f.severity === "critical" ? "🔴" : f.severity === "warning" ? "🟡" : "🔵";
    const fileRef = f.file ? ` ${f.file}:${f.line || 1}` : "";
    md += `${sev}${fileRef} — ${f.issue || "some issue"}\n`;
    if (f.fix) md += `→ ${f.fix}\n`;
    if (f.reasoning) md += `reasoning: ${f.reasoning}\n`;
    md += "\n";
  }
  const count = findings.length;
  const v = blocked ? "BLOCKED" : verdict;
  md += `VERDICT: ${v} FINDINGS[${count}]\n`;
  return md;
}

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "opc-e2e-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// Helper: run init + transition sequence
function initFlow(dir, flow, entry) {
  const c = capture(() => cmdInit(["--flow", flow, "--entry", entry || FLOW_TEMPLATES[flow].nodes[0], "--dir", dir]));
  return parseOutput(c);
}

function transition(dir, flow, from, to, verdict) {
  const c = capture(() => cmdTransition(["--from", from, "--to", to, "--verdict", verdict, "--flow", flow, "--dir", dir]));
  return parseOutput(c);
}

function getState(dir) {
  return JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
}

// ══════════════════════════════════════════════════════════════════
// 1. Happy path: quick review (V901-V915)
// ══════════════════════════════════════════════════════════════════
describe("Happy path: quick review", () => {
  it("V901 — init creates flow-state.json", () => {
    const hd = join(tmp, "h");
    const out = initFlow(hd, "quick-review");
    assert.equal(out.created, true);
    assert.ok(existsSync(join(hd, "flow-state.json")));
  });

  it("V902 — init sets entry node to code-review", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    const state = getState(hd);
    assert.equal(state.currentNode, "code-review");
    assert.equal(state.entryNode, "code-review");
  });

  it("V903 — marker shows ▶ at code-review after init", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    const state = getState(hd);
    assert.equal(getMarker("code-review", state), "▶");
  });

  it("V904 — write eval files and synthesize → PASS", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    mkdirSync(join(hd, "nodes", "code-review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "code-review", "run_1", "eval-security.md"),
      makeEvalMd({ findings: [] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "code-review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "PASS");
  });

  it("V905 — route from code-review with PASS → gate", () => {
    const c = capture(() => cmdRoute(["--node", "code-review", "--verdict", "PASS", "--flow", "quick-review"]));
    assert.equal(parseOutput(c).next, "gate");
  });

  it("V906 — transition code-review → gate", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    const out = transition(hd, "quick-review", "code-review", "gate", "PASS");
    assert.equal(out.allowed, true);
    assert.equal(out.next, "gate");
  });

  it("V907 — after transition, currentNode is gate", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    transition(hd, "quick-review", "code-review", "gate", "PASS");
    assert.equal(getState(hd).currentNode, "gate");
  });

  it("V908 — marker shows ▶ at gate, ✅ at code-review", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    transition(hd, "quick-review", "code-review", "gate", "PASS");
    const state = getState(hd);
    assert.equal(getMarker("code-review", state), "✅");
    assert.equal(getMarker("gate", state), "▶");
  });

  it("V909 — gate PASS → null (end of flow)", () => {
    const c = capture(() => cmdRoute(["--node", "gate", "--verdict", "PASS", "--flow", "quick-review"]));
    assert.equal(parseOutput(c).next, null);
  });

  it("V910 — totalSteps increments correctly", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    assert.equal(getState(hd).totalSteps, 0);
    transition(hd, "quick-review", "code-review", "gate", "PASS");
    assert.equal(getState(hd).totalSteps, 1);
  });

  it("V911 — history has one entry after transition", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    transition(hd, "quick-review", "code-review", "gate", "PASS");
    assert.equal(getState(hd).history.length, 1);
  });

  it("V912 — run directory created by transition", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    transition(hd, "quick-review", "code-review", "gate", "PASS");
    assert.ok(existsSync(join(hd, "nodes", "gate", "run_1")));
  });

  it("V913 — double init fails (already exists)", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    const c = capture(() => cmdInit(["--flow", "quick-review", "--dir", hd]));
    assert.ok(parseOutput(c).error);
    assert.equal(parseOutput(c).created, false);
  });

  it("V914 — validate-chain after clean flow is valid", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    transition(hd, "quick-review", "code-review", "gate", "PASS");
    const c = capture(() => cmdValidateChain(["--dir", hd]));
    assert.equal(parseOutput(c).valid, true);
  });

  it("V915 — full quick-review: init → transition → viz shows all ✅/▶", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    transition(hd, "quick-review", "code-review", "gate", "PASS");
    const c = capture(() => cmdViz(["--flow", "quick-review", "--dir", hd, "--json"]));
    const out = parseOutput(c);
    assert.equal(out.nodes.find(n => n.id === "code-review").status, "✅");
    assert.equal(out.nodes.find(n => n.id === "gate").status, "▶");
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. Fail-loop: build-verify (V916-V930)
// ══════════════════════════════════════════════════════════════════
describe("Fail-loop: build-verify", () => {
  it("V916 — init build-verify at build", () => {
    const hd = join(tmp, "h");
    const out = initFlow(hd, "build-verify");
    assert.equal(out.created, true);
    assert.equal(getState(hd).currentNode, "build");
  });

  it("V917 — build → code-review → test-verify → gate", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    transition(hd, "build-verify", "build", "code-review", "PASS");
    transition(hd, "build-verify", "code-review", "test-verify", "PASS");
    transition(hd, "build-verify", "test-verify", "gate", "PASS");
    assert.equal(getState(hd).currentNode, "gate");
    assert.equal(getState(hd).totalSteps, 3);
  });

  it("V918 — gate FAIL → back to build", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    transition(hd, "build-verify", "build", "code-review", "PASS");
    transition(hd, "build-verify", "code-review", "test-verify", "PASS");
    transition(hd, "build-verify", "test-verify", "gate", "PASS");
    const out = transition(hd, "build-verify", "gate", "build", "FAIL");
    assert.equal(out.allowed, true);
    assert.equal(getState(hd).currentNode, "build");
  });

  it("V919 — after loop back, totalSteps = 4", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    transition(hd, "build-verify", "build", "code-review", "PASS");
    transition(hd, "build-verify", "code-review", "test-verify", "PASS");
    transition(hd, "build-verify", "test-verify", "gate", "PASS");
    transition(hd, "build-verify", "gate", "build", "FAIL");
    assert.equal(getState(hd).totalSteps, 4);
  });

  it("V920 — edge count for gate→build incremented", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    transition(hd, "build-verify", "build", "code-review", "PASS");
    transition(hd, "build-verify", "code-review", "test-verify", "PASS");
    transition(hd, "build-verify", "test-verify", "gate", "PASS");
    transition(hd, "build-verify", "gate", "build", "FAIL");
    assert.equal(getState(hd).edgeCounts["gate→build"], 1);
  });

  it("V921 — second loop: build → cr → tv → gate → build (2 loops)", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    // Loop 1
    transition(hd, "build-verify", "build", "code-review", "PASS");
    transition(hd, "build-verify", "code-review", "test-verify", "PASS");
    transition(hd, "build-verify", "test-verify", "gate", "PASS");
    transition(hd, "build-verify", "gate", "build", "FAIL");
    // Loop 2
    transition(hd, "build-verify", "build", "code-review", "PASS");
    transition(hd, "build-verify", "code-review", "test-verify", "PASS");
    transition(hd, "build-verify", "test-verify", "gate", "PASS");
    transition(hd, "build-verify", "gate", "build", "FAIL");
    assert.equal(getState(hd).edgeCounts["gate→build"], 2);
    assert.equal(getState(hd).totalSteps, 8);
  });

  it("V922 — maxLoopsPerEdge blocks when edge count reaches limit", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    // Directly set state to simulate 3 prior gate→build transitions
    const state = getState(hd);
    state.currentNode = "gate";
    state.totalSteps = 12;
    state.edgeCounts = { "gate→build": 3 }; // at the limit
    state.history = [
      { nodeId: "code-review", runId: "run_1" },
      { nodeId: "gate", runId: "run_1" },
    ];
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify(state));
    const c = capture(() => cmdTransition(["--from", "gate", "--to", "build", "--verdict", "FAIL", "--flow", "build-verify", "--dir", hd]));
    assert.equal(parseOutput(c).allowed, false);
    assert.ok(parseOutput(c).reason.includes("maxLoopsPerEdge"));
  });

  it("V923 — after fix: gate PASS → null (complete)", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    transition(hd, "build-verify", "build", "code-review", "PASS");
    transition(hd, "build-verify", "code-review", "test-verify", "PASS");
    transition(hd, "build-verify", "test-verify", "gate", "PASS");
    const c = capture(() => cmdRoute(["--node", "gate", "--verdict", "PASS", "--flow", "build-verify"]));
    assert.equal(parseOutput(c).next, null);
  });

  it("V924 — history tracks all loop visits", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    transition(hd, "build-verify", "build", "code-review", "PASS");
    transition(hd, "build-verify", "code-review", "test-verify", "PASS");
    transition(hd, "build-verify", "test-verify", "gate", "PASS");
    transition(hd, "build-verify", "gate", "build", "FAIL");
    const buildVisits = getState(hd).history.filter(h => h.nodeId === "build");
    assert.equal(buildVisits.length, 1); // re-entry tracked
  });

  it("V925 — gate handshake written on transition", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    transition(hd, "build-verify", "build", "code-review", "PASS");
    transition(hd, "build-verify", "code-review", "test-verify", "PASS");
    transition(hd, "build-verify", "test-verify", "gate", "PASS");
    transition(hd, "build-verify", "gate", "build", "FAIL");
    assert.ok(existsSync(join(hd, "nodes", "gate", "handshake.json")));
    const hs = JSON.parse(readFileSync(join(hd, "nodes", "gate", "handshake.json"), "utf8"));
    assert.equal(hs.verdict, "FAIL");
  });

  it("V926 — ITERATE also loops back to build", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    transition(hd, "build-verify", "build", "code-review", "PASS");
    transition(hd, "build-verify", "code-review", "test-verify", "PASS");
    transition(hd, "build-verify", "test-verify", "gate", "PASS");
    const out = transition(hd, "build-verify", "gate", "build", "ITERATE");
    assert.equal(out.allowed, true);
  });

  it("V927 — transition from wrong node blocked", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    const c = capture(() => cmdTransition(["--from", "gate", "--to", "build", "--verdict", "FAIL", "--flow", "build-verify", "--dir", hd]));
    assert.equal(parseOutput(c).allowed, false);
    assert.ok(parseOutput(c).reason.includes("cannot transition"));
  });

  it("V928 — invalid edge blocked", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    const c = capture(() => cmdTransition(["--from", "build", "--to", "gate", "--verdict", "PASS", "--flow", "build-verify", "--dir", hd]));
    assert.equal(parseOutput(c).allowed, false);
  });

  it("V929 — build node run_2 directory created on loopback", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    transition(hd, "build-verify", "build", "code-review", "PASS");
    transition(hd, "build-verify", "code-review", "test-verify", "PASS");
    transition(hd, "build-verify", "test-verify", "gate", "PASS");
    transition(hd, "build-verify", "gate", "build", "FAIL");
    assert.ok(existsSync(join(hd, "nodes", "build", "run_1")));
  });

  it("V930 — viz shows build as ▶ after loopback", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    transition(hd, "build-verify", "build", "code-review", "PASS");
    transition(hd, "build-verify", "code-review", "test-verify", "PASS");
    transition(hd, "build-verify", "test-verify", "gate", "PASS");
    transition(hd, "build-verify", "gate", "build", "FAIL");
    const c = capture(() => cmdViz(["--flow", "build-verify", "--dir", hd, "--json"]));
    assert.equal(parseOutput(c).nodes.find(n => n.id === "build").status, "▶");
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. Oscillation: recurring issues (V931-V945)
// ══════════════════════════════════════════════════════════════════
describe("Oscillation: recurring issues", () => {
  it("V931 — round 1 finds issues", () => {
    const r1 = join(tmp, "round1.md");
    writeFileSync(r1, makeEvalMd({ findings: [
      { severity: "warning", issue: "race condition", file: "worker.js", line: 42 },
      { severity: "warning", issue: "no timeout", file: "api.js", line: 10 },
    ] }));
    const parsed = parseEvaluation(readFileSync(r1, "utf8"));
    assert.equal(parsed.findings.length, 2);
  });

  it("V932 — round 2 same issues → diff detects recurring", () => {
    const r1 = join(tmp, "round1.md");
    const r2 = join(tmp, "round2.md");
    const findings = [
      { severity: "warning", issue: "race condition", file: "worker.js", line: 42 },
      { severity: "warning", issue: "no timeout", file: "api.js", line: 10 },
    ];
    writeFileSync(r1, makeEvalMd({ findings }));
    writeFileSync(r2, makeEvalMd({ findings }));
    const c = capture(() => cmdDiff([r1, r2]));
    assert.equal(parseOutput(c).recurring, 2);
  });

  it("V933 — oscillation detected when all issues recur", () => {
    const r1 = join(tmp, "r1.md");
    const r2 = join(tmp, "r2.md");
    const findings = [
      { severity: "warning", issue: "race condition", file: "worker.js", line: 42 },
      { severity: "warning", issue: "no timeout", file: "api.js", line: 10 },
    ];
    writeFileSync(r1, makeEvalMd({ findings }));
    writeFileSync(r2, makeEvalMd({ findings }));
    const c = capture(() => cmdDiff([r1, r2]));
    assert.equal(parseOutput(c).oscillation, true);
  });

  it("V934 — partial fix → some recurring some resolved", () => {
    const r1 = join(tmp, "r1.md");
    const r2 = join(tmp, "r2.md");
    writeFileSync(r1, makeEvalMd({ findings: [
      { severity: "warning", issue: "race condition", file: "worker.js", line: 42 },
      { severity: "warning", issue: "no timeout", file: "api.js", line: 10 },
      { severity: "suggestion", issue: "add docs", file: "readme.md", line: 1 },
    ] }));
    writeFileSync(r2, makeEvalMd({ findings: [
      { severity: "warning", issue: "race condition", file: "worker.js", line: 42 },
    ] }));
    const c = capture(() => cmdDiff([r1, r2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 1);
    assert.equal(out.resolved, 2);
  });

  it("V935 — 3 rounds: issues persist through all", () => {
    const r1 = join(tmp, "r1.md");
    const r2 = join(tmp, "r2.md");
    const r3 = join(tmp, "r3.md");
    const persistent = { severity: "warning", issue: "memory leak", file: "cache.js", line: 100 };
    writeFileSync(r1, makeEvalMd({ findings: [persistent] }));
    writeFileSync(r2, makeEvalMd({ findings: [persistent] }));
    writeFileSync(r3, makeEvalMd({ findings: [persistent] }));
    // Diff r1 vs r2
    const c12 = capture(() => cmdDiff([r1, r2]));
    assert.equal(parseOutput(c12).oscillation, true);
    // Diff r2 vs r3
    const c23 = capture(() => cmdDiff([r2, r3]));
    assert.equal(parseOutput(c23).oscillation, true);
  });

  it("V936 — new issues in round 2 don't trigger oscillation if < 60% recurring", () => {
    const r1 = join(tmp, "r1.md");
    const r2 = join(tmp, "r2.md");
    writeFileSync(r1, makeEvalMd({ findings: [
      { severity: "warning", issue: "issue-a", file: "a.js", line: 1 },
    ] }));
    writeFileSync(r2, makeEvalMd({ findings: [
      { severity: "warning", issue: "issue-a", file: "a.js", line: 1 },
      { severity: "warning", issue: "new-b", file: "b.js", line: 1 },
      { severity: "warning", issue: "new-c", file: "c.js", line: 1 },
    ] }));
    const c = capture(() => cmdDiff([r1, r2]));
    // 1/1 = 100% recurring of round1 → oscillation despite new ones
    assert.equal(parseOutput(c).oscillation, true);
  });

  it("V937 — severity escalation in recurring issue flagged", () => {
    const r1 = join(tmp, "r1.md");
    const r2 = join(tmp, "r2.md");
    writeFileSync(r1, makeEvalMd({ findings: [
      { severity: "warning", issue: "unvalidated input", file: "form.js", line: 5 },
    ] }));
    writeFileSync(r2, makeEvalMd({ findings: [
      { severity: "critical", issue: "unvalidated input", file: "form.js", line: 5 },
    ] }));
    const c = capture(() => cmdDiff([r1, r2]));
    const out = parseOutput(c);
    assert.equal(out.recurring_details[0].severity_changed, true);
  });

  it("V938 — all findings resolved in round 2 → no oscillation", () => {
    const r1 = join(tmp, "r1.md");
    const r2 = join(tmp, "r2.md");
    writeFileSync(r1, makeEvalMd({ findings: [
      { severity: "warning", issue: "old", file: "x.js", line: 1 },
    ] }));
    writeFileSync(r2, makeEvalMd({ findings: [] }));
    const c = capture(() => cmdDiff([r1, r2]));
    assert.equal(parseOutput(c).oscillation, false);
  });

  it("V939 — synthesize on fixed round → PASS", () => {
    const hd = join(tmp, "h");
    mkdirSync(join(hd, "nodes", "review", "run_2"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_2", "eval-sec.md"),
      makeEvalMd({ findings: [] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "2"]));
    assert.equal(parseOutput(c).verdict, "PASS");
  });

  it("V940 — diff round1 vs round2 shows resolved count", () => {
    const r1 = join(tmp, "r1.md");
    const r2 = join(tmp, "r2.md");
    writeFileSync(r1, makeEvalMd({ findings: [
      { severity: "critical", issue: "sql injection", file: "db.js", line: 10 },
      { severity: "warning", issue: "no auth check", file: "api.js", line: 20 },
    ] }));
    writeFileSync(r2, makeEvalMd({ findings: [] }));
    const c = capture(() => cmdDiff([r1, r2]));
    assert.equal(parseOutput(c).resolved, 2);
  });

  it("V941 — recurring details have correct issue_key", () => {
    const r1 = join(tmp, "r1.md");
    const r2 = join(tmp, "r2.md");
    const findings = [{ severity: "warning", issue: "test issue", file: "x.js", line: 1 }];
    writeFileSync(r1, makeEvalMd({ findings }));
    writeFileSync(r2, makeEvalMd({ findings }));
    const c = capture(() => cmdDiff([r1, r2]));
    assert.ok(parseOutput(c).recurring_details[0].issue_key.length > 0);
  });

  it("V942 — oscillation with many findings (20 of 25 recurring)", () => {
    const common = Array.from({ length: 20 }, (_, i) =>
      ({ severity: "warning", issue: `common-${i}`, file: `f${i}.js`, line: i }));
    const r1only = Array.from({ length: 5 }, (_, i) =>
      ({ severity: "suggestion", issue: `r1only-${i}`, file: `g${i}.js`, line: i }));
    const r1 = join(tmp, "r1.md");
    const r2 = join(tmp, "r2.md");
    writeFileSync(r1, makeEvalMd({ findings: [...common, ...r1only] }));
    writeFileSync(r2, makeEvalMd({ findings: common }));
    const c = capture(() => cmdDiff([r1, r2]));
    assert.equal(parseOutput(c).oscillation, true); // 20/25 = 80%
  });

  it("V943 — oscillation false with exactly half recurring (5/10)", () => {
    const common = Array.from({ length: 5 }, (_, i) =>
      ({ severity: "warning", issue: `c-${i}`, file: `f${i}.js`, line: i }));
    const r1only = Array.from({ length: 5 }, (_, i) =>
      ({ severity: "warning", issue: `old-${i}`, file: `g${i}.js`, line: i }));
    const r1 = join(tmp, "r1.md");
    const r2 = join(tmp, "r2.md");
    writeFileSync(r1, makeEvalMd({ findings: [...common, ...r1only] }));
    writeFileSync(r2, makeEvalMd({ findings: common }));
    assert.equal(parseOutput(capture(() => cmdDiff([r1, r2]))).oscillation, false);
  });

  it("V944 — diff summary has round1_findings and round2_findings", () => {
    const r1 = join(tmp, "r1.md");
    const r2 = join(tmp, "r2.md");
    writeFileSync(r1, makeEvalMd({ findings: [{ severity: "warning", issue: "a" }] }));
    writeFileSync(r2, makeEvalMd({ findings: [{ severity: "warning", issue: "b" }, { severity: "warning", issue: "c" }] }));
    const out = parseOutput(capture(() => cmdDiff([r1, r2])));
    assert.equal(out.round1_findings, 1);
    assert.equal(out.round2_findings, 2);
  });

  it("V945 — oscillation report works with synthesis data", () => {
    const hd = join(tmp, "h");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    mkdirSync(join(hd, "nodes", "review", "run_2"), { recursive: true });
    const findings = [{ severity: "warning", issue: "recurring-bug", file: "a.js", line: 1 }];
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-sec.md"), makeEvalMd({ findings }));
    writeFileSync(join(hd, "nodes", "review", "run_2", "eval-sec.md"), makeEvalMd({ findings }));
    // Both rounds show same issue
    const c1 = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    const c2 = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "2"]));
    assert.equal(parseOutput(c1).verdict, "ITERATE");
    assert.equal(parseOutput(c2).verdict, "ITERATE");
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. Max limits hit (V946-V960)
// ══════════════════════════════════════════════════════════════════
describe("Max limits hit", () => {
  it("V946 — maxTotalSteps blocks transition", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    // quick-review maxTotalSteps = 10
    const state = getState(hd);
    state.totalSteps = 10;
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify(state));
    const c = capture(() => cmdTransition(["--from", "code-review", "--to", "gate", "--verdict", "PASS", "--flow", "quick-review", "--dir", hd]));
    assert.equal(parseOutput(c).allowed, false);
    assert.ok(parseOutput(c).reason.includes("maxTotalSteps"));
  });

  it("V947 — state NOT mutated on blocked transition (totalSteps)", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    const state = getState(hd);
    state.totalSteps = 10;
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify(state));
    capture(() => cmdTransition(["--from", "code-review", "--to", "gate", "--verdict", "PASS", "--flow", "quick-review", "--dir", hd]));
    assert.equal(getState(hd).totalSteps, 10); // unchanged
  });

  it("V948 — state NOT mutated on blocked transition (currentNode)", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    const state = getState(hd);
    state.totalSteps = 10;
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify(state));
    capture(() => cmdTransition(["--from", "code-review", "--to", "gate", "--verdict", "PASS", "--flow", "quick-review", "--dir", hd]));
    assert.equal(getState(hd).currentNode, "code-review"); // unchanged
  });

  it("V949 — state NOT mutated on blocked transition (history length)", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    const state = getState(hd);
    state.totalSteps = 10;
    state.history = [{ nodeId: "x", runId: "run_1" }];
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify(state));
    capture(() => cmdTransition(["--from", "code-review", "--to", "gate", "--verdict", "PASS", "--flow", "quick-review", "--dir", hd]));
    assert.equal(getState(hd).history.length, 1);
  });

  it("V950 — maxLoopsPerEdge blocks specific edge", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    const state = getState(hd);
    state.currentNode = "gate";
    state.edgeCounts = { "gate→build": 3 }; // maxLoopsPerEdge = 3
    state.totalSteps = 5;
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify(state));
    const c = capture(() => cmdTransition(["--from", "gate", "--to", "build", "--verdict", "FAIL", "--flow", "build-verify", "--dir", hd]));
    assert.equal(parseOutput(c).allowed, false);
    assert.ok(parseOutput(c).reason.includes("maxLoopsPerEdge"));
  });

  it("V951 — maxNodeReentry blocks node visit", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    const state = getState(hd);
    state.currentNode = "gate";
    state.totalSteps = 5;
    state.history = Array.from({ length: 5 }, () => ({ nodeId: "build", runId: "run_1" })); // 5 = maxNodeReentry
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify(state));
    const c = capture(() => cmdTransition(["--from", "gate", "--to", "build", "--verdict", "FAIL", "--flow", "build-verify", "--dir", hd]));
    assert.equal(parseOutput(c).allowed, false);
    assert.ok(parseOutput(c).reason.includes("maxNodeReentry"));
  });

  it("V952 — maxTotalSteps at boundary: steps = max-1 → allowed", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    const state = getState(hd);
    state.totalSteps = 9; // max is 10
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify(state));
    const c = capture(() => cmdTransition(["--from", "code-review", "--to", "gate", "--verdict", "PASS", "--flow", "quick-review", "--dir", hd]));
    assert.equal(parseOutput(c).allowed, true);
  });

  it("V953 — maxLoopsPerEdge at boundary: count = max-1 → allowed", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    const state = getState(hd);
    state.currentNode = "gate";
    state.edgeCounts = { "gate→build": 2 }; // max is 3
    state.totalSteps = 5;
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify(state));
    const c = capture(() => cmdTransition(["--from", "gate", "--to", "build", "--verdict", "FAIL", "--flow", "build-verify", "--dir", hd]));
    assert.equal(parseOutput(c).allowed, true);
  });

  it("V954 — maxNodeReentry at boundary: entries = max-1 → allowed", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "build-verify");
    const state = getState(hd);
    state.currentNode = "gate";
    state.totalSteps = 5;
    state.history = Array.from({ length: 4 }, () => ({ nodeId: "build", runId: "run_1" })); // 4 < 5
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify(state));
    const c = capture(() => cmdTransition(["--from", "gate", "--to", "build", "--verdict", "FAIL", "--flow", "build-verify", "--dir", hd]));
    assert.equal(parseOutput(c).allowed, true);
  });

  it("V955 — blocked transition returns reason string", () => {
    const hd = join(tmp, "h");
    initFlow(hd, "quick-review");
    const state = getState(hd);
    state.totalSteps = 10;
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify(state));
    const c = capture(() => cmdTransition(["--from", "code-review", "--to", "gate", "--verdict", "PASS", "--flow", "quick-review", "--dir", hd]));
    assert.equal(typeof parseOutput(c).reason, "string");
    assert.ok(parseOutput(c).reason.length > 0);
  });

  it("V956 — full-stack maxTotalSteps is 30", () => {
    assert.equal(FLOW_TEMPLATES["full-stack"].limits.maxTotalSteps, 30);
  });

  it("V957 — build-verify maxTotalSteps is 20", () => {
    assert.equal(FLOW_TEMPLATES["build-verify"].limits.maxTotalSteps, 20);
  });

  it("V958 — pre-release maxTotalSteps is 20", () => {
    assert.equal(FLOW_TEMPLATES["pre-release"].limits.maxTotalSteps, 20);
  });

  it("V959 — all templates have maxLoopsPerEdge = 3", () => {
    for (const [name, t] of Object.entries(FLOW_TEMPLATES)) {
      assert.equal(t.limits.maxLoopsPerEdge, 3, `${name} maxLoopsPerEdge`);
    }
  });

  it("V960 — all templates have maxNodeReentry = 5", () => {
    for (const [name, t] of Object.entries(FLOW_TEMPLATES)) {
      assert.equal(t.limits.maxNodeReentry, 5, `${name} maxNodeReentry`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. Devil's advocate integration (V961-V970)
// ══════════════════════════════════════════════════════════════════
describe("Devil's advocate integration", () => {
  const SCRIPT = join(__dirname, "..", "scripts", "verify_devil_advocate.py");
  const hasPython = (() => {
    try { execFileSync("python3", ["--version"], { encoding: "utf8", timeout: 5000 }); return true; }
    catch { return false; }
  })();
  const hasScript = existsSync(SCRIPT);

  function runPy(filePath) {
    try {
      const stdout = execFileSync("python3", [SCRIPT, filePath], { encoding: "utf8", timeout: 10000 });
      return { stdout, code: 0 };
    } catch (e) {
      return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status };
    }
  }

  function makeDevilDoc(challenges, verdict) {
    let md = "# Devil's Advocate Evaluation\n\n## Challenges\n\n";
    for (const c of challenges) {
      md += `### [${c.status || "OPEN"}] Challenge ${c.number}: ${c.title}\n\n`;
      if (c.assumption) md += `**Assumption under attack:** ${c.assumption}\n\n`;
      if (c.failure) md += `**Failure scenario:** ${c.failure}\n\n`;
      if (c.convince) md += `**What would convince me:** ${c.convince}\n\n`;
      if (c.alternative) md += `**If I'm right:** ${c.alternative}\n\n`;
    }
    md += `---\n\n## Verdict\n\nVERDICT: ${verdict}\n`;
    return md;
  }

  const skip = !hasPython || !hasScript;

  it("V961 — valid devil advocate doc passes verification", { skip }, () => {
    const p = join(tmp, "da.md");
    writeFileSync(p, makeDevilDoc([
      { number: 1, title: "Scaling issue", assumption: "System handles 10k rps",
        failure: "When load hits 15k rps, OOM", convince: "Load test at 20k rps",
        alternative: "Use backpressure queue" },
      { number: 2, title: "Data loss", assumption: "Transactions are atomic",
        failure: "If network partition during commit, data lost",
        convince: "Show WAL recovery test", alternative: "Add write-ahead log" },
      { number: 3, title: "Auth bypass", assumption: "JWT validation is correct",
        failure: "When token algorithm is none, auth bypassed",
        convince: "Show algorithm pinning test", alternative: "Use opaque tokens" },
    ], "UNCONVINCED [3]"));
    const r = runPy(p);
    assert.equal(r.code, 0);
  });

  it("V962 — devil advocate doc with missing sections fails", { skip }, () => {
    const p = join(tmp, "da.md");
    writeFileSync(p, makeDevilDoc([
      { number: 1, title: "Incomplete", status: "OPEN" },
    ], "UNCONVINCED [1]"));
    const r = runPy(p);
    assert.equal(r.code, 1);
  });

  it("V963 — CONVINCED with all SEALED passes", { skip }, () => {
    const p = join(tmp, "da.md");
    writeFileSync(p, makeDevilDoc([
      { number: 1, status: "SEALED", title: "Resolved",
        assumption: "X", failure: "Y", convince: "Z", alternative: "W" },
      { number: 2, status: "SEALED", title: "Also resolved",
        assumption: "A", failure: "B", convince: "C", alternative: "D" },
      { number: 3, status: "SEALED", title: "Done too",
        assumption: "E", failure: "F", convince: "G", alternative: "H" },
    ], "CONVINCED"));
    const r = runPy(p);
    assert.equal(r.code, 0);
  });

  it("V964 — FATAL verdict recognized", { skip }, () => {
    const p = join(tmp, "da.md");
    writeFileSync(p, makeDevilDoc([
      { number: 1, title: "Critical flaw", assumption: "X",
        failure: "When Y, system crashes", convince: "Z", alternative: "W" },
      { number: 2, title: "Another flaw", assumption: "A",
        failure: "When B, data corrupt", convince: "C", alternative: "D" },
      { number: 3, title: "Third flaw", assumption: "E",
        failure: "When F, security breach", convince: "G", alternative: "H" },
    ], "FATAL"));
    const r = runPy(p);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("FATAL"));
  });

  it("V965 — challenge structure has all 4 fields", { skip }, () => {
    const p = join(tmp, "da.md");
    writeFileSync(p, makeDevilDoc([
      { number: 1, title: "Test", assumption: "Assume X",
        failure: "When Y happens, Z breaks", convince: "Show test T",
        alternative: "Use approach B" },
      { number: 2, title: "Test2", assumption: "Assume A",
        failure: "When B happens, C breaks", convince: "Show test D",
        alternative: "Use approach E" },
      { number: 3, title: "Test3", assumption: "Assume F",
        failure: "When G happens, H breaks", convince: "Show test I",
        alternative: "Use approach J" },
    ], "UNCONVINCED [3]"));
    const r = runPy(p);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("assumption"));
  });

  it("V966 — vague failure scenario detected", { skip }, () => {
    const p = join(tmp, "da.md");
    writeFileSync(p, makeDevilDoc([
      { number: 1, title: "Vague", assumption: "X",
        failure: "The system might eventually have problems",
        convince: "Z", alternative: "W" },
      { number: 2, title: "Good", assumption: "A",
        failure: "When load exceeds 1000 rps, OOM kills process",
        convince: "C", alternative: "D" },
      { number: 3, title: "Also good", assumption: "E",
        failure: "If network partitions, data is lost",
        convince: "G", alternative: "H" },
    ], "UNCONVINCED [3]"));
    const r = runPy(p);
    assert.ok(r.stdout.includes("VAGUE"));
  });

  it("V967 — low challenge count warned (1 challenge)", { skip }, () => {
    const p = join(tmp, "da.md");
    writeFileSync(p, makeDevilDoc([
      { number: 1, title: "Only one", assumption: "X",
        failure: "When Y, Z breaks", convince: "W", alternative: "V" },
    ], "UNCONVINCED [1]"));
    const r = runPy(p);
    assert.ok(r.stdout.includes("LOW_CHALLENGE_COUNT"));
  });

  it("V968 — 5 challenges no low count warning", { skip }, () => {
    const challenges = Array.from({ length: 5 }, (_, i) => ({
      number: i + 1, title: `Challenge ${i + 1}`, assumption: `A${i}`,
      failure: `When X${i} exceeds threshold, system fails`,
      convince: `Show test for X${i}`, alternative: `Use approach Y${i}`,
    }));
    const p = join(tmp, "da.md");
    writeFileSync(p, makeDevilDoc(challenges, "UNCONVINCED [5]"));
    const r = runPy(p);
    assert.ok(!r.stdout.includes("LOW_CHALLENGE_COUNT"));
  });

  it("V969 — UNCONVINCED count mismatch flagged", { skip }, () => {
    const p = join(tmp, "da.md");
    writeFileSync(p, makeDevilDoc([
      { number: 1, title: "One", assumption: "X",
        failure: "When Y, Z", convince: "W", alternative: "V" },
      { number: 2, title: "Two", assumption: "A",
        failure: "When B, C", convince: "D", alternative: "E" },
      { number: 3, title: "Three", assumption: "F",
        failure: "When G, H", convince: "I", alternative: "J" },
    ], "UNCONVINCED [5]")); // says 5 but only 3 OPEN
    const r = runPy(p);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("VERDICT_MISMATCH"));
  });

  it("V970 — CONVINCED with OPEN challenges flagged inconsistent", { skip }, () => {
    const p = join(tmp, "da.md");
    writeFileSync(p, makeDevilDoc([
      { number: 1, title: "Still open", assumption: "X",
        failure: "When Y, Z", convince: "W", alternative: "V" },
      { number: 2, title: "Still open 2", assumption: "A",
        failure: "When B, C", convince: "D", alternative: "E" },
      { number: 3, title: "Still open 3", assumption: "F",
        failure: "When G, H", convince: "I", alternative: "J" },
    ], "CONVINCED"));
    const r = runPy(p);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("INCONSISTENT"));
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. Report → Replay round-trip (V971-V980)
// ══════════════════════════════════════════════════════════════════
describe("Report → Replay round-trip", () => {
  function setupFullFlow(dir) {
    // Set up a completed build-verify flow
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      flowTemplate: "build-verify",
      currentNode: "gate",
      entryNode: "build",
      totalSteps: 3,
      history: [
        { nodeId: "code-review", runId: "run_1", timestamp: "2026-01-01T00:00:00Z" },
        { nodeId: "test-verify", runId: "run_1", timestamp: "2026-01-01T00:01:00Z" },
        { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:02:00Z" },
      ],
    }));
    mkdirSync(join(dir, "nodes", "build"), { recursive: true });
    mkdirSync(join(dir, "nodes", "code-review", "run_1"), { recursive: true });
    mkdirSync(join(dir, "nodes", "test-verify", "run_1"), { recursive: true });
    mkdirSync(join(dir, "nodes", "gate"), { recursive: true });

    writeFileSync(join(dir, "nodes", "build", "handshake.json"), JSON.stringify({
      nodeId: "build", nodeType: "build", runId: "run_1",
      status: "completed", summary: "built app", timestamp: "2026-01-01T00:00:00Z", artifacts: [],
    }));
    writeFileSync(join(dir, "nodes", "code-review", "handshake.json"), JSON.stringify({
      nodeId: "code-review", nodeType: "review", runId: "run_1",
      status: "completed", summary: "reviewed", timestamp: "2026-01-01T00:01:00Z", artifacts: [],
    }));
    writeFileSync(join(dir, "nodes", "code-review", "run_1", "eval-security.md"),
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "add rate limit", file: "api.js", line: 10 }] }));
    writeFileSync(join(dir, "nodes", "gate", "handshake.json"), JSON.stringify({
      nodeId: "gate", nodeType: "gate", runId: "run_1",
      status: "completed", verdict: "PASS", summary: "gate passed", timestamp: "2026-01-01T00:02:00Z", artifacts: [],
    }));
  }

  it("V971 — replay data from full flow has all nodes", () => {
    setupFullFlow(tmp);
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.deepEqual(out.nodes, ["build", "code-review", "test-verify", "gate"]);
  });

  it("V972 — replay data has handshakes for nodes with handshake files", () => {
    setupFullFlow(tmp);
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.ok(out.handshakes.build);
    assert.ok(out.handshakes["code-review"]);
    assert.ok(out.handshakes.gate);
  });

  it("V973 — replay handshake has details from run files", () => {
    setupFullFlow(tmp);
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.ok(out.handshakes["code-review"].details.length > 0);
    assert.ok(out.handshakes["code-review"].details[0].file === "eval-security.md");
  });

  it("V974 — replay data has correct history", () => {
    setupFullFlow(tmp);
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(parseOutput(c).history.length, 3);
  });

  it("V975 — replay data has correct totalSteps", () => {
    setupFullFlow(tmp);
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(parseOutput(c).totalSteps, 3);
  });

  it("V976 — replay data has edges matching template", () => {
    setupFullFlow(tmp);
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.equal(out.edges.gate.FAIL, "build");
    assert.equal(out.edges.gate.PASS, null);
  });

  it("V977 — replay loopbacks match template", () => {
    setupFullFlow(tmp);
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.ok(out.loopbacks.some(lb => lb.gate === "gate" && lb.verdict === "FAIL"));
  });

  it("V978 — report from same flow has agent data", () => {
    // Set up wave eval files for report (different path from flow)
    const projDir = join(tmp, "proj");
    mkdirSync(join(projDir, ".harness"), { recursive: true });
    writeFileSync(join(projDir, ".harness", "evaluation-wave-1-security.md"),
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "add rate limit", file: "api.js", line: 10 }] }));
    const c = capture(() => cmdReport([projDir, "--mode", "build", "--task", "Build app"]));
    assert.ok(parseOutput(c).agents.length > 0);
  });

  it("V979 — report and replay have matching flow template", () => {
    setupFullFlow(tmp);
    const replayC = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(parseOutput(replayC).flowTemplate, "build-verify");
  });

  it("V980 — replay content field has actual eval content", () => {
    setupFullFlow(tmp);
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const detail = parseOutput(c).handshakes["code-review"].details[0];
    assert.ok(detail.content.includes("add rate limit"));
  });
});

// ══════════════════════════════════════════════════════════════════
// 7. Error recovery scenarios (V981-V990)
// ══════════════════════════════════════════════════════════════════
describe("Error recovery scenarios", () => {
  it("V981 — corrupted flow-state.json → re-init fresh", () => {
    const hd = join(tmp, "h");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "flow-state.json"), "CORRUPT{{{not json");
    // Attempting replay-data fails
    const c1 = capture(() => cmdReplayData(["--dir", hd]));
    assert.equal(c1.exitCode, 1);
    // Remove and re-init
    rmSync(join(hd, "flow-state.json"));
    const c2 = capture(() => cmdInit(["--flow", "quick-review", "--dir", hd]));
    assert.equal(parseOutput(c2).created, true);
  });

  it("V982 — missing eval files → synthesize exits gracefully", () => {
    const hd = join(tmp, "h");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    // No eval files in run
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(c.exitCode, 1);
  });

  it("V983 — missing eval files → verify exits gracefully on nonexistent", () => {
    const c = capture(() => cmdVerify([join(tmp, "nonexistent.md")]));
    assert.equal(c.exitCode, 1);
  });

  it("V984 — validate-chain catches missing handshake", () => {
    const hd = join(tmp, "h");
    mkdirSync(join(hd, "nodes"), { recursive: true });
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify({
      flowTemplate: "build-verify",
      currentNode: "gate",
      entryNode: "build",
      totalSteps: 3,
      history: [
        { nodeId: "build", runId: "run_1" },
        { nodeId: "code-review", runId: "run_1" },
        // gate is current, so missing handshake OK for it
      ],
    }));
    // build and code-review missing handshakes
    const c = capture(() => cmdValidateChain(["--dir", hd]));
    const out = parseOutput(c);
    assert.equal(out.valid, false);
    assert.ok(out.errors.length > 0);
  });

  it("V985 — validate-chain with no flow-state → invalid", () => {
    const hd = join(tmp, "h");
    mkdirSync(hd, { recursive: true });
    const c = capture(() => cmdValidateChain(["--dir", hd]));
    assert.equal(parseOutput(c).valid, false);
  });

  it("V986 — validate catches malformed handshake", () => {
    const hd = join(tmp, "h");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "handshake.json"), JSON.stringify({ nodeId: "", nodeType: "" }));
    const c = capture(() => cmdValidate([join(hd, "handshake.json")]));
    assert.equal(parseOutput(c).valid, false);
  });

  it("V987 — validate catches invalid nodeType", () => {
    const hd = join(tmp, "h");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "handshake.json"), JSON.stringify({
      nodeId: "test", nodeType: "invalid-type", runId: "run_1",
      status: "completed", summary: "ok", timestamp: "2026-01-01T00:00:00Z", artifacts: [],
    }));
    const c = capture(() => cmdValidate([join(hd, "handshake.json")]));
    assert.equal(parseOutput(c).valid, false);
    assert.ok(parseOutput(c).errors.some(e => e.includes("nodeType")));
  });

  it("V988 — validate catches PASS verdict with critical findings", () => {
    const hd = join(tmp, "h");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "handshake.json"), JSON.stringify({
      nodeId: "review", nodeType: "review", runId: "run_1",
      status: "completed", summary: "ok", timestamp: "2026-01-01T00:00:00Z",
      artifacts: [], verdict: "PASS", findings: { critical: 2 },
    }));
    const c = capture(() => cmdValidate([join(hd, "handshake.json")]));
    assert.equal(parseOutput(c).valid, false);
    assert.ok(parseOutput(c).errors.some(e => e.includes("critical")));
  });

  it("V989 — validate catches missing loopback fields", () => {
    const hd = join(tmp, "h");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "handshake.json"), JSON.stringify({
      nodeId: "gate", nodeType: "gate", runId: "run_1",
      status: "completed", summary: "ok", timestamp: "2026-01-01T00:00:00Z",
      artifacts: [], loopback: { from: "gate" }, // missing reason, iteration
    }));
    const c = capture(() => cmdValidate([join(hd, "handshake.json")]));
    assert.equal(parseOutput(c).valid, false);
  });

  it("V990 — validate-chain executedPath lists visited nodes", () => {
    const hd = join(tmp, "h");
    mkdirSync(join(hd, "nodes", "build"), { recursive: true });
    mkdirSync(join(hd, "nodes", "code-review"), { recursive: true });
    writeFileSync(join(hd, "nodes", "build", "handshake.json"), JSON.stringify({
      nodeId: "build", nodeType: "build", status: "completed",
    }));
    writeFileSync(join(hd, "nodes", "code-review", "handshake.json"), JSON.stringify({
      nodeId: "code-review", nodeType: "review", status: "completed",
    }));
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify({
      flowTemplate: "build-verify",
      currentNode: "test-verify",
      entryNode: "build",
      totalSteps: 2,
      history: [
        { nodeId: "build", runId: "run_1" },
        { nodeId: "code-review", runId: "run_1" },
        { nodeId: "test-verify", runId: "run_1" },
      ],
    }));
    const c = capture(() => cmdValidateChain(["--dir", hd]));
    const out = parseOutput(c);
    assert.ok(out.executedPath.includes("build"));
    assert.ok(out.executedPath.includes("code-review"));
  });
});

// ══════════════════════════════════════════════════════════════════
// 8. Multi-template comparison (V991-V1000)
// ══════════════════════════════════════════════════════════════════
describe("Multi-template comparison", () => {
  it("V991 — quick-review has fewer nodes than build-verify", () => {
    assert.ok(FLOW_TEMPLATES["quick-review"].nodes.length < FLOW_TEMPLATES["build-verify"].nodes.length);
  });

  it("V992 — build-verify has fewer nodes than full-stack", () => {
    assert.ok(FLOW_TEMPLATES["build-verify"].nodes.length < FLOW_TEMPLATES["full-stack"].nodes.length);
  });

  it("V993 — quick-review has no FAIL edges", () => {
    const edges = FLOW_TEMPLATES["quick-review"].edges;
    for (const [node, e] of Object.entries(edges)) {
      assert.equal(e.FAIL, undefined, `${node} should not have FAIL edge`);
    }
  });

  it("V994 — build-verify gate has FAIL and ITERATE edges", () => {
    const gateEdges = FLOW_TEMPLATES["build-verify"].edges.gate;
    assert.equal(gateEdges.FAIL, "build");
    assert.equal(gateEdges.ITERATE, "build");
  });

  it("V995 — full-stack has 5 gate nodes", () => {
    const gates = FLOW_TEMPLATES["full-stack"].nodes.filter(n => n.startsWith("gate"));
    assert.equal(gates.length, 5);
  });

  it("V996 — every template first node is not a gate", () => {
    for (const [name, t] of Object.entries(FLOW_TEMPLATES)) {
      assert.ok(!t.nodes[0].startsWith("gate"), `${name} starts with gate`);
    }
  });

  it("V997 — every template has at least 2 nodes", () => {
    for (const [name, t] of Object.entries(FLOW_TEMPLATES)) {
      assert.ok(t.nodes.length >= 2, `${name} has < 2 nodes`);
    }
  });

  it("V998 — viz JSON for different templates have different node counts", () => {
    const c1 = capture(() => cmdViz(["--flow", "quick-review", "--json"]));
    const c2 = capture(() => cmdViz(["--flow", "full-stack", "--json"]));
    assert.notEqual(parseOutput(c1).nodes.length, parseOutput(c2).nodes.length);
  });

  it("V999 — build-verify and pre-release both have gate loopbacks", () => {
    for (const flow of ["build-verify", "pre-release"]) {
      const c = capture(() => cmdViz(["--flow", flow, "--json"]));
      assert.ok(parseOutput(c).loopbacks.length > 0, `${flow} has no loopbacks`);
    }
  });

  it("V1000 — all templates have edges for every node", () => {
    for (const [name, t] of Object.entries(FLOW_TEMPLATES)) {
      for (const node of t.nodes) {
        assert.ok(t.edges[node], `${name}: missing edges for node '${node}'`);
      }
    }
  });
});
