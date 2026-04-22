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
echo "=== GAP-5: Transition error branches ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 5.1: transition with corrupt flow-state.json ---"
rm -rf .h-trans1 && mkdir -p .h-trans1
echo "not json" > .h-trans1/flow-state.json
OUT=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .h-trans1 2>/dev/null)
assert_field_eq "corrupt state" "$OUT" "allowed" "false"
assert_contains "corrupt msg" "$OUT" "corrupt"

echo ""
echo "--- 5.2: transition corrupt pre-transition handshake ---"
rm -rf .h-trans2 && $HARNESS init --flow build-verify --dir .h-trans2 >/dev/null 2>/dev/null
mkdir -p .h-trans2/nodes/build
echo "not json" > .h-trans2/nodes/build/handshake.json
OUT=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .h-trans2 2>/dev/null)
assert_field_eq "corrupt handshake" "$OUT" "allowed" "false"
assert_contains "parse handshake" "$OUT" "parse"

echo ""
echo "--- 5.3: Backlog enforcement with PASS verdict (not just ITERATE) ---"
rm -rf .h-bp && $HARNESS init --flow build-verify --entry gate --dir .h-bp >/dev/null 2>/dev/null
mkdir -p .h-bp/nodes/test-execute
cat > .h-bp/nodes/test-execute/handshake.json << 'HS'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["ev.txt"],"findings":{"warning":1,"critical":0}}
HS
echo "evidence" > .h-bp/nodes/test-execute/ev.txt
# gate PASS→null in build-verify, but we need a non-null PASS target
# Use full-stack: gate-test PASS→acceptance, FAIL→discuss
rm -rf .h-bp2 && $HARNESS init --flow full-stack --entry gate-test --dir .h-bp2 >/dev/null 2>/dev/null
mkdir -p .h-bp2/nodes/test-execute
cat > .h-bp2/nodes/test-execute/handshake.json << 'HS'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["ev.txt"],"findings":{"warning":1,"critical":0}}
HS
echo "evidence" > .h-bp2/nodes/test-execute/ev.txt
OUT=$($HARNESS transition --from gate-test --to acceptance --verdict PASS --flow full-stack --dir .h-bp2 2>/dev/null)
assert_field_eq "PASS backlog check" "$OUT" "allowed" "false"
assert_contains "PASS backlog msg" "$OUT" "backlog"

echo ""
echo "--- 5.4: Backlog 0 matching entries blocked ---"
rm -rf .h-bp3 && $HARNESS init --flow full-stack --entry gate-test --dir .h-bp3 >/dev/null 2>/dev/null
mkdir -p .h-bp3/nodes/test-execute
cat > .h-bp3/nodes/test-execute/handshake.json << 'HS'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["ev.txt"],"findings":{"warning":1,"critical":0}}
HS
echo "evidence" > .h-bp3/nodes/test-execute/ev.txt
# Backlog exists but no entries from test-execute
cat > .h-bp3/backlog.md << 'BL'
# Backlog
- [ ] 🟡 Some other concern [build]
BL
OUT=$($HARNESS transition --from gate-test --to acceptance --verdict PASS --flow full-stack --dir .h-bp3 2>/dev/null)
assert_field_eq "0 entries blocked" "$OUT" "allowed" "false"
assert_contains "no entries msg" "$OUT" "no formatted entries"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-6: Escape hatch error branches ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 6.1: skip with unknown flow template ---"
rm -rf .h-esc1 && $HARNESS init --flow build-verify --dir .h-esc1 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-esc1/flow-state.json'))
d['flowTemplate'] = 'nonexistent'
json.dump(d, open('.h-esc1/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS skip --dir .h-esc1 2>/dev/null)
assert_contains "skip unknown flow" "$OUT" "unknown flow"

echo ""
echo "--- 6.2: pass with no state ---"
rm -rf .h-esc2 && mkdir -p .h-esc2
OUT=$($HARNESS pass --dir .h-esc2 2>/dev/null)
assert_contains "pass no state" "$OUT" "no flow-state"

echo ""
echo "--- 6.3: stop with no state ---"
OUT=$($HARNESS stop --dir .h-esc2 2>/dev/null)
assert_contains "stop no state" "$OUT" "no flow-state"

echo ""
echo "--- 6.4: goto with unknown flow ---"
rm -rf .h-esc3 && $HARNESS init --flow build-verify --dir .h-esc3 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-esc3/flow-state.json'))
d['flowTemplate'] = 'fake'
json.dump(d, open('.h-esc3/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS goto build --dir .h-esc3 2>/dev/null)
assert_contains "goto unknown flow" "$OUT" "unknown flow"

echo ""
echo "--- 6.5: pass succeeds on gate with non-null transition ---"
# full-stack: gate-test PASS→acceptance
rm -rf .h-esc4 && $HARNESS init --flow full-stack --entry gate-test --dir .h-esc4 >/dev/null 2>/dev/null
# gate-test upstream = test-execute. Create handshake with no warnings to skip backlog check.
mkdir -p .h-esc4/nodes/test-execute
cat > .h-esc4/nodes/test-execute/handshake.json << 'HS'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["ev.txt"],"findings":{"warning":0,"critical":0}}
HS
echo "evidence" > .h-esc4/nodes/test-execute/ev.txt
OUT=$($HARNESS pass --dir .h-esc4 2>/dev/null)
assert_field_eq "pass gate→acceptance" "$OUT" "allowed" "true"

echo ""
echo "--- 6.6: pass with unknown flow ---"
rm -rf .h-esc5 && $HARNESS init --flow build-verify --entry gate --dir .h-esc5 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-esc5/flow-state.json'))
d['flowTemplate'] = 'fake-flow'
json.dump(d, open('.h-esc5/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS pass --dir .h-esc5 2>/dev/null)
assert_contains "pass unknown flow" "$OUT" "unknown flow"

echo ""
echo "--- 6.7: ls with .harness-* directories ---"
rm -rf .harness-test1 && $HARNESS init --flow build-verify --dir .harness-test1 >/dev/null 2>/dev/null
OUT=$($HARNESS ls --base . 2>/dev/null)
assert_contains "ls finds .harness-*" "$OUT" ".harness-test1"

echo ""
echo "--- 6.8: ls with nested harness ---"
rm -rf .harness && mkdir -p .harness/subflow
# Create a nested flow-state
$HARNESS init --flow review --dir .harness/subflow >/dev/null 2>/dev/null
OUT=$($HARNESS ls --base . 2>/dev/null)
assert_contains "ls finds nested" "$OUT" "subflow"


print_results
