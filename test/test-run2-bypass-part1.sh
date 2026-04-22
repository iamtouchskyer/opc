#!/bin/bash
# test-run2-bypass-part1.sh — Run 2 bypass-chain (methods 1-4: env, flag, whitelist, prompt)

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

TMP=$(mktemp -d -t opc-run2-bypass-p1-XXXXXX)
cleanup() {
  if [ "$FAIL" -eq 0 ]; then
    rm -rf "$TMP"
  else
    echo "  ⚠️  TMP preserved for diagnosis: $TMP" >&2
  fi
}
trap cleanup EXIT INT TERM HUP

# ── Stage fixtures ─────────────────────────────────────────────────
EXT_DIR="$TMP/extensions"
mkdir -p "$EXT_DIR"
cp -R "$REPO_ROOT/test/fixtures/run2-ext/ok-ext"    "$EXT_DIR/"
cp -R "$REPO_ROOT/test/fixtures/run2-ext/slow-ext"  "$EXT_DIR/"
cp -R "$REPO_ROOT/test/fixtures/run2-ext/throw-ext" "$EXT_DIR/"

# ── Custom flow file ──
FLOW_FILE="$TMP/run2-bypass.json"
cat > "$FLOW_FILE" <<'EOF'
{
  "opc_compat": ">=0.0",
  "name": "run2-bypass",
  "nodes": ["review", "gate"],
  "edges": {
    "review": { "PASS": "gate" },
    "gate":   { "PASS": null, "FAIL": "review", "ITERATE": "review" }
  },
  "limits": { "maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5 },
  "nodeTypes": { "review": "review", "gate": "gate" },
  "nodeCapabilities": { "review": ["verification@1"] }
}
EOF

HARNESS_NAME="harness"
mkdir -p "$TMP/$HARNESS_NAME"
mkdir -p "$TMP/fake-home"

export OPC_HOOK_TIMEOUT_MS=500
export OPC_HOOK_FAILURE_THRESHOLD=1

cd "$TMP" || exit 1
OPC="node $REPO_ROOT/bin/opc-harness.mjs"

echo "=== TEST: Run 2 bypass-chain (methods 1-4) ==="

# ─────────────────────────────────────────────────────────────────
# Method 1: OPC_DISABLE_EXTENSIONS=1 env
# ─────────────────────────────────────────────────────────────────
echo "--- 1.1: OPC_DISABLE_EXTENSIONS=1 — 0 extensions loaded ---"
H1="harness-env"
mkdir -p "$H1"

HOME="$TMP/fake-home" \
OPC_EXTENSIONS_DIR="$EXT_DIR" \
OPC_DISABLE_EXTENSIONS=1 \
  $OPC init --flow-file "$FLOW_FILE" --entry review --dir "$H1" \
  >"$TMP/env-init.out" 2>"$TMP/env-init.err" || true

if [ -f "$H1/.ext-registry.json" ]; then
  APPLIED_LEN=$(jq -r '.applied | length' "$H1/.ext-registry.json" 2>/dev/null || echo "x")
  BMODE=$(jq -r '.bypass.mode // "null"' "$H1/.ext-registry.json" 2>/dev/null || echo "x")
  if [ "$APPLIED_LEN" = "0" ] && [ "$BMODE" = "disable-all" ]; then
    ok "env: applied=[] AND bypass.mode=disable-all"
  else
    fail "env: applied.length=$APPLIED_LEN bypass.mode=$BMODE (expected 0, disable-all)"
  fi
else
  fail "env: .ext-registry.json not created"
fi

# bypass message on stderr (source=env)
if grep -q "OPC_DISABLE_EXTENSIONS" "$TMP/env-init.err"; then
  ok "env: stderr names OPC_DISABLE_EXTENSIONS as bypass source"
else
  fail "env: stderr missing OPC_DISABLE_EXTENSIONS bypass message"
fi

# flow-state.bypassMode persisted
if [ -f "$H1/flow-state.json" ]; then
  FSMODE=$(jq -r '.bypassMode.mode // "null"' "$H1/flow-state.json" 2>/dev/null || echo "x")
  FSSRC=$(jq -r '.bypassMode.source // "null"' "$H1/flow-state.json" 2>/dev/null || echo "x")
  if [ "$FSMODE" = "disable-all" ] && [ "$FSSRC" = "env" ]; then
    ok "env: flow-state.bypassMode = {disable-all, env}"
  else
    fail "env: flow-state.bypassMode mismatch (mode=$FSMODE source=$FSSRC)"
  fi
fi

# ─────────────────────────────────────────────────────────────────
# Method 2: --no-extensions CLI flag (no env)
# ─────────────────────────────────────────────────────────────────
echo "--- 2.1: --no-extensions — 0 extensions loaded ---"
H2="harness-flag"
mkdir -p "$H2"

# Explicitly UNSET env to prove flag works alone
unset OPC_DISABLE_EXTENSIONS

HOME="$TMP/fake-home" \
OPC_EXTENSIONS_DIR="$EXT_DIR" \
  $OPC init --flow-file "$FLOW_FILE" --entry review --dir "$H2" --no-extensions \
  >"$TMP/flag-init.out" 2>"$TMP/flag-init.err" || true

if [ -f "$H2/.ext-registry.json" ]; then
  APPLIED_LEN=$(jq -r '.applied | length' "$H2/.ext-registry.json" 2>/dev/null || echo "x")
  BMODE=$(jq -r '.bypass.mode // "null"' "$H2/.ext-registry.json" 2>/dev/null || echo "x")
  BSRC=$(jq -r '.bypass.source // "null"' "$H2/.ext-registry.json" 2>/dev/null || echo "x")
  if [ "$APPLIED_LEN" = "0" ] && [ "$BMODE" = "disable-all" ] && [ "$BSRC" = "flag" ]; then
    ok "flag: applied=[] AND bypass={disable-all, flag}"
  else
    fail "flag: applied.length=$APPLIED_LEN bypass.mode=$BMODE source=$BSRC (expected 0, disable-all, flag)"
  fi
else
  fail "flag: .ext-registry.json not created"
fi

# stderr should name --no-extensions, NOT OPC_DISABLE_EXTENSIONS
if grep -q -- "--no-extensions" "$TMP/flag-init.err"; then
  ok "flag: stderr names --no-extensions as bypass source"
else
  fail "flag: stderr missing --no-extensions message"
fi

# ─────────────────────────────────────────────────────────────────
# Method 3: --extensions ok-ext (whitelist)
# ─────────────────────────────────────────────────────────────────
echo "--- 3.1: --extensions ok-ext — only ok-ext applied ---"
H3="harness-whitelist"
mkdir -p "$H3"

HOME="$TMP/fake-home" \
OPC_EXTENSIONS_DIR="$EXT_DIR" \
  $OPC init --flow-file "$FLOW_FILE" --entry review --dir "$H3" --extensions ok-ext \
  >"$TMP/wl-init.out" 2>"$TMP/wl-init.err" || true

if [ -f "$H3/.ext-registry.json" ]; then
  APPLIED=$(jq -r '.applied | sort | join(",")' "$H3/.ext-registry.json" 2>/dev/null || echo "x")
  BMODE=$(jq -r '.bypass.mode // "null"' "$H3/.ext-registry.json" 2>/dev/null || echo "x")
  if [ "$APPLIED" = "ok-ext" ] && [ "$BMODE" = "whitelist" ]; then
    ok "whitelist: applied=[ok-ext] AND bypass.mode=whitelist"
  else
    fail "whitelist: applied='$APPLIED' bypass.mode=$BMODE (expected 'ok-ext', whitelist)"
  fi
else
  fail "whitelist: .ext-registry.json not created"
fi

# slow-ext + throw-ext must NOT appear in applied
if [ -f "$H3/.ext-registry.json" ]; then
  HAS_SLOW=$(jq -r '.applied | map(. == "slow-ext") | any' "$H3/.ext-registry.json" 2>/dev/null || echo "x")
  HAS_THROW=$(jq -r '.applied | map(. == "throw-ext") | any' "$H3/.ext-registry.json" 2>/dev/null || echo "x")
  if [ "$HAS_SLOW" = "false" ] && [ "$HAS_THROW" = "false" ]; then
    ok "whitelist: slow-ext + throw-ext correctly excluded from applied"
  else
    fail "whitelist: leakage detected (slow=$HAS_SLOW throw=$HAS_THROW)"
  fi
fi

# stderr names --extensions
if grep -q -- "--extensions" "$TMP/wl-init.err"; then
  ok "whitelist: stderr names --extensions as bypass source"
else
  fail "whitelist: stderr missing --extensions message"
fi

# ─────────────────────────────────────────────────────────────────
# Method 4: prompt-context under whitelist — only ok-ext fires
# ─────────────────────────────────────────────────────────────────
echo "--- 4.1: prompt-context under --extensions ok-ext — no breaker trips ---"

# Seed a run dir for review node
mkdir -p "$H3/nodes/review/run_1"
echo '{}' > "$H3/nodes/review/run_1/handshake.json"

HOME="$TMP/fake-home" \
OPC_EXTENSIONS_DIR="$EXT_DIR" \
  $OPC prompt-context --node review --role evaluator \
  --flow-file "$FLOW_FILE" --dir "$H3" --extensions ok-ext \
  >"$TMP/wl-prompt.out" 2>"$TMP/wl-prompt.err" || true

if [ -s "$TMP/wl-prompt.out" ]; then
  APPEND=$(jq -r '.append' "$TMP/wl-prompt.out" 2>/dev/null || echo "")
  if echo "$APPEND" | grep -q "From ok-ext"; then
    ok "whitelist+prompt: 'From ok-ext' present"
  else
    fail "whitelist+prompt: 'From ok-ext' missing — got: $(echo "$APPEND" | head -c 200)"
  fi
  if echo "$APPEND" | grep -q "From throw-ext"; then
    fail "whitelist+prompt: 'From throw-ext' leaked through whitelist (should be filtered)"
  else
    ok "whitelist+prompt: throw-ext correctly absent (whitelist enforced)"
  fi
  if echo "$APPEND" | grep -q "From slow-ext"; then
    fail "whitelist+prompt: 'From slow-ext' leaked AND somehow completed"
  else
    ok "whitelist+prompt: slow-ext absent (whitelist filtered before timeout race)"
  fi
else
  fail "whitelist+prompt: prompt-context produced no stdout (see $TMP/wl-prompt.err)"
fi

# CRITICAL: under whitelist, slow-ext never loads → no CIRCUIT-BREAKER line
if grep -q "CIRCUIT-BREAKER.*slow-ext" "$TMP/wl-prompt.err"; then
  fail "whitelist+prompt: slow-ext breaker tripped — bypass should have prevented load"
else
  ok "whitelist+prompt: NO slow-ext breaker (bypass prevents load, not just dispatch)"
fi

# ── Summary ──────────────────────────────────────────────────────
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  printf "%s" "$FAIL_DETAILS"
  exit 1
fi
