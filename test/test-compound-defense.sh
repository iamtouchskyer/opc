#!/bin/bash
# Tests for compound defense layers (probability stacking)
# Each layer is independently ~30% bypassable; stacked = ~0.24% bypass.
#
# Layers tested:
#   eval-parser: lowUniqueContent, singleHeading, findingDensityLow
#   eval-commands/synthesize: wiring into warnings → verdict downgrade
#   test plan: section depth (≥3 content lines), actionable commands
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

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 4: Test plan compound defense ==="
# ═══════════════════════════════════════════════════════════════

mkdir -p .harness/nodes/test-design/run_1

# Need an eval for synthesize to parse
{
  echo "# Test Design Review"
  echo ""
  echo "## Analysis"
  echo "Test plan is comprehensive."
  echo "Coverage appears adequate for the feature."
  echo ""
  echo "## Findings"
  echo "🔵 Test plan covers all critical paths"
  echo "→ No changes needed"
  echo "Reasoning: Comprehensive coverage."
  echo ""
  echo "## Quality Assessment"
  echo "All test layers are present."
  echo "Each section has sufficient detail."
  echo "Actionable steps are clear."
  echo "Expected outcomes are defined."
  echo "Failure impacts are documented."
  echo "Priority ranking is reasonable."
  echo ""
  echo "## Structure"
  echo "Well organized into logical sections."
  echo "Dependencies between tests documented."
  echo "Resource requirements noted."
  echo ""
  echo "## Coverage Analysis"
  echo "Unit tests cover all public APIs."
  echo "Integration tests verify cross-module flows."
  echo "E2E tests cover user-facing scenarios."
  echo "Edge cases are explicitly enumerated."
  echo "Error paths are tested systematically."
  echo ""
  echo "## Timing"
  echo "Estimated total test execution: 12 minutes."
  echo "Parallelizable tests are grouped correctly."
  echo "Long-running tests are marked for CI-only."
  echo "Quick smoke tests are extracted for local dev."
  echo "Progressive test strategy aligns with CI stages."
  echo ""
  echo "VERDICT: PASS FINDINGS[1]"
} > .harness/nodes/test-design/run_1/eval-tester.md

echo "--- 4.1: Test plan with shallow sections → warning ---"
cat > .harness/nodes/test-design/run_1/test-plan.md <<'EOF'
# Test Plan

## L1: Unit Tests
- Run `npm test`

## L2: Edge Cases
- Test edge cases

## L3: Integration
- Test end-to-end flow

## L4: UI
- Check screenshots

## L5: Tier Baseline
- Check typography
EOF

OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_contains "shallow sections detected" "$OUT" "shallow"
assert_field_eq "verdict ITERATE (shallow)" "$OUT" "verdict" '"ITERATE"'

echo ""
echo "--- 4.2: Test plan with deep sections → no shallow warning ---"
cat > .harness/nodes/test-design/run_1/test-plan.md <<'EOF'
# Test Plan

## L1: Unit Tests
- Run `npm test` for unit tests
- Jest coverage must be > 80%
- All modules in src/ must have corresponding test files
- Snapshot tests for React components

## L2: Contract / Edge Cases
- Validate API schema compliance with OpenAPI spec
- Test boundary values: empty string, max length, unicode
- Test invalid input rejection returns 400 with error details
- Verify error codes match documentation

## L3: Integration / E2E Flows
- Test end-to-end flow: login → create → submit → verify
- Integration test with real database (test container)
- Verify webhook delivery on state transitions
- Test concurrent user scenarios

## L4: UI / Visual / A11y
- Playwright screenshot at 1440px and 375px viewport
- Verify responsive layout breakpoints
- axe-core accessibility scan with zero violations
- Keyboard navigation test for all interactive elements

## L5: Tier Baseline / Polish
- Verify dark mode toggle preserves user preference
- Check typography hierarchy (heading vs body fonts)
- Test navigation active states on all routes
- Verify favicon and meta tags present
EOF

OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_not_contains "no shallow for deep sections" "$OUT" "shallow"

echo ""
echo "--- 4.3: Test plan with 0 actionable commands → warning ---"
cat > .harness/nodes/test-design/run_1/test-plan.md <<'EOF'
# Test Plan

## L1: Unit / Smoke
We should test all the units.
Make sure every module has tests.
Coverage should be high.
The tests need to be reliable.

## L2: Contract / Edge Cases
Test all the edge cases we can think of.
Validate the schema is correct.
Check boundary values carefully.
Ensure error handling works.

## L3: Integration / E2E Flows
Run the integration tests.
Verify the end-to-end flow works.
Check all services communicate properly.
Test with realistic data volumes.

## L4: UI / Visual / A11y
Verify the UI looks correct.
Check responsive design on mobile.
Run accessibility checks.
Test keyboard navigation.

## L5: Tier / Baseline / Polish
Check typography is correct.
Verify dark mode works.
Test navigation states.
Ensure favicon is present.
EOF

OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_contains "no actionable commands" "$OUT" "noActionableCommands"
assert_field_eq "verdict ITERATE (no commands)" "$OUT" "verdict" '"ITERATE"'

echo ""
echo "--- 4.4: Test plan with actionable commands → no command warning ---"
cat > .harness/nodes/test-design/run_1/test-plan.md <<'EOF'
# Test Plan

## L1: Unit / Smoke
- Run `npm test` for all unit tests
- Run `npx vitest run --coverage` for coverage report
- Verify all modules pass independently
- Check `npm run lint` has zero warnings

## L2: Contract / Edge Cases
- Run `npx jest --testPathPattern=edge` for edge case tests
- Validate against schema: `npx ajv validate -s schema.json -d response.json`
- Test boundary values with dedicated boundary suite
- Test invalid input returns proper error codes

## L3: Integration / E2E Flows
- Run `npm run test:integration` with Docker test containers
- Execute `curl -X POST http://localhost:3000/api/submit` to test submission flow
- Verify webhook delivery with test interceptor
- Run `npx playwright test tests/e2e/flow.spec.ts`

## L4: UI / Visual / A11y
- Run `npx playwright test --project=chromium` for screenshots
- Run `node scripts/axe-scan.js` for accessibility audit
- Verify responsive layout at 375px and 1440px viewport
- Test keyboard navigation through all interactive elements

## L5: Tier / Baseline / Polish
- Verify dark mode: `npx playwright test tests/visual/dark-mode.spec.ts`
- Check typography hierarchy in computed styles
- Test navigation active states on all routes
- Verify `curl -s http://localhost:3000 | grep favicon` returns match
EOF

OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_not_contains "no command warning for actionable plan" "$OUT" "noActionableCommands"

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
assert_field_eq "verdict ITERATE (stacked)" "$OUT" "verdict" '"ITERATE"'

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

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 7: File:line reality check via --base ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 7.1: Fabricated file:line refs caught with --base ---"
# Create a project dir with short files
mkdir -p project/src
echo "// placeholder" > project/src/main.ts
echo "// placeholder" > project/src/auth.ts

# Eval references line 10 and line 15 — files only have 1 line
cat > .harness/nodes/code-review/run_1/eval-faker.md <<'EVALEOF'
# Code Review

## Architecture
Clean modular structure with proper layering.
Services abstract business logic from handlers.

## Findings

🔵 src/main.ts:10 — Import ordering inconsistent
→ Group external imports before internal ones
Reasoning: Following convention.

🔵 src/auth.ts:15 — Token expiry issue
→ Add expiry check
Reasoning: Security.

## Security
No injection vectors. Auth is solid.
CORS and CSP properly configured.

## Performance
Queries use proper indexing throughout.
No N+1 patterns detected anywhere.

## Testing
Good unit test coverage on core modules.
Integration tests cover main flows.

## Error Handling
Try-catch on all async routes.
Proper status codes returned.

## Summary
Two suggestions. Code quality is good overall.
No critical vulnerabilities found in review.
Patterns are consistently followed throughout.

VERDICT: PASS FINDINGS[2]
EVALEOF
rm -f .harness/nodes/code-review/run_1/eval-reasoned.md

OUT=$($HARNESS synthesize .harness --node code-review --base project 2>/dev/null)
assert_contains "fabricated refs caught" "$OUT" "fabricated refs"
assert_field_eq "verdict ITERATE (fake refs)" "$OUT" "verdict" '"ITERATE"'

echo ""
echo "--- 7.2: Valid file:line refs pass with --base ---"
# Make files long enough
python3 -c "
for i in range(50):
    print(f'const line{i+1} = \"implementation\";')
" > project/src/main.ts
python3 -c "
for i in range(50):
    print(f'const auth{i+1} = \"implementation\";')
" > project/src/auth.ts

OUT=$($HARNESS synthesize .harness --node code-review --base project 2>/dev/null)
assert_not_contains "no fabricated refs for valid files" "$OUT" "fabricated refs"

echo ""
echo "--- 7.3: Without --base, file ref check is skipped ---"
echo "// placeholder" > project/src/main.ts
echo "// placeholder" > project/src/auth.ts

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_not_contains "no ref check without --base" "$OUT" "fabricated refs"

print_results
