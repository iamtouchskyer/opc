#!/bin/bash
# Coverage gap tests — Part 1 (CG-1 through CG-5)
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

# Create idea-factory fixture for testing (not a built-in template)
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
  if [ -z "$actual" ]; then
    echo "  ❌ $desc — no JSON output (field=$field)"
    FAIL=$((FAIL + 1))
    return
  fi
  actual=$(echo "$actual" | tr -d '"')
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — expected '$expected', got '$actual'"
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
    echo "  ❌ $desc — pattern '$pattern' found but should not be"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

assert_exit_nonzero() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>/dev/null; then
    echo "  ❌ $desc — expected nonzero exit"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

# ═══════════════════════════════════════════════════════════════
echo "=== CG-1: maxLoopsPerEdge limit ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-1.1: Edge loop limit blocks transition ---"
rm -rf .h-edge && $HARNESS init --flow build-verify --entry gate --dir .h-edge >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-edge/flow-state.json'))
d['edgeCounts']['gate→build'] = d['maxLoopsPerEdge']
json.dump(d, open('.h-edge/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS transition --from gate --to build --verdict FAIL --flow build-verify --dir .h-edge 2>/dev/null)
assert_field_eq "edge limit blocked" "$OUT" "allowed" "false"
assert_contains "maxLoopsPerEdge msg" "$OUT" "maxLoopsPerEdge"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-2: maxNodeReentry limit in transition ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-2.1: Node reentry limit blocks transition ---"
rm -rf .h-reentry && $HARNESS init --flow build-verify --entry gate --dir .h-reentry >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-reentry/flow-state.json'))
for i in range(d['maxNodeReentry']):
    d['history'].append({'nodeId': 'build', 'runId': f'run_{i}', 'timestamp': '2024-01-01T00:00:00Z'})
json.dump(d, open('.h-reentry/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS transition --from gate --to build --verdict FAIL --flow build-verify --dir .h-reentry 2>/dev/null)
assert_field_eq "reentry blocked" "$OUT" "allowed" "false"
assert_contains "maxNodeReentry msg" "$OUT" "maxNodeReentry"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-3: Idempotency guard ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-3.1: Duplicate transition within 5s window blocked ---"
rm -rf .h-idemp && $HARNESS init --flow build-verify --dir .h-idemp >/dev/null 2>/dev/null
mkdir -p .h-idemp/nodes/build
cat > .h-idemp/nodes/build/handshake.json << 'HS'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","summary":"done","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
$HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .h-idemp >/dev/null 2>/dev/null
mkdir -p .h-idemp/nodes/code-review
cat > .h-idemp/nodes/code-review/handshake.json << 'HS'
{"nodeId":"code-review","nodeType":"review","runId":"run_1","status":"completed","summary":"done","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
OUT=$($HARNESS transition --from code-review --to test-execute --verdict PASS --flow build-verify --dir .h-idemp 2>/dev/null)
rm -rf .h-idemp2 && $HARNESS init --flow build-verify --entry gate --dir .h-idemp2 >/dev/null 2>/dev/null
$HARNESS transition --from gate --to build --verdict FAIL --flow build-verify --dir .h-idemp2 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-idemp2/flow-state.json'))
d['currentNode'] = 'gate'
json.dump(d, open('.h-idemp2/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS transition --from gate --to build --verdict FAIL --flow build-verify --dir .h-idemp2 2>/dev/null)
assert_field_eq "idempotency blocked" "$OUT" "allowed" "false"
assert_contains "idempotency guard" "$OUT" "idempotency"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-4: Backlog enforcement ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-4.1: Gate ITERATE blocked when upstream has warnings but no backlog ---"
rm -rf .h-backlog && $HARNESS init --flow build-verify --entry gate --dir .h-backlog >/dev/null 2>/dev/null
mkdir -p .h-backlog/nodes/test-execute
cat > .h-backlog/nodes/test-execute/handshake.json << 'HS'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["evidence.txt"],"findings":{"warning":2,"critical":0}}
HS
echo "test evidence" > .h-backlog/nodes/test-execute/evidence.txt
OUT=$($HARNESS transition --from gate --to build --verdict ITERATE --flow build-verify --dir .h-backlog 2>/dev/null)
assert_field_eq "backlog required" "$OUT" "allowed" "false"
assert_contains "backlog missing msg" "$OUT" "backlog"

echo ""
echo "--- CG-4.2: Gate passes when backlog has matching entries ---"
rm -rf .h-backlog2 && $HARNESS init --flow build-verify --entry gate --dir .h-backlog2 >/dev/null 2>/dev/null
mkdir -p .h-backlog2/nodes/test-execute
cat > .h-backlog2/nodes/test-execute/handshake.json << 'HS'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["evidence.txt"],"findings":{"warning":2,"critical":0}}
HS
echo "test evidence" > .h-backlog2/nodes/test-execute/evidence.txt
cat > .h-backlog2/backlog.md << 'BL'
# Backlog
- [ ] 🟡 Missing input validation [test-execute]
- [ ] 🟡 Error handling too broad [test-execute]
BL
OUT=$($HARNESS transition --from gate --to build --verdict ITERATE --flow build-verify --dir .h-backlog2 2>/dev/null)
assert_field_eq "backlog satisfied" "$OUT" "allowed" "true"

echo ""
echo "--- CG-4.3: Insufficient backlog entries rejected ---"
rm -rf .h-backlog3 && $HARNESS init --flow build-verify --entry gate --dir .h-backlog3 >/dev/null 2>/dev/null
mkdir -p .h-backlog3/nodes/test-execute
cat > .h-backlog3/nodes/test-execute/handshake.json << 'HS'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["evidence.txt"],"findings":{"warning":3,"critical":0}}
HS
echo "test evidence" > .h-backlog3/nodes/test-execute/evidence.txt
cat > .h-backlog3/backlog.md << 'BL'
- [ ] 🟡 Only one entry [test-execute]
BL
OUT=$($HARNESS transition --from gate --to build --verdict ITERATE --flow build-verify --dir .h-backlog3 2>/dev/null)
assert_field_eq "insufficient entries" "$OUT" "allowed" "false"
assert_contains "entries count" "$OUT" "only has"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-5: validate-context rules ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-5.1: idea-factory contextSchema validation ---"
rm -rf .h-ctx && $HARNESS init --flow idea-factory --dir .h-ctx >/dev/null 2>/dev/null
echo '{}' > .h-ctx/flow-context.json
OUT=$($HARNESS validate-context --flow idea-factory --node discover --dir .h-ctx 2>/dev/null)
assert_field_eq "schema validation" "$OUT" "valid" "false"

echo ""
echo "--- CG-5.2: flow-context.json not found ---"
rm -rf .h-ctx2 && mkdir -p .h-ctx2
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/test-ctx-flow.json" << 'CTX'
{
  "nodes": ["step1", "step2"],
  "edges": {"step1": {"PASS": "step2"}, "step2": {"PASS": null}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5},
  "nodeTypes": {"step1": "build", "step2": "review"},
  "contextSchema": {
    "step1": {
      "required": ["topic", "count"],
      "rules": {"count": "positive-integer", "topic": "non-empty-string"}
    }
  },
  "opc_compat": ">=0.5"
}
CTX
$HARNESS init --flow test-ctx-flow --dir .h-ctx2 >/dev/null 2>/dev/null
OUT=$($HARNESS validate-context --flow test-ctx-flow --node step1 --dir .h-ctx2 2>/dev/null)
assert_field_eq "no context file" "$OUT" "valid" "false"
assert_contains "context not found" "$OUT" "flow-context.json not found"

echo ""
echo "--- CG-5.3: Required field missing ---"
echo '{"topic": "test"}' > .h-ctx2/flow-context.json
OUT=$($HARNESS validate-context --flow test-ctx-flow --node step1 --dir .h-ctx2 2>/dev/null)
assert_field_eq "field missing" "$OUT" "valid" "false"
assert_contains "missing count" "$OUT" "count"

echo ""
echo "--- CG-5.4: Rule validation fails ---"
echo '{"topic": "", "count": -1}' > .h-ctx2/flow-context.json
OUT=$($HARNESS validate-context --flow test-ctx-flow --node step1 --dir .h-ctx2 2>/dev/null)
assert_field_eq "rule fails" "$OUT" "valid" "false"
assert_contains "fails rule" "$OUT" "fails rule"

echo ""
echo "--- CG-5.5: Valid context passes ---"
echo '{"topic": "hello", "count": 5}' > .h-ctx2/flow-context.json
OUT=$($HARNESS validate-context --flow test-ctx-flow --node step1 --dir .h-ctx2 2>/dev/null)
assert_field_eq "valid context" "$OUT" "valid" "true"

echo ""
echo "--- CG-5.6: Corrupt context JSON ---"
echo 'not json' > .h-ctx2/flow-context.json
OUT=$($HARNESS validate-context --flow test-ctx-flow --node step1 --dir .h-ctx2 2>/dev/null)
assert_field_eq "corrupt context" "$OUT" "valid" "false"
assert_contains "parse error" "$OUT" "cannot parse"

# Cleanup
rm -f "$HOME/.claude/flows/test-ctx-flow.json"
rm -f "$HOME/.claude/flows/idea-factory.json"
print_results
