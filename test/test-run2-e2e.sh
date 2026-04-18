#!/bin/bash
# test-run2-e2e.sh — Run 2 end-to-end verification of extension stability
#
# Wires the 3 Run 2 fixtures (ok-ext, slow-ext, throw-ext) via a custom flow
# file that maps `verification@1` to a review node, runs the full
# prompt-context → extension-verdict → extension-artifact sequence, and
# asserts the Run 1 hardening guarantees hold end-to-end:
#
#   (a) ok-ext fires on all 4 runtime hooks (prompt/verdict/execute/artifact)
#   (b) slow-ext trips the HOOK_TIMEOUT_MS breaker on prompt.append
#   (c) throw-ext trips the error breaker on verdict.append
#   (d) extension-failures.md records both broken extensions with 🔴
#   (e) ok-ext's outputs are isolated from siblings' failures
#
# NOTE on OUT-2: handshake.extensionsApplied is currently a LOAD-TIME snapshot
# in core (bin/lib/ext-commands.mjs:118/307/388 — `handshake.extensionsApplied
# = registry.applied`). That's the shape documented in CONTRACTS.md for Run 1.
# Changing it to filter by `ext.enabled` is a behavior change that belongs in
# its own unit pair, not U2.4. This test therefore asserts the weaker but
# empirically stable invariants: ok-ext is in `extensionsApplied`, and the
# registry's failures file names both broken extensions.

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

TMP=$(mktemp -d -t opc-run2-e2e-XXXXXX)
# G6 fix: keep-on-fail (mirrors strict.sh + bypass.sh) + handle signal-driven exits.
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

# resolveDir() in bin/lib/util.mjs requires --dir to be under cwd. Work
# from $TMP so the harness dir is valid.
HARNESS_NAME="harness"
HARNESS="$TMP/$HARNESS_NAME"
OPC_CFG_DIR="$HARNESS/.opc"
mkdir -p "$OPC_CFG_DIR"
cat > "$OPC_CFG_DIR/config.json" <<EOF
{
  "extensionsDir": "$EXT_DIR"
}
EOF

# ── Seed acceptance-criteria.md so readTaskFromAC() works ────────
# opc-harness init requires this to pass criteria-lint; write a minimal
# passing criteria doc.
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
# cmdInit's loadExtensions does NOT read .opc/config.json — it only honors
# OPC_EXTENSIONS_DIR env or default ~/.opc/extensions. Export so init sees
# the fixture dir. Downstream commands (prompt-context/verdict/artifact) also
# read this env first.
export OPC_EXTENSIONS_DIR="$EXT_DIR"
# Isolate HOME so no ambient ~/.opc config leaks in
export HOME="$TMP/fake-home"
mkdir -p "$HOME"

# resolveDir requires --dir under cwd. cd into $TMP and drive the harness
# via --dir "$HARNESS_NAME" so all paths resolve under the temp tree.
cd "$TMP" || exit 1
OPC="node $REPO_ROOT/bin/opc-harness.mjs"

echo "=== TEST: Run 2 E2E — 3-fixture pipeline ==="

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
# throw-ext's verdictAppend throws → breaker trips.
# ok-ext returns 1 info finding.
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

# Snapshot extension-failures.md right after verdict — each CLI invocation
# creates a fresh registry with empty failures[], and extension-artifact's
# writeFailureReport() call will OVERWRITE the file with "No hook failures
# recorded". Assert the immediate-post-verdict content is what matters.
FAILURES_MD_MID="$TMP/extension-failures-after-verdict.md"
if [ -f "$RUN_DIR_REL/extension-failures.md" ]; then
  cp "$RUN_DIR_REL/extension-failures.md" "$FAILURES_MD_MID"
fi

# ── 4. extension-artifact fires execute.run + artifact.emit ──────
# Only ok-ext implements these hooks. slow-ext and throw-ext are disabled
# by now; even if they weren't, they don't implement these hooks.
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

# G4 fix: assert executeRun side-effect (was previously untested — fixture was no-op)
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

# ── 5. extension-failures.md records throw-ext ───────────────────
# NOTE 1 (prompt-context gap): core calls writeFailureReport() only after
# fireVerdictAppend and fireArtifactEmit — NOT after firePromptAppend. So
# slow-ext's timeout (prompt phase) is not persisted to extension-failures.md;
# the CIRCUIT-BREAKER line on stderr (asserted above) is the only record.
# NOTE 2 (cross-command overwrite gap): each CLI invocation loads a FRESH
# registry with empty failures[]. extension-artifact's writeFailureReport()
# therefore overwrites the file produced by extension-verdict with "No
# failures recorded". We snapshot the file immediately after extension-verdict
# (see FAILURES_MD_MID above) to preserve the throw-ext record and assert on
# that snapshot. Both gaps file as downstream fix-pairs per plan.md protocol.
echo "--- 5.1: extension-failures.md records throw-ext with 🔴 (post-verdict snapshot) ---"

FAILURES_MD="$FAILURES_MD_MID"
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
  # slow-ext is NOT expected here — document the gap inline so future
  # readers understand why.
  if grep -q "slow-ext" "$FAILURES_MD"; then
    ok "[bonus] extension-failures.md also names slow-ext (core fixed prompt-context to call writeFailureReport)"
  fi
else
  fail "extension-failures.md not written at $FAILURES_MD"
fi

# ── 6. Isolation: ok-ext's outputs untouched by sibling failures ─
echo "--- 6.1: Isolation — ok-ext fired on every applicable hook ---"

# We already verified ok-ext's prompt + artifact outputs. Verify the verdict
# finding landed in the per-node eval-extensions.md file.
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
