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

print_results
