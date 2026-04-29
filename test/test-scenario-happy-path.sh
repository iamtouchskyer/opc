#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

echo "Test: Scenario — Happy Path (init → build → review → gate PASS)"
echo "================================================"
echo ""

# ── Test 1: init creates flow-state.json ──
echo "1. init --flow build-verify → creates flow-state.json"
$HARNESS init --flow build-verify --entry build --dir .harness 2>/dev/null
if [ -f ".harness/flow-state.json" ]; then
  echo "  ✅ flow-state.json exists"
  PASS=$((PASS + 1))
else
  echo "  ❌ flow-state.json missing"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: currentNode is build after init ──
echo "2. currentNode = build"
NODE=$(python3 -c "import json; print(json.load(open('.harness/flow-state.json'))['currentNode'])")
if [ "$NODE" = "build" ]; then
  echo "  ✅ currentNode=build"
  PASS=$((PASS + 1))
else
  echo "  ❌ currentNode=$NODE"
  FAIL=$((FAIL + 1))
fi

# ── Test 3: route from build with PASS → code-review ──
echo "3. route --node build --verdict PASS → next=code-review"
ROUTE=$($HARNESS route --node build --verdict PASS --flow build-verify 2>/dev/null)
NEXT=$(echo "$ROUTE" | python3 -c "import sys,json; print(json.load(sys.stdin)['next'])")
if [ "$NEXT" = "code-review" ]; then
  echo "  ✅ next=code-review"
  PASS=$((PASS + 1))
else
  echo "  ❌ next=$NEXT"
  FAIL=$((FAIL + 1))
fi

# ── Test 4: transition from build → code-review ──
echo "4. transition build → code-review"
# Need handshake for build node
mkdir -p .harness/nodes/build
cat > .harness/nodes/build/handshake.json <<'EOF'
{
  "nodeId": "build",
  "nodeType": "build",
  "runId": "run_1",
  "status": "completed",
  "verdict": "PASS",
  "summary": "Build completed successfully",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [{"type":"code","path":"src/app.tsx"}]
}
EOF
mkdir -p .harness/nodes/build/src && touch .harness/nodes/build/src/app.tsx

TRANS=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .harness 2>/dev/null)
ALLOWED=$(echo "$TRANS" | python3 -c "import sys,json; print(json.load(sys.stdin)['allowed'])")
if [ "$ALLOWED" = "True" ]; then
  echo "  ✅ transition allowed"
  PASS=$((PASS + 1))
else
  echo "  ❌ transition not allowed: $TRANS"
  FAIL=$((FAIL + 1))
fi

# ── Test 5: currentNode updated to code-review ──
echo "5. currentNode updated to code-review after transition"
NODE2=$(python3 -c "import json; print(json.load(open('.harness/flow-state.json'))['currentNode'])")
if [ "$NODE2" = "code-review" ]; then
  echo "  ✅ currentNode=code-review"
  PASS=$((PASS + 1))
else
  echo "  ❌ currentNode=$NODE2"
  FAIL=$((FAIL + 1))
fi

# ── Test 6: full path to gate PASS → next=null (flow complete) ──
echo "6. Full path: code-review → test-design → test-execute → gate PASS → null"

# Transition code-review → test-design
mkdir -p .harness/nodes/code-review
cat > .harness/nodes/code-review/handshake.json <<'EOF'
{"nodeId":"code-review","nodeType":"review","runId":"run_1","status":"completed","verdict":"PASS","summary":"Review passed","timestamp":"2026-01-01T00:00:00.000Z","artifacts":[{"type":"eval","path":"eval-frontend.md"}]}
EOF
touch .harness/nodes/code-review/eval-frontend.md
$HARNESS transition --from code-review --to test-design --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null

# Transition test-design → test-execute
mkdir -p .harness/nodes/test-design
cat > .harness/nodes/test-design/handshake.json <<'EOF'
{"nodeId":"test-design","nodeType":"review","runId":"run_1","status":"completed","verdict":"PASS","summary":"Tests designed","timestamp":"2026-01-01T00:00:00.000Z","artifacts":[{"type":"eval","path":"test-plan.md"}]}
EOF
touch .harness/nodes/test-design/test-plan.md
$HARNESS transition --from test-design --to test-execute --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null

# Transition test-execute → gate
mkdir -p .harness/nodes/test-execute
cat > .harness/nodes/test-execute/handshake.json <<'EOF'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","verdict":"PASS","summary":"Tests passed","timestamp":"2026-01-01T00:00:00.000Z","artifacts":[{"type":"test-result","path":"output.txt"}]}
EOF
touch .harness/nodes/test-execute/output.txt
$HARNESS transition --from test-execute --to gate --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null

# Gate → null (complete)
FINAL=$($HARNESS route --node gate --verdict PASS --flow build-verify 2>/dev/null)
FINAL_NEXT=$(echo "$FINAL" | python3 -c "import sys,json; print(json.load(sys.stdin)['next'])")
if [ "$FINAL_NEXT" = "None" ]; then
  echo "  ✅ gate PASS → next=None (flow complete)"
  PASS=$((PASS + 1))
else
  echo "  ❌ gate PASS → next=$FINAL_NEXT (expected None)"
  FAIL=$((FAIL + 1))
fi

print_results
