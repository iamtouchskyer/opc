#!/usr/bin/env bash
set -euo pipefail

# Test: crash recovery (in_progress timeout) + VALID_LOOP_STATUSES export

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
  local reldir="$1" next_unit="$2" tick="${3:-0}" status="${4:-in_progress}" since="${5:-}"
  local absdir="$TMPD/$reldir"
  mkdir -p "$absdir"
  local since_field=""
  if [ -n "$since" ]; then
    since_field="\"_in_progress_since\": \"$since\","
  fi
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
  $since_field
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

echo "=== TEST GROUP 1: Stale in_progress auto-recovered ==="

# Set _in_progress_since to 2 hours ago
TWO_HOURS_AGO=$(node -e "console.log(new Date(Date.now() - 2*3600000).toISOString())")
setup_loop "crash1" "A.2" 1 "in_progress" "$TWO_HOURS_AGO"

RESULT=$(H next-tick --dir crash1)
check "returns recovered_from" 'echo "$RESULT" | grep -q "in_progress_timeout"'
check "returns stall reason" 'echo "$RESULT" | grep -q "auto-recovered"'

# Verify state was written to stalled
STATE_STATUS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMPD/crash1/loop-state.json','utf8')).status)")
check "state set to stalled" '[ "$STATE_STATUS" = "stalled" ]'

echo ""
echo "=== TEST GROUP 2: Recent in_progress not recovered ==="

# Set _in_progress_since to 10 minutes ago
TEN_MIN_AGO=$(node -e "console.log(new Date(Date.now() - 10*60000).toISOString())")
setup_loop "crash2" "A.2" 1 "in_progress" "$TEN_MIN_AGO"

RESULT2=$(H next-tick --dir crash2)
check "returns normal skip message" 'echo "$RESULT2" | grep -q "another tick is in progress"'
check "no recovery triggered" '! echo "$RESULT2" | grep -q "in_progress_timeout"'

# Verify state unchanged
STATE_STATUS2=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMPD/crash2/loop-state.json','utf8')).status)")
check "state still in_progress" '[ "$STATE_STATUS2" = "in_progress" ]'

echo ""
echo "=== TEST GROUP 3: Custom timeout via env var ==="

FIVE_MIN_AGO=$(node -e "console.log(new Date(Date.now() - 5*60000).toISOString())")
setup_loop "crash3" "A.2" 1 "in_progress" "$FIVE_MIN_AGO"

# Set timeout to 0.001 hours (~3.6 seconds) — 5min old should trigger
RESULT3=$(OPC_TICK_TIMEOUT_HOURS=0.001 H next-tick --dir crash3)
check "custom timeout triggers recovery" 'echo "$RESULT3" | grep -q "in_progress_timeout"'

echo ""
echo "=== TEST GROUP 4: VALID_LOOP_STATUSES export ==="

VSIZE=$(node -e "import { VALID_LOOP_STATUSES } from '$SCRIPT_DIR/bin/lib/util.mjs'; console.log(VALID_LOOP_STATUSES.size)" 2>&1)
check "VALID_LOOP_STATUSES has 5 entries" '[ "$VSIZE" = "5" ]'

TSIZE=$(node -e "import { TERMINAL_LOOP_STATUSES } from '$SCRIPT_DIR/bin/lib/util.mjs'; console.log(TERMINAL_LOOP_STATUSES.size)" 2>&1)
check "TERMINAL_LOOP_STATUSES has 3 entries" '[ "$TSIZE" = "3" ]'

echo ""
echo "=== TEST GROUP 5: TERMINAL_LOOP_STATUSES used in complete-tick ==="

setup_loop "term1" "A.1" 0 "stalled"
echo '{"tests_run": 1}' > "$TMPD/term1/test.json"
RESULT5=$(H complete-tick --unit A.1 --artifacts "$TMPD/term1/test.json" --description "test" --dir term1)
check "stalled loop rejects complete-tick" 'echo "$RESULT5" | grep -q "terminated pipeline"'

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[ "$FAIL" -eq 0 ] || exit 1
