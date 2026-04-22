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
echo "--- Profile 9: Monotonous line lengths (lineLengthVarianceLow) ---"
setup_review_node
{
  echo "# Code Review Results"
  echo ""
  echo "## Architecture Section"
  echo ""
  echo "🔵 src/main.ts:10 — Issue with code"
  echo ""
  echo "Reasoning: The code has a problem."
  echo ""
  echo "Fix: Update the code to fix it."
  echo ""
  echo "## Security Section Review"
  echo ""
  echo "🔵 src/auth.ts:20 — Auth issue"
  echo ""
  echo "Reasoning: Auth is not working."
  echo ""
  echo "Fix: Fix the auth to work now."
  echo ""
  echo "## Performance Section Ok"
  echo ""
  echo "🔵 src/perf.ts:30 — Slow endpoint"
  echo ""
  echo "Reasoning: Endpoint is very slow."
  echo ""
  echo "Fix: Optimize the slow endpoint."
  echo ""
  for i in $(seq 1 25); do
    echo "Additional review commentary l$i."
  done
} > .harness/nodes/code-review/run_1/eval-monotone.md

OUT=$($HARNESS synthesize .harness --node code-review)
# May or may not trigger gate depending on how many layers fire
# Just verify it runs without error
assert_contains "monotone: synthesize succeeds" "$OUT" "verdict"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 10: Low finding density (huge eval, few findings) ---"
setup_review_node
{
  echo "# Comprehensive Code Review"
  echo ""
  echo "## Introduction"
  echo "This is a very thorough review of the codebase."
  echo ""
  echo "## Architecture"
  for i in $(seq 1 100); do
    echo "The architecture is well-designed with good separation of concerns in module $i."
  done
  echo ""
  echo "## Finding"
  echo "🔵 src/main.ts:1 — Minor issue"
  echo ""
  echo "Reasoning: Small problem."
  echo "Fix: Easy fix."
  echo ""
  echo "## Summary"
  echo "Overall the code is excellent."
} > .harness/nodes/code-review/run_1/eval-density.md

OUT=$($HARNESS synthesize .harness --node code-review)
assert_contains "low density: synthesize succeeds" "$OUT" "verdict"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 11: All 9 layers tripped simultaneously ---"
setup_review_node
{
  echo "# Only Heading"
  echo "🔵 Something wrong"
  for i in $(seq 1 50); do
    echo "Something wrong"
  done
} > .harness/nodes/code-review/run_1/eval-worstcase.md

OUT=$($HARNESS synthesize .harness --node code-review)
assert_gate_triggered "all layers: triggers enforce" "$OUT" "enforce"

OUT=$($HARNESS synthesize .harness --node code-review --no-strict)
assert_gate_triggered "all layers no-strict: shadow" "$OUT" "shadow"
assert_field_eq "all layers no-strict: ITERATE" "$OUT" "verdict" '"ITERATE"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 12: Multiple roles, one bad one good ---"
setup_review_node
# Good eval
cat > .harness/nodes/code-review/run_1/eval-good.md << 'EVALEOF'
# Thorough Review

## Architecture

🔵 src/handler.ts:15 — Missing input validation

**Reasoning:** User input flows directly into business logic without sanitization.

**Fix:** Add zod schema at the handler boundary.

## Performance

🟡 src/queries.ts:42 — Missing index on frequently queried column

**Reasoning:** Full table scan on every request, O(n) degradation.

**Fix:** `CREATE INDEX idx_users_email ON users(email);`

## Error Handling

🔵 src/middleware.ts:8 — Generic catch-all swallows specific errors

**Reasoning:** Makes debugging impossible in production.

**Fix:** Re-throw after logging, or use typed error classes.

## Summary

3 findings. Priority: input validation and query performance.
EVALEOF

# Bad eval
{
  echo "# Review"
  echo "🔵 Looks ok"
  for i in $(seq 1 50); do
    echo "Everything seems fine overall."
  done
} > .harness/nodes/code-review/run_1/eval-bad.md

OUT=$($HARNESS synthesize .harness --node code-review)
assert_gate_triggered "mixed roles: enforce (bad role triggers)" "$OUT" "enforce"
assert_field_eq "mixed roles: verdict FAIL" "$OUT" "verdict" '"FAIL"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 13: Both roles bad + strict ---"
setup_review_node
{
  echo "# Review"
  echo "🔵 Issue"
  for i in $(seq 1 50); do echo "Filler content."; done
} > .harness/nodes/code-review/run_1/eval-role1.md
{
  echo "# Review"
  echo "🔵 Problem"
  for i in $(seq 1 50); do echo "Filler content."; done
} > .harness/nodes/code-review/run_1/eval-role2.md

OUT=$($HARNESS synthesize .harness --node code-review --strict)
assert_gate_triggered "both bad strict: enforce" "$OUT" "enforce"
assert_field_eq "both bad strict: FAIL" "$OUT" "verdict" '"FAIL"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 14: Critical finding overrides D2 gate ---"
setup_review_node
cat > .harness/nodes/code-review/run_1/eval-critical.md << 'EVALEOF'
# Review

## Security

🔴 src/auth.ts:1 — SQL injection vulnerability

**Reasoning:** Direct string concat in query.

**Fix:** Use parameterized queries.

## Summary

1 critical finding.
EVALEOF

OUT=$($HARNESS synthesize .harness --node code-review)
assert_field_eq "critical overrides: FAIL" "$OUT" "verdict" '"FAIL"'
assert_contains "critical overrides: reason mentions critical" "$OUT" "critical"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 15: BLOCKED overrides everything ---"
setup_review_node
cat > .harness/nodes/code-review/run_1/eval-blocked.md << 'EVALEOF'
# Review

VERDICT: BLOCKED — Cannot review, database is down

## Summary

Blocked due to infrastructure.
EVALEOF

OUT=$($HARNESS synthesize .harness --node code-review)
assert_field_eq "blocked overrides: BLOCKED" "$OUT" "verdict" '"BLOCKED"'

# ───────────────────────────────────────────────────────────────

print_results
