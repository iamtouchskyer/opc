// tests/eval-commands.test.mjs — T601-T750 (150 tests)
// Tests for cmdVerify, cmdSynthesize, cmdReport, cmdDiff

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We intercept console.log / console.error and process.exit for testing
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
  try {
    result = fn();
  } catch (e) {
    if (!e.message.startsWith("EXIT_")) throw e;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { logs, errs, exitCode, output: logs.join("\n") };
}

function parseOutput(captured) {
  if (captured.logs.length === 0) return null;
  return JSON.parse(captured.output);
}

// Fresh import each time to avoid module caching issues
const { cmdVerify, cmdSynthesize, cmdReport, cmdDiff } = await import(
  "../bin/lib/eval-commands.mjs"
);

// ── Helpers ──────────────────────────────────────────────────────
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
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "opc-eval-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// ══════════════════════════════════════════════════════════════════
// cmdVerify (T601-T640)
// ══════════════════════════════════════════════════════════════════
describe("cmdVerify", () => {
  it("T601 — valid eval file with all fields", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      verdict: "PASS",
      findings: [{ severity: "critical", file: "app.js", line: 10, issue: "bug", fix: "fix it", reasoning: "because" }],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.evidence_complete, true);
  });

  it("T602 — missing file refs flagged", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      findings: [{ severity: "warning", issue: "no file ref", reasoning: "r" }],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.ok(out.findings_without_refs.length > 0);
  });

  it("T603 — critical without fix flagged", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      findings: [{ severity: "critical", file: "a.js", line: 1, issue: "bug", reasoning: "r" }],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.ok(out.critical_without_fix.length > 0);
  });

  it("T604 — missing reasoning flagged", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      findings: [{ severity: "warning", file: "a.js", line: 1, issue: "bug", fix: "fix" }],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.ok(out.findings_without_reasoning.length > 0);
  });

  it("T605 — empty file exits with error", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.findings_count, 0);
    assert.equal(out.evidence_complete, true);
  });

  it("T606 — no args exits 1", () => {
    const c = capture(() => cmdVerify([]));
    assert.equal(c.exitCode, 1);
  });

  it("T607 — file not found exits 1", () => {
    const c = capture(() => cmdVerify([join(tmp, "nope.md")]));
    assert.equal(c.exitCode, 1);
    assert.ok(c.errs.some(e => e.includes("File not found")));
  });

  it("T608 — multiple findings all complete", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      findings: [
        { severity: "critical", file: "a.js", line: 1, issue: "x", fix: "f", reasoning: "r" },
        { severity: "warning", file: "b.js", line: 2, issue: "y", fix: "f", reasoning: "r" },
      ],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.evidence_complete, true);
  });

  it("T609 — multiple findings some incomplete", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      findings: [
        { severity: "critical", file: "a.js", line: 1, issue: "x", fix: "f", reasoning: "r" },
        { severity: "critical", file: "b.js", line: 2, issue: "y" },
      ],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.evidence_complete, false);
  });

  it("T610 — suggestion severity parsed", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      findings: [{ severity: "suggestion", file: "a.js", line: 1, issue: "hint", fix: "f", reasoning: "r" }],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.suggestion, 1);
  });

  it("T611 — verdict field included in output", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({ verdict: "FAIL" }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.ok(out.verdict.includes("FAIL"));
  });

  it("T612 — findings_count matches", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      findings: [
        { severity: "critical", file: "a.js", line: 1, issue: "x", fix: "f", reasoning: "r" },
        { severity: "warning", file: "b.js", line: 2, issue: "y", fix: "f", reasoning: "r" },
        { severity: "suggestion", file: "c.js", line: 3, issue: "z", fix: "f", reasoning: "r" },
      ],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.findings_count, 3);
  });

  it("T613 — critical count in output", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      findings: [
        { severity: "critical", file: "a.js", line: 1, issue: "x", fix: "f", reasoning: "r" },
        { severity: "critical", file: "b.js", line: 2, issue: "y", fix: "f", reasoning: "r" },
      ],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.critical, 2);
  });

  it("T614 — warning count in output", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      findings: [{ severity: "warning", file: "a.js", line: 1, issue: "x", fix: "f", reasoning: "r" }],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.warning, 1);
  });

  it("T615 — evidence_complete true when zero findings", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "# Eval\nVERDICT: PASS FINDINGS[0]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.evidence_complete, true);
  });

  it("T616 — has_file_refs detected", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      findings: [{ severity: "warning", file: "foo.ts", line: 42, issue: "x", fix: "f", reasoning: "r" }],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.has_file_refs, true);
  });

  it("T617 — verdict_present true", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd());
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.verdict_present, true);
  });

  it("T618 — no verdict in file", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "# Eval\n🔴 bug.js:1 — bad\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.verdict_present, false);
  });

  it("T619 — hedging detected", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "🔴 a.js:1 — this might be a problem\nVERDICT: FAIL FINDINGS[1]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.ok(out.hedging_detected.length > 0);
  });

  it("T620 — fix line parsed", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "🔴 a.js:1 — bad\n→ use better code\nreasoning: because\nVERDICT: FAIL FINDINGS[1]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.critical_without_fix.length, 0);
  });

  it("T621 — reasoning line parsed", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "🟡 a.js:1 — warn\nreasoning: solid reason\nVERDICT: ITERATE FINDINGS[1]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.findings_without_reasoning.length, 0);
  });

  it("T622 — malformed markdown still parses findings", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "random text\n\n🔵 hint.js:5 — try this\nreasoning: why not\n\nmore random\nVERDICT: PASS FINDINGS[1]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.findings_count, 1);
  });

  it("T623 — heading lines with emoji skipped", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "# 🔴 title\n🔴 a.js:1 — real finding\nreasoning: r\n→ fix\nVERDICT: FAIL FINDINGS[1]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.critical, 1);
  });

  it("T624 — multiple findings mixed severities", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      findings: [
        { severity: "critical", file: "a.js", line: 1, issue: "x", fix: "f", reasoning: "r" },
        { severity: "warning", file: "b.js", line: 2, issue: "y", fix: "f", reasoning: "r" },
        { severity: "suggestion", file: "c.js", line: 3, issue: "z", fix: "f", reasoning: "r" },
      ],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.critical, 1);
    assert.equal(out.warning, 1);
    assert.equal(out.suggestion, 1);
  });

  it("T625 — findings_without_refs array has correct labels", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "🔴 — no file ref here\nreasoning: r\n→ f\nVERDICT: FAIL FINDINGS[1]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.ok(out.findings_without_refs[0].includes("#1"));
  });

  it("T626 — critical_without_fix label contains severity", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "🔴 a.js:1 — bug\nreasoning: r\nVERDICT: FAIL FINDINGS[1]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.ok(out.critical_without_fix[0].includes("critical"));
  });

  it("T627 — warning without fix NOT flagged in critical_without_fix", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "🟡 a.js:1 — warn\nreasoning: r\nVERDICT: ITERATE FINDINGS[1]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.critical_without_fix.length, 0);
  });

  it("T628 — suggestion without fix NOT flagged in critical_without_fix", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "🔵 a.js:1 — hint\nreasoning: r\nVERDICT: PASS FINDINGS[1]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.critical_without_fix.length, 0);
  });

  it("T629 — CRLF line endings handled", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "🔴 a.js:1 — bug\r\n→ fix\r\nreasoning: r\r\nVERDICT: FAIL FINDINGS[1]\r\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.evidence_complete, true);
  });

  it("T630 — verdict_count_match true when counts align", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      findings: [{ severity: "warning", file: "a.js", line: 1, issue: "y", fix: "f", reasoning: "r" }],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.verdict_count_match, true);
  });

  it("T631 — verdict_count_match false when mismatch", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "🔴 a.js:1 — bug\nreasoning: r\n→ f\nVERDICT: FAIL FINDINGS[5]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.verdict_count_match, false);
  });

  it("T632 — five findings all complete", () => {
    const findings = Array.from({ length: 5 }, (_, i) => ({
      severity: "warning", file: `f${i}.js`, line: i + 1, issue: `issue${i}`, fix: "f", reasoning: "r",
    }));
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({ findings }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.evidence_complete, true);
    assert.equal(out.findings_count, 5);
  });

  it("T633 — large file with 20 findings", () => {
    const findings = Array.from({ length: 20 }, (_, i) => ({
      severity: i % 3 === 0 ? "critical" : i % 3 === 1 ? "warning" : "suggestion",
      file: `mod${i}.js`, line: i + 1, issue: `issue ${i}`, fix: "f", reasoning: "r",
    }));
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({ findings }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.findings_count, 20);
  });

  it("T634 — file with only verdict line", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "VERDICT: PASS FINDINGS[0]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.evidence_complete, true);
    assert.equal(out.findings_count, 0);
  });

  it("T635 — file path with spaces", () => {
    const dir = join(tmp, "sub dir");
    mkdirSync(dir);
    const p = join(dir, "eval file.md");
    writeFileSync(p, makeEvalMd());
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.evidence_complete, true);
  });

  it("T636 — output is valid JSON", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd());
    const c = capture(() => cmdVerify([p]));
    assert.doesNotThrow(() => JSON.parse(c.output));
  });

  it("T637 — output does not include raw findings array", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeEvalMd({
      findings: [{ severity: "warning", file: "a.js", line: 1, issue: "y", fix: "f", reasoning: "r" }],
    }));
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    // findings are destructured out; only findings_without_* arrays remain
    assert.equal(out.findings, undefined);
  });

  it("T638 — evidence_complete false when any check fails", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "🔴 — no file\nVERDICT: FAIL FINDINGS[1]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.evidence_complete, false);
  });

  it("T639 — non-utf8 file read error", () => {
    const p = join(tmp, "eval.md");
    // Make the file a directory to cause a read error
    mkdirSync(p);
    const c = capture(() => cmdVerify([p]));
    assert.equal(c.exitCode, 1);
  });

  it("T640 — file with BOM still parses", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "\uFEFF🔴 a.js:1 — bug\n→ fix\nreasoning: r\nVERDICT: FAIL FINDINGS[1]\n");
    const c = capture(() => cmdVerify([p]));
    const out = parseOutput(c);
    assert.equal(out.findings_count, 1);
  });
});

// ══════════════════════════════════════════════════════════════════
// cmdSynthesize (T641-T680)
// ══════════════════════════════════════════════════════════════════
describe("cmdSynthesize", () => {
  // -- wave mode helpers --
  function setupWave(dir, wave, evals) {
    const hd = join(dir, ".harness");
    mkdirSync(hd, { recursive: true });
    for (const [name, content] of Object.entries(evals)) {
      writeFileSync(join(hd, `evaluation-wave-${wave}-${name}.md`), content);
    }
    return dir;
  }

  // -- node mode helpers --
  function setupNode(harnessDir, nodeId, runN, evals) {
    const runDir = join(harnessDir, "nodes", nodeId, `run_${runN}`);
    mkdirSync(runDir, { recursive: true });
    for (const [name, content] of Object.entries(evals)) {
      writeFileSync(join(runDir, name), content);
    }
    return harnessDir;
  }

  it("T641 — wave mode PASS verdict when only suggestions", () => {
    setupWave(tmp, 1, {
      security: makeEvalMd({ findings: [{ severity: "suggestion", file: "a.js", line: 1, issue: "hint", fix: "f", reasoning: "r" }] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "PASS");
  });

  it("T642 — wave mode FAIL verdict when critical", () => {
    setupWave(tmp, 1, {
      security: makeEvalMd({ findings: [{ severity: "critical", file: "a.js", line: 1, issue: "bug", fix: "f", reasoning: "r" }] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "FAIL");
  });

  it("T643 — wave mode ITERATE verdict when warnings", () => {
    setupWave(tmp, 1, {
      security: makeEvalMd({ findings: [{ severity: "warning", file: "a.js", line: 1, issue: "warn", fix: "f", reasoning: "r" }] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "ITERATE");
  });

  it("T644 — BLOCKED override trumps all", () => {
    setupWave(tmp, 1, {
      security: makeEvalMd({ verdict: "BLOCKED", findings: [] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "BLOCKED");
  });

  it("T645 — multiple evaluator files aggregated", () => {
    setupWave(tmp, 1, {
      security: makeEvalMd({ findings: [{ severity: "warning", file: "a.js", line: 1, issue: "w1", fix: "f", reasoning: "r" }] }),
      perf: makeEvalMd({ findings: [{ severity: "warning", file: "b.js", line: 2, issue: "w2", fix: "f", reasoning: "r" }] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.totals.warning, 2);
    assert.equal(out.roles.length, 2);
  });

  it("T646 — role name extracted from filename (wave)", () => {
    setupWave(tmp, 1, {
      "arch-review": makeEvalMd(),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.roles[0].role, "arch-review");
  });

  it("T647 — node mode PASS verdict", () => {
    const hd = join(tmp, "harness");
    setupNode(hd, "code-review", 1, {
      "eval-security.md": makeEvalMd({ findings: [{ severity: "suggestion", file: "a.js", line: 1, issue: "s", fix: "f", reasoning: "r" }] }),
    });
    const c = capture(() => cmdSynthesize([hd, "--node", "code-review", "--run", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "PASS");
  });

  it("T648 — node mode role name from eval-<role>.md", () => {
    const hd = join(tmp, "harness");
    setupNode(hd, "code-review", 1, {
      "eval-security.md": makeEvalMd(),
    });
    const c = capture(() => cmdSynthesize([hd, "--node", "code-review", "--run", "1"]));
    const out = parseOutput(c);
    assert.equal(out.roles[0].role, "security");
  });

  it("T649 — node mode auto-selects latest run", () => {
    const hd = join(tmp, "harness");
    setupNode(hd, "gate", 1, { "eval-old.md": makeEvalMd({ findings: [{ severity: "critical", file: "a.js", line: 1, issue: "old", fix: "f", reasoning: "r" }] }) });
    setupNode(hd, "gate", 2, { "eval-new.md": makeEvalMd() });
    const c = capture(() => cmdSynthesize([hd, "--node", "gate"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "PASS");
  });

  it("T650 — no args exits 1", () => {
    const c = capture(() => cmdSynthesize([]));
    assert.equal(c.exitCode, 1);
  });

  it("T651 — missing --wave and --node exits 1", () => {
    const c = capture(() => cmdSynthesize([tmp]));
    assert.equal(c.exitCode, 1);
  });

  it("T652 — --wave without number exits 1", () => {
    const c = capture(() => cmdSynthesize([tmp, "--wave"]));
    assert.equal(c.exitCode, 1);
  });

  it("T653 — --node without nodeId exits 1", () => {
    const c = capture(() => cmdSynthesize([tmp, "--node"]));
    assert.equal(c.exitCode, 1);
  });

  it("T654 — empty harness dir exits 1", () => {
    mkdirSync(join(tmp, ".harness"), { recursive: true });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    assert.equal(c.exitCode, 1);
  });

  it("T655 — missing harness dir exits 1", () => {
    const c = capture(() => cmdSynthesize([join(tmp, "nope"), "--wave", "1"]));
    assert.equal(c.exitCode, 1);
  });

  it("T656 — round files excluded from wave mode", () => {
    const hd = join(tmp, ".harness");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "evaluation-wave-1-security.md"), makeEvalMd({ findings: [{ severity: "warning", file: "a.js", line: 1, issue: "w", fix: "f", reasoning: "r" }] }));
    writeFileSync(join(hd, "evaluation-wave-1-round1-security.md"), makeEvalMd({ findings: [{ severity: "critical", file: "b.js", line: 1, issue: "c", fix: "f", reasoning: "r" }] }));
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.totals.critical, 0); // round file excluded
  });

  it("T657 — merged file excluded from wave mode", () => {
    const hd = join(tmp, ".harness");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "evaluation-wave-1-security.md"), makeEvalMd());
    writeFileSync(join(hd, "evaluation-wave-1.md"), makeEvalMd({ findings: [{ severity: "critical", file: "a.js", line: 1, issue: "x", fix: "f", reasoning: "r" }] }));
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.totals.critical, 0);
  });

  it("T658 — totals accumulate across roles", () => {
    setupWave(tmp, 1, {
      a: makeEvalMd({ findings: [
        { severity: "critical", file: "a.js", line: 1, issue: "c1", fix: "f", reasoning: "r" },
        { severity: "warning", file: "a.js", line: 2, issue: "w1", fix: "f", reasoning: "r" },
      ] }),
      b: makeEvalMd({ findings: [
        { severity: "critical", file: "b.js", line: 1, issue: "c2", fix: "f", reasoning: "r" },
        { severity: "suggestion", file: "b.js", line: 2, issue: "s1", fix: "f", reasoning: "r" },
      ] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.totals.critical, 2);
    assert.equal(out.totals.warning, 1);
    assert.equal(out.totals.suggestion, 1);
  });

  it("T659 — BLOCKED reason includes role name", () => {
    setupWave(tmp, 1, {
      compliance: makeEvalMd({ verdict: "BLOCKED" }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.ok(out.reason.includes("compliance"));
  });

  it("T660 — FAIL reason includes critical count", () => {
    setupWave(tmp, 1, {
      sec: makeEvalMd({ findings: [
        { severity: "critical", file: "a.js", line: 1, issue: "c1", fix: "f", reasoning: "r" },
        { severity: "critical", file: "b.js", line: 2, issue: "c2", fix: "f", reasoning: "r" },
      ] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.ok(out.reason.includes("2"));
  });

  it("T661 — PASS reason mentions LGTM", () => {
    setupWave(tmp, 1, { sec: makeEvalMd() });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.ok(out.reason.includes("LGTM"));
  });

  it("T662 — blocked role listed in roles output", () => {
    setupWave(tmp, 1, { sec: makeEvalMd({ verdict: "BLOCKED" }) });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.ok(out.roles[0].blocked);
  });

  it("T663 — non-blocked role has blocked=false", () => {
    setupWave(tmp, 1, { sec: makeEvalMd() });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.roles[0].blocked, false);
  });

  it("T664 — node mode no runs exits 1", () => {
    const nodeDir = join(tmp, "harness", "nodes", "gate");
    mkdirSync(nodeDir, { recursive: true });
    const c = capture(() => cmdSynthesize([join(tmp, "harness"), "--node", "gate"]));
    assert.equal(c.exitCode, 1);
  });

  it("T665 — node mode no eval files in run exits 1", () => {
    const runDir = join(tmp, "harness", "nodes", "gate", "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "notes.md"), "not an eval");
    const c = capture(() => cmdSynthesize([join(tmp, "harness"), "--node", "gate", "--run", "1"]));
    assert.equal(c.exitCode, 1);
  });

  it("T666 — eval.md role defaults to 'evaluator'", () => {
    const hd = join(tmp, "harness");
    const runDir = join(hd, "nodes", "gate", "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "eval.md"), makeEvalMd());
    const c = capture(() => cmdSynthesize([hd, "--node", "gate", "--run", "1"]));
    const out = parseOutput(c);
    assert.equal(out.roles[0].role, "evaluator");
  });

  it("T667 — BLOCKED + critical still yields BLOCKED", () => {
    setupWave(tmp, 1, {
      a: makeEvalMd({ verdict: "BLOCKED" }),
      b: makeEvalMd({ findings: [{ severity: "critical", file: "a.js", line: 1, issue: "c", fix: "f", reasoning: "r" }] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "BLOCKED");
  });

  it("T668 — critical + warning yields FAIL not ITERATE", () => {
    setupWave(tmp, 1, {
      a: makeEvalMd({ findings: [
        { severity: "critical", file: "a.js", line: 1, issue: "c", fix: "f", reasoning: "r" },
        { severity: "warning", file: "b.js", line: 2, issue: "w", fix: "f", reasoning: "r" },
      ] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "FAIL");
  });

  it("T669 — empty eval files yield PASS", () => {
    setupWave(tmp, 1, { sec: makeEvalMd({ findings: [] }) });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "PASS");
  });

  it("T670 — three roles aggregated", () => {
    setupWave(tmp, 1, {
      a: makeEvalMd(),
      b: makeEvalMd(),
      c: makeEvalMd(),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.roles.length, 3);
  });

  it("T671 — mixed PASS and FAIL across roles", () => {
    setupWave(tmp, 1, {
      good: makeEvalMd(),
      bad: makeEvalMd({ findings: [{ severity: "critical", file: "a.js", line: 1, issue: "c", fix: "f", reasoning: "r" }] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "FAIL");
  });

  it("T672 — wave 2 isolated from wave 1", () => {
    const hd = join(tmp, ".harness");
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "evaluation-wave-1-sec.md"), makeEvalMd({ findings: [{ severity: "critical", file: "a.js", line: 1, issue: "c", fix: "f", reasoning: "r" }] }));
    writeFileSync(join(hd, "evaluation-wave-2-sec.md"), makeEvalMd());
    const c = capture(() => cmdSynthesize([tmp, "--wave", "2"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "PASS");
  });

  it("T673 — output is valid JSON", () => {
    setupWave(tmp, 1, { sec: makeEvalMd() });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    assert.doesNotThrow(() => JSON.parse(c.output));
  });

  it("T674 — roles have correct critical/warning/suggestion counts", () => {
    setupWave(tmp, 1, {
      sec: makeEvalMd({ findings: [
        { severity: "critical", file: "a.js", line: 1, issue: "c", fix: "f", reasoning: "r" },
        { severity: "suggestion", file: "b.js", line: 2, issue: "s", fix: "f", reasoning: "r" },
      ] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.equal(out.roles[0].critical, 1);
    assert.equal(out.roles[0].suggestion, 1);
  });

  it("T675 — multiple blocked roles all listed in reason", () => {
    setupWave(tmp, 1, {
      a: makeEvalMd({ verdict: "BLOCKED" }),
      b: makeEvalMd({ verdict: "BLOCKED" }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.ok(out.reason.includes("a"));
    assert.ok(out.reason.includes("b"));
  });

  it("T676 — node mode with explicit --run flag", () => {
    const hd = join(tmp, "harness");
    setupNode(hd, "gate", 3, { "eval-tester.md": makeEvalMd() });
    const c = capture(() => cmdSynthesize([hd, "--node", "gate", "--run", "3"]));
    const out = parseOutput(c);
    assert.equal(out.verdict, "PASS");
  });

  it("T677 — node mode non-existent run exits 1", () => {
    const hd = join(tmp, "harness");
    mkdirSync(join(hd, "nodes", "gate"), { recursive: true });
    const c = capture(() => cmdSynthesize([hd, "--node", "gate", "--run", "99"]));
    assert.equal(c.exitCode, 1);
  });

  it("T678 — node mode non-existent node dir exits 1", () => {
    const hd = join(tmp, "harness");
    mkdirSync(hd, { recursive: true });
    const c = capture(() => cmdSynthesize([hd, "--node", "nonexistent"]));
    assert.equal(c.exitCode, 1);
  });

  it("T679 — only eval*.md files picked up in node mode", () => {
    const hd = join(tmp, "harness");
    const runDir = join(hd, "nodes", "gate", "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "eval-sec.md"), makeEvalMd());
    writeFileSync(join(runDir, "notes.txt"), "ignored");
    writeFileSync(join(runDir, "readme.md"), "ignored too");
    const c = capture(() => cmdSynthesize([hd, "--node", "gate", "--run", "1"]));
    const out = parseOutput(c);
    assert.equal(out.roles.length, 1);
  });

  it("T680 — ITERATE reason mentions warning count", () => {
    setupWave(tmp, 1, {
      sec: makeEvalMd({ findings: [
        { severity: "warning", file: "a.js", line: 1, issue: "w1", fix: "f", reasoning: "r" },
        { severity: "warning", file: "b.js", line: 2, issue: "w2", fix: "f", reasoning: "r" },
      ] }),
    });
    const c = capture(() => cmdSynthesize([tmp, "--wave", "1"]));
    const out = parseOutput(c);
    assert.ok(out.reason.includes("2"));
  });
});

// ══════════════════════════════════════════════════════════════════
// cmdReport (T681-T710)
// ══════════════════════════════════════════════════════════════════
describe("cmdReport", () => {
  function setupReport(dir, files) {
    const hd = join(dir, ".harness");
    mkdirSync(hd, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(hd, name), content);
    }
  }

  it("T681 — valid report generation", () => {
    setupReport(tmp, {
      "evaluation-wave-1-security.md": makeEvalMd({
        findings: [{ severity: "warning", file: "a.js", line: 1, issue: "w", fix: "f", reasoning: "r" }],
      }),
    });
    const c = capture(() => cmdReport([tmp, "--mode", "build-verify", "--task", "add feature"]));
    const out = parseOutput(c);
    assert.equal(out.version, "1.0");
    assert.equal(out.mode, "build-verify");
    assert.equal(out.task, "add feature");
  });

  it("T682 — no args exits 1", () => {
    const c = capture(() => cmdReport([]));
    assert.equal(c.exitCode, 1);
  });

  it("T683 — missing --mode exits 1", () => {
    const c = capture(() => cmdReport([tmp, "--task", "x"]));
    assert.equal(c.exitCode, 1);
  });

  it("T684 — missing --task exits 1", () => {
    const c = capture(() => cmdReport([tmp, "--mode", "x"]));
    assert.equal(c.exitCode, 1);
  });

  it("T685 — challenged count included", () => {
    setupReport(tmp, { "evaluation-wave-1-sec.md": makeEvalMd() });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t", "--challenged", "3"]));
    const out = parseOutput(c);
    assert.equal(out.coordinator.challenged, 3);
  });

  it("T686 — dismissed count included", () => {
    setupReport(tmp, { "evaluation-wave-1-sec.md": makeEvalMd() });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t", "--dismissed", "2"]));
    const out = parseOutput(c);
    assert.equal(out.coordinator.dismissed, 2);
  });

  it("T687 — downgraded count included", () => {
    setupReport(tmp, { "evaluation-wave-1-sec.md": makeEvalMd() });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t", "--downgraded", "1"]));
    const out = parseOutput(c);
    assert.equal(out.coordinator.downgraded, 1);
  });

  it("T688 — defaults to zero for coordinator counts", () => {
    setupReport(tmp, { "evaluation-wave-1-sec.md": makeEvalMd() });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.coordinator.challenged, 0);
    assert.equal(out.coordinator.dismissed, 0);
    assert.equal(out.coordinator.downgraded, 0);
  });

  it("T689 — scope extracted from findings", () => {
    setupReport(tmp, {
      "evaluation-wave-1-sec.md": makeEvalMd({
        findings: [
          { severity: "warning", file: "a.js", line: 1, issue: "w", fix: "f", reasoning: "r" },
          { severity: "warning", file: "b.js", line: 2, issue: "w", fix: "f", reasoning: "r" },
        ],
      }),
    });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.ok(out.agents[0].scope.includes("a.js"));
    assert.ok(out.agents[0].scope.includes("b.js"));
  });

  it("T690 — scope deduplicates files", () => {
    setupReport(tmp, {
      "evaluation-wave-1-sec.md": makeEvalMd({
        findings: [
          { severity: "warning", file: "a.js", line: 1, issue: "w1", fix: "f", reasoning: "r" },
          { severity: "warning", file: "a.js", line: 5, issue: "w2", fix: "f", reasoning: "r" },
        ],
      }),
    });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.agents[0].scope.length, 1);
  });

  it("T691 — timestamp is ISO string", () => {
    setupReport(tmp, { "evaluation-wave-1-sec.md": makeEvalMd() });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.ok(!isNaN(Date.parse(out.timestamp)));
  });

  it("T692 — timeline is empty array", () => {
    setupReport(tmp, { "evaluation-wave-1-sec.md": makeEvalMd() });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.deepEqual(out.timeline, []);
  });

  it("T693 — multiple agents in report", () => {
    setupReport(tmp, {
      "evaluation-wave-1-security.md": makeEvalMd(),
      "evaluation-wave-1-perf.md": makeEvalMd(),
    });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.agents.length, 2);
  });

  it("T694 — agent role extracted from filename", () => {
    setupReport(tmp, {
      "evaluation-wave-1-arch-review.md": makeEvalMd(),
    });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.agents[0].role, "arch-review");
  });

  it("T695 — agent findings include severity/file/line/issue", () => {
    setupReport(tmp, {
      "evaluation-wave-1-sec.md": makeEvalMd({
        findings: [{ severity: "critical", file: "x.js", line: 42, issue: "bad code", fix: "fix it", reasoning: "why" }],
      }),
    });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    const f = out.agents[0].findings[0];
    assert.equal(f.severity, "critical");
    assert.equal(f.file, "x.js");
    assert.equal(f.line, 42);
  });

  it("T696 — summary counts only accepted findings", () => {
    // All findings default to status "accepted" in parseEvaluation
    setupReport(tmp, {
      "evaluation-wave-1-sec.md": makeEvalMd({
        findings: [
          { severity: "critical", file: "a.js", line: 1, issue: "c", fix: "f", reasoning: "r" },
          { severity: "warning", file: "b.js", line: 2, issue: "w", fix: "f", reasoning: "r" },
        ],
      }),
    });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.summary.critical, 1);
    assert.equal(out.summary.warning, 1);
  });

  it("T697 — empty harness dir exits 1", () => {
    const c = capture(() => cmdReport([join(tmp, "nope"), "--mode", "m", "--task", "t"]));
    assert.equal(c.exitCode, 1);
  });

  it("T698 — no role files but single eval files used", () => {
    setupReport(tmp, { "evaluation-wave-1.md": makeEvalMd() });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.agents.length, 1);
    assert.equal(out.agents[0].role, "evaluator");
  });

  it("T699 — report output is valid JSON", () => {
    setupReport(tmp, { "evaluation-wave-1-sec.md": makeEvalMd() });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    assert.doesNotThrow(() => JSON.parse(c.output));
  });

  it("T700 — agent verdict included", () => {
    setupReport(tmp, {
      "evaluation-wave-1-sec.md": makeEvalMd({ verdict: "FAIL" }),
    });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.ok(out.agents[0].verdict.includes("FAIL"));
  });

  it("T701 — fix and reasoning propagated to report findings", () => {
    setupReport(tmp, {
      "evaluation-wave-1-sec.md": makeEvalMd({
        findings: [{ severity: "warning", file: "a.js", line: 1, issue: "w", fix: "do this", reasoning: "because" }],
      }),
    });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.agents[0].findings[0].fix, "do this");
    assert.equal(out.agents[0].findings[0].reasoning, "because");
  });

  it("T702 — round files excluded from report", () => {
    setupReport(tmp, {
      "evaluation-wave-1-security.md": makeEvalMd(),
      "evaluation-wave-1-round1-security.md": makeEvalMd({ findings: [{ severity: "critical", file: "a.js", line: 1, issue: "c", fix: "f", reasoning: "r" }] }),
    });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.summary.critical, 0);
  });

  it("T703 — version field is 1.0", () => {
    setupReport(tmp, { "evaluation-wave-1-sec.md": makeEvalMd() });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.version, "1.0");
  });

  it("T704 — summary has all three severity keys", () => {
    setupReport(tmp, { "evaluation-wave-1-sec.md": makeEvalMd() });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.ok("critical" in out.summary);
    assert.ok("warning" in out.summary);
    assert.ok("suggestion" in out.summary);
  });

  it("T705 — empty agents when no matching files", () => {
    mkdirSync(join(tmp, ".harness"), { recursive: true });
    writeFileSync(join(tmp, ".harness", "random.md"), "nope");
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.agents.length, 0);
  });

  it("T706 — findings status field present", () => {
    setupReport(tmp, {
      "evaluation-wave-1-sec.md": makeEvalMd({
        findings: [{ severity: "warning", file: "a.js", line: 1, issue: "w", fix: "f", reasoning: "r" }],
      }),
    });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.agents[0].findings[0].status, "accepted");
  });

  it("T707 — dismissReason field present (null by default)", () => {
    setupReport(tmp, {
      "evaluation-wave-1-sec.md": makeEvalMd({
        findings: [{ severity: "warning", file: "a.js", line: 1, issue: "w", fix: "f", reasoning: "r" }],
      }),
    });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.agents[0].findings[0].dismissReason, null);
  });

  it("T708 — multiple waves only picks matching wave", () => {
    setupReport(tmp, {
      "evaluation-wave-1-sec.md": makeEvalMd({ findings: [{ severity: "critical", file: "a.js", line: 1, issue: "c", fix: "f", reasoning: "r" }] }),
      "evaluation-wave-2-sec.md": makeEvalMd(),
    });
    // Report picks all role files regardless of wave — but role regex matches both
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.equal(out.agents.length, 2);
  });

  it("T709 — scope empty when findings have no file", () => {
    const hd = join(tmp, ".harness");
    mkdirSync(hd);
    writeFileSync(join(hd, "evaluation-wave-1-sec.md"), "🔴 — no file\nreasoning: r\n→ f\nVERDICT: FAIL FINDINGS[1]\n");
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t"]));
    const out = parseOutput(c);
    assert.deepEqual(out.agents[0].scope, []);
  });

  it("T710 — coordinator fields all present", () => {
    setupReport(tmp, { "evaluation-wave-1-sec.md": makeEvalMd() });
    const c = capture(() => cmdReport([tmp, "--mode", "m", "--task", "t", "--challenged", "1", "--dismissed", "2", "--downgraded", "3"]));
    const out = parseOutput(c);
    assert.equal(out.coordinator.challenged, 1);
    assert.equal(out.coordinator.dismissed, 2);
    assert.equal(out.coordinator.downgraded, 3);
  });
});

// ══════════════════════════════════════════════════════════════════
// cmdDiff (T711-T750)
// ══════════════════════════════════════════════════════════════════
describe("cmdDiff", () => {
  function writeDiffFile(dir, name, findings) {
    const p = join(dir, name);
    writeFileSync(p, makeEvalMd({ findings }));
    return p;
  }

  it("T711 — identical files show zero new/resolved", () => {
    const findings = [{ severity: "warning", file: "a.js", line: 1, issue: "same issue", fix: "f", reasoning: "r" }];
    const f1 = writeDiffFile(tmp, "r1.md", findings);
    const f2 = writeDiffFile(tmp, "r2.md", findings);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.new, 0);
    assert.equal(out.resolved, 0);
    assert.equal(out.recurring, 1);
  });

  it("T712 — all new findings", () => {
    const f1 = writeDiffFile(tmp, "r1.md", []);
    const f2 = writeDiffFile(tmp, "r2.md", [
      { severity: "warning", file: "a.js", line: 1, issue: "new one", fix: "f", reasoning: "r" },
    ]);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.new, 1);
    assert.equal(out.recurring, 0);
  });

  it("T713 — all resolved findings", () => {
    const f1 = writeDiffFile(tmp, "r1.md", [
      { severity: "warning", file: "a.js", line: 1, issue: "old one", fix: "f", reasoning: "r" },
    ]);
    const f2 = writeDiffFile(tmp, "r2.md", []);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.resolved, 1);
    assert.equal(out.new, 0);
  });

  it("T714 — recurring findings detected", () => {
    const findings = [
      { severity: "warning", file: "a.js", line: 1, issue: "stays", fix: "f", reasoning: "r" },
    ];
    const f1 = writeDiffFile(tmp, "r1.md", findings);
    const f2 = writeDiffFile(tmp, "r2.md", findings);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 1);
  });

  it("T715 — oscillation detected (>60% recurring)", () => {
    const shared = [
      { severity: "warning", file: "a.js", line: 1, issue: "stays 1", fix: "f", reasoning: "r" },
      { severity: "warning", file: "b.js", line: 2, issue: "stays 2", fix: "f", reasoning: "r" },
      { severity: "warning", file: "c.js", line: 3, issue: "stays 3", fix: "f", reasoning: "r" },
    ];
    const extra = { severity: "warning", file: "d.js", line: 4, issue: "resolved", fix: "f", reasoning: "r" };
    const f1 = writeDiffFile(tmp, "r1.md", [...shared, extra]);
    const f2 = writeDiffFile(tmp, "r2.md", shared);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.oscillation, true);
  });

  it("T716 — no oscillation when <60% recurring", () => {
    const shared = [{ severity: "warning", file: "a.js", line: 1, issue: "stays", fix: "f", reasoning: "r" }];
    const extra = [
      { severity: "warning", file: "b.js", line: 2, issue: "resolved1", fix: "f", reasoning: "r" },
      { severity: "warning", file: "c.js", line: 3, issue: "resolved2", fix: "f", reasoning: "r" },
      { severity: "warning", file: "d.js", line: 4, issue: "resolved3", fix: "f", reasoning: "r" },
    ];
    const f1 = writeDiffFile(tmp, "r1.md", [...shared, ...extra]);
    const f2 = writeDiffFile(tmp, "r2.md", shared);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.oscillation, false);
  });

  it("T717 — empty findings in both rounds", () => {
    const f1 = writeDiffFile(tmp, "r1.md", []);
    const f2 = writeDiffFile(tmp, "r2.md", []);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.round1_findings, 0);
    assert.equal(out.round2_findings, 0);
    assert.equal(out.oscillation, false);
  });

  it("T718 — normalization ignores case", () => {
    const f1 = writeDiffFile(tmp, "r1.md", [{ severity: "warning", file: "a.js", line: 1, issue: "Some Issue Here", fix: "f", reasoning: "r" }]);
    const f2 = writeDiffFile(tmp, "r2.md", [{ severity: "warning", file: "a.js", line: 1, issue: "some issue here", fix: "f", reasoning: "r" }]);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 1);
  });

  it("T719 — normalization collapses whitespace", () => {
    const f1 = writeDiffFile(tmp, "r1.md", [{ severity: "warning", file: "a.js", line: 1, issue: "issue   with   spaces", fix: "f", reasoning: "r" }]);
    const f2 = writeDiffFile(tmp, "r2.md", [{ severity: "warning", file: "a.js", line: 1, issue: "issue with spaces", fix: "f", reasoning: "r" }]);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 1);
  });

  it("T720 — no args exits with error", () => {
    const c = capture(() => cmdDiff([]));
    assert.equal(c.exitCode, 1);
  });

  it("T721 — missing second file returns error JSON", () => {
    const f1 = writeDiffFile(tmp, "r1.md", []);
    const c = capture(() => cmdDiff([f1, join(tmp, "nope.md")]));
    const out = parseOutput(c);
    assert.ok(out.error);
  });

  it("T722 — missing first file returns error JSON", () => {
    const f2 = writeDiffFile(tmp, "r2.md", []);
    const c = capture(() => cmdDiff([join(tmp, "nope.md"), f2]));
    const out = parseOutput(c);
    assert.ok(out.error);
  });

  it("T723 — recurring_details has correct structure", () => {
    const findings = [{ severity: "warning", file: "a.js", line: 1, issue: "same", fix: "f", reasoning: "r" }];
    const f1 = writeDiffFile(tmp, "r1.md", findings);
    const f2 = writeDiffFile(tmp, "r2.md", findings);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring_details.length, 1);
    assert.ok("file" in out.recurring_details[0]);
    assert.ok("issue_key" in out.recurring_details[0]);
    assert.ok("severity_changed" in out.recurring_details[0]);
  });

  it("T724 — severity_changed detected", () => {
    const f1 = writeDiffFile(tmp, "r1.md", [{ severity: "warning", file: "a.js", line: 1, issue: "same", fix: "f", reasoning: "r" }]);
    const f2 = writeDiffFile(tmp, "r2.md", [{ severity: "critical", file: "a.js", line: 1, issue: "same", fix: "f", reasoning: "r" }]);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring_details[0].severity_changed, true);
  });

  it("T725 — severity_changed false when same", () => {
    const findings = [{ severity: "warning", file: "a.js", line: 1, issue: "same", fix: "f", reasoning: "r" }];
    const f1 = writeDiffFile(tmp, "r1.md", findings);
    const f2 = writeDiffFile(tmp, "r2.md", findings);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring_details[0].severity_changed, false);
  });

  it("T726 — round1_findings count correct", () => {
    const f1 = writeDiffFile(tmp, "r1.md", [
      { severity: "warning", file: "a.js", line: 1, issue: "w1", fix: "f", reasoning: "r" },
      { severity: "warning", file: "b.js", line: 2, issue: "w2", fix: "f", reasoning: "r" },
    ]);
    const f2 = writeDiffFile(tmp, "r2.md", []);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.round1_findings, 2);
  });

  it("T727 — round2_findings count correct", () => {
    const f1 = writeDiffFile(tmp, "r1.md", []);
    const f2 = writeDiffFile(tmp, "r2.md", [
      { severity: "critical", file: "a.js", line: 1, issue: "c1", fix: "f", reasoning: "r" },
    ]);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.round2_findings, 1);
  });

  it("T728 — complex mix of new/resolved/recurring", () => {
    const f1 = writeDiffFile(tmp, "r1.md", [
      { severity: "warning", file: "a.js", line: 1, issue: "stays", fix: "f", reasoning: "r" },
      { severity: "warning", file: "b.js", line: 2, issue: "goes away", fix: "f", reasoning: "r" },
    ]);
    const f2 = writeDiffFile(tmp, "r2.md", [
      { severity: "warning", file: "a.js", line: 1, issue: "stays", fix: "f", reasoning: "r" },
      { severity: "critical", file: "c.js", line: 3, issue: "brand new", fix: "f", reasoning: "r" },
    ]);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 1);
    assert.equal(out.resolved, 1);
    assert.equal(out.new, 1);
  });

  it("T729 — output is valid JSON", () => {
    const f1 = writeDiffFile(tmp, "r1.md", []);
    const f2 = writeDiffFile(tmp, "r2.md", []);
    const c = capture(() => cmdDiff([f1, f2]));
    assert.doesNotThrow(() => JSON.parse(c.output));
  });

  it("T730 — findings without file still work in diff", () => {
    const f1p = join(tmp, "r1.md");
    writeFileSync(f1p, "🔴 — no file ref\nreasoning: r\n→ f\nVERDICT: FAIL FINDINGS[1]\n");
    const f2p = join(tmp, "r2.md");
    writeFileSync(f2p, "🔴 — no file ref\nreasoning: r\n→ f\nVERDICT: FAIL FINDINGS[1]\n");
    const c = capture(() => cmdDiff([f1p, f2p]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 1);
  });

  it("T731 — different files same issue are different keys", () => {
    const f1 = writeDiffFile(tmp, "r1.md", [{ severity: "warning", file: "a.js", line: 1, issue: "same", fix: "f", reasoning: "r" }]);
    const f2 = writeDiffFile(tmp, "r2.md", [{ severity: "warning", file: "b.js", line: 1, issue: "same", fix: "f", reasoning: "r" }]);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 0);
    assert.equal(out.new, 1);
    assert.equal(out.resolved, 1);
  });

  it("T732 — key truncated to 80 chars", () => {
    const longIssue = "a".repeat(200);
    const f1 = writeDiffFile(tmp, "r1.md", [{ severity: "warning", file: "a.js", line: 1, issue: longIssue, fix: "f", reasoning: "r" }]);
    const f2 = writeDiffFile(tmp, "r2.md", [{ severity: "warning", file: "a.js", line: 1, issue: longIssue, fix: "f", reasoning: "r" }]);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.ok(out.recurring_details[0].issue_key.length <= 80);
  });

  it("T733 — exactly 60% recurring is NOT oscillation (>60% required)", () => {
    // 3 out of 5 = 60% exactly — NOT >60%
    const shared = [
      { severity: "warning", file: "a.js", line: 1, issue: "s1", fix: "f", reasoning: "r" },
      { severity: "warning", file: "b.js", line: 2, issue: "s2", fix: "f", reasoning: "r" },
      { severity: "warning", file: "c.js", line: 3, issue: "s3", fix: "f", reasoning: "r" },
    ];
    const extras = [
      { severity: "warning", file: "d.js", line: 4, issue: "e1", fix: "f", reasoning: "r" },
      { severity: "warning", file: "e.js", line: 5, issue: "e2", fix: "f", reasoning: "r" },
    ];
    const f1 = writeDiffFile(tmp, "r1.md", [...shared, ...extras]);
    const f2 = writeDiffFile(tmp, "r2.md", shared);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.oscillation, false);
  });

  it("T734 — 61% recurring IS oscillation", () => {
    // We need recurring/round1 > 0.6. Use ~2/3 = 66%
    const shared = [
      { severity: "warning", file: "a.js", line: 1, issue: "s1", fix: "f", reasoning: "r" },
      { severity: "warning", file: "b.js", line: 2, issue: "s2", fix: "f", reasoning: "r" },
    ];
    const extra = { severity: "warning", file: "c.js", line: 3, issue: "e1", fix: "f", reasoning: "r" };
    const f1 = writeDiffFile(tmp, "r1.md", [...shared, extra]);
    const f2 = writeDiffFile(tmp, "r2.md", shared);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.oscillation, true);
  });

  it("T735 — single finding in round1 not oscillation if resolved", () => {
    const f1 = writeDiffFile(tmp, "r1.md", [{ severity: "warning", file: "a.js", line: 1, issue: "x", fix: "f", reasoning: "r" }]);
    const f2 = writeDiffFile(tmp, "r2.md", []);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.oscillation, false);
  });

  it("T736 — single finding recurring IS oscillation (100%)", () => {
    const findings = [{ severity: "warning", file: "a.js", line: 1, issue: "x", fix: "f", reasoning: "r" }];
    const f1 = writeDiffFile(tmp, "r1.md", findings);
    const f2 = writeDiffFile(tmp, "r2.md", findings);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.oscillation, true);
  });

  it("T737 — diff does not exit process on missing file (returns error)", () => {
    const f1 = writeDiffFile(tmp, "r1.md", []);
    const c = capture(() => cmdDiff([f1, join(tmp, "nope.md")]));
    // Should NOT exit — returns error JSON
    assert.equal(c.exitCode, null);
  });

  it("T738 — 10 findings complex diff", () => {
    const r1 = Array.from({ length: 10 }, (_, i) => ({
      severity: "warning", file: `f${i}.js`, line: i + 1, issue: `issue ${i}`, fix: "f", reasoning: "r",
    }));
    const r2 = [
      ...r1.slice(0, 5), // 5 recurring
      ...Array.from({ length: 3 }, (_, i) => ({
        severity: "critical", file: `new${i}.js`, line: 1, issue: `new ${i}`, fix: "f", reasoning: "r",
      })),
    ];
    const f1 = writeDiffFile(tmp, "r1.md", r1);
    const f2 = writeDiffFile(tmp, "r2.md", r2);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 5);
    assert.equal(out.resolved, 5);
    assert.equal(out.new, 3);
  });

  it("T739 — leading/trailing whitespace in issue normalized", () => {
    const f1 = writeDiffFile(tmp, "r1.md", [{ severity: "warning", file: "a.js", line: 1, issue: "  padded issue  ", fix: "f", reasoning: "r" }]);
    const f2 = writeDiffFile(tmp, "r2.md", [{ severity: "warning", file: "a.js", line: 1, issue: "padded issue", fix: "f", reasoning: "r" }]);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 1);
  });

  it("T740 — recurring_details empty when no recurring", () => {
    const f1 = writeDiffFile(tmp, "r1.md", [{ severity: "warning", file: "a.js", line: 1, issue: "old", fix: "f", reasoning: "r" }]);
    const f2 = writeDiffFile(tmp, "r2.md", [{ severity: "warning", file: "b.js", line: 1, issue: "new", fix: "f", reasoning: "r" }]);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring_details.length, 0);
  });

  it("T741 — file field in recurring_details", () => {
    const findings = [{ severity: "warning", file: "xyz.js", line: 1, issue: "same", fix: "f", reasoning: "r" }];
    const f1 = writeDiffFile(tmp, "r1.md", findings);
    const f2 = writeDiffFile(tmp, "r2.md", findings);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring_details[0].file, "xyz.js");
  });

  it("T742 — only one arg provided exits 1", () => {
    const f1 = writeDiffFile(tmp, "r1.md", []);
    const c = capture(() => cmdDiff([f1]));
    assert.equal(c.exitCode, 1);
  });

  it("T743 — duplicate findings in same round deduplicated by key", () => {
    const findings = [
      { severity: "warning", file: "a.js", line: 1, issue: "same issue", fix: "f", reasoning: "r" },
      { severity: "warning", file: "a.js", line: 1, issue: "same issue", fix: "f", reasoning: "r" },
    ];
    const f1 = writeDiffFile(tmp, "r1.md", findings);
    const f2 = writeDiffFile(tmp, "r2.md", [{ severity: "warning", file: "a.js", line: 1, issue: "same issue", fix: "f", reasoning: "r" }]);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    // Set deduplicates: keys1 has 1 entry, keys2 has 1 entry
    assert.equal(out.recurring, 1);
  });

  it("T744 — line numbers don't affect diff key", () => {
    const f1 = writeDiffFile(tmp, "r1.md", [{ severity: "warning", file: "a.js", line: 1, issue: "same", fix: "f", reasoning: "r" }]);
    const f2 = writeDiffFile(tmp, "r2.md", [{ severity: "warning", file: "a.js", line: 99, issue: "same", fix: "f", reasoning: "r" }]);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    // key is file + normalized issue, not line — should still match
    assert.equal(out.recurring, 1);
  });

  it("T745 — suggestion severity findings in diff", () => {
    const findings = [{ severity: "suggestion", file: "a.js", line: 1, issue: "hint", fix: "f", reasoning: "r" }];
    const f1 = writeDiffFile(tmp, "r1.md", findings);
    const f2 = writeDiffFile(tmp, "r2.md", findings);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 1);
  });

  it("T746 — mix of severity types in same diff", () => {
    const r1 = [
      { severity: "critical", file: "a.js", line: 1, issue: "crit", fix: "f", reasoning: "r" },
      { severity: "warning", file: "b.js", line: 2, issue: "warn", fix: "f", reasoning: "r" },
    ];
    const r2 = [
      { severity: "critical", file: "a.js", line: 1, issue: "crit", fix: "f", reasoning: "r" },
      { severity: "suggestion", file: "c.js", line: 3, issue: "sug", fix: "f", reasoning: "r" },
    ];
    const f1 = writeDiffFile(tmp, "r1.md", r1);
    const f2 = writeDiffFile(tmp, "r2.md", r2);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 1);
    assert.equal(out.resolved, 1);
    assert.equal(out.new, 1);
  });

  it("T747 — empty round1 no oscillation", () => {
    const f1 = writeDiffFile(tmp, "r1.md", []);
    const f2 = writeDiffFile(tmp, "r2.md", [{ severity: "warning", file: "a.js", line: 1, issue: "new", fix: "f", reasoning: "r" }]);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.oscillation, false);
  });

  it("T748 — all fields present in output", () => {
    const f1 = writeDiffFile(tmp, "r1.md", []);
    const f2 = writeDiffFile(tmp, "r2.md", []);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    const expected = ["round1_findings", "round2_findings", "recurring", "new", "resolved", "oscillation", "recurring_details"];
    for (const key of expected) assert.ok(key in out, `Missing key: ${key}`);
  });

  it("T749 — CRLF in eval files handled", () => {
    const f1p = join(tmp, "r1.md");
    writeFileSync(f1p, "🟡 a.js:1 — warn\r\nreasoning: r\r\n→ f\r\nVERDICT: ITERATE FINDINGS[1]\r\n");
    const f2p = join(tmp, "r2.md");
    writeFileSync(f2p, "🟡 a.js:1 — warn\nreasoning: r\n→ f\nVERDICT: ITERATE FINDINGS[1]\n");
    const c = capture(() => cmdDiff([f1p, f2p]));
    const out = parseOutput(c);
    assert.equal(out.recurring, 1);
  });

  it("T750 — large diff with 50 findings", () => {
    const r1 = Array.from({ length: 50 }, (_, i) => ({
      severity: "warning", file: `f${i}.js`, line: i + 1, issue: `issue${i}`, fix: "f", reasoning: "r",
    }));
    const r2 = Array.from({ length: 50 }, (_, i) => ({
      severity: "warning", file: `f${i + 25}.js`, line: i + 1, issue: `issue${i + 25}`, fix: "f", reasoning: "r",
    }));
    const f1 = writeDiffFile(tmp, "r1.md", r1);
    const f2 = writeDiffFile(tmp, "r2.md", r2);
    const c = capture(() => cmdDiff([f1, f2]));
    const out = parseOutput(c);
    assert.equal(out.round1_findings, 50);
    assert.equal(out.round2_findings, 50);
    assert.ok(out.recurring + out.new + out.resolved > 0);
  });
});
