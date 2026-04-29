#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

echo "Test: Negative — Transition Error Paths"
echo "================================================"
echo ""

$HARNESS init --flow build-verify --entry build --dir .harness 2>/dev/null >/dev/null

# ── Test 1: transition from wrong currentNode ──
echo "1. transition from code-review when currentNode=build → blocked"
mkdir -p .harness/nodes/code-review
cat > .harness/nodes/code-review/handshake.json <<'EOF'
{"nodeId":"code-review","nodeType":"review","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:00:00.000Z","artifacts":[{"type":"eval","path":"eval-a.md"},{"type":"eval","path":"eval-b.md"}]}
EOF
echo "# Eval A" > .harness/nodes/code-review/eval-a.md
echo "# Eval B" > .harness/nodes/code-review/eval-b.md
TRANS=$($HARNESS transition --from code-review --to test-design --verdict PASS --flow build-verify --dir .harness 2>/dev/null || true)
ALLOWED=$(echo "$TRANS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allowed', 'missing'))" 2>/dev/null)
if [ "$ALLOWED" = "False" ]; then
  echo "  ✅ transition from wrong node blocked"
  PASS=$((PASS + 1))
else
  echo "  ❌ allowed=$ALLOWED output=$TRANS"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: transition along invalid edge ──
echo "2. transition build → gate (no direct edge) → blocked"
mkdir -p .harness/nodes/build
cat > .harness/nodes/build/handshake.json <<'EOF'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:00:00.000Z","artifacts":[{"type":"code","path":"x"}]}
EOF
touch .harness/nodes/build/x
TRANS2=$($HARNESS transition --from build --to gate --verdict PASS --flow build-verify --dir .harness 2>/dev/null || true)
ALLOWED2=$(echo "$TRANS2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allowed', 'missing'))" 2>/dev/null)
if [ "$ALLOWED2" = "False" ]; then
  echo "  ✅ invalid edge blocked"
  PASS=$((PASS + 1))
else
  echo "  ❌ allowed=$ALLOWED2 output=$TRANS2"
  FAIL=$((FAIL + 1))
fi

# ── Test 3: transition without handshake ──
echo "3. transition without handshake.json → blocked"
rm -rf .harness
$HARNESS init --flow build-verify --entry build --dir .harness 2>/dev/null >/dev/null
TRANS3=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .harness 2>/dev/null || true)
ALLOWED3=$(echo "$TRANS3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allowed', 'missing'))" 2>/dev/null)
if [ "$ALLOWED3" = "False" ]; then
  echo "  ✅ missing handshake blocks transition"
  PASS=$((PASS + 1))
else
  echo "  ❌ allowed=$ALLOWED3 output=$TRANS3"
  FAIL=$((FAIL + 1))
fi

# ── Test 4: transition with mismatched verdict ──
echo "4. transition build→code-review with FAIL verdict → blocked (no FAIL edge from build)"
mkdir -p .harness/nodes/build
cat > .harness/nodes/build/handshake.json <<'EOF'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:00:00.000Z","artifacts":[{"type":"code","path":"x"}]}
EOF
touch .harness/nodes/build/x
TRANS4=$($HARNESS transition --from build --to code-review --verdict FAIL --flow build-verify --dir .harness 2>/dev/null || true)
ALLOWED4=$(echo "$TRANS4" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allowed', 'missing'))" 2>/dev/null)
if [ "$ALLOWED4" = "False" ]; then
  echo "  ✅ wrong verdict blocks transition"
  PASS=$((PASS + 1))
else
  echo "  ❌ allowed=$ALLOWED4"
  FAIL=$((FAIL + 1))
fi

print_results
