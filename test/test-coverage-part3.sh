#!/bin/bash
# Coverage gap tests — Part 3 (CG-10 through CG-13)
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else json.dumps(v))" 2>/dev/null
}

assert_field_eq() {
  local desc="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(jq_field "$json" "$field")
  if [ -z "$actual" ]; then
    echo "  ❌ $desc — no JSON output (field=$field)"
    FAIL=$((FAIL + 1))
    return
  fi
  actual=$(echo "$actual" | tr -d '"')
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -q "$pattern"; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — pattern '$pattern' not found"
    FAIL=$((FAIL + 1))
  fi
}

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-10: cmdSynthesize --wave (legacy) ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-10.1: Synthesize from wave files ---"
rm -rf .h-wave && mkdir -p .h-wave/.harness
cat > .h-wave/.harness/evaluation-wave-1-security.md << 'EVAL'
# Security
VERDICT: FAIL FINDINGS[1]
🔴 Critical XSS — template.js:15 — unescaped user input
→ Use DOMPurify
Reasoning: allows script injection
EVAL
cat > .h-wave/.harness/evaluation-wave-1-perf.md << 'EVAL'
# Perf
VERDICT: PASS FINDINGS[0]
EVAL
OUT=$($HARNESS synthesize .h-wave --wave 1)
assert_contains "wave FAIL verdict" "$OUT" "FAIL"
assert_contains "critical count" "$OUT" "critical"

echo ""
echo "--- CG-10.2: Synthesize BLOCKED verdict ---"
cat > .h-wave/.harness/evaluation-wave-2-security.md << 'EVAL'
# Security
VERDICT: BLOCKED
EVAL
OUT=$($HARNESS synthesize .h-wave --wave 2)
assert_contains "BLOCKED verdict" "$OUT" "BLOCKED"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-11: eval-parser edge cases ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-11.1: Heading with emoji skipped ---"
rm -rf .h-parse && mkdir -p .h-parse
cat > .h-parse/heading-eval.md << 'EVAL'
# Review
VERDICT: PASS FINDINGS[0]
#### 🔴 This should be ignored because it's a heading
EVAL
OUT=$($HARNESS verify .h-parse/heading-eval.md)
assert_field_eq "heading skipped" "$OUT" "critical" "0"

echo ""
echo "--- CG-11.2: Hedging detected ---"
cat > .h-parse/hedge-eval.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[1]
🔴 This might be an issue — test.js:1 — possible problem
→ Consider fixing it
Reasoning: could potentially cause a crash
EVAL
OUT=$($HARNESS verify .h-parse/hedge-eval.md)
assert_contains "hedging found" "$OUT" "hedging"

echo ""
echo "--- CG-11.3: Fix and reasoning parsed ---"
python3 -c "open('.h-parse/app.js','w').write('\n'.join(['line '+str(i) for i in range(1,60)]))"
cat > .h-parse/fix-eval.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[1]
🔴 Null pointer — app.js:42 — crashes on empty input
→ Add null check before dereference
Reasoning: Input validation missing at boundary
EVAL
OUT=$($HARNESS verify .h-parse/fix-eval.md --base .h-parse)
assert_field_eq "has verdict" "$OUT" "verdict_present" "true"
assert_field_eq "critical 1" "$OUT" "critical" "1"
assert_field_eq "evidence complete" "$OUT" "evidence_complete" "true"

echo ""
echo "--- CG-11.4: Finding without file ref detected ---"
cat > .h-parse/noref-eval.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[1]
🔴 General concern about architecture — needs redesign
→ Refactor the whole thing
Reasoning: too coupled
EVAL
OUT=$($HARNESS verify .h-parse/noref-eval.md)
assert_contains "findings without refs" "$OUT" "findings_without_refs"
NOREF=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('findings_without_refs',[])))")
if [ "$NOREF" -ge 1 ]; then
  echo "  ✅ no-ref finding detected"
  PASS=$((PASS + 1))
else
  echo "  ❌ no-ref finding not detected"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- CG-11.5: Verdict count mismatch ---"
cat > .h-parse/mismatch-eval.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[5]
🔴 Only one — test.js:1 — there's one
→ fix it
Reasoning: broken
EVAL
OUT=$($HARNESS verify .h-parse/mismatch-eval.md)
assert_field_eq "count mismatch" "$OUT" "verdict_count_match" "false"

echo ""
echo "--- CG-11.6: Critical without fix detected ---"
cat > .h-parse/nofix-eval.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[1]
🔴 Missing fix — server.js:100 — no fix suggestion provided
Reasoning: clearly broken
EVAL
OUT=$($HARNESS verify .h-parse/nofix-eval.md)
NOFIX=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('critical_without_fix',[])))")
if [ "$NOFIX" -ge 1 ]; then
  echo "  ✅ critical without fix detected"
  PASS=$((PASS + 1))
else
  echo "  ❌ critical without fix not detected"
  FAIL=$((FAIL + 1))
fi

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-12: Diff oscillation + severity change ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-12.1: Oscillation detected ---"
rm -rf .h-diff && mkdir -p .h-diff
cat > .h-diff/r1.md << 'EVAL'
VERDICT: FAIL FINDINGS[3]
🔴 Bug A — test.js:1 — issue one
🔴 Bug B — test.js:2 — issue two
🔴 Bug C — test.js:3 — issue three
EVAL
cat > .h-diff/r2.md << 'EVAL'
VERDICT: FAIL FINDINGS[3]
🔴 Bug A — test.js:1 — issue one
🔴 Bug B — test.js:2 — issue two
🔴 Bug D — test.js:4 — new issue
EVAL
OUT=$($HARNESS diff .h-diff/r1.md .h-diff/r2.md)
assert_field_eq "oscillation true" "$OUT" "oscillation" "true"
assert_contains "recurring count" "$OUT" "recurring"

echo ""
echo "--- CG-12.2: Severity change tracked ---"
cat > .h-diff/r3.md << 'EVAL'
VERDICT: FAIL FINDINGS[1]
🔴 Bug A — test.js:1 — issue one
EVAL
cat > .h-diff/r4.md << 'EVAL'
VERDICT: PASS FINDINGS[1]
🟡 Bug A — test.js:1 — issue one
EVAL
OUT=$($HARNESS diff .h-diff/r3.md .h-diff/r4.md)
assert_contains "severity changed" "$OUT" "severity_changed"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-13: loadState corrupt JSON ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-13.1: Corrupt flow-state in skip → graceful error ---"
rm -rf .h-corrupt && mkdir -p .h-corrupt
echo 'not json' > .h-corrupt/flow-state.json
OUT=$($HARNESS skip --dir .h-corrupt 2>&1 || true)
assert_contains "parse error" "$OUT" "Cannot parse"

echo ""
echo "--- CG-13.2: Corrupt flow-state in stop → graceful error ---"
OUT=$($HARNESS stop --dir .h-corrupt 2>&1 || true)
assert_contains "stop parse error" "$OUT" "Cannot parse"

echo ""
echo "--- CG-13.3: Corrupt flow-state in goto → graceful error ---"
OUT=$($HARNESS goto build --dir .h-corrupt 2>&1 || true)
assert_contains "goto parse error" "$OUT" "Cannot parse"

print_results
