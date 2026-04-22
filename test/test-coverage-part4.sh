#!/bin/bash
# Coverage gap tests — Part 4 (CG-14 through CG-19)
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

# Create fixtures needed by CG-15 and CG-16
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

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-14: External flow validation ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-14.1: External flow with bad edge source rejected ---"
cat > "$HOME/.claude/flows/bad-edge-src.json" << 'FL'
{
  "nodes": ["a", "b"],
  "edges": {"nonexistent": {"PASS": "b"}, "a": {"PASS": "b"}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5}
}
FL
OUT=$($HARNESS init --flow bad-edge-src --dir .h-badsrc 2>&1 || true)
assert_contains "bad source rejected" "$OUT" "unknown flow\|not in nodes\|Unknown flow"

echo ""
echo "--- CG-14.2: External flow with bad edge target rejected ---"
cat > "$HOME/.claude/flows/bad-edge-tgt.json" << 'FL'
{
  "nodes": ["a", "b"],
  "edges": {"a": {"PASS": "nonexistent"}, "b": {"PASS": null}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5}
}
FL
OUT=$($HARNESS init --flow bad-edge-tgt --dir .h-badtgt 2>&1 || true)
assert_contains "bad target rejected" "$OUT" "unknown flow\|not in nodes\|Unknown flow"

echo ""
echo "--- CG-14.3: External flow with invalid nodeType rejected ---"
cat > "$HOME/.claude/flows/bad-nodetype.json" << 'FL'
{
  "nodes": ["a", "b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5},
  "nodeTypes": {"a": "invalid-type", "b": "build"}
}
FL
OUT=$($HARNESS init --flow bad-nodetype --dir .h-badnt 2>&1 || true)
assert_contains "bad nodetype rejected" "$OUT" "unknown flow\|invalid\|Unknown flow"

echo ""
echo "--- CG-14.4: Prototype pollution name skipped ---"
cat > "$HOME/.claude/flows/__proto__.json" << 'FL'
{"nodes": ["a"], "edges": {"a": {"PASS": null}}, "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5}}
FL
OUT=$($HARNESS init --flow __proto__ --dir .h-proto 2>&1 || true)
assert_contains "proto skipped" "$OUT" "unknown flow\|Unknown flow"

echo ""
echo "--- CG-14.5: Missing required fields rejected ---"
cat > "$HOME/.claude/flows/bad-missing.json" << 'FL'
{"nodes": []}
FL
OUT=$($HARNESS init --flow bad-missing --dir .h-badmiss 2>&1 || true)
assert_contains "missing fields rejected" "$OUT" "unknown flow\|Unknown flow"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-15: satisfiesVersion ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-15.1: Flow with impossible version requirement rejected ---"
cat > "$HOME/.claude/flows/future-ver.json" << 'FL'
{
  "nodes": ["a", "b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5},
  "opc_compat": ">=99.99"
}
FL
OUT=$($HARNESS init --flow future-ver --dir .h-futver 2>&1 || true)
assert_contains "version rejected" "$OUT" "unknown flow\|Unknown flow"

echo ""
echo "--- CG-15.2: Valid test-ctx-flow still loads ---"
OUT=$($HARNESS init --flow test-ctx-flow --dir .h-ctxcheck 2>/dev/null)
assert_field_eq "ctx flow loads" "$OUT" "created" "true"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-16: softEvidence in validate ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-16.1: softEvidence downgrades to warning ---"
rm -rf .h-soft && $HARNESS init --flow test-ctx-flow --dir .h-soft >/dev/null 2>/dev/null
mkdir -p .h-soft/nodes/step1
cat > .h-soft/nodes/step1/handshake.json << 'HS'
{"nodeId":"step1","nodeType":"execute","runId":"run_1","status":"completed","summary":"x","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
rm -rf .h-soft2 && $HARNESS init --flow idea-factory --dir .h-soft2 >/dev/null 2>/dev/null
mkdir -p .h-soft2/nodes/discover
cat > .h-soft2/nodes/discover/handshake.json << 'HS'
{"nodeId":"discover","nodeType":"execute","runId":"run_1","status":"completed","summary":"x","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
OUT=$($HARNESS validate .h-soft2/nodes/discover/handshake.json 2>&1)
assert_contains "validate output" "$OUT" "valid\|warning\|evidence"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-17: next-tick plan hash drift ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-17.1: Modified plan triggers warning ---"
rm -rf .h-drift && mkdir -p .h-drift
cat > .h-drift/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — review it
  - verify: echo ok
PLAN
$HARNESS init-loop --skip-scope --plan .h-drift/plan.md --dir .h-drift >/dev/null 2>/dev/null
$HARNESS complete-tick --unit F1.1 --artifacts dummy.txt --description "built" --dir .h-drift >/dev/null 2>/dev/null
cat >> .h-drift/plan.md << 'PLAN'
- F1.3: fix — fix findings
  - verify: echo ok
PLAN
OUT=$($HARNESS next-tick --dir .h-drift 2>&1)
assert_contains "plan hash drift" "$OUT" "plan.*changed\|hash.*drift\|modified"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-18: next-tick unknown unit terminates ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-18.1: next_unit not in plan → auto-terminate ---"
rm -rf .h-unknown && mkdir -p .h-unknown
cat > .h-unknown/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — review it
  - verify: echo ok
PLAN
$HARNESS init-loop --skip-scope --plan .h-unknown/plan.md --dir .h-unknown >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-unknown/loop-state.json'))
d['next_unit'] = 'nonexistent'
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
json.dump(d, open('.h-unknown/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-unknown 2>/dev/null)
assert_field_eq "unknown unit terminates" "$OUT" "terminate" "true"
assert_contains "not in plan" "$OUT" "not.*plan\|not found"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-19: Duplicate unit ID in plan ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-19.1: Duplicate IDs warned ---"
rm -rf .h-dup && mkdir -p .h-dup
cat > .h-dup/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.1: review — review it
  - verify: echo ok
PLAN
OUT=$($HARNESS init-loop --skip-scope --plan .h-dup/plan.md --dir .h-dup 2>&1)
assert_contains "dup warning" "$OUT" "duplicate\|Duplicate"

# Cleanup test flows
rm -f "$HOME/.claude/flows/test-ctx-flow.json"
rm -f "$HOME/.claude/flows/bad-edge-src.json"
rm -f "$HOME/.claude/flows/bad-edge-tgt.json"
rm -f "$HOME/.claude/flows/bad-nodetype.json"
rm -f "$HOME/.claude/flows/__proto__.json"
rm -f "$HOME/.claude/flows/bad-missing.json"
rm -f "$HOME/.claude/flows/future-ver.json"
rm -f "$HOME/.claude/flows/idea-factory.json"

print_results
