#!/usr/bin/env bash
# test-schema-strict.sh — Tests for contextSchema load-time validation and finalize --strict
set -euo pipefail

HARNESS="node $HOME/.claude/skills/opc/bin/opc-harness.mjs"
PASS=0; FAIL=0

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
echo "=== PART 1: contextSchema load-time validation ==="
# ═══════════════════════════════════════════════════════════════════

# Ensure flows dir exists
mkdir -p "$HOME/.claude/flows"

# ─────────────────────────────────────────────────────────────────
# 1. contextSchema key referencing non-existent node → skip flow
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 1: contextSchema key not in nodes → flow skipped"
cat > "$HOME/.claude/flows/test-cs-badnode.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "contextSchema": {
    "nonexistent": {"required": ["foo"]}
  }
}
EOF
D=$(mktemp -d)
cd "$D"
# Flow should not be loaded — init should fail with unknown template
OUT=$($HARNESS init --flow test-cs-badnode --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "1a: flow with bad contextSchema node key is rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# 2. contextSchema.required is not an array → skip flow
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2: contextSchema required not array → flow skipped"
cat > "$HOME/.claude/flows/test-cs-badreq.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "contextSchema": {
    "a": {"required": "not-an-array"}
  }
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-badreq --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2a: flow with non-array required is rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# 3. contextSchema.required contains non-string → skip flow
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3: contextSchema required has non-string → flow skipped"
cat > "$HOME/.claude/flows/test-cs-badreqtype.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "contextSchema": {
    "a": {"required": ["valid", 123]}
  }
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-badreqtype --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "3a: flow with non-string in required array is rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# 4. contextSchema.rules has invalid rule name → skip flow
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 4: contextSchema rules with invalid rule name → flow skipped"
cat > "$HOME/.claude/flows/test-cs-badrule.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "contextSchema": {
    "a": {"rules": {"name": "bogus-rule"}}
  }
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-badrule --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "4a: flow with invalid rule name is rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# 5. Valid contextSchema → flow loads successfully
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 5: valid contextSchema → flow loads"
cat > "$HOME/.claude/flows/test-cs-valid.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "contextSchema": {
    "a": {
      "required": ["name", "config"],
      "rules": {"name": "non-empty-string", "config": "non-empty-object"}
    }
  }
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-valid --dir . 2>/dev/null || true)
assert_field_eq "$OUT" "['created']" "True" "5a: flow with valid contextSchema loads OK"
assert_field_eq "$OUT" "['flow']" "test-cs-valid" "5b: correct flow name"
rm -rf "$D"
cd /tmp

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 2: finalize --strict ==="
# ═══════════════════════════════════════════════════════════════════

# Helper: write a valid handshake for a node
write_handshake() {
  local dir="$1" node="$2" ntype="$3" status="$4"
  mkdir -p "$dir/nodes/$node"
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

# ═══════════════════════════════════════════════════════════════════
# Cleanup test flows
# ═══════════════════════════════════════════════════════════════════
rm -f "$HOME/.claude/flows/test-cs-badnode.json"
rm -f "$HOME/.claude/flows/test-cs-badreq.json"
rm -f "$HOME/.claude/flows/test-cs-badreqtype.json"
rm -f "$HOME/.claude/flows/test-cs-badrule.json"
rm -f "$HOME/.claude/flows/test-cs-valid.json"

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

[ "$FAIL" -eq 0 ] || exit 1
