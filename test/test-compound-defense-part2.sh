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
echo "=== TEST GROUP 3: Finding density detection ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 3.1: 1 finding in 70 lines → findingDensityLow warning ---"
{
  echo "# Review"
  echo ""
  echo "## Architecture"
  echo "The architecture is well-designed overall."
  echo "Clear separation between data and presentation layers."
  echo ""
  echo "## Findings"
  echo ""
  echo "🔵 src/main.ts:10 — One tiny issue"
  echo "→ Fix it"
  echo "Reasoning: Good practice."
  echo ""
  echo "## Security Analysis"
  echo "No SQL injection vectors found in the codebase."
  echo "Authentication middleware is correctly applied."
  echo "CORS settings are appropriately restrictive."
  echo "Input validation is comprehensive."
  echo "Session management follows best practices."
  echo "Password hashing uses bcrypt with proper rounds."
  echo "JWT tokens have reasonable expiry times."
  echo "Sensitive data is not logged."
  echo "API keys are stored in environment variables."
  echo "Cross-site scripting protections are in place."
  echo ""
  echo "## Performance Review"
  echo "Database queries use proper indexing strategies."
  echo "No N+1 query patterns detected in the code."
  echo "Connection pooling is configured correctly."
  echo "Response caching reduces server load."
  echo "Static assets are served with proper cache headers."
  echo "Lazy loading is used for heavy components."
  echo "Bundle splitting is configured correctly."
  echo "Image optimization pipeline is in place."
  echo "CDN is used for static asset delivery."
  echo "Database connection timeouts are configured."
  echo ""
  echo "## Testing Assessment"
  echo "Unit test coverage is good for core modules."
  echo "Integration tests cover the critical paths."
  echo "E2E tests verify the main user flows."
  echo "Mock data is properly isolated per test."
  echo "Test fixtures are well-organized and reusable."
  echo "CI runs tests on every pull request."
  echo "Coverage reports are generated automatically."
  echo "Performance benchmarks track regression."
  echo "Load testing scripts exist for key endpoints."
  echo "Visual regression tests catch UI changes."
  echo ""
  echo "## Code Quality"
  echo "Consistent coding style across the codebase."
  echo "Proper use of TypeScript for type safety."
  echo "Documentation comments on public APIs."
  echo "No circular dependencies detected."
  echo "Clean git history with descriptive commits."
  echo "Feature flags manage gradual rollouts."
  echo "Error boundaries prevent cascading failures."
  echo "Monitoring and alerting are configured."
  echo "Runbooks exist for common operational tasks."
  echo "Incident response procedures are documented."
  echo ""
  echo "## Summary"
  echo "Code quality is excellent. One minor suggestion."
  echo "Security posture is strong."
  echo "Performance characteristics meet requirements."
  echo "Testing coverage provides good confidence."
  echo ""
  echo "VERDICT: PASS FINDINGS[1]"
} > .harness/nodes/code-review/run_1/eval-lowdensity.md
rm -f .harness/nodes/code-review/run_1/eval-multihead.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_contains "finding density warning" "$OUT" "finding density"
assert_contains "bulk filler" "$OUT" "bulk filler"
assert_field_eq "verdict ITERATE (low density)" "$OUT" "verdict" '"ITERATE"'

echo ""
echo "--- 3.2: Multiple findings in proportionate eval → no density warning ---"
cat > .harness/nodes/code-review/run_1/eval-propfinding.md <<'EVALEOF'
# Code Review

## Architecture
Clean modular structure with proper layering.

## Findings

🔵 src/main.ts:10 — Import ordering inconsistent
→ Group external imports before internal ones
Reasoning: Follow established convention.

🔵 src/utils.ts:25 — Unused helper function
→ Remove dead code
Reasoning: Maintenance burden.

🔵 src/db.ts:42 — Connection pool size hardcoded
→ Move to environment variable
Reasoning: Production flexibility.

🟡 src/auth.ts:15 — Token expiry not validated
→ Add expiry check in auth middleware
Reasoning: Security issue.

🔵 src/api.ts:88 — Missing error handler
→ Add try-catch block
Reasoning: Unhandled promise rejection.

## Security
Authentication checked. CORS configured. CSP present.
Input validation covers all endpoints.

## Performance
Queries indexed. No N+1 patterns. Caching applied.
Bundle size within acceptable limits.

## Summary
Found 5 issues: 1 warning, 4 suggestions.
Overall good quality with specific improvements needed.
Code follows existing patterns consistently.
Security posture is mostly adequate.
Performance meets current requirements.

VERDICT: ITERATE FINDINGS[5]
EVALEOF
rm -f .harness/nodes/code-review/run_1/eval-lowdensity.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_not_contains "no density warning for proportionate eval" "$OUT" "finding density"


print_results
