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
echo "=== GAP-1: opc-harness help + unknown command ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 1.1: No-args shows help ---"
OUT=$(node "$(cd "$(dirname "$0")/.." 2>/dev/null || echo "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)")" 2>&1 || true)
# Use the HARNESS variable properly
OUT=$($HARNESS 2>&1 || true)
assert_contains "help output" "$OUT" "opc-harness"
assert_contains "flow commands" "$OUT" "Flow commands"

echo ""
echo "--- 1.2: Unknown command shows help ---"
OUT=$($HARNESS nonexistent-cmd 2>&1 || true)
assert_contains "unknown cmd help" "$OUT" "opc-harness"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-2: resolveDir path traversal guard ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 2.1: --dir /etc exits nonzero ---"
assert_exit_nonzero "traversal /etc" $HARNESS init --flow build-verify --dir /etc

echo ""
echo "--- 2.2: --dir ../../../ exits nonzero ---"
assert_exit_nonzero "traversal ../../.." $HARNESS init --flow build-verify --dir ../../../tmp

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-3: Flow command missing-args exit codes ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 3.1: route missing flags exits nonzero ---"
assert_exit_nonzero "route no-args" $HARNESS route

echo ""
echo "--- 3.2: init missing flow returns error JSON ---"
OUT=$($HARNESS init 2>/dev/null)
assert_field_eq "init no-flow" "$OUT" "created" "false"

echo ""
echo "--- 3.3: viz missing flow exits nonzero ---"
assert_exit_nonzero "viz no-flow" $HARNESS viz

echo ""
echo "--- 3.4: verify no-args exits nonzero ---"
assert_exit_nonzero "verify no-args" $HARNESS verify

echo ""
echo "--- 3.5: verify nonexistent file exits nonzero ---"
assert_exit_nonzero "verify missing file" $HARNESS verify /nonexistent/eval.md

echo ""
echo "--- 3.6: diff missing files exits nonzero ---"
assert_exit_nonzero "diff no-args" $HARNESS diff

echo ""
echo "--- 3.7: report no dir exits nonzero ---"
assert_exit_nonzero "report no-dir" $HARNESS report

echo ""
echo "--- 3.8: report missing mode/task exits nonzero ---"
assert_exit_nonzero "report no-mode" $HARNESS report /tmp --task test

echo ""
echo "--- 3.9: synthesize missing flags exits nonzero ---"
assert_exit_nonzero "synthesize no-dir" $HARNESS synthesize

echo ""
echo "--- 3.10: synthesize --node no nodeId exits nonzero ---"
assert_exit_nonzero "synth --node empty" $HARNESS synthesize /tmp --node

echo ""
echo "--- 3.11: synthesize --wave no number exits nonzero ---"
assert_exit_nonzero "synth --wave empty" $HARNESS synthesize /tmp --wave

echo ""
echo "--- 3.12: goto missing nodeId exits nonzero ---"
assert_exit_nonzero "goto no-node" $HARNESS goto --dir .harness

echo ""
echo "--- 3.13: complete-tick missing unit exits nonzero ---"
assert_exit_nonzero "ctick no-unit" $HARNESS complete-tick --dir .harness

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-4: Finalize error branches ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 4.1: finalize with tampered writer sig ---"
rm -rf .h-fin1 && $HARNESS init --flow build-verify --dir .h-fin1 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-fin1/flow-state.json'))
d['_written_by'] = 'evil-script'
json.dump(d, open('.h-fin1/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS finalize --dir .h-fin1 2>/dev/null)
assert_field_eq "finalize tamper" "$OUT" "finalized" "false"
assert_contains "finalize tamper msg" "$OUT" "not written by opc-harness"

echo ""
echo "--- 4.2: finalize with unknown template ---"
rm -rf .h-fin2 && $HARNESS init --flow build-verify --dir .h-fin2 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-fin2/flow-state.json'))
d['flowTemplate'] = 'nonexistent-template'
json.dump(d, open('.h-fin2/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS finalize --dir .h-fin2 2>/dev/null)
assert_field_eq "finalize bad template" "$OUT" "finalized" "false"
assert_contains "finalize unknown tpl" "$OUT" "unknown flow"

echo ""
echo "--- 4.3: finalize non-terminal node ---"
rm -rf .h-fin3 && $HARNESS init --flow build-verify --dir .h-fin3 >/dev/null 2>/dev/null
# build is not terminal (PASS→code-review, not null)
OUT=$($HARNESS finalize --dir .h-fin3 2>/dev/null)
assert_field_eq "finalize non-terminal" "$OUT" "finalized" "false"
assert_contains "non-terminal msg" "$OUT" "not a terminal"

echo ""
echo "--- 4.4: finalize with missing handshake at terminal gate (auto-creates) ---"
rm -rf .h-fin4 && $HARNESS init --flow review --entry gate --dir .h-fin4 >/dev/null 2>/dev/null
# gate PASS→null so it's terminal. finalize auto-creates gate handshake
# (commit f61d70e: terminal gate finalize auto-writes handshake).
OUT=$($HARNESS finalize --dir .h-fin4 2>/dev/null)
assert_field_eq "finalize auto-creates terminal gate handshake" "$OUT" "finalized" "true"
if [ -f ".h-fin4/nodes/gate/handshake.json" ]; then
  echo "  ✅ gate handshake auto-written to disk"
  PASS=$((PASS + 1))
else
  echo "  ❌ gate handshake not auto-written"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 4.5: finalize with non-completed terminal handshake ---"
# Use fresh dir — 4.4's successful finalize sets state.status=completed.
rm -rf .h-fin5 && $HARNESS init --flow review --entry gate --dir .h-fin5 >/dev/null 2>/dev/null
mkdir -p .h-fin5/nodes/gate
cat > .h-fin5/nodes/gate/handshake.json << 'HS'
{"nodeId":"gate","nodeType":"gate","runId":"run_1","status":"failed","summary":"x","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
OUT=$($HARNESS finalize --dir .h-fin5 2>/dev/null)
assert_field_eq "finalize bad status" "$OUT" "finalized" "false"
assert_contains "status not completed" "$OUT" "status is"

echo ""
echo "--- 4.6: finalize with corrupt terminal handshake ---"
# Fresh dir — pre-existing handshake must be corrupted before finalize runs.
rm -rf .h-fin6 && $HARNESS init --flow review --entry gate --dir .h-fin6 >/dev/null 2>/dev/null
mkdir -p .h-fin6/nodes/gate
echo "not json" > .h-fin6/nodes/gate/handshake.json
OUT=$($HARNESS finalize --dir .h-fin6 2>/dev/null)
assert_field_eq "finalize corrupt hs" "$OUT" "finalized" "false"
assert_contains "corrupt hs msg" "$OUT" "cannot parse"


print_results
