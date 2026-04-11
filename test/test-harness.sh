#!/bin/bash
# End-to-end tests for opc-harness loop commands
# Tests all bug fixes from the 24h review sprint
set -e

HARNESS="node $(cd "$(dirname "$0")/.." && pwd)/bin/opc-harness.mjs"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT
cd "$TMPDIR"

# Need a git repo for some tests
git init -q .
git config user.email "test@test.com"
git config user.name "Test"
echo "init" > dummy.txt
git add dummy.txt && git commit -q -m "init"

PASS=0
FAIL=0

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
  $HARNESS init-loop --dir .harness --plan .harness/plan.md >/dev/null 2>/dev/null
  $HARNESS next-tick --dir .harness >/dev/null 2>/dev/null
}

# ═══════════════════════════════════════════════════════════════
echo "=== TEST GROUP 1: init-loop ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 1.1: Basic init with verify/eval ---"
rm -rf .harness && mkdir -p .harness
cat > .harness/plan.md << 'PLAN'
## Feature 1
- F1.1: implement-backend — Build auth
  - verify: npm test -- --grep "auth"
  - eval: No plaintext passwords
- F1.2: review-backend — Review auth
  - eval: Check SQL injection
- F1.3: fix-backend — Fix findings
  - verify: npm test still passes
PLAN
OUT=$($HARNESS init-loop --dir .harness --plan .harness/plan.md 2>/dev/null)
assert_field_eq "init succeeds" "$OUT" "initialized" "true"
assert_field_eq "3 units" "$OUT" "total_units" "3"
assert_output_contains "external_validators in output" "$OUT" "external_validators"

echo ""
echo "--- 1.2: Init warns on missing verify/eval ---"
rm -rf .harness && mkdir -p .harness
cat > .harness/plan.md << 'PLAN'
- F1.1: implement-backend — Build stuff
- F1.2: review-backend — Review stuff
- F1.3: fix-backend — Fix stuff
PLAN
OUT=$($HARNESS init-loop --dir .harness --plan .harness/plan.md 2>/dev/null)
assert_output_contains "warns missing verify" "$OUT" "have no verify"
assert_output_contains "warns missing eval" "$OUT" "have no eval"

echo ""
echo "--- 1.3: Init rejects plan without review after implement ---"
rm -rf .harness && mkdir -p .harness
cat > .harness/plan.md << 'PLAN'
- F1.1: implement-a — Build A
- F1.2: implement-b — Build B
PLAN
OUT=$($HARNESS init-loop --dir .harness --plan .harness/plan.md 2>/dev/null)
assert_field_eq "rejects bad structure" "$OUT" "initialized" "false"
assert_output_contains "explains missing review" "$OUT" "without a review unit"

echo ""
echo "--- 1.4: Init detects active loop ---"
rm -rf .harness && mkdir -p .harness
cat > .harness/plan.md << 'PLAN'
- F1.1: implement-a — Build
- F1.2: review-a — Review
PLAN
$HARNESS init-loop --dir .harness --plan .harness/plan.md >/dev/null 2>/dev/null
OUT=$($HARNESS init-loop --dir .harness --plan .harness/plan.md 2>/dev/null)
assert_field_eq "rejects double init" "$OUT" "initialized" "false"
assert_output_contains "explains active loop" "$OUT" "already exists"

echo ""
echo "--- 1.5: Write nonce in state ---"
rm -rf .harness && mkdir -p .harness
cat > .harness/plan.md << 'PLAN'
- F1.1: implement-a — Build
- F1.2: review-a — Review
PLAN
$HARNESS init-loop --dir .harness --plan .harness/plan.md >/dev/null 2>/dev/null
NONCE=$(python3 -c "import json; d=json.load(open('.harness/loop-state.json')); print(d.get('_write_nonce','MISSING'))")
if [ "$NONCE" != "MISSING" ] && [ ${#NONCE} -eq 16 ]; then
  echo "  ✅ write nonce present (16 hex chars)"
  PASS=$((PASS + 1))
else
  echo "  ❌ write nonce missing or wrong: '$NONCE'"
  FAIL=$((FAIL + 1))
fi

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 2: complete-tick ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 2.1: Reject complete-tick with no artifacts for implement ---"
setup_loop
OUT=$($HARNESS complete-tick --dir .harness --unit F1.1 --status completed 2>/dev/null)
assert_output_contains "has errors" "$OUT" "errors"
assert_output_contains "explains missing artifacts" "$OUT" "no artifacts"

echo ""
echo "--- 2.2: Reject tampered state (bad writer sig) ---"
setup_loop
python3 -c "
import json
d = json.load(open('.harness/loop-state.json'))
d['_written_by'] = 'hacker'
json.dump(d, open('.harness/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS complete-tick --dir .harness --unit F1.1 --status completed --artifacts dummy.txt 2>/dev/null)
assert_output_contains "detects bad writer" "$OUT" "not written by opc-harness"

echo ""
echo "--- 2.3: Reject wrong unit ---"
setup_loop
OUT=$($HARNESS complete-tick --dir .harness --unit F1.2 --status completed --artifacts dummy.txt 2>/dev/null)
assert_output_contains "explains expected unit" "$OUT" "expected unit"

echo ""
echo "--- 2.4: Reject modified plan ---"
setup_loop
echo "# tampered" >> .harness/plan.md
OUT=$($HARNESS complete-tick --dir .harness --unit F1.1 --status completed --artifacts dummy.txt 2>/dev/null)
assert_output_contains "explains plan change" "$OUT" "plan.md was modified"

echo ""
echo "--- 2.5: Accept blocked with description ---"
setup_loop
OUT=$($HARNESS complete-tick --dir .harness --unit F1.1 --status blocked --description "waiting for API key" 2>/dev/null)
assert_field_eq "accepts blocked with description" "$OUT" "completed" "true"

echo ""
echo "--- 2.6: Reject blocked without description ---"
setup_loop
OUT=$($HARNESS complete-tick --dir .harness --unit F1.1 --status blocked 2>/dev/null)
assert_output_contains "requires description" "$OUT" "description"

echo ""
echo "--- 2.7: Accept completed implement with commit + artifact ---"
setup_loop
echo '{"tests_run": 5, "passed": 5, "_command": "npm test", "durationMs": 1200}' > test-result.json
echo "feature code" > feature.js
git add feature.js test-result.json && git commit -q -m "add feature"
OUT=$($HARNESS complete-tick --dir .harness --unit F1.1 --status completed --artifacts test-result.json 2>/dev/null)
assert_field_eq "accepts valid implement" "$OUT" "completed" "true"

echo ""
echo "--- 2.8: Reject implement without git commit ---"
setup_loop
echo '{"tests_run": 5, "passed": 5, "_command": "npm test"}' > test-result2.json
OUT=$($HARNESS complete-tick --dir .harness --unit F1.1 --status completed --artifacts test-result2.json 2>/dev/null)
assert_output_contains "explains HEAD unchanged" "$OUT" "git HEAD unchanged"

echo ""
echo "--- 2.9: Reject artifact with durationMs=0 ---"
setup_loop
echo '{"tests_run": 5, "passed": 5, "_command": "npm test", "durationMs": 0}' > bad-artifact.json
echo "code" > f.js && git add f.js bad-artifact.json && git commit -q -m "feat"
OUT=$($HARNESS complete-tick --dir .harness --unit F1.1 --status completed --artifacts bad-artifact.json 2>/dev/null)
assert_output_contains "explains zero duration" "$OUT" "durationMs"

# ═══════════════════════════════════════════════════════════════
echo ""
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
$HARNESS init-loop --dir .harness --plan .harness/plan.md >/dev/null 2>/dev/null
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
$HARNESS init-loop --dir .harness --plan .harness/plan.md >/dev/null 2>/dev/null
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
OUT=$($HARNESS init-loop --dir .harness --plan .harness/plan.md 2>/dev/null)
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
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

if [ $FAIL -gt 0 ]; then
  exit 1
fi
