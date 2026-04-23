#!/bin/bash
# End-to-end tests for opc-harness flow commands — Part 3 (Groups 7-11)
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/idea-factory.json" << 'FIXTURE'
{
  "nodes": ["discover", "validate", "build", "gate", "synthesize", "pitch"],
  "edges": {
    "discover": {"PASS": "validate"},
    "validate": {"PASS": "build"},
    "build": {"PASS": "gate"},
    "gate": {"PASS": "pitch", "FAIL": "synthesize", "ITERATE": "build"},
    "synthesize": {"PASS": "pitch"},
    "pitch": {"PASS": null}
  },
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 15, "maxNodeReentry": 5},
  "nodeTypes": {"discover": "discussion", "validate": "review", "build": "build", "gate": "gate", "synthesize": "discussion", "pitch": "discussion"},
  "softEvidence": true,
  "opc_compat": ">=0.5",
  "contextSchema": {
    "discover": {
      "required": ["topic"],
      "rules": {"topic": "non-empty-string"}
    }
  }
}
FIXTURE

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

assert_not_contains() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -q "$pattern"; then
    echo "  ❌ $desc — pattern '$pattern' unexpectedly found"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

assert_file_exists() {
  local desc="$1" path="$2"
  if [ -e "$path" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — not found: $path"
    FAIL=$((FAIL + 1))
  fi
}

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 7: escape hatches ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 7.1: skip ---"
rm -rf .h-skip && $HARNESS init --flow build-verify --dir .h-skip >/dev/null 2>/dev/null
OUT=$($HARNESS skip --dir .h-skip 2>/dev/null)
assert_field_eq "skip from build" "$OUT" "skipped" "\"build\""
assert_field_eq "skip to code-review" "$OUT" "next" "\"code-review\""
assert_file_exists "skip handshake" ".h-skip/nodes/build/handshake.json"
SKIPPED=$(python3 -c "import json; print(json.load(open('.h-skip/nodes/build/handshake.json')).get('skipped',False))")
if [ "$SKIPPED" = "True" ]; then
  echo "  ✅ handshake.skipped=true"
  PASS=$((PASS + 1))
else
  echo "  ❌ skipped=$SKIPPED"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 7.2: skip terminal node ---"
rm -rf .h-skip2 && $HARNESS init --flow review --entry gate --dir .h-skip2 >/dev/null 2>/dev/null
OUT=$($HARNESS skip --dir .h-skip2 2>/dev/null)
assert_contains "terminal skip blocked" "$OUT" "terminal"

echo ""
echo "--- 7.3: skip no state ---"
rm -rf .h-skip3 && mkdir -p .h-skip3
OUT=$($HARNESS skip --dir .h-skip3 2>/dev/null)
assert_contains "no state" "$OUT" "no flow-state"

echo ""
echo "--- 7.4: pass (gate) ---"
rm -rf .h-pass && $HARNESS init --flow build-verify --entry gate --dir .h-pass >/dev/null 2>/dev/null
OUT=$($HARNESS pass --dir .h-pass 2>/dev/null)
assert_contains "terminal gate" "$OUT" "terminal"

echo ""
echo "--- 7.5: pass (non-gate) ---"
rm -rf .h-pass2 && $HARNESS init --flow build-verify --dir .h-pass2 >/dev/null 2>/dev/null
OUT=$($HARNESS pass --dir .h-pass2 2>/dev/null)
assert_contains "not a gate" "$OUT" "not a gate"

echo ""
echo "--- 7.6: stop ---"
rm -rf .h-stop && $HARNESS init --flow build-verify --dir .h-stop >/dev/null 2>/dev/null
OUT=$($HARNESS stop --dir .h-stop)
assert_field_eq "stopped" "$OUT" "stopped" "true"
STATUS=$(python3 -c "import json; print(json.load(open('.h-stop/flow-state.json'))['status'])")
if [ "$STATUS" = "stopped" ]; then
  echo "  ✅ state.status=stopped"
  PASS=$((PASS + 1))
else
  echo "  ❌ status=$STATUS"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 7.7: stop already completed ---"
rm -rf .h-fin && $HARNESS init --flow review --dir .h-fin >/dev/null 2>/dev/null
python3 -c "import json; d=json.load(open('.h-fin/flow-state.json')); d['status']='completed'; json.dump(d,open('.h-fin/flow-state.json','w'),indent=2)"
OUT=$($HARNESS stop --dir .h-fin)
assert_field_eq "cant stop completed" "$OUT" "stopped" "false"

echo ""
echo "--- 7.8: goto ---"
rm -rf .h-goto && $HARNESS init --flow build-verify --dir .h-goto >/dev/null 2>/dev/null
OUT=$($HARNESS goto test-design --dir .h-goto)
assert_field_eq "goto target" "$OUT" "goto" "\"test-design\""
CUR=$(python3 -c "import json; print(json.load(open('.h-goto/flow-state.json'))['currentNode'])")
if [ "$CUR" = "test-design" ]; then
  echo "  ✅ jumped to test-design"
  PASS=$((PASS + 1))
else
  echo "  ❌ currentNode=$CUR"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 7.9: goto invalid node ---"
OUT=$($HARNESS goto nonexistent --dir .h-goto)
assert_contains "node not found" "$OUT" "not a node"

echo ""
echo "--- 7.10: goto reentry limit ---"
rm -rf .h-reentry && $HARNESS init --flow build-verify --dir .h-reentry >/dev/null 2>/dev/null
for i in 1 2 3; do
  $HARNESS goto build --dir .h-reentry >/dev/null
done
OUT=$($HARNESS goto build --dir .h-reentry)
assert_contains "edge limit" "$OUT" "maxLoopsPerEdge"

echo ""
echo "--- 7.11: ls ---"
OUT=$($HARNESS ls --base .)
assert_contains "flows array" "$OUT" "flows"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 8: validate-context ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 8.1: No contextSchema ---"
rm -rf .h-init && $HARNESS init --flow build-verify --dir .h-init >/dev/null 2>/dev/null
OUT=$($HARNESS validate-context --flow build-verify --node build --dir .h-init)
assert_field_eq "no schema ok" "$OUT" "valid" "true"

echo ""
echo "--- 8.2: Missing context file ---"
rm -rf .h-ctx && mkdir -p .h-ctx
OUT=$($HARNESS validate-context --flow build-verify --node build --dir .h-ctx)
assert_field_eq "no schema = valid" "$OUT" "valid" "true"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 9: viz ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 9.1: Viz ASCII ---"
OUT=$($HARNESS viz --flow build-verify)
assert_contains "has build" "$OUT" "build"
assert_contains "has gate" "$OUT" "gate"

echo ""
echo "--- 9.2: Viz JSON ---"
OUT=$($HARNESS viz --flow build-verify --json)
assert_contains "nodes array" "$OUT" "nodes"
assert_contains "loopbacks" "$OUT" "loopbacks"

echo ""
echo "--- 9.3: Viz with state ---"
rm -rf .h-trans && $HARNESS init --flow build-verify --dir .h-trans >/dev/null 2>/dev/null
mkdir -p .h-trans/nodes/build
cat > .h-trans/nodes/build/handshake.json << 'HS'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","summary":"built","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
sleep 1
$HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .h-trans 2>/dev/null
OUT=$($HARNESS viz --flow build-verify --dir .h-trans)
assert_contains "marker symbols" "$OUT" "✅"

echo ""
echo "--- 9.4: Viz unknown flow ---"
OUT=$($HARNESS viz --flow nonexistent 2>&1) || true
assert_contains "unknown flow" "$OUT" "unknown flow template"

# Cleanup idea-factory fixture
rm -f "$HOME/.claude/flows/idea-factory.json"
print_results
