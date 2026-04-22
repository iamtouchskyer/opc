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

# GAP2-1: resolveDir — --dir . (resolved === cwd)
# ─────────────────────────────────────────────────────────────────
echo "── GAP2-1: resolveDir with --dir ."
D1=$(mktemp -d)
cd "$D1"
OUT=$($HARNESS init --flow build-verify --dir . 2>/dev/null)
assert_contains "$OUT" "created" "resolveDir --dir . resolves to cwd"
rm -rf "$D1"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-2: flow-core validateHandshakeData — artifact missing type/path
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-2: artifact missing type/path + baseDir"
D2=$(mktemp -d)
mkdir -p "$D2/nodes/test-node"
cat > "$D2/nodes/test-node/handshake.json" << 'EOF'
{
  "nodeId": "test-node",
  "nodeType": "build",
  "runId": "run_1",
  "status": "completed",
  "summary": "test",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "test-result"}, {"path": "foo.md"}],
  "verdict": null
}
EOF
cd "$D2"
OUT=$($HARNESS validate nodes/test-node/handshake.json 2>/dev/null)
assert_contains "$OUT" "missing type or path" "artifact missing type or path detected"
rm -rf "$D2"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-3: artifact path — exists at a.path but not join(baseDir, a.path)
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-3: artifact fallback to absolute path"
D3=$(mktemp -d)
mkdir -p "$D3/nodes/test-node"
ABSFILE=$(mktemp)
echo "content" > "$ABSFILE"
cat > "$D3/nodes/test-node/handshake.json" << EOF
{
  "nodeId": "test-node",
  "nodeType": "build",
  "runId": "run_1",
  "status": "completed",
  "summary": "test",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "test-result", "path": "$ABSFILE"}],
  "verdict": null
}
EOF
cd "$D3"
OUT=$($HARNESS validate nodes/test-node/handshake.json 2>/dev/null)
# Should NOT report file not found since absolute path exists
assert_not_contains "$OUT" "file not found" "artifact absolute path fallback works"
rm -rf "$D3" "$ABSFILE"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-4: cmdValidate softEvidence path — template with softEvidence=true
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-4: softEvidence path in validate"
D4=$(mktemp -d)
mkdir -p "$D4/nodes/exec-node"
# Create external flow with softEvidence
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/test-soft-ev.json" << 'EOF'
{
  "nodes": ["exec-node", "gate"],
  "edges": {"exec-node": {"PASS": "gate"}, "gate": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"exec-node": "execute", "gate": "gate"},
  "softEvidence": true,
  "opc_compat": ">=0.5"
}
EOF
cd "$D4"
# Init with the soft-evidence flow
$HARNESS init --flow test-soft-ev --dir . > /dev/null 2>&1
# Create handshake for execute node without evidence
cat > nodes/exec-node/handshake.json << 'EOF'
{
  "nodeId": "exec-node",
  "nodeType": "execute",
  "runId": "run_1",
  "status": "completed",
  "summary": "did stuff",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [],
  "verdict": null
}
EOF
# Validate should produce warning (softEvidence) not error
OUT=$($HARNESS validate nodes/exec-node/handshake.json 2>&1)
assert_contains "$OUT" "softEvidence" "softEvidence produces warning not error"
# Check valid=true (soft means warning only)
STDOUT=$($HARNESS validate nodes/exec-node/handshake.json 2>/dev/null)
assert_field_eq "$STDOUT" "['valid']" "True" "softEvidence valid=true (warning only)"
rm -rf "$D4"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-5: cmdValidate — flow-state.json exists but corrupt (catch block)
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-5: validate with corrupt flow-state.json → strict mode"
D5=$(mktemp -d)
mkdir -p "$D5/nodes/exec-node"
echo "NOT JSON" > "$D5/flow-state.json"
cat > "$D5/nodes/exec-node/handshake.json" << 'EOF'
{
  "nodeId": "exec-node",
  "nodeType": "execute",
  "runId": "run_1",
  "status": "completed",
  "summary": "did stuff",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [],
  "verdict": null
}
EOF
cd "$D5"
# Should fall back to strict (soft=false) → produce error not warning
OUT=$($HARNESS validate nodes/exec-node/handshake.json 2>/dev/null)
assert_contains "$OUT" "executor node missing evidence" "corrupt state → strict mode → error"
rm -rf "$D5"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-6: validate-context — field null/undefined skips rule (no error)
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-6: validate-context null field skips rule"
D6=$(mktemp -d)
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/test-ctx-null.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "opc_compat": ">=0.5",
  "contextSchema": {
    "a": {
      "required": [],
      "rules": {"optField": "non-empty-string"}
    }
  }
}
EOF
cd "$D6"
$HARNESS init --flow test-ctx-null --dir . > /dev/null 2>&1
echo '{"optField": null}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-ctx-null --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "null field skips rule validation"
rm -rf "$D6"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-7: transition without prior flow-state.json → fresh state
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-7: transition creates fresh state when no flow-state.json"
D7=$(mktemp -d)
mkdir -p "$D7/nodes/build"
# Write handshake for 'build' so pre-transition check passes
cat > "$D7/nodes/build/handshake.json" << 'EOF'
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
cd "$D7"
# Transition without prior init — should create state
OUT=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir . 2>/dev/null)
assert_field_eq "$OUT" "['allowed']" "True" "transition without init creates fresh state"
# Verify state was created
test -f flow-state.json
assert_contains "$(cat flow-state.json)" "code-review" "fresh state has correct currentNode"
rm -rf "$D7"
cd /tmp

print_results
