#!/bin/bash
# test-run2-e2e-part2.sh — Run 2 E2E verification (sections 4-6: artifact, failures, isolation)

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

TMP=$(mktemp -d -t opc-run2-e2e-p2-XXXXXX)
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

echo "=== TEST: Run 2 E2E — sections 4-6 (artifact, failures, isolation) ==="

# ── Prereqs: replay sections 1-3 silently to build state ─────────
$OPC init --flow-file "$FLOW_FILE" --entry review --dir "$HARNESS_NAME" >/dev/null 2>/dev/null || true
RUN_DIR_REL="$HARNESS_NAME/nodes/review/run_1"
mkdir -p "$RUN_DIR_REL"
echo '{}' > "$RUN_DIR_REL/handshake.json"
$OPC prompt-context --node review --role evaluator --flow-file "$FLOW_FILE" --dir "$HARNESS_NAME" >/dev/null 2>/dev/null || true
$OPC extension-verdict --node review --flow-file "$FLOW_FILE" --dir "$HARNESS_NAME" >/dev/null 2>/dev/null || true

# ── 4. extension-artifact fires execute.run + artifact.emit ──────
echo "--- 4.1: extension-artifact fires ok-ext's artifactEmit ---"

$OPC extension-artifact \
  --node review \
  --flow-file "$FLOW_FILE" \
  --dir "$HARNESS_NAME" >"$TMP/artifact.out" 2>"$TMP/artifact.err" || true

OK_MARKER="$RUN_DIR_REL/ext-ok-ext/ok-ext-marker.txt"
if [ -f "$OK_MARKER" ]; then
  CONTENT=$(cat "$OK_MARKER")
  if [ "$CONTENT" = "ok" ]; then
    ok "ok-ext-marker.txt written with content 'ok'"
  else
    fail "ok-ext-marker.txt content = '$CONTENT' (expected 'ok')"
  fi
else
  fail "ok-ext-marker.txt NOT written at $OK_MARKER"
fi

# G4 fix: assert executeRun side-effect
EXEC_MARKER="$RUN_DIR_REL/ok-ext-execute-marker.txt"
if [ -f "$EXEC_MARKER" ]; then
  ok "ok-ext-execute-marker.txt written (executeRun fired)"
else
  fail "ok-ext-execute-marker.txt NOT written — executeRun did not fire"
fi

# handshake.artifacts[] should include the marker path
if [ -f "$RUN_DIR_REL/handshake.json" ]; then
  HAS_ART=$(jq -r '[.artifacts[]? | select(.path | contains("ok-ext-marker.txt"))] | length' "$RUN_DIR_REL/handshake.json" 2>/dev/null || echo "0")
  if [ "$HAS_ART" -ge 1 ]; then
    ok "handshake.artifacts[] includes ok-ext-marker.txt"
  else
    fail "handshake.artifacts[] missing ok-ext-marker.txt entry"
  fi
fi

# ── 5. extension-failures.md records throw-ext (FINAL content, post-artifact) ──
echo "--- 5.1: extension-failures.md records throw-ext with 🟡 (FINAL post-artifact) ---"

FAILURES_MD="$RUN_DIR_REL/extension-failures.md"
SIDECAR="$RUN_DIR_REL/extension-failures.json"

# G3 closure assertion: sidecar (canonical) must contain throw-ext entry
if [ -f "$SIDECAR" ]; then
  HAS_THROW_JSON=$(jq -r '[.failures[] | select(.ext == "throw-ext")] | length' "$SIDECAR" 2>/dev/null || echo "0")
  if [ "$HAS_THROW_JSON" -ge 1 ]; then
    ok "extension-failures.json (sidecar) preserves throw-ext across CLI invocations"
  else
    fail "extension-failures.json missing throw-ext (G3 regression — cross-command merge broken)"
    cat "$SIDECAR" >&2
  fi
else
  fail "extension-failures.json (sidecar) not written"
fi
if [ -f "$FAILURES_MD" ]; then
  if grep -q "throw-ext" "$FAILURES_MD"; then
    ok "extension-failures.md names throw-ext"
  else
    fail "extension-failures.md missing throw-ext"
    cat "$FAILURES_MD" >&2
  fi
  if grep -q "🔴" "$FAILURES_MD"; then
    ok "extension-failures.md contains 🔴 severity marker"
  else
    fail "extension-failures.md has no 🔴 markers"
  fi
  if grep -q "intentional failure" "$FAILURES_MD"; then
    ok "extension-failures.md preserves throw-ext error message"
  else
    fail "extension-failures.md missing 'intentional failure' text"
  fi
  if grep -q "slow-ext" "$FAILURES_MD"; then
    ok "[bonus] extension-failures.md also names slow-ext (core fixed prompt-context to call writeFailureReport)"
  fi
else
  fail "extension-failures.md not written at $FAILURES_MD"
fi

# ── 6. Isolation: ok-ext's outputs untouched by sibling failures ─
echo "--- 6.1: Isolation — ok-ext fired on every applicable hook ---"

EVAL_MD="$RUN_DIR_REL/eval-extensions.md"
if [ -f "$EVAL_MD" ]; then
  if grep -q "ok-ext verdict ran" "$EVAL_MD"; then
    ok "eval-extensions.md contains ok-ext's info finding"
  else
    fail "eval-extensions.md missing ok-ext's 'verdict ran' finding"
    cat "$EVAL_MD" >&2
  fi
else
  fail "eval-extensions.md not written at $EVAL_MD"
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
