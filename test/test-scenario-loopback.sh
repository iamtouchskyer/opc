#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

echo "Test: Scenario — Gate FAIL Loopback"
echo "================================================"
echo ""

$HARNESS init --flow build-verify --entry build --dir .harness 2>/dev/null

# Advance to gate
mkdir -p .harness/nodes/build
cat > .harness/nodes/build/handshake.json <<'EOF'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:01:00.000Z","artifacts":[{"type":"code","path":"x"}]}
EOF
touch .harness/nodes/build/x
$HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null

mkdir -p .harness/nodes/code-review
cat > .harness/nodes/code-review/handshake.json <<'EOF'
{"nodeId":"code-review","nodeType":"review","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:02:00.000Z","artifacts":[{"type":"eval","path":"eval-a.md"},{"type":"eval","path":"eval-b.md"}]}
EOF
echo "# Eval A" > .harness/nodes/code-review/eval-a.md
echo "# Eval B" > .harness/nodes/code-review/eval-b.md
$HARNESS transition --from code-review --to test-design --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null

mkdir -p .harness/nodes/test-design
cat > .harness/nodes/test-design/handshake.json <<'EOF'
{"nodeId":"test-design","nodeType":"review","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:03:00.000Z","artifacts":[{"type":"eval","path":"eval-a.md"},{"type":"eval","path":"eval-b.md"}]}
EOF
echo "# Eval A" > .harness/nodes/test-design/eval-a.md
echo "# Eval B" > .harness/nodes/test-design/eval-b.md
$HARNESS transition --from test-design --to test-execute --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null

mkdir -p .harness/nodes/test-execute
cat > .harness/nodes/test-execute/handshake.json <<'EOF'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:04:00.000Z","artifacts":[{"type":"test-result","path":"o"}]}
EOF
touch .harness/nodes/test-execute/o
$HARNESS transition --from test-execute --to gate --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null

# ── Test 1: gate FAIL → routes back to build ──
echo "1. gate FAIL → next=build (loopback)"
ROUTE=$($HARNESS route --node gate --verdict FAIL --flow build-verify 2>/dev/null)
NEXT=$(echo "$ROUTE" | python3 -c "import sys,json; print(json.load(sys.stdin)['next'])")
if [ "$NEXT" = "build" ]; then
  echo "  ✅ FAIL → build"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL → $NEXT"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: gate ITERATE → routes back to build ──
echo "2. gate ITERATE → next=build"
ROUTE2=$($HARNESS route --node gate --verdict ITERATE --flow build-verify 2>/dev/null)
NEXT2=$(echo "$ROUTE2" | python3 -c "import sys,json; print(json.load(sys.stdin)['next'])")
if [ "$NEXT2" = "build" ]; then
  echo "  ✅ ITERATE → build"
  PASS=$((PASS + 1))
else
  echo "  ❌ ITERATE → $NEXT2"
  FAIL=$((FAIL + 1))
fi

# ── Test 3: transition with FAIL loopback succeeds ──
echo "3. transition gate → build (FAIL loopback) allowed"
mkdir -p .harness/nodes/gate
cat > .harness/nodes/gate/handshake.json <<'EOF'
{"nodeId":"gate","nodeType":"gate","runId":"run_1","status":"completed","verdict":"FAIL","summary":"critical findings","timestamp":"2026-01-01T00:00:00.000Z","artifacts":[]}
EOF
# Need backlog.md for FAIL/ITERATE transitions
echo "- Fix null reference" > .harness/backlog.md
TRANS=$($HARNESS transition --from gate --to build --verdict FAIL --flow build-verify --dir .harness 2>/dev/null)
ALLOWED=$(echo "$TRANS" | python3 -c "import sys,json; print(json.load(sys.stdin)['allowed'])")
if [ "$ALLOWED" = "True" ]; then
  echo "  ✅ loopback transition allowed"
  PASS=$((PASS + 1))
else
  echo "  ❌ loopback not allowed: $TRANS"
  FAIL=$((FAIL + 1))
fi

# ── Test 4: currentNode is build after loopback ──
echo "4. currentNode = build after loopback"
NODE=$(python3 -c "import json; print(json.load(open('.harness/flow-state.json'))['currentNode'])")
if [ "$NODE" = "build" ]; then
  echo "  ✅ currentNode=build"
  PASS=$((PASS + 1))
else
  echo "  ❌ currentNode=$NODE"
  FAIL=$((FAIL + 1))
fi

# ── Test 5: totalSteps incremented ──
echo "5. totalSteps incremented through transitions"
STEPS=$(python3 -c "import json; print(json.load(open('.harness/flow-state.json'))['totalSteps'])")
if [ "$STEPS" -gt 4 ]; then
  echo "  ✅ totalSteps=$STEPS (>4)"
  PASS=$((PASS + 1))
else
  echo "  ❌ totalSteps=$STEPS (expected >4)"
  FAIL=$((FAIL + 1))
fi

print_results
