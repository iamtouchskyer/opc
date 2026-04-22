#!/bin/bash
# test-run2-bypass-part2.sh — Run 2 bypass-chain (methods 5-8: priority, flag-prio, unknown, coexist)

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

TMP=$(mktemp -d -t opc-run2-bypass-p2-XXXXXX)
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

mkdir -p "$TMP/fake-home"

export OPC_HOOK_TIMEOUT_MS=500
export OPC_HOOK_FAILURE_THRESHOLD=1

cd "$TMP" || exit 1
OPC="node $REPO_ROOT/bin/opc-harness.mjs"

echo "=== TEST: Run 2 bypass-chain (methods 5-8) ==="

# ─────────────────────────────────────────────────────────────────
# Method 5: priority — env > flag (env wins even when --extensions also given)
# ─────────────────────────────────────────────────────────────────
echo "--- 5.1: priority — OPC_DISABLE_EXTENSIONS=1 wins over --extensions ok-ext ---"
H5="harness-priority"
mkdir -p "$H5"

HOME="$TMP/fake-home" \
OPC_EXTENSIONS_DIR="$EXT_DIR" \
OPC_DISABLE_EXTENSIONS=1 \
  $OPC init --flow-file "$FLOW_FILE" --entry review --dir "$H5" --extensions ok-ext \
  >"$TMP/prio-init.out" 2>"$TMP/prio-init.err" || true

if [ -f "$H5/.ext-registry.json" ]; then
  APPLIED_LEN=$(jq -r '.applied | length' "$H5/.ext-registry.json" 2>/dev/null || echo "x")
  BMODE=$(jq -r '.bypass.mode // "null"' "$H5/.ext-registry.json" 2>/dev/null || echo "x")
  BSRC=$(jq -r '.bypass.source // "null"' "$H5/.ext-registry.json" 2>/dev/null || echo "x")
  if [ "$APPLIED_LEN" = "0" ] && [ "$BMODE" = "disable-all" ] && [ "$BSRC" = "env" ]; then
    ok "priority: env wins (applied=[], mode=disable-all, source=env) — whitelist ignored"
  else
    fail "priority: env did not win (applied.length=$APPLIED_LEN mode=$BMODE source=$BSRC)"
  fi
else
  fail "priority: .ext-registry.json not created"
fi

# Cleanup the env var so a 2nd run inside this shell wouldn't inherit it
unset OPC_DISABLE_EXTENSIONS

# ─────────────────────────────────────────────────────────────────
# Method 6: --no-extensions priority over --extensions (flag-vs-flag)
# ─────────────────────────────────────────────────────────────────
echo "--- 6.1: --no-extensions wins over --extensions ok-ext (flag priority) ---"
H6="harness-flagprio"
mkdir -p "$H6"

HOME="$TMP/fake-home" \
OPC_EXTENSIONS_DIR="$EXT_DIR" \
  $OPC init --flow-file "$FLOW_FILE" --entry review --dir "$H6" \
  --no-extensions --extensions ok-ext \
  >"$TMP/flagprio-init.out" 2>"$TMP/flagprio-init.err" || true

if [ -f "$H6/.ext-registry.json" ]; then
  APPLIED_LEN=$(jq -r '.applied | length' "$H6/.ext-registry.json" 2>/dev/null || echo "x")
  BMODE=$(jq -r '.bypass.mode // "null"' "$H6/.ext-registry.json" 2>/dev/null || echo "x")
  if [ "$APPLIED_LEN" = "0" ] && [ "$BMODE" = "disable-all" ]; then
    ok "flag-priority: --no-extensions wins (applied=[], mode=disable-all)"
  else
    fail "flag-priority: --no-extensions did not win (applied.length=$APPLIED_LEN mode=$BMODE)"
  fi
fi

# ─────────────────────────────────────────────────────────────────
# Method 7: --extensions <unknown-name> — graceful empty applied (G7)
# ─────────────────────────────────────────────────────────────────
echo "--- 7.1: --extensions does-not-exist — graceful empty applied[] ---"
H7="harness-unknown"
mkdir -p "$H7"

HOME="$TMP/fake-home" \
OPC_EXTENSIONS_DIR="$EXT_DIR" \
  $OPC init --flow-file "$FLOW_FILE" --entry review --dir "$H7" \
  --extensions does-not-exist \
  >"$TMP/unknown-init.out" 2>"$TMP/unknown-init.err" || true

if [ -f "$H7/.ext-registry.json" ]; then
  APPLIED_LEN=$(jq -r '.applied | length' "$H7/.ext-registry.json" 2>/dev/null || echo "x")
  BMODE=$(jq -r '.bypass.mode // "null"' "$H7/.ext-registry.json" 2>/dev/null || echo "x")
  if [ "$APPLIED_LEN" = "0" ] && [ "$BMODE" = "whitelist" ]; then
    ok "unknown-name: applied=[] AND bypass.mode=whitelist (graceful filter, no crash)"
  else
    fail "unknown-name: applied.length=$APPLIED_LEN bypass.mode=$BMODE (expected 0, whitelist)"
  fi
else
  fail "unknown-name: .ext-registry.json not created (init crashed on unknown ext name)"
fi

# ─────────────────────────────────────────────────────────────────
# Method 8: env + --no-extensions co-presence — both align, env wins source (G7)
# ─────────────────────────────────────────────────────────────────
echo "--- 8.1: OPC_DISABLE_EXTENSIONS=1 + --no-extensions — env wins source attribution ---"
H8="harness-coexist"
mkdir -p "$H8"

HOME="$TMP/fake-home" \
OPC_EXTENSIONS_DIR="$EXT_DIR" \
OPC_DISABLE_EXTENSIONS=1 \
  $OPC init --flow-file "$FLOW_FILE" --entry review --dir "$H8" --no-extensions \
  >"$TMP/coexist-init.out" 2>"$TMP/coexist-init.err" || true

if [ -f "$H8/.ext-registry.json" ]; then
  APPLIED_LEN=$(jq -r '.applied | length' "$H8/.ext-registry.json" 2>/dev/null || echo "x")
  BMODE=$(jq -r '.bypass.mode // "null"' "$H8/.ext-registry.json" 2>/dev/null || echo "x")
  BSRC=$(jq -r '.bypass.source // "null"' "$H8/.ext-registry.json" 2>/dev/null || echo "x")
  if [ "$APPLIED_LEN" = "0" ] && [ "$BMODE" = "disable-all" ] && [ "$BSRC" = "env" ]; then
    ok "coexist: env+flag both → applied=[], mode=disable-all, source=env (priority deterministic)"
  else
    fail "coexist: applied.length=$APPLIED_LEN mode=$BMODE source=$BSRC (expected 0, disable-all, env)"
  fi
fi
unset OPC_DISABLE_EXTENSIONS

# ─── Summary ──────────────────────────────────────────────────────
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
