#!/bin/bash
# Tests for reinit-loop: decompose stalled units into sub-units
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

# Helper: create a loop and stall it on a unit
setup_stalled_loop() {
  rm -rf .harness
  mkdir -p .harness
  cat > .harness/plan.md << 'PLAN'
- F1.1: implement-backend — Build auth
  - verify: npm test
- F1.2: review-backend — Review auth
  - eval: Check quality
- F1.3: fix-backend — Fix findings
  - verify: npm test
PLAN
  $HARNESS init-loop --skip-scope --dir .harness --plan .harness/plan.md >/dev/null 2>/dev/null
  # Manually set state to stalled (simulating 3 consecutive failures on F1.1)
  python3 -c "
import json
d = json.load(open('.harness/loop-state.json'))
d['status'] = 'stalled'
d['tick'] = 3
d['unit'] = 'F1.1'
d['next_unit'] = 'F1.1'
d['_tick_history'] = [
  {'unit': 'F1.1', 'tick': 1, 'status': 'failed'},
  {'unit': 'F1.1', 'tick': 2, 'status': 'failed'},
  {'unit': 'F1.1', 'tick': 3, 'status': 'failed'},
]
json.dump(d, open('.harness/loop-state.json', 'w'), indent=2)
"
}

# ═══════════════════════════════════════════════════════════════
echo "=== TEST GROUP 1: Basic reinit-loop --skip-scope ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 1.1: Successful decomposition ---"
setup_stalled_loop
OUT=$($HARNESS reinit-loop --skip-scope --dir .harness --unit F1.1 --sub-units "F1.1a: implement-api — Build API layer, F1.1b: implement-ui — Build UI layer, F1.1c: review-fullstack — Review both layers" 2>/dev/null)
assert_field_eq "reinit succeeds" "$OUT" "reinitialized" "true"
assert_field_eq "decomposes correct unit" "$OUT" "decomposed_unit" '"F1.1"'
assert_output_contains "has 3 sub-units" "$OUT" "F1.1a"
assert_output_contains "next_unit is first sub-unit" "$OUT" "F1.1a"

echo ""
echo "--- 1.2: Plan file rewritten correctly ---"
# Continue from 1.1's state
PLAN_CONTENT=$(cat .harness/plan.md)
if echo "$PLAN_CONTENT" | grep -q "F1.1a: implement-api"; then
  echo "  ✅ plan has first sub-unit"
  PASS=$((PASS + 1))
else
  echo "  ❌ plan missing first sub-unit"
  FAIL=$((FAIL + 1))
fi
if echo "$PLAN_CONTENT" | grep -q "F1.1b: implement-ui"; then
  echo "  ✅ plan has second sub-unit"
  PASS=$((PASS + 1))
else
  echo "  ❌ plan missing second sub-unit"
  FAIL=$((FAIL + 1))
fi
# Original F1.1 should be gone
if echo "$PLAN_CONTENT" | grep -q "^- F1.1: implement-backend"; then
  echo "  ❌ original F1.1 still in plan"
  FAIL=$((FAIL + 1))
else
  echo "  ✅ original F1.1 replaced"
  PASS=$((PASS + 1))
fi
# F1.2 and F1.3 should still be there
if echo "$PLAN_CONTENT" | grep -q "F1.2: review-backend"; then
  echo "  ✅ F1.2 preserved"
  PASS=$((PASS + 1))
else
  echo "  ❌ F1.2 missing from rewritten plan"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 1.3: State updated correctly ---"
STATE_STATUS=$(python3 -c "import json; d=json.load(open('.harness/loop-state.json')); print(d['status'])")
STATE_NEXT=$(python3 -c "import json; d=json.load(open('.harness/loop-state.json')); print(d['next_unit'])")
if [ "$STATE_STATUS" = "initialized" ]; then
  echo "  ✅ status reset to initialized"
  PASS=$((PASS + 1))
else
  echo "  ❌ status is '$STATE_STATUS', expected 'initialized'"
  FAIL=$((FAIL + 1))
fi
if [ "$STATE_NEXT" = "F1.1a" ]; then
  echo "  ✅ next_unit points to first sub-unit"
  PASS=$((PASS + 1))
else
  echo "  ❌ next_unit is '$STATE_NEXT', expected 'F1.1a'"
  FAIL=$((FAIL + 1))
fi

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 2: Reinit guards ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 2.1: Reject reinit on non-stalled loop ---"
rm -rf .harness && mkdir -p .harness
cat > .harness/plan.md << 'PLAN'
- F1.1: implement-a — Build
- F1.2: review-a — Review
PLAN
$HARNESS init-loop --skip-scope --dir .harness --plan .harness/plan.md >/dev/null 2>/dev/null
OUT=$($HARNESS reinit-loop --skip-scope --dir .harness --unit F1.1 --sub-units "F1.1a: implement — A, F1.1b: review — B" 2>/dev/null)
assert_field_eq "rejects non-stalled" "$OUT" "reinitialized" "false"
assert_output_contains "explains stall requirement" "$OUT" "stalled"

echo ""
echo "--- 2.2: Reject reinit with unknown unit ---"
setup_stalled_loop
OUT=$($HARNESS reinit-loop --skip-scope --dir .harness --unit NONEXISTENT --sub-units "X.1: implement — A, X.2: review — B" 2>/dev/null)
assert_field_eq "rejects unknown unit" "$OUT" "reinitialized" "false"
assert_output_contains "explains unit not found" "$OUT" "not found"

echo ""
echo "--- 2.3: Reject with <2 sub-units ---"
setup_stalled_loop
OUT=$($HARNESS reinit-loop --skip-scope --dir .harness --unit F1.1 --sub-units "F1.1a: implement — Only one" 2>/dev/null)
assert_field_eq "rejects single sub-unit" "$OUT" "reinitialized" "false"
assert_output_contains "explains minimum" "$OUT" "at least 2"

echo ""
echo "--- 2.4: Reject duplicate sub-unit IDs ---"
setup_stalled_loop
OUT=$($HARNESS reinit-loop --skip-scope --dir .harness --unit F1.1 --sub-units "F1.1a: implement — First, F1.1a: review — Duplicate" 2>/dev/null)
assert_field_eq "rejects duplicate IDs" "$OUT" "reinitialized" "false"
assert_output_contains "explains duplicate" "$OUT" "duplicate"

echo ""
echo "--- 2.5: Reject ID conflict with existing units ---"
setup_stalled_loop
OUT=$($HARNESS reinit-loop --skip-scope --dir .harness --unit F1.1 --sub-units "F1.2: implement — Conflicts with existing, F1.1a: review — OK" 2>/dev/null)
assert_field_eq "rejects conflicting ID" "$OUT" "reinitialized" "false"
assert_output_contains "explains conflict" "$OUT" "conflicts"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 3: Tick history preservation ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 3.1: History preserved after reinit ---"
setup_stalled_loop
$HARNESS reinit-loop --skip-scope --dir .harness --unit F1.1 --sub-units "F1.1a: implement — Part A, F1.1b: review — Part B" >/dev/null 2>/dev/null
HISTORY_LEN=$(python3 -c "import json; d=json.load(open('.harness/loop-state.json')); print(len(d.get('_tick_history',[])))")
# Original 3 failed ticks + 1 reinit marker = 4
if [ "$HISTORY_LEN" = "4" ]; then
  echo "  ✅ tick history has 4 entries (3 original + reinit marker)"
  PASS=$((PASS + 1))
else
  echo "  ❌ tick history has $HISTORY_LEN entries, expected 4"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 3.2: Reinit marker breaks stall detection ---"
# After reinit, next-tick should NOT detect stall because reinit marker is injected
$HARNESS next-tick --dir .harness >/dev/null 2>/dev/null  # advances to in_progress
# Complete F1.1a to test the loop continues
echo "code" > impl.js && git add impl.js && git commit -q -m "impl"
echo '{"tests_run":1,"passed":1,"_command":"test","durationMs":100}' > t.json
OUT=$($HARNESS complete-tick --dir .harness --unit F1.1a --status completed --artifacts t.json 2>/dev/null)
assert_field_eq "tick completes after reinit" "$OUT" "completed" "true"

echo ""
echo "--- 3.3: Reinit marker has correct structure ---"
setup_stalled_loop
$HARNESS reinit-loop --skip-scope --dir .harness --unit F1.1 --sub-units "F1.1a: implement — Part A, F1.1b: review — Part B" >/dev/null 2>/dev/null
MARKER=$(python3 -c "
import json
d = json.load(open('.harness/loop-state.json'))
h = d.get('_tick_history', [])
marker = [e for e in h if e.get('status') == 'reinit']
if marker:
    m = marker[0]
    print(f\"{m.get('unit')}|{m.get('decomposed')}|{','.join(m.get('sub_units',[]))}\")
else:
    print('NONE')
")
if [ "$MARKER" = "__reinit__|F1.1|F1.1a,F1.1b" ]; then
  echo "  ✅ reinit marker has correct structure"
  PASS=$((PASS + 1))
else
  echo "  ❌ reinit marker: '$MARKER'"
  FAIL=$((FAIL + 1))
fi

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 4: Max tick budget recalculation ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 4.1: Budget accounts for consumed ticks ---"
setup_stalled_loop
$HARNESS reinit-loop --skip-scope --dir .harness --unit F1.1 --sub-units "F1.1a: implement — A, F1.1b: review — B" >/dev/null 2>/dev/null
# After reinit: tick=3 (consumed), new plan has 4 units (F1.1a, F1.1b, F1.2, F1.3)
# Budget = 3 + 4*3 = 15
MAX_TICKS=$(python3 -c "import json; d=json.load(open('.harness/loop-state.json')); print(d.get('_max_total_ticks','MISSING'))")
if [ "$MAX_TICKS" = "15" ]; then
  echo "  ✅ budget = consumed(3) + new_units(4) * 3 = 15"
  PASS=$((PASS + 1))
else
  echo "  ❌ max_total_ticks is $MAX_TICKS, expected 15"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 4.2: Plan hash updated ---"
OLD_HASH=$(python3 -c "import json; print('none')")
setup_stalled_loop
OLD_HASH=$(python3 -c "import json; d=json.load(open('.harness/loop-state.json')); print(d.get('_plan_hash',''))")
$HARNESS reinit-loop --skip-scope --dir .harness --unit F1.1 --sub-units "F1.1a: implement — A, F1.1b: review — B" >/dev/null 2>/dev/null
NEW_HASH=$(python3 -c "import json; d=json.load(open('.harness/loop-state.json')); print(d.get('_plan_hash',''))")
if [ "$OLD_HASH" != "$NEW_HASH" ] && [ -n "$NEW_HASH" ]; then
  echo "  ✅ plan hash updated after reinit"
  PASS=$((PASS + 1))
else
  echo "  ❌ plan hash not updated: old=$OLD_HASH new=$NEW_HASH"
  FAIL=$((FAIL + 1))
fi

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 5: Sub-unit format parsing ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 5.1: Reject malformed sub-unit format ---"
setup_stalled_loop
OUT=$($HARNESS reinit-loop --skip-scope --dir .harness --unit F1.1 --sub-units "this is not a valid format, also bad" 2>/dev/null)
assert_field_eq "rejects malformed" "$OUT" "reinitialized" "false"
assert_output_contains "explains parse error" "$OUT" "cannot parse"

echo ""
echo "--- 5.2: Accept em-dash separator ---"
setup_stalled_loop
OUT=$($HARNESS reinit-loop --skip-scope --dir .harness --unit F1.1 --sub-units "F1.1a: implement — Build API, F1.1b: review — Check API" 2>/dev/null)
assert_field_eq "accepts em-dash" "$OUT" "reinitialized" "true"

echo ""
echo "--- 5.3: Accept en-dash separator ---"
setup_stalled_loop
OUT=$($HARNESS reinit-loop --skip-scope --dir .harness --unit F1.1 --sub-units "F1.1a: implement – Build API, F1.1b: review – Check API" 2>/dev/null)
assert_field_eq "accepts en-dash" "$OUT" "reinitialized" "true"

echo ""
echo "--- 5.4: Accept hyphen separator ---"
setup_stalled_loop
OUT=$($HARNESS reinit-loop --skip-scope --dir .harness --unit F1.1 --sub-units "F1.1a: implement - Build API, F1.1b: review - Check API" 2>/dev/null)
assert_field_eq "accepts hyphen" "$OUT" "reinitialized" "true"

# ═══════════════════════════════════════════════════════════════
print_results
