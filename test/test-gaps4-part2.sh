#!/usr/bin/env bash
# test-gaps4 — split part
set -euo pipefail

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

assert_exit_nonzero() {
  local label="$1"; shift
  if "$@" > /dev/null 2>&1; then
    echo "  ❌ $label — expected nonzero exit"; FAIL=$((FAIL+1))
  else
    echo "  ✅ $label"; PASS=$((PASS+1))
  fi
}

mkdir -p "$HOME/.claude/flows"


# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.7: opc_compat version too high → skip flow"
# flow-templates.mjs L202-205: version constraint not met
cat > "$HOME/.claude/flows/test-cs-compat-high.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "opc_compat": ">=99.99"
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-compat-high --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.7a: opc_compat too high → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.8: malformed JSON in external flow file → skip"
# flow-templates.mjs L207-209: JSON parse error
cat > "$HOME/.claude/flows/test-cs-malformed.json" << 'EOF'
THIS IS NOT JSON AT ALL!!!!
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-malformed --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.8a: malformed JSON → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.9: missing required fields (no nodes array) → skip"
# flow-templates.mjs L124-127: missing nodes/edges/limits
cat > "$HOME/.claude/flows/test-cs-noflds.json" << 'EOF'
{
  "edges": {"a": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3}
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-noflds --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.9a: missing nodes → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.10: empty nodes array → skip"
# flow-templates.mjs L124: nodes.length === 0
cat > "$HOME/.claude/flows/test-cs-emptynodes.json" << 'EOF'
{
  "nodes": [],
  "edges": {},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5}
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-emptynodes --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.10a: empty nodes → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.11: prototype pollution guard (__proto__ name)"
# flow-templates.mjs L120: skip __proto__
cat > "$HOME/.claude/flows/__proto__.json" << 'EOF'
{
  "nodes": ["a"],
  "edges": {"a": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5}
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow __proto__ --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.11a: __proto__ name → flow rejected"
rm -f "$HOME/.claude/flows/__proto__.json"
rm -rf "$D"
cd /tmp

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 3: flow-core.mjs remaining edge branches ==="
# ═══════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.1: validate-context with unknown rule in RULE_VALIDATORS"
# flow-core.mjs L289-292: unknown rule name
D=$(mktemp -d)
cd "$D"
# Create a flow with contextSchema that passes load-time validation
# but has a field with a rule that is valid at load time.
# We test validate-context with a manually crafted context.
cat > "$HOME/.claude/flows/test-vc-goodrule.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "contextSchema": {
    "a": {
      "required": ["name"],
      "rules": {"name": "non-empty-string", "count": "positive-integer"}
    }
  }
}
EOF
$HARNESS init --flow test-vc-goodrule --dir . > /dev/null 2>&1
# Write context with count=0 (fails positive-integer rule)
echo '{"name":"valid","count":0}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-goodrule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "3.1a: count=0 fails positive-integer rule"
assert_contains "$OUT" "positive-integer" "3.1b: error mentions rule name"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.2: validate-context with missing required field"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow test-vc-goodrule --dir . > /dev/null 2>&1
echo '{"count":5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-goodrule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "3.2a: missing 'name' field fails validation"
assert_contains "$OUT" "missing required" "3.2b: error mentions missing required"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.3: validate-context with non-empty-object rule failure"
D=$(mktemp -d)
cd "$D"
cat > "$HOME/.claude/flows/test-vc-objrule.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "contextSchema": {
    "a": {
      "rules": {"config": "non-empty-object"}
    }
  }
}
EOF
$HARNESS init --flow test-vc-objrule --dir . > /dev/null 2>&1
echo '{"config":{}}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-objrule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "3.3a: empty object fails non-empty-object rule"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.4: validate-context with non-empty-array rule failure"
D=$(mktemp -d)
cd "$D"
cat > "$HOME/.claude/flows/test-vc-arrrule.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "contextSchema": {
    "a": {
      "rules": {"items": "non-empty-array"}
    }
  }
}
EOF
$HARNESS init --flow test-vc-arrrule --dir . > /dev/null 2>&1
echo '{"items":[]}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-arrrule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "3.4a: empty array fails non-empty-array rule"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.5: validate-context — no contextSchema for requested node (happy path)"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow test-vc-goodrule --dir . > /dev/null 2>&1
echo '{}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-goodrule --node b --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "3.5a: no schema for node b → valid"
assert_contains "$OUT" "no contextSchema" "3.5b: note mentions no contextSchema for node"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.6: validate-context — corrupt flow-context.json"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow test-vc-goodrule --dir . > /dev/null 2>&1
echo 'NOT-JSON' > flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-goodrule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "3.6a: corrupt context JSON fails validation"
assert_contains "$OUT" "cannot parse" "3.6b: error mentions parse failure"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.7: validate-context — no flow-context.json file"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow test-vc-goodrule --dir . > /dev/null 2>&1
# Don't create flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-goodrule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "3.7a: missing context file fails validation"
assert_contains "$OUT" "flow-context.json not found" "3.7b: error mentions missing file"
rm -rf "$D"
cd /tmp

rm -f "$HOME/.claude/flows/test-cs-compat-high.json"
rm -f "$HOME/.claude/flows/test-cs-malformed.json"
rm -f "$HOME/.claude/flows/test-cs-noflds.json"
rm -f "$HOME/.claude/flows/test-cs-emptynodes.json"
rm -f "$HOME/.claude/flows/__proto__.json"
rm -f "$HOME/.claude/flows/test-vc-goodrule.json"
rm -f "$HOME/.claude/flows/test-vc-objrule.json"
rm -f "$HOME/.claude/flows/test-vc-arrrule.json"

print_results
