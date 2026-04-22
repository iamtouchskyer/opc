#!/usr/bin/env bash
set -euo pipefail

# Test: checkpoint (tick-N-summary.md) + resume prompt

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="node $SCRIPT_DIR/bin/opc-harness.mjs"
PASS=0; FAIL=0

check() {
  local label="$1" cond="$2"
  if eval "$cond"; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label"
    FAIL=$((FAIL + 1))
  fi
}

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

# All harness commands run from TMPD, paths are relative to TMPD
H() { (cd "$TMPD" && $HARNESS "$@" 2>&1); }

setup_loop() {
  local reldir="$1" next_unit="$2" tick="${3:-0}"
  local absdir="$TMPD/$reldir"
  mkdir -p "$absdir"
  cat > "$absdir/loop-state.json" << LOOPEOF
{
  "tick": $tick,
  "unit": "A.1",
  "next_unit": "$next_unit",
  "status": "in_progress",
  "plan_file": "$absdir/plan.md",
  "_written_by": "opc-harness",
  "_write_nonce": "test123",
  "_last_modified": "2026-01-01T00:00:00.000Z",
  "_tick_history": [],
  "_git_head": null,
  "_task_scope": []
}
LOOPEOF
  cat > "$absdir/plan.md" << 'PLANEOF'
## Units

- A.1: implement — Build the auth module
- A.2: review — Review auth module
- A.3: implement — Build the dashboard
PLANEOF
}

echo "=== TEST GROUP 1: Checkpoint written by complete-tick ==="

setup_loop "run1" "A.1" 0
echo '{"tests_run": 5, "passed": 5, "exitCode": 0, "_command": "npm test"}' > "$TMPD/run1/test-result.json"

RESULT=$(H complete-tick --unit A.1 --artifacts "$TMPD/run1/test-result.json" --description "Built auth module" --dir run1)
check "complete-tick succeeds" 'echo "$RESULT" | grep -q "\"completed\":true"'
check "tick-1-summary.md created" '[ -f "$TMPD/run1/tick-1-summary.md" ]'
check "checkpoint has unit name" 'grep -q "A.1" "$TMPD/run1/tick-1-summary.md"'
check "checkpoint has description" 'grep -q "Built auth module" "$TMPD/run1/tick-1-summary.md"'
check "checkpoint has next unit" 'grep -q "A.2" "$TMPD/run1/tick-1-summary.md"'
check "checkpoint has resume context" 'grep -q "Resume Context" "$TMPD/run1/tick-1-summary.md"'

echo ""
echo "=== TEST GROUP 2: Resume prompt in next-tick ==="

setup_loop "run2" "A.2" 1

# Status must be "completed" (not "in_progress") for next-tick to proceed
# Use perl for portability (macOS sed -i '' vs Linux sed -i)
perl -pi -e 's/"in_progress"/"completed"/' "$TMPD/run2/loop-state.json"

cat > "$TMPD/run2/tick-1-summary.md" << 'CPEOF'
# Checkpoint: Tick 1
- **Unit**: A.1 (implement)
- **Status**: completed
CPEOF

RESULT2=$(H next-tick --dir run2)
check "next-tick returns ready" 'echo "$RESULT2" | grep -q "\"ready\":true"'
check "next-tick has resumePrompt" 'echo "$RESULT2" | grep -q "resumePrompt"'
check "resumePrompt mentions next unit" 'echo "$RESULT2" | grep -q "A.2"'
check "resumePrompt includes checkpoint" 'echo "$RESULT2" | grep -q "Last Checkpoint"'

echo ""
echo "=== TEST GROUP 3: Missing loop state ==="

mkdir -p "$TMPD/run3"
RESULT3=$(H next-tick --dir run3)
check "missing state returns error JSON" 'echo "$RESULT3" | grep -q "loop-state.json not found"'

echo ""
echo "=== TEST GROUP 4: Corrupt loop state ==="

mkdir -p "$TMPD/run4"
echo "not json {{{" > "$TMPD/run4/loop-state.json"
RESULT4=$(H next-tick --dir run4)
check "corrupt state returns error JSON" 'echo "$RESULT4" | grep -q "corrupt"'

echo ""
echo "=== TEST GROUP 5: Complete-tick with missing state ==="

mkdir -p "$TMPD/run5"
RESULT5=$(H complete-tick --unit A.1 --artifacts "" --description "test" --dir run5)
check "missing state returns error" 'echo "$RESULT5" | grep -q "loop-state.json not found"'

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[ "$FAIL" -eq 0 ] || exit 1
