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

# ═══════════════════════════════════════════════════════════════
echo "=== D2 CALIBRATION: 25 Synthetic Eval Profiles ==="
echo ""
echo "--- Profile 1: Perfect eval (all layers clean) ---"
# ═══════════════════════════════════════════════════════════════

setup_review_node
cat > .harness/nodes/code-review/run_1/eval-senior.md << 'EVALEOF'
# Comprehensive Code Review

## Architecture Analysis

🔵 src/auth/handler.ts:15 — Missing rate limiter on login endpoint

**Reasoning:** Without rate limiting, brute-force attacks can enumerate credentials.

**Fix:** Add express-rate-limit middleware with 5 attempts per 15 minutes.

## Security Review

🔵 src/db/queries.ts:42 — SQL query uses string concatenation

**Reasoning:** Direct string interpolation in SQL enables injection attacks.

**Fix:** Replace with parameterized queries using `$1, $2` placeholders.

## Performance

🟡 src/api/users.ts:88 — N+1 query pattern in user listing

**Reasoning:** Each user triggers a separate profile fetch, causing O(n) queries.

**Fix:** Use a single JOIN or batch query with `WHERE id IN (...)`.

## Error Handling

🔵 src/middleware/error.ts:12 — Stack traces exposed in production error responses

**Reasoning:** Stack traces reveal internal paths and framework versions.

**Fix:** Conditionally strip stack in production via `NODE_ENV` check.

## Summary

4 findings (1 warning, 3 suggestions). Auth rate limiting and SQL injection are the priority items.
EVALEOF

OUT=$($HARNESS synthesize .harness --node code-review)
assert_gate_not_triggered "clean eval: no gate trigger" "$OUT"
assert_field_eq "clean eval: verdict ITERATE (has warning)" "$OUT" "verdict" '"ITERATE"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 2: Thin eval only (1 layer) ---"
setup_review_node
cat > .harness/nodes/code-review/run_1/eval-lazy.md << 'EVALEOF'
# Review

🔵 src/main.ts:10 — Looks good

Reasoning: It's fine.
Fix: Nothing needed.
EVALEOF

OUT=$($HARNESS synthesize .harness --node code-review)
assert_gate_not_triggered "thin-only: below threshold (1 layer)" "$OUT"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 3: Thin + noCodeRefs (2 layers) ---"
setup_review_node
cat > .harness/nodes/code-review/run_1/eval-weak.md << 'EVALEOF'
# Review

🔵 Something wrong with the code
🔵 Another issue somewhere

Reasoning: Various issues found.
Fix: Fix them.
EVALEOF

OUT=$($HARNESS synthesize .harness --node code-review)
assert_gate_not_triggered "2 layers: below threshold" "$OUT"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 4: Thin + noCodeRefs + singleHeading (3 layers) → triggers ---"
setup_review_node
# 50+ lines with single heading, no file:line refs, findings present
{
  echo "# Only One Heading"
  echo ""
  echo "🔵 Something is wrong with the code"
  echo "🔵 Another problem here"
  echo ""
  for i in $(seq 1 48); do
    echo "This is filler line $i to make the eval long enough."
  done
} > .harness/nodes/code-review/run_1/eval-padded.md

OUT=$($HARNESS synthesize .harness --node code-review)
assert_gate_triggered "3 layers: enforce trigger" "$OUT" "enforce"
assert_field_eq "3 layers: verdict FAIL (enforce default)" "$OUT" "verdict" '"FAIL"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 5: Same as 4 with --no-strict → shadow mode ---"
OUT=$($HARNESS synthesize .harness --node code-review --no-strict)
assert_gate_triggered "3 layers no-strict: shadow" "$OUT" "shadow"
assert_field_eq "3 layers no-strict: verdict ITERATE (shadow)" "$OUT" "verdict" '"ITERATE"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 6: Copy-paste padding (lowUniqueContent + singleHeading + thin) ---"
setup_review_node
{
  echo "# Review"
  echo ""
  echo "🔵 Issue found"
  echo ""
  for i in $(seq 1 50); do
    echo "The code needs improvement in various areas."
  done
} > .harness/nodes/code-review/run_1/eval-copypaste.md

OUT=$($HARNESS synthesize .harness --node code-review)
assert_gate_triggered "copypaste: triggers enforce" "$OUT" "enforce"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 7: Fabricated file refs (invalidRefCount × 2 weight) ---"
setup_review_node
mkdir -p /tmp/opc-d2-cal-base/src
echo "real content" > /tmp/opc-d2-cal-base/src/real.ts
cat > .harness/nodes/code-review/run_1/eval-fabricated.md << 'EVALEOF'
# Code Review

## Security

🔵 src/nonexistent.ts:999 — Missing validation

## Performance

🔵 src/also-fake.ts:42 — Slow query

## Architecture

🔵 src/real.ts:1 — Good structure

## Testing

🔵 src/ghost-file.ts:100 — No tests

## Summary

4 findings reviewed across security, performance, architecture, and testing.
Code quality needs improvement in multiple areas.
The application has several security concerns that need addressing.
Performance bottlenecks identified in database layer.
Test coverage is insufficient for critical paths.
Architecture is reasonable but needs refinement.
Recommended follow-up review after fixes are applied.
Additional static analysis tools should be integrated.
Consider implementing automated security scanning.
Database query optimization should be prioritized.
End of review.
EVALEOF

OUT=$($HARNESS synthesize .harness --node code-review --base /tmp/opc-d2-cal-base)
# 3 fabricated refs → invalidRefCount = 3 → +2 weight = contribution of 2
# Plus possibly other layers
assert_gate_triggered "fabricated refs: triggers enforce" "$OUT" "enforce"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 8: Missing reasoning on all findings ---"
setup_review_node
{
  echo "# Code Review"
  echo ""
  echo "## Security"
  echo "🔵 src/auth.ts:10 — No rate limiting"
  echo ""
  echo "## Performance"
  echo "🔵 src/db.ts:20 — Slow query"
  echo ""
  echo "## Errors"
  echo "🔵 src/error.ts:30 — Stack trace leak"
  echo ""
  echo "## Summary"
  echo "Three findings."
  for i in $(seq 1 30); do
    echo "Additional analysis line $i covers various aspects of the codebase quality and structure."
  done
} > .harness/nodes/code-review/run_1/eval-noreasoning.md

OUT=$($HARNESS synthesize .harness --node code-review)
# missingReasoningTripped + missingFixTripped + possibly others
assert_contains "missing reasoning: triggers some layers" "$OUT" "evalQualityGate\|missingReasoning\|thinEval"

# ───────────────────────────────────────────────────────────────

print_results
