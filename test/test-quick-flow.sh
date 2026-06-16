#!/bin/bash
# Tests for the quick flow template
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

echo "=== Quick flow template tests ==="
echo ""

# ── 1: init --flow quick creates 3-node flow ──
echo "--- 1: init --flow quick ---"
$HARNESS init --flow quick --entry build --dir .harness 2>/dev/null
STATE=$(cat .harness/flow-state.json)
NODE=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('currentNode',''))" 2>/dev/null)
if [ "$NODE" = "build" ]; then
  echo "  ✅ init quick → currentNode=build"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected build, got: $NODE"
  FAIL=$((FAIL + 1))
fi

# ── 2: route gate FAIL → build ──
echo "--- 2: route gate FAIL → build ---"
OUT=$($HARNESS route --node gate --verdict FAIL --flow quick 2>/dev/null)
NEXT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('next',''))" 2>/dev/null)
if [ "$NEXT" = "build" ]; then
  echo "  ✅ gate FAIL → build"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected build, got: $NEXT"
  FAIL=$((FAIL + 1))
fi

# ── 3: route gate ITERATE → build ──
echo "--- 3: route gate ITERATE → build ---"
OUT=$($HARNESS route --node gate --verdict ITERATE --flow quick 2>/dev/null)
NEXT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('next',''))" 2>/dev/null)
if [ "$NEXT" = "build" ]; then
  echo "  ✅ gate ITERATE → build"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected build, got: $NEXT"
  FAIL=$((FAIL + 1))
fi

# ── 4: route gate PASS → null (complete) ──
echo "--- 4: route gate PASS → null ---"
OUT=$($HARNESS route --node gate --verdict PASS --flow quick 2>/dev/null)
NEXT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('next'))" 2>/dev/null)
if [ "$NEXT" = "None" ]; then
  echo "  ✅ gate PASS → null (flow complete)"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected None, got: $NEXT"
  FAIL=$((FAIL + 1))
fi

# ── 5: viz --flow quick shows the 3 nodes ──
echo "--- 5: viz --flow quick ---"
VIZ=$($HARNESS viz --flow quick 2>/dev/null)
if echo "$VIZ" | grep -q "build" && echo "$VIZ" | grep -q "review" && echo "$VIZ" | grep -q "gate"; then
  echo "  ✅ viz shows build, review, gate"
  PASS=$((PASS + 1))
else
  echo "  ❌ viz output: $VIZ"
  FAIL=$((FAIL + 1))
fi

# ── 6: Full path build → review → gate PASS ──
echo "--- 6: Full path build → review → gate PASS ---"
rm -rf .harness
$HARNESS init --flow quick --entry build --dir .harness 2>/dev/null

# build → review
mkdir -p .harness/nodes/build
cat > .harness/nodes/build/handshake.json <<'EOF'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","verdict":"PASS","summary":"built","timestamp":"2026-01-01T00:01:00.000Z","artifacts":[{"type":"code","path":"x"}]}
EOF
touch .harness/nodes/build/x
$HARNESS transition --from build --to review --verdict PASS --flow quick --dir .harness 2>/dev/null >/dev/null

# review → gate
mkdir -p .harness/nodes/review/run_1
cat > .harness/nodes/review/run_1/eval-analyst.md << 'EVALEOF'
# Analyst Review
## Code Quality
🔵 src/handler.ts:15 — Missing input validation
Reasoning: User input flows directly without sanitization.
→ Add zod schema validation.
## Summary
VERDICT: FINDINGS[1]
EVALEOF
cat > .harness/nodes/review/run_1/eval-checker.md << 'EVALEOF'
# Checker Review
## Architecture
🔵 src/service.ts:10 — Consider extracting helper
Reasoning: Function is 200+ lines.
→ Split into focused functions.
## Summary
VERDICT: FINDINGS[1]
EVALEOF
cat > .harness/nodes/review/handshake.json <<'EOF'
{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:02:00.000Z","artifacts":[{"type":"eval","path":"run_1/eval-analyst.md"},{"type":"eval","path":"run_1/eval-checker.md"}]}
EOF
$HARNESS transition --from review --to gate --verdict PASS --flow quick --dir .harness 2>/dev/null >/dev/null

STATE=$(cat .harness/flow-state.json)
CUR=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('currentNode',''))" 2>/dev/null)
if [ "$CUR" = "gate" ]; then
  echo "  ✅ full path: reached gate"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected gate, got: $CUR"
  FAIL=$((FAIL + 1))
fi

# ── 7: maxLoopsPerEdge=2 enforced ──
echo "--- 7: maxLoopsPerEdge=2 enforced ---"
rm -rf .harness
$HARNESS init --flow quick --entry build --dir .harness 2>/dev/null

# Loop 1: build → review → gate → FAIL → build
advance_quick() {
  mkdir -p .harness/nodes/build
  cat > .harness/nodes/build/handshake.json <<'BEOF'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:01:00.000Z","artifacts":[{"type":"code","path":"x"}]}
BEOF
  touch .harness/nodes/build/x
  $HARNESS transition --from build --to review --verdict PASS --flow quick --dir .harness 2>/dev/null >/dev/null
  mkdir -p .harness/nodes/review/run_1
  cat > .harness/nodes/review/run_1/eval-a.md << 'EEOF'
# Review A
🔵 src/x.ts:1 — Minor issue
Reasoning: Small thing.
→ Fix it.
EEOF
  cat > .harness/nodes/review/run_1/eval-b.md << 'EEOF'
# Review B
🔵 src/y.ts:2 — Another issue
Reasoning: Another thing.
→ Fix that too.
EEOF
  cat > .harness/nodes/review/handshake.json <<'REOF'
{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:02:00.000Z","artifacts":[{"type":"eval","path":"run_1/eval-a.md"},{"type":"eval","path":"run_1/eval-b.md"}]}
REOF
  $HARNESS transition --from review --to gate --verdict PASS --flow quick --dir .harness 2>/dev/null >/dev/null
}

loopback_quick() {
  mkdir -p .harness/nodes/gate
  cat > .harness/nodes/gate/handshake.json <<'GEOF'
{"nodeId":"gate","nodeType":"gate","runId":"run_1","status":"completed","verdict":"FAIL","summary":"fail","timestamp":"2026-01-01T00:03:00.000Z","artifacts":[]}
GEOF
  $HARNESS transition --from gate --to build --verdict FAIL --flow quick --dir .harness 2>/dev/null >/dev/null
}

advance_quick
loopback_quick
advance_quick
loopback_quick

# 3rd attempt should be blocked (maxLoopsPerEdge=2)
advance_quick
mkdir -p .harness/nodes/gate
cat > .harness/nodes/gate/handshake.json <<'GEOF'
{"nodeId":"gate","nodeType":"gate","runId":"run_1","status":"completed","verdict":"FAIL","summary":"fail","timestamp":"2026-01-01T00:03:00.000Z","artifacts":[]}
GEOF
TRANS=$($HARNESS transition --from gate --to build --verdict FAIL --flow quick --dir .harness 2>/dev/null || true)
ALLOWED=$(echo "$TRANS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allowed', True))" 2>/dev/null)
if [ "$ALLOWED" = "False" ]; then
  echo "  ✅ 3rd gate→build blocked (maxLoopsPerEdge=2)"
  PASS=$((PASS + 1))
else
  echo "  ❌ was allowed: $TRANS"
  FAIL=$((FAIL + 1))
fi

print_results
