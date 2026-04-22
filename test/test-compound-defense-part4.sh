#!/bin/bash
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
echo "=== TEST GROUP 5: Compound stacking — multiple triggers ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 5.1: Eval that triggers ALL compound defenses → multiple warnings ---"
mkdir -p .harness/nodes/code-review/run_1
rm -f .harness/nodes/code-review/run_1/eval-*.md
{
  echo "# Only Heading"
  echo ""
  echo "🔵 Something is wrong — no real finding"
  echo ""
  # Lots of identical padding (kills unique ratio + single heading)
  for i in $(seq 1 55); do
    echo "This is a padding line that should not count."
  done
  echo ""
  echo "VERDICT: PASS FINDINGS[1]"
} > .harness/nodes/code-review/run_1/eval-garbage.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
# Should trigger: lowUniqueContent + singleHeading + noCodeRefs + findingDensityLow
assert_contains "triggers low unique content" "$OUT" "low unique content"
assert_contains "triggers single heading" "$OUT" "heading"
assert_contains "triggers no code refs" "$OUT" "0 file:line references"
assert_contains "triggers finding density" "$OUT" "finding density"
assert_field_eq "verdict FAIL (D2 enforce default)" "$OUT" "verdict" '"FAIL"'

# Count total warnings — should be at least 4 from compound layers
WARN_COUNT=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['totals']['warning'])" 2>/dev/null)
if [ "$WARN_COUNT" -ge 4 ]; then
  echo "  ✅ stacked warnings count ≥ 4 (got $WARN_COUNT)"
  PASS=$((PASS + 1))
else
  echo "  ❌ stacked warnings count < 4 (got $WARN_COUNT)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 5.2: Clean eval triggers NONE of the compound defenses ---"
cat > .harness/nodes/code-review/run_1/eval-clean.md <<'EVALEOF'
# Thorough Code Review

## Architecture Analysis
The codebase follows a well-structured MVC pattern.
Dependency injection is used consistently.
Module boundaries are clearly defined with explicit exports.

## Security Assessment
No SQL injection vectors found in database queries.
Authentication middleware properly validates JWT tokens.
CORS is configured to allow only approved origins.
Input sanitization covers all user-facing endpoints.

## Findings

🔵 src/main.ts:10 — Import ordering inconsistent with project convention
→ Group external imports before internal ones, alphabetize within groups
Reasoning: Following the project's established convention seen in other files.

🔵 src/utils.ts:25 — Unused helper function `formatDate` is dead code
→ Remove `formatDate` — it's not called anywhere in the codebase
Reasoning: Dead code increases maintenance burden and confuses new developers.

🟡 src/auth.ts:42 — Token refresh window is too narrow (30s)
→ Increase refresh window to 300s to prevent auth races
Reasoning: Users with slow connections may lose their session during the refresh gap.

🔵 src/db.ts:88 — Connection pool size hardcoded to 10
→ Move to DATABASE_POOL_SIZE environment variable with default 10
Reasoning: Production environments with higher traffic need larger pool sizes.

## Performance Review
Database queries use proper indexing on frequently queried columns.
No N+1 query patterns detected in the ORM usage.
Response caching is applied to read-heavy endpoints.
Bundle splitting is configured for optimal loading.

## Testing Assessment
Unit test coverage is 85% for core business logic modules.
Integration tests cover the four critical user flows.
E2E tests verify the login-to-checkout journey end-to-end.
Edge cases for concurrent operations need additional coverage.

## Summary
Found 4 issues: 1 warning (auth token refresh), 3 suggestions.
Overall code quality is strong. The auth issue should be addressed
before the next release to prevent user session drops.

VERDICT: ITERATE FINDINGS[4]
EVALEOF
rm -f .harness/nodes/code-review/run_1/eval-garbage.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_not_contains "no low unique content" "$OUT" "low unique content"
assert_not_contains "no single heading" "$OUT" "heading.*multiple sections"
assert_not_contains "no finding density" "$OUT" "finding density"
assert_not_contains "no code refs warning" "$OUT" "0 file:line references"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 6: Missing reasoning / fix detection ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 6.1: Findings without reasoning → warning ---"
mkdir -p .harness/nodes/code-review/run_1
rm -f .harness/nodes/code-review/run_1/eval-*.md
cat > .harness/nodes/code-review/run_1/eval-noreason.md <<'EVALEOF'
# Code Review

## Architecture
Clean modular structure with proper layering.
Services abstract business logic from handlers.

## Findings

🔵 src/main.ts:10 — Import ordering inconsistent
→ Group external imports before internal ones

🔵 src/utils.ts:25 — Unused helper function
→ Remove dead code

🟡 src/auth.ts:15 — Token expiry not validated

## Security
No SQL injection. Auth middleware applied.
CORS configured. Input validated on all endpoints.

## Performance
Queries indexed. No N+1 patterns found.
Bundle size within acceptable limits.

## Error Handling
All async routes have try-catch blocks.
Error responses include proper status codes.

## Testing
Unit test coverage is good for core modules.
Integration tests cover critical user flows.

## Summary
Found 3 issues: 1 warning, 2 suggestions.
Warning on token validation needs immediate fix.
Code follows existing patterns consistently.

VERDICT: ITERATE FINDINGS[3]
EVALEOF

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_contains "missing reasoning detected" "$OUT" "findings lack reasoning"

echo ""
echo "--- 6.2: Findings WITH reasoning → no warning ---"
cat > .harness/nodes/code-review/run_1/eval-reasoned.md <<'EVALEOF'
# Code Review

## Architecture
Clean modular structure with proper layering.
Services abstract business logic from handlers.

## Findings

🔵 src/main.ts:10 — Import ordering inconsistent
→ Group external imports before internal ones
Reasoning: Following the project's established convention.

🔵 src/utils.ts:25 — Unused helper function
→ Remove dead code
Reasoning: Maintenance burden from dead code.

🟡 src/auth.ts:15 — Token expiry not validated
→ Add expiry check in middleware
Reasoning: Security issue allowing expired sessions.

## Security
No SQL injection. Auth middleware applied.
CORS configured. Input validated on all endpoints.

## Performance
Queries indexed. No N+1 patterns found.
Bundle size within acceptable limits.

## Error Handling
All async routes have try-catch blocks.
Error responses include proper status codes.

## Testing
Unit test coverage is good for core modules.
Integration tests cover critical user flows.

## Summary
Found 3 issues: 1 warning, 2 suggestions.
Warning on token validation needs immediate fix.
Code follows existing patterns consistently.

VERDICT: ITERATE FINDINGS[3]
EVALEOF
rm -f .harness/nodes/code-review/run_1/eval-noreason.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_not_contains "no reasoning warning for complete eval" "$OUT" "findings lack reasoning"


print_results
