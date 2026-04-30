// tests/integration.test.mjs — T951-T1000 (50 tests)
// End-to-end integration tests using temp directories

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const { cmdVerify, cmdSynthesize, cmdReport, cmdDiff } = await import("../bin/lib/eval-commands.mjs");
const { getMarker, cmdViz, cmdReplayData } = await import("../bin/lib/viz-commands.mjs");
const { FLOW_TEMPLATES } = await import("../bin/lib/flow-templates.mjs");

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

function makeEvalMd({ verdict = "PASS", findings = [] } = {}) {
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
  md += `VERDICT: ${verdict} FINDINGS[${count}]\n`;
  return md;
}

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "opc-integ-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// ── Helpers to set up full flow state ────────────────────────────
function setupFlowState(dir, template, currentNode, history = []) {
  writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
    flowTemplate: template,
    currentNode,
    entryNode: FLOW_TEMPLATES[template].nodes[0],
    totalSteps: history.length,
    history,
  }));
  mkdirSync(join(dir, "nodes"), { recursive: true });
}

function setupNodeRun(dir, nodeId, runN, evals) {
  const runDir = join(dir, "nodes", nodeId, `run_${runN}`);
  mkdirSync(runDir, { recursive: true });
  for (const [name, content] of Object.entries(evals)) {
    writeFileSync(join(runDir, name), content);
  }
}

function setupHandshake(dir, nodeId, hs) {
  const nodeDir = join(dir, "nodes", nodeId);
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(nodeDir, "handshake.json"), JSON.stringify(hs));
}

function setupWaveEvals(projectDir, wave, evals) {
  const hd = join(projectDir, ".harness");
  mkdirSync(hd, { recursive: true });
  for (const [name, content] of Object.entries(evals)) {
    writeFileSync(join(hd, `evaluation-wave-${wave}-${name}.md`), content);
  }
}

// ══════════════════════════════════════════════════════════════════
// Full flow: quick-review (T951-T960)
// ══════════════════════════════════════════════════════════════════
describe("Full flow: quick-review", () => {
  it("T951 — init state at code-review", () => {
    setupFlowState(tmp, "quick-review", "code-review");
    const c = capture(() => cmdViz(["--flow", "quick-review", "--dir", tmp, "--json"]));
    const out = parseOutput(c);
    const cr = out.nodes.find(n => n.id === "code-review");
    assert.equal(cr.status, "▶");
  });

  it("T952 — transition to gate after code-review", () => {
    setupFlowState(tmp, "quick-review", "gate", [{ nodeId: "code-review" }]);
    const c = capture(() => cmdViz(["--flow", "quick-review", "--dir", tmp, "--json"]));
    const out = parseOutput(c);
    assert.equal(out.nodes.find(n => n.id === "gate").status, "▶");
    assert.equal(out.nodes.find(n => n.id === "code-review").status, "✅");
  });

  it("T953 — write eval then verify", () => {
    const evalFile = join(tmp, "eval.md");
    writeFileSync(evalFile, makeEvalMd({
      findings: [{ severity: "warning", file: "app.js", line: 5, issue: "unused var", fix: "remove it", reasoning: "dead code" }],
    }));
    const c = capture(() => cmdVerify([evalFile]));
    const out = parseOutput(c);
    assert.equal(out.evidence_complete, true);
  });

  it("T954 — synthesize single eval yields ITERATE", () => {
    setupNodeRun(tmp, "code-review", 1, {
      "eval-security.md": makeEvalMd({ findings: [{ severity: "warning", file: "a.js", line: 1, issue: "warn", fix: "f", reasoning: "r" }] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--node", "code-review", "--run", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "ITERATE");
  });

  it("T955 — synthesize PASS eval yields PASS", () => {
    setupNodeRun(tmp, "code-review", 1, {
      "eval-security.md": makeEvalMd(),
    });
    const c = capture(() => cmdSynthesize([tmp, "--node", "code-review", "--run", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "PASS");
  });

  it("T956 — gate PASS edge transitions to null (done)", () => {
    const edges = FLOW_TEMPLATES["quick-review"].edges;
    assert.equal(edges["gate"].PASS, null);
  });

  it("T957 — verify then synthesize pipeline", () => {
    const evalFile = join(tmp, "eval-sec.md");
    writeFileSync(evalFile, makeEvalMd({
      findings: [{ severity: "suggestion", file: "a.js", line: 1, issue: "hint", fix: "f", reasoning: "r" }],
    }));
    const v = capture(() => cmdVerify([evalFile]));
    const vOut = parseOutput(v);
    assert.equal(vOut.evidence_complete, true);

    // Now synthesize
    setupNodeRun(tmp, "gate", 1, { "eval-sec.md": readFileSync(evalFile, "utf8") });
    writeFileSync(join(tmp, "nodes", "gate", "run_1", "eval-sec.md"), readFileSync(evalFile));
    const s = capture(() => cmdSynthesize([tmp, "--node", "gate", "--run", "1"]));
    const sOut = parseOutput(s);
    assert.equal(sOut.verdict, "PASS");
  });

  it("T958 — full pipeline: verify + synthesize + report", () => {
    const projectDir = join(tmp, "project");
    mkdirSync(projectDir);
    setupWaveEvals(projectDir, 1, {
      security: makeEvalMd({ findings: [{ severity: "suggestion", file: "a.js", line: 1, issue: "s", fix: "f", reasoning: "r" }] }),
    });

    // Verify
    const evalFile = join(projectDir, ".harness", "evaluation-wave-1-security.md");
    const v = capture(() => cmdVerify([evalFile]));
    assert.equal(parseOutput(v).evidence_complete, true);

    // Synthesize
    const s = capture(() => cmdSynthesize([projectDir, "--wave", "1"]));
    assert.equal(parseOutput(s).verdict, "PASS");

    // Report
    const r = capture(() => cmdReport([projectDir, "--mode", "quick-review", "--task", "review code"]));
    const rOut = parseOutput(r);
    assert.equal(rOut.mode, "quick-review");
    assert.ok(rOut.agents.length > 0);
  });

  it("T959 — quick-review has no loopbacks", () => {
    const c = capture(() => cmdViz(["--flow", "quick-review", "--json"]));
    const out = parseOutput(c);
    assert.equal(out.loopbacks.length, 0);
  });

  it("T960 — visualization matches template node count", () => {
    const c = capture(() => cmdViz(["--flow", "quick-review", "--json"]));
    const out = parseOutput(c);
    assert.equal(out.nodes.length, FLOW_TEMPLATES["quick-review"].nodes.length);
  });
});

// ══════════════════════════════════════════════════════════════════
// Full flow: build-verify (T961-T970)
// ══════════════════════════════════════════════════════════════════
describe("Full flow: build-verify", () => {
  it("T961 — init at build", () => {
    setupFlowState(tmp, "build-verify", "build");
    const c = capture(() => cmdViz(["--flow", "build-verify", "--dir", tmp, "--json"]));
    const out = parseOutput(c);
    assert.equal(out.nodes.find(n => n.id === "build").status, "▶");
  });

  it("T962 — transition build → code-review → test-verify → gate", () => {
    setupFlowState(tmp, "build-verify", "gate", [
      { nodeId: "build" }, { nodeId: "code-review" }, { nodeId: "test-verify" },
    ]);
    const c = capture(() => cmdViz(["--flow", "build-verify", "--dir", tmp, "--json"]));
    const out = parseOutput(c);
    assert.equal(out.nodes.find(n => n.id === "gate").status, "▶");
    assert.equal(out.nodes.find(n => n.id === "build").status, "✅");
  });

  it("T963 — gate FAIL loops back to build", () => {
    assert.equal(FLOW_TEMPLATES["build-verify"].edges["gate"].FAIL, "build");
  });

  it("T964 — gate ITERATE loops back to build", () => {
    assert.equal(FLOW_TEMPLATES["build-verify"].edges["gate"].ITERATE, "build");
  });

  it("T965 — PASS path completes to null", () => {
    assert.equal(FLOW_TEMPLATES["build-verify"].edges["gate"].PASS, null);
  });

  it("T966 — synthesize FAIL triggers loop concept", () => {
    setupNodeRun(tmp, "gate", 1, {
      "eval-tester.md": makeEvalMd({ findings: [{ severity: "critical", file: "a.js", line: 1, issue: "crash", fix: "f", reasoning: "r" }] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--node", "gate", "--run", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "FAIL");
  });

  it("T967 — second run after fix yields PASS", () => {
    setupNodeRun(tmp, "gate", 1, {
      "eval-tester.md": makeEvalMd({ findings: [{ severity: "critical", file: "a.js", line: 1, issue: "crash", fix: "f", reasoning: "r" }] }),
    });
    setupNodeRun(tmp, "gate", 2, {
      "eval-tester.md": makeEvalMd(),
    });
    // Auto-selects latest run
    const c = capture(() => cmdSynthesize([tmp, "--node", "gate"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "PASS");
  });

  it("T968 — diff between run 1 and run 2", () => {
    const r1File = join(tmp, "r1.md");
    const r2File = join(tmp, "r2.md");
    writeFileSync(r1File, makeEvalMd({ findings: [{ severity: "critical", file: "a.js", line: 1, issue: "crash bug", fix: "f", reasoning: "r" }] }));
    writeFileSync(r2File, makeEvalMd());
    const c = capture(() => cmdDiff([r1File, r2File]));
    const out = parseOutput(c);
    assert.equal(out.resolved, 1);
    assert.equal(out.new, 0);
  });

  it("T969 — loopbacks visible in viz", () => {
    const c = capture(() => cmdViz(["--flow", "build-verify", "--json"]));
    const out = parseOutput(c);
    assert.ok(out.loopbacks.some(lb => lb.gate === "gate" && lb.target === "build"));
  });

  it("T970 — report for build-verify mode", () => {
    const projectDir = join(tmp, "project");
    mkdirSync(projectDir);
    setupWaveEvals(projectDir, 1, {
      tester: makeEvalMd({
        findings: [{ severity: "warning", file: "main.js", line: 10, issue: "no test", fix: "add test", reasoning: "coverage" }],
      }),
    });
    const c = capture(() => cmdReport([projectDir, "--mode", "build-verify", "--task", "add feature"]));
    const out = parseOutput(c);
    assert.equal(out.mode, "build-verify");
    assert.equal(out.summary.warning, 1);
  });
});

// ══════════════════════════════════════════════════════════════════
// Oscillation detection (T971-T975)
// ══════════════════════════════════════════════════════════════════
describe("Oscillation detection", () => {
  it("T971 — two rounds with 100% recurring findings triggers oscillation", () => {
    const findings = [
      { severity: "warning", file: "a.js", line: 1, issue: "recurring bug", fix: "f", reasoning: "r" },
      { severity: "warning", file: "b.js", line: 2, issue: "another recurring", fix: "f", reasoning: "r" },
    ];
    const f1 = join(tmp, "r1.md");
    const f2 = join(tmp, "r2.md");
    writeFileSync(f1, makeEvalMd({ findings }));
    writeFileSync(f2, makeEvalMd({ findings }));
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.oscillation, true);
  });

  it("T972 — diff detects oscillation at boundary", () => {
    // 4 out of 6 = 66.7% > 60%
    const shared = Array.from({ length: 4 }, (_, i) => ({
      severity: "warning", file: `s${i}.js`, line: 1, issue: `shared ${i}`, fix: "f", reasoning: "r",
    }));
    const extra = Array.from({ length: 2 }, (_, i) => ({
      severity: "warning", file: `e${i}.js`, line: 1, issue: `extra ${i}`, fix: "f", reasoning: "r",
    }));
    const f1 = join(tmp, "r1.md");
    const f2 = join(tmp, "r2.md");
    writeFileSync(f1, makeEvalMd({ findings: [...shared, ...extra] }));
    writeFileSync(f2, makeEvalMd({ findings: shared }));
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.oscillation, true);
  });

  it("T973 — no oscillation when all findings resolved", () => {
    const f1 = join(tmp, "r1.md");
    const f2 = join(tmp, "r2.md");
    writeFileSync(f1, makeEvalMd({ findings: [{ severity: "warning", file: "a.js", line: 1, issue: "old", fix: "f", reasoning: "r" }] }));
    writeFileSync(f2, makeEvalMd({ findings: [{ severity: "warning", file: "b.js", line: 1, issue: "new", fix: "f", reasoning: "r" }] }));
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.oscillation, false);
  });

  it("T974 — recurring_details lists oscillating items", () => {
    const findings = [{ severity: "warning", file: "a.js", line: 1, issue: "stuck bug", fix: "f", reasoning: "r" }];
    const f1 = join(tmp, "r1.md");
    const f2 = join(tmp, "r2.md");
    writeFileSync(f1, makeEvalMd({ findings }));
    writeFileSync(f2, makeEvalMd({ findings }));
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring_details.length, 1);
    assert.equal(out.recurring_details[0].file, "a.js");
  });

  it("T975 — severity changes tracked in recurring_details", () => {
    const f1 = join(tmp, "r1.md");
    const f2 = join(tmp, "r2.md");
    writeFileSync(f1, makeEvalMd({ findings: [{ severity: "warning", file: "a.js", line: 1, issue: "issue", fix: "f", reasoning: "r" }] }));
    writeFileSync(f2, makeEvalMd({ findings: [{ severity: "critical", file: "a.js", line: 1, issue: "issue", fix: "f", reasoning: "r" }] }));
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring_details[0].severity_changed, true);
  });
});

// ══════════════════════════════════════════════════════════════════
// Report generation (T976-T985)
// ══════════════════════════════════════════════════════════════════
describe("Report generation", () => {
  it("T976 — full pipeline report with all fields", () => {
    const projectDir = join(tmp, "proj");
    mkdirSync(projectDir);
    setupWaveEvals(projectDir, 1, {
      security: makeEvalMd({ findings: [
        { severity: "critical", file: "auth.js", line: 5, issue: "SQL injection", fix: "use parameterized", reasoning: "OWASP" },
        { severity: "warning", file: "auth.js", line: 10, issue: "weak hash", fix: "use bcrypt", reasoning: "security" },
      ] }),
      perf: makeEvalMd({ findings: [
        { severity: "suggestion", file: "db.js", line: 20, issue: "N+1 query", fix: "batch", reasoning: "perf" },
      ] }),
    });
    const c = capture(() => cmdReport([projectDir, "--mode", "full-stack", "--task", "implement auth", "--challenged", "1", "--dismissed", "0", "--downgraded", "1"]));
    const out = parseOutput(c);
    assert.equal(out.agents.length, 2);
    assert.equal(out.coordinator.challenged, 1);
    assert.equal(out.coordinator.downgraded, 1);
    assert.equal(out.summary.critical, 1);
    assert.equal(out.summary.warning, 1);
    assert.equal(out.summary.suggestion, 1);
  });

  it("T977 — report scope shows unique files", () => {
    const projectDir = join(tmp, "proj");
    mkdirSync(projectDir);
    setupWaveEvals(projectDir, 1, {
      sec: makeEvalMd({ findings: [
        { severity: "warning", file: "a.js", line: 1, issue: "w1", fix: "f", reasoning: "r" },
        { severity: "warning", file: "a.js", line: 5, issue: "w2", fix: "f", reasoning: "r" },
        { severity: "warning", file: "b.js", line: 1, issue: "w3", fix: "f", reasoning: "r" },
      ] }),
    });
    const c = capture(() => cmdReport([projectDir, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.agents[0].scope.length, 2);
  });

  it("T978 — report with zero findings", () => {
    const projectDir = join(tmp, "proj");
    mkdirSync(projectDir);
    setupWaveEvals(projectDir, 1, { sec: makeEvalMd() });
    const c = capture(() => cmdReport([projectDir, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.summary.critical, 0);
    assert.equal(out.summary.warning, 0);
    assert.equal(out.summary.suggestion, 0);
  });

  it("T979 — report timestamp is recent", () => {
    const projectDir = join(tmp, "proj");
    mkdirSync(projectDir);
    setupWaveEvals(projectDir, 1, { sec: makeEvalMd() });
    const c = capture(() => cmdReport([projectDir, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    const ts = new Date(out.timestamp);
    const now = new Date();
    assert.ok(now - ts < 5000);
  });

  it("T980 — report has version 1.0", () => {
    const projectDir = join(tmp, "proj");
    mkdirSync(projectDir);
    setupWaveEvals(projectDir, 1, { sec: makeEvalMd() });
    const c = capture(() => cmdReport([projectDir, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.version, "1.0");
  });

  it("T981 — multi-wave report includes all agents", () => {
    const projectDir = join(tmp, "proj");
    mkdirSync(projectDir);
    const hd = join(projectDir, ".harness");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "evaluation-wave-1-sec.md"), makeEvalMd());
    writeFileSync(join(hd, "evaluation-wave-2-perf.md"), makeEvalMd());
    const c = capture(() => cmdReport([projectDir, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.agents.length, 2);
  });

  it("T982 — report findings have all required fields", () => {
    const projectDir = join(tmp, "proj");
    mkdirSync(projectDir);
    setupWaveEvals(projectDir, 1, {
      sec: makeEvalMd({ findings: [{ severity: "warning", file: "a.js", line: 1, issue: "w", fix: "f", reasoning: "r" }] }),
    });
    const c = capture(() => cmdReport([projectDir, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    const f = out.agents[0].findings[0];
    const required = ["severity", "file", "line", "issue", "fix", "reasoning", "status", "dismissReason"];
    for (const key of required) assert.ok(key in f, `Missing: ${key}`);
  });

  it("T983 — report mode matches input", () => {
    const projectDir = join(tmp, "proj");
    mkdirSync(projectDir);
    setupWaveEvals(projectDir, 1, { sec: makeEvalMd() });
    const c = capture(() => cmdReport([projectDir, "--mode", "build-verify", "--task", "test task"]));
    const out = parseOutput(c);
    assert.equal(out.mode, "build-verify");
    assert.equal(out.task, "test task");
  });

  it("T984 — report agent verdict included", () => {
    const projectDir = join(tmp, "proj");
    mkdirSync(projectDir);
    setupWaveEvals(projectDir, 1, {
      sec: makeEvalMd({ verdict: "FAIL", findings: [{ severity: "critical", file: "a.js", line: 1, issue: "c", fix: "f", reasoning: "r" }] }),
    });
    const c = capture(() => cmdReport([projectDir, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.ok(out.agents[0].verdict.includes("FAIL"));
  });

  it("T985 — report is valid JSON", () => {
    const projectDir = join(tmp, "proj");
    mkdirSync(projectDir);
    setupWaveEvals(projectDir, 1, { sec: makeEvalMd() });
    const c = capture(() => cmdReport([projectDir, "--mode", "m", "--task", "t"]));
    assert.doesNotThrow(() => JSON.parse(c.output));
  });
});

// ══════════════════════════════════════════════════════════════════
// Replay data (T986-T990)
// ══════════════════════════════════════════════════════════════════
describe("Replay data", () => {
  it("T986 — full flow produces valid replay JSON", () => {
    setupFlowState(tmp, "build-verify", "gate", [
      { nodeId: "build" }, { nodeId: "code-review" }, { nodeId: "test-verify" },
    ]);
    setupHandshake(tmp, "build", { status: "done", verdict: "PASS" });
    setupHandshake(tmp, "code-review", { status: "done", verdict: "PASS" });
    setupNodeRun(tmp, "code-review", 1, { "eval-sec.md": makeEvalMd() });

    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.equal(out.flowTemplate, "build-verify");
    assert.equal(out.nodes.length, 4);
    assert.ok("build" in out.handshakes);
    assert.ok("code-review" in out.handshakes);
  });

  it("T987 — replay data includes run file details", () => {
    setupFlowState(tmp, "quick-review", "gate", [{ nodeId: "code-review" }]);
    setupHandshake(tmp, "code-review", { status: "done" });
    setupNodeRun(tmp, "code-review", 1, { "eval.md": "# Eval content\n" });

    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.ok(out.handshakes["code-review"].details.length > 0);
  });

  it("T988 — replay data edges match template", () => {
    setupFlowState(tmp, "build-verify", "build");
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.deepEqual(out.edges, FLOW_TEMPLATES["build-verify"].edges);
  });

  it("T989 — replay data loopbacks present for build-verify", () => {
    setupFlowState(tmp, "build-verify", "build");
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.ok(out.loopbacks.length > 0);
  });

  it("T990 — replay data history matches state", () => {
    const history = [{ nodeId: "build", ts: "t1" }, { nodeId: "code-review", ts: "t2" }];
    setupFlowState(tmp, "build-verify", "test-verify", history);
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.equal(out.history.length, 2);
    assert.equal(out.history[0].nodeId, "build");
  });
});

// ══════════════════════════════════════════════════════════════════
// Error recovery (T991-T1000)
// ══════════════════════════════════════════════════════════════════
describe("Error recovery", () => {
  it("T991 — corrupted flow-state.json handled", () => {
    writeFileSync(join(tmp, "flow-state.json"), "{{broken json");
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(c.exitCode, 1);
  });

  it("T992 — missing eval file in verify", () => {
    const c = capture(() => cmdVerify([join(tmp, "ghost.md")]));
    assert.equal(c.exitCode, 1);
  });

  it("T993 — missing harness dir in synthesize", () => {
    const c = capture(() => cmdSynthesize([join(tmp, "nope"), "--wave", "1"]));
    assert.equal(c.exitCode, 1);
  });

  it("T994 — empty node run dir in synthesize", () => {
    const runDir = join(tmp, "nodes", "gate", "run_1");
    mkdirSync(runDir, { recursive: true });
    const c = capture(() => cmdSynthesize([tmp, "--node", "gate", "--run", "1"]));
    assert.equal(c.exitCode, 1);
  });

  it("T995 — missing harness dir in report", () => {
    const c = capture(() => cmdReport([join(tmp, "nope"), "--mode", "m", "--task", "t"]));
    assert.equal(c.exitCode, 1);
  });

  it("T996 — diff with one missing file returns error JSON", () => {
    const f1 = join(tmp, "r1.md");
    writeFileSync(f1, makeEvalMd());
    const c = capture(() => cmdDiff([f1, join(tmp, "ghost.md")]));
    const out = parseOutput(c);
    assert.ok(out.error);
  });

  it("T997 — unknown flow template in replay exits 1", () => {
    writeFileSync(join(tmp, "flow-state.json"), JSON.stringify({ flowTemplate: "bogus" }));
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(c.exitCode, 1);
  });

  it("T998 — viz with unknown template exits 1", () => {
    const c = capture(() => cmdViz(["--flow", "bogus", "--json"]));
    assert.equal(c.exitCode, 1);
  });

  it("T999 — verify handles file with only whitespace", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "   \n\n   \n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.findings_count, 0);
  });

  it("T1000 — synthesize handles eval file with no findings", () => {
    setupNodeRun(tmp, "gate", 1, {
      "eval-sec.md": "# Evaluation\n\nVERDICT: PASS FINDINGS[0]\n",
    });
    const c = capture(() => cmdSynthesize([tmp, "--node", "gate", "--run", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "PASS");
    assert.equal(out.totals.critical, 0);
  });
});
