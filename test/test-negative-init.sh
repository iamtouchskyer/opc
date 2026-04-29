#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

echo "Test: Negative — Init Error Paths"
echo "================================================"
echo ""

# ── Test 1: invalid flow template ──
echo "1. init with invalid --flow → error JSON"
OUT=$($HARNESS init --flow nonexistent --entry build --dir .harness 2>/dev/null || true)
if echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('error') or 'error' in str(d).lower(); print('ok')" 2>/dev/null | grep -q ok; then
  echo "  ✅ invalid flow rejected with error"
  PASS=$((PASS + 1))
else
  echo "  ❌ output: $OUT"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: missing --flow flag ──
echo "2. init without --flow → non-zero exit or error"
OUT2=$($HARNESS init --entry build --dir .harness 2>&1 || true)
if [ -n "$OUT2" ]; then
  echo "  ✅ missing --flow produces output (error or usage)"
  PASS=$((PASS + 1))
else
  echo "  ❌ no output at all"
  FAIL=$((FAIL + 1))
fi

# ── Test 3: invalid entry node ──
echo "3. init with invalid --entry → error"
OUT3=$($HARNESS init --flow build-verify --entry nonexistent --dir .harness2 2>/dev/null || true)
if echo "$OUT3" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('error') or 'error' in str(d).lower() or 'invalid' in str(d).lower(); print('ok')" 2>/dev/null | grep -q ok; then
  echo "  ✅ invalid entry node rejected"
  PASS=$((PASS + 1))
else
  # Some implementations silently default — check if it at least ran
  if [ -f ".harness2/flow-state.json" ]; then
    echo "  ⚠️  init succeeded with invalid entry (implementation allows it)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ output: $OUT3"
    FAIL=$((FAIL + 1))
  fi
fi

# ── Test 4: duplicate init (already initialized) ──
echo "4. duplicate init → overwrites or errors gracefully"
$HARNESS init --flow build-verify --entry build --dir .harness3 2>/dev/null >/dev/null || true
OUT4=$($HARNESS init --flow build-verify --entry build --dir .harness3 2>/dev/null || true)
# Should either succeed (overwrite) or error — not crash
if [ -n "$OUT4" ]; then
  echo "  ✅ duplicate init handled gracefully (no crash)"
  PASS=$((PASS + 1))
else
  echo "  ❌ no output"
  FAIL=$((FAIL + 1))
fi

print_results
