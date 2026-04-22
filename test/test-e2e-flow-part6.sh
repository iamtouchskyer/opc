#!/bin/bash
# E2E flow integration tests — Part 6 (Test 18)
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else json.dumps(v))" 2>/dev/null
}

assert_field_eq() {
  local desc="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(jq_field "$json" "$field")
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — $field: expected $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -q "$pattern"; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — pattern '$pattern' not found"
    FAIL=$((FAIL + 1))
  fi
}

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 18: stub extension hook in flow ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
STUB_EXT_DIR="$TMPDIR/opc-stub-ext"
rm -rf "$STUB_EXT_DIR"
mkdir -p "$STUB_EXT_DIR/stub-test"
cat > "$STUB_EXT_DIR/stub-test/ext.json" << 'EXTEOF'
{
  "name": "stub-test",
  "version": "1.0.0",
  "meta": { "provides": ["stub-check@1"] }
}
EXTEOF
cat > "$STUB_EXT_DIR/stub-test/hook.mjs" << 'HOOKEOF'
export const meta = { provides: ["stub-check@1"] };
export async function promptAppend(ctx) {
  return "<!-- stub-ext-injected -->";
}
export async function verdictAppend(ctx) {
  return [{ severity: "info", category: "stub", message: "stub-ext-verdict-fired" }];
}
HOOKEOF

# 18.1: Test hook invocation via extension-test CLI (prompt.append)
PROMPT_OUT=$($HARNESS extension-test --ext "$STUB_EXT_DIR/stub-test" --hook prompt.append --context '{"nodeId":"review","nodeType":"review"}' 2>/dev/null)
assert_contains "18.1: promptAppend fires" "$PROMPT_OUT" "stub-ext-injected"

# 18.2: Test hook invocation via extension-test CLI (verdict.append)
VERDICT_OUT=$($HARNESS extension-test --ext "$STUB_EXT_DIR/stub-test" --hook verdict.append --context '{"nodeId":"review","nodeType":"review"}' 2>/dev/null)
assert_contains "18.2: verdictAppend fires" "$VERDICT_OUT" "stub-ext-verdict-fired"

# 18.3: Lint passes on valid extension
LINT_OUT=$($HARNESS extension-test --ext "$STUB_EXT_DIR/stub-test" --lint-strict 2>&1; echo "EXIT:$?")
assert_contains "18.3: lint passes" "$LINT_OUT" "EXIT:0"

# 18.4: Init loads extension into flow-state
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
assert_contains "18.4: flow-state exists" "$(cat .harness/flow-state.json 2>/dev/null || echo '{}')" "flowTemplate"

echo ""

print_results
