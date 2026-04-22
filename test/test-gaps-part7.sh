#!/bin/bash
set -e
source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

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

echo ""
echo "=== GAP-14: Loop-advance gaps ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 14.1: next-tick with no loop-state ---"
rm -rf .h-la1 && mkdir -p .h-la1
OUT=$($HARNESS next-tick --dir .h-la1 2>/dev/null)
assert_field_eq "no state terminate" "$OUT" "terminate" "true"
assert_contains "no state msg" "$OUT" "not found"

echo ""
echo "--- 14.2: next-tick on terminated pipeline ---"
rm -rf .h-la2 && mkdir -p .h-la2
cat > .h-la2/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-la2/plan.md --dir .h-la2 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-la2/loop-state.json'))
d['status'] = 'pipeline_complete'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-la2/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-la2 2>/dev/null)
assert_field_eq "terminated" "$OUT" "terminate" "true"
assert_contains "already msg" "$OUT" "already"

echo ""
echo "--- 14.3: 2 consecutive same unit does NOT stall ---"
rm -rf .h-la3 && mkdir -p .h-la3
cat > .h-la3/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-la3/plan.md --dir .h-la3 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-la3/loop-state.json'))
d['tick'] = 2
d['next_unit'] = 'F1.1'
d['status'] = 'idle'
d['_tick_history'] = [
    {'unit': 'F1.1', 'tick': 1, 'status': 'failed'},
    {'unit': 'F1.1', 'tick': 2, 'status': 'failed'}
]
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-la3/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-la3 2>/dev/null)
assert_field_eq "2x no stall" "$OUT" "ready" "true"
assert_not_contains "no stall msg" "$OUT" "stalled"

echo ""
echo "--- 14.4: 4 alternating does NOT oscillate ---"
rm -rf .h-la4 && mkdir -p .h-la4
cat > .h-la4/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-la4/plan.md --dir .h-la4 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-la4/loop-state.json'))
d['tick'] = 4
d['next_unit'] = 'F1.1'
d['status'] = 'idle'
d['_tick_history'] = [
    {'unit': 'F1.1', 'tick': 1, 'status': 'failed'},
    {'unit': 'F1.2', 'tick': 2, 'status': 'failed'},
    {'unit': 'F1.1', 'tick': 3, 'status': 'failed'},
    {'unit': 'F1.2', 'tick': 4, 'status': 'failed'}
]
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-la4/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-la4 2>/dev/null)
assert_field_eq "4x no oscillation" "$OUT" "ready" "true"
assert_not_contains "no osc msg" "$OUT" "oscillation"

echo ""
echo "--- 14.5: Backlog drain gate at pipeline completion ---"
rm -rf .h-la5 && mkdir -p .h-la5
cat > .h-la5/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-la5/plan.md --dir .h-la5 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-la5/loop-state.json'))
d['tick'] = 2
d['next_unit'] = None
d['status'] = 'idle'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-la5/loop-state.json', 'w'), indent=2)
"
# Create backlog with open items — drain gate should block termination
cat > .h-la5/backlog.md << 'BL'
# Backlog
- [ ] Fix input validation
- [x] Add error handling
- [ ] Improve test coverage
BL
OUT=$($HARNESS next-tick --dir .h-la5 2>/dev/null)
assert_field_eq "drain blocks termination" "$OUT" "terminate" "false"
assert_field_eq "drain required flag" "$OUT" "drain_required" "true"
assert_contains "backlog surfaced" "$OUT" "backlog\|open_items"

# Force-terminate bypasses drain gate
OUT=$($HARNESS next-tick --dir .h-la5 --force-terminate 2>/dev/null)
assert_field_eq "force-terminate works" "$OUT" "terminate" "true"

echo ""
echo "--- 14.6: next-tick no plan file ---"
rm -rf .h-la6 && mkdir -p .h-la6
cat > .h-la6/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-la6/plan.md --dir .h-la6 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-la6/loop-state.json'))
d['next_unit'] = 'F1.1'
d['status'] = 'idle'
d['_written_by'] = 'opc-harness'
# Point to non-existent plan
d['plan_file'] = '.h-la6/deleted-plan.md'
json.dump(d, open('.h-la6/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-la6 2>/dev/null)
assert_contains "no plan error" "$OUT" "plan file.*not found\|plan.*not found"

echo ""
echo "--- 14.7: next-tick tamper warning ---"
rm -rf .h-la7 && mkdir -p .h-la7
cat > .h-la7/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-la7/plan.md --dir .h-la7 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-la7/loop-state.json'))
d['next_unit'] = 'F1.1'
d['status'] = 'idle'
d['_written_by'] = 'someone-else'
d['_write_nonce'] = None
json.dump(d, open('.h-la7/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-la7 2>/dev/null)
assert_contains "tamper warning" "$OUT" "not written by\|possible direct edit"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-15: Report + validate-context edge cases ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 15.1: Report finding status filtering ---"
rm -rf .h-rp1 && mkdir -p .h-rp1/.harness
cat > .h-rp1/.harness/evaluation-wave-1-engineer.md << 'EVAL'
# Engineer Review
VERDICT: PASS FINDINGS[2]
🔴 Critical — auth.js:1 — XSS vulnerability
→ Sanitize input
Reasoning: user input unescaped
🔵 Minor — style.css:1 — use variables
EVAL
OUT=$($HARNESS report .h-rp1 --mode review --task "test")
# Both findings should be counted (both default to status=accepted)
assert_contains "critical counted" "$OUT" '"critical": 1'
assert_contains "suggestion counted" "$OUT" '"suggestion": 1'

echo ""
echo "--- 15.2: validate-context unknown template ---"
OUT=$($HARNESS validate-context --flow nonexistent-flow --node x --dir .h-la1 2>/dev/null)
assert_field_eq "vc unknown tpl" "$OUT" "valid" "false"
assert_contains "vc unknown msg" "$OUT" "unknown flow"

echo ""
echo "--- 15.3: validate-context unknown rule name (rejected at load-time) ---"
# Create external flow with unknown rule — now rejected at load-time by contextSchema validation
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/bad-rule.json" << 'FL'
{
  "nodes": ["s1", "s2"],
  "edges": {"s1": {"PASS": "s2"}, "s2": {"PASS": null}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5},
  "nodeTypes": {"s1": "build", "s2": "gate"},
  "contextSchema": {"s1": {"required": ["x"], "rules": {"x": "unknown-rule-type"}}},
  "opc_compat": ">=0.5"
}
FL
# Flow should fail to load due to contextSchema validation — init returns unknown template
OUT=$($HARNESS init --flow bad-rule --dir .h-vc1 2>/dev/null || true)
assert_contains "unknown rule rejected at load" "$OUT" "unknown flow template"
# validate-context also returns unknown since the flow never loaded
OUT=$($HARNESS validate-context --flow bad-rule --node s1 --dir .h-vc1 2>/dev/null || true)
assert_contains "unknown rule msg" "$OUT" "unknown flow"
rm -f "$HOME/.claude/flows/bad-rule.json"

print_results
