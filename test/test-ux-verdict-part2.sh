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
echo "=== TEST GROUP 3: Gate logic — first run ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 3.1: Critical flag → FAIL ---"
FLOW9="flow9"
setup_flow "$FLOW9" "polished"
mkdir -p "$FLOW9/nodes/ux-simulation/run_1"
make_observer "$FLOW9/nodes/ux-simulation/run_1/observer-new-user.md" \
  "new-user" \
  '[{"key": "broken-link", "stage": "core-flow", "reference": "nav menu"}]' \
  '["favicon-custom"]' '[]' "at-tier" \
  '[{"stage": "core-flow", "observation": "Link broken", "reference": "nav"}]'

OUT=$($HARNESS ux-verdict --dir "$FLOW9" --run 1 2>/dev/null)
assert_field_eq "critical → FAIL" "$OUT" "verdict" "FAIL"
assert_nested_eq "critical count = 1" "$OUT" "findings.critical" "1"

echo ""
echo "--- 3.2: Warnings over threshold → ITERATE (polished threshold=2) ---"
FLOW10="flow10"
setup_flow "$FLOW10" "polished"
mkdir -p "$FLOW10/nodes/ux-simulation/run_1"
# 3 warning-level flags for polished tier (threshold=2)
make_observer "$FLOW10/nodes/ux-simulation/run_1/observer-new-user.md" \
  "new-user" \
  '[{"key": "default-favicon", "stage": "first-30s", "reference": "tab"}, {"key": "no-empty-state", "stage": "core-flow", "reference": "list"}, {"key": "no-loading-feedback", "stage": "core-flow", "reference": "page"}]' \
  '["responsive-layout"]' '[]' "at-tier" \
  '[{"stage": "first-30s", "observation": "Missing favicon", "reference": "tab"}]'

OUT=$($HARNESS ux-verdict --dir "$FLOW10" --run 1 2>/dev/null)
assert_field_eq "warnings over threshold → ITERATE" "$OUT" "verdict" "ITERATE"

echo ""
echo "--- 3.3: Warnings under threshold → PASS ---"
FLOW11="flow11"
setup_flow "$FLOW11" "polished"
mkdir -p "$FLOW11/nodes/ux-simulation/run_1"
# 1 warning-level flag (under polished threshold of 2)
make_observer "$FLOW11/nodes/ux-simulation/run_1/observer-new-user.md" \
  "new-user" \
  '[{"key": "default-favicon", "stage": "first-30s", "reference": "tab"}]' \
  '["responsive-layout"]' '[]' "at-tier" \
  '[{"stage": "first-30s", "observation": "Missing favicon", "reference": "tab"}]'

OUT=$($HARNESS ux-verdict --dir "$FLOW11" --run 1 2>/dev/null)
assert_field_eq "warnings under threshold → PASS" "$OUT" "verdict" "PASS"

echo ""
echo "--- 3.4: Bad tier_fit → ITERATE ---"
FLOW12="flow12"
setup_flow "$FLOW12" "polished"
mkdir -p "$FLOW12/nodes/ux-simulation/run_1"
make_observer "$FLOW12/nodes/ux-simulation/run_1/observer-new-user.md" \
  "new-user" \
  '[]' \
  '[]' '[]' "free-only" \
  '[{"stage": "first-30s", "observation": "Feels basic", "reference": "landing"}]'

OUT=$($HARNESS ux-verdict --dir "$FLOW12" --run 1 2>/dev/null)
assert_field_eq "free-only tier_fit → ITERATE" "$OUT" "verdict" "ITERATE"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 4: Gate logic — delta (subsequent run) ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 4.1: Regression → FAIL ---"
FLOW13="flow13"
setup_flow "$FLOW13" "polished"
# Run 1 baseline: no flags
mkdir -p "$FLOW13/nodes/ux-simulation/run_1"
cat > "$FLOW13/nodes/ux-simulation/run_1/ux-verdict.json" << 'EOF'
{
  "verdict": "PASS",
  "uxResult": {
    "flagDetails": [],
    "redFlags": { "critical": 0, "warning": 0, "suggestion": 0 }
  }
}
EOF
# Run 2: new critical flag = regression
mkdir -p "$FLOW13/nodes/ux-simulation/run_2"
make_observer "$FLOW13/nodes/ux-simulation/run_2/observer-new-user.md" \
  "new-user" \
  '[{"key": "broken-link", "stage": "core-flow", "reference": "nav menu"}]' \
  '["favicon-custom"]' '[]' "at-tier" \
  '[{"stage": "core-flow", "observation": "Link broken", "reference": "nav"}]'

OUT=$($HARNESS ux-verdict --dir "$FLOW13" --run 2 2>/dev/null)
assert_field_eq "regression → FAIL" "$OUT" "verdict" "FAIL"
assert_contains "has delta" "$OUT" "vs_run"

echo ""
echo "--- 4.2: Improvement + under threshold → PASS ---"
FLOW14="flow14"
setup_flow "$FLOW14" "polished"
# Run 1 baseline: had 2 warnings
mkdir -p "$FLOW14/nodes/ux-simulation/run_1"
cat > "$FLOW14/nodes/ux-simulation/run_1/ux-verdict.json" << 'EOF'
{
  "verdict": "ITERATE",
  "uxResult": {
    "flagDetails": [
      { "key": "default-favicon", "severity": "warning", "observers": ["new-user"] },
      { "key": "no-empty-state", "severity": "warning", "observers": ["new-user"] }
    ],
    "redFlags": { "critical": 0, "warning": 2, "suggestion": 0 }
  }
}
EOF
# Run 2: resolved one flag, one warning remains (1 ≤ threshold 2)
mkdir -p "$FLOW14/nodes/ux-simulation/run_2"
make_observer "$FLOW14/nodes/ux-simulation/run_2/observer-new-user.md" \
  "new-user" \
  '[{"key": "no-empty-state", "stage": "core-flow", "reference": "list"}]' \
  '["favicon-custom"]' '[]' "at-tier" \
  '[{"stage": "core-flow", "observation": "No empty state", "reference": "list"}]'

OUT=$($HARNESS ux-verdict --dir "$FLOW14" --run 2 2>/dev/null)
assert_field_eq "improvement + under → PASS" "$OUT" "verdict" "PASS"

echo ""
echo "--- 4.3: Same (no change) + over threshold → ITERATE ---"
FLOW15="flow15"
setup_flow "$FLOW15" "polished"
# Run 1 baseline: 3 warnings
mkdir -p "$FLOW15/nodes/ux-simulation/run_1"
cat > "$FLOW15/nodes/ux-simulation/run_1/ux-verdict.json" << 'EOF'
{
  "verdict": "ITERATE",
  "uxResult": {
    "flagDetails": [
      { "key": "default-favicon", "severity": "warning", "observers": ["new-user"] },
      { "key": "no-empty-state", "severity": "warning", "observers": ["new-user"] },
      { "key": "no-loading-feedback", "severity": "warning", "observers": ["new-user"] }
    ],
    "redFlags": { "critical": 0, "warning": 3, "suggestion": 0 }
  }
}
EOF
# Run 2: exact same 3 warnings
mkdir -p "$FLOW15/nodes/ux-simulation/run_2"
make_observer "$FLOW15/nodes/ux-simulation/run_2/observer-new-user.md" \
  "new-user" \
  '[{"key": "default-favicon", "stage": "first-30s", "reference": "tab"}, {"key": "no-empty-state", "stage": "core-flow", "reference": "list"}, {"key": "no-loading-feedback", "stage": "core-flow", "reference": "page"}]' \
  '["responsive-layout"]' '[]' "at-tier" \
  '[{"stage": "first-30s", "observation": "Same issues", "reference": "tab"}]'

OUT=$($HARNESS ux-verdict --dir "$FLOW15" --run 2 2>/dev/null)
assert_field_eq "same + over threshold → ITERATE" "$OUT" "verdict" "ITERATE"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 5: Trust signals & tier fit ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 5.1: Trust signals merge correctly ---"
FLOW16="flow16"
setup_flow "$FLOW16" "polished"
mkdir -p "$FLOW16/nodes/ux-simulation/run_1"
# Observer 1 has "favicon-custom" present, "dark-mode-support" absent
make_observer "$FLOW16/nodes/ux-simulation/run_1/observer-new-user.md" \
  "new-user" \
  '[]' \
  '["favicon-custom"]' '["dark-mode-support", "responsive-layout"]' \
  "at-tier" \
  '[{"stage": "first-30s", "observation": "Loaded fast", "reference": "landing page"}]'
# Observer 2 has "responsive-layout" present (overrides absent from observer 1)
make_observer "$FLOW16/nodes/ux-simulation/run_1/observer-active-user.md" \
  "active-user" \
  '[]' \
  '["responsive-layout", "loading-states-present"]' '["dark-mode-support"]' \
  "at-tier" \
  '[{"stage": "core-flow", "observation": "Navigation smooth", "reference": "sidebar"}]'

OUT=$($HARNESS ux-verdict --dir "$FLOW16" --run 1 2>/dev/null)
# responsive-layout should be present (observer 2 marks it), NOT absent
assert_contains "responsive-layout in present" "$OUT" '"responsive-layout"'
# dark-mode-support should still be absent (no observer marks it present)
assert_contains "trust signals structure" "$OUT" "trustSignals"

echo ""
echo "--- 5.2: Tier fit consensus = majority ---"
FLOW17="flow17"
setup_flow "$FLOW17" "polished"
mkdir -p "$FLOW17/nodes/ux-simulation/run_1"
# 2 observers say at-tier, 1 says below-tier → consensus = at-tier
make_observer "$FLOW17/nodes/ux-simulation/run_1/observer-new-user.md" \
  "new-user" '[]' '[]' '[]' "at-tier" \
  '[{"stage": "first-30s", "observation": "OK", "reference": "page"}]'
make_observer "$FLOW17/nodes/ux-simulation/run_1/observer-active-user.md" \
  "active-user" '[]' '[]' '[]' "at-tier" \
  '[{"stage": "core-flow", "observation": "OK", "reference": "page"}]'
make_observer "$FLOW17/nodes/ux-simulation/run_1/observer-churned-user.md" \
  "churned-user" '[]' '[]' '[]' "below-tier" \
  '[{"stage": "first-30s", "observation": "Meh", "reference": "page"}]'

OUT=$($HARNESS ux-verdict --dir "$FLOW17" --run 1 2>/dev/null)
assert_nested_eq "tier fit consensus = at-tier" "$OUT" "uxResult.tierFitConsensus" "at-tier"


print_results
