#!/bin/bash
# test-run2-strict.sh — Run 2 strict-mode verification
#
# Asserts OPC_STRICT_EXTENSIONS=1 makes any extension hook failure propagate to:
#   (a) non-zero process exit code on the CLI invocation that triggered the failure
#   (b) clear stderr line naming the extension and the strict mode that caused
#       the propagation (e.g. "[opc] STRICT: throw-ext failed verdict.append — exiting non-zero")
#
# CONTRACT (Run 1 OUT-3, restated):
#   Default mode: hook failures trip the per-extension breaker, isolate the
#                 broken extension, and the CLI command returns 0.
#   Strict mode (OPC_STRICT_EXTENSIONS=1): same isolation/breaker behavior, BUT
#                 the CLI command returns NON-ZERO and stderr names the failure.
#                 This is for CI use where any extension regression should fail
#                 the build, not silently degrade.
#
# THIS TEST PASSES on core ≥ U2.7a, where OPC_STRICT_EXTENSIONS=1 is enforced
# in cmdPromptContext / cmdExtensionVerdict / cmdExtensionArtifact via
# enforceStrictMode(registry) called AFTER writeFailureReport runs (so isolation
# is preserved — siblings still complete, eval-extensions.md still written —
# the strict check only adds a non-zero exit signal for CI).

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

TMP=$(mktemp -d -t opc-run2-strict-XXXXXX)
cleanup() {
  if [ "$FAIL" -eq 0 ]; then
    rm -rf "$TMP"
  else
    echo "  ⚠️  TMP preserved for diagnosis: $TMP" >&2
  fi
}
trap cleanup EXIT INT TERM HUP

# ── Stage just throw-ext (single failing fixture is enough for strict mode) ──
EXT_DIR="$TMP/extensions"
mkdir -p "$EXT_DIR"
cp -R "$REPO_ROOT/test/fixtures/run2-ext/throw-ext" "$EXT_DIR/"
cp -R "$REPO_ROOT/test/fixtures/run2-ext/ok-ext"    "$EXT_DIR/"

# ── Custom flow file declaring verification@1 on review node ───────
FLOW_FILE="$TMP/run2-strict.json"
cat > "$FLOW_FILE" <<'EOF'
{
  "opc_compat": ">=0.0",
  "name": "run2-strict",
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
HARNESS_NAME="harness"
mkdir -p "$TMP/$HARNESS_NAME"

export OPC_HOOK_TIMEOUT_MS=500
export OPC_HOOK_FAILURE_THRESHOLD=1
export HOME="$TMP/fake-home"
export OPC_EXTENSIONS_DIR="$EXT_DIR"

cd "$TMP" || exit 1
OPC="node $REPO_ROOT/bin/opc-harness.mjs"

echo "=== TEST: Run 2 STRICT mode (OPC_STRICT_EXTENSIONS=1) ==="

# ── 1. Init harness (no strict — needed for state) ─────────────────
$OPC init --flow-file "$FLOW_FILE" --entry review --dir "$HARNESS_NAME" \
  >"$TMP/init.out" 2>"$TMP/init.err" || true

if [ ! -f "$HARNESS_NAME/flow-state.json" ]; then
  fail "init did not create flow-state.json (see $TMP/init.err)"
  cat "$TMP/init.err" >&2
fi

# Seed a run dir for review node
mkdir -p "$HARNESS_NAME/nodes/review/run_1"
echo '{}' > "$HARNESS_NAME/nodes/review/run_1/handshake.json"

# ── 2. Default mode: throw-ext.verdictAppend trips breaker → exit 0 ──
# Sanity: confirm the baseline contract (default mode = exit 0 even with broken ext)
echo "--- 2.1: BASELINE — default mode: throw-ext failure → exit 0 ---"

unset OPC_STRICT_EXTENSIONS
$OPC extension-verdict --node review \
  --flow-file "$FLOW_FILE" --dir "$HARNESS_NAME" \
  >"$TMP/default.out" 2>"$TMP/default.err"
DEFAULT_RC=$?

if [ "$DEFAULT_RC" = "0" ]; then
  ok "default: extension-verdict exits 0 despite throw-ext failure (breaker isolates)"
else
  fail "default: extension-verdict exited $DEFAULT_RC (expected 0 — baseline broken!)"
  cat "$TMP/default.err" >&2
fi

# Confirm breaker DID trip (proves throw-ext actually failed, not silently passed)
if grep -q "CIRCUIT-BREAKER.*throw-ext" "$TMP/default.err"; then
  ok "default: throw-ext breaker tripped (failure was real, not skipped)"
else
  fail "default: no CIRCUIT-BREAKER for throw-ext — failure didn't fire"
fi

# ── 3. Strict mode: same throw-ext failure → non-zero exit ─────────
echo "--- 3.1: STRICT — OPC_STRICT_EXTENSIONS=1: throw-ext failure → exit ≠ 0 ---"

# Reset run dir state so verdict re-runs from clean slate
rm -rf "$HARNESS_NAME/nodes/review/run_1"
mkdir -p "$HARNESS_NAME/nodes/review/run_1"
echo '{}' > "$HARNESS_NAME/nodes/review/run_1/handshake.json"

OPC_STRICT_EXTENSIONS=1 \
  $OPC extension-verdict --node review \
  --flow-file "$FLOW_FILE" --dir "$HARNESS_NAME" \
  >"$TMP/strict.out" 2>"$TMP/strict.err"
STRICT_RC=$?

if [ "$STRICT_RC" != "0" ]; then
  ok "strict: extension-verdict exited $STRICT_RC (non-zero — strict mode propagated)"
else
  fail "strict: extension-verdict exited 0 — STRICT mode NOT enforced (expected non-zero)"
fi

# Stderr must clearly identify (a) it was strict mode and (b) which extension failed
if grep -qiE "STRICT.*throw-ext|throw-ext.*STRICT" "$TMP/strict.err"; then
  ok "strict: stderr names STRICT mode + throw-ext (operator can diagnose)"
else
  fail "strict: stderr missing 'STRICT … throw-ext' line — operator can't tell why CI broke"
  echo "    --- strict.err ---" >&2
  head -20 "$TMP/strict.err" >&2
  echo "    ------------------" >&2
fi

# ── 4. Strict mode does NOT change isolation: ok-ext still ran ─────
# Even when STRICT exits non-zero, healthy extensions must still have completed
# their hooks (we don't roll back on failure — we just signal harder).
echo "--- 4.1: STRICT preserves isolation — ok-ext's verdict finding still recorded ---"
EVAL_MD="$HARNESS_NAME/nodes/review/run_1/eval-extensions.md"
if [ -f "$EVAL_MD" ]; then
  if grep -q "ok-ext verdict ran" "$EVAL_MD"; then
    ok "strict: eval-extensions.md still contains ok-ext finding (isolation intact)"
  else
    fail "strict: eval-extensions.md missing ok-ext finding — strict killed siblings (regression)"
  fi
else
  fail "strict: eval-extensions.md not written — strict aborted before isolation"
fi

# ── 5. Strict mode + only-healthy extensions → exit 0 (no false positives) ──
echo "--- 5.1: STRICT + only ok-ext → exit 0 (no false positives) ---"
rm -rf "$HARNESS_NAME/nodes/review/run_1"
mkdir -p "$HARNESS_NAME/nodes/review/run_1"
echo '{}' > "$HARNESS_NAME/nodes/review/run_1/handshake.json"

OPC_STRICT_EXTENSIONS=1 \
  $OPC extension-verdict --node review \
  --flow-file "$FLOW_FILE" --dir "$HARNESS_NAME" \
  --extensions ok-ext \
  >"$TMP/strict-clean.out" 2>"$TMP/strict-clean.err"
CLEAN_RC=$?

if [ "$CLEAN_RC" = "0" ]; then
  ok "strict+clean: exits 0 when no extensions failed (no false positive)"
else
  fail "strict+clean: exited $CLEAN_RC — strict tripped on healthy run (false positive)"
  head -20 "$TMP/strict-clean.err" >&2
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
