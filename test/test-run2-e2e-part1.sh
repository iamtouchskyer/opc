#!/bin/bash
# test-run2-e2e-part1.sh — Run 2 E2E verification (sections 1-3: init, prompt, verdict)

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

TMP=$(mktemp -d -t opc-run2-e2e-p1-XXXXXX)
cleanup() {
  if [ "$FAIL" -eq 0 ]; then
    rm -rf "$TMP"
  else
    echo "  ⚠️  TMP preserved for diagnosis: $TMP" >&2
  fi
}
trap cleanup EXIT INT TERM HUP

# ── Stage fixtures in a private extensionsDir under $TMP ─────────
EXT_DIR="$TMP/extensions"
mkdir -p "$EXT_DIR"
cp -R "$REPO_ROOT/test/fixtures/run2-ext/ok-ext"    "$EXT_DIR/"
cp -R "$REPO_ROOT/test/fixtures/run2-ext/slow-ext"  "$EXT_DIR/"
cp -R "$REPO_ROOT/test/fixtures/run2-ext/throw-ext" "$EXT_DIR/"

# ── Custom flow file: solo review node declaring verification@1 ──
FLOW_FILE="$TMP/run2-review.json"
cat > "$FLOW_FILE" <<'EOF'
{
  "opc_compat": ">=0.0",
  "name": "run2-review",
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
HARNESS="$TMP/$HARNESS_NAME"
OPC_CFG_DIR="$HARNESS/.opc"
mkdir -p "$OPC_CFG_DIR"
cat > "$OPC_CFG_DIR/config.json" <<EOF
{
  "extensionsDir": "$EXT_DIR"
}
EOF

# ── Seed acceptance-criteria.md ────────────────────────────────
cat > "$HARNESS/acceptance-criteria.md" <<'EOF'
# Run 2 E2E Harness — Acceptance Criteria

**Tier:** functional
**Scope:** Local throwaway harness used only by test-run2-e2e.sh to drive the
3 Run 2 fixtures through the extension dispatch pipeline.

## Outcomes

- OUT-1: All 3 fixtures load via extensionsDir.
- OUT-2: ok-ext fires on every runtime hook (prompt/verdict/execute/artifact).
- OUT-3: slow-ext trips the HOOK_TIMEOUT_MS breaker on prompt.append.
- OUT-4: throw-ext trips the error breaker on verdict.append.
- OUT-5: extension-failures.md lists both broken extensions with 🔴.

## Verification

- OUT-1: .ext-registry.json applied contains all 3 fixture names after init.
- OUT-2: ok-ext-marker.txt exists in runDir/ext-ok-ext/ after extension-artifact.
- OUT-3: extension-failures.md contains slow-ext + timeout marker.
- OUT-4: extension-failures.md contains throw-ext + "intentional failure".
- OUT-5: handshake.artifacts[] includes ok-ext's emitted artifact path.

## Out of Scope

- Testing core changes to extensionsApplied filtering (separate unit).
- Performance or cross-platform behavior.

## Quality Constraints

- Test is hermetic: uses $TMP, no touch to ~/.opc or global state.
- Deterministic: OPC_HOOK_TIMEOUT_MS pinned so slow-ext trips on every run.

## Quality Baseline (functional)

- Non-zero exit on any assertion failure.
- stderr captures extension failures for human review.
EOF

# ── Pin timeout + breaker threshold for determinism ──────────────
export OPC_HOOK_TIMEOUT_MS=500
export OPC_HOOK_FAILURE_THRESHOLD=1
export OPC_EXTENSIONS_DIR="$EXT_DIR"
export HOME="$TMP/fake-home"
mkdir -p "$HOME"

cd "$TMP" || exit 1
OPC="node $REPO_ROOT/bin/opc-harness.mjs"

echo "=== TEST: Run 2 E2E — sections 1-3 (init, prompt, verdict) ==="

# ── 1. init the harness with the custom flow ─────────────────────
echo "--- 1.1: init --flow-file loads 3 fixtures ---"
$OPC init \
  --flow-file "$FLOW_FILE" \
  --entry review \
  --dir "$HARNESS_NAME" >"$TMP/init.out" 2>"$TMP/init.err" || true

if [ ! -f "$HARNESS_NAME/flow-state.json" ]; then
  fail "init did not create flow-state.json (see $TMP/init.err)"
  cat "$TMP/init.err" >&2
else
  ok "init created flow-state.json"
fi

# .ext-registry.json should list all 3 fixtures as applied
if [ -f "$HARNESS_NAME/.ext-registry.json" ]; then
  APPLIED=$(jq -r '.applied | sort | join(",")' "$HARNESS_NAME/.ext-registry.json" 2>/dev/null || echo "")
  if [ "$APPLIED" = "ok-ext,slow-ext,throw-ext" ]; then
    ok ".ext-registry.json applied = [ok-ext, slow-ext, throw-ext]"
  else
    fail ".ext-registry.json applied = '$APPLIED' (expected 'ok-ext,slow-ext,throw-ext')"
  fi
else
  fail ".ext-registry.json not created"
fi

# ── 2. prompt-context fires promptAppend on matching extensions ──
echo "--- 2.1: prompt-context fires promptAppend under pinned timeout ---"

RUN_DIR_REL="$HARNESS_NAME/nodes/review/run_1"
mkdir -p "$RUN_DIR_REL"
echo '{}' > "$RUN_DIR_REL/handshake.json"

$OPC prompt-context \
  --node review --role evaluator \
  --flow-file "$FLOW_FILE" \
  --dir "$HARNESS_NAME" >"$TMP/prompt.out" 2>"$TMP/prompt.err" || true

if [ -s "$TMP/prompt.out" ]; then
  APPEND=$(jq -r '.append' "$TMP/prompt.out" 2>/dev/null || echo "")
  if echo "$APPEND" | grep -q "From ok-ext"; then
    ok "prompt-context append includes 'From ok-ext'"
  else
    fail "prompt-context append missing 'From ok-ext' — got: $(echo "$APPEND" | head -c 200)"
  fi
  if echo "$APPEND" | grep -q "From throw-ext"; then
    ok "prompt-context append includes 'From throw-ext' (throw-ext's promptAppend is innocuous)"
  else
    fail "prompt-context append missing 'From throw-ext'"
  fi
  # slow-ext should NOT appear — it timed out
  if echo "$APPEND" | grep -q "From slow-ext"; then
    fail "prompt-context append includes 'From slow-ext' — slow hook should have timed out"
  else
    ok "slow-ext's promptAppend correctly isolated by timeout (not in append)"
  fi
else
  fail "prompt-context produced no stdout (see $TMP/prompt.err)"
  cat "$TMP/prompt.err" >&2
fi

# Breaker should have tripped on slow-ext
if grep -q "CIRCUIT-BREAKER.*slow-ext" "$TMP/prompt.err"; then
  ok "slow-ext breaker tripped (stderr CIRCUIT-BREAKER line present)"
else
  fail "slow-ext breaker did NOT trip (no CIRCUIT-BREAKER line on stderr)"
fi

# ── 3. extension-verdict fires verdictAppend ─────────────────────
echo "--- 3.1: extension-verdict fires verdictAppend, throw-ext trips breaker ---"

$OPC extension-verdict \
  --node review \
  --flow-file "$FLOW_FILE" \
  --dir "$HARNESS_NAME" >"$TMP/verdict.out" 2>"$TMP/verdict.err" || true

if grep -q "CIRCUIT-BREAKER.*throw-ext" "$TMP/verdict.err"; then
  ok "throw-ext breaker tripped on verdict.append"
else
  fail "throw-ext breaker did NOT trip (see $TMP/verdict.err)"
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
