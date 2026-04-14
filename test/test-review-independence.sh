#!/bin/bash
# Tests for review independence enforcement (Plan Item #1)
# - Review node requires ≥2 eval artifacts
# - Identical eval files rejected
# - High overlap warned
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

# ═══════════════════════════════════════════════════════════════
echo "=== TEST GROUP 1: Review node requires ≥2 eval artifacts ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 1.1: Review with 0 eval artifacts → error ---"
mkdir -p test-review
cat > test-review/handshake.json <<'EOF'
{
  "nodeId": "code-review",
  "nodeType": "review",
  "runId": "run_1",
  "status": "completed",
  "summary": "Looks good",
  "timestamp": "2025-01-01T00:00:00Z",
  "verdict": "PASS",
  "artifacts": []
}
EOF
OUT=$($HARNESS validate test-review/handshake.json 2>/dev/null)
assert_field_eq "not valid" "$OUT" "valid" "false"
assert_contains "requires ≥2 eval" "$OUT" "requires.*2 eval artifacts"

echo ""
echo "--- 1.2: Review with 1 eval artifact → error ---"
mkdir -p test-review2
echo "# Eval A
🔵 suggestion — looks fine
VERDICT: PASS FINDINGS[1]" > test-review2/eval-a.md
cat > test-review2/handshake.json <<'EOF'
{
  "nodeId": "code-review",
  "nodeType": "review",
  "runId": "run_1",
  "status": "completed",
  "summary": "Reviewed",
  "timestamp": "2025-01-01T00:00:00Z",
  "verdict": "PASS",
  "artifacts": [
    {"type": "eval", "path": "eval-a.md"}
  ]
}
EOF
OUT=$($HARNESS validate test-review2/handshake.json 2>/dev/null)
assert_field_eq "not valid" "$OUT" "valid" "false"
assert_contains "requires ≥2" "$OUT" "requires.*2 eval"

echo ""
echo "--- 1.3: Review with 2 distinct eval artifacts → valid ---"
mkdir -p test-review3
cat > test-review3/eval-a.md <<'EVALEOF'
# Security Review
🔵 src/auth.ts:42 — Consider using bcrypt rounds > 10
→ Increase to 12 for production
Reasoning: Current default is low for security-critical hashing.

VERDICT: PASS FINDINGS[1]
EVALEOF
cat > test-review3/eval-b.md <<'EVALEOF'
# Performance Review
🟡 src/db.ts:88 — N+1 query in user listing
→ Use eager loading or batch fetch
Reasoning: This endpoint is called frequently and will scale poorly.

VERDICT: ITERATE FINDINGS[1]
EVALEOF
cat > test-review3/handshake.json <<'EOF'
{
  "nodeId": "code-review",
  "nodeType": "review",
  "runId": "run_1",
  "status": "completed",
  "summary": "Two reviews completed",
  "timestamp": "2025-01-01T00:00:00Z",
  "verdict": "ITERATE",
  "artifacts": [
    {"type": "eval", "path": "eval-a.md"},
    {"type": "eval", "path": "eval-b.md"}
  ]
}
EOF
OUT=$($HARNESS validate test-review3/handshake.json 2>/dev/null)
assert_field_eq "valid" "$OUT" "valid" "true"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 2: Eval distinctness checks ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 2.1: Identical eval files → error ---"
mkdir -p test-identical
EVAL_CONTENT="# Code Review
🔵 src/main.ts:10 — Minor style issue
→ Fix style
Reasoning: Consistent formatting.

VERDICT: PASS FINDINGS[1]"
echo "$EVAL_CONTENT" > test-identical/eval-a.md
echo "$EVAL_CONTENT" > test-identical/eval-b.md
cat > test-identical/handshake.json <<'EOF'
{
  "nodeId": "code-review",
  "nodeType": "review",
  "runId": "run_1",
  "status": "completed",
  "summary": "Two identical reviews",
  "timestamp": "2025-01-01T00:00:00Z",
  "verdict": "PASS",
  "artifacts": [
    {"type": "eval", "path": "eval-a.md"},
    {"type": "eval", "path": "eval-b.md"}
  ]
}
EOF
OUT=$($HARNESS validate test-identical/handshake.json 2>/dev/null)
assert_field_eq "not valid" "$OUT" "valid" "false"
assert_contains "identical" "$OUT" "identical.*reviews must be independent"

echo ""
echo "--- 2.2: Non-review node with 0 eval artifacts → still valid ---"
mkdir -p test-execute
echo "test output" > test-execute/output.txt
cat > test-execute/handshake.json <<'EOF'
{
  "nodeId": "test-execute",
  "nodeType": "execute",
  "runId": "run_1",
  "status": "completed",
  "summary": "Tests passed",
  "timestamp": "2025-01-01T00:00:00Z",
  "verdict": "PASS",
  "artifacts": [
    {"type": "cli-output", "path": "output.txt"}
  ]
}
EOF
OUT=$($HARNESS validate test-execute/handshake.json 2>/dev/null)
assert_field_eq "execute valid without evals" "$OUT" "valid" "true"

echo ""
echo "--- 2.3: Review with 'evaluation' type artifacts → also works ---"
mkdir -p test-eval-type
cat > test-eval-type/eval-a.md <<'EVALEOF'
# Frontend Review
🔵 src/App.tsx:5 — Import order inconsistent
→ Group React imports first
Reasoning: Convention for React projects.

VERDICT: PASS FINDINGS[1]
EVALEOF
cat > test-eval-type/eval-b.md <<'EVALEOF'
# Backend Review
🟡 src/server.ts:20 — Missing rate limiting on public endpoint
→ Add express-rate-limit middleware
Reasoning: Public APIs need rate limiting to prevent abuse.

VERDICT: ITERATE FINDINGS[1]
EVALEOF
cat > test-eval-type/handshake.json <<'EOF'
{
  "nodeId": "code-review",
  "nodeType": "review",
  "runId": "run_1",
  "status": "completed",
  "summary": "Two reviews",
  "timestamp": "2025-01-01T00:00:00Z",
  "verdict": "ITERATE",
  "artifacts": [
    {"type": "evaluation", "path": "eval-a.md"},
    {"type": "evaluation", "path": "eval-b.md"}
  ]
}
EOF
OUT=$($HARNESS validate test-eval-type/handshake.json 2>/dev/null)
assert_field_eq "'evaluation' type works" "$OUT" "valid" "true"

print_results
