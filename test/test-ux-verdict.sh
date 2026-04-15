#!/bin/bash
# Tests for ux-verdict and ux-friction-aggregate commands
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
echo "=== TEST GROUP 1: Basic verdict flow ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 1.1: Clean observers → PASS verdict ---"
FLOW1="flow1"
setup_flow "$FLOW1" "polished"
mkdir -p "$FLOW1/nodes/ux-simulation/run_1"
make_observer "$FLOW1/nodes/ux-simulation/run_1/observer-new-user.md" \
  "new-user" \
  '[]' \
  '["favicon-custom", "error-messages-helpful"]' \
  '[]' \
  "at-tier" \
  '[{"stage": "first-30s", "observation": "Page loaded fast", "reference": "landing page"}]'
make_observer "$FLOW1/nodes/ux-simulation/run_1/observer-active-user.md" \
  "active-user" \
  '[]' \
  '["favicon-custom", "responsive-layout"]' \
  '["dark-mode-support"]' \
  "at-tier" \
  '[{"stage": "core-flow", "observation": "Smooth navigation", "reference": "sidebar"}]'

OUT=$($HARNESS ux-verdict --dir "$FLOW1" --run 1 2>/dev/null)
assert_field_eq "clean → PASS" "$OUT" "verdict" "PASS"
assert_field_eq "node id correct" "$OUT" "nodeId" "ux-simulation"
assert_field_eq "run id correct" "$OUT" "runId" "run_1"
assert_nested_eq "critical=0" "$OUT" "findings.critical" "0"
assert_nested_eq "warning=0" "$OUT" "findings.warning" "0"

echo ""
echo "--- 1.2: No observer files → BLOCKED ---"
FLOW2="flow2"
setup_flow "$FLOW2" "polished"
mkdir -p "$FLOW2/nodes/ux-simulation/run_1"
# Empty run dir — no observer files
OUT=$($HARNESS ux-verdict --dir "$FLOW2" --run 1 2>/dev/null)
assert_field_eq "no observers → BLOCKED" "$OUT" "verdict" "BLOCKED"
assert_contains "reason mentions no observer" "$OUT" "no observer files"

echo ""
echo "--- 1.3: Malformed JSON → BLOCKED ---"
FLOW3="flow3"
setup_flow "$FLOW3" "polished"
mkdir -p "$FLOW3/nodes/ux-simulation/run_1"
cat > "$FLOW3/nodes/ux-simulation/run_1/observer-new-user.md" << 'EOF'
# Observer Report
This has no JSON block at all.
EOF
OUT=$($HARNESS ux-verdict --dir "$FLOW3" --run 1 2>/dev/null)
assert_field_eq "malformed JSON → BLOCKED" "$OUT" "verdict" "BLOCKED"
assert_contains "reason mentions malformed" "$OUT" "malformed"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 2: Schema validation ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 2.1: Missing required field → BLOCKED ---"
FLOW4="flow4"
setup_flow "$FLOW4" "polished"
mkdir -p "$FLOW4/nodes/ux-simulation/run_1"
cat > "$FLOW4/nodes/ux-simulation/run_1/observer-new-user.md" << 'EOF'
# Observer
```json
{
  "persona": "new-user",
  "tier": "polished",
  "red_flags": [],
  "trust_signals": { "present": [], "absent": [] },
  "friction_points": [],
  "reasoning": "I found this to be a reasonable experience overall with good defaults."
}
```
EOF
# Missing tier_fit field
OUT=$($HARNESS ux-verdict --dir "$FLOW4" --run 1 2>/dev/null)
assert_field_eq "missing field → BLOCKED" "$OUT" "verdict" "BLOCKED"
assert_contains "reports missing tier_fit" "$OUT" "tier_fit"

echo ""
echo "--- 2.2: Invalid red_flag key → BLOCKED ---"
FLOW5="flow5"
setup_flow "$FLOW5" "polished"
mkdir -p "$FLOW5/nodes/ux-simulation/run_1"
cat > "$FLOW5/nodes/ux-simulation/run_1/observer-new-user.md" << 'EOF'
# Observer
```json
{
  "persona": "new-user",
  "tier": "polished",
  "red_flags": [{ "key": "totally-not-a-real-flag", "stage": "first-30s" }],
  "trust_signals": { "present": [], "absent": [] },
  "friction_points": [{ "stage": "first-30s", "observation": "test", "reference": "page" }],
  "tier_fit": "at-tier",
  "reasoning": "As a new user I found the experience straightforward and well-designed."
}
```
EOF
OUT=$($HARNESS ux-verdict --dir "$FLOW5" --run 1 2>/dev/null)
assert_field_eq "invalid flag key → BLOCKED" "$OUT" "verdict" "BLOCKED"
assert_contains "reports invalid key" "$OUT" "invalid red_flag key"

echo ""
echo "--- 2.3: 'other' flag without description → BLOCKED ---"
FLOW6="flow6"
setup_flow "$FLOW6" "polished"
mkdir -p "$FLOW6/nodes/ux-simulation/run_1"
cat > "$FLOW6/nodes/ux-simulation/run_1/observer-new-user.md" << 'EOF'
# Observer
```json
{
  "persona": "new-user",
  "tier": "polished",
  "red_flags": [{ "key": "other", "stage": "first-30s" }],
  "trust_signals": { "present": [], "absent": [] },
  "friction_points": [{ "stage": "first-30s", "observation": "test", "reference": "page" }],
  "tier_fit": "at-tier",
  "reasoning": "As a new user I found the experience straightforward and well-designed."
}
```
EOF
OUT=$($HARNESS ux-verdict --dir "$FLOW6" --run 1 2>/dev/null)
assert_field_eq "other without desc → BLOCKED" "$OUT" "verdict" "BLOCKED"
assert_contains "reports other missing desc" "$OUT" "other.*missing description"

echo ""
echo "--- 2.4: Short reasoning → BLOCKED ---"
FLOW7="flow7"
setup_flow "$FLOW7" "polished"
mkdir -p "$FLOW7/nodes/ux-simulation/run_1"
cat > "$FLOW7/nodes/ux-simulation/run_1/observer-new-user.md" << 'EOF'
# Observer
```json
{
  "persona": "new-user",
  "tier": "polished",
  "red_flags": [],
  "trust_signals": { "present": [], "absent": [] },
  "friction_points": [{ "stage": "first-30s", "observation": "test", "reference": "page" }],
  "tier_fit": "at-tier",
  "reasoning": "It was fine."
}
```
EOF
OUT=$($HARNESS ux-verdict --dir "$FLOW7" --run 1 2>/dev/null)
assert_field_eq "short reasoning → BLOCKED" "$OUT" "verdict" "BLOCKED"
assert_contains "reports reasoning too short" "$OUT" "reasoning too short"

echo ""
echo "--- 2.5: Third-person reasoning → BLOCKED ---"
FLOW8="flow8"
setup_flow "$FLOW8" "polished"
mkdir -p "$FLOW8/nodes/ux-simulation/run_1"
cat > "$FLOW8/nodes/ux-simulation/run_1/observer-new-user.md" << 'EOF'
# Observer
```json
{
  "persona": "new-user",
  "tier": "polished",
  "red_flags": [],
  "trust_signals": { "present": [], "absent": [] },
  "friction_points": [{ "stage": "first-30s", "observation": "test", "reference": "page" }],
  "tier_fit": "at-tier",
  "reasoning": "Users would find this application very intuitive and easy to navigate overall."
}
```
EOF
OUT=$($HARNESS ux-verdict --dir "$FLOW8" --run 1 2>/dev/null)
assert_field_eq "third-person → BLOCKED" "$OUT" "verdict" "BLOCKED"
assert_contains "reports third-person" "$OUT" "third-person"

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

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 9: Verdict persistence ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 9.1: ux-verdict.json written to run dir ---"
# Reuse FLOW1 from test 1.1 which already ran
if [ -f "$FLOW1/nodes/ux-simulation/run_1/ux-verdict.json" ]; then
  PERSISTED=$(cat "$FLOW1/nodes/ux-simulation/run_1/ux-verdict.json")
  assert_field_eq "persisted verdict = PASS" "$PERSISTED" "verdict" "PASS"
else
  echo "  ❌ ux-verdict.json not persisted"
  FAIL=$((FAIL + 1))
fi

# ═══════════════════════════════════════════════════════════════
print_results
