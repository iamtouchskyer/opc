#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

# ── Setup: create a minimal session with eval files missing mandatory role ──

mkdir -p .harness/nodes/code-review/run_1

# flow-state.json with code-review as current node
cat > .harness/flow-state.json <<'EOF'
{
  "flowTemplate": "build-verify",
  "currentNode": "code-review",
  "status": "active",
  "totalSteps": 3,
  "history": []
}
EOF

# Write a valid eval file for frontend role (NOT skeptic-owner)
cat > .harness/nodes/code-review/run_1/eval-frontend.md <<'EOF'
# Frontend Review

## Summary
Code looks reasonable.

## Findings

🟡 **Warning** — `src/app.tsx:42` — Missing error boundary
- **Why**: Uncaught render errors crash the entire app
- **Fix**: Wrap top-level route in `<ErrorBoundary>`

## Verdict
ITERATE — one warning needs addressing.
EOF

echo "Test: Mandatory role enforcement in synthesize"
echo "================================================"
echo ""

# ── Test 1: synthesize detects missing mandatory role ──
echo "1. Missing mandatory role → warning emitted"
OUT=$($HARNESS synthesize .harness --node code-review --run 1 --no-strict 2>/dev/null || true)

if echo "$OUT" | grep -q "mandatory role.*skeptic-owner.*not present"; then
  echo "  ✅ mandatory role warning detected"
  PASS=$((PASS + 1))
else
  echo "  ❌ mandatory role warning NOT detected"
  echo "  Output: $OUT"
  FAIL=$((FAIL + 1))
fi

# Check mandatoryMissing field in output
if echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'skeptic-owner' in d.get('mandatoryMissing',[])" 2>/dev/null; then
  echo "  ✅ mandatoryMissing contains skeptic-owner"
  PASS=$((PASS + 1))
else
  echo "  ❌ mandatoryMissing field missing or wrong"
  FAIL=$((FAIL + 1))
fi

# Check verdict is at least ITERATE (warning bumps it)
VERDICT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['verdict'])" 2>/dev/null)
if [ "$VERDICT" = "ITERATE" ] || [ "$VERDICT" = "FAIL" ]; then
  echo "  ✅ verdict=$VERDICT (not PASS)"
  PASS=$((PASS + 1))
else
  echo "  ❌ verdict=$VERDICT (expected ITERATE or FAIL)"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: adding skeptic-owner eval → no mandatory warning ──
echo ""
echo "2. With skeptic-owner present → no mandatory warning"

cat > .harness/nodes/code-review/run_1/eval-skeptic-owner.md <<'EOF'
# Skeptic Owner Review

## Summary
Checked the actual consumer path. The orchestrator calls this correctly.

## Findings

🔵 **Suggestion** — `src/app.tsx:1` — Consider adding integration test for error boundary
- **Why**: Unit test alone doesn't prove the boundary catches real render errors
- **Fix**: Add Playwright test that triggers a component throw

Mechanism validated: error boundary renders fallback, no uncaught promise rejection in console.

## Verdict
PASS — mechanism works as designed.
EOF

OUT2=$($HARNESS synthesize .harness --node code-review --run 1 --no-strict 2>/dev/null || true)

if echo "$OUT2" | grep -q "mandatory role.*skeptic-owner"; then
  echo "  ❌ mandatory warning still present with skeptic-owner eval"
  FAIL=$((FAIL + 1))
else
  echo "  ✅ no mandatory role warning when skeptic-owner present"
  PASS=$((PASS + 1))
fi

# mandatoryMissing should be absent
if echo "$OUT2" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('mandatoryMissing') is None" 2>/dev/null; then
  echo "  ✅ mandatoryMissing is null/absent"
  PASS=$((PASS + 1))
else
  echo "  ❌ mandatoryMissing still populated"
  FAIL=$((FAIL + 1))
fi

print_results
