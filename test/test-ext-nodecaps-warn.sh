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
#   - prompt-context with no flow-state + no --flow (template unresolvable)  → WARN STILL fires
#
# The last case is the preservation guard: we suppress the false positive without blanket-
# silencing the WARN. Template-unresolvable-yet-extensions-loaded is a real, actionable
# misconfig and must stay loud. The F2 raw-library WARN-once contract (extensions.test.mjs)
# covers the programmatic "forgot to pass caps" path and must remain green independently.

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

# init <flow> into a fresh subdir, fire prompt-context on <node>, capture stderr only.
warn_stderr() {
  local flow="$1" node="$2" sub="sess-${flow}-${node}"
  rm -rf "$sub"; mkdir -p "$sub"
  ( cd "$sub" && $HARNESS init --flow "$flow" --dir . >/dev/null 2>&1 )
  OPC_EXTENSIONS_DIR="$TMPDIR/exts" $HARNESS prompt-context --node "$node" --role tester --dir "$sub" 2>&1 1>/dev/null
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
# Preservation guard: no flow-state.json and no --flow → template cannot resolve →
# caps genuinely unknown while extensions are loaded → the WARN MUST still fire.
echo ""
echo "--- N5 (guard): unresolved template + extensions loaded → WARN STILL fires ---"
rm -rf bare; mkdir -p bare   # no init: no flow-state.json
OUT=$(OPC_EXTENSIONS_DIR="$TMPDIR/exts" $HARNESS prompt-context --node review --role tester --dir bare 2>&1 1>/dev/null)
assert_warn_count "unresolved template → warns" 1 "$OUT"

# ───────────────────────────────────────────────────────────────
# Node-typo guard: template resolves, but the requested node is NOT in template.nodes.
# An empty caps list here is NOT a legitimate "capless node" — it's a misconfig (typo /
# wrong --node). Suppressing the WARN would hide a loaded-but-no-match extension with zero
# diagnostics. So an unknown node must be treated as unresolved → WARN STILL fires.
echo ""
echo "--- N6 (guard): resolved template + unknown node → WARN STILL fires ---"
OUT=$(warn_stderr build-verify typo-node)
assert_warn_count "unknown node → warns" 1 "$OUT"

print_results
