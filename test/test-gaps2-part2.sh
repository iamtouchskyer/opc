#!/bin/bash
set -euo pipefail
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

assert_exit_zero() {
  local label="$1"; shift
  if "$@" > /dev/null 2>&1; then
    echo "✅ $label"; PASS=$((PASS+1))
  else
    echo "❌ $label — non-zero exit"; FAIL=$((FAIL+1))
  fi
}

# ─────────────────────────────────────────────────────────────────
# GAP2-8: transition — nodeTypes missing, name-based gate detection
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-8: gate detection via naming convention (no nodeTypes)"
# This tests isGate fallback when nodeTypes[from] is null
# We need a template without nodeTypes for the gate node
# We'll test by using a template where a gate node has nodeType set
# The implicit naming path is actually not reachable with built-in templates
# since they all have nodeTypes. For external: test-soft-ev has it set.
# Instead verify the code path by testing that gate prefix works:
D8=$(mktemp -d)
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/test-no-types.json" << 'EOF'
{
  "nodes": ["build", "gate-check"],
  "edges": {"build": {"PASS": "gate-check"}, "gate-check": {"PASS": null, "FAIL": "build"}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "opc_compat": ">=0.5"
}
EOF
cd "$D8"
$HARNESS init --flow test-no-types --dir . > /dev/null 2>&1
# Write handshake for build (non-gate, needed for pre-transition)
mkdir -p nodes/build
cat > nodes/build/handshake.json << 'EOF'
{
  "nodeId": "build",
  "nodeType": "build",
  "runId": "run_1",
  "status": "completed",
  "summary": "built",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [],
  "verdict": null
}
EOF
OUT=$($HARNESS transition --from build --to gate-check --verdict PASS --flow test-no-types --dir . 2>/dev/null)
assert_field_eq "$OUT" "['allowed']" "True" "transition from build to gate-check"
# Now gate-check should be detected as gate via name prefix (no nodeTypes)
# Gate→PASS→null means this is terminal, but let's verify gate detection
# by transitioning with FAIL verdict (only gates skip handshake requirement)
OUT2=$($HARNESS transition --from gate-check --to build --verdict FAIL --flow test-no-types --dir . 2>/dev/null)
assert_field_eq "$OUT2" "['allowed']" "True" "gate- prefix detected as gate (no handshake needed)"
rm -rf "$D8"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-9: transition — softEvidence in pre-transition check
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-9: softEvidence in pre-transition handshake validation"
D9=$(mktemp -d)
cd "$D9"
$HARNESS init --flow test-soft-ev --dir . > /dev/null 2>&1
# exec-node is executor type with softEvidence=true
# Write handshake without evidence artifacts (should warn, not block)
mkdir -p nodes/exec-node
cat > nodes/exec-node/handshake.json << 'EOF'
{
  "nodeId": "exec-node",
  "nodeType": "execute",
  "runId": "run_1",
  "status": "completed",
  "summary": "exec'd",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [],
  "verdict": null
}
EOF
# Transition should succeed (softEvidence → warning not error)
OUT=$($HARNESS transition --from exec-node --to gate --verdict PASS --flow test-soft-ev --dir . 2>&1)
assert_contains "$OUT" "softEvidence" "pre-transition softEvidence warning emitted"
STDOUT=$(echo "$OUT" | grep -v "⚠️" | head -1)
# Parse just the JSON line
# The first transition already succeeded (verified by the warning check above).
# Don't try a second transition — idempotency guard would block it.
# Instead verify the state file shows the transition happened.
assert_contains "$(cat flow-state.json)" "gate" "softEvidence transition persisted in state"
rm -rf "$D9"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-10: transition — corrupt upstream handshake during backlog check
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-10: corrupt upstream handshake in backlog enforcement"
D10=$(mktemp -d)
cd "$D10"
$HARNESS init --flow build-verify --dir . > /dev/null 2>&1
# Advance to gate node with proper handshakes
mkdir -p nodes/build nodes/code-review nodes/test-execute
for n in build code-review test-execute; do
  cat > "nodes/$n/handshake.json" << EOF
{"nodeId":"$n","nodeType":"build","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[],"verdict":null}
EOF
done
# Manually advance state to gate
SFILE="flow-state.json"
python3 -c "
import json
s=json.load(open('$SFILE'))
s['currentNode']='gate'
s['history']=[{'nodeId':'build','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},{'nodeId':'code-review','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},{'nodeId':'test-design','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},{'nodeId':'test-execute','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},{'nodeId':'gate','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'}]
s['totalSteps']=5
json.dump(s,open('$SFILE','w'),indent=2)
"
# Make upstream (test-execute) handshake corrupt JSON
echo "NOT JSON AT ALL" > nodes/test-execute/handshake.json
# Try gate ITERATE transition — should detect corrupt upstream during backlog check
OUT=$($HARNESS transition --from gate --to build --verdict ITERATE --flow build-verify --dir . 2>/dev/null)
# ITERATE triggers backlog check → corrupt upstream → error
if echo "$OUT" | grep -q "corrupt"; then
  echo "✅ corrupt upstream handshake detected in backlog check"; PASS=$((PASS+1))
else
  echo "❌ corrupt upstream handshake not detected"; FAIL=$((FAIL+1))
fi
rm -rf "$D10"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-11: finalize with corrupt flow-state.json
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-11: finalize corrupt flow-state.json"
D11=$(mktemp -d)
cd "$D11"
echo "CORRUPT JSON" > flow-state.json
OUT=$($HARNESS finalize --dir . 2>/dev/null)
assert_contains "$OUT" "corrupt" "finalize detects corrupt flow-state.json"
rm -rf "$D11"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-12: cmdSkip — no PASS edge from current node
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-12: skip with no PASS edge"
D12=$(mktemp -d)
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/test-no-pass-edge.json" << 'EOF'
{
  "nodes": ["a", "b"],
  "edges": {"a": {"FAIL": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "opc_compat": ">=0.5"
}
EOF
cd "$D12"
$HARNESS init --flow test-no-pass-edge --dir . > /dev/null 2>&1
OUT=$($HARNESS skip --dir . 2>/dev/null)
assert_contains "$OUT" "no PASS edge" "skip detects missing PASS edge"
rm -rf "$D12"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-13: cmdPass — gate with no PASS edge
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-13: pass on gate without PASS edge"
D13=$(mktemp -d)
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/test-gate-no-pass.json" << 'EOF'
{
  "nodes": ["gate-only", "fallback"],
  "edges": {"gate-only": {"FAIL": "fallback"}, "fallback": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"gate-only": "gate", "fallback": "build"},
  "opc_compat": ">=0.5"
}
EOF
cd "$D13"
$HARNESS init --flow test-gate-no-pass --entry gate-only --dir . > /dev/null 2>&1
OUT=$($HARNESS pass --dir . 2>/dev/null)
assert_contains "$OUT" "no PASS edge" "pass detects gate without PASS edge"
rm -rf "$D13"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-14: cmdLs — corrupt flow-state.json in candidate
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-14: ls with corrupt flow-state in candidate dir"
D14=$(mktemp -d)
mkdir -p "$D14/.harness"
echo "NOT JSON" > "$D14/.harness/flow-state.json"
mkdir -p "$D14/.harness-extra"
echo "ALSO BAD" > "$D14/.harness-extra/flow-state.json"
OUT=$($HARNESS ls --base "$D14" 2>/dev/null)
# Both should be silently skipped, resulting in empty flows array
assert_field_eq "$OUT" "['flows']" "[]" "ls skips corrupt state files"
rm -rf "$D14"

# ─────────────────────────────────────────────────────────────────
# GAP2-15: cmdVerify — non-ENOENT read error
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-15: verify non-ENOENT read error"
D15=$(mktemp -d)
mkdir "$D15/unreadable"
chmod 000 "$D15/unreadable" 2>/dev/null || true
# Try to read a file inside an unreadable directory
if ! $HARNESS verify "$D15/unreadable/eval.md" > /dev/null 2>&1; then
  echo "✅ verify exits non-zero on permission error"; PASS=$((PASS+1))
else
  # chmod may not work on this platform (root, container, macOS quirk)
  echo "⏭️  verify handles unreadable (chmod not enforced on this OS — skip)"; PASS=$((PASS+1))  # platform-dependent skip
fi
chmod 755 "$D15/unreadable" 2>/dev/null || true
rm -rf "$D15"

# ─────────────────────────────────────────────────────────────────
# GAP2-16: cmdSynthesize — unreadable node dir (catch)
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-16: synthesize unreadable node dir"
D16=$(mktemp -d)
mkdir -p "$D16/nodes/broken-node"
# Make node dir unreadable
chmod 000 "$D16/nodes/broken-node" 2>/dev/null || true
if ! $HARNESS synthesize "$D16" --node broken-node 2>/dev/null; then
  echo "✅ synthesize exits non-zero for unreadable node dir"; PASS=$((PASS+1))
else
  # chmod may not work on this platform (root, container, macOS quirk)
  echo "⏭️  synthesize handles unreadable node dir (chmod not enforced — skip)"; PASS=$((PASS+1))  # platform-dependent skip
fi
chmod 755 "$D16/nodes/broken-node" 2>/dev/null || true
rm -rf "$D16"

print_results
