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

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-11: Viz + Replay error branches ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 11.1: replay with corrupt state ---"
rm -rf .h-rep1 && mkdir -p .h-rep1
echo "not json" > .h-rep1/flow-state.json
OUT=$($HARNESS replay --dir .h-rep1 2>&1 || true)
assert_contains "replay corrupt" "$OUT" "Cannot parse\|parse"

echo ""
echo "--- 11.2: replay with unknown template ---"
rm -rf .h-rep2 && $HARNESS init --flow build-verify --dir .h-rep2 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-rep2/flow-state.json'))
d['flowTemplate'] = 'nonexistent'
json.dump(d, open('.h-rep2/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS replay --dir .h-rep2 2>&1 || true)
assert_contains "replay bad template" "$OUT" "Unknown flow\|unknown flow"

echo ""
echo "--- 11.3: replay with run_* detail collection ---"
rm -rf .h-rep3 && $HARNESS init --flow build-verify --dir .h-rep3 >/dev/null 2>/dev/null
mkdir -p .h-rep3/nodes/build/run_1
echo "test output" > .h-rep3/nodes/build/run_1/result.md
cat > .h-rep3/nodes/build/handshake.json << 'HS'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","summary":"done","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
OUT=$($HARNESS replay --dir .h-rep3 2>/dev/null)
assert_contains "detail collected" "$OUT" "test output"

echo ""
echo "--- 11.4: diff file2 unreadable ---"
echo "dummy" > .h-rep3/r1.md
OUT=$($HARNESS diff .h-rep3/r1.md /nonexistent/r2.md)
assert_contains "file2 error" "$OUT" "Cannot read"

echo ""
echo "--- 11.5: diff oscillation=false (round1=0 findings) ---"
rm -rf .h-diffz && mkdir -p .h-diffz
cat > .h-diffz/empty.md << 'EVAL'
# Review
VERDICT: PASS FINDINGS[0]
EVAL
cat > .h-diffz/r2.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[1]
🔴 New issue — test.js:1 — broken
EVAL
OUT=$($HARNESS diff .h-diffz/empty.md .h-diffz/r2.md)
assert_field_eq "osc false" "$OUT" "oscillation" "false"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-12: Loop-init gaps ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 12.1: init-loop --skip-scope plan not found ---"
rm -rf .h-li1 && mkdir -p .h-li1
OUT=$($HARNESS init-loop --skip-scope --plan /nonexistent/plan.md --dir .h-li1 2>/dev/null)
assert_field_eq "plan not found" "$OUT" "initialized" "false"
assert_contains "not found msg" "$OUT" "plan file not found"

echo ""
echo "--- 12.2: init-loop --skip-scope empty plan ---"
rm -rf .h-li2 && mkdir -p .h-li2
echo "nothing here" > .h-li2/plan.md
OUT=$($HARNESS init-loop --skip-scope --plan .h-li2/plan.md --dir .h-li2 2>/dev/null)
assert_field_eq "empty plan" "$OUT" "initialized" "false"
assert_contains "no units" "$OUT" "no units"

echo ""
echo "--- 12.3: init-loop --skip-scope corrupt existing state overwritten ---"
rm -rf .h-li3 && mkdir -p .h-li3
# Create corrupt loop-state.json
echo "not json" > .h-li3/loop-state.json
cat > .h-li3/plan.md << 'PLAN'
- F1.1: implement — build it
  - verify: echo ok
- F1.2: review — review it
PLAN
OUT=$($HARNESS init-loop --skip-scope --plan .h-li3/plan.md --dir .h-li3 2>/dev/null)
assert_field_eq "corrupt overwritten" "$OUT" "initialized" "true"

echo ""
echo "--- 12.4: init-loop --skip-scope plan ends with implement ---"
rm -rf .h-li4 && mkdir -p .h-li4
cat > .h-li4/plan.md << 'PLAN'
- F1.1: implement — build it
PLAN
OUT=$($HARNESS init-loop --skip-scope --plan .h-li4/plan.md --dir .h-li4 2>/dev/null)
assert_field_eq "trailing impl" "$OUT" "initialized" "false"
assert_contains "no review follows" "$OUT" "no review"

echo ""
echo "--- 12.5: fix unit type triggers verify warning ---"
rm -rf .h-li5 && mkdir -p .h-li5
cat > .h-li5/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
- F1.3: fix — fix findings
PLAN
OUT=$($HARNESS init-loop --skip-scope --plan .h-li5/plan.md --dir .h-li5 2>/dev/null)
assert_field_eq "fix init ok" "$OUT" "initialized" "true"
assert_contains "fix verify warn" "$OUT" "verify"


print_results
