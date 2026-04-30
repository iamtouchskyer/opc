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
// S01: Basic Parsing (T001–T030)
// ============================================================================
describe('S01: Basic Parsing', () => {
  it('T001 returns empty findings for empty text', () => {
    const r = parseEvaluation('');
    assert.equal(r.findings_count, 0);
    assert.deepEqual(r.findings, []);
  });

  it('T002 returns empty findings for whitespace-only text', () => {
    const r = parseEvaluation('   \n  \n   ');
    assert.equal(r.findings_count, 0);
    assert.deepEqual(r.findings, []);
  });

  it('T003 parses a single critical finding', () => {
    const r = parseEvaluation('🔴 src/app.js:10 — Memory leak in handler');
    assert.equal(r.findings_count, 1);
    assert.equal(r.critical, 1);
    assert.equal(r.findings[0].severity, 'critical');
  });

  it('T004 parses a single warning finding', () => {
    const r = parseEvaluation('🟡 src/app.js:10 — Unused variable');
    assert.equal(r.findings_count, 1);
    assert.equal(r.warning, 1);
    assert.equal(r.findings[0].severity, 'warning');
  });

  it('T005 parses a single suggestion finding', () => {
    const r = parseEvaluation('🔵 src/app.js:10 — Consider renaming');
    assert.equal(r.findings_count, 1);
    assert.equal(r.suggestion, 1);
    assert.equal(r.findings[0].severity, 'suggestion');
  });

  it('T006 parses multiple findings of same severity', () => {
    const text = '🔴 file.js:1 — Issue A\n🔴 file.js:2 — Issue B\n🔴 file.js:3 — Issue C';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 3);
    assert.equal(r.critical, 3);
    assert.equal(r.findings.length, 3);
  });

  it('T007 parses multiple findings of mixed severity', () => {
    const text = '🔴 a.js:1 — Critical\n🟡 b.js:2 — Warning\n🔵 c.js:3 — Suggestion';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 3);
    assert.equal(r.critical, 1);
    assert.equal(r.warning, 1);
    assert.equal(r.suggestion, 1);
  });

  it('T008 returns verdict_present false when no verdict', () => {
    const r = parseEvaluation('🔴 a.js:1 — Bug');
    assert.equal(r.verdict_present, false);
    assert.equal(r.verdict, '');
  });

  it('T009 returns verdict_present true when verdict exists', () => {
    const r = parseEvaluation('VERDICT: PASS');
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, 'PASS');
  });

  it('T010 parses only verdict with no findings', () => {
    const r = parseEvaluation('VERDICT: PASS');
    assert.equal(r.verdict_present, true);
    assert.equal(r.findings_count, 0);
    assert.deepEqual(r.findings, []);
  });

  it('T011 handles text with no severity markers and no verdict', () => {
    const r = parseEvaluation('Just some plain text\nwith multiple lines');
    assert.equal(r.findings_count, 0);
    assert.equal(r.verdict_present, false);
  });

  it('T012 returns correct structure shape', () => {
    const r = parseEvaluation('');
    assert.ok('verdict_present' in r);
    assert.ok('verdict' in r);
    assert.ok('findings_count' in r);
    assert.ok('critical' in r);
    assert.ok('warning' in r);
    assert.ok('suggestion' in r);
    assert.ok('has_file_refs' in r);
    assert.ok('hedging_detected' in r);
    assert.ok('verdict_count_match' in r);
    assert.ok('findings' in r);
  });

  it('T013 hedging_detected is an array', () => {
    const r = parseEvaluation('');
    assert.ok(Array.isArray(r.hedging_detected));
  });

  it('T014 findings is an array', () => {
    const r = parseEvaluation('');
    assert.ok(Array.isArray(r.findings));
  });

  it('T015 finding has correct structure', () => {
    const r = parseEvaluation('🔴 a.js:1 — Bug');
    const f = r.findings[0];
    assert.ok('severity' in f);
    assert.ok('file' in f);
    assert.ok('line' in f);
    assert.ok('issue' in f);
    assert.ok('fix' in f);
    assert.ok('reasoning' in f);
    assert.ok('status' in f);
    assert.ok('dismissReason' in f);
  });

  it('T016 finding defaults: fix null, reasoning null, status accepted, dismissReason null', () => {
    const r = parseEvaluation('🔴 a.js:1 — Bug');
    const f = r.findings[0];
    assert.equal(f.fix, null);
    assert.equal(f.reasoning, null);
    assert.equal(f.status, 'accepted');
    assert.equal(f.dismissReason, null);
  });

  it('T017 parses text with only blank lines', () => {
    const r = parseEvaluation('\n\n\n\n');
    assert.equal(r.findings_count, 0);
  });

  it('T018 verdict and findings together', () => {
    const text = 'VERDICT: FAIL\n🔴 a.js:1 — Bug';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.findings_count, 1);
  });

  it('T019 verdict after findings', () => {
    const text = '🔴 a.js:1 — Bug\nVERDICT: FAIL';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_present, true);
    assert.equal(r.findings_count, 1);
  });

  it('T020 multiple findings keep correct order', () => {
    const text = '🔴 a.js:1 — First\n🟡 b.js:2 — Second\n🔵 c.js:3 — Third';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].issue, 'First');
    assert.equal(r.findings[1].issue, 'Second');
    assert.equal(r.findings[2].issue, 'Third');
  });

  it('T021 counts are integers', () => {
    const r = parseEvaluation('🔴 a.js:1 — Bug');
    assert.equal(typeof r.findings_count, 'number');
    assert.equal(typeof r.critical, 'number');
    assert.equal(typeof r.warning, 'number');
    assert.equal(typeof r.suggestion, 'number');
  });

  it('T022 has_file_refs defaults to false', () => {
    const r = parseEvaluation('🔴 no file ref here — Bug');
    assert.equal(r.has_file_refs, false);
  });

  it('T023 parses finding without file ref', () => {
    const r = parseEvaluation('🔴 — Missing semicolon');
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].file, null);
    assert.equal(r.findings[0].line, null);
  });

  it('T024 parses finding without em-dash (entire line becomes issue)', () => {
    const r = parseEvaluation('🔴 Something is wrong');
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].issue, '🔴 Something is wrong');
  });

  it('T025 ten findings counted correctly', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `🔴 f.js:${i + 1} — Issue ${i + 1}`);
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.findings_count, 10);
    assert.equal(r.findings.length, 10);
  });

  it('T026 verdict_count_match is true when no findings and no FINDINGS[N]', () => {
    const r = parseEvaluation('VERDICT: PASS');
    assert.equal(r.verdict_count_match, true);
  });

  it('T027 plain prose between findings is ignored', () => {
    const text = '🔴 a.js:1 — Bug A\nSome plain commentary here\n🔵 b.js:2 — Suggestion B';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
  });

  it('T028 empty string verdict', () => {
    const r = parseEvaluation('');
    assert.equal(r.verdict, '');
  });

  it('T029 finding with fix and reasoning', () => {
    const text = '🔴 a.js:1 — Bug\n→ Fix the bug\nreasoning: because it crashes';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Fix the bug');
    assert.equal(r.findings[0].reasoning, 'because it crashes');
  });

  it('T030 many blank lines between findings', () => {
    const text = '🔴 a.js:1 — Bug A\n\n\n\n\n🟡 b.js:2 — Warning B';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
  });
});

// ============================================================================
// S02: Severity Detection (T031–T070)
// ============================================================================
describe('S02: Severity Detection', () => {
  it('T031 SEVERITY_MAP has three entries', () => {
    assert.equal(Object.keys(SEVERITY_MAP).length, 3);
  });

  it('T032 SEVERITY_MAP maps red circle to critical', () => {
    assert.equal(SEVERITY_MAP['🔴'], 'critical');
  });

  it('T033 SEVERITY_MAP maps yellow circle to warning', () => {
    assert.equal(SEVERITY_MAP['🟡'], 'warning');
  });

  it('T034 SEVERITY_MAP maps blue circle to suggestion', () => {
    assert.equal(SEVERITY_MAP['🔵'], 'suggestion');
  });

  it('T035 SEVERITY_RE matches bare 🔴', () => {
    assert.ok(SEVERITY_RE.test('🔴'));
  });

  it('T036 SEVERITY_RE matches bare 🟡', () => {
    assert.ok(SEVERITY_RE.test('🟡'));
  });

  it('T037 SEVERITY_RE matches bare 🔵', () => {
    assert.ok(SEVERITY_RE.test('🔵'));
  });

  it('T038 SEVERITY_RE matches [🔴] with brackets', () => {
    assert.ok(SEVERITY_RE.test('[🔴]'));
  });

  it('T039 SEVERITY_RE matches [🟡] with brackets', () => {
    assert.ok(SEVERITY_RE.test('[🟡]'));
  });

  it('T040 SEVERITY_RE matches [🔵] with brackets', () => {
    assert.ok(SEVERITY_RE.test('[🔵]'));
  });

  it('T041 🔴 at start of line detected as critical', () => {
    const r = parseEvaluation('🔴 file.js:1 — Issue');
    assert.equal(r.critical, 1);
  });

  it('T042 🔴 in middle of line detected as critical', () => {
    const r = parseEvaluation('Some text 🔴 file.js:1 — Issue');
    assert.equal(r.critical, 1);
  });

  it('T043 🔴 at end of line detected as critical', () => {
    const r = parseEvaluation('file.js:1 — Issue 🔴');
    assert.equal(r.critical, 1);
  });

  it('T044 [🔴] with brackets parsed as critical', () => {
    const r = parseEvaluation('[🔴] file.js:1 — Issue');
    assert.equal(r.critical, 1);
  });

  it('T045 [🟡] with brackets parsed as warning', () => {
    const r = parseEvaluation('[🟡] file.js:1 — Issue');
    assert.equal(r.warning, 1);
  });

  it('T046 [🔵] with brackets parsed as suggestion', () => {
    const r = parseEvaluation('[🔵] file.js:1 — Issue');
    assert.equal(r.suggestion, 1);
  });

  it('T047 severity in markdown heading is skipped', () => {
    const r = parseEvaluation('# 🔴 Critical Section');
    assert.equal(r.critical, 0);
    assert.equal(r.findings_count, 0);
  });

  it('T048 severity in ## heading is skipped', () => {
    const r = parseEvaluation('## 🟡 Warnings');
    assert.equal(r.warning, 0);
  });

  it('T049 severity in ### heading is skipped', () => {
    const r = parseEvaluation('### 🔵 Suggestions');
    assert.equal(r.suggestion, 0);
  });

  it('T050 mixed severity counts correct', () => {
    const text = '🔴 a.js:1 — A\n🔴 b.js:2 — B\n🟡 c.js:3 — C\n🔵 d.js:4 — D\n🔵 e.js:5 — E';
    const r = parseEvaluation(text);
    assert.equal(r.critical, 2);
    assert.equal(r.warning, 1);
    assert.equal(r.suggestion, 2);
    assert.equal(r.findings_count, 5);
  });

  it('T051 severity on line with only emoji is detected', () => {
    const r = parseEvaluation('🔴');
    assert.equal(r.critical, 1);
    assert.equal(r.findings_count, 1);
  });

  it('T052 severity after whitespace detected', () => {
    const r = parseEvaluation('   🔴 file.js:1 — Issue');
    assert.equal(r.critical, 1);
  });

  it('T053 severity with tab prefix detected', () => {
    const r = parseEvaluation('\t🔴 file.js:1 — Issue');
    assert.equal(r.critical, 1);
  });

  it('T054 multiple severity emojis on same line — first match wins', () => {
    const r = parseEvaluation('🔴 🟡 file.js:1 — Issue');
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].severity, 'critical');
  });

  it('T055 SEVERITY_RE captures the emoji group', () => {
    const m = '🔴 test'.match(SEVERITY_RE);
    assert.equal(m[1], '🔴');
  });

  it('T056 SEVERITY_RE captures emoji from bracketed form', () => {
    const m = '[🟡] test'.match(SEVERITY_RE);
    assert.equal(m[1], '🟡');
  });

  it('T057 only left bracket [🔴 still matches', () => {
    assert.ok(SEVERITY_RE.test('[🔴'));
  });

  it('T058 only right bracket 🔴] still matches', () => {
    assert.ok(SEVERITY_RE.test('🔴]'));
  });

  it('T059 no severity emoji returns zero counts', () => {
    const r = parseEvaluation('No issues found at all');
    assert.equal(r.critical, 0);
    assert.equal(r.warning, 0);
    assert.equal(r.suggestion, 0);
  });

  it('T060 severity in heading does not produce finding but line text still scanned for file refs', () => {
    const r = parseEvaluation('# 🔴 src/app.js:42 — Critical Section');
    assert.equal(r.findings_count, 0);
    assert.equal(r.has_file_refs, true);
  });

  it('T061 20 critical findings counted correctly', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `🔴 f.js:${i + 1} — Issue ${i}`);
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.critical, 20);
  });

  it('T062 severity followed by em-dash extracts issue text', () => {
    const r = parseEvaluation('🔴 — The actual issue text');
    assert.equal(r.findings[0].issue, 'The actual issue text');
  });

  it('T063 severity with text before em-dash preserves issue after dash', () => {
    const r = parseEvaluation('🔴 file.js:1 — Leaked secret');
    assert.equal(r.findings[0].issue, 'Leaked secret');
  });

  it('T064 finding severity stored in finding object', () => {
    const r = parseEvaluation('🟡 file.js:1 — Warn');
    assert.equal(r.findings[0].severity, 'warning');
  });

  it('T065 finding severity for suggestion stored correctly', () => {
    const r = parseEvaluation('🔵 file.js:1 — Suggest');
    assert.equal(r.findings[0].severity, 'suggestion');
  });

  it('T066 heading with #### and severity skipped', () => {
    const r = parseEvaluation('#### 🔴 Deep heading');
    assert.equal(r.findings_count, 0);
  });

  it('T067 line starting with - (list item) and severity is detected', () => {
    const r = parseEvaluation('- 🔴 file.js:1 — Issue');
    assert.equal(r.critical, 1);
  });

  it('T068 line starting with * (list item) and severity is detected', () => {
    const r = parseEvaluation('* 🔵 file.js:1 — Suggestion');
    assert.equal(r.suggestion, 1);
  });

  it('T069 numbered list item with severity is detected', () => {
    const r = parseEvaluation('1. 🟡 file.js:1 — Warning');
    assert.equal(r.warning, 1);
  });

  it('T070 severity emoji not in map is not detected', () => {
    const r = parseEvaluation('🟢 file.js:1 — All good');
    assert.equal(r.findings_count, 0);
  });
});

// ============================================================================
// S03: File References (T071–T110)
// ============================================================================
describe('S03: File References', () => {
  it('T071 simple file ref src/app.js:42 detected', () => {
    const r = parseEvaluation('🔴 src/app.js:42 — Bug');
    assert.equal(r.has_file_refs, true);
    assert.equal(r.findings[0].file, 'src/app.js');
    assert.equal(r.findings[0].line, 42);
  });

  it('T072 no file ref means has_file_refs false', () => {
    const r = parseEvaluation('🔴 — Bug with no file');
    assert.equal(r.has_file_refs, false);
  });

  it('T073 FILE_REF_RE matches standard file:line', () => {
    assert.ok(FILE_REF_RE.test('src/app.js:42'));
  });

  it('T074 FILE_REF_RE does not match file without line number', () => {
    assert.ok(!FILE_REF_RE.test('src/app.js'));
  });

  it('T075 FILE_REF_RE does not match bare number', () => {
    assert.ok(!FILE_REF_RE.test(':42'));
  });

  it('T076 deeply nested path detected', () => {
    const r = parseEvaluation('🔴 src/components/ui/buttons/PrimaryButton.tsx:99 — Issue');
    assert.equal(r.findings[0].file, 'src/components/ui/buttons/PrimaryButton.tsx');
    assert.equal(r.findings[0].line, 99);
  });

  it('T077 dotfile path detected', () => {
    const r = parseEvaluation('🔴 .github/workflows/ci.yml:10 — Bad config');
    assert.equal(r.findings[0].file, '.github/workflows/ci.yml');
  });

  it('T078 file with multiple dots detected', () => {
    const r = parseEvaluation('🔴 my.config.prod.js:5 — Issue');
    assert.equal(r.findings[0].file, 'my.config.prod.js');
  });

  it('T079 file with hyphen in name detected', () => {
    const r = parseEvaluation('🔴 my-component.tsx:1 — Issue');
    assert.equal(r.findings[0].file, 'my-component.tsx');
  });

  it('T080 file with underscore in name detected', () => {
    const r = parseEvaluation('🔴 my_module.py:100 — Issue');
    assert.equal(r.findings[0].file, 'my_module.py');
  });

  it('T081 multiple file refs on same line — first is used for finding', () => {
    const r = parseEvaluation('🔴 a.js:1 references b.js:2 — Issue');
    assert.equal(r.findings[0].file, 'a.js');
    assert.equal(r.findings[0].line, 1);
  });

  it('T082 file ref in non-finding line still sets has_file_refs', () => {
    const r = parseEvaluation('See src/utils.ts:50 for details');
    assert.equal(r.has_file_refs, true);
    assert.equal(r.findings_count, 0);
  });

  it('T083 file ref in heading line sets has_file_refs', () => {
    const r = parseEvaluation('# Check src/main.ts:1');
    assert.equal(r.has_file_refs, true);
  });

  it('T084 line number is parsed as integer', () => {
    const r = parseEvaluation('🔴 file.js:999 — Issue');
    assert.equal(typeof r.findings[0].line, 'number');
    assert.equal(r.findings[0].line, 999);
  });

  it('T085 line number 0 is valid', () => {
    const r = parseEvaluation('🔴 file.js:0 — Issue');
    assert.equal(r.findings[0].line, 0);
  });

  it('T086 very large line number', () => {
    const r = parseEvaluation('🔴 file.js:99999 — Issue');
    assert.equal(r.findings[0].line, 99999);
  });

  it('T087 .mjs extension detected', () => {
    const r = parseEvaluation('🔴 parser.mjs:10 — Issue');
    assert.equal(r.findings[0].file, 'parser.mjs');
  });

  it('T088 .cjs extension detected', () => {
    const r = parseEvaluation('🔴 config.cjs:5 — Issue');
    assert.equal(r.findings[0].file, 'config.cjs');
  });

  it('T089 .ts extension detected', () => {
    const r = parseEvaluation('🔴 index.ts:1 — Issue');
    assert.equal(r.findings[0].file, 'index.ts');
  });

  it('T090 .py extension detected', () => {
    const r = parseEvaluation('🔴 main.py:50 — Issue');
    assert.equal(r.findings[0].file, 'main.py');
  });

  it('T091 .rs extension detected', () => {
    const r = parseEvaluation('🔴 lib.rs:12 — Issue');
    assert.equal(r.findings[0].file, 'lib.rs');
  });

  it('T092 .go extension detected', () => {
    const r = parseEvaluation('🔴 main.go:7 — Issue');
    assert.equal(r.findings[0].file, 'main.go');
  });

  it('T093 .vue extension detected', () => {
    const r = parseEvaluation('🔴 App.vue:20 — Issue');
    assert.equal(r.findings[0].file, 'App.vue');
  });

  it('T094 .yaml extension detected', () => {
    const r = parseEvaluation('🔴 config.yaml:3 — Issue');
    assert.equal(r.findings[0].file, 'config.yaml');
  });

  it('T095 file ref with only filename no directory', () => {
    const r = parseEvaluation('🔴 index.js:1 — Issue');
    assert.equal(r.findings[0].file, 'index.js');
  });

  it('T096 file ref regex captures first match on line', () => {
    const m = 'See src/a.js:10 and src/b.js:20'.match(FILE_REF_RE);
    assert.equal(m[0], 'src/a.js:10');
  });

  it('T097 no file ref when colon has no number after it', () => {
    assert.ok(!FILE_REF_RE.test('file.js:'));
  });

  it('T098 no file ref when no extension', () => {
    assert.ok(!FILE_REF_RE.test('Makefile:10'));
  });

  it('T099 file ref with single char extension', () => {
    assert.ok(FILE_REF_RE.test('test.c:5'));
  });

  it('T100 file ref with numbers in filename', () => {
    const r = parseEvaluation('🔴 test123.js:1 — Issue');
    assert.equal(r.findings[0].file, 'test123.js');
  });

  it('T101 file ref detection across multiple lines', () => {
    const text = '🔴 a.js:1 — Issue A\nSome text\n🔵 b.ts:2 — Issue B';
    const r = parseEvaluation(text);
    assert.equal(r.has_file_refs, true);
    assert.equal(r.findings[0].file, 'a.js');
    assert.equal(r.findings[1].file, 'b.ts');
  });

  it('T102 finding without file ref has null file and line', () => {
    const r = parseEvaluation('🔴 — General issue');
    assert.equal(r.findings[0].file, null);
    assert.equal(r.findings[0].line, null);
  });

  it('T103 file path with dot directory', () => {
    const r = parseEvaluation('🔴 .config/settings.json:1 — Issue');
    assert.equal(r.findings[0].file, '.config/settings.json');
  });

  it('T104 FILE_REF_RE matches path with multiple slashes', () => {
    assert.ok(FILE_REF_RE.test('a/b/c/d/e.js:1'));
  });

  it('T105 file ref in verdict line still triggers has_file_refs', () => {
    const r = parseEvaluation('VERDICT: PASS — see report.md:1');
    assert.equal(r.has_file_refs, true);
  });

  it('T106 file ref with .jsx extension', () => {
    const r = parseEvaluation('🔴 Component.jsx:15 — Issue');
    assert.equal(r.findings[0].file, 'Component.jsx');
  });

  it('T107 file ref with .scss extension', () => {
    assert.ok(FILE_REF_RE.test('styles.scss:8'));
  });

  it('T108 file ref with .css extension', () => {
    assert.ok(FILE_REF_RE.test('main.css:100'));
  });

  it('T109 file ref not detected in URL-like string without line', () => {
    // URL won't match because there's no :\d+ at end of extension
    assert.ok(!FILE_REF_RE.test('https://example.com'));
  });

  it('T110 file ref with .md extension', () => {
    const r = parseEvaluation('🔴 README.md:5 — Typo');
    assert.equal(r.findings[0].file, 'README.md');
  });
});

// ============================================================================
// S04: Verdict Parsing (T111–T140)
// ============================================================================
describe('S04: Verdict Parsing', () => {
  it('T111 VERDICT: PASS parsed', () => {
    const r = parseEvaluation('VERDICT: PASS');
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, 'PASS');
  });

  it('T112 VERDICT: FAIL parsed', () => {
    const r = parseEvaluation('VERDICT: FAIL');
    assert.equal(r.verdict, 'FAIL');
  });

  it('T113 VERDICT: ITERATE parsed', () => {
    const r = parseEvaluation('VERDICT: ITERATE');
    assert.equal(r.verdict, 'ITERATE');
  });

  it('T114 VERDICT: BLOCKED parsed', () => {
    const r = parseEvaluation('VERDICT: BLOCKED');
    assert.equal(r.verdict, 'BLOCKED');
  });

  it('T115 verdict is case insensitive (Verdict: pass)', () => {
    const r = parseEvaluation('Verdict: pass');
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, 'pass');
  });

  it('T116 verdict: lowercase', () => {
    const r = parseEvaluation('verdict: iterate');
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, 'iterate');
  });

  it('T117 VERDICT with extra whitespace after colon', () => {
    const r = parseEvaluation('VERDICT:    PASS');
    assert.equal(r.verdict, 'PASS');
  });

  it('T118 VERDICT with no space after colon', () => {
    const r = parseEvaluation('VERDICT:PASS');
    assert.equal(r.verdict, 'PASS');
  });

  it('T119 VERDICT with trailing whitespace trimmed', () => {
    const r = parseEvaluation('VERDICT: PASS   ');
    assert.equal(r.verdict, 'PASS');
  });

  it('T120 VERDICT with surrounding text', () => {
    const r = parseEvaluation('Result is VERDICT: FAIL due to bugs');
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, 'FAIL due to bugs');
  });

  it('T121 missing verdict returns empty string', () => {
    const r = parseEvaluation('No verdict here');
    assert.equal(r.verdict, '');
  });

  it('T122 multiple verdicts — last one wins', () => {
    const text = 'VERDICT: PASS\nVERDICT: FAIL';
    const r = parseEvaluation(text);
    assert.equal(r.verdict, 'FAIL');
  });

  it('T123 verdict on last line', () => {
    const text = '🔴 a.js:1 — Bug\nVERDICT: ITERATE';
    const r = parseEvaluation(text);
    assert.equal(r.verdict, 'ITERATE');
  });

  it('T124 verdict on first line', () => {
    const text = 'VERDICT: PASS\n🔴 a.js:1 — Bug';
    const r = parseEvaluation(text);
    assert.equal(r.verdict, 'PASS');
  });

  it('T125 VERDICT_RE regex matches', () => {
    assert.ok(VERDICT_RE.test('VERDICT: PASS'));
  });

  it('T126 VERDICT_RE captures value after colon', () => {
    const m = 'VERDICT: BLOCKED'.match(VERDICT_RE);
    assert.equal(m[1], 'BLOCKED');
  });

  it('T127 verdict with FINDINGS[N] in it', () => {
    const r = parseEvaluation('VERDICT: FAIL FINDINGS [3]');
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, 'FAIL FINDINGS [3]');
  });

  it('T128 verdict line in heading still parsed (verdict detection does not check #)', () => {
    // Note: verdict detection does NOT skip headings — it checks every line
    const r = parseEvaluation('# VERDICT: PASS');
    assert.equal(r.verdict_present, true);
  });

  it('T129 VERDICT in middle of multiline text', () => {
    const text = 'Some preamble\n\nVERDICT: ITERATE\n\nSome epilogue';
    const r = parseEvaluation(text);
    assert.equal(r.verdict, 'ITERATE');
  });

  it('T130 verdict with emoji in value', () => {
    const r = parseEvaluation('VERDICT: FAIL 🔴');
    assert.equal(r.verdict, 'FAIL 🔴');
  });

  it('T131 verdict_present stays true even with empty value after colon', () => {
    // VERDICT_RE requires .+ so this should NOT match
    const r = parseEvaluation('VERDICT:');
    assert.equal(r.verdict_present, false);
  });

  it('T132 VERDICT_RE matches even with trailing space (dot-plus is greedy)', () => {
    // .+ matches the trailing space character
    assert.ok(VERDICT_RE.test('VERDICT: '));
  });

  it('T133 verdict with tab after colon', () => {
    const r = parseEvaluation('VERDICT:\tPASS');
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, 'PASS');
  });

  it('T134 three verdicts — last wins', () => {
    const text = 'VERDICT: A\nVERDICT: B\nVERDICT: C';
    const r = parseEvaluation(text);
    assert.equal(r.verdict, 'C');
  });

  it('T135 verdict with mixed case VERDICT keyword', () => {
    const r = parseEvaluation('VeRdIcT: PASS');
    assert.equal(r.verdict_present, true);
  });

  it('T136 verdict value includes everything after colon', () => {
    const r = parseEvaluation('VERDICT: PASS — all checks green');
    assert.equal(r.verdict, 'PASS — all checks green');
  });

  it('T137 verdict with leading whitespace on line', () => {
    const r = parseEvaluation('  VERDICT: PASS');
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, 'PASS');
  });

  it('T138 text "VERDICT" without colon is not a verdict', () => {
    const r = parseEvaluation('The VERDICT is guilty');
    assert.equal(r.verdict_present, false);
  });

  it('T139 verdict_present is boolean', () => {
    const r = parseEvaluation('VERDICT: X');
    assert.equal(typeof r.verdict_present, 'boolean');
  });

  it('T140 verdict is always a string', () => {
    const r = parseEvaluation('');
    assert.equal(typeof r.verdict, 'string');
  });
});

// ============================================================================
// S05: Fix Lines (T141–T165)
// ============================================================================
describe('S05: Fix Lines', () => {
  it('T141 fix line with → prefix parsed', () => {
    const text = '🔴 a.js:1 — Bug\n→ Replace X with Y';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Replace X with Y');
  });

  it('T142 fix line with → and leading space parsed', () => {
    const text = '🔴 a.js:1 — Bug\n→  Use const instead';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Use const instead');
  });

  it('T143 missing fix line leaves fix as null', () => {
    const text = '🔴 a.js:1 — Bug';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, null);
  });

  it('T144 fix line without prior finding is ignored', () => {
    const r = parseEvaluation('→ Orphan fix line');
    assert.equal(r.findings_count, 0);
  });

  it('T145 fix line with code snippet', () => {
    const text = '🔴 a.js:1 — Bug\n→ Change `foo()` to `bar()`';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Change `foo()` to `bar()`');
  });

  it('T146 fix line with empty content after arrow', () => {
    const text = '🔴 a.js:1 — Bug\n→';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, '');
  });

  it('T147 fix applies to most recent finding', () => {
    const text = '🔴 a.js:1 — Bug A\n🟡 b.js:2 — Bug B\n→ Fix for B';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, null);
    assert.equal(r.findings[1].fix, 'Fix for B');
  });

  it('T148 second fix line overwrites first for same finding', () => {
    const text = '🔴 a.js:1 — Bug\n→ First fix\n→ Second fix';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Second fix');
  });

  it('T149 fix with special characters', () => {
    const text = '🔴 a.js:1 — Bug\n→ Use `arr.map(x => x * 2)` instead';
    const r = parseEvaluation(text);
    assert.ok(r.findings[0].fix.includes('=>'));
  });

  it('T150 fix line trimmed of leading whitespace', () => {
    const text = '🔴 a.js:1 — Bug\n  → Fix this';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Fix this');
  });

  it('T151 fix with URL', () => {
    const text = '🔴 a.js:1 — Bug\n→ See https://example.com for fix';
    const r = parseEvaluation(text);
    assert.ok(r.findings[0].fix.includes('https://example.com'));
  });

  it('T152 fix each finding independently', () => {
    const text = '🔴 a.js:1 — A\n→ Fix A\n🟡 b.js:2 — B\n→ Fix B';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Fix A');
    assert.equal(r.findings[1].fix, 'Fix B');
  });

  it('T153 fix line with → and no space', () => {
    const text = '🔴 a.js:1 — Bug\n→Fix directly';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Fix directly');
  });

  it('T154 fix line does not interfere with severity count', () => {
    const text = '🔴 a.js:1 — Bug\n→ Fix it';
    const r = parseEvaluation(text);
    assert.equal(r.critical, 1);
    assert.equal(r.findings_count, 1);
  });

  it('T155 non-arrow lines between finding and fix are ignored for fix', () => {
    const text = '🔴 a.js:1 — Bug\nSome commentary\n→ The actual fix';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'The actual fix');
  });

  it('T156 fix line with multiline code block reference', () => {
    const text = '🔴 a.js:1 — Bug\n→ Replace with ```const x = 1```';
    const r = parseEvaluation(text);
    assert.ok(r.findings[0].fix.includes('const x = 1'));
  });

  it('T157 fix with parentheses', () => {
    const text = '🔴 a.js:1 — Bug\n→ Call init() before render()';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Call init() before render()');
  });

  it('T158 fix with unicode characters', () => {
    const text = '🔴 a.js:1 — Bug\n→ 修复这个问题';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, '修复这个问题');
  });

  it('T159 regular arrow -> does not count as fix', () => {
    const text = '🔴 a.js:1 — Bug\n-> Not a fix';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, null);
  });

  it('T160 fix with hedging word detected', () => {
    const text = '🔴 a.js:1 — Bug\n→ might want to refactor this';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'might want to refactor this');
    assert.ok(r.hedging_detected.length > 0);
  });

  it('T161 fix line with only whitespace after arrow', () => {
    const text = '🔴 a.js:1 — Bug\n→   ';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, '');
  });

  it('T162 fix with pipe characters', () => {
    const text = '🔴 a.js:1 — Bug\n→ Use `data | filter | sort`';
    const r = parseEvaluation(text);
    assert.ok(r.findings[0].fix.includes('|'));
  });

  it('T163 tab-indented fix line', () => {
    const text = '🔴 a.js:1 — Bug\n\t→ Tabbed fix';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Tabbed fix');
  });

  it('T164 fix with quotes', () => {
    const text = '🔴 a.js:1 — Bug\n→ Set name to "default"';
    const r = parseEvaluation(text);
    assert.ok(r.findings[0].fix.includes('"default"'));
  });

  it('T165 fix for last finding when it is the last line', () => {
    const text = '🔴 a.js:1 — Bug\n→ Final fix';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Final fix');
  });
});

// ============================================================================
// S06: Reasoning Lines (T166–T190)
// ============================================================================
describe('S06: Reasoning Lines', () => {
  it('T166 reasoning: prefix parsed', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning: it causes crashes';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'it causes crashes');
  });

  it('T167 Reasoning: capitalized parsed', () => {
    const text = '🔴 a.js:1 — Bug\nReasoning: it causes crashes';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'it causes crashes');
  });

  it('T168 REASONING: all caps parsed', () => {
    const text = '🔴 a.js:1 — Bug\nREASONING: it causes crashes';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'it causes crashes');
  });

  it('T169 reasoning with extra spaces after colon', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning:    spaced out';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'spaced out');
  });

  it('T170 reasoning with no space after colon', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning:tight';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'tight');
  });

  it('T171 empty reasoning after colon', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning:';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, '');
  });

  it('T172 reasoning without prior finding is ignored (no crash)', () => {
    const r = parseEvaluation('reasoning: orphan reasoning');
    assert.equal(r.findings_count, 0);
  });

  it('T173 reasoning applies to most recent finding', () => {
    const text = '🔴 a.js:1 — A\n🟡 b.js:2 — B\nreasoning: for B';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, null);
    assert.equal(r.findings[1].reasoning, 'for B');
  });

  it('T174 reasoning after fix, both captured', () => {
    const text = '🔴 a.js:1 — Bug\n→ Fix it\nreasoning: because';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Fix it');
    assert.equal(r.findings[0].reasoning, 'because');
  });

  it('T175 reasoning before fix, both captured', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning: because\n→ Fix it';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'because');
    assert.equal(r.findings[0].fix, 'Fix it');
  });

  it('T176 second reasoning overwrites first', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning: first\nreasoning: second';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'second');
  });

  it('T177 reasoning with hedging detected', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning: might be a problem';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected.length > 0);
  });

  it('T178 reasoning does not affect severity count', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning: stuff';
    const r = parseEvaluation(text);
    assert.equal(r.critical, 1);
    assert.equal(r.findings_count, 1);
  });

  it('T179 reasoning with code in it', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning: `null` is passed to `parseInt()`';
    const r = parseEvaluation(text);
    assert.ok(r.findings[0].reasoning.includes('parseInt'));
  });

  it('T180 reasoning with unicode', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning: 因为这个会崩溃';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, '因为这个会崩溃');
  });

  it('T181 reasoning line with leading whitespace', () => {
    const text = '🔴 a.js:1 — Bug\n   reasoning: indented';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'indented');
  });

  it('T182 reasoning line with tab prefix', () => {
    const text = '🔴 a.js:1 — Bug\n\treasoning: tabbed';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'tabbed');
  });

  it('T183 text containing "reasoning" not at start is not a reasoning line', () => {
    const text = '🔴 a.js:1 — Bug\nThe reasoning is unclear';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, null);
  });

  it('T184 ReAsOnInG: mixed case parsed', () => {
    const text = '🔴 a.js:1 — Bug\nReAsOnInG: mixed';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'mixed');
  });

  it('T185 reasoning with only whitespace after colon', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning:   ';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, '');
  });

  it('T186 reasoning for each finding independently', () => {
    const text = '🔴 a.js:1 — A\nreasoning: R1\n🟡 b.js:2 — B\nreasoning: R2';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].reasoning, 'R1');
    assert.equal(r.findings[1].reasoning, 'R2');
  });

  it('T187 reasoning with special characters', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning: uses O(n^2) which is > O(n log n)';
    const r = parseEvaluation(text);
    assert.ok(r.findings[0].reasoning.includes('O(n^2)'));
  });

  it('T188 reasoning default is null', () => {
    const r = parseEvaluation('🔴 a.js:1 — Bug');
    assert.equal(r.findings[0].reasoning, null);
  });

  it('T189 reasoning with URL', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning: see https://cve.org/123';
    const r = parseEvaluation(text);
    assert.ok(r.findings[0].reasoning.includes('https://'));
  });

  it('T190 reasoning line does not start new finding', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning: reason\n→ Fix';
    const r = parseEvaluation(text);
    assert.equal(r.findings.length, 1);
  });
});

// ============================================================================
// S07: Hedging Detection (T191–T220)
// ============================================================================
describe('S07: Hedging Detection', () => {
  it('T191 "might" detected as hedging', () => {
    const text = '🔴 a.js:1 — This might be a bug';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected.length > 0);
  });

  it('T192 "could potentially" detected as hedging', () => {
    const text = '🔴 a.js:1 — This could potentially cause issues';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected.length > 0);
  });

  it('T193 "consider" detected as hedging', () => {
    const text = '🔴 a.js:1 — consider refactoring this';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected.length > 0);
  });

  it('T194 no hedging words returns empty array', () => {
    const text = '🔴 a.js:1 — Definitely a bug';
    const r = parseEvaluation(text);
    assert.equal(r.hedging_detected.length, 0);
  });

  it('T195 HEDGING_RE is case insensitive', () => {
    assert.ok(HEDGING_RE.test('MIGHT be wrong'));
    assert.ok(HEDGING_RE.test('Could Potentially fail'));
    assert.ok(HEDGING_RE.test('CONSIDER this'));
  });

  it('T196 hedging in fix line detected', () => {
    const text = '🔴 a.js:1 — Bug\n→ might want to change this';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected.length > 0);
  });

  it('T197 hedging in reasoning line detected', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning: could potentially crash';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected.length > 0);
  });

  it('T198 hedging includes line number in entry', () => {
    const text = '🔴 a.js:1 — might be wrong';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected[0].startsWith('line '));
  });

  it('T199 hedging includes quoted line text', () => {
    const text = '🔴 a.js:1 — might be wrong';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected[0].includes("'"));
  });

  it('T200 "might" as part of another word not detected (e.g., almighty)', () => {
    // HEDGING_RE uses \b so "almighty" should not match
    assert.ok(!HEDGING_RE.test('almighty power'));
  });

  it('T201 "consider" as part of "considerable" still matches at word boundary', () => {
    // "considerable" starts with "consider" but \b after "consider" would fail
    // because 'a' follows. Let's check.
    assert.ok(!HEDGING_RE.test('considerable'));
  });

  it('T202 hedging in non-finding context line (within finding block)', () => {
    const text = '🔴 a.js:1 — Bug\nYou might want to look at this';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected.length > 0);
  });

  it('T203 hedging not detected in heading lines (trimmed starts with #)', () => {
    // headings are skipped for hedging detection in the general case
    const text = '🔴 a.js:1 — Bug\n# might want to consider this';
    const r = parseEvaluation(text);
    // heading line starts with # so it should be skipped
    const hedgingFromHeading = r.hedging_detected.filter(h => h.includes('might want'));
    assert.equal(hedgingFromHeading.length, 0);
  });

  it('T204 multiple hedging words on same line', () => {
    const text = '🔴 a.js:1 — might consider refactoring';
    const r = parseEvaluation(text);
    // hedging_detected should have at least one entry for this line
    assert.ok(r.hedging_detected.length >= 1);
  });

  it('T205 hedging across multiple lines', () => {
    const text = '🔴 a.js:1 — might be wrong\n→ consider fixing it';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected.length >= 2);
  });

  it('T206 hedging not detected on empty lines', () => {
    const text = '🔴 a.js:1 — Bug\n\n';
    const r = parseEvaluation(text);
    assert.equal(r.hedging_detected.length, 0);
  });

  it('T207 HEDGING_RE does not match "could" alone (only "could potentially")', () => {
    assert.ok(!HEDGING_RE.test('could be better'));
  });

  it('T208 hedging on line before any finding not detected (no currentFinding)', () => {
    const text = 'This might be an issue\n🔴 a.js:1 — Bug';
    const r = parseEvaluation(text);
    // First line has no currentFinding, so hedging should not be collected
    // Actually: line 1 has no currentFinding and no severity match, so hedging block at line 102 won't fire
    assert.equal(r.hedging_detected.length, 0);
  });

  it('T209 hedging in verdict line is not detected (no currentFinding context usually)', () => {
    const text = 'VERDICT: might PASS';
    const r = parseEvaluation(text);
    // No currentFinding, so hedging won't be recorded
    assert.equal(r.hedging_detected.length, 0);
  });

  it('T210 hedging detected after currentFinding set', () => {
    const text = '🔴 a.js:1 — Bug\nthis might fail';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected.length > 0);
  });

  it('T211 "Consider" at start of sentence detected', () => {
    const text = '🔴 a.js:1 — Consider using async/await';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected.length > 0);
  });

  it('T212 HEDGING_RE test on exact word "might"', () => {
    assert.ok(HEDGING_RE.test('might'));
  });

  it('T213 HEDGING_RE test on exact phrase "could potentially"', () => {
    assert.ok(HEDGING_RE.test('could potentially'));
  });

  it('T214 HEDGING_RE test on exact word "consider"', () => {
    assert.ok(HEDGING_RE.test('consider'));
  });

  it('T215 hedging in finding line includes correct line number', () => {
    const text = 'line one\n🔴 a.js:1 — might fail';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected[0].includes('line 2'));
  });

  it('T216 hedging in fix line includes correct line number', () => {
    const text = '🔴 a.js:1 — Bug\n→ consider this fix';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected[0].includes('line 2'));
  });

  it('T217 hedging in reasoning line includes correct line number', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning: might be relevant';
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected[0].includes('line 2'));
  });

  it('T218 nightMIGHT with no boundary does not match', () => {
    assert.ok(!HEDGING_RE.test('nightMIGHT'));
  });

  it('T219 "could potentially" with extra spaces does not match', () => {
    assert.ok(!HEDGING_RE.test('could   potentially'));
  });

  it('T220 hedging detection does not create extra findings', () => {
    const text = '🔴 a.js:1 — might be wrong\nthis could potentially fail';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
  });
});

// ============================================================================
// S08: Findings Count Validation (T221–T240)
// ============================================================================
describe('S08: Findings Count Validation', () => {
  it('T221 FINDINGS [3] matches actual 3 findings', () => {
    const text = '🔴 a.js:1 — A\n🟡 b.js:2 — B\n🔵 c.js:3 — C\nVERDICT: FAIL FINDINGS [3]';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, true);
  });

  it('T222 FINDINGS [2] does not match actual 3 findings', () => {
    const text = '🔴 a.js:1 — A\n🟡 b.js:2 — B\n🔵 c.js:3 — C\nVERDICT: FAIL FINDINGS [2]';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, false);
  });

  it('T223 FINDINGS [0] matches zero findings', () => {
    const text = 'VERDICT: PASS FINDINGS [0]';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, true);
  });

  it('T224 no FINDINGS[N] and no findings — verdict_count_match is true', () => {
    const r = parseEvaluation('VERDICT: PASS');
    assert.equal(r.verdict_count_match, true);
  });

  it('T225 no FINDINGS[N] but findings exist — verdict_count_match is null', () => {
    const text = '🔴 a.js:1 — Bug\nVERDICT: FAIL';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, null);
  });

  it('T226 FINDINGS_N_RE matches FINDINGS [5]', () => {
    assert.ok(FINDINGS_N_RE.test('FINDINGS [5]'));
  });

  it('T227 FINDINGS_N_RE matches FINDINGS[5] without space', () => {
    assert.ok(FINDINGS_N_RE.test('FINDINGS[5]'));
  });

  it('T228 FINDINGS_N_RE captures the number', () => {
    const m = 'FINDINGS [42]'.match(FINDINGS_N_RE);
    assert.equal(m[1], '42');
  });

  it('T229 FINDINGS_N_RE is case insensitive', () => {
    assert.ok(FINDINGS_N_RE.test('findings [3]'));
    assert.ok(FINDINGS_N_RE.test('Findings [3]'));
  });

  it('T230 FINDINGS [1] matches 1 finding', () => {
    const text = '🔴 a.js:1 — Bug\nVERDICT: FAIL FINDINGS [1]';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, true);
  });

  it('T231 FINDINGS [10] matches 10 findings', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `🔴 f.js:${i + 1} — Issue ${i}`);
    lines.push('VERDICT: FAIL FINDINGS [10]');
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.verdict_count_match, true);
  });

  it('T232 FINDINGS[N] in verdict but count differs by 1', () => {
    const text = '🔴 a.js:1 — Bug\nVERDICT: FAIL FINDINGS [2]';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, false);
  });

  it('T233 findings_count sums all severities', () => {
    const text = '🔴 a.js:1 — A\n🔴 b.js:2 — B\n🟡 c.js:3 — C';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, r.critical + r.warning + r.suggestion);
  });

  it('T234 no verdict at all — verdict_count_match defaults', () => {
    const text = '🔴 a.js:1 — Bug';
    const r = parseEvaluation(text);
    // No verdict, fnMatch is null on empty string, findingsCount > 0 => null
    assert.equal(r.verdict_count_match, null);
  });

  it('T235 FINDINGS_N_RE does not match FINDINGS without brackets', () => {
    assert.ok(!FINDINGS_N_RE.test('FINDINGS 5'));
  });

  it('T236 FINDINGS_N_RE does not match empty brackets', () => {
    assert.ok(!FINDINGS_N_RE.test('FINDINGS []'));
  });

  it('T237 FINDINGS [0] with no findings returns true', () => {
    const r = parseEvaluation('VERDICT: PASS FINDINGS [0]');
    assert.equal(r.findings_count, 0);
    assert.equal(r.verdict_count_match, true);
  });

  it('T238 FINDINGS_N_RE matches multi-digit number', () => {
    const m = 'FINDINGS [123]'.match(FINDINGS_N_RE);
    assert.equal(m[1], '123');
  });

  it('T239 verdict_count_match with no verdict and no findings is true', () => {
    const r = parseEvaluation('Just text');
    // verdict is '', fnMatch on '' is null, findingsCount is 0
    assert.equal(r.verdict_count_match, true);
  });

  it('T240 FINDINGS with extra spaces around number does not match (\\d+ requires digits immediately)', () => {
    assert.ok(!FINDINGS_N_RE.test('FINDINGS [ 5 ]'));
  });
});

// ============================================================================
// S09: Edge Cases (T241–T270)
// ============================================================================
describe('S09: Edge Cases', () => {
  it('T241 very long text (10000 lines) does not crash', () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `Line ${i}: some text`);
    lines[5000] = '🔴 big.js:5000 — Found in the middle';
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.findings_count, 1);
  });

  it('T242 Windows line endings (\\r\\n) handled', () => {
    const text = '🔴 a.js:1 — Bug\r\n→ Fix it\r\nreasoning: because';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].fix, 'Fix it');
    assert.equal(r.findings[0].reasoning, 'because');
  });

  it('T243 mixed line endings (\\n and \\r\\n)', () => {
    const text = '🔴 a.js:1 — Bug\r\n🟡 b.js:2 — Warn\n🔵 c.js:3 — Suggest';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 3);
  });

  it('T244 tabs in finding line', () => {
    const text = '\t🔴\ta.js:1\t—\tBug';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
  });

  it('T245 Unicode in issue text', () => {
    const r = parseEvaluation('🔴 a.js:1 — 变量命名不规范');
    assert.equal(r.findings[0].issue, '变量命名不规范');
  });

  it('T246 emoji in issue text (non-severity)', () => {
    const r = parseEvaluation('🔴 a.js:1 — Memory leak 💧');
    assert.ok(r.findings[0].issue.includes('💧'));
  });

  it('T247 nested code blocks do not interfere', () => {
    const text = '🔴 a.js:1 — Bug\n```\nconst x = 1;\n```\n🟡 b.js:2 — Warn';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
  });

  it('T248 HTML tags in text', () => {
    const r = parseEvaluation('🔴 a.js:1 — Missing <div> closing tag');
    assert.equal(r.findings_count, 1);
    assert.ok(r.findings[0].issue.includes('<div>'));
  });

  it('T249 markdown bold in issue text', () => {
    const r = parseEvaluation('🔴 a.js:1 — **Critical** memory leak');
    assert.ok(r.findings[0].issue.includes('**Critical**'));
  });

  it('T250 markdown italic in issue text', () => {
    const r = parseEvaluation('🔴 a.js:1 — _Possible_ issue');
    assert.ok(r.findings[0].issue.includes('_Possible_'));
  });

  it('T251 line with only whitespace between findings', () => {
    const text = '🔴 a.js:1 — A\n   \n🟡 b.js:2 — B';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
  });

  it('T252 text with BOM character', () => {
    const text = '\uFEFF🔴 a.js:1 — Bug';
    const r = parseEvaluation(text);
    // BOM may interfere with trimmed.startsWith("#") but severity should still match
    assert.equal(r.findings_count, 1);
  });

  it('T253 null-like text "null"', () => {
    const r = parseEvaluation('null');
    assert.equal(r.findings_count, 0);
  });

  it('T254 text "undefined"', () => {
    const r = parseEvaluation('undefined');
    assert.equal(r.findings_count, 0);
  });

  it('T255 very long single line', () => {
    const long = '🔴 a.js:1 — ' + 'x'.repeat(10000);
    const r = parseEvaluation(long);
    assert.equal(r.findings_count, 1);
  });

  it('T256 finding with em-dash at end of line', () => {
    const r = parseEvaluation('🔴 a.js:1 —');
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].issue, '');
  });

  it('T257 multiple em-dashes on one line — first split used', () => {
    const r = parseEvaluation('🔴 a.js:1 — Issue — more context');
    assert.equal(r.findings[0].issue, 'Issue — more context');
  });

  it('T258 regular dash is not treated as em-dash', () => {
    const r = parseEvaluation('🔴 a.js:1 - Not an em-dash');
    // No em-dash found, so entire line becomes issue
    assert.equal(r.findings[0].issue, '🔴 a.js:1 - Not an em-dash');
  });

  it('T259 single newline at end of text', () => {
    const r = parseEvaluation('🔴 a.js:1 — Bug\n');
    assert.equal(r.findings_count, 1);
  });

  it('T260 line with only severity emoji and brackets', () => {
    const r = parseEvaluation('[🔴]');
    assert.equal(r.findings_count, 1);
  });

  it('T261 backslashes in file path — regex matches after backslash', () => {
    // FILE_REF_RE [\w./-]+\.\w+:\d+ — "app.js:1" still matches after the backslash
    const r = parseEvaluation('🔴 src\\app.js:1 — Bug');
    assert.equal(r.findings[0].file, 'app.js');
    assert.equal(r.findings[0].line, 1);
  });

  it('T262 file ref with space in path — regex matches portion after space', () => {
    // "file.js:10" portion matches despite space before it
    assert.ok(FILE_REF_RE.test('my file.js:10'));
  });

  it('T263 emoji in file path does not match file ref', () => {
    assert.ok(!FILE_REF_RE.test('🔴.js:10'));
  });

  it('T264 Japanese characters in issue text', () => {
    const r = parseEvaluation('🔴 a.js:1 — メモリリーク');
    assert.equal(r.findings[0].issue, 'メモリリーク');
  });

  it('T265 Arabic characters in issue text', () => {
    const r = parseEvaluation('🔴 a.js:1 — خطأ في الذاكرة');
    assert.equal(r.findings[0].issue, 'خطأ في الذاكرة');
  });

  it('T266 markdown horizontal rule does not crash', () => {
    const text = '---\n🔴 a.js:1 — Bug\n---';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
  });

  it('T267 markdown link in issue text', () => {
    const r = parseEvaluation('🔴 a.js:1 — See [docs](https://example.com)');
    assert.ok(r.findings[0].issue.includes('[docs]'));
  });

  it('T268 markdown image in text', () => {
    const r = parseEvaluation('🔴 a.js:1 — ![alt](img.png:100)');
    assert.equal(r.findings_count, 1);
  });

  it('T269 only \\r line endings (old Mac style)', () => {
    // Parser only replaces \r\n, so \r alone stays — split by \n gives one big line
    const text = '🔴 a.js:1 — Bug\r→ Fix\rreasoning: because';
    const r = parseEvaluation(text);
    // All on one line after split by \n
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].fix, null); // fix is on "same line" so not detected
  });

  it('T270 extremely deeply nested path', () => {
    const path = 'a/b/c/d/e/f/g/h/i/j/k.ts:1';
    const r = parseEvaluation(`🔴 ${path} — Deep`);
    assert.equal(r.findings[0].file, 'a/b/c/d/e/f/g/h/i/j/k.ts');
  });
});

// ============================================================================
// S10: Complex Documents (T271–T300)
// ============================================================================
describe('S10: Complex Documents', () => {
  it('T271 realistic full evaluation document', () => {
    const text = `# Code Review

## Findings

🔴 src/auth.ts:45 — SQL injection vulnerability in login handler
→ Use parameterized queries instead of string concatenation
reasoning: User input is directly interpolated into SQL string

🟡 src/utils.ts:120 — Unused import of lodash
→ Remove the import to reduce bundle size

🔵 src/components/Button.tsx:8 — Consider using semantic HTML
→ Replace div with button element
reasoning: Improves accessibility

VERDICT: FAIL FINDINGS [3]`;
    const r = parseEvaluation(text);
    assert.equal(r.verdict_present, true);
    assert.equal(r.verdict, 'FAIL FINDINGS [3]');
    assert.equal(r.findings_count, 3);
    assert.equal(r.critical, 1);
    assert.equal(r.warning, 1);
    assert.equal(r.suggestion, 1);
    assert.equal(r.has_file_refs, true);
    assert.equal(r.verdict_count_match, true);
    assert.equal(r.findings[0].file, 'src/auth.ts');
    assert.equal(r.findings[0].line, 45);
    assert.equal(r.findings[0].fix, 'Use parameterized queries instead of string concatenation');
    assert.equal(r.findings[0].reasoning, 'User input is directly interpolated into SQL string');
  });

  it('T272 evaluation with only warnings', () => {
    const text = `🟡 api.js:10 — Missing error handling
→ Add try/catch
🟡 api.js:25 — Deprecated method used
→ Migrate to fetch API
VERDICT: ITERATE FINDINGS [2]`;
    const r = parseEvaluation(text);
    assert.equal(r.critical, 0);
    assert.equal(r.warning, 2);
    assert.equal(r.suggestion, 0);
    assert.equal(r.verdict, 'ITERATE FINDINGS [2]');
    assert.equal(r.verdict_count_match, true);
  });

  it('T273 evaluation with hedging throughout', () => {
    const text = `🔴 a.js:1 — This might cause crashes
→ consider replacing the algorithm
reasoning: could potentially lead to data loss`;
    const r = parseEvaluation(text);
    assert.ok(r.hedging_detected.length >= 3);
  });

  it('T274 evaluation with heading containing severity (skipped) and actual findings', () => {
    const text = `# 🔴 Critical Issues

🔴 db.js:50 — Connection pool exhaustion

## 🟡 Warnings

🟡 config.js:3 — Hardcoded timeout value

VERDICT: FAIL FINDINGS [2]`;
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
    assert.equal(r.critical, 1);
    assert.equal(r.warning, 1);
    assert.equal(r.verdict_count_match, true);
  });

  it('T275 PASS verdict with zero findings', () => {
    const text = `# Review Complete

All checks passed. No issues found.

VERDICT: PASS FINDINGS [0]`;
    const r = parseEvaluation(text);
    assert.equal(r.verdict_present, true);
    assert.equal(r.findings_count, 0);
    assert.equal(r.verdict_count_match, true);
  });

  it('T276 mismatched findings count in verdict', () => {
    const text = `🔴 a.js:1 — Bug
🟡 b.js:2 — Warn
VERDICT: FAIL FINDINGS [5]`;
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
    assert.equal(r.verdict_count_match, false);
  });

  it('T277 evaluation with all severity types and fixes and reasoning', () => {
    const text = `🔴 critical.ts:1 — Critical bug
→ Fix the critical bug
reasoning: It crashes the app

🟡 warn.ts:2 — Minor warning
→ Address the warning
reasoning: Performance impact

🔵 suggest.ts:3 — Style suggestion
→ Improve naming
reasoning: Readability`;
    const r = parseEvaluation(text);
    assert.equal(r.findings.length, 3);
    r.findings.forEach(f => {
      assert.notEqual(f.fix, null);
      assert.notEqual(f.reasoning, null);
    });
  });

  it('T278 evaluation with Windows line endings throughout', () => {
    const text = '🔴 a.js:1 — Bug\r\n→ Fix\r\nreasoning: reason\r\nVERDICT: FAIL FINDINGS [1]';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].fix, 'Fix');
    assert.equal(r.findings[0].reasoning, 'reason');
    assert.equal(r.verdict_count_match, true);
  });

  it('T279 evaluation with no file references at all', () => {
    const text = `🔴 — General architecture concern
→ Refactor the module
🟡 — Code style inconsistency
→ Apply linter
VERDICT: ITERATE`;
    const r = parseEvaluation(text);
    assert.equal(r.has_file_refs, false);
    assert.equal(r.findings_count, 2);
  });

  it('T280 evaluation with bracketed severity markers', () => {
    const text = `[🔴] src/main.ts:1 — Critical issue
[🟡] src/util.ts:5 — Warning issue
[🔵] src/help.ts:10 — Suggestion`;
    const r = parseEvaluation(text);
    assert.equal(r.critical, 1);
    assert.equal(r.warning, 1);
    assert.equal(r.suggestion, 1);
  });

  it('T281 large evaluation with 50 findings', () => {
    const lines = [];
    for (let i = 0; i < 50; i++) {
      const sev = i % 3 === 0 ? '🔴' : i % 3 === 1 ? '🟡' : '🔵';
      lines.push(`${sev} file${i}.js:${i + 1} — Issue number ${i}`);
      lines.push(`→ Fix for issue ${i}`);
    }
    lines.push('VERDICT: FAIL FINDINGS [50]');
    const r = parseEvaluation(lines.join('\n'));
    assert.equal(r.findings_count, 50);
    assert.equal(r.findings.length, 50);
    assert.equal(r.verdict_count_match, true);
  });

  it('T282 evaluation with prose paragraphs between findings', () => {
    const text = `The following issues were identified during review.

🔴 server.js:100 — Race condition in request handler

The above issue is particularly concerning because multiple
threads can access shared state simultaneously.

🟡 client.js:50 — Missing loading state

This is less severe but affects user experience.

VERDICT: FAIL FINDINGS [2]`;
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
    assert.equal(r.verdict_count_match, true);
  });

  it('T283 evaluation with code blocks containing severity emoji (false positive check)', () => {
    // Code block content is just plain lines — parser will detect emoji in them
    const text = '🔴 a.js:1 — Bug\n```\nconsole.log("🔴 not a finding")\n```';
    const r = parseEvaluation(text);
    // The line inside ``` has 🔴 and doesn't start with #, so it IS detected as a finding
    assert.equal(r.findings_count, 2);
  });

  it('T284 evaluation verdict with complex text', () => {
    const r = parseEvaluation('VERDICT: ITERATE — 2 critical, 1 warning, address before merge FINDINGS [3]');
    assert.equal(r.verdict_present, true);
    assert.ok(r.verdict.includes('ITERATE'));
    assert.ok(r.verdict.includes('FINDINGS [3]'));
  });

  it('T285 evaluation with reasoning containing file references', () => {
    const text = '🔴 a.js:1 — Bug\nreasoning: similar to pattern in b.js:42';
    const r = parseEvaluation(text);
    assert.equal(r.has_file_refs, true);
    assert.ok(r.findings[0].reasoning.includes('b.js:42'));
  });

  it('T286 evaluation with fix containing file references', () => {
    const text = '🔴 a.js:1 — Bug\n→ Move logic to utils.ts:10';
    const r = parseEvaluation(text);
    assert.equal(r.has_file_refs, true);
  });

  it('T287 evaluation with only a verdict and FINDINGS[0]', () => {
    const r = parseEvaluation('VERDICT: PASS FINDINGS [0]');
    assert.equal(r.verdict_present, true);
    assert.equal(r.findings_count, 0);
    assert.equal(r.verdict_count_match, true);
    assert.deepEqual(r.findings, []);
  });

  it('T288 evaluation where verdict appears between findings', () => {
    const text = '🔴 a.js:1 — Bug A\nVERDICT: FAIL\n🟡 b.js:2 — Bug B';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_present, true);
    assert.equal(r.findings_count, 2);
  });

  it('T289 evaluation with multiple verdict lines — last wins', () => {
    const text = 'VERDICT: PASS\n🔴 a.js:1 — Found late bug\nVERDICT: FAIL FINDINGS [1]';
    const r = parseEvaluation(text);
    assert.equal(r.verdict, 'FAIL FINDINGS [1]');
    assert.equal(r.verdict_count_match, true);
  });

  it('T290 evaluation with indented findings', () => {
    const text = '  🔴 a.js:1 — Indented finding\n  → Indented fix\n  reasoning: indented reason';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].fix, 'Indented fix');
    assert.equal(r.findings[0].reasoning, 'indented reason');
  });

  it('T291 evaluation with consecutive fix lines (last wins)', () => {
    const text = '🔴 a.js:1 — Bug\n→ First attempt\n→ Better fix';
    const r = parseEvaluation(text);
    assert.equal(r.findings[0].fix, 'Better fix');
  });

  it('T292 evaluation with no verdict and multiple findings — verdict_count_match null', () => {
    const text = '🔴 a.js:1 — A\n🟡 b.js:2 — B';
    const r = parseEvaluation(text);
    assert.equal(r.verdict_count_match, null);
  });

  it('T293 realistic security audit format', () => {
    const text = `# Security Audit Report

## Critical Vulnerabilities

🔴 src/api/auth.ts:23 — JWT secret hardcoded in source
→ Move to environment variable
reasoning: Exposed in version control, allows token forgery

🔴 src/db/queries.ts:89 — SQL injection via unsanitized user input
→ Use prepared statements with parameterized queries
reasoning: Direct string interpolation of req.body values

## Warnings

🟡 src/middleware/cors.ts:5 — CORS allows all origins in production
→ Restrict to known domains
reasoning: Overly permissive CORS policy

## Suggestions

🔵 src/utils/crypto.ts:12 — Using SHA-1 for hashing
→ Migrate to SHA-256 or bcrypt
reasoning: SHA-1 is considered weak for security purposes

VERDICT: FAIL FINDINGS [4]`;
    const r = parseEvaluation(text);
    assert.equal(r.critical, 2);
    assert.equal(r.warning, 1);
    assert.equal(r.suggestion, 1);
    assert.equal(r.findings_count, 4);
    assert.equal(r.verdict_count_match, true);
    assert.equal(r.has_file_refs, true);
    assert.equal(r.findings[0].file, 'src/api/auth.ts');
    assert.equal(r.findings[3].file, 'src/utils/crypto.ts');
  });

  it('T294 evaluation with list-style findings', () => {
    const text = `- 🔴 a.js:1 — Critical bug
- 🟡 b.js:2 — Warning
- 🔵 c.js:3 — Suggestion`;
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 3);
  });

  it('T295 evaluation with mixed bracket and bare severity', () => {
    const text = '[🔴] a.js:1 — Bracketed\n🟡 b.js:2 — Bare';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
    assert.equal(r.findings[0].severity, 'critical');
    assert.equal(r.findings[1].severity, 'warning');
  });

  it('T296 evaluation with no em-dashes at all', () => {
    const text = '🔴 src/app.js:1 No dash here\n🟡 src/app.js:2 Also no dash';
    const r = parseEvaluation(text);
    assert.equal(r.findings_count, 2);
    // Without em-dash, full line becomes issue
    assert.ok(r.findings[0].issue.includes('🔴'));
  });

  it('T297 evaluation with file ref in non-finding lines', () => {
    const text = 'Please check src/index.ts:1 for context\n🔴 — General issue';
    const r = parseEvaluation(text);
    assert.equal(r.has_file_refs, true);
    assert.equal(r.findings_count, 1);
    assert.equal(r.findings[0].file, null);
  });

  it('T298 evaluation with hedging only in prose (before any finding)', () => {
    const text = 'You might want to review this code.\n🔴 a.js:1 — Definite bug';
    const r = parseEvaluation(text);
    // "might" is before any finding, so not detected
    assert.equal(r.hedging_detected.length, 0);
  });

  it('T299 evaluation with BLOCKED verdict', () => {
    const text = `🔴 ci.yml:1 — CI pipeline broken, cannot verify changes
VERDICT: BLOCKED FINDINGS [1]`;
    const r = parseEvaluation(text);
    assert.equal(r.verdict, 'BLOCKED FINDINGS [1]');
    assert.equal(r.verdict_count_match, true);
  });

  it('T300 comprehensive stress test — all features combined', () => {
    const text = `# Evaluation Report

## 🔴 Critical (should be skipped as heading)

[🔴] src/auth/login.ts:45 — SQL injection in login handler
→ Use parameterized queries
reasoning: User input interpolated directly

🔴 src/api/users.ts:120 — Missing authentication check
→ Add auth middleware
reasoning: Endpoint accessible without token

## 🟡 Warnings (heading skipped)

🟡 src/config.ts:8 — Hardcoded timeout might cause issues
→ Move to config file
reasoning: could potentially differ per environment

🟡 src/utils/logger.ts:30 — Console.log in production code
→ Use structured logging library

## 🔵 Suggestions

🔵 src/types/index.ts:1 — Consider using discriminated unions
→ Refactor to tagged union type
reasoning: Improves type safety

🔵 tests/setup.ts:15 — Test setup duplicated across files
→ Extract to shared test helper

VERDICT: FAIL — Multiple critical issues found FINDINGS [6]`;
    const r = parseEvaluation(text);
    assert.equal(r.verdict_present, true);
    assert.equal(r.findings_count, 6);
    assert.equal(r.critical, 2);
    assert.equal(r.warning, 2);
    assert.equal(r.suggestion, 2);
    assert.equal(r.has_file_refs, true);
    assert.equal(r.verdict_count_match, true);
    assert.equal(r.findings.length, 6);
    // Hedging: "might" in 🟡 line, "could potentially" in reasoning, "Consider" in 🔵 line
    assert.ok(r.hedging_detected.length >= 3);
    // First finding
    assert.equal(r.findings[0].severity, 'critical');
    assert.equal(r.findings[0].file, 'src/auth/login.ts');
    assert.equal(r.findings[0].line, 45);
    assert.equal(r.findings[0].fix, 'Use parameterized queries');
    assert.equal(r.findings[0].reasoning, 'User input interpolated directly');
    // Last finding
    assert.equal(r.findings[5].severity, 'suggestion');
    assert.equal(r.findings[5].file, 'tests/setup.ts');
  });
});
