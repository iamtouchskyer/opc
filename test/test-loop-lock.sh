#!/usr/bin/env bash
set -euo pipefail

# Test: file locking in loop-tick and loop-advance

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

H() { (cd "$TMPD" && $HARNESS "$@" 2>&1); }

setup_loop() {
  local reldir="$1" next_unit="$2" tick="${3:-0}" status="${4:-completed}"
  local absdir="$TMPD/$reldir"
  mkdir -p "$absdir"
  cat > "$absdir/loop-state.json" << LOOPEOF
{
  "tick": $tick,
  "unit": "A.1",
  "next_unit": "$next_unit",
  "status": "$status",
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

echo "=== TEST GROUP 1: Lock conflict on complete-tick ==="

setup_loop "lock1" "A.1" 0
echo '{"tests_run": 5, "passed": 5, "exitCode": 0, "_command": "npm test"}' > "$TMPD/lock1/test-result.json"

# Create a lock file simulating another process (use current PID so it looks alive)
cat > "$TMPD/lock1/loop-state.json.lock" << LOCKEOF
{
  "pid": $$,
  "timestamp": "2026-04-22T00:00:00.000Z",
  "command": "complete-tick"
}
LOCKEOF

RESULT=$(H complete-tick --unit A.1 --artifacts "$TMPD/lock1/test-result.json" --description "test" --dir lock1 || true)
check "lock conflict returns error" 'echo "$RESULT" | grep -q "could not acquire lock"'

# Verify state is untouched
check "state not corrupted" 'python3 -c "import json; json.load(open(\"$TMPD/lock1/loop-state.json\"))" 2>/dev/null'

# Clean up lock
rm -f "$TMPD/lock1/loop-state.json.lock"

echo ""
echo "=== TEST GROUP 2: Lock conflict on next-tick ==="

setup_loop "lock2" "A.2" 1

cat > "$TMPD/lock2/loop-state.json.lock" << LOCKEOF
{
  "pid": $$,
  "timestamp": "2026-04-22T00:00:00.000Z",
  "command": "next-tick"
}
LOCKEOF

RESULT2=$(H next-tick --dir lock2 || true)
check "next-tick lock conflict returns error" 'echo "$RESULT2" | grep -q "could not acquire lock"'

rm -f "$TMPD/lock2/loop-state.json.lock"

echo ""
echo "=== TEST GROUP 3: Stale lock (dead PID) is cleaned up ==="

setup_loop "lock3" "A.2" 1

# Use a PID that is almost certainly dead
cat > "$TMPD/lock3/loop-state.json.lock" << LOCKEOF
{
  "pid": 999999,
  "timestamp": "2026-04-22T00:00:00.000Z",
  "command": "old-process"
}
LOCKEOF

RESULT3=$(H next-tick --dir lock3)
check "stale lock recovered — next-tick proceeds" 'echo "$RESULT3" | grep -qE "\"ready\":|\"terminate\":|\"reason\":"'
check "stale lock file removed" '[ ! -f "$TMPD/lock3/loop-state.json.lock" ]'

echo ""
echo "=== TEST GROUP 4: Normal operation acquires and releases lock ==="

setup_loop "lock4" "A.1" 0
echo '{"tests_run": 5, "passed": 5, "exitCode": 0, "_command": "npm test"}' > "$TMPD/lock4/test-result.json"

RESULT4=$(H complete-tick --unit A.1 --artifacts "$TMPD/lock4/test-result.json" --description "Built auth" --dir lock4)
check "complete-tick succeeds with lock" 'echo "$RESULT4" | grep -q "\"completed\":true"'
check "lock released after complete-tick" '[ ! -f "$TMPD/lock4/loop-state.json.lock" ]'

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[ "$FAIL" -eq 0 ] || exit 1
