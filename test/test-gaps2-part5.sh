#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "✅ $label"; PASS=$((PASS+1))
  else
    echo "❌ $label — expected '$needle' in output"; FAIL=$((FAIL+1))
    echo "   GOT: $(echo "$haystack" | head -5)"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "❌ $label — did NOT expect '$needle' in output"; FAIL=$((FAIL+1))
  else
    echo "✅ $label"; PASS=$((PASS+1))
  fi
}

assert_field_eq() {
  local json="$1" field="$2" expected="$3" label="$4"
  local actual
  actual=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d${field})" 2>/dev/null || echo "__PARSE_ERROR__")
  if [ "$actual" = "$expected" ]; then
    echo "✅ $label"; PASS=$((PASS+1))
  else
    echo "❌ $label — expected $field=$expected, got $actual"; FAIL=$((FAIL+1))
  fi
}

assert_exit_zero() {
  local label="$1"; shift
  if "$@" > /dev/null 2>&1; then
    echo "✅ $label"; PASS=$((PASS+1))
  else
    echo "❌ $label — non-zero exit"; FAIL=$((FAIL+1))
  fi
}

# GAP2-1: resolveDir — --dir . (resolved === cwd)
# GAP2-31: cmdGoto — arg parsing edge case
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-31: goto arg parsing"
D31=$(mktemp -d)
cd "$D31"
$HARNESS init --flow build-verify --dir . > /dev/null 2>&1
# goto with --dir value that looks like it could confuse parser
OUT=$($HARNESS goto code-review --dir . 2>/dev/null)
assert_contains "$OUT" "code-review" "goto with --dir parses target correctly"
rm -rf "$D31"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-32: synthesize — roleName fallback for wave file without prefix match
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-32: synthesize wave file roleName fallback"
D32=$(mktemp -d)
mkdir -p "$D32/.harness"
# Create wave eval file with non-standard naming
cat > "$D32/.harness/evaluation-wave-1-custom-reviewer.md" << 'EVAL'
# Custom Review
VERDICT: PASS FINDINGS[1]
🔵 Suggestion — test.js:1 — minor
EVAL
OUT=$($HARNESS synthesize "$D32" --wave 1 2>/dev/null)
assert_contains "$OUT" "custom-reviewer" "wave roleName extraction"
rm -rf "$D32"

# ─────────────────────────────────────────────────────────────────
# GAP2-33: loop next-tick — wall-clock deadline
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-33: next-tick wall-clock deadline"
D33=$(mktemp -d)
cd "$D33"
cat > plan.md << 'PLAN'
- F1.1: implement — build
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan plan.md --dir . > /dev/null 2>&1
# Tamper _started_at to 25 hours ago
python3 -c "
import json, datetime
s=json.load(open('loop-state.json'))
past = datetime.datetime.utcnow() - datetime.timedelta(hours=25)
s['_started_at'] = past.strftime('%Y-%m-%dT%H:%M:%SZ')
s['status'] = 'completed'  # not in_progress/terminated/pipeline_complete
json.dump(s,open('loop-state.json','w'),indent=2)
"
OUT=$($HARNESS next-tick --dir . 2>/dev/null)
assert_contains "$OUT" "deadline\|wall-clock" "wall-clock deadline terminates"
rm -rf "$D33"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-34: loop next-tick — maxTotalTicks reached
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-34: next-tick maxTotalTicks"
D34=$(mktemp -d)
cd "$D34"
cat > plan.md << 'PLAN'
- F1.1: implement — build
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan plan.md --dir . > /dev/null 2>&1
python3 -c "
import json
s=json.load(open('loop-state.json'))
s['tick'] = 999
s['_max_total_ticks'] = 5
s['status'] = 'completed'
json.dump(s,open('loop-state.json','w'),indent=2)
"
OUT=$($HARNESS next-tick --dir . 2>/dev/null)
assert_contains "$OUT" "maxTotalTicks" "maxTotalTicks terminates"
rm -rf "$D34"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-35: loop next-tick — concurrent tick guard
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-35: next-tick concurrent guard"
D35=$(mktemp -d)
cd "$D35"
cat > plan.md << 'PLAN'
- F1.1: implement — build
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan plan.md --dir . > /dev/null 2>&1
# Set status to in_progress (simulating concurrent tick)
python3 -c "
import json
s=json.load(open('loop-state.json'))
s['status'] = 'in_progress'
json.dump(s,open('loop-state.json','w'),indent=2)
"
OUT=$($HARNESS next-tick --dir . 2>/dev/null)
assert_contains "$OUT" "another tick" "concurrent tick guard"
rm -rf "$D35"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# GAP2-36: loop next-tick — unit not found in plan → auto-terminate
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── GAP2-36: next-tick unit not in plan → auto-terminate"
D36=$(mktemp -d)
cd "$D36"
cat > plan.md << 'PLAN'
- F1.1: implement — build
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan plan.md --dir . > /dev/null 2>&1
# Set next_unit to something not in plan
python3 -c "
import json
s=json.load(open('loop-state.json'))
s['next_unit'] = 'NONEXISTENT'
s['status'] = 'completed'
json.dump(s,open('loop-state.json','w'),indent=2)
"
OUT=$($HARNESS next-tick --dir . 2>/dev/null)
assert_contains "$OUT" "not found in plan" "auto-terminate for missing unit"
rm -rf "$D36"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# Cleanup test flows
# ─────────────────────────────────────────────────────────────────
rm -f "$HOME/.claude/flows/test-soft-ev.json"
rm -f "$HOME/.claude/flows/test-ctx-null.json"
rm -f "$HOME/.claude/flows/test-no-types.json"
rm -f "$HOME/.claude/flows/test-no-pass-edge.json"
rm -f "$HOME/.claude/flows/test-gate-no-pass.json"

print_results
