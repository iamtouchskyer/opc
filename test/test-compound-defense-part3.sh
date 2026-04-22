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


print_results
