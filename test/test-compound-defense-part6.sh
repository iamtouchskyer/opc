#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

mkdir -p .harness/nodes/code-review/run_1

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

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 10: D3 — Iteration escalation ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 10.1: --iteration 2 + thinEvalWarnings → FAIL ---"
rm -f .harness/nodes/code-review/run_1/eval-*.md
{
  echo "# Short"
  echo ""
  echo "🔵 issue — bad"
  echo "→ fix"
  echo ""
  echo "VERDICT: PASS FINDINGS[1]"
} > .harness/nodes/code-review/run_1/eval-thin.md

OUT=$($HARNESS synthesize .harness --node code-review --iteration 2 2>/dev/null)
assert_field_eq "iteration 2 escalates to FAIL" "$OUT" "verdict" '"FAIL"'
assert_contains "escalation reason" "$OUT" "persist after 2 iterations"

echo ""
echo "--- 10.2: --iteration 1 + D2 triggers → FAIL (enforce default) ---"
OUT=$($HARNESS synthesize .harness --node code-review --iteration 1 2>/dev/null)
assert_field_eq "iteration 1 FAIL (D2 enforce)" "$OUT" "verdict" '"FAIL"'

echo ""
echo "--- 10.3: --iteration 2 but clean eval → no escalation ---"
rm -f .harness/nodes/code-review/run_1/eval-*.md
cat > .harness/nodes/code-review/run_1/eval-clean.md <<'EVALEOF'
# Thorough Code Review

## Architecture
Well-structured MVC pattern throughout the codebase.
Clean module boundaries with explicit exports.
Dependency injection is used consistently across services.

## Findings

🔵 src/main.ts:10 — Import ordering inconsistent with project convention
→ Group external imports before internal ones, alphabetize within groups
Reasoning: Following the project's established convention seen in other files.

🔵 src/utils.ts:25 — Unused helper function formatDate is dead code
→ Remove formatDate — not called anywhere in codebase
Reasoning: Dead code increases maintenance burden.

🟡 src/auth.ts:42 — Token refresh window is too narrow at 30 seconds
→ Increase refresh window to 300s to prevent auth races
Reasoning: Users with slow connections may lose their session.

🔵 src/db.ts:88 — Connection pool size is hardcoded to 10
→ Move to DATABASE_POOL_SIZE environment variable with default 10
Reasoning: Production environments with higher traffic need larger pools.

## Security
No SQL injection vectors found in database query layer.
Authentication middleware properly validates JWT tokens on protected routes.
CORS is configured to allow only approved origins.
Input sanitization covers all user-facing endpoints.

## Performance
Database queries use proper indexing on frequently queried columns.
No N+1 query patterns detected in the ORM usage throughout.
Response caching is applied to read-heavy endpoints.
Bundle splitting is configured for optimal code loading.

## Error Handling
All async route handlers have try-catch blocks.
Error responses include proper HTTP status codes.
Validation errors distinguished from server errors.

## Testing
Unit test coverage at 85% for core business logic.
Integration tests cover the four critical user flows.
E2E tests verify login-to-checkout journey.

## Summary
Found 4 issues: 1 warning, 3 suggestions.
Code quality is strong. Auth issue should be fixed before release.
Overall patterns are consistent and well-maintained.

VERDICT: ITERATE FINDINGS[4]
EVALEOF

OUT=$($HARNESS synthesize .harness --node code-review --iteration 2 2>/dev/null)
assert_not_contains "no escalation for clean eval" "$OUT" "persist after"


print_results
