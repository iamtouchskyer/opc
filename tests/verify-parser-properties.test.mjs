// tests/verify-parser-properties.test.mjs — V201-V350 (150 tests)
// Property-based verification — invariants that must ALWAYS hold regardless of input.

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFinding(emoji, file, line, issue) {
  return `${emoji} ${file}:${line} — ${issue}`;
}

function makeDoc({ findings = [], verdict = '', extra = '' } = {}) {
  let md = '';
  for (const f of findings) md += f + '\n';
  if (verdict) md += `\nVERDICT: ${verdict}\n`;
  if (extra) md += extra + '\n';
  return md;
}

function randomEmoji() {
  return ['🔴', '🟡', '🔵'][Math.floor(Math.random() * 3)];
}

function randomFindings(n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(makeFinding(randomEmoji(), `f${i}.js`, i + 1, `Issue ${i}`));
  }
  return lines;
}

// ============================================================================
// P01: Idempotency (V201–V220)
// ============================================================================
describe('P01: Idempotency', () => {
  it('V201 parsing same text twice gives identical results — empty', () => {
    const a = parseEvaluation('');
    const b = parseEvaluation('');
    assert.deepEqual(a, b);
  });

  it('V202 parsing same text twice — single finding', () => {
    const text = '🔴 a.js:1 — Issue';
    assert.deepEqual(parseEvaluation(text), parseEvaluation(text));
  });

  it('V203 parsing same text twice — complex doc', () => {
    const text = makeDoc({
      findings: randomFindings(10),
      verdict: 'PASS FINDINGS[10]',
    });
    assert.deepEqual(parseEvaluation(text), parseEvaluation(text));
  });

  it('V204 parsing same text twice — with hedging', () => {
    const text = '🔴 a.js:1 — This might be an issue\n→ consider fixing';
    assert.deepEqual(parseEvaluation(text), parseEvaluation(text));
  });

  it('V205 parsing same text twice — with fix and reasoning', () => {
    const text = '🔴 a.js:1 — Issue\n→ Fix it\nReasoning: Because';
    assert.deepEqual(parseEvaluation(text), parseEvaluation(text));
  });

  it('V206 parsing does not mutate input string', () => {
    const text = '🔴 a.js:1 — Issue\n→ Fix\nVERDICT: PASS';
    const copy = text.slice();
    parseEvaluation(text);
    assert.equal(text, copy);
  });

  it('V207 parsing does not mutate input string — with CRLF', () => {
    const text = '🔴 a.js:1 — Issue\r\nVERDICT: PASS';
    const copy = text.slice();
    parseEvaluation(text);
    assert.equal(text, copy);
  });

  it('V208 result objects are independent (modifying one doesn\'t affect another)', () => {
    const text = '🔴 a.js:1 — Issue';
    const a = parseEvaluation(text);
    const b = parseEvaluation(text);
    a.findings[0].severity = 'modified';
    assert.equal(b.findings[0].severity, 'critical');
  });

  it('V209 parsing 50-finding doc twice gives same result', () => {
    const text = makeDoc({ findings: randomFindings(50), verdict: 'PASS' });
    const a = parseEvaluation(text);
    const b = parseEvaluation(text);
    assert.equal(a.findings_count, b.findings_count);
    assert.equal(a.critical, b.critical);
    assert.equal(a.warning, b.warning);
    assert.equal(a.suggestion, b.suggestion);
  });

  it('V210 parsing text with unicode twice gives same result', () => {
    const text = '🔴 a.js:1 — Issue with 中文 and 日本語';
    assert.deepEqual(parseEvaluation(text), parseEvaluation(text));
  });

  it('V211 parsing whitespace-only twice gives same result', () => {
    assert.deepEqual(parseEvaluation('   \n  '), parseEvaluation('   \n  '));
  });

  it('V212 parsing verdict-only twice gives same result', () => {
    assert.deepEqual(parseEvaluation('VERDICT: PASS'), parseEvaluation('VERDICT: PASS'));
  });

  it('V213 parsing mixed headings and findings twice', () => {
    const text = '# 🔴 Title\n🔴 a.js:1 — Real';
    assert.deepEqual(parseEvaluation(text), parseEvaluation(text));
  });

  it('V214 parsing large doc (200 findings) twice', () => {
    const text = makeDoc({ findings: randomFindings(200) });
    const a = parseEvaluation(text);
    const b = parseEvaluation(text);
    assert.equal(a.findings_count, b.findings_count);
    assert.deepEqual(a.findings.map(f => f.severity), b.findings.map(f => f.severity));
  });

  it('V215 parsing BOM text twice', () => {
    const text = '\uFEFF🔴 a.js:1 — Issue';
    assert.deepEqual(parseEvaluation(text), parseEvaluation(text));
  });

  it('V216 result findings array is a new array each time', () => {
    const text = '🔴 a.js:1 — Issue';
    const a = parseEvaluation(text);
    const b = parseEvaluation(text);
    assert.notEqual(a.findings, b.findings);
  });

  it('V217 result hedging_detected array is new each time', () => {
    const text = '🔴 a.js:1 — might be bad';
    const a = parseEvaluation(text);
    const b = parseEvaluation(text);
    assert.notEqual(a.hedging_detected, b.hedging_detected);
    assert.deepEqual(a.hedging_detected, b.hedging_detected);
  });

  it('V218 repeated parsing of null-byte text', () => {
    const text = '🔴 a.js:1 — \0Issue';
    assert.deepEqual(parseEvaluation(text), parseEvaluation(text));
  });

  it('V219 parsing doc with only arrows twice', () => {
    assert.deepEqual(parseEvaluation('→ noop'), parseEvaluation('→ noop'));
  });

  it('V220 parsing doc with multiple verdicts twice', () => {
    const text = 'VERDICT: A\nVERDICT: B\nVERDICT: C';
    assert.deepEqual(parseEvaluation(text), parseEvaluation(text));
  });
});

// ============================================================================
// P02: Count Consistency (V221–V250)
// ============================================================================
describe('P02: Count consistency', () => {
  function assertCountConsistency(text, label) {
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, r.findings.length,
      `${label}: findings_count !== findings.length`);
    assert.equal(r.critical + r.warning + r.suggestion, r.findings_count,
      `${label}: severity sum !== findings_count`);
    for (const f of r.findings) {
      assert.ok(['critical', 'warning', 'suggestion'].includes(f.severity),
        `${label}: invalid severity "${f.severity}"`);
    }
  }

  it('V221 empty input', () => assertCountConsistency('', 'empty'));

  it('V222 single critical', () => assertCountConsistency('🔴 a.js:1 — I', 'single critical'));

  it('V223 single warning', () => assertCountConsistency('🟡 a.js:1 — I', 'single warning'));

  it('V224 single suggestion', () => assertCountConsistency('🔵 a.js:1 — I', 'single suggestion'));

  it('V225 mixed 3 findings', () => {
    assertCountConsistency('🔴 a.js:1 — A\n🟡 b.js:2 — B\n🔵 c.js:3 — C', 'mixed 3');
  });

  it('V226 10 random findings', () => {
    assertCountConsistency(makeDoc({ findings: randomFindings(10) }), '10 random');
  });

  it('V227 50 random findings', () => {
    assertCountConsistency(makeDoc({ findings: randomFindings(50) }), '50 random');
  });

  it('V228 100 random findings', () => {
    assertCountConsistency(makeDoc({ findings: randomFindings(100) }), '100 random');
  });

  it('V229 findings with headings (headings excluded)', () => {
    const text = '# 🔴 Title\n🔴 a.js:1 — Real\n## 🟡 Sec\n🟡 b.js:2 — Real2';
    assertCountConsistency(text, 'headings');
  });

  it('V230 findings with verdict', () => {
    assertCountConsistency('🔴 a.js:1 — I\nVERDICT: PASS', 'with verdict');
  });

  it('V231 no findings, only verdict', () => {
    assertCountConsistency('VERDICT: PASS', 'verdict only');
  });

  it('V232 all critical', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `🔴 f${i}.js:1 — C`);
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.critical, 20);
    assert.equal(r.warning, 0);
    assert.equal(r.suggestion, 0);
    assert.equal(r.findings_count, 20);
  });

  it('V233 all warning', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `🟡 f${i}.js:1 — W`);
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.warning, 20);
    assert.equal(r.findings_count, 20);
  });

  it('V234 all suggestion', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `🔵 f${i}.js:1 — S`);
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.suggestion, 20);
    assert.equal(r.findings_count, 20);
  });

  it('V235 findings interspersed with non-matching lines', () => {
    const text = 'Hello\n🔴 a.js:1 — A\nworld\n🟡 b.js:2 — B\nfoo\n🔵 c.js:3 — C\nbar';
    assertCountConsistency(text, 'interspersed');
  });

  it('V236 count with whitespace-only lines', () => {
    const text = '   \n🔴 a.js:1 — A\n   \n🟡 b.js:2 — B\n   ';
    assertCountConsistency(text, 'whitespace');
  });

  it('V237 count after CRLF normalization', () => {
    const text = '🔴 a.js:1 — A\r\n🟡 b.js:2 — B\r\n🔵 c.js:3 — C';
    assertCountConsistency(text, 'CRLF');
  });

  it('V238 count with fix and reasoning lines', () => {
    const text = '🔴 a.js:1 — A\n→ Fix\nReasoning: R\n🟡 b.js:2 — B\n→ Fix2';
    assertCountConsistency(text, 'fix+reasoning');
  });

  it('V239 count with bracket-wrapped emoji', () => {
    assertCountConsistency('[🔴] a.js:1 — A\n[🟡] b.js:2 — B', 'brackets');
  });

  it('V240 count with 200 findings', () => {
    assertCountConsistency(makeDoc({ findings: randomFindings(200) }), '200 random');
  });

  it('V241 count stability across multiple parses', () => {
    const text = makeDoc({ findings: randomFindings(30) });
    const counts = Array.from({ length: 5 }, () => parseEvaluation(text).findings_count);
    assert.ok(counts.every(c => c === counts[0]));
  });

  it('V242 zero findings when only headings', () => {
    const text = '# 🔴 H1\n## 🟡 H2\n### 🔵 H3';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 0);
  });

  it('V243 critical count matches filtered findings', () => {
    const text = makeDoc({ findings: randomFindings(40) });
    const r = parseEvaluation(text);
    assert.equal(r.critical, r.findings.filter(f => f.severity === 'critical').length);
  });

  it('V244 warning count matches filtered findings', () => {
    const text = makeDoc({ findings: randomFindings(40) });
    const r = parseEvaluation(text);
    assert.equal(r.warning, r.findings.filter(f => f.severity === 'warning').length);
  });

  it('V245 suggestion count matches filtered findings', () => {
    const text = makeDoc({ findings: randomFindings(40) });
    const r = parseEvaluation(text);
    assert.equal(r.suggestion, r.findings.filter(f => f.severity === 'suggestion').length);
  });

  it('V246 count with single emoji no text', () => {
    assertCountConsistency('🔴', 'bare emoji');
  });

  it('V247 count with duplicate lines', () => {
    const text = '🔴 a.js:1 — Same\n🔴 a.js:1 — Same\n🔴 a.js:1 — Same';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 3);
    assert.equal(r.findings.length, 3);
  });

  it('V248 count with mixed content types', () => {
    const text = [
      '# Title',
      '🔴 a.js:1 — A',
      '→ Fix',
      'Reasoning: R',
      '',
      '> blockquote',
      '🟡 b.js:2 — B',
      'VERDICT: PASS',
    ].join('\n');
    assertCountConsistency(text, 'mixed content');
  });

  it('V249 count with 500 findings', () => {
    assertCountConsistency(makeDoc({ findings: randomFindings(500) }), '500 random');
  });

  it('V250 count never negative', () => {
    const inputs = ['', 'hello', '# 🔴 Heading', 'VERDICT: X'];
    for (const input of inputs) {
      const r = parseEvaluation(input);
      assert.ok(r.findings_count >= 0);
      assert.ok(r.critical >= 0);
      assert.ok(r.warning >= 0);
      assert.ok(r.suggestion >= 0);
    }
  });
});

// ============================================================================
// P03: Ordering Preservation (V251–V270)
// ============================================================================
describe('P03: Ordering preservation', () => {
  it('V251 findings appear in document order — 3 findings', () => {
    const text = '🔴 a.js:1 — First\n🟡 b.js:2 — Second\n🔵 c.js:3 — Third';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].issue, 'First');
    assert.equal(r.findings[1].issue, 'Second');
    assert.equal(r.findings[2].issue, 'Third');
  });

  it('V252 findings order preserved with interleaved non-finding lines', () => {
    const text = 'Preamble\n🔴 a.js:1 — A\nSome text\n🟡 b.js:2 — B\nMore text\n🔵 c.js:3 — C';
    const r = parseEvaluation(text);
    assert.deepEqual(r.findings.map(f => f.issue), ['A', 'B', 'C']);
  });

  it('V253 line numbers monotonically increase in ordered doc', () => {
    const lines = [];
    for (let i = 1; i <= 20; i++) {
      lines.push(`🔴 f.js:${i} — Issue ${i}`);
    }
    const r = parseEvaluation(lines.join('\n'));
    for (let i = 1; i < r.findings.length; i++) {
      assert.ok(r.findings[i].line > r.findings[i - 1].line);
    }
  });

  it('V254 file references preserve order', () => {
    const text = '🔴 alpha.js:1 — A\n🟡 beta.js:2 — B\n🔵 gamma.js:3 — C';
    const r = parseEvaluation(text);
    assert.deepEqual(r.findings.map(f => f.file), ['alpha.js', 'beta.js', 'gamma.js']);
  });

  it('V255 severity order preserved when mixed', () => {
    const text = '🔵 c.js:1 — S\n🔴 a.js:2 — C\n🟡 b.js:3 — W';
    const r = parseEvaluation(text);
    assert.deepEqual(
      r.findings.map(f => f.severity),
      ['suggestion', 'critical', 'warning']
    );
  });

  it('V256 10 findings maintain insertion order', () => {
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`🔴 f${i}.js:${i + 1} — Issue_${i}`);
    }
    const r = parseEvaluation(lines.join('\n'));
    for (let i = 0; i < 10; i++) {
      assert.equal(r.findings[i].issue, `Issue_${i}`);
    }
  });

  it('V257 findings after verdict maintain order', () => {
    const text = 'VERDICT: MID\n🔴 a.js:1 — First\n🟡 b.js:2 — Second';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].issue, 'First');
    assert.equal(r.findings[1].issue, 'Second');
  });

  it('V258 findings before and after verdict maintain order', () => {
    const text = '🔴 a.js:1 — Before\nVERDICT: MID\n🟡 b.js:2 — After';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].issue, 'Before');
    assert.equal(r.findings[1].issue, 'After');
  });

  it('V259 50 findings maintain document order', () => {
    const lines = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`🔴 f.js:${i + 1} — N${i}`);
    }
    const r = parseEvaluation(lines.join('\n'));
    for (let i = 0; i < 50; i++) {
      assert.equal(r.findings[i].issue, `N${i}`);
    }
  });

  it('V260 findings with fixes maintain order', () => {
    const text = [
      '🔴 a.js:1 — A', '→ Fix A',
      '🟡 b.js:2 — B', '→ Fix B',
      '🔵 c.js:3 — C', '→ Fix C',
    ].join('\n');
    const r = parseEvaluation(text);
    assert.deepEqual(r.findings.map(f => f.fix), ['Fix A', 'Fix B', 'Fix C']);
  });

  it('V261 findings with reasoning maintain order', () => {
    const text = [
      '🔴 a.js:1 — A', 'Reasoning: RA',
      '🟡 b.js:2 — B', 'Reasoning: RB',
    ].join('\n');
    const r = parseEvaluation(text);
    assert.deepEqual(r.findings.map(f => f.reasoning), ['RA', 'RB']);
  });

  it('V262 100 findings with mixed severities preserve order', () => {
    const emojis = ['🔴', '🟡', '🔵'];
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`${emojis[i % 3]} f.js:${i + 1} — N${i}`);
    }
    const r = parseEvaluation(lines.join('\n'));
    for (let i = 0; i < 100; i++) {
      assert.equal(r.findings[i].issue, `N${i}`);
    }
  });

  it('V263 findings separated by blank lines preserve order', () => {
    const text = '🔴 a.js:1 — A\n\n\n🟡 b.js:2 — B\n\n\n🔵 c.js:3 — C';
    const r = parseEvaluation(text);
    assert.deepEqual(r.findings.map(f => f.issue), ['A', 'B', 'C']);
  });

  it('V264 findings after headings preserve order', () => {
    const text = '# Section 1\n🔴 a.js:1 — A\n# Section 2\n🟡 b.js:2 — B';
    const r = parseEvaluation(text);
    assert.deepEqual(r.findings.map(f => f.issue), ['A', 'B']);
  });

  it('V265 identical issue text still preserves order by line', () => {
    const text = '🔴 a.js:1 — Same\n🔴 b.js:2 — Same\n🔴 c.js:3 — Same';
    const r = parseEvaluation(text);
    assert.deepEqual(r.findings.map(f => f.file), ['a.js', 'b.js', 'c.js']);
  });

  it('V266 reverse line-number order in doc preserves finding order', () => {
    const text = '🔴 a.js:100 — A\n🔴 a.js:50 — B\n🔴 a.js:1 — C';
    const r = parseEvaluation(text);
    assert.deepEqual(r.findings.map(f => f.line), [100, 50, 1]);
  });

  it('V267 findings in bullet list preserve order', () => {
    const text = '- 🔴 a.js:1 — A\n- 🟡 b.js:2 — B\n- 🔵 c.js:3 — C';
    const r = parseEvaluation(text);
    assert.deepEqual(r.findings.map(f => f.issue), ['A', 'B', 'C']);
  });

  it('V268 findings in numbered list preserve order', () => {
    const text = '1. 🔴 a.js:1 — A\n2. 🟡 b.js:2 — B\n3. 🔵 c.js:3 — C';
    const r = parseEvaluation(text);
    assert.deepEqual(r.findings.map(f => f.issue), ['A', 'B', 'C']);
  });

  it('V269 first finding is first in array', () => {
    const text = '🔴 first.js:1 — First\n🔴 second.js:2 — Second';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].file, 'first.js');
  });

  it('V270 last finding is last in array', () => {
    const text = '🔴 first.js:1 — First\n🔴 last.js:99 — Last';
    const r = parseEvaluation(text);
    assert.equal(r.findings[r.findings.length - 1].file, 'last.js');
  });
});

// ============================================================================
// P04: Verdict Consistency (V271–V290)
// ============================================================================
describe('P04: Verdict consistency', () => {
  it('V271 verdict_present === true iff verdict !== ""', () => {
    const r = parseEvaluation('VERDICT: PASS');
    assert.equal(r.verdict_present, true);
    assert.notEqual(r.verdict, '');
  });

  it('V272 no verdict → verdict_present false and verdict empty', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue');
    assert.equal(r.verdict_present, false);
    assert.equal(r.verdict, '');
  });

  it('V273 verdict_present false for empty input', () => {
    const r = parseEvaluation('');
    assert.equal(r.verdict_present, false);
    assert.equal(r.verdict, '');
  });

  it('V274 verdict with FINDINGS[N] matching count → verdict_count_match true', () => {
    const text = '🔴 a.js:1 — A\n🟡 b.js:2 — B\nVERDICT: FAIL FINDINGS[2]';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, true);
  });

  it('V275 verdict with FINDINGS[N] not matching → verdict_count_match false', () => {
    const text = '🔴 a.js:1 — A\nVERDICT: FAIL FINDINGS[5]';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, false);
  });

  it('V276 verdict without FINDINGS[N] and findings > 0 → verdict_count_match null', () => {
    const text = '🔴 a.js:1 — A\nVERDICT: FAIL';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, null);
  });

  it('V277 no verdict and no findings → verdict_count_match true', () => {
    const r = parseEvaluation('Just some text');
    assert.equal(r.verdict_count_match, true);
  });

  it('V278 verdict FINDINGS[0] with 0 findings → true', () => {
    const r = parseEvaluation('VERDICT: PASS FINDINGS[0]');
    assert.equal(r.verdict_count_match, true);
    assert.equal(r.findings_count, 0);
  });

  it('V279 multiple verdicts — last one determines state', () => {
    const text = 'VERDICT: FIRST\nVERDICT: LAST';
    const r = parseEvaluation(text);
    assert.equal(r.verdict, 'LAST');
    assert.equal(r.verdict_present, true);
  });

  it('V280 verdict consistency over 20 random docs', () => {
    for (let i = 0; i < 20; i++) {
      const n = Math.floor(Math.random() * 10);
      const text = makeDoc({
        findings: randomFindings(n),
        verdict: `RESULT FINDINGS[${n}]`,
      });
      const r = parseEvaluation(text);
      assert.equal(r.verdict_present, true);
      assert.equal(r.verdict_count_match, true);
    }
  });

  it('V281 verdict with FINDINGS[N] where N is string-parseable', () => {
    const r = parseEvaluation('🔴 a.js:1 — A\nVERDICT: FINDINGS[01]');
    // parseInt("01", 10) === 1
    assert.equal(r.verdict_count_match, true);
  });

  it('V282 verdict_present remains true even if verdict is overwritten', () => {
    const text = 'VERDICT: OLD\nVERDICT: NEW';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, 'NEW');
  });

  it('V283 verdict with findings mismatch is detectable', () => {
    for (let actual = 0; actual < 5; actual++) {
      for (let claimed = 0; claimed < 5; claimed++) {
        const text = makeDoc({
          findings: randomFindings(actual).map((f, i) =>
            makeFinding(['🔴', '🟡', '🔵'][i % 3], `f${i}.js`, i + 1, `I${i}`)
          ),
          verdict: `R FINDINGS[${claimed}]`,
        });
        const r = parseEvaluation(text);
        assert.equal(r.verdict_count_match, actual === claimed);
      }
    }
  });

  it('V284 verdict_present is boolean', () => {
    const r = parseEvaluation('VERDICT: X');
    assert.equal(typeof r.verdict_present, 'boolean');
  });

  it('V285 verdict is always string', () => {
    const r1 = parseEvaluation('');
    const r2 = parseEvaluation('VERDICT: Y');
    assert.equal(typeof r1.verdict, 'string');
    assert.equal(typeof r2.verdict, 'string');
  });

  it('V286 verdict_count_match type is boolean, null, or true', () => {
    const r = parseEvaluation('');
    assert.ok(r.verdict_count_match === true || r.verdict_count_match === false || r.verdict_count_match === null);
  });

  it('V287 empty verdict (no match) means empty string', () => {
    const r = parseEvaluation('no verdict here');
    assert.equal(r.verdict, '');
  });

  it('V288 verdict with only whitespace content does not match', () => {
    const r = parseEvaluation('VERDICT:    ');
    assert.equal(r.verdict_present, false);
  });

  it('V289 verdict_count_match for doc with findings but no verdict', () => {
    const text = '🔴 a.js:1 — A\n🟡 b.js:2 — B';
    const r = parseEvaluation(text);
    // No verdict → fnMatch is null, findingsCount > 0 → null
    assert.equal(r.verdict_count_match, null);
  });

  it('V290 verdict_count_match true when no findings and no FINDINGS[N] in verdict', () => {
    const r = parseEvaluation('VERDICT: ALL CLEAR');
    // No FINDINGS[N] in verdict, findingsCount = 0, so verdictCountMatch stays true
    assert.equal(r.verdict_count_match, true);
  });
});

// ============================================================================
// P05: File Ref Consistency (V291–V310)
// ============================================================================
describe('P05: File ref consistency', () => {
  it('V291 has_file_refs true when finding has file', () => {
    const r = parseEvaluation('🔴 src/app.js:10 — Issue');
    assert.equal(r.has_file_refs, true);
  });

  it('V292 has_file_refs false when no file refs anywhere', () => {
    const r = parseEvaluation('🔴 simple issue no file');
    assert.equal(r.has_file_refs, false);
  });

  it('V293 has_file_refs true iff any finding has non-null file', () => {
    const text = '🔴 no file here\n🟡 src/b.js:2 — Has file';
    const r = parseEvaluation(text);
    assert.equal(r.has_file_refs, true);
    assert.ok(r.findings.some(f => f.file !== null));
  });

  it('V294 finding without file ref has null file and null line', () => {
    const r = parseEvaluation('🔴 issue without file ref');
    assert.equal(r.findings[0].file, null);
    assert.equal(r.findings[0].line, null);
  });

  it('V295 finding with file ref has string file and number line', () => {
    const r = parseEvaluation('🔴 src/app.js:10 — Issue');
    assert.equal(typeof r.findings[0].file, 'string');
    assert.equal(typeof r.findings[0].line, 'number');
  });

  it('V296 file path extraction is correct', () => {
    const r = parseEvaluation('🔴 path/to/deep/file.ts:42 — Issue');
    assert.equal(r.findings[0].file, 'path/to/deep/file.ts');
    assert.equal(r.findings[0].line, 42);
  });

  it('V297 has_file_refs false for empty input', () => {
    assert.equal(parseEvaluation('').has_file_refs, false);
  });

  it('V298 has_file_refs true even if file ref is in non-finding line', () => {
    // FILE_REF_RE is checked on every line
    const r = parseEvaluation('See src/app.js:10 for details');
    assert.equal(r.has_file_refs, true);
  });

  it('V299 has_file_refs with multiple file refs', () => {
    const text = '🔴 a.js:1 — A\n🔴 b.js:2 — B\n🔴 c.js:3 — C';
    const r = parseEvaluation(text);
    assert.equal(r.has_file_refs, true);
    assert.ok(r.findings.every(f => f.file !== null));
  });

  it('V300 file ref in verdict line sets has_file_refs', () => {
    const r = parseEvaluation('VERDICT: See app.js:10 for details');
    assert.equal(r.has_file_refs, true);
  });

  it('V301 file ref in heading line sets has_file_refs', () => {
    const r = parseEvaluation('# Review of app.js:42');
    assert.equal(r.has_file_refs, true);
  });

  it('V302 all findings without file refs → has_file_refs false', () => {
    const text = '🔴 No file — A\n🟡 No file — B\n🔵 No file — C';
    const r = parseEvaluation(text);
    assert.equal(r.has_file_refs, false);
    assert.ok(r.findings.every(f => f.file === null));
  });

  it('V303 mixed findings — some with file, some without', () => {
    const text = '🔴 a.js:1 — With file\n🟡 no file here — Without';
    const r = parseEvaluation(text);
    assert.equal(r.has_file_refs, true);
    assert.equal(r.findings[0].file, 'a.js');
    assert.equal(r.findings[1].file, null);
  });

  it('V304 file with dotfile name', () => {
    const r = parseEvaluation('🔴 .env.local:5 — Exposed secret');
    assert.equal(r.findings[0].file, '.env.local');
    assert.equal(r.findings[0].line, 5);
  });

  it('V305 file in deeply nested path', () => {
    const r = parseEvaluation('🔴 src/components/ui/Button/index.tsx:99 — Issue');
    assert.equal(r.findings[0].file, 'src/components/ui/Button/index.tsx');
    assert.equal(r.findings[0].line, 99);
  });

  it('V306 line number is integer', () => {
    const r = parseEvaluation('🔴 a.js:42 — Issue');
    assert.ok(Number.isInteger(r.findings[0].line));
  });

  it('V307 file ref consistency over 50 findings', () => {
    const lines = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`🔴 dir/file${i}.js:${i + 1} — Issue`);
    }
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.has_file_refs, true);
    for (let i = 0; i < 50; i++) {
      assert.equal(r.findings[i].file, `dir/file${i}.js`);
      assert.equal(r.findings[i].line, i + 1);
    }
  });

  it('V308 file ref with underscore in filename', () => {
    const r = parseEvaluation('🔴 my_module.py:7 — Issue');
    assert.equal(r.findings[0].file, 'my_module.py');
  });

  it('V309 file ref with dash in filename', () => {
    const r = parseEvaluation('🔴 my-component.tsx:3 — Issue');
    assert.equal(r.findings[0].file, 'my-component.tsx');
  });

  it('V310 file ref with multiple extensions', () => {
    const r = parseEvaluation('🔴 app.module.spec.ts:12 — Issue');
    assert.equal(r.findings[0].file, 'app.module.spec.ts');
    assert.equal(r.findings[0].line, 12);
  });
});

// ============================================================================
// P06: Severity Mapping (V311–V330)
// ============================================================================
describe('P06: Severity mapping', () => {
  it('V311 🔴 always maps to "critical"', () => {
    assert.equal(SEVERITY_MAP['🔴'], 'critical');
  });

  it('V312 🟡 always maps to "warning"', () => {
    assert.equal(SEVERITY_MAP['🟡'], 'warning');
  });

  it('V313 🔵 always maps to "suggestion"', () => {
    assert.equal(SEVERITY_MAP['🔵'], 'suggestion');
  });

  it('V314 SEVERITY_MAP has exactly 3 entries', () => {
    assert.equal(Object.keys(SEVERITY_MAP).length, 3);
  });

  it('V315 SEVERITY_MAP values are exactly the 3 severities', () => {
    const vals = new Set(Object.values(SEVERITY_MAP));
    assert.deepEqual(vals, new Set(['critical', 'warning', 'suggestion']));
  });

  it('V316 parsed finding severity is always one of the 3 values', () => {
    const text = '🔴 a.js:1 — A\n🟡 b.js:2 — B\n🔵 c.js:3 — C';
    const r = parseEvaluation(text);
    for (const f of r.findings) {
      assert.ok(['critical', 'warning', 'suggestion'].includes(f.severity));
    }
  });

  it('V317 100 random findings all have valid severity', () => {
    const text = makeDoc({ findings: randomFindings(100) });
    const r = parseEvaluation(text);
    const valid = new Set(['critical', 'warning', 'suggestion']);
    for (const f of r.findings) {
      assert.ok(valid.has(f.severity));
    }
  });

  it('V318 severity from 🔴 finding is "critical"', () => {
    const r = parseEvaluation('🔴 a.js:1 — Test');
    assert.equal(r.findings[0].severity, 'critical');
  });

  it('V319 severity from 🟡 finding is "warning"', () => {
    const r = parseEvaluation('🟡 a.js:1 — Test');
    assert.equal(r.findings[0].severity, 'warning');
  });

  it('V320 severity from 🔵 finding is "suggestion"', () => {
    const r = parseEvaluation('🔵 a.js:1 — Test');
    assert.equal(r.findings[0].severity, 'suggestion');
  });

  it('V321 SEVERITY_MAP keys match SEVERITY_RE capture group options', () => {
    const reSource = SEVERITY_RE.source;
    for (const key of Object.keys(SEVERITY_MAP)) {
      assert.ok(reSource.includes(key), `${key} not in regex`);
    }
  });

  it('V322 no undefined severity values in SEVERITY_MAP', () => {
    for (const v of Object.values(SEVERITY_MAP)) {
      assert.notEqual(v, undefined);
      assert.equal(typeof v, 'string');
    }
  });

  it('V323 severity mapping is deterministic', () => {
    for (let i = 0; i < 10; i++) {
      assert.equal(SEVERITY_MAP['🔴'], 'critical');
      assert.equal(SEVERITY_MAP['🟡'], 'warning');
      assert.equal(SEVERITY_MAP['🔵'], 'suggestion');
    }
  });

  it('V324 bracket-wrapped emoji maps same severity', () => {
    const r1 = parseEvaluation('🔴 a.js:1 — A');
    const r2 = parseEvaluation('[🔴] a.js:1 — A');
    assert.equal(r1.findings[0].severity, r2.findings[0].severity);
  });

  it('V325 SEVERITY_MAP does not contain null values', () => {
    for (const v of Object.values(SEVERITY_MAP)) {
      assert.notEqual(v, null);
    }
  });

  it('V326 unrelated emoji does not produce finding', () => {
    const r = parseEvaluation('🟢 a.js:1 — Green');
    assert.equal(r.findings_count, 0);
  });

  it('V327 🔴 in heading does not count in severity totals', () => {
    const r = parseEvaluation('# 🔴 Critical Section');
    assert.equal(r.critical, 0);
  });

  it('V328 multiple 🔴 findings all map to critical', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `🔴 f${i}.js:1 — C`);
    const r = parseEvaluation(lines.join('\n'));
    assert.ok(r.findings.every(f => f.severity === 'critical'));
  });

  it('V329 multiple 🟡 findings all map to warning', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `🟡 f${i}.js:1 — W`);
    const r = parseEvaluation(lines.join('\n'));
    assert.ok(r.findings.every(f => f.severity === 'warning'));
  });

  it('V330 multiple 🔵 findings all map to suggestion', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `🔵 f${i}.js:1 — S`);
    const r = parseEvaluation(lines.join('\n'));
    assert.ok(r.findings.every(f => f.severity === 'suggestion'));
  });
});

// ============================================================================
// P07: Hedging Completeness (V331–V350)
// ============================================================================
describe('P07: Hedging completeness', () => {
  it('V331 hedging_detected is empty for non-hedging text', () => {
    const r = parseEvaluation('🔴 a.js:1 — Definite issue');
    assert.deepEqual(r.hedging_detected, []);
  });

  it('V332 hedging_detected contains "might" match', () => {
    const r = parseEvaluation('🔴 a.js:1 — This might fail');
    assert.equal(r.hedging_detected.length, 1);
    assert.ok(r.hedging_detected[0].includes('might'));
  });

  it('V333 hedging_detected contains "consider" match', () => {
    const r = parseEvaluation('🔴 a.js:1 — You should consider refactoring');
    assert.equal(r.hedging_detected.length, 1);
    assert.ok(r.hedging_detected[0].includes('consider'));
  });

  it('V334 hedging_detected contains "could potentially" match', () => {
    const r = parseEvaluation('🔴 a.js:1 — This could potentially break');
    assert.equal(r.hedging_detected.length, 1);
    assert.ok(r.hedging_detected[0].includes('could potentially'));
  });

  it('V335 hedging in fix line is detected', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\n→ You might want to fix this');
    assert.ok(r.hedging_detected.length > 0);
  });

  it('V336 hedging in reasoning line is detected', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\nReasoning: This might be the cause');
    assert.ok(r.hedging_detected.length > 0);
  });

  it('V337 hedging in continuation line is detected', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\nThis might cause problems');
    assert.ok(r.hedging_detected.length > 0);
  });

  it('V338 hedging NOT detected in heading lines', () => {
    const r = parseEvaluation('# You might consider this\n🔴 a.js:1 — No hedge');
    // Heading lines with # are skipped for finding detection
    // Hedging in heading context: not in a finding context
    assert.deepEqual(r.hedging_detected, []);
  });

  it('V339 all hedging entries reference real line numbers', () => {
    const text = '🔴 a.js:1 — might fail\nThis could potentially break\nReasoning: consider this';
    const r = parseEvaluation(text);
    for (const h of r.hedging_detected) {
      const lineMatch = h.match(/^line (\d+):/);
      assert.ok(lineMatch, `hedging entry doesn't start with line number: ${h}`);
      const lineNum = parseInt(lineMatch[1], 10);
      assert.ok(lineNum > 0);
    }
  });

  it('V340 hedging entries contain the matched line text', () => {
    const r = parseEvaluation('🔴 a.js:1 — might be bad');
    for (const h of r.hedging_detected) {
      assert.ok(h.includes("'"), 'hedging entry should contain quoted text');
    }
  });

  it('V341 multiple hedging instances all detected', () => {
    const text = '🔴 a.js:1 — might fail\nYou might also consider this\ncould potentially crash';
    const r = parseEvaluation(text);
    assert.equal(r.hedging_detected.length, 3);
  });

  it('V342 hedging in finding without file ref', () => {
    const r = parseEvaluation('🔴 This might be a problem');
    assert.ok(r.hedging_detected.length > 0);
  });

  it('V343 no hedging when finding has no hedging words', () => {
    const r = parseEvaluation('🔴 a.js:1 — Definite memory leak\n→ Fix the leak\nReasoning: Proven by heap dump');
    assert.deepEqual(r.hedging_detected, []);
  });

  it('V344 hedging_detected is always an array', () => {
    assert.ok(Array.isArray(parseEvaluation('').hedging_detected));
    assert.ok(Array.isArray(parseEvaluation('🔴 a.js:1 — might').hedging_detected));
  });

  it('V345 hedging_detected items are all strings', () => {
    const r = parseEvaluation('🔴 a.js:1 — might fail\ncould potentially break');
    for (const h of r.hedging_detected) {
      assert.equal(typeof h, 'string');
    }
  });

  it('V346 hedging on empty line (within finding) is not detected', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\n\n');
    assert.deepEqual(r.hedging_detected, []);
  });

  it('V347 hedging detected on line with only hedging word', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue\nmight');
    assert.equal(r.hedging_detected.length, 1);
  });

  it('V348 hedging NOT detected before first finding', () => {
    const r = parseEvaluation('This might be something\n🔴 a.js:1 — Real issue');
    // "This might be something" is before any finding → no currentFinding → no hedging
    // Actually, hedging is only detected when currentFinding exists
    // But the finding line itself has no hedging
    // Let me check: first line has no severity → no currentFinding → hedging not added
    assert.deepEqual(r.hedging_detected, []);
  });

  it('V349 hedging count matches HEDGING_RE test on each line within finding', () => {
    const lines = [
      '🔴 a.js:1 — Issue',
      'might fail',
      'definitely broken',
      'could potentially crash',
      'no hedge here',
      'consider refactoring',
    ];
    const text = lines.join('\n');
    const r = parseEvaluation(text);
    // Lines within finding context (after line 0): lines 1-5
    // Hedging: "might fail" (1), "could potentially crash" (3), "consider refactoring" (5) = 3
    assert.equal(r.hedging_detected.length, 3);
  });

  it('V350 hedging entries only contain strings matching HEDGING_RE', () => {
    const text = [
      '🔴 a.js:1 — might fail here',
      '→ consider using alternative',
      'Reasoning: could potentially be improved',
      'Definitely a problem though',
    ].join('\n');
    const r = parseEvaluation(text);
    for (const h of r.hedging_detected) {
      // Extract the quoted line content
      const quoteMatch = h.match(/'(.+)'/);
      assert.ok(quoteMatch, `Could not extract quoted text from: ${h}`);
      assert.ok(HEDGING_RE.test(quoteMatch[1]),
        `Hedging entry line does not match HEDGING_RE: ${quoteMatch[1]}`);
    }
  });
});
