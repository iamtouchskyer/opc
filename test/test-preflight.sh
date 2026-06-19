#!/bin/bash
# test-preflight.sh — Verify preflight hook lifecycle
# Tests: fireNodePreflight, writeDesignArtifacts, cmdNodePreflight,
#        capability routing for design-preflight@1

set -u
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0
FAIL=0
FAIL_DETAILS=""

fail() {
  local msg="$1"
  FAIL=$((FAIL + 1))
  FAIL_DETAILS="${FAIL_DETAILS}  ❌ $msg"$'\n'
}
ok() {
  local msg="$1"
  PASS=$((PASS + 1))
  echo "  ✅ $msg"
}

TMP=$(mktemp -d -t opc-preflight-XXXXXX)
INIT_EMPTY_REPO="$REPO_ROOT/.tmp-opc-preflight-init-empty-$$"
cleanup() {
  rm -rf "$INIT_EMPTY_REPO"
  if [ "$FAIL" -eq 0 ]; then
    rm -rf "$TMP"
  else
    echo "  ⚠️  TMP preserved for diagnosis: $TMP" >&2
  fi
}
trap cleanup EXIT INT TERM HUP

# ── Stage fixtures ──────────────────────────────────────────────
EXT_DIR="$TMP/extensions"
mkdir -p "$EXT_DIR"
cp -R "$REPO_ROOT/test/fixtures/run2-ext/ok-ext" "$EXT_DIR/"

# ── Flow file with design-preflight@1 on build node ─────────────
FLOW_FILE="$TMP/preflight-test.json"
cat > "$FLOW_FILE" <<'EOF'
{
  "opc_compat": ">=0.0",
  "nodes": ["build", "code-review", "gate"],
  "edges": {
    "build":       { "PASS": "code-review" },
    "code-review": { "PASS": "gate" },
    "gate":        { "PASS": null, "FAIL": "build", "ITERATE": "build" }
  },
  "limits": { "maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5 },
  "nodeTypes": { "build": "build", "code-review": "review", "gate": "gate" },
  "nodeCapabilities": {
    "build": ["design-preflight@1", "verification@1"],
    "code-review": ["verification@1"]
  }
}
EOF

# ── Set up harness dir ──────────────────────────────────────────
HARNESS="$TMP/harness"
OPC_CFG_DIR="$HARNESS/.opc"
mkdir -p "$OPC_CFG_DIR"
cat > "$OPC_CFG_DIR/config.json" <<EOF
{
  "extensionsDir": "$EXT_DIR"
}
EOF
cat > "$HARNESS/acceptance-criteria.md" <<'EOF'
# Preflight Test — Acceptance Criteria
- OUT-1: preflight hook fires and writes artifacts
EOF

HARNESS_BIN="node $REPO_ROOT/bin/opc-harness.mjs"

echo "═══ Preflight Hook Tests ═══"

# ── 1. Init flow ────────────────────────────────────────────────
# ── 1. Set up flow state manually (skip cmdInit path-safety check) ──
echo "§1 Setup flow state"
cat > "$HARNESS/flow-state.json" <<EOF
{
  "currentNode": "build",
  "flow": "preflight-test",
  "_flow_file": "$FLOW_FILE",
  "totalSteps": 0,
  "edgeCounts": {},
  "reentryCount": {}
}
EOF
if [ -f "$HARNESS/flow-state.json" ]; then
  ok "flow state created with design-preflight@1 on build node"
else
  fail "failed to create flow-state.json"
fi

# ── 1b. Init auto-preflight skips empty AC instead of writing confidence 0.1 ──
echo "§1b Init auto-preflight skips empty task"
INIT_EMPTY="$INIT_EMPTY_REPO"
mkdir -p "$INIT_EMPTY"
INIT_OUT=$(OPC_EXTENSIONS_DIR="$EXT_DIR" OPC_BREAKER_STATE=disabled $HARNESS_BIN init --flow-file "$FLOW_FILE" --dir "$INIT_EMPTY" 2>"$TMP/init-empty.err")
if echo "$INIT_OUT" | grep -q '"status":"skipped"' && [ ! -f "$INIT_EMPTY/design-mode.json" ]; then
  ok "init auto-preflight skipped empty acceptance criteria"
else
  fail "init empty AC should skip preflight without design-mode: $INIT_OUT $(cat "$TMP/init-empty.err")"
fi

# Create a run dir for the build node
BUILD_RUN="$HARNESS/nodes/build/run_1"
mkdir -p "$BUILD_RUN"

# ── 2. node-preflight fires and writes artifacts ────────────────
echo "§2 Fire node-preflight"
PREFLIGHT_OUT=$(OPC_BREAKER_STATE=disabled $HARNESS_BIN node-preflight --node build --dir "$HARNESS" --flow-file "$FLOW_FILE" 2>/dev/null)

if echo "$PREFLIGHT_OUT" | grep -q '"ok":true'; then
  ok "node-preflight returned ok"
else
  fail "node-preflight failed: $PREFLIGHT_OUT"
fi

if echo "$PREFLIGHT_OUT" | grep -q '"preflightResults":1'; then
  ok "one preflight result collected"
else
  fail "expected 1 preflight result: $PREFLIGHT_OUT"
fi

if echo "$PREFLIGHT_OUT" | grep -q '"design"'; then
  ok "design artifact type reported"
else
  fail "expected design in artifactTypes: $PREFLIGHT_OUT"
fi

# ── 3. Verify design-mode.json written ──────────────────────────
echo "§3 Verify design artifacts"
if [ -f "$HARNESS/design-mode.json" ]; then
  ok "design-mode.json exists"
  MODE_CONTENT=$(cat "$HARNESS/design-mode.json")
  if echo "$MODE_CONTENT" | grep -q '"mode": "auto"'; then
    ok "design-mode.json mode=auto (confidence 0.9 > 0.4)"
  else
    fail "expected mode=auto in design-mode.json: $MODE_CONTENT"
  fi
  if echo "$MODE_CONTENT" | grep -q '"confidence": 0.9'; then
    ok "design-mode.json confidence=0.9"
  else
    fail "expected confidence=0.9: $MODE_CONTENT"
  fi
  if echo "$MODE_CONTENT" | grep -q '"source": "inferred"'; then
    ok "design-mode.json source=inferred"
  else
    fail "expected source=inferred: $MODE_CONTENT"
  fi
else
  fail "design-mode.json not written"
fi

# ── 4. Verify design-selection.json ─────────────────────────────
if [ -f "$HARNESS/design-selection.json" ]; then
  ok "design-selection.json exists"
  SEL_CONTENT=$(cat "$HARNESS/design-selection.json")
  if echo "$SEL_CONTENT" | grep -q '"industry": "test"'; then
    ok "design-selection.json industry=test"
  else
    fail "expected industry=test: $SEL_CONTENT"
  fi
else
  fail "design-selection.json not written"
fi

# ── 5. Verify design-brief.md ──────────────────────────────────
if [ -f "$HARNESS/design-brief.md" ]; then
  ok "design-brief.md exists"
  if grep -q "Test brief from ok-ext" "$HARNESS/design-brief.md"; then
    ok "design-brief.md content correct"
  else
    fail "design-brief.md content wrong"
  fi
else
  fail "design-brief.md not written"
fi

# ── 6. Verify design-tokens.json ───────────────────────────────
if [ -f "$HARNESS/design-tokens.json" ]; then
  ok "design-tokens.json exists"
  TOKENS_CONTENT=$(cat "$HARNESS/design-tokens.json")
  if echo "$TOKENS_CONTENT" | grep -q '"bg": "#FFFFFF"'; then
    ok "design-tokens.json has bg token"
  else
    fail "expected bg token: $TOKENS_CONTENT"
  fi
else
  fail "design-tokens.json not written"
fi

if [ -f "$HARNESS/di-state.json" ]; then
  ok "di-state.json exists"
  if grep -q '"preflight"' "$HARNESS/di-state.json"; then
    ok "di-state.json records preflight state"
  else
    fail "di-state.json missing preflight state: $(cat "$HARNESS/di-state.json")"
  fi
else
  fail "di-state.json not written"
fi

# ── 7. No preflight on nodes without capability ─────────────────
echo "§4 No-op on non-matching node"
# Use a flow where code-review has only unmatched capabilities
NOOP_FLOW="$TMP/noop-flow.json"
cat > "$NOOP_FLOW" <<'EOF'
{
  "opc_compat": ">=0.0",
  "nodes": ["build", "code-review", "gate"],
  "edges": {
    "build":       { "PASS": "code-review" },
    "code-review": { "PASS": "gate" },
    "gate":        { "PASS": null, "FAIL": "build", "ITERATE": "build" }
  },
  "limits": { "maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5 },
  "nodeTypes": { "build": "build", "code-review": "review", "gate": "gate" },
  "nodeCapabilities": {
    "build": ["design-preflight@1", "verification@1"],
    "code-review": ["unrelated-check@1"]
  }
}
EOF
NOOP_HARNESS="$TMP/noop-harness"
NOOP_CFG="$NOOP_HARNESS/.opc"
mkdir -p "$NOOP_CFG"
cat > "$NOOP_CFG/config.json" <<EOF
{
  "extensionsDir": "$EXT_DIR"
}
EOF
cat > "$NOOP_HARNESS/acceptance-criteria.md" <<'EOF'
# Noop Test
EOF
cat > "$NOOP_HARNESS/flow-state.json" <<EOF
{
  "currentNode": "build",
  "flow": "noop-flow",
  "_flow_file": "$NOOP_FLOW",
  "totalSteps": 0,
  "edgeCounts": {},
  "reentryCount": {}
}
EOF
NOOP_OUT=$(OPC_BREAKER_STATE=disabled $HARNESS_BIN node-preflight --node code-review --dir "$NOOP_HARNESS" --flow-file "$NOOP_FLOW" 2>/dev/null)
if echo "$NOOP_OUT" | grep -q '"preflightResults":0'; then
  ok "no preflight on code-review node (no matching capability)"
else
  fail "expected 0 preflight results on code-review: $NOOP_OUT"
fi

# ── 8. Extension without preflight hook is silently skipped ──────
echo "§5 Extension without preflight"
# Create a minimal extension with no preflight export
mkdir -p "$EXT_DIR/no-preflight"
cat > "$EXT_DIR/no-preflight/hook.mjs" <<'NEOF'
export const meta = { provides: ["design-preflight@1"] };
export function promptAppend() { return "## no-preflight ext"; }
NEOF

SKIP_OUT=$(OPC_BREAKER_STATE=disabled $HARNESS_BIN node-preflight --node build --dir "$HARNESS" --flow-file "$FLOW_FILE" 2>/dev/null)
if echo "$SKIP_OUT" | grep -q '"ok":true'; then
  ok "node-preflight still succeeds with ext that has no preflight hook"
else
  fail "node-preflight failed with mixed extensions: $SKIP_OUT"
fi

# ── 9. design-mode.json mode=auto even for low confidence ────────
echo "§6 Low confidence → still mode=auto (confidence controls strictness, not activation)"
# Replace ok-ext with a low-confidence preflight
cat > "$EXT_DIR/ok-ext/hook.mjs" <<'LCEOF'
export const meta = { provides: ["verification@1"] };
export function preflight() {
  return { type: "design", confidence: 0.2, reason: "low confidence test" };
}
LCEOF
# Clear old artifacts
rm -f "$HARNESS/design-mode.json"
LOW_OUT=$(OPC_BREAKER_STATE=disabled $HARNESS_BIN node-preflight --node build --dir "$HARNESS" --flow-file "$FLOW_FILE" 2>/dev/null)
if [ -f "$HARNESS/design-mode.json" ]; then
  LOW_MODE=$(cat "$HARNESS/design-mode.json")
  if echo "$LOW_MODE" | grep -q '"mode": "auto"'; then
    ok "design-mode.json mode=auto for confidence 0.2 (auto regardless of confidence)"
  else
    fail "expected mode=auto for low confidence: $LOW_MODE"
  fi
  if echo "$LOW_MODE" | grep -q '"confidence": 0.2'; then
    ok "confidence preserved at 0.2 for downstream strictness decisions"
  else
    fail "expected confidence=0.2: $LOW_MODE"
  fi
else
  fail "design-mode.json not written for low confidence"
fi

# ── 10. design-mode.json mode=explicit for userOverride ──────────
echo "§7 User override → mode=explicit"
cat > "$EXT_DIR/ok-ext/hook.mjs" <<'UOEOF'
export const meta = { provides: ["verification@1"] };
export function preflight() {
  return { type: "design", confidence: 0.5, userOverride: true, reason: "user override test" };
}
UOEOF
rm -f "$HARNESS/design-mode.json"
UO_OUT=$(OPC_BREAKER_STATE=disabled $HARNESS_BIN node-preflight --node build --dir "$HARNESS" --flow-file "$FLOW_FILE" 2>/dev/null)
if [ -f "$HARNESS/design-mode.json" ]; then
  UO_MODE=$(cat "$HARNESS/design-mode.json")
  if echo "$UO_MODE" | grep -q '"mode": "explicit"'; then
    ok "design-mode.json mode=explicit for userOverride"
  else
    fail "expected mode=explicit for userOverride: $UO_MODE"
  fi
  if echo "$UO_MODE" | grep -q '"source": "user-override"'; then
    ok "design-mode.json source=user-override"
  else
    fail "expected source=user-override: $UO_MODE"
  fi
else
  fail "design-mode.json not written for userOverride"
fi

# ── 11. design-mode.json mode=off when extension explicitly says off ──
echo "§8 Extension explicit mode=off"
cat > "$EXT_DIR/ok-ext/hook.mjs" <<'OFFEOF'
export const meta = { provides: ["verification@1"] };
export function preflight() {
  return { type: "design", mode: "off", confidence: 0.5, reason: "explicit off test" };
}
OFFEOF
rm -f "$HARNESS/design-mode.json"
OFF_OUT=$(OPC_BREAKER_STATE=disabled $HARNESS_BIN node-preflight --node build --dir "$HARNESS" --flow-file "$FLOW_FILE" 2>/dev/null)
if [ -f "$HARNESS/design-mode.json" ]; then
  OFF_MODE=$(cat "$HARNESS/design-mode.json")
  if echo "$OFF_MODE" | grep -q '"mode": "off"'; then
    ok "design-mode.json mode=off when extension explicitly returns mode=off"
  else
    fail "expected mode=off for explicit off: $OFF_MODE"
  fi
else
  fail "design-mode.json not written for explicit off"
fi

# ── Summary ─────────────────────────────────────────────────────
echo
echo "═══ Results: $PASS passed, $FAIL failed ═══"
if [ "$FAIL" -gt 0 ]; then
  echo "$FAIL_DETAILS"
  exit 1
fi
