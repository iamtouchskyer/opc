#!/bin/bash
# End-to-end tests for opc-harness flow commands — Part 4 (Groups 10-11)
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

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
echo ""
echo "=== TEST GROUP 10: eval commands ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 10.1: verify ---"
mkdir -p .h-eval
cat > .h-eval/eval.md << 'EVAL'
# Security Review

## Verdict: ITERATE

### Findings

#### 🔴 Critical: SQL injection
- **File:** user.js:42
- **Issue:** Raw SQL query with user input
- **Fix:** Use parameterized queries
- **Reasoning:** Direct string concatenation allows injection

#### 🟡 Warning: Missing rate limiting
- **File:** auth.js:10
- **Issue:** Login endpoint has no rate limit
- **Fix:** Add express-rate-limit middleware
- **Reasoning:** Brute force attacks possible
EVAL
OUT=$($HARNESS verify .h-eval/eval.md)
assert_contains "has verdict" "$OUT" "ITERATE"
assert_contains "critical count" "$OUT" "critical"

echo ""
echo "--- 10.2: synthesize ---"
mkdir -p .h-eval/nodes/code-review/run_1
cat > .h-eval/nodes/code-review/run_1/eval-security.md << 'EVAL'
# Security Review
## Verdict: ITERATE
### Findings
🔴 SQL injection in user.js:10 — missing parameterized query
→ Use prepared statements
Reasoning: Direct string concatenation allows injection
EVAL
cat > .h-eval/nodes/code-review/run_1/eval-perf.md << 'EVAL'
# Performance Review
## Verdict: PASS
### Findings
🔵 Consider caching — response.js:5 — add redis cache layer
EVAL
OUT=$($HARNESS synthesize .h-eval --node code-review)
assert_contains "FAIL verdict" "$OUT" "FAIL"

echo ""
echo "--- 10.3: diff ---"
cat > .h-eval/r1.md << 'EVAL'
# Review Round 1
## Verdict: FAIL
### Findings
🔴 Bug in auth — auth.js:10 — missing null check
→ Add null check before accessing user.id
Reasoning: Crashes on unauthenticated requests
EVAL
cat > .h-eval/r2.md << 'EVAL'
# Review Round 2
## Verdict: PASS
### Findings
No findings.
EVAL
OUT=$($HARNESS diff .h-eval/r1.md .h-eval/r2.md)
assert_contains "resolved count" "$OUT" "resolved"
assert_contains "round1 findings" "$OUT" "round1_findings"

echo ""
echo "--- 10.4: diff unreadable file ---"
OUT=$($HARNESS diff .h-eval/nonexistent.md .h-eval/r2.md)
assert_contains "error on bad file" "$OUT" "Cannot read"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 11: replay ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 11.1: replay data ---"
rm -rf .h-fin && $HARNESS init --flow review --dir .h-fin >/dev/null 2>/dev/null
mkdir -p .h-fin/nodes/review/run_1
printf '# Review A\nPerspective: Security\nVERDICT: PASS FINDINGS[0]\n' > .h-fin/nodes/review/run_1/eval-a.md
printf '# Review B\nPerspective: Performance\nVERDICT: PASS FINDINGS[0]\n' > .h-fin/nodes/review/run_1/eval-b.md
cat > .h-fin/nodes/review/handshake.json << 'HS'
{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[{"type":"eval","path":"run_1/eval-a.md"},{"type":"eval","path":"run_1/eval-b.md"}]}
HS
sleep 1
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .h-fin >/dev/null 2>/dev/null
mkdir -p .h-fin/nodes/gate
cat > .h-fin/nodes/gate/handshake.json << 'HS'
{"nodeId":"gate","nodeType":"gate","runId":"run_1","status":"completed","summary":"passed","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
$HARNESS finalize --dir .h-fin >/dev/null 2>/dev/null
OUT=$($HARNESS replay --dir .h-fin)
assert_contains "has flowTemplate" "$OUT" "flowTemplate"
assert_contains "has nodes" "$OUT" "nodes"
assert_contains "has history" "$OUT" "history"

echo ""
echo "--- 11.2: replay no state ---"
rm -rf .h-replay-no && mkdir -p .h-replay-no
OUT=$($HARNESS replay --dir .h-replay-no 2>&1) || true
assert_contains "no state" "$OUT" "No flow-state"

print_results
