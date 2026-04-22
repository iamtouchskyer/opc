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
# Cleanup test flows
# ═══════════════════════════════════════════════════════════════════
rm -f "$HOME/.claude/flows/test-cs-badnode.json"
rm -f "$HOME/.claude/flows/test-cs-badreq.json"
rm -f "$HOME/.claude/flows/test-cs-badreqtype.json"
rm -f "$HOME/.claude/flows/test-cs-badrule.json"
rm -f "$HOME/.claude/flows/test-cs-valid.json"

print_results
