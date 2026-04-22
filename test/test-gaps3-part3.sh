#!/usr/bin/env bash
# test-gaps3 — split part
set -euo pipefail

source "$(dirname "$0")/test-helpers.sh"

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


# ─────────────────────────────────────────────────────────────────
# DEFENSIVE-5: plan hash check skipped when plan deleted
# loop-tick.mjs:63-68
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── DEF-5: plan hash check skipped when plan deleted"
D=$(mktemp -d)
cd "$D"
cat > plan.md << 'PLAN'
- F1.1: review — review
PLAN
$HARNESS init-loop --skip-scope --plan plan.md --dir . > /dev/null 2>&1
$HARNESS next-tick --dir . > /dev/null 2>&1
# Delete plan — _plan_hash exists but file doesn't
rm plan.md
cat > eval-a.md << 'EVAL'
# Review
VERDICT: PASS FINDINGS[1]
🔵 Minor — foo.js:1 — test
EVAL
cat > eval-b.md << 'EVAL'
# Review B
VERDICT: PASS FINDINGS[1]
🔵 Minor — bar.js:1 — test
EVAL
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts eval-a.md,eval-b.md --dir . 2>/dev/null)
# Should succeed — plan hash check is silently skipped
assert_field_eq "$OUT" "['completed']" "True" "plan hash check skipped when plan missing"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# DEFENSIVE-6: complete-tick — unit not in plan → terminate
# loop-tick.mjs:110-113
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── DEF-6: complete-tick unit removed from plan → null next"
D=$(mktemp -d)
cd "$D"
cat > plan.md << 'PLAN'
- F1.1: review — review
- F1.2: implement — build
- F1.3: review — review
PLAN
$HARNESS init-loop --skip-scope --plan plan.md --dir . > /dev/null 2>&1
$HARNESS next-tick --dir . > /dev/null 2>&1
# Now rewrite plan WITHOUT F1.1 and update the plan hash so tamper check passes
cat > plan.md << 'PLAN'
- F1.2: implement — build
- F1.3: review — review
PLAN
# Update _plan_hash to match new plan content
NEW_HASH=$(python3 -c "import hashlib; print(hashlib.sha256(open('plan.md').read().encode()).hexdigest()[:16])")
python3 -c "
import json
s=json.load(open('loop-state.json'))
s['_plan_hash']='$NEW_HASH'
json.dump(s,open('loop-state.json','w'),indent=2)
"
cat > eval-a.md << 'EVAL'
# Review
VERDICT: PASS FINDINGS[1]
🔵 Minor — foo.js:1 — test
EVAL
cat > eval-b.md << 'EVAL'
# Review B
VERDICT: PASS FINDINGS[1]
🔵 Minor — bar.js:1 — test
EVAL
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts eval-a.md,eval-b.md --dir . 2>/dev/null)
# Unit F1.1 not found in current plan → nextUnit = null → terminate=true
assert_field_eq "$OUT" "['terminate']" "True" "unit not in plan → terminate"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# DEFENSIVE-7: short eval lines → overlap check skipped
# loop-tick.mjs:254-256, linesA.length=0 → skip
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── DEF-7: review evals with only short lines → overlap skipped"
D=$(mktemp -d)
cd "$D"
cat > plan.md << 'PLAN'
- F1.1: implement — build
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan plan.md --dir . > /dev/null 2>&1
$HARNESS next-tick --dir . > /dev/null 2>&1
echo '{"tests_run":1,"passed":1,"_command":"t"}' > result.json
git init -q . 2>/dev/null || true
git add -A && git commit -q -m "init" 2>/dev/null || true
$HARNESS complete-tick --unit F1.1 --artifacts result.json --dir . > /dev/null 2>&1
$HARNESS next-tick --dir . > /dev/null 2>&1
# Two evals with only short lines (< 10 chars each)
cat > eval-a.md << 'EVAL'
# A
🔵 ok
EVAL
cat > eval-b.md << 'EVAL'
# B
🔵 ok
EVAL
OUT=$($HARNESS complete-tick --unit F1.2 --artifacts eval-a.md,eval-b.md --dir . 2>/dev/null)
# Should not trigger overlap warning (all lines too short for comparison)
assert_not_contains "$OUT" "overlap" "short lines skip overlap check"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# DEFENSIVE-8: checkStall/checkOscillation with 0-1 history
# loop-advance.mjs:194, 221
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── DEF-8: next-tick with empty history → no stall check"
D=$(mktemp -d)
cd "$D"
cat > plan.md << 'PLAN'
- F1.1: implement — build
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan plan.md --dir . > /dev/null 2>&1
# State has tick=0, _tick_history=[] → should proceed without stall/oscillation
OUT=$($HARNESS next-tick --dir . 2>/dev/null)
assert_field_eq "$OUT" "['ready']" "True" "empty history → no stall/oscillation"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# DEFENSIVE-9: replay — unreadable file in run_* dir
# viz-commands.mjs:118-119
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── DEF-9: replay with unreadable file in run dir"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
mkdir -p nodes/review/run_1
echo "content" > nodes/review/run_1/eval.md
cat > nodes/review/handshake.json << 'EOF'
{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
EOF
# Make one file unreadable
echo "secret" > nodes/review/run_1/blocked.md
chmod 000 nodes/review/run_1/blocked.md 2>/dev/null || true
OUT=$($HARNESS replay --dir . 2>/dev/null)
assert_contains "$OUT" "review" "replay works despite unreadable file"
# Verify the readable file IS included
assert_contains "$OUT" "eval.md" "readable file included in replay"
chmod 755 nodes/review/run_1/blocked.md 2>/dev/null || true
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# DEFENSIVE-10: non-empty-string rule validation
# flow-core.mjs:232 (exercise all validators)
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── DEF-10: non-empty-string rule validation"
D=$(mktemp -d)
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/test-str-rule.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "opc_compat": ">=0.5",
  "contextSchema": {
    "a": {
      "required": [],
      "rules": {"name": "non-empty-string"}
    }
  }
}
EOF
cd "$D"
$HARNESS init --flow test-str-rule --dir . > /dev/null 2>&1
echo '{"name": ""}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-str-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "empty string fails non-empty-string"
echo '{"name": "hello"}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-str-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "non-empty string passes"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# DEFENSIVE-11: non-empty-array rule validation
# flow-core.mjs:230
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── DEF-11: non-empty-array rule validation"
D=$(mktemp -d)
cat > "$HOME/.claude/flows/test-arr-rule.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "opc_compat": ">=0.5",
  "contextSchema": {
    "a": {
      "required": [],
      "rules": {"items": "non-empty-array"}
    }
  }
}
EOF
cd "$D"
$HARNESS init --flow test-arr-rule --dir . > /dev/null 2>&1
echo '{"items": []}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-arr-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "empty array fails non-empty-array"
echo '{"items": [1]}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-arr-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "non-empty array passes"
echo '{"items": "not-array"}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-arr-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "string fails non-empty-array"
rm -rf "$D"
cd /tmp


rm -f "$HOME/.claude/flows/test-str-rule.json"
rm -f "$HOME/.claude/flows/test-arr-rule.json"

print_results
