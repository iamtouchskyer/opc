#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

echo "Test: Scenario — Cycle Limit Enforcement"
echo "================================================"
echo ""

$HARNESS init --flow build-verify --entry build --dir .harness 2>/dev/null

# ── Helper: advance build→code-review→test-design→test-execute→gate ──
advance_to_gate() {
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
  echo "# Eval A - review findings" > .harness/nodes/code-review/eval-a.md
  echo "# Eval B - secondary review" > .harness/nodes/code-review/eval-b.md
  $HARNESS transition --from code-review --to test-design --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null

  mkdir -p .harness/nodes/test-design
  cat > .harness/nodes/test-design/handshake.json <<'EOF'
{"nodeId":"test-design","nodeType":"review","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:03:00.000Z","artifacts":[{"type":"eval","path":"eval-a.md"},{"type":"eval","path":"eval-b.md"}]}
EOF
  echo "# Eval A - test design findings" > .harness/nodes/test-design/eval-a.md
  echo "# Eval B - test design secondary" > .harness/nodes/test-design/eval-b.md
  $HARNESS transition --from test-design --to test-execute --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null

  mkdir -p .harness/nodes/test-execute
  cat > .harness/nodes/test-execute/handshake.json <<'EOF'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:04:00.000Z","artifacts":[{"type":"test-result","path":"o"}]}
EOF
  touch .harness/nodes/test-execute/o
  $HARNESS transition --from test-execute --to gate --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null
}

loopback_gate_to_build() {
  mkdir -p .harness/nodes/gate
  cat > .harness/nodes/gate/handshake.json <<'EOF'
{"nodeId":"gate","nodeType":"gate","runId":"run_1","status":"completed","verdict":"FAIL","summary":"fail","timestamp":"2026-01-01T00:05:00.000Z","artifacts":[]}
EOF
  echo "- fix" > .harness/backlog.md
  $HARNESS transition --from gate --to build --verdict FAIL --flow build-verify --dir .harness 2>/dev/null >/dev/null
}

# Loop 1
advance_to_gate
loopback_gate_to_build

# Loop 2
advance_to_gate
loopback_gate_to_build

# Loop 3
advance_to_gate
loopback_gate_to_build

# ── Test 1: after 3 loopbacks, edges are blocked at limit ──
echo "1. After 3 loops, build→code-review edge (count=3) is blocked on 4th attempt"
mkdir -p .harness/nodes/build
cat > .harness/nodes/build/handshake.json <<'EOF'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:01:00.000Z","artifacts":[{"type":"code","path":"x"}]}
EOF
touch .harness/nodes/build/x
TRANS=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .harness 2>/dev/null || true)
ALLOWED=$(echo "$TRANS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allowed', True))" 2>/dev/null)
if [ "$ALLOWED" = "False" ]; then
  echo "  ✅ 4th traversal of build→code-review blocked (maxLoopsPerEdge=3)"
  PASS=$((PASS + 1))
else
  echo "  ❌ was allowed: $TRANS"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: check reason mentions limit ──
echo "2. Blocked reason mentions edge limit"
REASON=$(echo "$TRANS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)
if echo "$REASON" | grep -qi "edge\|loop\|limit\|max"; then
  echo "  ✅ reason: $REASON"
  PASS=$((PASS + 1))
else
  echo "  ❌ reason: $REASON"
  FAIL=$((FAIL + 1))
fi

print_results
