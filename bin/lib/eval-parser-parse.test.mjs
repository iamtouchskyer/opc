import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseEvaluation } from "./eval-parser.mjs";

describe("parseEvaluation", () => {
  test("detects verdict when present", () => {
    const r = parseEvaluation("VERDICT: PASS FINDINGS[0]");
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, "PASS FINDINGS[0]");
  });

  test("verdict absent", () => {
    const r = parseEvaluation("No verdict here");
    assert.equal(r.verdict_present, false);
    assert.equal(r.verdict, "");
  });

  test("counts severities", () => {
    const text = [
      "🔴 src/a.js:1 — critical bug",
      "🔴 src/b.js:2 — another critical",
      "🟡 src/c.js:3 — a warning",
      "🔵 src/d.js:4 — a suggestion",
    ].join("\n");
    const r = parseEvaluation(text);
    assert.equal(r.critical, 2);
    assert.equal(r.warning, 1);
    assert.equal(r.suggestion, 1);
    assert.equal(r.findings_count, 4);
  });

  test("detects file references", () => {
    const r = parseEvaluation("🔴 src/foo.js:10 — issue");
    assert.equal(r.has_file_refs, true);
  });

  test("no file refs when absent", () => {
    const r = parseEvaluation("🔴 some issue without file ref — bad");
    assert.equal(r.has_file_refs, false);
  });

  test("detects hedging", () => {
    const r = parseEvaluation("🔴 src/a.js:1 — you might want to fix this");
    assert.ok(r.hedging_detected.length > 0);
  });

  test("parses finding with file, line, fix, reasoning", () => {
    const text = [
      "🔴 src/app.js:42 — missing null check",
      "→ Add a null guard before access",
      "Reasoning: prevents runtime crash",
    ].join("\n");
    const r = parseEvaluation(text);
    assert.equal(r.findings.length, 1);
    const f = r.findings[0];
    assert.equal(f.severity, "critical");
    assert.equal(f.file, "src/app.js");
    assert.equal(f.line, 42);
    assert.equal(f.fix, "Add a null guard before access");
    assert.equal(f.reasoning, "prevents runtime crash");
  });

  test("skips section labels like '🔴 Must Fix:'", () => {
    const text = "🔴 Must Fix:\n🔴 src/a.js:1 — real finding";
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
  });

  test("skips empty markers (None., N/A) after section label", () => {
    const text = "🔴 Must Fix:\n- None.\n🟡 Warnings:\nN/A";
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 0);
  });

  test("skips bare emoji filler lines like '🔴 None.'", () => {
    const r = parseEvaluation("🔴 None.\n🟡 N/A\n🔵 nothing");
    assert.equal(r.findings_count, 0);
  });

  test("thinEval when lineCount < 50", () => {
    const r = parseEvaluation("short\neval");
    assert.equal(r.thinEval, true);
    assert.ok(r.lineCount < 50);
  });

  test("not thinEval when lineCount >= 50", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `Line ${i}`);
    const r = parseEvaluation(lines.join("\n"));
    assert.equal(r.thinEval, false);
  });

  test("CRLF normalization", () => {
    const r = parseEvaluation("VERDICT: PASS\r\n🔴 src/a.js:1 — bug\r\n");
    assert.equal(r.verdict_present, true);
    assert.equal(r.findings_count, 1);
  });

  test("verdictCountMatch when FINDINGS[N] matches", () => {
    const text = "VERDICT: PASS FINDINGS[2]\n🔴 a.js:1 — x\n🟡 b.js:2 — y";
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, true);
  });

  test("verdictCountMatch false when mismatch", () => {
    const text = "VERDICT: PASS FINDINGS[5]\n🔴 a.js:1 — x";
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, false);
  });

  test("verdictCountMatch null when no FINDINGS[N] but findings exist", () => {
    const text = "VERDICT: PASS\n🔴 a.js:1 — x";
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, null);
  });

  test("noCodeRefs true when no file:line refs", () => {
    const r = parseEvaluation("Just text with no refs");
    assert.equal(r.noCodeRefs, true);
  });

  test("fileLineRefCount counts all refs", () => {
    const r = parseEvaluation("🔴 a.js:1 — x\n🔴 b.js:2 — y");
    assert.equal(r.fileLineRefCount, 2);
  });

  test("lowUniqueContent detects copy-paste padding", () => {
    const lines = Array.from({ length: 30 }, () => "This is a repeated padding line");
    const r = parseEvaluation(lines.join("\n"));
    assert.equal(r.lowUniqueContent, true);
  });

  test("singleHeading true when only one heading and >=30 lines", () => {
    const lines = ["# Review", ...Array.from({ length: 35 }, (_, i) => `Content line ${i}`)];
    const r = parseEvaluation(lines.join("\n"));
    assert.equal(r.singleHeading, true);
  });

  test("singleHeading false with multiple headings", () => {
    const lines = ["# Review", "## Section", ...Array.from({ length: 35 }, (_, i) => `Line ${i}`)];
    const r = parseEvaluation(lines.join("\n"));
    assert.equal(r.singleHeading, false);
  });

  test("aspirationalClaims detected", () => {
    const text = [
      "🔴 a.js:1 — should consider refactoring this",
      "🔴 b.js:2 — worth exploring alternatives here",
      "🔴 c.js:3 — it would be nice to add tests",
    ].join("\n");
    const r = parseEvaluation(text);
    assert.equal(r.aspirationalClaims, true);
    assert.equal(r.aspirationalLineCount, 3);
  });

  test("aspirationalClaims false for actionable findings", () => {
    const text = [
      "🔴 a.js:1 — missing null check causes crash",
      "🔴 b.js:2 — SQL injection vulnerability",
    ].join("\n");
    const r = parseEvaluation(text);
    assert.equal(r.aspirationalClaims, false);
  });

  test("findingDensityLow when few emoji lines in long doc", () => {
    const lines = [
      "🔴 a.js:1 — one finding",
      ...Array.from({ length: 55 }, (_, i) => `Padding line number ${i} for density`),
    ];
    const r = parseEvaluation(lines.join("\n"));
    assert.equal(r.findingDensityLow, true);
  });

  test("missingReasoningRatio and missingFixRatio", () => {
    const text = "🔴 a.js:1 — issue without fix or reasoning";
    const r = parseEvaluation(text);
    assert.equal(r.missingReasoningRatio, 100);
    assert.equal(r.missingFixRatio, 100);
    assert.equal(r.findingsWithoutReasoning, 1);
    assert.equal(r.findingsWithoutFix, 1);
  });

  test("fix and reasoning bring ratios to 0", () => {
    const text = [
      "🔴 a.js:1 — issue",
      "→ Fix it",
      "Reasoning: because",
    ].join("\n");
    const r = parseEvaluation(text);
    assert.equal(r.missingReasoningRatio, 0);
    assert.equal(r.missingFixRatio, 0);
  });

  test("lineLengthVarianceLow for uniform lines", () => {
    const lines = Array.from({ length: 20 }, () => "Exactly the same length line here!!");
    const r = parseEvaluation(lines.join("\n"));
    assert.equal(r.lineLengthVarianceLow, true);
  });

  test("headingCount counts h1-h3 headings", () => {
    const text = "# H1\n## H2\n### H3\n#### H4 not counted";
    const r = parseEvaluation(text);
    assert.equal(r.headingCount, 3);
  });

  test("structured findings count despite PASS or resolved status text", () => {
    const r = parseEvaluation([
      "## Finding 1 — Lost event",
      "**Severity**: 🔴",
      "**Location**: `src/events.js:7`",
      "**R2 Status**: ✅",
      "Reasoning: terminal events can be lost",
      "→ Fix: preserve event ordering",
      "VERDICT: PASS FINDINGS[1]",
    ].join("\n"));
    assert.equal(r.critical, 1);
    assert.equal(r.verdict_count_match, true);
    assert.equal(r.findings[0].issue, "Lost event");
    assert.equal(r.findings[0].file, "src/events.js");
    assert.equal(r.findings[0].line, 7);
    assert.equal(r.findings[0].fix, "preserve event ordering");
    assert.equal(r.findingsWithoutReasoning, 0);
  });

  test("mixed formats deduplicate the same finding without lowering severity", () => {
    for (const reverse of [false, true]) {
      const blocks = [
        "🟡 src/events.js:7 — Lost event\nReasoning: events are lost\n→ Fix: preserve ordering",
        "## Finding 1 — Lost event\n**Severity**: 🔴\n**Location**: src/events.js:7",
      ];
      const r = parseEvaluation((reverse ? blocks.reverse() : blocks).join("\n"));
      assert.equal(r.findings_count, 1);
      assert.equal(r.critical, 1);
      assert.equal(r.warning, 0);
      assert.equal(r.findingsWithoutReasoning, 0);
      assert.equal(r.findingsWithoutFix, 0);
    }
  });

  test("metadata without a finding heading is not a finding", () => {
    assert.equal(parseEvaluation("**Severity**: 🔴\n**Location**: src/a.js:1").findings_count, 0);
  });
});
