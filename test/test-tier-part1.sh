#!/bin/bash
# test-tier — split part
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

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
echo "=== TEST GROUP 1: init --tier ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 1.1: Init with valid tier ---"
rm -rf .h-tier && OUT=$($HARNESS init --flow build-verify --tier polished --dir .h-tier 2>/dev/null)
assert_field_eq "created" "$OUT" "created" "true"
assert_field_eq "tier in output" "$OUT" "tier" "\"polished\""
TIER=$(python3 -c "import json; print(json.load(open('.h-tier/flow-state.json'))['tier'])")
if [ "$TIER" = "polished" ]; then
  echo "  ✅ tier in state"
  PASS=$((PASS + 1))
else
  echo "  ❌ tier=$TIER"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 1.2: Init with invalid tier ---"
rm -rf .h-tier2 && OUT=$($HARNESS init --flow build-verify --tier banana --dir .h-tier2 2>/dev/null)
assert_field_eq "rejected" "$OUT" "created" "false"
assert_contains "explains invalid" "$OUT" "invalid tier"

echo ""
echo "--- 1.3: Init without tier ---"
rm -rf .h-tier3 && OUT=$($HARNESS init --flow build-verify --dir .h-tier3 2>/dev/null)
assert_field_eq "tier null" "$OUT" "tier" "__NULL__"
TIER=$(python3 -c "import json; print(json.load(open('.h-tier3/flow-state.json')).get('tier'))")
if [ "$TIER" = "None" ]; then
  echo "  ✅ tier null in state"
  PASS=$((PASS + 1))
else
  echo "  ❌ tier=$TIER"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 1.4: All valid tiers ---"
for t in functional polished delightful; do
  rm -rf ".h-$t" && OUT=$($HARNESS init --flow build-verify --tier $t --dir ".h-$t" 2>/dev/null)
  assert_field_eq "init $t" "$OUT" "tier" "\"$t\""
done

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 2: tier-baseline ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 2.1: Functional tier → 0 test cases ---"
OUT=$($HARNESS tier-baseline --tier functional)
assert_field_eq "functional total" "$OUT" "total" "0"

echo ""
echo "--- 2.2: Polished tier → test cases ---"
OUT=$($HARNESS tier-baseline --tier polished)
TOTAL=$(jq_field "$OUT" "total")
if [ "$TOTAL" -gt 0 ] 2>/dev/null; then
  echo "  ✅ polished has $TOTAL test cases"
  PASS=$((PASS + 1))
else
  echo "  ❌ polished total=$TOTAL"
  FAIL=$((FAIL + 1))
fi
assert_contains "has TC-TIER IDs" "$OUT" "TC-TIER"
assert_contains "all P0" "$OUT" "P0"
assert_contains "has steps" "$OUT" "steps"
assert_contains "has expected" "$OUT" "expected"

echo ""
echo "--- 2.3: Delightful tier → more test cases than polished ---"
OUT_D=$($HARNESS tier-baseline --tier delightful)
TOTAL_D=$(echo "$OUT_D" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])")
TOTAL_P=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])")
if [ "$TOTAL_D" -ge "$TOTAL_P" ]; then
  echo "  ✅ delightful ($TOTAL_D) >= polished ($TOTAL_P)"
  PASS=$((PASS + 1))
else
  echo "  ❌ delightful ($TOTAL_D) < polished ($TOTAL_P)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 2.4: Invalid tier ---"
OUT=$($HARNESS tier-baseline --tier banana)
assert_contains "error message" "$OUT" "invalid tier"

echo ""
echo "--- 2.5: Each test case has required fields ---"
OUT=$($HARNESS tier-baseline --tier polished)
VALID=$(echo "$OUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for tc in d['testCases']:
    for field in ['id', 'category', 'priority', 'description', 'steps', 'expected', 'failureImpact', 'baselineKey']:
        if field not in tc:
            print(f'MISSING:{field}')
            sys.exit(0)
print('ALL_PRESENT')
")
if [ "$VALID" = "ALL_PRESENT" ]; then
  echo "  ✅ all test cases have required fields"
  PASS=$((PASS + 1))
else
  echo "  ❌ $VALID"
  FAIL=$((FAIL + 1))
fi



print_results
