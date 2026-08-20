#!/bin/bash
set -e

# F10 DX gate: the `ctx.nodeCapabilities not set` WARN must fire ONLY when caps could
# not be resolved from a flow template (genuine misconfig / raw-library misuse). When the
# CLI successfully resolves a flow template and the node simply declares no capabilities
# (e.g. `quick`'s review node, or build-verify's test-design/gate nodes), an empty caps
# list is LEGITIMATE — emitting the WARN there is pure noise.
#
#   - quick:review                (template has no nodeCapabilities map)      → NO WARN
#   - build-verify:test-design    (map exists, node absent from it)          → NO WARN
#   - build-verify:gate           (map exists, node absent from it)          → NO WARN
#   - build-verify:code-review    (node HAS caps)                            → NO WARN (control)
#   - prompt-context with no flow-state + no --flow (template unresolvable)  → FAIL CLOSED
#
# CLI callers must name the state-selected node. Unresolvable templates and unknown nodes
# are rejected before extension routing; the raw-library WARN-once contract remains covered
# independently by extensions.test.mjs.

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

WARN_PATTERN="nodeCapabilities not set"

# A minimal well-formed extension so the registry has >0 extensions (the WARN short-circuits
# to silence when nobody is listening).
mkdir -p exts/ok-ext
cat > exts/ok-ext/hook.mjs << 'EOF'
export const meta = { name: "ok-ext", provides: ["verification@1"] };
export function promptAppend() { return ""; }
export function verdictAppend() { return []; }
EOF

assert_warn_count() {
  local desc="$1" expected="$2" stderr="$3" actual
  actual=$(echo "$stderr" | grep -c "$WARN_PATTERN" || true)
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $desc"; PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — expected $expected WARN line(s), got $actual"; FAIL=$((FAIL + 1))
  fi
}

# Init <flow> at <node>, then capture prompt-context stderr for that selected node.
warn_stderr() {
  local flow="$1" node="$2" sub
  sub="sess-${flow}-${node}"
  rm -rf "$sub"; mkdir -p "$sub"
  ( cd "$sub" && $HARNESS init --flow "$flow" --entry "$node" --dir . >/dev/null 2>&1 )
  mkdir -p "$sub/nodes/$node/run_1"
  OPC_EXTENSIONS_DIR="$TMPDIR/exts" $HARNESS prompt-context --node "$node" --role tester --dir "$sub" 2>&1 1>/dev/null
}

assert_rejected() {
  local desc="$1" rc="$2" output="$3"
  if [ "$rc" -ne 0 ] && [ -n "$output" ]; then
    echo "  ✅ $desc"; PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — expected non-zero exit with diagnostic, got rc=$rc output='$output'"; FAIL=$((FAIL + 1))
  fi
}

echo "=== F10: nodeCapabilities WARN fires only on unresolved-template path ==="

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- N1: quick:review (template has no nodeCapabilities map) → NO WARN ---"
OUT=$(warn_stderr quick review)
assert_warn_count "quick review → silent" 0 "$OUT"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- N2: build-verify:test-design (capless node) → NO WARN ---"
OUT=$(warn_stderr build-verify test-design)
assert_warn_count "build-verify test-design → silent" 0 "$OUT"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- N3: build-verify:gate (capless node) → NO WARN ---"
OUT=$(warn_stderr build-verify gate)
assert_warn_count "build-verify gate → silent" 0 "$OUT"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- N4 (control): build-verify:code-review (HAS caps) → NO WARN ---"
OUT=$(warn_stderr build-verify code-review)
assert_warn_count "build-verify code-review → silent" 0 "$OUT"

# ───────────────────────────────────────────────────────────────
# No flow-state.json and no --flow is not a routable lifecycle invocation.
echo ""
echo "--- N5 (guard): unresolved template + extensions loaded → FAIL CLOSED ---"
rm -rf bare; mkdir -p bare   # no init: no flow-state.json
set +e
OUT=$(OPC_EXTENSIONS_DIR="$TMPDIR/exts" $HARNESS prompt-context --node review --role tester --dir bare 2>&1)
RC=$?
set -e
assert_rejected "unresolved template is rejected" "$RC" "$OUT"

# ───────────────────────────────────────────────────────────────
# A node typo must be rejected, not degraded into a capless extension context.
echo ""
echo "--- N6 (guard): resolved template + unknown node → FAIL CLOSED ---"
rm -rf sess-build-verify-typo-node
$HARNESS init --flow build-verify --entry brief --dir sess-build-verify-typo-node >/dev/null 2>&1
set +e
OUT=$(OPC_EXTENSIONS_DIR="$TMPDIR/exts" $HARNESS prompt-context --node typo-node --role tester --dir sess-build-verify-typo-node 2>&1)
RC=$?
set -e
assert_rejected "unknown node is rejected" "$RC" "$OUT"

print_results
