#!/bin/bash
# Coverage gap tests — Part 2 (CG-6 through CG-9)
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

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-6: Stall detection ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-6.1: 3 consecutive same unit → stall ---"
rm -rf .h-stall && mkdir -p .h-stall
cat > .h-stall/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — review it
  - verify: echo ok
PLAN
$HARNESS init-loop --skip-scope --plan .h-stall/plan.md --dir .h-stall >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-stall/loop-state.json'))
d['tick'] = 3
d['next_unit'] = 'F1.1'
d['status'] = 'idle'
d['_tick_history'] = [
    {'unit': 'F1.1', 'tick': 1, 'status': 'failed'},
    {'unit': 'F1.1', 'tick': 2, 'status': 'failed'},
    {'unit': 'F1.1', 'tick': 3, 'status': 'failed'}
]
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
json.dump(d, open('.h-stall/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-stall 2>/dev/null)
assert_field_eq "stall detected" "$OUT" "terminate" "true"
assert_contains "stalled msg" "$OUT" "stalled"

echo ""
echo "--- CG-6.2: A↔B oscillation for 6 ticks → stall ---"
rm -rf .h-osc && mkdir -p .h-osc
cat > .h-osc/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — review it
  - verify: echo ok
PLAN
$HARNESS init-loop --skip-scope --plan .h-osc/plan.md --dir .h-osc >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-osc/loop-state.json'))
d['tick'] = 6
d['next_unit'] = 'F1.1'
d['status'] = 'idle'
d['_tick_history'] = [
    {'unit': 'F1.1', 'tick': 1, 'status': 'failed'},
    {'unit': 'F1.2', 'tick': 2, 'status': 'failed'},
    {'unit': 'F1.1', 'tick': 3, 'status': 'failed'},
    {'unit': 'F1.2', 'tick': 4, 'status': 'failed'},
    {'unit': 'F1.1', 'tick': 5, 'status': 'failed'},
    {'unit': 'F1.2', 'tick': 6, 'status': 'failed'}
]
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
json.dump(d, open('.h-osc/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-osc 2>/dev/null)
assert_field_eq "oscillation detected" "$OUT" "terminate" "true"
assert_contains "oscillation msg" "$OUT" "oscillation"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-7: Wall-clock deadline ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-7.1: Expired deadline terminates ---"
rm -rf .h-wall && mkdir -p .h-wall
cat > .h-wall/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — review it
  - verify: echo ok
PLAN
$HARNESS init-loop --skip-scope --plan .h-wall/plan.md --dir .h-wall >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-wall/loop-state.json'))
d['next_unit'] = 'F1.1'
d['_started_at'] = '2020-01-01T00:00:00Z'
d['_max_duration_hours'] = 24
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
json.dump(d, open('.h-wall/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-wall 2>/dev/null)
assert_field_eq "wall-clock terminated" "$OUT" "terminate" "true"
assert_contains "wall-clock msg" "$OUT" "wall-clock"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-8: validateFixArtifacts ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-8.1: Fix with unchanged git HEAD fails ---"
rm -rf .h-fix && mkdir -p .h-fix
cat > .h-fix/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — review it
  - verify: echo ok
- F1.3: fix — fix findings
  - verify: echo ok
PLAN
$HARNESS init-loop --skip-scope --plan .h-fix/plan.md --dir .h-fix >/dev/null 2>/dev/null
python3 -c "
import json, subprocess
d = json.load(open('.h-fix/loop-state.json'))
d['tick'] = 2
d['next_unit'] = 'F1.3'
d['completed_ticks'] = [
    {'tick': 1, 'unit': 'F1.1', 'status': 'completed', 'artifacts': ['dummy.txt']},
    {'tick': 2, 'unit': 'F1.2', 'status': 'completed', 'artifacts': []}
]
head = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()
d['_git_head'] = head
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
json.dump(d, open('.h-fix/loop-state.json', 'w'), indent=2)
"
echo '{}' > fix-artifact.json
OUT=$($HARNESS complete-tick --unit F1.3 --artifacts fix-artifact.json --description "fix stuff" --dir .h-fix 2>/dev/null)
assert_contains "git HEAD unchanged" "$OUT" "git HEAD unchanged"

echo ""
echo "--- CG-8.2: Fix without finding references warns ---"
echo "fix" > fix-file.txt
git add fix-file.txt && git commit -q -m "fix"
echo 'no references here' > fix-artifact.json
OUT=$($HARNESS complete-tick --unit F1.3 --artifacts fix-artifact.json --description "fix stuff" --dir .h-fix 2>/dev/null)
assert_contains "no references warning" "$OUT" "reference"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-9: cmdReport ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-9.1: Report from role eval files ---"
rm -rf .h-report && mkdir -p .h-report/.harness
cat > .h-report/.harness/evaluation-wave-1-security.md << 'EVAL'
# Security Review
VERDICT: PASS FINDINGS[1]
🔵 Minor concern — utils.js:5 — add input validation
Reasoning: user input passes through unchecked
EVAL
cat > .h-report/.harness/evaluation-wave-1-perf.md << 'EVAL'
# Performance Review
VERDICT: PASS FINDINGS[0]
EVAL
OUT=$($HARNESS report .h-report --mode review --task "test")
assert_contains "has agents" "$OUT" "agents"
assert_contains "has summary" "$OUT" "summary"
assert_contains "has timestamp" "$OUT" "timestamp"
assert_contains "security role" "$OUT" "security"

echo ""
echo "--- CG-9.2: Report from single eval files ---"
rm -rf .h-report2 && mkdir -p .h-report2/.harness
cat > .h-report2/.harness/evaluation-wave-1.md << 'EVAL'
# Review
VERDICT: PASS FINDINGS[1]
🟡 Warning — api.js:10 — rate limiting needed
Reasoning: no rate limit on public endpoint
EVAL
OUT=$($HARNESS report .h-report2 --mode review --task "test")
assert_contains "evaluator role" "$OUT" "evaluator"
assert_contains "warning count" "$OUT" "warning"

echo ""
echo "--- CG-9.3: Report coordinator counts ---"
OUT=$($HARNESS report .h-report --mode review --task "test" --challenged 2 --dismissed 1 --downgraded 0)
assert_contains "challenged" "$OUT" "challenged"

print_results
