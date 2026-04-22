#!/usr/bin/env bash
# test-gaps3 — split part
set -euo pipefail

source "$(dirname "$0")/test-helpers.sh"

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

# ─────────────────────────────────────────────────────────────────
# REAL-1: Executor happy-path evidence — valid evidence → no error
# flow-core.mjs:155-164 — hasEvidence=true path
# ─────────────────────────────────────────────────────────────────
echo "── REAL-1: executor with valid evidence → no error"
D=$(mktemp -d)
mkdir -p "$D/nodes/exec-node"
cat > "$D/nodes/exec-node/handshake.json" << 'EOF'
{
  "nodeId": "exec-node",
  "nodeType": "execute",
  "runId": "run_1",
  "status": "completed",
  "summary": "ran tests",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "test-result", "path": "results.json"}],
  "verdict": null
}
EOF
echo '{}' > "$D/nodes/exec-node/results.json"
cd "$D"
OUT=$($HARNESS validate nodes/exec-node/handshake.json 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "executor with test-result evidence is valid"
assert_not_contains "$OUT" "evidence" "no evidence error when evidence present"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# REAL-2: non-empty-object rule rejects array
# flow-core.mjs:231
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── REAL-2: non-empty-object rule rejects array"
D=$(mktemp -d)
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/test-obj-rule.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "opc_compat": ">=0.5",
  "contextSchema": {
    "a": {
      "required": [],
      "rules": {"config": "non-empty-object"}
    }
  }
}
EOF
cd "$D"
$HARNESS init --flow test-obj-rule --dir . > /dev/null 2>&1
echo '{"config": [1,2,3]}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-obj-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "array fails non-empty-object rule"
assert_contains "$OUT" "non-empty-object" "error references rule name"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# REAL-3: positive-integer rule rejects float
# flow-core.mjs:233
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── REAL-3: positive-integer rule rejects float"
D=$(mktemp -d)
cat > "$HOME/.claude/flows/test-int-rule.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "opc_compat": ">=0.5",
  "contextSchema": {
    "a": {
      "required": [],
      "rules": {"count": "positive-integer"}
    }
  }
}
EOF
cd "$D"
$HARNESS init --flow test-int-rule --dir . > /dev/null 2>&1
echo '{"count": 1.5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-int-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "float 1.5 fails positive-integer rule"
# Also test 0 (not positive)
echo '{"count": 0}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-int-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "zero fails positive-integer rule"
# Also test negative
echo '{"count": -3}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-int-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "negative fails positive-integer rule"
# Happy path: valid integer
echo '{"count": 5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-int-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "positive integer passes rule"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# REAL-4: Corrupt upstream handshake during backlog enforcement
# flow-transition.mjs:206-212
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── REAL-4: corrupt upstream handshake in backlog enforcement"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --dir . > /dev/null 2>&1
# Manually build state at gate with proper history
mkdir -p nodes/build nodes/code-review nodes/test-execute
# build handshake with warnings (triggers backlog check)
cat > nodes/build/handshake.json << 'EOF'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[],"verdict":null}
EOF
cat > nodes/code-review/handshake.json << 'EOF'
{"nodeId":"code-review","nodeType":"review","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[],"verdict":null}
EOF
# test-execute handshake is the upstream of gate — make it have warnings then corrupt it
cat > nodes/test-execute/handshake.json << 'EOF'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[],"verdict":null,"findings":{"warning":2}}
EOF
# Advance state to gate
python3 -c "
import json
s=json.load(open('flow-state.json'))
s['currentNode']='gate'
s['history']=[
  {'nodeId':'build','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},
  {'nodeId':'code-review','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},
  {'nodeId':'test-execute','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},
  {'nodeId':'gate','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'}
]
s['totalSteps']=4
s['edgeCounts']={}
json.dump(s,open('flow-state.json','w'),indent=2)
"
# Now corrupt the upstream handshake AFTER state was built
echo "CORRUPT JSON {{{{" > nodes/test-execute/handshake.json
# ITERATE from gate triggers backlog check on upstream test-execute
OUT=$($HARNESS transition --from gate --to build --verdict ITERATE --flow build-verify --dir . 2>/dev/null)
assert_contains "$OUT" "corrupt" "corrupt upstream handshake detected"
assert_field_eq "$OUT" "['allowed']" "False" "transition blocked by corrupt upstream"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# REAL-5: Missing upstream handshake skips backlog check
# flow-transition.mjs:170-172
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── REAL-5: missing upstream handshake → backlog check skipped"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --dir . > /dev/null 2>&1
mkdir -p nodes/build nodes/code-review nodes/test-execute
cat > nodes/build/handshake.json << 'EOF'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[],"verdict":null}
EOF
cat > nodes/code-review/handshake.json << 'EOF'
{"nodeId":"code-review","nodeType":"review","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[],"verdict":null}
EOF
# DO NOT create test-execute handshake — upstream is missing
python3 -c "
import json
s=json.load(open('flow-state.json'))
s['currentNode']='gate'
s['history']=[
  {'nodeId':'build','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},
  {'nodeId':'code-review','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},
  {'nodeId':'test-execute','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},
  {'nodeId':'gate','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'}
]
s['totalSteps']=4
s['edgeCounts']={}
json.dump(s,open('flow-state.json','w'),indent=2)
"
# PASS from gate — no upstream handshake → backlog check should be silently skipped → transition allowed
OUT=$($HARNESS transition --from gate --to build --verdict ITERATE --flow build-verify --dir . 2>/dev/null)
# Without upstream handshake, no findings.warning to trigger backlog enforcement
assert_field_eq "$OUT" "['allowed']" "True" "missing upstream handshake → backlog skipped → allowed"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# REAL-6: detectTestScript — "type-check" and "tsc" alternate keys
# loop-helpers.mjs:93-94
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── REAL-6: detectTestScript alternate typecheck keys"
D=$(mktemp -d)
cd "$D"
# Test "type-check" key
cat > package.json << 'EOF'
{"scripts": {"type-check": "tsc --noEmit"}}
EOF
cat > plan.md << 'PLAN'
- F1.1: implement — build
- F1.2: review — review
PLAN
OUT=$($HARNESS init-loop --skip-scope --plan plan.md --dir . 2>/dev/null)
assert_contains "$OUT" "typecheck" "type-check key detected as typecheck"
# Now test "tsc" key
echo '{"scripts": {"tsc": "tsc"}}' > package.json
rm -f loop-state.json
OUT=$($HARNESS init-loop --skip-scope --plan plan.md --dir . 2>/dev/null)
assert_contains "$OUT" "typecheck" "tsc key detected as typecheck"
# Also test "lint" via "eslint" key
echo '{"scripts": {"eslint": "eslint ."}}' > package.json
rm -f loop-state.json
OUT=$($HARNESS init-loop --skip-scope --plan plan.md --dir . 2>/dev/null)
assert_contains "$OUT" "lint" "eslint key detected as lint"
rm -rf "$D"
cd /tmp

rm -f "$HOME/.claude/flows/test-obj-rule.json"
rm -f "$HOME/.claude/flows/test-int-rule.json"

print_results
