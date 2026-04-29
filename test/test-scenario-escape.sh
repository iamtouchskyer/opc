#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

echo "Test: Scenario — Escape Hatches (skip, pass, stop, goto)"
echo "================================================"
echo ""

$HARNESS init --flow build-verify --entry build --dir .harness 2>/dev/null

# ── Test 1: skip advances via PASS edge ──
echo "1. skip → advances from build to code-review"
SKIP=$($HARNESS skip --dir .harness --flow build-verify 2>/dev/null)
NODE=$(python3 -c "import json; print(json.load(open('.harness/flow-state.json'))['currentNode'])")
if [ "$NODE" = "code-review" ]; then
  echo "  ✅ skip moved to code-review"
  PASS=$((PASS + 1))
else
  echo "  ❌ currentNode=$NODE (expected code-review)"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: skip writes handshake with skipped flag ──
echo "2. skip writes handshake.json for build"
if [ -f ".harness/nodes/build/handshake.json" ]; then
  SKIPPED=$(python3 -c "import json; print(json.load(open('.harness/nodes/build/handshake.json')).get('skipped', False))")
  if [ "$SKIPPED" = "True" ]; then
    echo "  ✅ handshake has skipped=True"
    PASS=$((PASS + 1))
  else
    echo "  ❌ handshake missing skipped flag"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  ❌ no handshake.json for build"
  FAIL=$((FAIL + 1))
fi

# ── Test 3: goto jumps to arbitrary node ──
echo "3. goto test-execute → currentNode=test-execute"
$HARNESS goto test-execute --dir .harness 2>/dev/null >/dev/null || true
NODE2=$(python3 -c "import json; print(json.load(open('.harness/flow-state.json'))['currentNode'])")
if [ "$NODE2" = "test-execute" ]; then
  echo "  ✅ goto moved to test-execute"
  PASS=$((PASS + 1))
else
  echo "  ❌ currentNode=$NODE2"
  FAIL=$((FAIL + 1))
fi

# ── Test 4: stop terminates flow ──
echo "4. stop → status=stopped"
$HARNESS stop --dir .harness 2>/dev/null >/dev/null || true
STATUS=$(python3 -c "import json; print(json.load(open('.harness/flow-state.json'))['status'])")
if [ "$STATUS" = "stopped" ]; then
  echo "  ✅ status=stopped"
  PASS=$((PASS + 1))
else
  echo "  ❌ status=$STATUS"
  FAIL=$((FAIL + 1))
fi

# ── Test 5: pass on gate node ──
echo "5. pass on gate node → advances"
# Re-init for clean gate test
rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null

# Skip review to get to gate
$HARNESS skip --dir .harness --flow review 2>/dev/null >/dev/null
NODE3=$(python3 -c "import json; print(json.load(open('.harness/flow-state.json'))['currentNode'])")
if [ "$NODE3" = "gate" ]; then
  $HARNESS pass --dir .harness 2>/dev/null >/dev/null || true
  $HARNESS finalize --dir .harness 2>/dev/null >/dev/null || true
  # After pass+finalize, gate should advance (next=null for review flow → completed)
  STATUS2=$(python3 -c "import json; d=json.load(open('.harness/flow-state.json')); print(d.get('status',''))")
  if [ "$STATUS2" = "completed" ] || [ "$STATUS2" = "finalized" ]; then
    echo "  ✅ pass on gate → flow completed"
    PASS=$((PASS + 1))
  else
    echo "  ❌ status=$STATUS2 after pass"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  ❌ not at gate node (at $NODE3)"
  FAIL=$((FAIL + 1))
fi

print_results
