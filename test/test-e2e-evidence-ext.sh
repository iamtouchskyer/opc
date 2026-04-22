#!/usr/bin/env bash
set -euo pipefail

# Test: e2e-evidence extension — E2E trigger-to-artifact verification
# Verifies the extension fires and produces correct findings based on eval content.

EXT_DIR="$(cd "$(dirname "$0")/fixtures/e2e-evidence-ext" && pwd)"
PASS=0; FAIL=0

check() {
  local label="$1" cond="$2"
  if eval "$cond"; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label"
    FAIL=$((FAIL + 1))
  fi
}

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

echo "=== TEST GROUP 1: startupCheck ==="

echo "--- 1.1: startupCheck returns true ---"
RESULT=$(node -e "
import('file://$EXT_DIR/hook.mjs').then(ext => {
  console.log(JSON.stringify(ext.startupCheck()));
});
" 2>&1)
check "startupCheck passes" '[ "$RESULT" = "true" ]'

echo ""
echo "=== TEST GROUP 2: Proxy-only eval → 🟡 warning ==="

echo "--- 2.1: Eval with only 'tests pass' ---"
RUND="$TMPD/run_1"
mkdir -p "$RUND"
cat > "$RUND/eval-tester.md" << 'EVAL'
# Tester Eval

### 🔵 [OPEN] All good

All tests pass. LGTM.

VERDICT: MECHANISMS HOLD
EVAL

RESULT=$(node -e "
import('file://$EXT_DIR/hook.mjs').then(ext => {
  const findings = ext.verdictAppend({ runDir: '$RUND' });
  console.log(JSON.stringify(findings));
});
" 2>&1)
check "returns findings array" 'echo "$RESULT" | node -e "const d=JSON.parse(require(\"fs\").readFileSync(\"/dev/stdin\",\"utf8\")); process.exit(Array.isArray(d) && d.length > 0 ? 0 : 1)"'
check "severity is warning" 'echo "$RESULT" | grep -q "\"warning\""'
check "category is e2e-evidence" 'echo "$RESULT" | grep -q "e2e-evidence"'
check "mentions proxy" 'echo "$RESULT" | grep -q -i "proxy"'

echo ""
echo "=== TEST GROUP 3: Eval with E2E evidence → no finding ==="

echo "--- 3.1: Eval with trigger-to-artifact trace ---"
RUND2="$TMPD/run_2"
mkdir -p "$RUND2"
cat > "$RUND2/eval-skeptic.md" << 'EVAL'
# Skeptic Owner Eval

### 🔵 [OPEN] E2E verified

**Evidence**: Triggered `opc-harness init` then observed e2e-evidence artifact changed within 5s.
Before/after diff confirms state transition. Exit code 0.
Command output captured in command-output-1.txt.

VERDICT: MECHANISMS HOLD
EVAL

RESULT2=$(node -e "
import('file://$EXT_DIR/hook.mjs').then(ext => {
  const findings = ext.verdictAppend({ runDir: '$RUND2' });
  console.log(JSON.stringify(findings));
});
" 2>&1)
check "returns empty array" 'echo "$RESULT2" | node -e "const d=JSON.parse(require(\"fs\").readFileSync(\"/dev/stdin\",\"utf8\")); process.exit(Array.isArray(d) && d.length === 0 ? 0 : 1)"'

echo ""
echo "=== TEST GROUP 4: Eval with explicit exemption → no finding ==="

echo "--- 4.1: Eval with 'No E2E path' annotation ---"
RUND3="$TMPD/run_3"
mkdir -p "$RUND3"
cat > "$RUND3/eval-arch.md" << 'EVAL'
# Architect Eval

### 🔵 [OPEN] Config refactor

No E2E path — unit/integration evidence only. Pure refactor of config parsing.

VERDICT: MECHANISMS HOLD
EVAL

RESULT3=$(node -e "
import('file://$EXT_DIR/hook.mjs').then(ext => {
  const findings = ext.verdictAppend({ runDir: '$RUND3' });
  console.log(JSON.stringify(findings));
});
" 2>&1)
check "returns empty array" 'echo "$RESULT3" | node -e "const d=JSON.parse(require(\"fs\").readFileSync(\"/dev/stdin\",\"utf8\")); process.exit(Array.isArray(d) && d.length === 0 ? 0 : 1)"'

echo ""
echo "=== TEST GROUP 5: No eval files → null ==="

echo "--- 5.1: Empty runDir ---"
RUND4="$TMPD/run_4"
mkdir -p "$RUND4"

RESULT4=$(node -e "
import('file://$EXT_DIR/hook.mjs').then(ext => {
  const findings = ext.verdictAppend({ runDir: '$RUND4' });
  console.log(JSON.stringify(findings));
});
" 2>&1)
check "returns null" '[ "$RESULT4" = "null" ]'

echo ""
echo "=== TEST GROUP 6: Null context → null ==="

echo "--- 6.1: null ctx ---"
RESULT5=$(node -e "
import('file://$EXT_DIR/hook.mjs').then(ext => {
  const findings = ext.verdictAppend(null);
  console.log(JSON.stringify(findings));
});
" 2>&1)
check "returns null" '[ "$RESULT5" = "null" ]'

echo ""
echo "=== TEST GROUP 7: Mixed — proxy + E2E in separate evals ==="

echo "--- 7.1: One eval proxy-only, another with E2E evidence ---"
RUND5="$TMPD/run_5"
mkdir -p "$RUND5"
cat > "$RUND5/eval-pm.md" << 'EVAL'
# PM Eval
All tests pass. Looks good. LGTM.
EVAL
cat > "$RUND5/eval-skeptic.md" << 'EVAL'
# Skeptic Owner Eval
**Evidence**: Before/after diff of flow-state.json confirms trigger-to-artifact path.
EVAL

RESULT6=$(node -e "
import('file://$EXT_DIR/hook.mjs').then(ext => {
  const findings = ext.verdictAppend({ runDir: '$RUND5' });
  console.log(JSON.stringify(findings));
});
" 2>&1)
check "E2E in any eval = no finding" 'echo "$RESULT6" | node -e "const d=JSON.parse(require(\"fs\").readFileSync(\"/dev/stdin\",\"utf8\")); process.exit(Array.isArray(d) && d.length === 0 ? 0 : 1)"'

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[ "$FAIL" -eq 0 ] || exit 1
