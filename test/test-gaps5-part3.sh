#!/usr/bin/env bash
# test-gaps5 — split part
set -uo pipefail
# NOTE: no set -e — we handle errors explicitly per assertion

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

mkdir -p "$HOME/.claude/flows"
ORIG_DIR=$(pwd)

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 13: 🔵 LOW — cmdPass with gate node ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 13.1: cmdPass on terminal gate (PASS → null)"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --entry gate --dir . > /dev/null 2>&1
OUT=$($HARNESS pass --dir . 2>/dev/null || true)
# The → is a unicode arrow in the JSON, match "finalize"
assert_contains "$OUT" "finalize" "13.1a: pass on terminal gate says use finalize"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 14: 🔵 LOW — loop-init getGitHeadHash null ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 14.1: init-loop --skip-scope in non-git dir → _git_head is null"
D=$(mktemp -d)
cd "$D"
rm -rf .git
mkdir -p .harness
cat > .harness/plan.md << 'EOF'
- u1.1: implement — build
- u1.2: review — check
EOF
OUT=$($HARNESS init-loop --skip-scope --dir .harness 2>/dev/null)
assert_field_eq "$OUT" "['initialized']" "True" "14.1a: init-loop --skip-scope works in non-git dir"
STATE=$(cat .harness/loop-state.json)
GIT_HEAD=$(echo "$STATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('_git_head'))" 2>/dev/null || echo "__ERROR__")
if [ "$GIT_HEAD" = "None" ]; then
  echo "  ✅ 14.1b: _git_head is null in non-git dir"; PASS=$((PASS+1))
else
  echo "  ❌ 14.1b: expected _git_head=None, got '$GIT_HEAD'"; FAIL=$((FAIL+1))
fi
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 15: 🔵 LOW — file-lock clean acquisition/release ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 15.1: lock file acquisition + release cycle is clean"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
OUT=$($HARNESS skip --dir . 2>/dev/null)
assert_contains "$OUT" "skipped|next" "15.1a: skip acquires and releases lock cleanly"
if [ ! -f "flow-state.json.lock" ]; then
  echo "  ✅ 15.1b: lock file cleaned up after command"; PASS=$((PASS+1))
else
  echo "  ❌ 15.1b: lock file still exists after command"; FAIL=$((FAIL+1))
fi
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 16: 🔵 LOW — cmdLs empty + corrupt scan ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 16.1: ls with base dir containing no harness dirs"
D=$(mktemp -d)
mkdir -p "$D/subdir"
OUT=$($HARNESS ls --base "$D" 2>/dev/null)
assert_field_eq "$OUT" "['flows']" "[]" "16.1a: ls empty dir returns empty flows array"

echo ""
echo "── 16.2: ls with corrupt flow-state in one of the harness dirs"
mkdir -p "$D/.harness"
echo "NOT JSON" > "$D/.harness/flow-state.json"
OUT=$($HARNESS ls --base "$D" 2>/dev/null)
assert_field_eq "$OUT" "['flows']" "[]" "16.2a: ls skips corrupt flow-state.json"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 17: viz --json edges + loopbacks ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 17.1: viz --json includes FAIL and ITERATE loopbacks"
OUT=$($HARNESS viz --flow build-verify --json 2>/dev/null)
assert_contains "$OUT" '"FAIL"' "17.1a: viz --json has FAIL loopback"
assert_contains "$OUT" '"ITERATE"' "17.1b: viz --json has ITERATE loopback"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 18: validate-context all four RULE_VALIDATOR types ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 18.1: test all four rule types (pass + fail)"
D=$(mktemp -d)
cd "$D"

cat > "$HOME/.claude/flows/test-allrules.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "contextSchema": {
    "a": {
      "required": ["name", "items", "config", "count"],
      "rules": {
        "name": "non-empty-string",
        "items": "non-empty-array",
        "config": "non-empty-object",
        "count": "positive-integer"
      }
    }
  }
}
EOF
$HARNESS init --flow test-allrules --dir . > /dev/null 2>&1

# All rules pass
echo '{"name":"hello","items":[1],"config":{"a":1},"count":5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "18.1a: all four rules pass"

# Each rule fails individually
echo '{"name":"","items":[1],"config":{"a":1},"count":5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "non-empty-string" "18.1b: empty string fails non-empty-string"

echo '{"name":"ok","items":[],"config":{"a":1},"count":5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "non-empty-array" "18.1c: empty array fails non-empty-array"

echo '{"name":"ok","items":[1],"config":{},"count":5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "non-empty-object" "18.1d: empty object fails non-empty-object"

echo '{"name":"ok","items":[1],"config":{"a":1},"count":0}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "positive-integer" "18.1e: zero fails positive-integer"

echo '{"name":"ok","items":[1],"config":{"a":1},"count":-3}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "positive-integer" "18.1f: negative fails positive-integer"

echo '{"name":"ok","items":[1],"config":{"a":1},"count":1.5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "positive-integer" "18.1g: float fails positive-integer (not integer)"

# missing required field
echo '{"name":"ok","items":[1],"config":{"a":1}}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "missing required" "18.1h: missing field triggers required error"
assert_not_contains "$OUT" "positive-integer" "18.1i: missing field doesn't trigger rule error"

rm -f "$HOME/.claude/flows/test-allrules.json"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
# Cleanup
rm -f "$HOME/.claude/flows/test-vc-goodrule.json" 2>/dev/null || true
rm -f "$HOME/.claude/flows/test-allrules.json" 2>/dev/null || true
rm -f "$HOME/.claude/flows/readme.txt" 2>/dev/null || true

print_results


print_results
