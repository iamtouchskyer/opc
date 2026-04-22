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
echo "--- Profile 29: Aspirational claims layer → compound trigger ---"
setup_review_node
{
  echo "# Security Review"
  echo ""
  echo "## Authentication"
  echo ""
  echo "🔴 src/auth.ts:10 — Password stored in plaintext"
  echo "It would be nice to hash passwords before storage."
  echo "→ Use bcrypt"
  echo ""
  echo "🟡 src/auth.ts:20 — Session timeout too long"
  echo "Worth considering reducing session length to 30 minutes."
  echo "→ Set maxAge=1800"
  echo ""
  echo "🟡 src/auth.ts:30 — No rate limiting"
  echo "Should consider adding rate limiting to login endpoint."
  echo "→ Add rate limiter"
  echo ""
  echo "🟡 src/auth.ts:40 — CORS too permissive"
  echo "May want to restrict allowed origins in production."
  echo "→ Whitelist origins"
  echo ""
  echo "## Summary"
  echo ""
  echo "VERDICT: ITERATE FINDINGS[4]"
  for i in $(seq 1 30); do echo "Detailed security analysis line $i with unique content."; done
} > .harness/nodes/code-review/run_1/eval-security.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_contains "29.1: aspirational claims detected" "$OUT" "aspirational"
# aspirationalClaims layer fires (4 aspirational lines ≥ 3 threshold)

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 30: evaluatorGuidance in output when D2 triggers ---"
setup_review_node
{
  echo "# Quick Review"
  echo ""
  echo "Looks fine overall."
  echo ""
  echo "🔴 something — Bad thing"
  echo ""
  echo "VERDICT: ITERATE FINDINGS[1]"
  for i in $(seq 1 12); do echo "Filler line $i."; done
} > .harness/nodes/code-review/run_1/eval-lazy.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_contains "30.1: evaluatorGuidance present" "$OUT" "evaluatorGuidance"
assert_contains "30.2: triggeredLayers in guidance" "$OUT" "triggeredLayers"
assert_contains "30.3: hints in guidance" "$OUT" "hints"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 31: No evaluatorGuidance when D2 does not trigger ---"
setup_review_node
{
  echo "# Thorough Code Review"
  echo ""
  echo "## Security"
  echo ""
  echo "🔴 src/auth.ts:10 — SQL injection in login query"
  echo ""
  echo "Reasoning: User input is concatenated directly into SQL string."
  echo "→ Use parameterized queries with prepared statements."
  echo ""
  echo "## Performance"
  echo ""
  echo "🟡 src/db.ts:25 — N+1 query in user list endpoint"
  echo ""
  echo "Reasoning: Each user triggers a separate query for roles."
  echo "→ Use JOIN or batch query to load all roles in one call."
  echo ""
  echo "## Error Handling"
  echo ""
  echo "🟡 src/api.ts:42 — Uncaught promise rejection in middleware"
  echo ""
  echo "Reasoning: Async middleware lacks try/catch, will crash process."
  echo "→ Wrap in try/catch or use express-async-errors."
  echo ""
  echo "## Validation"
  echo ""
  echo "🔵 src/routes.ts:8 — No input validation on POST /users"
  echo ""
  echo "Reasoning: Missing schema validation allows malformed data."
  echo "→ Add Zod or Joi schema validation."
  echo ""
  echo "## Summary"
  echo ""
  echo "VERDICT: ITERATE FINDINGS[4]"
  echo ""
  for i in $(seq 1 15); do echo "Detailed review analysis paragraph $i covering various aspects of the code."; done
} > .harness/nodes/code-review/run_1/eval-thorough.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_not_contains "31: no guidance when D2 not triggered" "$OUT" "evaluatorGuidance"


print_results
