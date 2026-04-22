#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else json.dumps(v))" 2>/dev/null
}

jq_nested() {
  echo "$1" | python3 -c "
import sys, json
d = json.load(sys.stdin)
keys = '$2'.split('.')
for k in keys:
    if d is None: break
    d = d.get(k) if isinstance(d, dict) else None
print('__NULL__' if d is None else json.dumps(d))
" 2>/dev/null
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

assert_not_contains() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -q "$pattern"; then
    echo "  ❌ $desc — pattern '$pattern' found (should not be)"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

assert_gate_triggered() {
  local desc="$1" json="$2" expected_mode="$3"
  local triggered mode
  triggered=$(jq_nested "$json" "evalQualityGate.triggered")
  mode=$(jq_nested "$json" "evalQualityGate.mode")
  if [ "$triggered" = "true" ] && [ "$mode" = "\"$expected_mode\"" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — triggered=$triggered mode=$mode (expected true/$expected_mode)"
    FAIL=$((FAIL + 1))
  fi
}

assert_gate_not_triggered() {
  local desc="$1" json="$2"
  local val
  val=$(jq_field "$json" "evalQualityGate")
  if [ "$val" = "__NULL__" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — evalQualityGate should be absent, got $val"
    FAIL=$((FAIL + 1))
  fi
}

# Helper: set up harness dir with a review node
setup_review_node() {
  rm -rf .harness
  mkdir -p .harness/nodes/code-review/run_1
  cat > .harness/flow-state.json << 'EOF'
{"currentNode":"code-review","history":[{"node":"code-review","run":1}],"edgeCounts":{},"stepCount":1}
EOF
}

echo ""
echo "--- Profile 16: D3 iteration escalation (iteration 1 = no escalation) ---"
setup_review_node
# Use a 50+ line eval to avoid thinEval warning affecting verdict
{
  echo "# Review"
  echo ""
  echo "## Architecture"
  echo ""
  echo "🔵 src/main.ts:10 — Minor style issue"
  echo ""
  echo "Reasoning: Inconsistent naming convention."
  echo "→ Rename to camelCase."
  echo ""
  echo "## Security"
  echo ""
  echo "🔵 src/auth.ts:20 — Consider adding rate limit"
  echo ""
  echo "Reasoning: No rate limiting on endpoint."
  echo "→ Add express-rate-limit."
  echo ""
  echo "## Performance"
  echo ""
  echo "🔵 src/db.ts:30 — Index recommended"
  echo ""
  echo "Reasoning: Query without index on lookup column."
  echo "→ Add database index."
  echo ""
  echo "## Testing"
  echo ""
  echo "🔵 src/test.ts:1 — Missing edge case test"
  echo ""
  echo "Reasoning: No test for empty input."
  echo "→ Add test for empty string."
  echo ""
  echo "## Documentation"
  echo ""
  echo "🔵 src/api.ts:5 — Missing JSDoc"
  echo ""
  echo "Reasoning: Public function undocumented."
  echo "→ Add JSDoc with @param."
  echo ""
  echo "## Summary"
  echo ""
  echo "5 suggestions. All minor improvements."
  for i in $(seq 1 15); do
    echo "Additional analysis point $i covering various code quality aspects."
  done
} > .harness/nodes/code-review/run_1/eval-clean50.md

OUT=$($HARNESS synthesize .harness --node code-review --iteration 1)
assert_field_eq "iteration 1: PASS (no thin, no warnings)" "$OUT" "verdict" '"PASS"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 17: D3 iteration escalation (iteration 2 + thin = FAIL) ---"
# Create a thin eval so thinEvalWarnings fires, then --iteration 2 escalates
setup_review_node
{
  echo "# Review"
  echo "🔵 Issue"
  for i in $(seq 1 15); do echo "Short line $i."; done
} > .harness/nodes/code-review/run_1/eval-thin17.md
OUT=$($HARNESS synthesize .harness --node code-review --iteration 2)
# thinEvalWarnings should exist for this thin eval
assert_contains "iteration 2: check for thin warnings or escalation" "$OUT" "FAIL\|thinEval"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 18: D3 iteration 3 + thin eval = FAIL ---"
# Reuse same thin eval from 17
OUT=$($HARNESS synthesize .harness --node code-review --iteration 3)
assert_contains "iteration 3: escalation" "$OUT" "FAIL\|thinEval"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 19: Clean 50+ line eval + iteration 2 = no escalation ---"
setup_review_node
{
  echo "# Thorough Review"
  echo ""
  echo "## Architecture"
  echo ""
  echo "🔵 src/handler.ts:15 — Missing rate limiter"
  echo ""
  echo "Reasoning: Endpoint has no rate limiting, vulnerable to abuse."
  echo "→ Add express-rate-limit with 100 req/min."
  echo ""
  echo "## Security"
  echo ""
  echo "🔵 src/auth.ts:22 — Weak password policy"
  echo ""
  echo "Reasoning: No minimum length or complexity requirement."
  echo "→ Enforce 12+ chars, 1 uppercase, 1 number."
  echo ""
  echo "## Performance"
  echo ""
  echo "🔵 src/db.ts:45 — Unindexed query"
  echo ""
  echo "Reasoning: Full table scan on user lookup."
  echo "→ Add index on email column."
  echo ""
  echo "## Error Handling"
  echo ""
  echo "🔵 src/error.ts:10 — Generic error response"
  echo ""
  echo "Reasoning: All errors return 500 with same message."
  echo "→ Map error types to appropriate HTTP status codes."
  echo ""
  echo "## Documentation"
  echo ""
  echo "🔵 src/api.ts:5 — Missing endpoint docs"
  echo ""
  echo "Reasoning: No OpenAPI spec for public endpoints."
  echo "→ Add swagger decorators."
  echo ""
  echo "## Code Quality"
  echo ""
  echo "🔵 src/utils.ts:88 — Dead code in utility module"
  echo ""
  echo "Reasoning: Function exportToCSV is never imported anywhere."
  echo "→ Remove or mark as TODO if planned for future use."
  echo ""
  echo "## Summary"
  echo ""
  echo "6 suggestions. All low severity hardening items. Code is production-ready."
  echo "Architecture is clean with proper separation of concerns."
  echo "No security vulnerabilities detected beyond hardening opportunities."
} > .harness/nodes/code-review/run_1/eval-clean.md

OUT=$($HARNESS synthesize .harness --node code-review --iteration 2)
assert_field_eq "clean + iteration 2: PASS" "$OUT" "verdict" '"PASS"'
assert_gate_not_triggered "clean + iteration 2: no gate" "$OUT"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 20: D1 --base warning ---"
setup_review_node
cat > .harness/nodes/code-review/run_1/eval-refs.md << 'EVALEOF'
# Review

## Finding

🔵 src/main.ts:10 — Issue

**Reasoning:** Problem exists.

**Fix:** Fix it.

## Summary

1 finding with file ref.
EVALEOF

STDERR=$($HARNESS synthesize .harness --node code-review 2>&1 >/dev/null || true)
assert_contains "D1 warning: stderr mentions --base" "$STDERR" "base\|file.*ref\|validation"

# ───────────────────────────────────────────────────────────────

print_results
