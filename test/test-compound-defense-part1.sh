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
echo "=== TEST GROUP 1: Low unique content detection ==="
# ═══════════════════════════════════════════════════════════════

mkdir -p .harness/nodes/code-review/run_1

echo "--- 1.1: Copy-paste padded eval → lowUniqueContent warning ---"
# 60 lines but >40% are duplicated "padding" lines
{
  echo "# Review"
  echo ""
  echo "## Findings"
  echo ""
  echo "🔵 src/main.ts:10 — Minor issue found"
  echo "→ Fix it"
  echo "Reasoning: Style."
  echo ""
  # 50 duplicate lines to bloat past thin eval threshold
  for i in $(seq 1 50); do
    echo "Additional padding for test purposes."
  done
  echo ""
  echo "VERDICT: PASS FINDINGS[1]"
} > .harness/nodes/code-review/run_1/eval-padder.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_contains "low unique content warning" "$OUT" "low unique content"
assert_contains "copy-paste padding" "$OUT" "copy-paste padding"
assert_field_eq "verdict ITERATE" "$OUT" "verdict" '"ITERATE"'

echo ""
echo "--- 1.2: Genuine eval with unique lines → no lowUniqueContent ---"
cat > .harness/nodes/code-review/run_1/eval-genuine.md <<'EVALEOF'
# Thorough Code Review

## Architecture
The codebase follows a clean layered architecture with clear separation of concerns.
Models are well-defined with proper TypeScript types.
Services abstract business logic from route handlers.

## Findings

🔵 src/main.ts:10 — Import ordering inconsistent
→ Group external imports before internal ones
Reasoning: Following the project's established convention in other files.

🔵 src/utils.ts:25 — Unused helper function
→ Remove `formatDate` — it's not called anywhere
Reasoning: Dead code increases maintenance burden.

🔵 src/db.ts:42 — Connection pool size hardcoded
→ Move to environment variable
Reasoning: Production environments may need different pool sizes.

## Security
No SQL injection vectors found. Input validation is proper.
Authentication middleware is correctly applied to protected routes.
CORS settings are appropriately restrictive.

## Performance
Database queries use proper indexing.
No N+1 query patterns detected.
Response caching is applied where appropriate.

## Error Handling
All async routes have try-catch blocks.
Error responses include proper status codes and messages.
Validation errors are distinguished from server errors.

## Testing
Unit test coverage appears adequate for core business logic.
Integration tests cover the critical user flows.
Missing edge case tests for concurrent operations.

## Summary
Overall code quality is good. Three minor suggestions found.
No critical or warning issues detected.
The implementation follows existing patterns well.

VERDICT: PASS FINDINGS[3]
EVALEOF

rm -f .harness/nodes/code-review/run_1/eval-padder.md
OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_not_contains "no copy-paste warning" "$OUT" "low unique content"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 2: Single heading detection ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 2.1: Eval with only 1 heading in 40+ lines → singleHeading warning ---"
{
  echo "# My Review"
  echo ""
  echo "🔵 src/main.ts:10 — Minor issue here"
  echo "→ Fix it properly"
  echo "Reasoning: Important for code quality."
  echo ""
  # Add 35 unique filler lines (no headings)
  echo "The code needs careful attention in several areas."
  echo "First, the error handling could be more robust."
  echo "Second, the logging is insufficient for debugging."
  echo "Third, configuration is scattered across files."
  echo "Fourth, dependency injection is not consistently used."
  echo "Fifth, some variable names are not descriptive enough."
  echo "Sixth, magic numbers appear in business logic."
  echo "Seventh, test data is hardcoded rather than generated."
  echo "Eighth, API versioning is not implemented."
  echo "Ninth, database migrations lack rollback scripts."
  echo "Tenth, no health check endpoint exists."
  echo "Authentication tokens lack expiry validation."
  echo "Rate limiting is not applied to public endpoints."
  echo "Cache invalidation strategy is missing."
  echo "Websocket connections have no heartbeat."
  echo "File uploads lack size validation."
  echo "Background jobs have no retry mechanism."
  echo "Metrics collection is not instrumented."
  echo "Log levels are not properly configured."
  echo "Environment variable validation is missing."
  echo "Docker healthchecks are not defined."
  echo "CI pipeline does not run security scans."
  echo "Dependency versions are not pinned."
  echo "No changelog is maintained."
  echo "API documentation is outdated."
  echo "Frontend bundle size is not monitored."
  echo "Service worker caching is not configured."
  echo "Content Security Policy headers are missing."
  echo "HSTS is not enabled."
  echo "Subresource integrity is not used for CDN assets."
  echo ""
  echo "VERDICT: PASS FINDINGS[1]"
} > .harness/nodes/code-review/run_1/eval-monohead.md
rm -f .harness/nodes/code-review/run_1/eval-genuine.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_contains "single heading warning" "$OUT" "heading"
assert_contains "multiple sections" "$OUT" "multiple sections"
assert_field_eq "verdict ITERATE (single heading)" "$OUT" "verdict" '"ITERATE"'

echo ""
echo "--- 2.2: Eval with 3+ headings → no singleHeading warning ---"
cat > .harness/nodes/code-review/run_1/eval-multihead.md <<'EVALEOF'
# Code Review

## Architecture
Clean separation of concerns. Models well-typed.

## Findings

🔵 src/main.ts:10 — Import ordering inconsistent
→ Group external imports before internal ones
Reasoning: Established convention.

## Security
No injection vectors. Auth middleware properly applied.
CORS appropriately restrictive. CSP headers present.

## Performance
Queries use proper indexing. No N+1 patterns.
Response caching applied where appropriate.

## Summary
Minor issues only. Implementation follows patterns well.
Code quality is good for production readiness.
Security posture meets baseline requirements.
Performance characteristics are within bounds.
Testing coverage adequate for core paths.
Error handling is properly structured.
Logging provides sufficient observability.
Configuration management follows twelve-factor.
Dependency management is clean and up to date.
Build pipeline is deterministic and cached.

VERDICT: PASS FINDINGS[1]
EVALEOF
rm -f .harness/nodes/code-review/run_1/eval-monohead.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_not_contains "no heading warning for multi-section eval" "$OUT" "heading.*multiple sections"


print_results
