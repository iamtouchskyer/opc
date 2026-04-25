#!/bin/bash
set -e
source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "✅ $label"; PASS=$((PASS+1))
  else
    echo "❌ $label — expected '$needle' in output"; FAIL=$((FAIL+1))
    echo "   GOT: $(echo "$haystack" | head -5)"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "❌ $label — did NOT expect '$needle' in output"; FAIL=$((FAIL+1))
  else
    echo "✅ $label"; PASS=$((PASS+1))
  fi
}

assert_field_eq() {
  local json="$1" field="$2" expected="$3" label="$4"
  local actual
  actual=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d${field})" 2>/dev/null || echo "__PARSE_ERROR__")
  if [ "$actual" = "$expected" ]; then
    echo "✅ $label"; PASS=$((PASS+1))
  else
    echo "❌ $label — expected $field=$expected, got $actual"; FAIL=$((FAIL+1))
  fi
}

# ═══════════════════════════════════════════════════════════════════
echo "=== PART 2: finalize --strict ==="
# ═══════════════════════════════════════════════════════════════════

# Helper: write a valid handshake for a node.
# For review nodes, also creates 2 distinct eval files to satisfy
# the review independence check (≥2 distinct eval artifacts).
write_handshake() {
  local dir="$1" node="$2" ntype="$3" status="$4"
  mkdir -p "$dir/nodes/$node"
  if [ "$ntype" = "review" ]; then
    mkdir -p "$dir/nodes/$node/run_1"
    cat > "$dir/nodes/$node/run_1/eval-security.md" << 'EVAL'
# Security Review
## Summary
Reviewed the authentication flow for common vulnerabilities.
Checked for SQL injection, XSS, CSRF, and session fixation issues.

## Findings
🔵 suggestion — auth.js:42 — prefer const for immutable bindings
→ Change `let user = ...` to `const user = ...`
Reasoning: const signals immutability and enables compile-time checks.

## Conclusion
No critical security issues found. One style suggestion only.
EVAL
    cat > "$dir/nodes/$node/run_1/eval-performance.md" << 'EVAL'
# Performance Review
## Approach
Profiled the hot path under typical load. Reviewed algorithmic complexity.
Measured allocation patterns and database query counts.

## Findings
🔵 suggestion — handler.js:20 — cache the result of expensive computation
→ Wrap the function in a memoize helper
Reasoning: The same input is queried many times per request cycle.

## Conclusion
No performance regressions. One optimization opportunity noted.
EVAL
    cat > "$dir/nodes/$node/run_1/eval-skeptic-owner.md" << 'EVAL'
# Skeptic Owner Review
## D7: Request Compliance
All checkpoints verified.

## Findings
🔵 suggestion — handler.js:30 — add integration test for cleanup path
→ Fix: write test that triggers cleanup and asserts artifact removal
→ Reasoning: cleanup path is untested, silent failure possible

## Verdict
VERDICT: MECHANISMS HOLD — PASS.
EVAL
    cat > "$dir/nodes/$node/handshake.json" << HSEOF
{
  "nodeId": "$node",
  "nodeType": "$ntype",
  "runId": "run_1",
  "status": "$status",
  "summary": "done",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [
    {"type": "eval", "path": "run_1/eval-security.md"},
    {"type": "eval", "path": "run_1/eval-performance.md"},
    {"type": "eval", "path": "run_1/eval-skeptic-owner.md"}
  ],
  "verdict": null
}
HSEOF
  else
    cat > "$dir/nodes/$node/handshake.json" << HSEOF
{
  "nodeId": "$node",
  "nodeType": "$ntype",
  "runId": "run_1",
  "status": "$status",
  "summary": "done",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [],
  "verdict": null
}
HSEOF
  fi
}

# ─────────────────────────────────────────────────────────────────
# 6. --strict rejects when a visited node is missing handshake
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 6: --strict rejects missing handshake for visited node"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
# Write handshake for review node (non-gate, needed for transition)
write_handshake "." "review" "review" "completed"
# Transition review → gate
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir . > /dev/null 2>&1
# Write completed handshake for gate (terminal node)
write_handshake "." "gate" "gate" "completed"
# Now delete review handshake to simulate missing
rm -f nodes/review/handshake.json
OUT=$($HARNESS finalize --dir . --strict 2>/dev/null || true)
assert_field_eq "$OUT" "['finalized']" "False" "6a: --strict rejects with missing handshake"
assert_contains "$OUT" "missing handshake" "6b: error mentions missing handshake"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# 7. --strict rejects when a handshake has validation errors
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 7: --strict rejects invalid handshake content"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
# Write valid handshake for review node for transition
write_handshake "." "review" "review" "completed"
# Transition review → gate
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir . > /dev/null 2>&1
# Now overwrite review handshake with invalid data (missing nodeType)
mkdir -p nodes/review
cat > nodes/review/handshake.json << 'EOF'
{
  "nodeId": "review",
  "runId": "run_1",
  "status": "completed",
  "summary": "done",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": []
}
EOF
# Write completed handshake for gate (terminal)
write_handshake "." "gate" "gate" "completed"
OUT=$($HARNESS finalize --dir . --strict 2>/dev/null || true)
assert_field_eq "$OUT" "['finalized']" "False" "7a: --strict rejects invalid handshake"
assert_contains "$OUT" "nodeType" "7b: error mentions nodeType issue"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# 8. --strict passes when all handshakes are valid
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 8: --strict passes when all handshakes are valid"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
# Write valid handshake for review node
write_handshake "." "review" "review" "completed"
# Transition review → gate
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir . > /dev/null 2>&1
# Write completed handshake for gate (terminal)
write_handshake "." "gate" "gate" "completed"
OUT=$($HARNESS finalize --dir . --strict 2>/dev/null || true)
assert_field_eq "$OUT" "['finalized']" "True" "8a: --strict passes with all valid handshakes"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# 9. finalize without --strict still works (no regression)
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 9: finalize without --strict ignores missing intermediate handshakes"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
write_handshake "." "review" "review" "completed"
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir . > /dev/null 2>&1
# Delete review handshake — should still finalize without --strict
rm -f nodes/review/handshake.json
write_handshake "." "gate" "gate" "completed"
OUT=$($HARNESS finalize --dir . 2>/dev/null || true)
assert_field_eq "$OUT" "['finalized']" "True" "9a: finalize without --strict succeeds despite missing intermediate handshake"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# 10. --strict with corrupt (unparseable) handshake → reject
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 10: --strict rejects corrupt handshake JSON"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
write_handshake "." "review" "review" "completed"
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir . > /dev/null 2>&1
# Corrupt the review handshake
mkdir -p nodes/review
echo "NOT VALID JSON{{{{" > nodes/review/handshake.json
write_handshake "." "gate" "gate" "completed"
OUT=$($HARNESS finalize --dir . --strict 2>/dev/null || true)
assert_field_eq "$OUT" "['finalized']" "False" "10a: --strict rejects corrupt handshake"
assert_contains "$OUT" "cannot parse" "10b: error mentions parse failure"
rm -rf "$D"
cd /tmp

print_results
