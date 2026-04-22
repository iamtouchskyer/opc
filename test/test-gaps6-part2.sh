#!/usr/bin/env bash
# test-gaps6-part2.sh — Final coverage closure (audit round 2) — Parts 8-13
set -uo pipefail

source "$(dirname "$0")/test-helpers.sh"

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qE "$needle"; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected pattern '$needle'"; FAIL=$((FAIL+1))
    echo "     GOT: $(echo "$haystack" | head -3)"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qE "$needle"; then
    echo "  ❌ $label — did NOT expect '$needle'"; FAIL=$((FAIL+1))
  else
    echo "  ✅ $label"; PASS=$((PASS+1))
  fi
}

assert_field_eq() {
  local json="$1" field="$2" expected="$3" label="$4"
  local actual
  actual=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d${field})" 2>/dev/null || echo "__PARSE_ERROR__")
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected $field=$expected, got '$actual'"; FAIL=$((FAIL+1))
  fi
}

ORIG_DIR=$(pwd)

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 8: 🔵 LOW — cmdSkip lock failure ==="
# flow-escape.mjs:36-39 — lock acquisition failure in skip
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 8.1: skip with live-PID lock file returns error"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
# Create lock with current PID (alive) — skip can't acquire
echo "{\"pid\": $$, \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"command\": \"test\"}" > flow-state.json.lock
OUT=$($HARNESS skip --dir . 2>/dev/null || true)
assert_contains "$OUT" "lock|error" "8.1a: skip fails when lock held by live process"
rm -f flow-state.json.lock
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 9: 🔵 LOW — review overlap with empty eval content ==="
# loop-tick.mjs:278 — linesA.length === 0 in overlap calculation
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 9.1: complete-tick review with minimal eval (few short lines)"
D=$(mktemp -d)
cd "$D"
mkdir -p .harness
cat > .harness/plan.md << 'EOF'
- u1.1: implement — build
- u1.2: review — check
EOF
$HARNESS init-loop --skip-scope --dir .harness > /dev/null 2>&1
$HARNESS next-tick --dir .harness > /dev/null 2>&1
# Create tiny eval with only very short lines (< 10 chars each)
echo "ok
ok
ok" > tiny-eval.md
OUT=$($HARNESS complete-tick --dir .harness --unit u1.1 --status completed --artifacts "$(pwd)/tiny-eval.md" 2>/dev/null)
assert_field_eq "$OUT" "['completed']" "True" "9.1a: complete-tick with tiny eval succeeds"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 10: 🔵 LOW — transition corrupt flow-state.json ==="
# flow-transition.mjs:60-63 — JSON.parse fails on corrupt state
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 10.1: transition with corrupt flow-state.json"
D=$(mktemp -d)
cd "$D"
mkdir -p nodes
echo "NOT JSON {{{" > flow-state.json
OUT=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir . 2>/dev/null)
assert_field_eq "$OUT" "['allowed']" "False" "10.1a: corrupt state blocks transition"
assert_contains "$OUT" "corrupt" "10.1b: error says corrupt"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 11: 🔵 LOW — transition tamper detection ==="
# flow-transition.mjs:69-72 — _written_by !== WRITER_SIG
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 11.1: transition with manually created state (no _written_by)"
D=$(mktemp -d)
cd "$D"
mkdir -p nodes
# Create state file WITHOUT _written_by and _write_nonce (manual edit)
cat > flow-state.json << 'EOF'
{
  "version": "1.0",
  "flowTemplate": "build-verify",
  "currentNode": "build",
  "entryNode": "build",
  "totalSteps": 0,
  "history": [],
  "edgeCounts": {}
}
EOF
OUT=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir . 2>/dev/null)
assert_field_eq "$OUT" "['allowed']" "False" "11.1a: manual state detected as tampered"
assert_contains "$OUT" "not written by opc-harness" "11.1b: error mentions direct edit"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 12: 🔵 LOW — transition currentNode mismatch ==="
# flow-transition.mjs:65-67 — state.currentNode !== from
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 12.1: transition from wrong node"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --entry build --dir . > /dev/null 2>&1
# State says currentNode=build, try to transition from code-review
OUT=$($HARNESS transition --from code-review --to test-design --verdict PASS --flow build-verify --dir . 2>/dev/null)
assert_field_eq "$OUT" "['allowed']" "False" "12.1a: wrong currentNode blocks transition"
assert_contains "$OUT" "cannot transition from a node you are not at" "12.1b: clear error message"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 13: 🔵 LOW — finalize terminal handshake not completed ==="
# flow-transition.mjs:428-434 — hsData.status !== "completed"
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 13.1: finalize with non-completed handshake status"
D=$(mktemp -d)
cd "$D"
# Use review: review → gate (gate PASS → null = terminal)
$HARNESS init --flow review --entry gate --dir . > /dev/null 2>&1
mkdir -p nodes/gate
cat > nodes/gate/handshake.json << 'EOF'
{"nodeId":"gate","nodeType":"gate","runId":"run_1","status":"in_progress","summary":"not done yet","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
EOF
OUT=$($HARNESS finalize --dir . 2>/dev/null)
assert_contains "$OUT" "in_progress" "13.1a: finalize rejects non-completed status"
assert_contains "$OUT" "expected.*completed" "13.1b: error says expected completed"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
# Cleanup
print_results
