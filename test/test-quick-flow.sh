#!/bin/bash
# Tests for the quick flow template
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

echo "=== Quick flow template tests ==="
echo ""

write_clean_eval() {
  local target="$1"
  local role="$2"
  {
    echo "# $role Review"
    echo "Role: $role"
    echo "## Scope"
    for i in $(seq 1 18); do echo "$role scope $i records a concrete review pass across the changed fixture."; done
    echo "## Evidence"
    for i in $(seq 1 18); do echo "$role evidence $i: command routing, artifacts, state history, and gate inputs were inspected."; done
    echo "## Decision"
    for i in $(seq 1 18); do echo "$role decision $i is PASS after checking the relevant harness contract and provenance path."; done
    echo "VERDICT: PASS"
  } > "$target"
}

write_quick_build() {
  mkdir -p .harness/nodes/build
  cat > .harness/nodes/build/handshake.json <<'EOF'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","verdict":"PASS","summary":"built","timestamp":"2026-01-01T00:01:00.000Z","artifacts":[{"type":"code","path":"x"}]}
EOF
  touch .harness/nodes/build/x
}

write_quick_review() {
  mkdir -p .harness/nodes/review/run_1
  write_clean_eval .harness/nodes/review/run_1/eval-skeptic-owner.md "skeptic-owner"
  write_clean_eval .harness/nodes/review/run_1/eval-quick-reviewer.md "quick-reviewer"
  cat > .harness/nodes/review/handshake.json <<'EOF'
{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:02:00.000Z","artifacts":[{"type":"eval","path":"run_1/eval-skeptic-owner.md"},{"type":"eval","path":"run_1/eval-quick-reviewer.md"}]}
EOF
}

write_quick_test_design() {
  mkdir -p .harness/nodes/test-design/run_1
  write_clean_eval .harness/nodes/test-design/run_1/eval-skeptic-owner.md "skeptic-owner"
  write_clean_eval .harness/nodes/test-design/run_1/eval-quick-tester.md "quick-tester"
  write_complete_test_plan .harness/nodes/test-design/run_1/test-plan.md
  cat > .harness/nodes/test-design/handshake.json <<'EOF'
{"nodeId":"test-design","nodeType":"review","runId":"run_1","status":"completed","verdict":"PASS","summary":"tests designed","timestamp":"2026-01-01T00:03:00.000Z","artifacts":[{"type":"eval","path":"run_1/eval-skeptic-owner.md"},{"type":"eval","path":"run_1/eval-quick-tester.md"},{"type":"test-plan","path":"run_1/test-plan.md"}],"testCommand":"printf quick-ok > quick-test.txt"}
EOF
}

advance_quick() {
  write_quick_build
  $HARNESS transition --from build --to review --verdict PASS --flow quick --dir .harness 2>/dev/null >/dev/null
  write_quick_review
  $HARNESS transition --from review --to test-design --verdict PASS --flow quick --dir .harness 2>/dev/null >/dev/null
  write_quick_test_design
  $HARNESS transition --from test-design --to test-execute --verdict PASS --flow quick --dir .harness 2>/dev/null >/dev/null
  $HARNESS transition --from test-execute --to gate --verdict PASS --flow quick --dir .harness 2>/dev/null >/dev/null
}

# ── 1: init --flow quick creates evidence-backed flow ──
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

# ── 5: viz --flow quick shows evidence-backed nodes ──
echo "--- 5: viz --flow quick ---"
VIZ=$($HARNESS viz --flow quick 2>/dev/null)
if echo "$VIZ" | grep -q "build" &&
   echo "$VIZ" | grep -q "review" &&
   echo "$VIZ" | grep -q "test-design" &&
   echo "$VIZ" | grep -q "test-execute" &&
   echo "$VIZ" | grep -q "gate"; then
  echo "  ✅ viz shows build, review, test-design, test-execute, gate"
  PASS=$((PASS + 1))
else
  echo "  ❌ viz output: $VIZ"
  FAIL=$((FAIL + 1))
fi

# ── 6: Full path build → review → test-design → test-execute → gate PASS ──
echo "--- 6: Full path build → review → test-design → test-execute → gate PASS ---"
rm -rf .harness
$HARNESS init --flow quick --entry build --dir .harness 2>/dev/null

advance_quick

STATE=$(cat .harness/flow-state.json)
CUR=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('currentNode',''))" 2>/dev/null)
if [ "$CUR" = "gate" ]; then
  echo "  ✅ full path: reached gate"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected gate, got: $CUR"
  FAIL=$((FAIL + 1))
fi

OUT=$($HARNESS transition --from gate --to null --verdict PASS --flow quick --dir .harness 2>/dev/null)
FINALIZED=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('finalized', False))" 2>/dev/null)
if [ "$FINALIZED" = "True" ]; then
  echo "  ✅ gate PASS finalizes with OPC testCommand evidence"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected finalized true, got: $OUT"
  FAIL=$((FAIL + 1))
fi

# ── 7: quick gate blocks missing testCommand evidence ──
echo "--- 7: quick gate blocks missing testCommand evidence ---"
rm -rf .harness
$HARNESS init --flow quick --entry gate --dir .harness 2>/dev/null
OUT=$($HARNESS transition --from gate --to null --verdict PASS --flow quick --dir .harness 2>/dev/null || true)
ALLOWED=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allowed', True))" 2>/dev/null)
if [ "$ALLOWED" = "False" ] && echo "$OUT" | grep -q "required OPC testCommand evidence missing before gate"; then
  echo "  ✅ missing testCommand evidence blocks quick gate PASS"
  PASS=$((PASS + 1))
else
  echo "  ❌ quick gate allowed missing testCommand evidence: $OUT"
  FAIL=$((FAIL + 1))
fi

# ── 8: maxLoopsPerEdge=2 enforced ──
echo "--- 8: maxLoopsPerEdge=2 enforced ---"
rm -rf .harness
$HARNESS init --flow quick --entry build --dir .harness 2>/dev/null

# Loop 1: build → review → gate → FAIL → build
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
