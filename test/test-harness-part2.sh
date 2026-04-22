#!/bin/bash
set -e
source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

# JSON field check via python3
jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else json.dumps(v))" 2>/dev/null
}

assert_field_eq() {
  local desc="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(jq_field "$json" "$field")
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — $field: expected $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_output_contains() {
  local desc="$1" json="$2" pattern="$3"
  if echo "$json" | grep -q "$pattern"; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — pattern '$pattern' not found"
    FAIL=$((FAIL + 1))
  fi
}

assert_output_not_contains() {
  local desc="$1" json="$2" pattern="$3"
  if echo "$json" | grep -q "$pattern"; then
    echo "  ❌ $desc — pattern '$pattern' unexpectedly found"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

# Helper: clean init a loop + advance to first unit
setup_loop() {
  rm -rf .harness
  mkdir -p .harness
  cat > .harness/plan.md << 'PLAN'
- F1.1: implement-a — Build
  - verify: echo test
- F1.2: review-a — Review
  - eval: Check quality
PLAN
  $HARNESS init-loop --skip-scope --dir .harness --plan .harness/plan.md >/dev/null 2>/dev/null
  $HARNESS next-tick --dir .harness >/dev/null 2>/dev/null
}

# ═══════════════════════════════════════════════════════════════
echo "=== TEST GROUP 3: next-tick ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 3.1: In-progress mutex ---"
setup_loop
# After setup_loop, status is in_progress. next-tick should block.
OUT=$($HARNESS next-tick --dir .harness 2>/dev/null)
assert_field_eq "blocks concurrent tick" "$OUT" "ready" "false"
assert_output_contains "explains blocking" "$OUT" "in progress"

echo ""
echo "--- 3.2: Tick limit enforcement ---"
rm -rf .harness && mkdir -p .harness
cat > .harness/plan.md << 'PLAN'
- F1.1: implement-a — Build
  - verify: echo test
- F1.2: review-a — Review
  - eval: check
PLAN
$HARNESS init-loop --skip-scope --dir .harness --plan .harness/plan.md >/dev/null 2>/dev/null
# Set tick at limit (properly preserving nonce/sig)
python3 -c "
import json
d = json.load(open('.harness/loop-state.json'))
d['tick'] = d['_max_total_ticks']
d['status'] = 'completed'
json.dump(d, open('.harness/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .harness 2>/dev/null)
assert_field_eq "enforces tick limit" "$OUT" "terminate" "true"
assert_output_contains "explains max ticks" "$OUT" "maxTotalTicks"

echo ""
echo "--- 3.3: Auto-terminate at end of plan ---"
rm -rf .harness && mkdir -p .harness
cat > .harness/plan.md << 'PLAN'
- F1.1: implement-a — Build
  - verify: echo test
- F1.2: review-a — Review
  - eval: check
PLAN
$HARNESS init-loop --skip-scope --dir .harness --plan .harness/plan.md >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.harness/loop-state.json'))
d['next_unit'] = None
d['status'] = 'completed'
json.dump(d, open('.harness/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .harness 2>/dev/null)
assert_field_eq "terminates at end" "$OUT" "terminate" "true"
assert_output_contains "pipeline complete" "$OUT" "pipeline complete"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 4: Review independence (Bug 8) ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 4.1: Reject review with only 1 eval file ---"
setup_loop
# Complete F1.1 first, then advance to F1.2
echo "code" > f2.js && git add f2.js && git commit -q -m "feat2"
echo '{"tests_run":1,"passed":1,"_command":"npm test","durationMs":100}' > tr.json
$HARNESS complete-tick --dir .harness --unit F1.1 --status completed --artifacts tr.json >/dev/null 2>/dev/null
$HARNESS next-tick --dir .harness >/dev/null 2>/dev/null
# Now on F1.2 (review)
mkdir -p .harness/nodes/F1.2/run_1
echo -e "# Review\n## Findings\n### 🟡 Found a bug" > .harness/nodes/F1.2/run_1/eval-one.md
OUT=$($HARNESS complete-tick --dir .harness --unit F1.2 --status completed --artifacts .harness/nodes/F1.2/run_1/eval-one.md 2>/dev/null)
assert_output_contains "explains need ≥2 evals" "$OUT" "need"

echo ""
echo "--- 4.2: Reject identical eval files ---"
setup_loop
echo "code" > f3.js && git add f3.js && git commit -q -m "feat3"
echo '{"tests_run":1,"passed":1,"_command":"npm test","durationMs":100}' > tr2.json
$HARNESS complete-tick --dir .harness --unit F1.1 --status completed --artifacts tr2.json >/dev/null 2>/dev/null
$HARNESS next-tick --dir .harness >/dev/null 2>/dev/null
mkdir -p .harness/nodes/F1.2/run_1
echo -e "# Security Review\n## Findings\n### 🟡 SQL injection risk in handler\nThe query at line 42 is vulnerable." > .harness/nodes/F1.2/run_1/eval-a.md
cp .harness/nodes/F1.2/run_1/eval-a.md .harness/nodes/F1.2/run_1/eval-b.md
OUT=$($HARNESS complete-tick --dir .harness --unit F1.2 --status completed --artifacts ".harness/nodes/F1.2/run_1/eval-a.md,.harness/nodes/F1.2/run_1/eval-b.md" 2>/dev/null)
assert_output_contains "detects identical evals" "$OUT" "identical"

echo ""
echo "--- 4.3: Accept distinct eval files ---"
setup_loop
echo "code" > f4.js && git add f4.js && git commit -q -m "feat4"
echo '{"tests_run":1,"passed":1,"_command":"npm test","durationMs":100}' > tr3.json
$HARNESS complete-tick --dir .harness --unit F1.1 --status completed --artifacts tr3.json >/dev/null 2>/dev/null
$HARNESS next-tick --dir .harness >/dev/null 2>/dev/null
mkdir -p .harness/nodes/F1.2/run_1
echo -e "# Security Review\n## Findings\n### 🟡 SQL injection risk in user input handler\nThe query builder at line 42 uses string interpolation." > .harness/nodes/F1.2/run_1/eval-security.md
echo -e "# Performance Review\n## Findings\n### 🔵 Consider adding index on users.email\nThe login query does a full table scan on the users table." > .harness/nodes/F1.2/run_1/eval-perf.md
OUT=$($HARNESS complete-tick --dir .harness --unit F1.2 --status completed --artifacts ".harness/nodes/F1.2/run_1/eval-security.md,.harness/nodes/F1.2/run_1/eval-perf.md" 2>/dev/null)
assert_field_eq "accepts distinct evals" "$OUT" "completed" "true"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 5: JSON crash recovery (Bug 3) ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 5.1: Corrupt state in complete-tick ---"
rm -rf .harness && mkdir -p .harness
echo "{truncated" > .harness/loop-state.json
OUT=$($HARNESS complete-tick --dir .harness --unit F1.1 --status completed 2>/dev/null)
assert_output_contains "returns JSON error, not crash" "$OUT" "error"

echo ""
echo "--- 5.2: Corrupt state in next-tick ---"
rm -rf .harness && mkdir -p .harness
echo "not json at all" > .harness/loop-state.json
OUT=$($HARNESS next-tick --dir .harness 2>/dev/null)
assert_output_contains "returns structured error" "$OUT" "corrupt"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 6: Verify/eval plan parsing ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 6.1: Parse verify/eval sub-lines ---"
rm -rf .harness && mkdir -p .harness
cat > .harness/plan.md << 'PLAN'
- F1.1: implement-backend — Build auth endpoints
  - verify: npm test -- --grep auth
  - eval: No plaintext passwords in code
- F1.2: review-backend — Review auth implementation
  - eval: Check for SQL injection
- F1.3: fix-backend — Address findings
PLAN
OUT=$($HARNESS init-loop --skip-scope --dir .harness --plan .harness/plan.md 2>/dev/null)
assert_field_eq "init succeeds" "$OUT" "initialized" "true"
# F1.3 (fix) has no verify line → should warn about F1.3
assert_output_contains "warns F1.3 missing verify" "$OUT" "F1.3"
# F1.1 has verify → check it's NOT in the "have no verify" warning
WARN_TEXT=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); ws=d.get('warnings',[]); [print(w) for w in ws if 'verify' in w]" 2>/dev/null)
if echo "$WARN_TEXT" | grep -q "F1.1"; then
  echo "  ❌ false warning for F1.1 (has verify but still warned)"
  FAIL=$((FAIL + 1))
else
  echo "  ✅ no false warning for F1.1"
  PASS=$((PASS + 1))
fi

# ═══════════════════════════════════════════════════════════════
print_results
