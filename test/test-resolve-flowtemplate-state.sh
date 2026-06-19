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

# ── 4b: node-preflight WITHOUT --flow resolves caps and task from state ──
echo "--- 4b: node-preflight (no --flow) → design-preflight fires with task ---"
EXT_DIR="$TMPDIR/state-exts"
mkdir -p "$EXT_DIR/state-design-ext" ".harness/.opc"
cat > "$EXT_DIR/state-design-ext/ext.json" <<'EOF'
{
  "name": "state-design-ext",
  "version": "0.1.0",
  "meta": { "provides": ["design-preflight@1"], "compatibleCapabilities": [] }
}
EOF
cat > "$EXT_DIR/state-design-ext/hook.mjs" <<'EOF'
export const meta = {
  provides: ["design-preflight@1"],
  compatibleCapabilities: [],
};

export function preflight(ctx) {
  return {
    type: "design",
    selection: { industry: "state-flow", taskSeen: ctx.task || "", taskDescriptionSeen: ctx.taskDescription || "" },
    brief: "# Design Brief\n\nState flow preflight brief.",
    tokens: { colors: { bg: "#ffffff", text: "#111111" } },
    confidence: ctx.task ? 0.82 : 0.1,
    reason: ctx.task ? "task propagated" : "task missing",
  };
}
EOF
cat > ".harness/.opc/config.json" <<EOF
{ "extensionsDir": "$EXT_DIR" }
EOF
cat > ".harness/acceptance-criteria.md" <<'EOF'
# Acceptance Criteria

Build an operations analytics dashboard with compact KPI cards and ranking insight.
EOF
OUT=$(OPC_BREAKER_STATE=disabled $HARNESS node-preflight --node brief --dir .harness 2>/dev/null)
if echo "$OUT" | grep -q '"ok":true' && grep -q '"confidence": 0.82' .harness/design-mode.json && grep -q "operations analytics dashboard" .harness/design-selection.json && grep -q "taskDescriptionSeen" .harness/design-selection.json; then
  echo "  ✅ node-preflight resolved state.flowTemplate and propagated task"
  PASS=$((PASS + 1))
else
  echo "  ❌ node-preflight state fallback failed: $OUT"
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

# ── 6: route WITHOUT --flow resolves next from state.flowTemplate (F7) ──
# The real /opc skill calls `route --node X --verdict Y --dir DIR` without
# --flow. Before the F7 fix, cmdRoute called resolveFlowTemplate(args) without
# state → "no --flow or --flow-file specified". Assert the CONCRETE next node
# (brief PASS → build in build-verify) so this proves the correct template
# resolved via fallback, not merely that route returned valid.
echo "--- 6: route (no --flow) resolves concrete next from state.flowTemplate ---"
OUT=$($HARNESS route --node brief --verdict PASS --dir .harness 2>/dev/null)
NEXT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('next',''))" 2>/dev/null)
if [ "$NEXT" = "build" ]; then
  echo "  ✅ route resolved build-verify via fallback (brief→build): $OUT"
  PASS=$((PASS + 1))
else
  echo "  ❌ route did not resolve correct template (expected next=build): $OUT"
  FAIL=$((FAIL + 1))
fi

# ── 7: route WITH --flow still works (no regression) ──
echo "--- 7: route WITH --flow still resolves ---"
OUT=$($HARNESS route --node brief --verdict PASS --dir .harness --flow build-verify 2>/dev/null)
NEXT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('next',''))" 2>/dev/null)
if [ "$NEXT" = "build" ]; then
  echo "  ✅ route --flow path unaffected: $OUT"
  PASS=$((PASS + 1))
else
  echo "  ❌ route --flow path broke: $OUT"
  FAIL=$((FAIL + 1))
fi

# ── 8: route WITHOUT --flow AND no state file → graceful valid:false ──
# Guards the try/catch degradation path: missing flow-state.json must not crash;
# route should return valid:false with the "no --flow" error, exit 0.
echo "--- 8: route, no --flow, no state file → graceful error (no crash) ---"
mkdir -p .empty-harness
OUT=$($HARNESS route --node gate --verdict PASS --dir .empty-harness 2>/dev/null)
RC=$?
VALID=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print('valid' if d.get('valid') else 'invalid')" 2>/dev/null)
if [ "$VALID" = "invalid" ] && [ "$RC" = "0" ]; then
  echo "  ✅ graceful: valid:false, no crash (rc=0): $OUT"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected graceful valid:false rc=0, got rc=$RC: $OUT"
  FAIL=$((FAIL + 1))
fi

# ── 9: autoMode state surfaces reminder in route output ──
# The F7 refactor moved the autoMode read into the shared state load; guard that
# `--auto` init still produces the reminder field on a route call.
echo "--- 9: autoMode init → route emits reminder ---"
rm -rf .auto-harness
$HARNESS init --flow build-verify --entry brief --dir .auto-harness --auto >/dev/null 2>&1
OUT=$($HARNESS route --node brief --verdict PASS --dir .auto-harness 2>/dev/null)
if echo "$OUT" | grep -q "auto mode"; then
  echo "  ✅ reminder present under autoMode: $OUT"
  PASS=$((PASS + 1))
else
  echo "  ❌ reminder missing under autoMode: $OUT"
  FAIL=$((FAIL + 1))
fi

# ── 10: non-auto init → route omits reminder ──
echo "--- 10: non-auto init → route has no reminder ---"
OUT=$($HARNESS route --node brief --verdict PASS --dir .harness 2>/dev/null)
if echo "$OUT" | grep -q "reminder"; then
  echo "  ❌ unexpected reminder without autoMode: $OUT"
  FAIL=$((FAIL + 1))
else
  echo "  ✅ no reminder without autoMode: $OUT"
  PASS=$((PASS + 1))
fi

print_results
