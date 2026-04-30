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

cat > .harness/nodes/code-review/run_1/eval-skeptic-owner.md <<'SOEOF'
# Skeptic-Owner Evaluation

## Mechanism Audit
🔵 src/config.ts:1 — Config values not validated at startup
→ Add runtime validation with zod schema at boot
Reasoning: Invalid config will cause runtime errors instead of fast startup failure.

## Lifecycle
🔵 src/server.ts:5 — No graceful shutdown handler
→ Add SIGTERM handler that drains connections
Reasoning: Hard shutdown drops in-flight requests during deployment.

## Summary
2 suggestions. No critical or warning issues.
SOEOF

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

cat > .harness/nodes/code-review/run_1/eval-skeptic-owner.md <<'SOEOF'
# Skeptic-Owner Evaluation

## Mechanism Audit
🔵 src/config.ts:1 — Config values not validated at startup
→ Add runtime validation with zod schema at boot
Reasoning: Invalid config will cause runtime errors instead of fast startup failure.

## Lifecycle
🔵 src/server.ts:5 — No graceful shutdown handler
→ Add SIGTERM handler that drains connections
Reasoning: Hard shutdown drops in-flight requests during deployment.

## Summary
2 suggestions. No critical or warning issues.
SOEOF

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

cat > .harness/nodes/code-review/run_1/eval-skeptic-owner.md <<'SOEOF'
# Skeptic-Owner Evaluation

## Mechanism Audit
🔵 src/config.ts:1 — Config values not validated at startup
→ Add runtime validation with zod schema at boot
Reasoning: Invalid config will cause runtime errors instead of fast startup failure.

## Lifecycle
🔵 src/server.ts:5 — No graceful shutdown handler
→ Add SIGTERM handler that drains connections
Reasoning: Hard shutdown drops in-flight requests during deployment.

## Summary
2 suggestions. No critical or warning issues.
SOEOF

OUT=$($HARNESS synthesize .harness --node code-review)
# singleHeading(1 heading in 50+ lines) + noCodeRefs(no file:line refs) = 2 layers, threshold is 3
assert_gate_not_triggered "boundary 2 layers: no trigger" "$OUT"

# ───────────────────────────────────────────────────────────────

print_results
