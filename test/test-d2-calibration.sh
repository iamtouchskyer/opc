#!/bin/bash
# D2 Compound Gate Calibration — 25 synthetic evals
# Purpose: Run diverse eval patterns through synthesize to validate
# shadow/enforce behavior and collect data for the shadow→enforce decision.
#
# Each test creates a synthetic eval, runs synthesize, checks:
#   1. Whether evalQualityGate fires (triggered/not)
#   2. Shadow vs enforce mode
#   3. Correct layer count
#   4. Verdict correctness
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
assert_gate_triggered "3 layers: shadow trigger" "$OUT" "shadow"
assert_field_eq "3 layers: verdict still ITERATE" "$OUT" "verdict" '"ITERATE"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 5: Same as 4 with --strict → FAIL ---"
OUT=$($HARNESS synthesize .harness --node code-review --strict)
assert_gate_triggered "3 layers strict: enforce" "$OUT" "enforce"
assert_field_eq "3 layers strict: verdict FAIL" "$OUT" "verdict" '"FAIL"'

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
assert_gate_triggered "copypaste: triggers shadow" "$OUT" "shadow"

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

**Reasoning:** Input not validated before processing.

**Fix:** Add zod schema validation.

## Performance

🔵 src/also-fake.ts:42 — Slow query

**Reasoning:** Query is not indexed.

**Fix:** Add database index.

## Architecture

🔵 src/real.ts:1 — Good structure

**Reasoning:** Well-organized module.

**Fix:** No change needed.

## Testing

🔵 src/ghost-file.ts:100 — No tests

**Reasoning:** Critical path untested.

**Fix:** Add unit tests.

## Summary

4 findings reviewed across security, performance, architecture, and testing.
EVALEOF

OUT=$($HARNESS synthesize .harness --node code-review --base /tmp/opc-d2-cal-base)
# 3 fabricated refs → invalidRefCount = 3 → +2 weight = contribution of 2
# Plus possibly other layers
assert_gate_triggered "fabricated refs: triggers shadow" "$OUT" "shadow"

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
assert_gate_triggered "all layers: triggers shadow" "$OUT" "shadow"

OUT=$($HARNESS synthesize .harness --node code-review --strict)
assert_gate_triggered "all layers strict: enforce" "$OUT" "enforce"
assert_field_eq "all layers strict: FAIL" "$OUT" "verdict" '"FAIL"'

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
assert_gate_triggered "mixed roles: shadow (bad role triggers)" "$OUT" "shadow"
assert_field_eq "mixed roles: verdict ITERATE" "$OUT" "verdict" '"ITERATE"'

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
echo ""
echo "--- Profile 21: Suggestion-only eval (50+ lines, no warning/critical) → PASS ---"
setup_review_node
{
  echo "# Code Review"
  echo ""
  echo "## Style"
  echo ""
  echo "🔵 src/utils.ts:5 — Consider using const instead of let"
  echo ""
  echo "Reasoning: Variable is never reassigned after initialization."
  echo "→ Change let to const for immutability signal."
  echo ""
  echo "## Documentation"
  echo ""
  echo "🔵 src/api.ts:12 — Missing JSDoc on public function"
  echo ""
  echo "Reasoning: Public API should be documented for consumers."
  echo "→ Add JSDoc with param and returns."
  echo ""
  echo "## Naming"
  echo ""
  echo "🔵 src/handler.ts:22 — Vague variable name"
  echo ""
  echo "Reasoning: data does not convey what the variable holds."
  echo "→ Rename to userProfile or authResponse."
  echo ""
  echo "## Structure"
  echo ""
  echo "🔵 src/routes.ts:8 — Route handlers could be extracted"
  echo ""
  echo "Reasoning: Inline handlers reduce readability."
  echo "→ Extract to separate controller module."
  echo ""
  echo "## Testing"
  echo ""
  echo "🔵 src/service.ts:30 — Missing error path test"
  echo ""
  echo "Reasoning: Only happy path is tested."
  echo "→ Add test for network timeout and invalid input."
  echo ""
  echo "## Imports"
  echo ""
  echo "🔵 src/index.ts:1 — Unused import of lodash"
  echo ""
  echo "Reasoning: lodash imported but only used in deleted function."
  echo "→ Remove import or replace with native methods."
  echo ""
  echo "## Summary"
  echo ""
  echo "6 suggestions, no warnings or critical issues."
  echo "Code is production-ready with minor polish opportunities."
  echo "All security and performance aspects are solid."
} > .harness/nodes/code-review/run_1/eval-suggestions.md

OUT=$($HARNESS synthesize .harness --node code-review)
assert_field_eq "suggestions only: PASS" "$OUT" "verdict" '"PASS"'
assert_gate_not_triggered "suggestions only: no gate" "$OUT"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 22: Warning finding → ITERATE (not PASS) ---"
setup_review_node
cat > .harness/nodes/code-review/run_1/eval-warning.md << 'EVALEOF'
# Code Review

## Security

🟡 src/auth.ts:30 — Session token not rotated after login

**Reasoning:** Session fixation vulnerability if token persists from anonymous session.

**Fix:** Call `req.session.regenerate()` after successful authentication.

## Architecture

🔵 src/routes.ts:15 — Route handler too long

**Reasoning:** 200+ lines in single handler reduces readability.

**Fix:** Extract validation, business logic, and response formatting into separate functions.

## Summary

1 warning, 1 suggestion.
EVALEOF

OUT=$($HARNESS synthesize .harness --node code-review)
assert_field_eq "warning: ITERATE" "$OUT" "verdict" '"ITERATE"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 23: Empty eval file ---"
setup_review_node
echo "" > .harness/nodes/code-review/run_1/eval-empty.md

OUT=$($HARNESS synthesize .harness --node code-review)
assert_contains "empty eval: synthesize handles it" "$OUT" "verdict"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 24: Eval with only LGTM (50+ lines) ---"
setup_review_node
{
  echo "# Code Review"
  echo ""
  echo "## Overall Assessment"
  echo ""
  echo "Code looks great. Well-structured, well-tested, follows all conventions."
  echo ""
  echo "## Architecture"
  echo ""
  echo "Clean separation of concerns. Controllers are thin, services handle business logic."
  echo "The dependency injection pattern is consistent across all modules."
  echo "Error boundaries are properly defined at each layer."
  echo ""
  echo "## Security"
  echo ""
  echo "Authentication and authorization properly implemented. No obvious vulnerabilities."
  echo "Rate limiting is in place. CORS headers are correctly configured."
  echo "Input validation uses zod schemas at every boundary."
  echo ""
  echo "## Performance"
  echo ""
  echo "Queries are indexed. No N+1 patterns detected."
  echo "Connection pooling is properly configured."
  echo "Caching strategy is appropriate for the use case."
  echo ""
  echo "## Testing"
  echo ""
  echo "Good test coverage across unit, integration, and e2e layers."
  echo "Edge cases are well covered including error paths."
  echo "Test fixtures are clean and isolated."
  echo ""
  echo "## Code Quality"
  echo ""
  echo "Consistent coding style throughout. No dead code detected."
  echo "TypeScript types are precise — no any escapes."
  echo "Error handling is comprehensive with typed error classes."
  echo ""
  echo "## Documentation"
  echo ""
  echo "API endpoints are documented with OpenAPI specs."
  echo "README is current with setup and deployment instructions."
  echo "Architecture decision records are maintained."
  echo ""
  echo "## Summary"
  echo ""
  echo "LGTM. No findings. Ready to merge. All quality bars met."
  echo "The codebase demonstrates mature engineering practices."
  echo "Dependency management is clean with no unnecessary packages."
  echo "CI pipeline covers all quality gates including lint, test, and build."
  echo "No action items required before merge."
} > .harness/nodes/code-review/run_1/eval-lgtm.md

OUT=$($HARNESS synthesize .harness --node code-review)
assert_field_eq "LGTM: PASS" "$OUT" "verdict" '"PASS"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 25: Gate boundary — exactly 2 layers (should NOT trigger) ---"
setup_review_node
# singleHeading (1 heading in 50+ lines) + noCodeRefs but has reasoning/fix → 2 layers
{
  echo "# Single Section Review"
  echo ""
  echo "🔵 There's an issue with error handling in the service layer"
  echo ""
  echo "Reasoning: The catch blocks swallow exceptions without logging."
  echo "→ Add structured logging in catch blocks."
  echo ""
  echo "🔵 Missing input validation on the update endpoint"
  echo ""
  echo "Reasoning: User-provided data goes straight to the database layer."
  echo "→ Add zod schema validation before database write."
  echo ""
  # Varied filler to avoid lowUniqueContent/thinEval/lineLengthVarianceLow
  for i in $(seq 1 45); do
    case $((i % 5)) in
      0) echo "Reviewing the dependency graph for circular imports in module $i." ;;
      1) echo "Short note on item $i." ;;
      2) echo "The error handling strategy in this section follows established patterns from the architecture decision record, which specifies structured logging and typed errors for area $i." ;;
      3) echo "Module $i: LGTM." ;;
      4) echo "Checked integration boundaries between services — clean interface contracts, properly typed DTOs, no implicit coupling in module group $i of the backend layer." ;;
    esac
  done
} > .harness/nodes/code-review/run_1/eval-boundary.md

OUT=$($HARNESS synthesize .harness --node code-review)
# singleHeading(1 heading in 50+ lines) + noCodeRefs(no file:line refs) = 2 layers, threshold is 3
assert_gate_not_triggered "boundary 2 layers: no trigger" "$OUT"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== D2 Calibration Summary ==="
echo ""
# Clean up
rm -rf /tmp/opc-d2-cal-base

print_results
