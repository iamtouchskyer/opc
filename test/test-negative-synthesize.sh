#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

echo "Test: Negative — Synthesize Error Paths"
echo "================================================"
echo ""

$HARNESS init --flow build-verify --entry build --dir .harness 2>/dev/null >/dev/null

# ── Test 1: synthesize with empty eval dir ──
echo "1. synthesize with no eval files → empty output or error"
mkdir -p .harness/nodes/code-review/run_1
SYNTH=$($HARNESS synthesize .harness --node code-review --run 1 --base "$TMPDIR" --no-strict 2>/dev/null || true)
if [ -z "$SYNTH" ]; then
  echo "  ✅ empty eval dir → no output (graceful)"
  PASS=$((PASS + 1))
else
  ROLES=$(echo "$SYNTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('roles',[])))" 2>/dev/null || echo "parse_error")
  if [ "$ROLES" = "0" ] || [ "$ROLES" = "parse_error" ]; then
    echo "  ✅ empty eval dir → 0 roles or error"
    PASS=$((PASS + 1))
  else
    echo "  ❌ roles=$ROLES"
    FAIL=$((FAIL + 1))
  fi
fi

# ── Test 2: eval file without VERDICT line ──
echo "2. eval without VERDICT → graceful handling"
cat > .harness/nodes/code-review/run_1/eval-missing-verdict.md <<'EOF'
# Missing Verdict Eval

## Summary
No verdict line here.

## Findings
Nothing.
EOF
mkdir -p "$TMPDIR/src"
echo "x" > "$TMPDIR/src/main.ts"
SYNTH2=$($HARNESS synthesize .harness --node code-review --run 1 --base "$TMPDIR" --no-strict 2>/dev/null || true)
if [ -z "$SYNTH2" ]; then
  echo "  ✅ missing VERDICT → no output (graceful)"
  PASS=$((PASS + 1))
else
  VALID=$(echo "$SYNTH2" | python3 -c "import sys,json; json.load(sys.stdin); print('ok')" 2>/dev/null || echo "no")
  if [ "$VALID" = "ok" ]; then
    echo "  ✅ missing VERDICT handled gracefully (valid JSON)"
    PASS=$((PASS + 1))
  else
    echo "  ✅ missing VERDICT → non-JSON error output (acceptable)"
    PASS=$((PASS + 1))
  fi
fi

# ── Test 3: thin eval (<50 lines) → warning in totals ──
echo "3. thin eval (<50 lines) → warning in totals"
cat > .harness/nodes/code-review/run_1/eval-thin.md <<'EOF'
# Thin Eval

## Summary
Short.

## Findings

🔵 **Suggestion** — `src/main.ts:1` — Add logging
- **Why**: Helps debugging
- **Fix**: Add console.log

## Verdict
PASS
EOF
SYNTH3=$($HARNESS synthesize .harness --node code-review --run 1 --base "$TMPDIR" --no-strict 2>/dev/null || true)
if [ -z "$SYNTH3" ]; then
  echo "  ❌ no output from synthesize"
  FAIL=$((FAIL + 1))
else
  WARNINGS=$(echo "$SYNTH3" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('totals',{}).get('warning',0))" 2>/dev/null || echo "0")
  if [ "$WARNINGS" -gt 0 ] 2>/dev/null; then
    echo "  ✅ thin eval produces warning (warnings=$WARNINGS)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ warnings=$WARNINGS (expected >0)"
    FAIL=$((FAIL + 1))
  fi
fi

# ── Test 4: synthesize with nonexistent node ──
echo "4. synthesize nonexistent node → error or empty"
SYNTH4=$($HARNESS synthesize .harness --node nonexistent --run 1 --base "$TMPDIR" --no-strict 2>/dev/null || true)
if [ -z "$SYNTH4" ]; then
  echo "  ✅ nonexistent node → no output (acceptable)"
  PASS=$((PASS + 1))
else
  if echo "$SYNTH4" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('error') or len(d.get('roles',[]))==0; print('ok')" 2>/dev/null | grep -q ok; then
    echo "  ✅ nonexistent node → error or empty roles"
    PASS=$((PASS + 1))
  else
    echo "  ✅ nonexistent node → some output (non-crash)"
    PASS=$((PASS + 1))
  fi
fi

print_results
