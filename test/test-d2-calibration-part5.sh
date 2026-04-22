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
echo "--- Profile 26: thinEval substance exemption (45 lines, all findings substantive) ---"
setup_review_node
{
  echo "# Code Review"
  echo ""
  echo "## Security Assessment"
  echo ""
  echo "🔴 src/auth.ts:15 — SQL injection in login query"
  echo "**Reasoning:** User input concatenated directly into SQL string without parameterization."
  echo "**Fix:** Use parameterized queries via prepared statements."
  echo ""
  echo "🟡 src/auth.ts:42 — Weak password hashing"
  echo "**Reasoning:** MD5 is used for password hashing, which is cryptographically broken."
  echo "**Fix:** Switch to bcrypt or argon2 with appropriate cost factor."
  echo ""
  echo "## Architecture"
  echo ""
  echo "🔵 src/routes.ts:8 — Route handler too large"
  echo "**Reasoning:** Single function handles validation, business logic, and response formatting."
  echo "**Fix:** Extract validation and formatting into separate middleware functions."
  echo ""
  echo "## Testing"
  echo ""
  echo "🟡 src/auth.test.ts:1 — Missing edge case tests"
  echo "**Reasoning:** No tests for empty password, unicode chars, or max-length inputs."
  echo "**Fix:** Add parameterized test cases covering boundary inputs."
  echo ""
  echo "## Summary"
  echo ""
  echo "VERDICT: ITERATE FINDINGS[4]"
  echo ""
  echo "4 findings: 1 critical, 2 warnings, 1 suggestion."
  echo "Focus on SQL injection fix as highest priority."
  echo "Password hashing upgrade is straightforward."
  echo "Route refactor can wait for next sprint."
  echo "Test coverage gaps are moderate risk."
  echo "Overall: solid codebase with specific security issues."
  echo "Review complete."
} > .harness/nodes/code-review/run_1/eval-substance.md

OUT=$($HARNESS synthesize .harness --node code-review)
# 45 lines but ALL findings have reasoning + fix + file refs → thinEval exempt
# Should not trigger thinEval layer
assert_not_contains "substance exempt: no thinEval warning" "$OUT" "eval is thin"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 27: thinEval NOT exempt (45 lines, findings lack reasoning) ---"
setup_review_node
{
  echo "# Code Review"
  echo ""
  echo "## Security"
  echo ""
  echo "🔴 src/auth.ts:15 — SQL injection"
  echo ""
  echo "🟡 src/auth.ts:42 — Weak hashing"
  echo ""
  echo "## Architecture"
  echo ""
  echo "🔵 src/routes.ts:8 — Too large"
  echo ""
  echo "## Summary"
  echo ""
  echo "VERDICT: ITERATE FINDINGS[3]"
  echo ""
  for i in $(seq 1 25); do echo "Review padding line $i with varied content."; done
} > .harness/nodes/code-review/run_1/eval-nosubstance.md

OUT=$($HARNESS synthesize .harness --node code-review)
# Findings lack reasoning and fix → NOT exempt → thinEval fires
assert_contains "no substance: thinEval warning fires" "$OUT" "eval is thin"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- Profile 28: --base content relevance check (weak ref detection) ---"
setup_review_node
# Create a source file with specific content
mkdir -p /tmp/opc-d2-cal-base/src
cat > /tmp/opc-d2-cal-base/src/auth.ts << 'SRCEOF'
import { hash } from 'bcrypt';
const SALT_ROUNDS = 12;
export async function hashPassword(plain: string) {
  return hash(plain, SALT_ROUNDS);
}
SRCEOF

{
  echo "# Security Review"
  echo ""
  echo "## Findings"
  echo ""
  echo "🔵 src/auth.ts:3 — Missing input validation on hashPassword"
  echo "**Reasoning:** The plain parameter is not checked for empty string or null."
  echo "**Fix:** Add guard clause: if (!plain) throw new Error('empty password')."
  echo ""
  echo "🔵 src/auth.ts:1 — Completely unrelated claim about database pooling"
  echo "**Reasoning:** The database connection pool is too small."
  echo "**Fix:** Increase pool size to 20."
  echo ""
  echo "## Architecture"
  echo ""
  echo "Well-structured auth module with clean separation."
  echo ""
  echo "## Summary"
  echo ""
  echo "VERDICT: PASS FINDINGS[2]"
  echo "Two findings, one relevant, one weak ref."
  echo ""
  for i in $(seq 1 30); do echo "Review line $i: detailed analysis of authentication patterns."; done
} > .harness/nodes/code-review/run_1/eval-relevance.md

OUT=$($HARNESS synthesize .harness --node code-review --base /tmp/opc-d2-cal-base 2>/dev/null)
# Finding 1 refs auth.ts:3 (hashPassword line) and mentions "hashPassword" → relevant
# Finding 2 refs auth.ts:1 (import line) but talks about "database pooling" → weak ref
assert_contains "28: weak ref detected" "$OUT" "possible mismatch"

# ───────────────────────────────────────────────────────────────

rm -rf /tmp/opc-d2-cal-base

print_results
