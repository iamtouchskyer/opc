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
echo "=== GAP-16: Loop-helpers gaps ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 16.1: detectTestScript with package.json ---"
rm -rf .h-pkg && mkdir -p .h-pkg
cat > package.json << 'PKG'
{"scripts":{"test":"jest","lint":"eslint ."}}
PKG
cat > .h-pkg/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
OUT=$($HARNESS init-loop --skip-scope --plan .h-pkg/plan.md --dir .h-pkg 2>/dev/null)
assert_contains "test script detected" "$OUT" "test script"
assert_contains "lint script detected" "$OUT" "lint script"

echo ""
echo "--- 16.2: validate-chain handshake parse error ---"
rm -rf .h-vc2 && $HARNESS init --flow build-verify --dir .h-vc2 >/dev/null 2>/dev/null
mkdir -p .h-vc2/nodes/build
echo "not json" > .h-vc2/nodes/build/handshake.json
# Add history so validator checks build's handshake
python3 -c "
import json
d = json.load(open('.h-vc2/flow-state.json'))
d['history'] = [{'nodeId': 'build', 'runId': 'run_1', 'timestamp': '2024-01-01T00:00:00Z'}]
d['currentNode'] = 'code-review'
json.dump(d, open('.h-vc2/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS validate-chain --dir .h-vc2 2>/dev/null)
assert_field_eq "chain parse error" "$OUT" "valid" "false"
assert_contains "parse error chain" "$OUT" "parse error"

echo ""
echo "--- 16.3: Review headings identical warning ---"
rm -rf .h-hd && mkdir -p .h-hd
cat > .h-hd/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-hd/plan.md --dir .h-hd >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-hd/loop-state.json'))
d['tick'] = 1
d['next_unit'] = 'F1.2'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-hd/loop-state.json', 'w'), indent=2)
"
# Two files with identical heading but different content
cat > head-a.md << 'EVAL'
# Security Review
VERDICT: PASS FINDINGS[1]
🔵 Minor A — utils.js:5 — add validation
EVAL
cat > head-b.md << 'EVAL'
# Security Review
VERDICT: PASS FINDINGS[1]
🔵 Minor B — api.js:10 — add timeout
EVAL
OUT=$($HARNESS complete-tick --unit F1.2 --artifacts head-a.md,head-b.md --dir .h-hd 2>/dev/null)
assert_contains "identical heading" "$OUT" "identical heading"

# Cleanup
rm -f package.json


print_results
