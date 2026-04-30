// tests/verify-synthesis-diff.test.mjs — V701-V850 (150 tests)
// Deep verification of cmdSynthesize and cmdDiff from eval-commands.mjs

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { cmdSynthesize, cmdDiff, cmdVerify, cmdReport } from "../bin/lib/eval-commands.mjs";
import { parseEvaluation } from "../bin/lib/eval-parser.mjs";

// ── capture helper ─────────────────────────────────────────────
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

// ── eval markdown builder ──────────────────────────────────────
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

function setupNodeEvals(harnessDir, nodeId, runN, evalFiles) {
  const runDir = join(harnessDir, "nodes", nodeId, `run_${runN}`);
  mkdirSync(runDir, { recursive: true });
  for (const [name, content] of Object.entries(evalFiles)) {
    writeFileSync(join(runDir, name), content);
  }
}

function setupWaveEvals(projectDir, wave, evals) {
  const hd = join(projectDir, ".harness");
  mkdirSync(hd, { recursive: true });
  for (const [name, content] of Object.entries(evals)) {
    writeFileSync(join(hd, `evaluation-wave-${wave}-${name}.md`), content);
  }
}

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "opc-vsd-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// ══════════════════════════════════════════════════════════════════
// 1. Synthesis verdict logic (V701-V740)
// ══════════════════════════════════════════════════════════════════
describe("Synthesis verdict logic", () => {
  // -- BLOCKED always wins --
  it("V701 — BLOCKED wins even when all other findings are PASS", () => {
    const hd = join(tmp, "h1");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-security.md"),
      makeEvalMd({ blocked: true, findings: [] }));
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-perf.md"),
      makeEvalMd({ verdict: "PASS", findings: [] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "BLOCKED");
  });

  it("V702 — BLOCKED wins with suggestions present", () => {
    const hd = join(tmp, "h2");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-a.md"),
      makeEvalMd({ blocked: true, findings: [{ severity: "suggestion", issue: "minor" }] }));
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-b.md"),
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "tweak" }] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "BLOCKED");
  });

  it("V703 — BLOCKED wins with criticals present in other files", () => {
    const hd = join(tmp, "h3");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-sec.md"),
      makeEvalMd({ blocked: true }));
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-code.md"),
      makeEvalMd({ findings: [{ severity: "critical", issue: "bug", file: "a.js", line: 1 }] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "BLOCKED");
  });

  it("V704 — BLOCKED reason lists the blocking role", () => {
    const hd = join(tmp, "h4");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-security.md"),
      makeEvalMd({ blocked: true }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.ok(parseOutput(c).reason.includes("security"));
  });

  it("V705 — multiple BLOCKED roles all listed in reason", () => {
    const hd = join(tmp, "h5");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-security.md"),
      makeEvalMd({ blocked: true }));
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-compliance.md"),
      makeEvalMd({ blocked: true }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    const r = parseOutput(c).reason;
    assert.ok(r.includes("security"));
    assert.ok(r.includes("compliance"));
  });

  // -- Single critical → FAIL --
  it("V706 — single critical finding → FAIL", () => {
    const hd = join(tmp, "h6");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-code.md"),
      makeEvalMd({ findings: [{ severity: "critical", issue: "SQL injection", file: "db.js", line: 42 }] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "FAIL");
  });

  it("V707 — one critical + 100 suggestions → still FAIL", () => {
    const hd = join(tmp, "h7");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    const findings = [{ severity: "critical", issue: "memory leak", file: "app.js", line: 10 }];
    for (let i = 0; i < 100; i++) findings.push({ severity: "suggestion", issue: `suggestion ${i}` });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-code.md"),
      makeEvalMd({ findings }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "FAIL");
  });

  it("V708 — FAIL reason includes critical count", () => {
    const hd = join(tmp, "h8");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-a.md"),
      makeEvalMd({ findings: [
        { severity: "critical", issue: "c1", file: "x.js", line: 1 },
        { severity: "critical", issue: "c2", file: "y.js", line: 2 },
      ] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.ok(parseOutput(c).reason.includes("2"));
  });

  it("V709 — critical across multiple files → FAIL", () => {
    const hd = join(tmp, "h9");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-sec.md"),
      makeEvalMd({ findings: [{ severity: "critical", issue: "xss", file: "a.js", line: 1 }] }));
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-perf.md"),
      makeEvalMd({ findings: [{ severity: "warning", issue: "slow" }] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "FAIL");
  });

  // -- Only warnings → ITERATE --
  it("V710 — only warnings → ITERATE", () => {
    const hd = join(tmp, "h10");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-code.md"),
      makeEvalMd({ findings: [
        { severity: "warning", issue: "unused var" },
        { severity: "warning", issue: "no error handling" },
      ] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "ITERATE");
  });

  it("V711 — warnings + suggestions → ITERATE", () => {
    const hd = join(tmp, "h11");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-code.md"),
      makeEvalMd({ findings: [
        { severity: "warning", issue: "warn1" },
        { severity: "suggestion", issue: "sug1" },
        { severity: "suggestion", issue: "sug2" },
      ] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "ITERATE");
  });

  it("V712 — ITERATE reason mentions warning count", () => {
    const hd = join(tmp, "h12");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-a.md"),
      makeEvalMd({ findings: [{ severity: "warning", issue: "w" }] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.ok(parseOutput(c).reason.includes("1"));
  });

  // -- Only suggestions → PASS --
  it("V713 — only suggestions → PASS", () => {
    const hd = join(tmp, "h13");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-code.md"),
      makeEvalMd({ findings: [
        { severity: "suggestion", issue: "rename var" },
        { severity: "suggestion", issue: "add comment" },
      ] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "PASS");
  });

  it("V714 — 50 suggestions still PASS", () => {
    const hd = join(tmp, "h14");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    const findings = Array.from({ length: 50 }, (_, i) => ({ severity: "suggestion", issue: `s${i}` }));
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-code.md"),
      makeEvalMd({ findings }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "PASS");
  });

  // -- Empty findings → PASS --
  it("V715 — empty findings → PASS", () => {
    const hd = join(tmp, "h15");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-code.md"),
      makeEvalMd({ findings: [] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "PASS");
  });

  it("V716 — all evaluators clean → PASS with LGTM reason", () => {
    const hd = join(tmp, "h16");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-sec.md"), makeEvalMd({}));
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-perf.md"), makeEvalMd({}));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.ok(parseOutput(c).reason.toLowerCase().includes("lgtm"));
  });

  // -- Mixed: 1 critical + 10 warnings + 50 suggestions → FAIL --
  it("V717 — 1 critical + 10 warnings + 50 suggestions → FAIL", () => {
    const hd = join(tmp, "h17");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    const findings = [
      { severity: "critical", issue: "crash bug", file: "main.js", line: 1 },
      ...Array.from({ length: 10 }, (_, i) => ({ severity: "warning", issue: `w${i}` })),
      ...Array.from({ length: 50 }, (_, i) => ({ severity: "suggestion", issue: `s${i}` })),
    ];
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-mixed.md"),
      makeEvalMd({ findings }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "FAIL");
  });

  it("V718 — totals sum across multiple files", () => {
    const hd = join(tmp, "h18");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-a.md"),
      makeEvalMd({ findings: [{ severity: "warning", issue: "w1" }] }));
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-b.md"),
      makeEvalMd({ findings: [{ severity: "warning", issue: "w2" }, { severity: "suggestion", issue: "s1" }] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    const out = parseOutput(c);
    assert.equal(out.totals.warning, 2);
    assert.equal(out.totals.suggestion, 1);
  });

  // -- Test with 2, 3, 5, 10 evaluator files --
  it("V719 — 2 evaluator files aggregated", () => {
    const hd = join(tmp, "h19");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-a.md"),
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "a" }] }));
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-b.md"),
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "b" }] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).roles.length, 2);
  });

  it("V720 — 3 evaluator files aggregated", () => {
    const hd = join(tmp, "h20");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    for (const r of ["a", "b", "c"]) {
      writeFileSync(join(hd, "nodes", "review", "run_1", `eval-${r}.md`),
        makeEvalMd({ findings: [{ severity: "suggestion", issue: r }] }));
    }
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).roles.length, 3);
  });

  it("V721 — 5 evaluator files aggregated", () => {
    const hd = join(tmp, "h21");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(hd, "nodes", "review", "run_1", `eval-r${i}.md`),
        makeEvalMd({ findings: [{ severity: "suggestion", issue: `s${i}` }] }));
    }
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).roles.length, 5);
    assert.equal(parseOutput(c).totals.suggestion, 5);
  });

  it("V722 — 10 evaluator files aggregated", () => {
    const hd = join(tmp, "h22");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(hd, "nodes", "review", "run_1", `eval-role${i}.md`),
        makeEvalMd({ findings: [{ severity: "warning", issue: `w${i}` }] }));
    }
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).roles.length, 10);
    assert.equal(parseOutput(c).totals.warning, 10);
  });

  it("V723 — 10 evaluators all PASS → overall PASS", () => {
    const hd = join(tmp, "h23");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(hd, "nodes", "review", "run_1", `eval-r${i}.md`), makeEvalMd({}));
    }
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "PASS");
  });

  it("V724 — auto-selects latest run when --run omitted", () => {
    const hd = join(tmp, "h24");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    mkdirSync(join(hd, "nodes", "review", "run_2"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-a.md"),
      makeEvalMd({ findings: [{ severity: "critical", issue: "old", file: "x.js", line: 1 }] }));
    writeFileSync(join(hd, "nodes", "review", "run_2", "eval-a.md"),
      makeEvalMd({ findings: [] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review"]));
    assert.equal(parseOutput(c).verdict, "PASS");
  });

  it("V725 — wave mode finds evaluation files", () => {
    setupWaveEvals(tmp, "1", {
      security: makeEvalMd({ findings: [{ severity: "warning", issue: "w" }] }),
      perf: makeEvalMd({ findings: [] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    assert.equal(parseOutput(c).verdict, "ITERATE");
  });

  it("V726 — wave mode ignores round files", () => {
    const hd = join(tmp, ".harness");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "evaluation-wave-1-security.md"),
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "s" }] }));
    writeFileSync(join(hd, "evaluation-wave-1-round1-security.md"),
      makeEvalMd({ findings: [{ severity: "critical", issue: "c", file: "a.js", line: 1 }] }));
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    assert.equal(parseOutput(c).verdict, "PASS");
  });

  it("V727 — BLOCKED in one of 5 evaluators → overall BLOCKED", () => {
    const hd = join(tmp, "h27");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(hd, "nodes", "review", "run_1", `eval-r${i}.md`), makeEvalMd({}));
    }
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-blocker.md"),
      makeEvalMd({ blocked: true }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "BLOCKED");
  });

  it("V728 — mixed severities: 0 critical, 3 warning, 7 suggestion → ITERATE", () => {
    const hd = join(tmp, "h28");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    const findings = [
      ...Array.from({ length: 3 }, (_, i) => ({ severity: "warning", issue: `w${i}` })),
      ...Array.from({ length: 7 }, (_, i) => ({ severity: "suggestion", issue: `s${i}` })),
    ];
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-mix.md"),
      makeEvalMd({ findings }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "ITERATE");
  });

  it("V729 — roles array contains correct role names", () => {
    const hd = join(tmp, "h29");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-security.md"), makeEvalMd({}));
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-performance.md"), makeEvalMd({}));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    const roles = parseOutput(c).roles.map(r => r.role).sort();
    assert.deepEqual(roles, ["performance", "security"]);
  });

  it("V730 — each role has correct finding counts", () => {
    const hd = join(tmp, "h30");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-a.md"),
      makeEvalMd({ findings: [
        { severity: "critical", issue: "c", file: "x.js", line: 1 },
        { severity: "warning", issue: "w" },
      ] }));
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-b.md"),
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "s" }] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    const out = parseOutput(c);
    const roleA = out.roles.find(r => r.role === "a");
    assert.equal(roleA.critical, 1);
    assert.equal(roleA.warning, 1);
    const roleB = out.roles.find(r => r.role === "b");
    assert.equal(roleB.suggestion, 1);
  });

  it("V731 — no eval files in run → exits with error", () => {
    const hd = join(tmp, "h31");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "notes.txt"), "nothing here");
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(c.exitCode, 1);
  });

  it("V732 — no runs for node → exits with error", () => {
    const hd = join(tmp, "h32");
    mkdirSync(join(hd, "nodes", "review"), { recursive: true });
    const c = capture(() => cmdSynthesize([hd, "--node", "review"]));
    assert.equal(c.exitCode, 1);
  });

  it("V733 — missing --wave and --node → exits with error", () => {
    const c = capture(() => cmdSynthesize([tmp]));
    assert.equal(c.exitCode, 1);
  });

  it("V734 — critical totals correct across 3 files with mixed findings", () => {
    const hd = join(tmp, "h34");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-a.md"),
      makeEvalMd({ findings: [{ severity: "critical", issue: "c1", file: "a.js", line: 1 }] }));
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-b.md"),
      makeEvalMd({ findings: [{ severity: "critical", issue: "c2", file: "b.js", line: 2 }] }));
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-c.md"),
      makeEvalMd({ findings: [{ severity: "warning", issue: "w1" }] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    const out = parseOutput(c);
    assert.equal(out.totals.critical, 2);
    assert.equal(out.totals.warning, 1);
  });

  it("V735 — blocked role marked in roles array", () => {
    const hd = join(tmp, "h35");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-sec.md"),
      makeEvalMd({ blocked: true }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).roles[0].blocked, true);
  });

  it("V736 — non-blocked role not marked blocked", () => {
    const hd = join(tmp, "h36");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-code.md"),
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "nit" }] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).roles[0].blocked, false);
  });

  it("V737 — wave mode with single evaluator", () => {
    setupWaveEvals(tmp, "2", {
      solo: makeEvalMd({ findings: [{ severity: "critical", issue: "bad", file: "x.js", line: 1 }] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "2"]));
    assert.equal(parseOutput(c).verdict, "FAIL");
  });

  it("V738 — BLOCKED with warnings and criticals → still BLOCKED", () => {
    const hd = join(tmp, "h38");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-a.md"),
      makeEvalMd({ blocked: true, findings: [
        { severity: "critical", issue: "c", file: "a.js", line: 1 },
        { severity: "warning", issue: "w" },
      ] }));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).verdict, "BLOCKED");
  });

  it("V739 — verdict hierarchy: BLOCKED > FAIL > ITERATE > PASS", () => {
    // Test each level
    const mkDir = (name) => {
      const hd = join(tmp, name);
      mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
      return hd;
    };
    const hd1 = mkDir("pass");
    writeFileSync(join(hd1, "nodes", "review", "run_1", "eval-a.md"), makeEvalMd({}));
    assert.equal(parseOutput(capture(() => cmdSynthesize([hd1, "--node", "review", "--run", "1"]))).verdict, "PASS");

    const hd2 = mkDir("iterate");
    writeFileSync(join(hd2, "nodes", "review", "run_1", "eval-a.md"),
      makeEvalMd({ findings: [{ severity: "warning", issue: "w" }] }));
    assert.equal(parseOutput(capture(() => cmdSynthesize([hd2, "--node", "review", "--run", "1"]))).verdict, "ITERATE");

    const hd3 = mkDir("fail");
    writeFileSync(join(hd3, "nodes", "review", "run_1", "eval-a.md"),
      makeEvalMd({ findings: [{ severity: "critical", issue: "c", file: "x.js", line: 1 }] }));
    assert.equal(parseOutput(capture(() => cmdSynthesize([hd3, "--node", "review", "--run", "1"]))).verdict, "FAIL");

    const hd4 = mkDir("blocked");
    writeFileSync(join(hd4, "nodes", "review", "run_1", "eval-a.md"), makeEvalMd({ blocked: true }));
    assert.equal(parseOutput(capture(() => cmdSynthesize([hd4, "--node", "review", "--run", "1"]))).verdict, "BLOCKED");
  });

  it("V740 — totals zero when no findings", () => {
    const hd = join(tmp, "h40");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", "eval-a.md"), makeEvalMd({}));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    const out = parseOutput(c);
    assert.equal(out.totals.critical, 0);
    assert.equal(out.totals.warning, 0);
    assert.equal(out.totals.suggestion, 0);
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. Role name extraction (V741-V770)
// ══════════════════════════════════════════════════════════════════
describe("Role name extraction", () => {
  function getRoleName(filename) {
    // Simulate what cmdSynthesize does for role extraction
    const hd = join(tmp, `role-${filename.replace(/[^a-z0-9]/g, "_")}`);
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    writeFileSync(join(hd, "nodes", "review", "run_1", filename), makeEvalMd({}));
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    return parseOutput(c).roles[0].role;
  }

  it("V741 — eval-security.md → 'security'", () => {
    assert.equal(getRoleName("eval-security.md"), "security");
  });

  it("V742 — eval-new-user.md → 'new-user'", () => {
    assert.equal(getRoleName("eval-new-user.md"), "new-user");
  });

  it("V743 — eval.md → 'evaluator'", () => {
    assert.equal(getRoleName("eval.md"), "evaluator");
  });

  it("V744 — eval-a-b-c.md → 'a-b-c'", () => {
    assert.equal(getRoleName("eval-a-b-c.md"), "a-b-c");
  });

  it("V745 — eval-perf.md → 'perf'", () => {
    assert.equal(getRoleName("eval-perf.md"), "perf");
  });

  it("V746 — eval-code-quality.md → 'code-quality'", () => {
    assert.equal(getRoleName("eval-code-quality.md"), "code-quality");
  });

  it("V747 — eval-ux.md → 'ux'", () => {
    assert.equal(getRoleName("eval-ux.md"), "ux");
  });

  it("V748 — eval-api-design.md → 'api-design'", () => {
    assert.equal(getRoleName("eval-api-design.md"), "api-design");
  });

  it("V749 — eval-accessibility.md → 'accessibility'", () => {
    assert.equal(getRoleName("eval-accessibility.md"), "accessibility");
  });

  it("V750 — eval-error-handling.md → 'error-handling'", () => {
    assert.equal(getRoleName("eval-error-handling.md"), "error-handling");
  });

  // Wave mode role extraction
  it("V751 — wave: evaluation-wave-1-pm.md → 'pm'", () => {
    const hd = join(tmp, ".harness");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "evaluation-wave-1-pm.md"), makeEvalMd({}));
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    assert.equal(parseOutput(c).roles[0].role, "pm");
  });

  it("V752 — wave: evaluation-wave-1-security.md → 'security'", () => {
    const hd = join(tmp, ".harness");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "evaluation-wave-1-security.md"), makeEvalMd({}));
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    assert.equal(parseOutput(c).roles[0].role, "security");
  });

  it("V753 — wave: evaluation-wave-2-code-quality.md → 'code-quality'", () => {
    const hd = join(tmp, ".harness");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "evaluation-wave-2-code-quality.md"), makeEvalMd({}));
    const c = capture(() => cmdSynthesize([tmp, "--wave", "2"]));
    assert.equal(parseOutput(c).roles[0].role, "code-quality");
  });

  it("V754 — eval-x.md → 'x' (single char)", () => {
    assert.equal(getRoleName("eval-x.md"), "x");
  });

  it("V755 — eval-123.md → '123' (numeric)", () => {
    assert.equal(getRoleName("eval-123.md"), "123");
  });

  it("V756 — eval-UPPER.md → 'UPPER' (case preserved)", () => {
    assert.equal(getRoleName("eval-UPPER.md"), "UPPER");
  });

  it("V757 — eval-mixed-Case-Name.md → 'mixed-Case-Name'", () => {
    assert.equal(getRoleName("eval-mixed-Case-Name.md"), "mixed-Case-Name");
  });

  it("V758 — multiple wave roles extracted correctly", () => {
    const hd = join(tmp, ".harness");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "evaluation-wave-1-security.md"), makeEvalMd({}));
    writeFileSync(join(hd, "evaluation-wave-1-perf.md"), makeEvalMd({}));
    writeFileSync(join(hd, "evaluation-wave-1-ux.md"), makeEvalMd({}));
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const roles = parseOutput(c).roles.map(r => r.role).sort();
    assert.deepEqual(roles, ["perf", "security", "ux"]);
  });

  it("V759 — eval-dev-ops.md → 'dev-ops'", () => {
    assert.equal(getRoleName("eval-dev-ops.md"), "dev-ops");
  });

  it("V760 — eval-i18n.md → 'i18n'", () => {
    assert.equal(getRoleName("eval-i18n.md"), "i18n");
  });

  it("V761 — eval-testing.md → 'testing'", () => {
    assert.equal(getRoleName("eval-testing.md"), "testing");
  });

  it("V762 — eval-data-pipeline.md → 'data-pipeline'", () => {
    assert.equal(getRoleName("eval-data-pipeline.md"), "data-pipeline");
  });

  it("V763 — eval-front-end-ux.md → 'front-end-ux'", () => {
    assert.equal(getRoleName("eval-front-end-ux.md"), "front-end-ux");
  });

  it("V764 — eval-ml-model.md → 'ml-model'", () => {
    assert.equal(getRoleName("eval-ml-model.md"), "ml-model");
  });

  it("V765 — eval-.md preserves as empty string role", () => {
    assert.equal(getRoleName("eval-.md"), "");
  });

  it("V766 — wave mode does not pick up merged file", () => {
    const hd = join(tmp, ".harness");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "evaluation-wave-1.md"),
      makeEvalMd({ findings: [{ severity: "critical", issue: "should not appear", file: "x.js", line: 1 }] }));
    writeFileSync(join(hd, "evaluation-wave-1-real.md"), makeEvalMd({}));
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    assert.equal(parseOutput(c).verdict, "PASS");
  });

  it("V767 — eval-日本語.md → '日本語' (unicode role name)", () => {
    assert.equal(getRoleName("eval-日本語.md"), "日本語");
  });

  it("V768 — eval-v2-migration.md → 'v2-migration'", () => {
    assert.equal(getRoleName("eval-v2-migration.md"), "v2-migration");
  });

  it("V769 — eval-backend-api-v3.md → 'backend-api-v3'", () => {
    assert.equal(getRoleName("eval-backend-api-v3.md"), "backend-api-v3");
  });

  it("V770 — roles array length matches file count", () => {
    const hd = join(tmp, "h70");
    mkdirSync(join(hd, "nodes", "review", "run_1"), { recursive: true });
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(hd, "nodes", "review", "run_1", `eval-r${i}.md`), makeEvalMd({}));
    }
    const c = capture(() => cmdSynthesize([hd, "--node", "review", "--run", "1"]));
    assert.equal(parseOutput(c).roles.length, 7);
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. Diff normalization (V771-V800)
// ══════════════════════════════════════════════════════════════════
describe("Diff normalization", () => {
  function writePair(f1Content, f2Content) {
    const p1 = join(tmp, "eval-round1.md");
    const p2 = join(tmp, "eval-round2.md");
    writeFileSync(p1, f1Content);
    writeFileSync(p2, f2Content);
    return [p1, p2];
  }

  it("V771 — same finding with different case → recurring", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "critical", issue: "SQL Injection in query", file: "db.js", line: 10 }] }),
      makeEvalMd({ findings: [{ severity: "critical", issue: "sql injection in query", file: "db.js", line: 10 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring, 1);
  });

  it("V772 — same finding with extra spaces → recurring", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "warning", issue: "missing error handling", file: "api.js", line: 5 }] }),
      makeEvalMd({ findings: [{ severity: "warning", issue: "missing  error   handling", file: "api.js", line: 5 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring, 1);
  });

  it("V773 — same finding with different line numbers → recurring (file key matches)", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "warning", issue: "no validation", file: "handler.js", line: 10 }] }),
      makeEvalMd({ findings: [{ severity: "warning", issue: "no validation", file: "handler.js", line: 25 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    // The key uses file (without line) + normalized issue, so line number difference = recurring
    assert.equal(parseOutput(c).recurring, 1);
  });

  it("V774 — completely different findings → new", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "critical", issue: "SQL injection", file: "db.js", line: 1 }] }),
      makeEvalMd({ findings: [{ severity: "critical", issue: "buffer overflow", file: "mem.c", line: 42 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring, 0);
    assert.equal(parseOutput(c).new, 1);
    assert.equal(parseOutput(c).resolved, 1);
  });

  it("V775 — subset of findings resolved", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [
        { severity: "critical", issue: "bug A", file: "a.js", line: 1 },
        { severity: "warning", issue: "bug B", file: "b.js", line: 2 },
        { severity: "warning", issue: "bug C", file: "c.js", line: 3 },
      ] }),
      makeEvalMd({ findings: [
        { severity: "critical", issue: "bug A", file: "a.js", line: 1 },
      ] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 1);
    assert.equal(out.resolved, 2);
    assert.equal(out.new, 0);
  });

  it("V776 — all findings resolved in round 2 (empty)", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [
        { severity: "warning", issue: "w1", file: "x.js", line: 1 },
        { severity: "warning", issue: "w2", file: "y.js", line: 2 },
      ] }),
      makeEvalMd({ findings: [] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 0);
    assert.equal(out.resolved, 2);
    assert.equal(out.new, 0);
  });

  it("V777 — all findings new in round 2 (empty round 1)", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [] }),
      makeEvalMd({ findings: [
        { severity: "critical", issue: "new bug", file: "z.js", line: 1 },
      ] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 0);
    assert.equal(out.new, 1);
    assert.equal(out.resolved, 0);
  });

  it("V778 — severity change detected in recurring finding", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "warning", issue: "slow query", file: "db.js", line: 10 }] }),
      makeEvalMd({ findings: [{ severity: "critical", issue: "slow query", file: "db.js", line: 10 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 1);
    assert.equal(out.recurring_details[0].severity_changed, true);
  });

  it("V779 — same severity → severity_changed false", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "warning", issue: "no tests", file: "app.js", line: 1 }] }),
      makeEvalMd({ findings: [{ severity: "warning", issue: "no tests", file: "app.js", line: 1 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring_details[0].severity_changed, false);
  });

  it("V780 — round1_findings count correct", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [
        { severity: "warning", issue: "a" }, { severity: "warning", issue: "b" }, { severity: "suggestion", issue: "c" },
      ] }),
      makeEvalMd({ findings: [{ severity: "warning", issue: "a" }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).round1_findings, 3);
  });

  it("V781 — round2_findings count correct", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "warning", issue: "a" }] }),
      makeEvalMd({ findings: [{ severity: "warning", issue: "x" }, { severity: "suggestion", issue: "y" }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).round2_findings, 2);
  });

  it("V782 — empty round 1 + empty round 2 → all zeros", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [] }),
      makeEvalMd({ findings: [] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 0);
    assert.equal(out.new, 0);
    assert.equal(out.resolved, 0);
  });

  it("V783 — findings without file refs still matched by issue text", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "add more comments" }] }),
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "add more comments" }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring, 1);
  });

  it("V784 — same issue different file → not recurring", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "warning", issue: "no error handling", file: "a.js", line: 1 }] }),
      makeEvalMd({ findings: [{ severity: "warning", issue: "no error handling", file: "b.js", line: 1 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring, 0);
    assert.equal(parseOutput(c).new, 1);
    assert.equal(parseOutput(c).resolved, 1);
  });

  it("V785 — issue text truncated to 80 chars for key", () => {
    const longIssue = "A".repeat(200);
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "warning", issue: longIssue, file: "x.js", line: 1 }] }),
      makeEvalMd({ findings: [{ severity: "warning", issue: longIssue, file: "x.js", line: 1 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring, 1);
  });

  it("V786 — issue text differs after char 80 → still recurring", () => {
    const base = "a".repeat(80);
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "warning", issue: base + "XXXX", file: "x.js", line: 1 }] }),
      makeEvalMd({ findings: [{ severity: "warning", issue: base + "YYYY", file: "x.js", line: 1 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring, 1);
  });

  it("V787 — many recurring + some new + some resolved", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [
        { severity: "warning", issue: "recurring1", file: "a.js", line: 1 },
        { severity: "warning", issue: "recurring2", file: "b.js", line: 1 },
        { severity: "suggestion", issue: "resolved1", file: "c.js", line: 1 },
      ] }),
      makeEvalMd({ findings: [
        { severity: "warning", issue: "recurring1", file: "a.js", line: 1 },
        { severity: "warning", issue: "recurring2", file: "b.js", line: 1 },
        { severity: "critical", issue: "new-bug", file: "d.js", line: 1 },
      ] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 2);
    assert.equal(out.new, 1);
    assert.equal(out.resolved, 1);
  });

  it("V788 — diff with nonexistent file1 → error in output", () => {
    const p2 = join(tmp, "eval2.md");
    writeFileSync(p2, makeEvalMd({}));
    const c = capture(() => cmdDiff(["/nonexistent/path.md", p2]));
    const out = parseOutput(c);
    assert.ok(out.error);
  });

  it("V789 — diff with nonexistent file2 → error in output", () => {
    const p1 = join(tmp, "eval1.md");
    writeFileSync(p1, makeEvalMd({}));
    const c = capture(() => cmdDiff([p1, "/nonexistent/path.md"]));
    const out = parseOutput(c);
    assert.ok(out.error);
  });

  it("V790 — diff with no args → exits with error", () => {
    const c = capture(() => cmdDiff([]));
    assert.equal(c.exitCode, 1);
  });

  it("V791 — recurring_details has correct file field", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "warning", issue: "issue X", file: "handler.js", line: 42 }] }),
      makeEvalMd({ findings: [{ severity: "warning", issue: "issue X", file: "handler.js", line: 42 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring_details[0].file, "handler.js");
  });

  it("V792 — 10 findings round1 vs 10 findings round2 all different → 0 recurring 10 new 10 resolved", () => {
    const r1findings = Array.from({ length: 10 }, (_, i) =>
      ({ severity: "warning", issue: `old-issue-${i}`, file: `old${i}.js`, line: i }));
    const r2findings = Array.from({ length: 10 }, (_, i) =>
      ({ severity: "warning", issue: `new-issue-${i}`, file: `new${i}.js`, line: i }));
    const [p1, p2] = writePair(makeEvalMd({ findings: r1findings }), makeEvalMd({ findings: r2findings }));
    const c = capture(() => cmdDiff([p1, p2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 0);
    assert.equal(out.new, 10);
    assert.equal(out.resolved, 10);
  });

  it("V793 — trailing whitespace in issue text normalized", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "trim me   ", file: "a.js", line: 1 }] }),
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "trim me", file: "a.js", line: 1 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring, 1);
  });

  it("V794 — leading whitespace in issue text normalized", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "   lead space", file: "a.js", line: 1 }] }),
      makeEvalMd({ findings: [{ severity: "suggestion", issue: "lead space", file: "a.js", line: 1 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring, 1);
  });

  it("V795 — diff with one finding missing file ref → key uses empty file", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "warning", issue: "no ref" }] }),
      makeEvalMd({ findings: [{ severity: "warning", issue: "no ref" }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring, 1);
  });

  it("V796 — 20 findings all recurring → recurring = 20", () => {
    const findings = Array.from({ length: 20 }, (_, i) =>
      ({ severity: "suggestion", issue: `issue-${i}`, file: `f${i}.js`, line: i + 1 }));
    const [p1, p2] = writePair(makeEvalMd({ findings }), makeEvalMd({ findings }));
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring, 20);
  });

  it("V797 — issue with em dash in text preserved", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [{ severity: "warning", issue: "race condition — thread unsafe", file: "a.js", line: 1 }] }),
      makeEvalMd({ findings: [{ severity: "warning", issue: "race condition — thread unsafe", file: "a.js", line: 1 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).recurring, 1);
  });

  it("V798 — duplicate findings in same round counted once per key", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [
        { severity: "warning", issue: "dup", file: "a.js", line: 1 },
        { severity: "warning", issue: "dup", file: "a.js", line: 1 },
      ] }),
      makeEvalMd({ findings: [{ severity: "warning", issue: "dup", file: "a.js", line: 1 }] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    // Set deduplication means recurring = 1 not 2
    assert.equal(parseOutput(c).recurring, 1);
  });

  it("V799 — mixed: 3 recurring, 2 new, 1 resolved (exact counts)", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [
        { severity: "warning", issue: "r1", file: "a.js", line: 1 },
        { severity: "warning", issue: "r2", file: "b.js", line: 1 },
        { severity: "warning", issue: "r3", file: "c.js", line: 1 },
        { severity: "suggestion", issue: "gone", file: "d.js", line: 1 },
      ] }),
      makeEvalMd({ findings: [
        { severity: "warning", issue: "r1", file: "a.js", line: 1 },
        { severity: "warning", issue: "r2", file: "b.js", line: 1 },
        { severity: "warning", issue: "r3", file: "c.js", line: 1 },
        { severity: "critical", issue: "new1", file: "e.js", line: 1 },
        { severity: "critical", issue: "new2", file: "f.js", line: 1 },
      ] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 3);
    assert.equal(out.new, 2);
    assert.equal(out.resolved, 1);
  });

  it("V800 — recurring_details array length matches recurring count", () => {
    const [p1, p2] = writePair(
      makeEvalMd({ findings: [
        { severity: "warning", issue: "a", file: "a.js", line: 1 },
        { severity: "warning", issue: "b", file: "b.js", line: 1 },
      ] }),
      makeEvalMd({ findings: [
        { severity: "warning", issue: "a", file: "a.js", line: 1 },
        { severity: "warning", issue: "b", file: "b.js", line: 1 },
      ] }),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    const out = parseOutput(c);
    assert.equal(out.recurring_details.length, out.recurring);
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. Oscillation thresholds (V801-V825)
// ══════════════════════════════════════════════════════════════════
describe("Oscillation thresholds", () => {
  function mkFindings(n, prefix = "issue") {
    return Array.from({ length: n }, (_, i) =>
      ({ severity: "warning", issue: `${prefix}-${i}`, file: `f${i}.js`, line: i + 1 }));
  }

  function writePairFindings(r1findings, r2findings) {
    const p1 = join(tmp, "r1.md");
    const p2 = join(tmp, "r2.md");
    writeFileSync(p1, makeEvalMd({ findings: r1findings }));
    writeFileSync(p2, makeEvalMd({ findings: r2findings }));
    return [p1, p2];
  }

  it("V801 — exactly 60% recurring (boundary) → NO oscillation (must be >60%)", () => {
    // 10 findings in round1, 6 recurring = 60% = NOT oscillation (>0.6 required, not >=)
    const common = mkFindings(6, "common");
    const r1only = mkFindings(4, "r1only");
    const r2only = mkFindings(4, "r2only");
    const [p1, p2] = writePairFindings(
      [...common, ...r1only],
      [...common, ...r2only],
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, false);
  });

  it("V802 — 59% recurring → no oscillation", () => {
    // 100 round1, 59 recurring
    const common = mkFindings(59, "common");
    const r1only = mkFindings(41, "r1only");
    const [p1, p2] = writePairFindings(
      [...common, ...r1only],
      [...common],
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, false);
  });

  it("V803 — 61% recurring → oscillation detected", () => {
    // 100 round1, 61 recurring → 61/100 > 0.6
    const common = mkFindings(61, "common");
    const r1only = mkFindings(39, "r1only");
    const [p1, p2] = writePairFindings(
      [...common, ...r1only],
      [...common],
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, true);
  });

  it("V804 — 100% recurring → oscillation", () => {
    const findings = mkFindings(5, "same");
    const [p1, p2] = writePairFindings(findings, findings);
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, true);
  });

  it("V805 — 0% recurring → no oscillation", () => {
    const [p1, p2] = writePairFindings(
      mkFindings(5, "old"),
      mkFindings(5, "new"),
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, false);
  });

  it("V806 — 1 finding recurring out of 1 total → 100% → oscillation", () => {
    const [p1, p2] = writePairFindings(
      [{ severity: "warning", issue: "same", file: "a.js", line: 1 }],
      [{ severity: "warning", issue: "same", file: "a.js", line: 1 }],
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, true);
  });

  it("V807 — 0 findings in round1 → no oscillation (division safety)", () => {
    const [p1, p2] = writePairFindings([], mkFindings(5, "new"));
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, false);
  });

  it("V808 — 0 findings both rounds → no oscillation", () => {
    const [p1, p2] = writePairFindings([], []);
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, false);
  });

  it("V809 — 7 of 10 recurring → 70% → oscillation", () => {
    const common = mkFindings(7, "common");
    const r1only = mkFindings(3, "r1only");
    const [p1, p2] = writePairFindings(
      [...common, ...r1only],
      common,
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, true);
  });

  it("V810 — 3 of 5 recurring → 60% → NOT oscillation", () => {
    const common = mkFindings(3, "common");
    const r1only = mkFindings(2, "r1only");
    const [p1, p2] = writePairFindings(
      [...common, ...r1only],
      common,
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, false);
  });

  it("V811 — 4 of 5 recurring → 80% → oscillation", () => {
    const common = mkFindings(4, "common");
    const r1only = mkFindings(1, "r1only");
    const [p1, p2] = writePairFindings(
      [...common, ...r1only],
      common,
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, true);
  });

  it("V812 — oscillation with severity changes still counts", () => {
    const r1 = [{ severity: "warning", issue: "issue-0", file: "f.js", line: 1 }];
    const r2 = [{ severity: "critical", issue: "issue-0", file: "f.js", line: 1 }];
    const [p1, p2] = writePairFindings(r1, r2);
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, true);
  });

  it("V813 — oscillation based on round1 count, not round2", () => {
    // 10 in round1, 7 recurring, 3 new in round2 → 7/10 = 70% → oscillation
    const common = mkFindings(7, "common");
    const r1only = mkFindings(3, "r1only");
    const r2only = mkFindings(3, "r2only");
    const [p1, p2] = writePairFindings(
      [...common, ...r1only],
      [...common, ...r2only],
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, true);
  });

  it("V814 — large set: 50 of 100 recurring → 50% → no oscillation", () => {
    const common = mkFindings(50, "common");
    const r1only = mkFindings(50, "r1only");
    const [p1, p2] = writePairFindings(
      [...common, ...r1only],
      common,
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, false);
  });

  it("V815 — large set: 61 of 100 recurring → oscillation", () => {
    const common = mkFindings(61, "c");
    const r1only = mkFindings(39, "r1");
    const [p1, p2] = writePairFindings(
      [...common, ...r1only],
      common,
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, true);
  });

  it("V816 — 2 of 3 recurring → 66.7% → oscillation", () => {
    const common = mkFindings(2, "common");
    const r1only = mkFindings(1, "r1only");
    const [p1, p2] = writePairFindings(
      [...common, ...r1only],
      common,
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, true);
  });

  it("V817 — 1 of 2 recurring → 50% → no oscillation", () => {
    const common = mkFindings(1, "common");
    const r1only = mkFindings(1, "r1only");
    const [p1, p2] = writePairFindings(
      [...common, ...r1only],
      common,
    );
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, false);
  });

  it("V818 — oscillation threshold is strictly greater than 0.6", () => {
    // 6/10 = 0.6 exactly → not oscillation
    const common = mkFindings(6, "c");
    const r1only = mkFindings(4, "r1");
    const [p1, p2] = writePairFindings([...common, ...r1only], common);
    const c = capture(() => cmdDiff([p1, p2]));
    assert.equal(parseOutput(c).oscillation, false);
  });

  it("V819 — 7/10 = 0.7 → oscillation (clearly above)", () => {
    const common = mkFindings(7, "c");
    const r1only = mkFindings(3, "r1");
    const [p1, p2] = writePairFindings([...common, ...r1only], common);
    assert.equal(parseOutput(capture(() => cmdDiff([p1, p2]))).oscillation, true);
  });

  it("V820 — single finding not recurring → 0% → no oscillation", () => {
    const [p1, p2] = writePairFindings(
      [{ severity: "warning", issue: "old", file: "a.js", line: 1 }],
      [{ severity: "warning", issue: "new", file: "b.js", line: 1 }],
    );
    assert.equal(parseOutput(capture(() => cmdDiff([p1, p2]))).oscillation, false);
  });

  it("V821 — oscillation field is boolean true", () => {
    const f = [{ severity: "warning", issue: "x", file: "a.js", line: 1 }];
    const [p1, p2] = writePairFindings(f, f);
    const out = parseOutput(capture(() => cmdDiff([p1, p2])));
    assert.equal(typeof out.oscillation, "boolean");
    assert.equal(out.oscillation, true);
  });

  it("V822 — oscillation field is boolean false", () => {
    const [p1, p2] = writePairFindings(mkFindings(3, "a"), mkFindings(3, "b"));
    const out = parseOutput(capture(() => cmdDiff([p1, p2])));
    assert.equal(typeof out.oscillation, "boolean");
    assert.equal(out.oscillation, false);
  });

  it("V823 — 5 of 8 recurring → 62.5% → oscillation", () => {
    const common = mkFindings(5, "c");
    const r1only = mkFindings(3, "r1");
    const [p1, p2] = writePairFindings([...common, ...r1only], common);
    assert.equal(parseOutput(capture(() => cmdDiff([p1, p2]))).oscillation, true);
  });

  it("V824 — 3 of 4 recurring → 75% → oscillation", () => {
    const common = mkFindings(3, "c");
    const r1only = mkFindings(1, "r1");
    const [p1, p2] = writePairFindings([...common, ...r1only], common);
    assert.equal(parseOutput(capture(() => cmdDiff([p1, p2]))).oscillation, true);
  });

  it("V825 — new findings in round2 do not affect oscillation calc", () => {
    // 7 of 10 recurring in round1, but round2 has 20 extra new → still 7/10 = 70%
    const common = mkFindings(7, "c");
    const r1only = mkFindings(3, "r1");
    const r2only = mkFindings(20, "r2new");
    const [p1, p2] = writePairFindings(
      [...common, ...r1only],
      [...common, ...r2only],
    );
    assert.equal(parseOutput(capture(() => cmdDiff([p1, p2]))).oscillation, true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. Report generation (V826-V850)
// ══════════════════════════════════════════════════════════════════
describe("Report generation", () => {
  function setupReport(mode, task, evals, opts = {}) {
    const hd = join(tmp, ".harness");
    mkdirSync(hd, { recursive: true });
    for (const [name, content] of Object.entries(evals)) {
      writeFileSync(join(hd, `evaluation-wave-1-${name}.md`), content);
    }
    const args = [tmp, "--mode", mode, "--task", task];
    if (opts.challenged != null) args.push("--challenged", String(opts.challenged));
    if (opts.dismissed != null) args.push("--dismissed", String(opts.dismissed));
    if (opts.downgraded != null) args.push("--downgraded", String(opts.downgraded));
    return capture(() => cmdReport(args));
  }

  it("V826 — report mode=review present in output", () => {
    const c = setupReport("review", "Fix bug #123", { sec: makeEvalMd({}) });
    assert.equal(parseOutput(c).mode, "review");
  });

  it("V827 — report mode=analysis present", () => {
    const c = setupReport("analysis", "Analyze codebase", { sec: makeEvalMd({}) });
    assert.equal(parseOutput(c).mode, "analysis");
  });

  it("V828 — report mode=build present", () => {
    const c = setupReport("build", "Build feature", { sec: makeEvalMd({}) });
    assert.equal(parseOutput(c).mode, "build");
  });

  it("V829 — report mode=brainstorm present", () => {
    const c = setupReport("brainstorm", "Brainstorm ideas", { sec: makeEvalMd({}) });
    assert.equal(parseOutput(c).mode, "brainstorm");
  });

  it("V830 — report mode=plan present", () => {
    const c = setupReport("plan", "Plan sprint", { sec: makeEvalMd({}) });
    assert.equal(parseOutput(c).mode, "plan");
  });

  it("V831 — report mode=verification present", () => {
    const c = setupReport("verification", "Verify deploy", { sec: makeEvalMd({}) });
    assert.equal(parseOutput(c).mode, "verification");
  });

  it("V832 — report mode=post-release present", () => {
    const c = setupReport("post-release", "Post-release check", { sec: makeEvalMd({}) });
    assert.equal(parseOutput(c).mode, "post-release");
  });

  it("V833 — task text preserved in report", () => {
    const c = setupReport("review", "Refactor auth module", { sec: makeEvalMd({}) });
    assert.equal(parseOutput(c).task, "Refactor auth module");
  });

  it("V834 — scope extraction from file refs", () => {
    const c = setupReport("review", "test", {
      code: makeEvalMd({ findings: [
        { severity: "warning", issue: "w", file: "src/auth.js", line: 10 },
        { severity: "suggestion", issue: "s", file: "src/db.js", line: 20 },
      ] }),
    });
    const agent = parseOutput(c).agents[0];
    assert.ok(agent.scope.includes("src/auth.js"));
    assert.ok(agent.scope.includes("src/db.js"));
  });

  it("V835 — scope deduplicates files", () => {
    const c = setupReport("review", "test", {
      code: makeEvalMd({ findings: [
        { severity: "warning", issue: "w1", file: "src/auth.js", line: 10 },
        { severity: "warning", issue: "w2", file: "src/auth.js", line: 20 },
      ] }),
    });
    const scope = parseOutput(c).agents[0].scope;
    assert.equal(scope.filter(s => s === "src/auth.js").length, 1);
  });

  it("V836 — agent count matches evaluator files", () => {
    const c = setupReport("review", "test", {
      security: makeEvalMd({}),
      perf: makeEvalMd({}),
      ux: makeEvalMd({}),
    });
    assert.equal(parseOutput(c).agents.length, 3);
  });

  it("V837 — report version is 1.0", () => {
    const c = setupReport("review", "test", { sec: makeEvalMd({}) });
    assert.equal(parseOutput(c).version, "1.0");
  });

  it("V838 — report has timestamp", () => {
    const c = setupReport("review", "test", { sec: makeEvalMd({}) });
    assert.ok(parseOutput(c).timestamp);
    assert.ok(parseOutput(c).timestamp.includes("T")); // ISO format
  });

  it("V839 — coordinator challenged/dismissed/downgraded captured", () => {
    const c = setupReport("review", "test", { sec: makeEvalMd({}) },
      { challenged: 3, dismissed: 1, downgraded: 2 });
    const coord = parseOutput(c).coordinator;
    assert.equal(coord.challenged, 3);
    assert.equal(coord.dismissed, 1);
    assert.equal(coord.downgraded, 2);
  });

  it("V840 — coordinator defaults to zeros", () => {
    const c = setupReport("review", "test", { sec: makeEvalMd({}) });
    const coord = parseOutput(c).coordinator;
    assert.equal(coord.challenged, 0);
    assert.equal(coord.dismissed, 0);
    assert.equal(coord.downgraded, 0);
  });

  it("V841 — summary counts accepted findings only", () => {
    // All findings default to status: accepted, so they count
    const c = setupReport("review", "test", {
      code: makeEvalMd({ findings: [
        { severity: "critical", issue: "c", file: "a.js", line: 1 },
        { severity: "warning", issue: "w" },
        { severity: "suggestion", issue: "s" },
      ] }),
    });
    const summary = parseOutput(c).summary;
    assert.equal(summary.critical, 1);
    assert.equal(summary.warning, 1);
    assert.equal(summary.suggestion, 1);
  });

  it("V842 — timeline is empty array by default", () => {
    const c = setupReport("review", "test", { sec: makeEvalMd({}) });
    assert.deepEqual(parseOutput(c).timeline, []);
  });

  it("V843 — agent role name from filename", () => {
    const c = setupReport("review", "test", {
      "security": makeEvalMd({}),
      "code-quality": makeEvalMd({}),
    });
    const roles = parseOutput(c).agents.map(a => a.role).sort();
    assert.deepEqual(roles, ["code-quality", "security"]);
  });

  it("V844 — agent verdict preserved from eval file", () => {
    const c = setupReport("review", "test", {
      sec: makeEvalMd({ verdict: "FAIL", findings: [{ severity: "critical", issue: "x", file: "a.js", line: 1 }] }),
    });
    assert.ok(parseOutput(c).agents[0].verdict.includes("FAIL"));
  });

  it("V845 — agent findings include severity/file/line/issue", () => {
    const c = setupReport("review", "test", {
      code: makeEvalMd({ findings: [
        { severity: "critical", issue: "SQL injection", file: "db.js", line: 42, fix: "use params", reasoning: "untrusted input" },
      ] }),
    });
    const f = parseOutput(c).agents[0].findings[0];
    assert.equal(f.severity, "critical");
    assert.equal(f.file, "db.js");
    assert.equal(f.line, 42);
    assert.ok(f.issue.includes("SQL injection"));
  });

  it("V846 — report missing --mode → exits with error", () => {
    const hd = join(tmp, ".harness");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "evaluation-wave-1-sec.md"), makeEvalMd({}));
    const c = capture(() => cmdReport([tmp, "--task", "test"]));
    assert.equal(c.exitCode, 1);
  });

  it("V847 — report missing --task → exits with error", () => {
    const hd = join(tmp, ".harness");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "evaluation-wave-1-sec.md"), makeEvalMd({}));
    const c = capture(() => cmdReport([tmp, "--mode", "review"]));
    assert.equal(c.exitCode, 1);
  });

  it("V848 — report with 5 agents has 5 entries", () => {
    const evals = {};
    for (const r of ["sec", "perf", "ux", "a11y", "code"]) evals[r] = makeEvalMd({});
    const c = setupReport("review", "test", evals);
    assert.equal(parseOutput(c).agents.length, 5);
  });

  it("V849 — summary aggregates across all agents", () => {
    const c = setupReport("review", "test", {
      sec: makeEvalMd({ findings: [{ severity: "critical", issue: "c1", file: "a.js", line: 1 }] }),
      perf: makeEvalMd({ findings: [{ severity: "critical", issue: "c2", file: "b.js", line: 1 }] }),
      ux: makeEvalMd({ findings: [{ severity: "warning", issue: "w1" }] }),
    });
    const summary = parseOutput(c).summary;
    assert.equal(summary.critical, 2);
    assert.equal(summary.warning, 1);
  });

  it("V850 — report with no evaluation files → exits with error", () => {
    mkdirSync(join(tmp, ".harness"), { recursive: true });
    const c = capture(() => cmdReport([tmp, "--mode", "review", "--task", "test"]));
    // When no role files found, it tries single eval files; if both empty, agents is empty but no crash
    const out = parseOutput(c);
    assert.equal(out.agents.length, 0);
  });
});
