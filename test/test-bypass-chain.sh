#!/bin/bash
# test-bypass-chain.sh — validate-chain honors bypass
# Ensures: a flow initialized under OPC_DISABLE_EXTENSIONS=1 does NOT fail
# validate-chain even when ~/.opc/config.json declares requiredExtensions.
# This is the benchmark-reproducibility contract from U1.1.

set -u
cd "$(dirname "$0")/.." || exit 1

PASS=0
FAIL=0

run_test() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  ✅ $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name"
    FAIL=$((FAIL + 1))
  fi
}

TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

# Seed a fake ~/.opc/config.json inside TMP (we'll override HOME for the test)
mkdir -p "$TMP/fake-home/.opc"
cat > "$TMP/fake-home/.opc/config.json" <<'EOF'
{ "requiredExtensions": ["non-existent-ext"] }
EOF

# Work inside a harness dir under cwd so resolveDir doesn't refuse it
HARNESS=".harness-bypass-chain-$$"
rm -rf "$HARNESS"

echo "=== TEST: validate-chain honors bypass ==="

# 1) init under OPC_DISABLE_EXTENSIONS=1
echo "--- 1.1: init under OPC_DISABLE_EXTENSIONS=1 records bypassMode in flow-state"
HOME="$TMP/fake-home" OPC_DISABLE_EXTENSIONS=1 node bin/opc-harness.mjs init \
  --flow review --entry review --dir "$HARNESS" >/dev/null 2>&1
if [ -f "$HARNESS/flow-state.json" ]; then
  MODE=$(jq -r '.bypassMode.mode // "null"' "$HARNESS/flow-state.json")
  if [ "$MODE" = "disable-all" ]; then
    echo "  ✅ flow-state.bypassMode.mode = disable-all"
    PASS=$((PASS + 1))
  else
    echo "  ❌ flow-state.bypassMode.mode = '$MODE' (expected 'disable-all')"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  ❌ flow-state.json not created"
  FAIL=$((FAIL + 1))
fi

# 2) .ext-registry.json records bypass
echo "--- 1.2: .ext-registry.json records bypass marker"
if [ -f "$HARNESS/.ext-registry.json" ]; then
  BMODE=$(jq -r '.bypass.mode // "null"' "$HARNESS/.ext-registry.json")
  APPLIED=$(jq -r '.applied | length' "$HARNESS/.ext-registry.json")
  if [ "$BMODE" = "disable-all" ] && [ "$APPLIED" = "0" ]; then
    echo "  ✅ .ext-registry.json: bypass.mode=disable-all, applied=[]"
    PASS=$((PASS + 1))
  else
    echo "  ❌ .ext-registry.json mismatch: bypass=$BMODE, applied.length=$APPLIED"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  ❌ .ext-registry.json not created"
  FAIL=$((FAIL + 1))
fi

# 3) validate-chain under bypass passes despite requiredExtensions config
echo "--- 1.3: validate-chain under bypass waives requiredExtensions"
OUT=$(HOME="$TMP/fake-home" OPC_DISABLE_EXTENSIONS=1 node bin/opc-harness.mjs validate-chain \
  --dir "$HARNESS" 2>/dev/null)
VALID=$(echo "$OUT" | jq -r '.valid // false')
if [ "$VALID" = "true" ]; then
  echo "  ✅ validate-chain valid=true under bypass"
  PASS=$((PASS + 1))
else
  echo "  ❌ validate-chain failed under bypass: $OUT"
  FAIL=$((FAIL + 1))
fi

# 4) Negative case: without bypass, validate-chain would still enforce requiredExtensions
#    (We can't easily test this in a passing way because a pristine init has no handshakes
#     yet, so no nodes fail. But we can confirm the waiver message only fires when bypass
#     is active: it should NOT appear without bypass.)
echo "--- 1.4: without bypass, no waiver message emitted"
rm -rf "$HARNESS"
HOME="$TMP/fake-home" node bin/opc-harness.mjs init \
  --flow review --entry review --dir "$HARNESS" >/dev/null 2>&1
MSG=$(HOME="$TMP/fake-home" node bin/opc-harness.mjs validate-chain --dir "$HARNESS" 2>&1 >/dev/null | grep -c "waiving requiredExtensions" || true)
if [ "$MSG" = "0" ]; then
  echo "  ✅ no 'waiving' message without bypass"
  PASS=$((PASS + 1))
else
  echo "  ❌ unexpected waiver message without bypass"
  FAIL=$((FAIL + 1))
fi

# 5) Cleanup
rm -rf "$HARNESS"

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

[ "$FAIL" -eq 0 ]
