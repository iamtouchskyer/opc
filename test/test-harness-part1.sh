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
echo "=== TEST GROUP 1: init-loop --skip-scope ==="
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
OUT=$($HARNESS init-loop --skip-scope --dir .harness --plan .harness/plan.md 2>/dev/null)
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
OUT=$($HARNESS init-loop --skip-scope --dir .harness --plan .harness/plan.md 2>/dev/null)
assert_output_contains "warns missing verify" "$OUT" "have no verify"
assert_output_contains "warns missing eval" "$OUT" "have no eval"

echo ""
echo "--- 1.3: Init rejects plan without review after implement ---"
rm -rf .harness && mkdir -p .harness
cat > .harness/plan.md << 'PLAN'
- F1.1: implement-a — Build A
- F1.2: implement-b — Build B
PLAN
OUT=$($HARNESS init-loop --skip-scope --dir .harness --plan .harness/plan.md 2>/dev/null)
assert_field_eq "rejects bad structure" "$OUT" "initialized" "false"
assert_output_contains "explains missing review" "$OUT" "without a review unit"

echo ""
echo "--- 1.4: Init detects active loop ---"
rm -rf .harness && mkdir -p .harness
cat > .harness/plan.md << 'PLAN'
- F1.1: implement-a — Build
- F1.2: review-a — Review
PLAN
$HARNESS init-loop --skip-scope --dir .harness --plan .harness/plan.md >/dev/null 2>/dev/null
OUT=$($HARNESS init-loop --skip-scope --dir .harness --plan .harness/plan.md 2>/dev/null)
assert_field_eq "rejects double init" "$OUT" "initialized" "false"
assert_output_contains "explains active loop" "$OUT" "already exists"

echo ""
echo "--- 1.5: Write nonce in state ---"
rm -rf .harness && mkdir -p .harness
cat > .harness/plan.md << 'PLAN'
- F1.1: implement-a — Build
- F1.2: review-a — Review
PLAN
$HARNESS init-loop --skip-scope --dir .harness --plan .harness/plan.md >/dev/null 2>/dev/null
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

print_results
