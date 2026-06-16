#!/bin/bash
# Regression: resolveFlowTemplate must fall back to state.flowTemplate when
# neither --flow nor --flow-file is given. Built-in flows persist the template
# NAME in flow-state.json (flowTemplate), not a _flow_file path. The real /opc
# skill calls `prompt-context --node X --role Y --dir DIR` WITHOUT --flow, so
# nodeCapabilities silently went empty → all capability-routed extensions
# no-matched. This guards that path.
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

echo "=== resolveFlowTemplate state.flowTemplate fallback ==="
echo ""

# ── 1: init built-in flow persists flowTemplate (name), no _flow_file ──
echo "--- 1: built-in flow state has flowTemplate, no _flow_file ---"
$HARNESS init --flow build-verify --entry brief --dir .harness 2>/dev/null
STATE=$(cat .harness/flow-state.json)
TPL=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('flowTemplate',''))" 2>/dev/null)
FF=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('_flow_file',''))" 2>/dev/null)
if [ "$TPL" = "build-verify" ] && [ -z "$FF" ]; then
  echo "  ✅ flowTemplate=build-verify, _flow_file empty"
  PASS=$((PASS + 1))
else
  echo "  ❌ flowTemplate=$TPL _flow_file=$FF"
  FAIL=$((FAIL + 1))
fi

# ── 2: prompt-context WITHOUT --flow resolves nodeCapabilities ──
echo "--- 2: prompt-context (no --flow) → nodeCapabilities non-empty ---"
OUT=$($HARNESS prompt-context --node brief --role architect --dir .harness 2>/dev/null)
CAPS=$(echo "$OUT" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('nodeCapabilities',[])))" 2>/dev/null)
if echo "$CAPS" | grep -q "design-system-injection@1"; then
  echo "  ✅ nodeCapabilities resolved from state.flowTemplate: $CAPS"
  PASS=$((PASS + 1))
else
  echo "  ❌ nodeCapabilities empty/wrong (no --flow, no _flow_file): '$CAPS'"
  FAIL=$((FAIL + 1))
fi

# ── 3: explicit --flow still works (no regression) ──
echo "--- 3: prompt-context WITH --flow still resolves ---"
OUT=$($HARNESS prompt-context --node brief --role architect --dir .harness --flow build-verify 2>/dev/null)
CAPS=$(echo "$OUT" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('nodeCapabilities',[])))" 2>/dev/null)
if echo "$CAPS" | grep -q "design-system-injection@1"; then
  echo "  ✅ --flow path unaffected: $CAPS"
  PASS=$((PASS + 1))
else
  echo "  ❌ --flow path broke: '$CAPS'"
  FAIL=$((FAIL + 1))
fi

# ── 4: build node caps differ from brief node caps (per-node routing intact) ──
echo "--- 4: per-node capabilities (build ≠ brief) ---"
OUT=$($HARNESS prompt-context --node build --role implementer --dir .harness 2>/dev/null)
BUILD_CAPS=$(echo "$OUT" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('nodeCapabilities',[])))" 2>/dev/null)
# build has design-system-injection@1 but NOT design-spec-conformance@1 (that's brief-only)
if echo "$BUILD_CAPS" | grep -q "design-system-injection@1" && ! echo "$BUILD_CAPS" | grep -q "design-spec-conformance@1"; then
  echo "  ✅ build caps correct (has injection, not spec-conformance): $BUILD_CAPS"
  PASS=$((PASS + 1))
else
  echo "  ❌ build caps wrong: '$BUILD_CAPS'"
  FAIL=$((FAIL + 1))
fi

# ── 5: unknown node → empty caps (no crash) ──
echo "--- 5: unknown node → empty caps ---"
OUT=$($HARNESS prompt-context --node nonexistent --role implementer --dir .harness 2>/dev/null)
CAPS=$(echo "$OUT" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('nodeCapabilities',[])))" 2>/dev/null)
if [ -z "$CAPS" ]; then
  echo "  ✅ unknown node → empty caps (no crash)"
  PASS=$((PASS + 1))
else
  echo "  ❌ unexpected caps: '$CAPS'"
  FAIL=$((FAIL + 1))
fi

print_results
