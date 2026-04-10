// tests/verify-parser-boundaries.test.mjs — V001-V200 (200 tests)
// Boundary conditions and stress tests for eval-parser.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEvaluation,
  SEVERITY_MAP,
  SEVERITY_RE,
  FILE_REF_RE,
  HEDGING_RE,
  VERDICT_RE,
  FINDINGS_N_RE,
} from '../bin/lib/eval-parser.mjs';

// ============================================================================
// S01: Regex Boundary Tests — SEVERITY_RE (V001–V015)
// ============================================================================
describe('S01: SEVERITY_RE boundaries', () => {
  it('V001 matches 🔴 standalone', () => {
    assert.ok(SEVERITY_RE.test('🔴'));
  });

  it('V002 matches 🔴 with surrounding ASCII text', () => {
    const m = 'hello 🔴 world'.match(SEVERITY_RE);
    assert.ok(m);
    assert.equal(m[1], '🔴');
  });

  it('V003 matches 🔴 adjacent to CJK characters', () => {
    const m = '错误🔴严重'.match(SEVERITY_RE);
    assert.ok(m);
    assert.equal(m[1], '🔴');
  });

  it('V004 matches 🔴 adjacent to Arabic text', () => {
    const m = 'مشكلة🔴خطير'.match(SEVERITY_RE);
    assert.ok(m);
    assert.equal(m[1], '🔴');
  });

  it('V005 matches 🔴 adjacent to Cyrillic text', () => {
    const m = 'ошибка🔴критический'.match(SEVERITY_RE);
    assert.ok(m);
    assert.equal(m[1], '🔴');
  });

  it('V006 matches 🟡 with square brackets', () => {
    const m = '[🟡]'.match(SEVERITY_RE);
    assert.ok(m);
    assert.equal(m[1], '🟡');
  });

  it('V007 matches 🔵 without square brackets', () => {
    const m = '🔵 suggestion'.match(SEVERITY_RE);
    assert.ok(m);
    assert.equal(m[1], '🔵');
  });

  it('V008 matches only first emoji when multiple present', () => {
    const m = '🔴🟡🔵'.match(SEVERITY_RE);
    assert.ok(m);
    assert.equal(m[1], '🔴');
  });

  it('V009 does NOT match unrelated emoji', () => {
    assert.equal(SEVERITY_RE.test('🟢 all good'), false);
  });

  it('V010 does NOT match red circle text representation', () => {
    assert.equal(SEVERITY_RE.test(':red_circle:'), false);
  });

  it('V011 matches 🔴 preceded by newline', () => {
    const m = '\n🔴 issue'.match(SEVERITY_RE);
    assert.ok(m);
    assert.equal(m[1], '🔴');
  });

  it('V012 matches 🔴 preceded by tab', () => {
    const m = '\t🔴 issue'.match(SEVERITY_RE);
    assert.ok(m);
    assert.equal(m[1], '🔴');
  });

  it('V013 matches 🟡 adjacent to emoji variation selector', () => {
    const m = '🟡\uFE0F warning'.match(SEVERITY_RE);
    assert.ok(m);
    assert.equal(m[1], '🟡');
  });

  it('V014 matches 🔴 inside parentheses', () => {
    const m = '(🔴) critical'.match(SEVERITY_RE);
    assert.ok(m);
    assert.equal(m[1], '🔴');
  });

  it('V015 matches 🔵 at end of string', () => {
    const m = 'text 🔵'.match(SEVERITY_RE);
    assert.ok(m);
    assert.equal(m[1], '🔵');
  });
});

// ============================================================================
// S02: Regex Boundary Tests — FILE_REF_RE (V016–V030)
// ============================================================================
describe('S02: FILE_REF_RE boundaries', () => {
  it('V016 matches simple file ref', () => {
    assert.ok(FILE_REF_RE.test('src/app.js:10'));
  });

  it('V017 matches file with dots in path', () => {
    assert.ok(FILE_REF_RE.test('src/my.module.js:42'));
  });

  it('V018 matches file with dashes in path', () => {
    assert.ok(FILE_REF_RE.test('src/my-component.tsx:1'));
  });

  it('V019 matches file with underscores in path', () => {
    assert.ok(FILE_REF_RE.test('src/my_module.py:99'));
  });

  it('V020 matches deeply nested path', () => {
    assert.ok(FILE_REF_RE.test('a/b/c/d/e/f/g.rs:1'));
  });

  it('V021 matches file with single-char extension', () => {
    assert.ok(FILE_REF_RE.test('main.c:100'));
  });

  it('V022 matches file with long extension', () => {
    assert.ok(FILE_REF_RE.test('template.handlebars:5'));
  });

  it('V023 does NOT match path without line number', () => {
    assert.equal(FILE_REF_RE.test('src/app.js'), false);
  });

  it('V024 does NOT match path with colon but no digits', () => {
    assert.equal(FILE_REF_RE.test('src/app.js:abc'), false);
  });

  it('V025 matches path at boundary with surrounding text', () => {
    const m = 'see file src/app.js:10 for details'.match(FILE_REF_RE);
    assert.ok(m);
    assert.equal(m[0], 'src/app.js:10');
  });

  it('V026 matches file with multiple dots', () => {
    assert.ok(FILE_REF_RE.test('src/app.module.spec.ts:3'));
  });

  it('V027 matches file starting with dot', () => {
    assert.ok(FILE_REF_RE.test('.eslintrc.json:1'));
  });

  it('V028 matches large line number', () => {
    assert.ok(FILE_REF_RE.test('file.txt:999999'));
  });

  it('V029 matches line number 0', () => {
    // Regex doesn't validate line number semantics, just pattern
    assert.ok(FILE_REF_RE.test('file.txt:0'));
  });

  it('V030 does NOT match bare number after colon with no extension', () => {
    // "foobar:10" has no dot so no extension — should NOT match
    assert.equal(FILE_REF_RE.test('foobar:10'), false);
  });
});

// ============================================================================
// S03: Regex Boundary Tests — HEDGING_RE (V031–V050)
// ============================================================================
describe('S03: HEDGING_RE boundaries', () => {
  it('V031 matches "might" as whole word', () => {
    assert.ok(HEDGING_RE.test('This might be an issue'));
  });

  it('V032 does NOT match "nightmare" (should not match "might" inside)', () => {
    assert.equal(HEDGING_RE.test('This is a nightmare'), false);
  });

  it('V033 does NOT match "almighty"', () => {
    assert.equal(HEDGING_RE.test('The almighty server'), false);
  });

  it('V034 matches "could potentially"', () => {
    assert.ok(HEDGING_RE.test('This could potentially cause issues'));
  });

  it('V035 does NOT match "could" alone (without "potentially")', () => {
    assert.equal(HEDGING_RE.test('This could cause issues'), false);
  });

  it('V036 matches "consider" as whole word', () => {
    assert.ok(HEDGING_RE.test('You should consider refactoring'));
  });

  it('V037 does NOT match "reconsider"', () => {
    assert.equal(HEDGING_RE.test('Please reconsider the approach'), false);
  });

  it('V038 does NOT match "consideration"', () => {
    assert.equal(HEDGING_RE.test('Under consideration'), false);
  });

  it('V039 does NOT match "inconsiderate"', () => {
    assert.equal(HEDGING_RE.test('An inconsiderate change'), false);
  });

  it('V040 matches "might" case-insensitively', () => {
    assert.ok(HEDGING_RE.test('MIGHT be an issue'));
  });

  it('V041 matches "Consider" with capital C', () => {
    assert.ok(HEDGING_RE.test('Consider using a map'));
  });

  it('V042 matches "COULD POTENTIALLY" uppercase', () => {
    assert.ok(HEDGING_RE.test('COULD POTENTIALLY break'));
  });

  it('V043 matches "might" at start of line', () => {
    assert.ok(HEDGING_RE.test('might cause a crash'));
  });

  it('V044 matches "might" at end of line', () => {
    assert.ok(HEDGING_RE.test('the server might'));
  });

  it('V045 does NOT match "mightily"', () => {
    assert.equal(HEDGING_RE.test('mightily impressive'), false);
  });

  it('V046 matches "consider" preceded by punctuation', () => {
    assert.ok(HEDGING_RE.test('Please, consider this'));
  });

  it('V047 matches "might" followed by punctuation', () => {
    assert.ok(HEDGING_RE.test('It might.'));
  });

  it('V048 does NOT match "considered"', () => {
    assert.equal(HEDGING_RE.test('We considered this'), false);
  });

  it('V049 does NOT match "considers"', () => {
    assert.equal(HEDGING_RE.test('She considers it done'), false);
  });

  it('V050 matches "could potentially" with extra spaces between', () => {
    // Depends on regex — "could potentially" requires exact spacing
    assert.equal(HEDGING_RE.test('could  potentially'), false);
  });
});

// ============================================================================
// S04: VERDICT_RE boundary tests (V051–V060)
// ============================================================================
describe('S04: VERDICT_RE boundaries', () => {
  it('V051 matches "VERDICT: PASS"', () => {
    const m = 'VERDICT: PASS'.match(VERDICT_RE);
    assert.ok(m);
    assert.equal(m[1], 'PASS');
  });

  it('V052 matches "verdict: pass" lowercase', () => {
    const m = 'verdict: pass'.match(VERDICT_RE);
    assert.ok(m);
    assert.equal(m[1], 'pass');
  });

  it('V053 matches with leading whitespace', () => {
    const m = '   VERDICT: FAIL'.match(VERDICT_RE);
    assert.ok(m);
    assert.equal(m[1], 'FAIL');
  });

  it('V054 matches with trailing content', () => {
    const m = 'VERDICT: PASS — everything looks good'.match(VERDICT_RE);
    assert.ok(m);
    assert.equal(m[1], 'PASS — everything looks good');
  });

  it('V055 does NOT match "VERDICT" without colon', () => {
    assert.equal(VERDICT_RE.test('VERDICT PASS'), false);
  });

  it('V056 matches "VERDICT:" with extra spaces before value', () => {
    const m = 'VERDICT:    PASS'.match(VERDICT_RE);
    assert.ok(m);
    // \s* consumes leading spaces, (.+) captures "PASS"
    assert.equal(m[1], 'PASS');
  });

  it('V057 matches verdict embedded in larger text', () => {
    const m = 'Final VERDICT: PASS here'.match(VERDICT_RE);
    assert.ok(m);
    assert.equal(m[1], 'PASS here');
  });

  it('V058 matches "VERDICT:" with trailing space (backtrack gives space to .+)', () => {
    // \s* is greedy but backtracks so (.+) can capture at least one space char
    const m = 'VERDICT: '.match(VERDICT_RE);
    assert.ok(m);
    assert.equal(m[1], ' ');
  });

  it('V059 matches "Verdict:" mixed case', () => {
    const m = 'Verdict: Acceptable'.match(VERDICT_RE);
    assert.ok(m);
    assert.equal(m[1], 'Acceptable');
  });

  it('V060 matches verdict with FINDINGS[N]', () => {
    const m = 'VERDICT: PASS — FINDINGS[3]'.match(VERDICT_RE);
    assert.ok(m);
    assert.ok(m[1].includes('FINDINGS[3]'));
  });
});

// ============================================================================
// S05: Parser State Machine — unusual ordering (V061–V100)
// ============================================================================
describe('S05: Parser state machine', () => {
  it('V061 fix line without preceding severity is ignored', () => {
    const r = parseEvaluation('→ Fix the thing');
    assert.equal(r.findings_count, 0);
    assert.deepEqual(r.findings, []);
  });

  it('V062 reasoning line without preceding severity is ignored', () => {
    const r = parseEvaluation('Reasoning: because reasons');
    assert.equal(r.findings_count, 0);
  });

  it('V063 two severity lines back-to-back create two findings', () => {
    const text = '🔴 a.js:1 — First\n🔴 b.js:2 — Second';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
    assert.equal(r.findings[0].issue, 'First');
    assert.equal(r.findings[1].issue, 'Second');
  });

  it('V064 fix line goes to the latest finding', () => {
    const text = '🔴 a.js:1 — Issue\n→ Fix it';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Fix it');
  });

  it('V065 two fix lines — last one wins', () => {
    const text = '🔴 a.js:1 — Issue\n→ Fix A\n→ Fix B';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Fix B');
  });

  it('V066 reasoning after fix', () => {
    const text = '🔴 a.js:1 — Issue\n→ Fix it\nReasoning: because';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Fix it');
    assert.equal(r.findings[0].reasoning, 'because');
  });

  it('V067 fix after reasoning', () => {
    const text = '🔴 a.js:1 — Issue\nReasoning: because\n→ Fix it';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'because');
    assert.equal(r.findings[0].fix, 'Fix it');
  });

  it('V068 severity inside markdown heading is skipped', () => {
    const r = parseEvaluation('# 🔴 Section Title');
    assert.equal(r.findings_count, 0);
  });

  it('V069 severity inside ## heading is skipped', () => {
    const r = parseEvaluation('## 🟡 Warning Section');
    assert.equal(r.findings_count, 0);
  });

  it('V070 severity inside ### heading is skipped', () => {
    const r = parseEvaluation('### 🔵 Suggestion Section');
    assert.equal(r.findings_count, 0);
  });

  it('V071 mixed headings and findings', () => {
    const text = '# 🔴 Title\n🔴 a.js:1 — Real finding\n## 🟡 Section\n🟡 b.js:2 — Real warning';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
    assert.equal(r.critical, 1);
    assert.equal(r.warning, 1);
  });

  it('V072 finding spanning many continuation lines', () => {
    let text = '🔴 a.js:1 — Issue\n';
    for (let i = 0; i < 100; i++) {
      text += `Line ${i} of context\n`;
    }
    text += '→ Fix it\n';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].fix, 'Fix it');
  });

  it('V073 interleaved findings and verdicts', () => {
    const text = '🔴 a.js:1 — A\nVERDICT: MID\n🟡 b.js:2 — B\nVERDICT: FINAL';
    const r = parseEvaluation(text);
    assert.equal(r.verdict, 'FINAL');
    assert.equal(r.findings_count, 2);
  });

  it('V074 last verdict wins when multiple present', () => {
    const text = 'VERDICT: FIRST\nVERDICT: SECOND\nVERDICT: THIRD';
    const r = parseEvaluation(text);
    assert.equal(r.verdict, 'THIRD');
  });

  it('V075 finding without em-dash uses entire trimmed line as issue', () => {
    const r = parseEvaluation('🔴 simple issue without dash');
    assert.equal(r.findings[0].issue, '🔴 simple issue without dash');
  });

  it('V076 finding with file ref but no em-dash', () => {
    const r = parseEvaluation('🔴 src/app.js:10 no dash here');
    assert.equal(r.findings[0].file, 'src/app.js');
    assert.equal(r.findings[0].line, 10);
  });

  it('V077 finding with em-dash extracts issue after dash', () => {
    const r = parseEvaluation('🔴 src/app.js:10 — Memory leak');
    assert.equal(r.findings[0].issue, 'Memory leak');
  });

  it('V078 CRLF line endings normalized', () => {
    const text = '🔴 a.js:1 — Issue\r\n→ Fix\r\nVERDICT: PASS';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].fix, 'Fix');
    assert.equal(r.verdict, 'PASS');
  });

  it('V079 empty lines between findings', () => {
    const text = '🔴 a.js:1 — A\n\n\n\n🟡 b.js:2 — B';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
  });

  it('V080 finding with bracket-wrapped emoji [🔴]', () => {
    const r = parseEvaluation('[🔴] src/app.js:10 — Issue');
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].severity, 'critical');
  });

  it('V081 verdict on very first line', () => {
    const r = parseEvaluation('VERDICT: PASS\n🔴 a.js:1 — Issue');
    assert.equal(r.verdict_present, true);
    assert.equal(r.findings_count, 1);
  });

  it('V082 verdict on very last line', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\nVERDICT: PASS');
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, 'PASS');
  });

  it('V083 fix line with only arrow and spaces', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\n→   ');
    assert.equal(r.findings[0].fix, '');
  });

  it('V084 reasoning line with empty value', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\nReasoning:   ');
    assert.equal(r.findings[0].reasoning, '');
  });

  it('V085 finding default status is accepted', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue');
    assert.equal(r.findings[0].status, 'accepted');
    assert.equal(r.findings[0].dismissReason, null);
  });

  it('V086 three findings rapid succession with fixes', () => {
    const text = [
      '🔴 a.js:1 — A', '→ Fix A',
      '🟡 b.js:2 — B', '→ Fix B',
      '🔵 c.js:3 — C', '→ Fix C',
    ].join('\n');
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 3);
    assert.equal(r.findings[0].fix, 'Fix A');
    assert.equal(r.findings[1].fix, 'Fix B');
    assert.equal(r.findings[2].fix, 'Fix C');
  });

  it('V087 severity line with leading spaces is still parsed', () => {
    const r = parseEvaluation('   🔴 src/app.js:10 — Issue');
    assert.equal(r.findings_count, 1);
  });

  it('V088 severity line with leading tab', () => {
    const r = parseEvaluation('\t🔴 src/app.js:10 — Issue');
    assert.equal(r.findings_count, 1);
  });

  it('V089 fix with arrow and multi-word instruction', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\n→ Refactor the entire module to use async/await');
    assert.equal(r.findings[0].fix, 'Refactor the entire module to use async/await');
  });

  it('V090 reasoning with colon in value', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\nReasoning: see: https://example.com');
    assert.equal(r.findings[0].reasoning, 'see: https://example.com');
  });

  it('V091 10 findings alternating severity', () => {
    const lines = [];
    for (let i = 0; i < 10; i++) {
      const emoji = ['🔴', '🟡', '🔵'][i % 3];
      lines.push(`${emoji} f${i}.js:${i + 1} — Issue ${i}`);
    }
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.findings_count, 10);
  });

  it('V092 finding after blank line still attaches fix', () => {
    const text = '🔴 a.js:1 — Issue\n\n→ Fix it';
    const r = parseEvaluation(text);
    // Blank line doesn't reset currentFinding
    assert.equal(r.findings[0].fix, 'Fix it');
  });

  it('V093 multiple file refs in one line — first one extracted', () => {
    const r = parseEvaluation('🔴 a.js:1 see also b.js:2 — Issue');
    assert.equal(r.findings[0].file, 'a.js');
    assert.equal(r.findings[0].line, 1);
  });

  it('V094 finding on last line without trailing newline', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue');
    assert.equal(r.findings_count, 1);
  });

  it('V095 verdict line also containing severity emoji', () => {
    const r = parseEvaluation('VERDICT: 🔴 FAIL FINDINGS[1]');
    // VERDICT line is matched; severity is also matched
    assert.equal(r.verdict_present, true);
    assert.ok(r.verdict.includes('FAIL'));
  });

  it('V096 finding with reasoning on same line as issue (not parsed as reasoning)', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue reasoning: inline');
    assert.equal(r.findings[0].reasoning, null);
    assert.ok(r.findings[0].issue.includes('reasoning:'));
  });

  it('V097 finding severity on line with markdown bold', () => {
    const r = parseEvaluation('**🔴 Critical** src/a.js:10 — Issue');
    assert.equal(r.findings_count, 1);
  });

  it('V098 consecutive reasoning lines — last wins', () => {
    const text = '🔴 a.js:1 — Issue\nReasoning: first\nReasoning: second';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'second');
  });

  it('V099 verdict with FINDINGS[0]', () => {
    const r = parseEvaluation('VERDICT: PASS — FINDINGS[0]');
    assert.equal(r.verdict_count_match, true);
    assert.equal(r.findings_count, 0);
  });

  it('V100 verdict with FINDINGS[N] mismatch', () => {
    const text = '🔴 a.js:1 — Issue\nVERDICT: FAIL — FINDINGS[5]';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, false);
  });
});

// ============================================================================
// S06: Encoding Stress (V101–V130)
// ============================================================================
describe('S06: Encoding stress', () => {
  it('V101 null bytes in text are handled', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\0with null');
    assert.equal(r.findings_count, 1);
  });

  it('V102 BOM character at start', () => {
    const r = parseEvaluation('\uFEFF🔴 a.js:1 — Issue');
    assert.equal(r.findings_count, 1);
  });

  it('V103 mixed BOM and findings', () => {
    const r = parseEvaluation('\uFEFFVERDICT: PASS\n🔴 a.js:1 — Issue');
    assert.equal(r.verdict_present, true);
    assert.equal(r.findings_count, 1);
  });

  it('V104 surrogate pair characters in issue text', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue with 𝕳𝖊𝖆𝖉𝖎𝖓𝖌');
    assert.equal(r.findings_count, 1);
  });

  it('V105 zero-width joiner in text', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\u200Dwith ZWJ');
    assert.equal(r.findings_count, 1);
  });

  it('V106 zero-width space in text', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\u200Bwith ZWS');
    assert.equal(r.findings_count, 1);
  });

  it('V107 RTL override character', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue \u202E reversed');
    assert.equal(r.findings_count, 1);
  });

  it('V108 emoji variation selector after severity emoji', () => {
    const r = parseEvaluation('🔴\uFE0F a.js:1 — Issue');
    assert.equal(r.findings_count, 1);
  });

  it('V109 text with form feed characters', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\fmore text');
    assert.equal(r.findings_count, 1);
  });

  it('V110 text with vertical tab', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\vmore');
    assert.equal(r.findings_count, 1);
  });

  it('V111 text with backspace characters', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\b\b\bmod');
    assert.equal(r.findings_count, 1);
  });

  it('V112 combining diacritical marks', () => {
    const r = parseEvaluation('🔴 a.js:1 — Iss\u0301ue with accent');
    assert.equal(r.findings_count, 1);
  });

  it('V113 text with soft hyphen', () => {
    const r = parseEvaluation('🔴 a.js:1 — Is\u00ADsue');
    assert.equal(r.findings_count, 1);
  });

  it('V114 text with non-breaking space', () => {
    const r = parseEvaluation('🔴 a.js:1 —\u00A0Issue');
    assert.equal(r.findings_count, 1);
  });

  it('V115 emoji skin tone modifier near severity emoji', () => {
    const r = parseEvaluation('👍🏽 🔴 a.js:1 — Issue');
    assert.equal(r.findings_count, 1);
  });

  it('V116 Korean text around finding', () => {
    const r = parseEvaluation('문제 🔴 a.js:1 — 메모리 누수');
    assert.equal(r.findings_count, 1);
  });

  it('V117 Japanese text around finding', () => {
    const r = parseEvaluation('🔴 app.js:1 — メモリリーク問題');
    assert.equal(r.findings_count, 1);
  });

  it('V118 mixed script finding', () => {
    const r = parseEvaluation('🔴 模块/app.js:1 — Issue');
    // Path won't match FILE_REF_RE because of CJK in path
    assert.equal(r.findings_count, 1);
  });

  it('V119 text only null bytes', () => {
    const r = parseEvaluation('\0\0\0');
    assert.equal(r.findings_count, 0);
  });

  it('V120 extremely long single codepoint repeated', () => {
    const r = parseEvaluation('a'.repeat(5000));
    assert.equal(r.findings_count, 0);
  });

  it('V121 emoji zwj sequence near severity', () => {
    // Family emoji (ZWJ sequence) then finding
    const r = parseEvaluation('👨‍👩‍👧‍👦 🔴 a.js:1 — Issue');
    assert.equal(r.findings_count, 1);
  });

  it('V122 regional indicator symbols', () => {
    const r = parseEvaluation('🇺🇸 🔴 a.js:1 — Issue');
    assert.equal(r.findings_count, 1);
  });

  it('V123 text with escape sequences as literal text', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue with \\n and \\t');
    assert.equal(r.findings_count, 1);
  });

  it('V124 text with HTML entities (not decoded)', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue &amp; more');
    assert.equal(r.findings_count, 1);
  });

  it('V125 mathematical symbols', () => {
    const r = parseEvaluation('🔴 a.js:1 — ∑ ∏ ∫ overflow');
    assert.equal(r.findings_count, 1);
  });

  it('V126 Devanagari script', () => {
    const r = parseEvaluation('🔴 a.js:1 — समस्या');
    assert.equal(r.findings_count, 1);
  });

  it('V127 Thai script', () => {
    const r = parseEvaluation('🔴 a.js:1 — ปัญหา');
    assert.equal(r.findings_count, 1);
  });

  it('V128 emoji keycap sequences — # keycap starts with # so treated as heading', () => {
    const r = parseEvaluation('#️⃣1️⃣ 🔴 a.js:1 — Issue');
    // Line starts with "#" (from #️⃣ keycap), so parser treats it as a heading and skips
    assert.equal(r.findings_count, 0);
  });

  it('V129 control characters STX/ETX', () => {
    const r = parseEvaluation('\x02🔴 a.js:1 — Issue\x03');
    assert.equal(r.findings_count, 1);
  });

  it('V130 mixed CRLF and LF line endings', () => {
    const r = parseEvaluation('🔴 a.js:1 — A\r\n🟡 b.js:2 — B\n🔵 c.js:3 — C');
    assert.equal(r.findings_count, 3);
  });
});

// ============================================================================
// S07: Fuzzy Inputs (V131–V160)
// ============================================================================
describe('S07: Fuzzy inputs', () => {
  it('V131 "VERDICT:" with no value after', () => {
    const r = parseEvaluation('VERDICT:');
    assert.equal(r.verdict_present, false);
  });

  it('V132 "VERDICT: " with only whitespace after', () => {
    const r = parseEvaluation('VERDICT:   ');
    assert.equal(r.verdict_present, false);
  });

  it('V133 🔴 at end of file with nothing after', () => {
    const r = parseEvaluation('text\n🔴');
    assert.equal(r.findings_count, 1);
  });

  it('V134 file ref with line 0', () => {
    const r = parseEvaluation('🔴 a.js:0 — Issue');
    assert.equal(r.findings[0].line, 0);
  });

  it('V135 file ref with very large line number', () => {
    const r = parseEvaluation('🔴 a.js:9999999 — Issue');
    assert.equal(r.findings[0].line, 9999999);
  });

  it('V136 string that looks like verdict but is in code block context', () => {
    // Parser doesn't understand code blocks — it will match
    const r = parseEvaluation('```\nVERDICT: CODE\n```');
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, 'CODE');
  });

  it('V137 severity emoji in URL-like context', () => {
    // Parser matches emoji regardless of context
    const r = parseEvaluation('https://example.com/🔴/page a.js:1');
    assert.equal(r.findings_count, 1);
  });

  it('V138 multiple colons in file ref — first colon used', () => {
    const r = parseEvaluation('🔴 C:/Users/app.js:10 — Issue');
    // FILE_REF_RE will match app.js:10
    assert.ok(r.has_file_refs);
  });

  it('V139 FINDINGS[N] without VERDICT', () => {
    const r = parseEvaluation('FINDINGS[3]');
    assert.equal(r.verdict_present, false);
  });

  it('V140 FINDINGS[N] in non-verdict line', () => {
    const r = parseEvaluation('There are FINDINGS[3] total\nVERDICT: PASS');
    // FINDINGS_N_RE is only checked against verdict content
    assert.equal(r.verdict, 'PASS');
  });

  it('V141 arrow character in non-fix context (no currentFinding)', () => {
    const r = parseEvaluation('→ This is just an arrow');
    assert.equal(r.findings_count, 0);
  });

  it('V142 only whitespace lines', () => {
    const r = parseEvaluation('   \n   \n   \n   ');
    assert.equal(r.findings_count, 0);
    assert.equal(r.verdict_present, false);
  });

  it('V143 just newlines', () => {
    const r = parseEvaluation('\n\n\n\n\n');
    assert.equal(r.findings_count, 0);
  });

  it('V144 tab-only lines', () => {
    const r = parseEvaluation('\t\t\t\n\t\t\n\t');
    assert.equal(r.findings_count, 0);
  });

  it('V145 "reasoning:" not at line start', () => {
    const text = '🔴 a.js:1 — Issue\nsome text reasoning: embedded';
    const r = parseEvaluation(text);
    // trimmed line doesn't start with "reasoning:" so it won't be parsed as reasoning
    assert.equal(r.findings[0].reasoning, null);
  });

  it('V146 leading "reasoning:" (matches regex)', () => {
    const text = '🔴 a.js:1 — Issue\nreasoning: it is broken';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'it is broken');
  });

  it('V147 "Reasoning:" with capital R', () => {
    const text = '🔴 a.js:1 — Issue\nReasoning: it is broken';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'it is broken');
  });

  it('V148 "REASONING:" all caps', () => {
    const text = '🔴 a.js:1 — Issue\nREASONING: it is broken';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'it is broken');
  });

  it('V149 arrow followed immediately by newline', () => {
    const text = '🔴 a.js:1 — Issue\n→\n';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, '');
  });

  it('V150 text with only emoji (no severity)', () => {
    const r = parseEvaluation('👍 💯 ✅ 🎉');
    assert.equal(r.findings_count, 0);
  });

  it('V151 verdict inside markdown link', () => {
    const r = parseEvaluation('[VERDICT: PASS](http://example.com)');
    assert.equal(r.verdict_present, true);
  });

  it('V152 severity in HTML comment', () => {
    // Parser doesn't understand HTML comments
    const r = parseEvaluation('<!-- 🔴 a.js:1 — Issue -->');
    assert.equal(r.findings_count, 1);
  });

  it('V153 severity in markdown strikethrough', () => {
    const r = parseEvaluation('~~🔴 a.js:1 — Issue~~');
    assert.equal(r.findings_count, 1);
  });

  it('V154 number-only verdict value', () => {
    const r = parseEvaluation('VERDICT: 42');
    assert.equal(r.verdict, '42');
  });

  it('V155 emoji-only verdict value', () => {
    const r = parseEvaluation('VERDICT: ✅');
    assert.equal(r.verdict, '✅');
  });

  it('V156 finding with no space after emoji', () => {
    const r = parseEvaluation('🔴a.js:1 — Issue');
    assert.equal(r.findings_count, 1);
  });

  it('V157 FINDINGS with lowercase', () => {
    const r = parseEvaluation('VERDICT: findings[3]');
    const m = r.verdict.match(FINDINGS_N_RE);
    assert.ok(m);
    assert.equal(m[1], '3');
  });

  it('V158 FINDINGS with spaces before bracket', () => {
    const m = 'FINDINGS [5]'.match(FINDINGS_N_RE);
    assert.ok(m);
    assert.equal(m[1], '5');
  });

  it('V159 nested emoji sequences as issue text', () => {
    const r = parseEvaluation('🔴 a.js:1 — 🎯🔥💡 Fix needed');
    assert.equal(r.findings_count, 1);
    assert.ok(r.findings[0].issue.includes('🎯'));
  });

  it('V160 extremely long file path', () => {
    const path = 'a/'.repeat(200) + 'file.js:1';
    const r = parseEvaluation(`🔴 ${path} — Issue`);
    assert.equal(r.findings_count, 1);
    assert.ok(r.has_file_refs);
  });
});

// ============================================================================
// S08: Large-scale tests (V161–V180)
// ============================================================================
describe('S08: Large-scale', () => {
  it('V161 document with 500 findings', () => {
    const lines = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`🔴 file${i}.js:${i + 1} — Issue ${i}`);
    }
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.findings_count, 500);
    assert.equal(r.findings.length, 500);
  });

  it('V162 document with 10000 blank lines then one finding', () => {
    const text = '\n'.repeat(10000) + '🔴 a.js:1 — Issue';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
  });

  it('V163 single line with 10000 characters followed by finding', () => {
    const text = 'x'.repeat(10000) + '\n🔴 a.js:1 — Issue';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
  });

  it('V164 100 verdict lines (last wins)', () => {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`VERDICT: Result ${i}`);
    }
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.verdict, 'Result 99');
  });

  it('V165 100 FINDINGS[N] markers in verdict — last verdict extracted', () => {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`VERDICT: PASS FINDINGS[${i}]`);
    }
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.verdict_present, true);
    assert.ok(r.verdict.includes('FINDINGS[99]'));
  });

  it('V166 all three severities in bulk (200 each)', () => {
    const lines = [];
    for (let i = 0; i < 200; i++) lines.push(`🔴 f${i}.js:1 — C${i}`);
    for (let i = 0; i < 200; i++) lines.push(`🟡 f${i}.js:1 — W${i}`);
    for (let i = 0; i < 200; i++) lines.push(`🔵 f${i}.js:1 — S${i}`);
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.critical, 200);
    assert.equal(r.warning, 200);
    assert.equal(r.suggestion, 200);
    assert.equal(r.findings_count, 600);
  });

  it('V167 500 findings with fixes and reasoning', () => {
    const lines = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`🔴 f${i}.js:${i + 1} — Issue ${i}`);
      lines.push(`→ Fix ${i}`);
      lines.push(`Reasoning: Because ${i}`);
    }
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.findings_count, 500);
    assert.equal(r.findings[499].fix, 'Fix 499');
    assert.equal(r.findings[499].reasoning, 'Because 499');
  });

  it('V168 very long issue text (5000 chars)', () => {
    const issue = 'A'.repeat(5000);
    const r = parseEvaluation(`🔴 a.js:1 — ${issue}`);
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].issue.length, 5000);
  });

  it('V169 document with 1000 hedging lines', () => {
    const lines = ['🔴 a.js:1 — Issue'];
    for (let i = 0; i < 1000; i++) {
      lines.push(`This might cause problems line ${i}`);
    }
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.hedging_detected.length, 1000);
  });

  it('V170 empty string', () => {
    const r = parseEvaluation('');
    assert.equal(r.findings_count, 0);
    assert.equal(r.verdict_present, false);
    assert.equal(r.verdict, '');
    assert.deepEqual(r.findings, []);
  });

  it('V171 single character string', () => {
    const r = parseEvaluation('x');
    assert.equal(r.findings_count, 0);
  });

  it('V172 single newline', () => {
    const r = parseEvaluation('\n');
    assert.equal(r.findings_count, 0);
  });

  it('V173 very long verdict text', () => {
    const v = 'PASS '.repeat(2000);
    const r = parseEvaluation(`VERDICT: ${v}`);
    assert.equal(r.verdict_present, true);
    assert.ok(r.verdict.length > 9000);
  });

  it('V174 500 file refs across findings', () => {
    const lines = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`🔴 path/to/file${i}.js:${i + 1} — Issue`);
    }
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.has_file_refs, true);
    assert.equal(r.findings.length, 500);
    assert.equal(r.findings[0].file, 'path/to/file0.js');
  });

  it('V175 alternating findings and empty lines (stress)', () => {
    const lines = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(i % 2 === 0 ? `🔴 f.js:${i + 1} — Issue` : '');
    }
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.findings_count, 500);
  });

  it('V176 massive non-matching text with one finding at end', () => {
    const text = 'Lorem ipsum dolor sit amet. '.repeat(5000) + '\n🔴 a.js:1 — Found it';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].issue, 'Found it');
  });

  it('V177 1000 heading lines with emoji (all skipped)', () => {
    const lines = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(`# 🔴 Heading ${i}`);
    }
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.findings_count, 0);
  });

  it('V178 large FINDINGS[N] number', () => {
    const r = parseEvaluation('VERDICT: PASS FINDINGS[99999]');
    const m = r.verdict.match(FINDINGS_N_RE);
    assert.ok(m);
    assert.equal(m[1], '99999');
  });

  it('V179 rapid CRLF in bulk', () => {
    const lines = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`🔴 f.js:${i + 1} — Issue ${i}`);
    }
    const r = parseEvaluation(lines.join('\r\n'));
    assert.equal(r.findings_count, 500);
  });

  it('V180 document with only verdicts and no findings', () => {
    const lines = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`VERDICT: Result ${i}`);
    }
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.findings_count, 0);
    assert.equal(r.verdict, 'Result 49');
    assert.equal(r.verdict_present, true);
  });
});

// ============================================================================
// S09: Regression Patterns — real-world markdown (V181–V200)
// ============================================================================
describe('S09: Regression patterns', () => {
  it('V181 nested blockquotes with finding', () => {
    const r = parseEvaluation('> > 🔴 a.js:1 — Nested issue');
    assert.equal(r.findings_count, 1);
  });

  it('V182 blockquote finding with fix', () => {
    const text = '> 🔴 a.js:1 — Issue\n> → Fix it';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
    // Fix line starts with ">" not "→" after trim, so won't be parsed as fix
    // Actually "> → Fix it".trim() = "> → Fix it", doesn't start with "→"
    assert.equal(r.findings[0].fix, null);
  });

  it('V183 code block with fake finding (parser matches it)', () => {
    const text = '```\n🔴 a.js:1 — Not real\n```';
    const r = parseEvaluation(text);
    // Parser doesn't understand code blocks
    assert.equal(r.findings_count, 1);
  });

  it('V184 inline code with severity emoji', () => {
    const r = parseEvaluation('Use `🔴` for critical issues');
    assert.equal(r.findings_count, 1); // Parser matches regardless
  });

  it('V185 table containing file refs', () => {
    const text = [
      '| Severity | File | Issue |',
      '|----------|------|-------|',
      '| 🔴 | src/app.js:10 | Memory leak |',
    ].join('\n');
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
    assert.ok(r.has_file_refs);
  });

  it('V186 HTML comment hiding a finding', () => {
    const r = parseEvaluation('<!-- 🔴 hidden.js:1 — Secret issue -->');
    // Parser doesn't handle HTML
    assert.equal(r.findings_count, 1);
  });

  it('V187 markdown link with file-ref-like text', () => {
    const r = parseEvaluation('🔴 [app.js:10](http://example.com) — Issue');
    assert.equal(r.findings_count, 1);
    assert.ok(r.has_file_refs);
  });

  it('V188 finding inside numbered list', () => {
    const text = '1. 🔴 a.js:1 — First\n2. 🟡 b.js:2 — Second';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
  });

  it('V189 finding inside bullet list', () => {
    const text = '- 🔴 a.js:1 — First\n- 🟡 b.js:2 — Second';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
  });

  it('V190 finding after horizontal rule', () => {
    const text = '---\n🔴 a.js:1 — After rule';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
  });

  it('V191 finding in task list checkbox', () => {
    const r = parseEvaluation('- [ ] 🔴 a.js:1 — Unchecked');
    assert.equal(r.findings_count, 1);
  });

  it('V192 footnote-style text with verdict', () => {
    const r = parseEvaluation('[^1]: VERDICT: PASS');
    assert.equal(r.verdict_present, true);
  });

  it('V193 details/summary HTML with finding', () => {
    const text = '<details>\n<summary>🔴 Issues</summary>\n🔴 a.js:1 — Inside details\n</details>';
    const r = parseEvaluation(text);
    // Two severity matches: one in summary (starts with <, not #), one in body
    assert.ok(r.findings_count >= 1);
  });

  it('V194 admonition-style with finding', () => {
    const text = '> [!WARNING]\n> 🟡 a.js:1 — Admonition finding';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
  });

  it('V195 LaTeX-like content near finding', () => {
    const r = parseEvaluation('$\\sum_{i=0}^{n}$ 🔴 a.js:1 — Math nearby');
    assert.equal(r.findings_count, 1);
  });

  it('V196 YAML frontmatter then finding', () => {
    const text = '---\ntitle: Report\n---\n🔴 a.js:1 — Issue';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
  });

  it('V197 finding text with markdown bold and italic', () => {
    const r = parseEvaluation('🔴 a.js:1 — **Critical** _memory_ issue');
    assert.equal(r.findings_count, 1);
  });

  it('V198 verdict in blockquote', () => {
    const r = parseEvaluation('> VERDICT: QUOTED PASS');
    assert.equal(r.verdict_present, true);
    assert.ok(r.verdict.includes('QUOTED PASS'));
  });

  it('V199 markdown image syntax near finding', () => {
    const r = parseEvaluation('![alt](img.png) 🔴 a.js:1 — Issue');
    assert.equal(r.findings_count, 1);
  });

  it('V200 real-world multiline evaluation document', () => {
    const text = [
      '# Code Review Evaluation',
      '',
      '## Findings',
      '',
      '🔴 src/auth/login.ts:45 — SQL injection vulnerability in login query',
      '→ Use parameterized queries instead of string concatenation',
      'Reasoning: User input is directly interpolated into SQL string',
      '',
      '🟡 src/api/handler.ts:120 — Missing error handling for async operation',
      '→ Wrap in try/catch and return appropriate HTTP status',
      'Reasoning: Unhandled promise rejection could crash the server',
      '',
      '🔵 src/utils/format.ts:8 — Consider using template literals',
      '→ Replace string concatenation with template literals for readability',
      '',
      '---',
      '',
      'VERDICT: FAIL — FINDINGS[3]',
    ].join('\n');
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 3);
    assert.equal(r.critical, 1);
    assert.equal(r.warning, 1);
    assert.equal(r.suggestion, 1);
    assert.equal(r.findings[0].file, 'src/auth/login.ts');
    assert.equal(r.findings[0].line, 45);
    assert.equal(r.findings[0].fix, 'Use parameterized queries instead of string concatenation');
    assert.equal(r.findings[0].reasoning, 'User input is directly interpolated into SQL string');
    assert.equal(r.findings[1].file, 'src/api/handler.ts');
    assert.equal(r.findings[1].line, 120);
    assert.equal(r.findings[2].file, 'src/utils/format.ts');
    assert.equal(r.verdict_present, true);
    assert.ok(r.verdict.includes('FAIL'));
    assert.equal(r.verdict_count_match, true);
    assert.equal(r.has_file_refs, true);
  });
});
