#!/bin/bash
# test-ux-verdict — split part
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else 'true' if v is True else 'false' if v is False else json.dumps(v) if isinstance(v, (dict,list)) else str(v))" 2>/dev/null
}

jq_nested() {
  echo "$1" | python3 -c "
import sys,json
d=json.load(sys.stdin)
keys='$2'.split('.')
for k in keys:
    if isinstance(d, dict):
        d = d.get(k)
    else:
        d = None
        break
if d is None: print('__NULL__')
elif d is True: print('true')
elif d is False: print('false')
elif isinstance(d, (dict,list)): print(json.dumps(d))
else: print(str(d))
" 2>/dev/null
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

assert_nested_eq() {
  local desc="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(jq_nested "$json" "$field")
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

# ── Helper: create a valid observer markdown file ──
make_observer() {
  local filepath="$1" persona="$2" red_flags="$3" trust_present="$4" trust_absent="$5" tier_fit="$6" friction="$7"
  cat > "$filepath" << ENDOBS
# Observer Report — $persona

\`\`\`json
{
  "persona": "$persona",
  "tier": "polished",
  "red_flags": $red_flags,
  "trust_signals": { "present": $trust_present, "absent": $trust_absent },
  "friction_points": $friction,
  "tier_fit": "$tier_fit",
  "reasoning": "As this persona, I found the experience to be quite detailed and well-considered overall."
}
\`\`\`
ENDOBS
}

# ── Helper: set up flow directory with flow-state.json ──
setup_flow() {
  local dir="$1" tier="$2"
  mkdir -p "$dir"
  cat > "$dir/flow-state.json" << EOF
{ "tier": "$tier", "currentNode": "ux-simulation" }
EOF
}


# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 6: Overrides ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 6.1: Override changes severity ---"
FLOW18="flow18"
setup_flow "$FLOW18" "polished"
mkdir -p "$FLOW18/nodes/ux-simulation/run_1"
# default-favicon is "warning" at polished tier, override to "suggestion"
cat > "$FLOW18/red-flag-overrides.md" << 'EOF'
# Red Flag Overrides
- default-favicon: suggestion
EOF
make_observer "$FLOW18/nodes/ux-simulation/run_1/observer-new-user.md" \
  "new-user" \
  '[{"key": "default-favicon", "stage": "first-30s", "reference": "tab"}]' \
  '["favicon-custom"]' '[]' "at-tier" \
  '[{"stage": "first-30s", "observation": "Missing favicon", "reference": "tab"}]'

OUT=$($HARNESS ux-verdict --dir "$FLOW18" --run 1 2>/dev/null)
# With override, default-favicon is now suggestion, not warning
assert_field_eq "override → still PASS" "$OUT" "verdict" "PASS"
assert_nested_eq "suggestion count = 1" "$OUT" "findings.suggestion" "1"
assert_nested_eq "warning count = 0" "$OUT" "findings.warning" "0"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 7: Tier-parameterized severity ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 7.1: Same flag, different severity per tier ---"
# no-empty-state: functional=suggestion, polished=warning
FLOW19="flow19a"
setup_flow "$FLOW19" "functional"
mkdir -p "$FLOW19/nodes/ux-simulation/run_1"
make_observer "$FLOW19/nodes/ux-simulation/run_1/observer-new-user.md" \
  "new-user" \
  '[{"key": "no-empty-state", "stage": "core-flow", "reference": "list"}]' \
  '[]' '[]' "at-tier" \
  '[{"stage": "core-flow", "observation": "No empty state", "reference": "list"}]'

OUT=$($HARNESS ux-verdict --dir "$FLOW19" --run 1 2>/dev/null)
assert_nested_eq "functional: suggestion=1" "$OUT" "findings.suggestion" "1"
assert_nested_eq "functional: warning=0" "$OUT" "findings.warning" "0"

FLOW20="flow19b"
setup_flow "$FLOW20" "polished"
mkdir -p "$FLOW20/nodes/ux-simulation/run_1"
make_observer "$FLOW20/nodes/ux-simulation/run_1/observer-new-user.md" \
  "new-user" \
  '[{"key": "no-empty-state", "stage": "core-flow", "reference": "list"}]' \
  '[]' '[]' "at-tier" \
  '[{"stage": "core-flow", "observation": "No empty state", "reference": "list"}]'

OUT=$($HARNESS ux-verdict --dir "$FLOW20" --run 1 2>/dev/null)
assert_nested_eq "polished: warning=1" "$OUT" "findings.warning" "1"
assert_nested_eq "polished: suggestion=0" "$OUT" "findings.suggestion" "0"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 8: Friction aggregate ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 8.1: Friction report generated correctly ---"
FLOW21="flow21"
setup_flow "$FLOW21" "polished"
mkdir -p "$FLOW21/nodes/ux-simulation/run_1"
make_observer "$FLOW21/nodes/ux-simulation/run_1/observer-new-user.md" \
  "new-user" '[]' '[]' '[]' "at-tier" \
  '[{"stage": "first-30s", "observation": "Slow load", "reference": "landing page"}, {"stage": "core-flow", "observation": "Confusing nav", "reference": "sidebar"}]'
make_observer "$FLOW21/nodes/ux-simulation/run_1/observer-active-user.md" \
  "active-user" '[]' '[]' '[]' "at-tier" \
  '[{"stage": "core-flow", "observation": "Missing breadcrumbs", "reference": "header"}]'

OUT=$($HARNESS ux-friction-aggregate --dir "$FLOW21" --run 1 --output "$FLOW21/friction.md" 2>/dev/null)
assert_field_eq "total friction points = 3" "$OUT" "totalFrictionPoints" "3"
# Verify the file was written
if [ -f "$FLOW21/friction.md" ]; then
  echo "  ✅ friction.md written"
  PASS=$((PASS + 1))
else
  echo "  ❌ friction.md not written"
  FAIL=$((FAIL + 1))
fi

# Verify content
FRICTION_MD=$(cat "$FLOW21/friction.md")
assert_contains "has first-30s section" "$FRICTION_MD" "first-30s"
assert_contains "has core-flow section" "$FRICTION_MD" "core-flow"
assert_contains "has persona tag" "$FRICTION_MD" "new-user"

print_results
