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
# REAL-7: unitType="unknown" when plan missing during complete-tick
# loop-tick.mjs:77-83
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── REAL-7: complete-tick with deleted plan → unitType=unknown"
D=$(mktemp -d)
cd "$D"
cat > plan.md << 'PLAN'
- F1.1: review — review things
PLAN
$HARNESS init-loop --skip-scope --plan plan.md --dir . > /dev/null 2>&1
$HARNESS next-tick --dir . > /dev/null 2>&1
# Delete plan so unitType becomes "unknown"
rm plan.md
cat > eval-a.md << 'EVAL'
# Review A
VERDICT: PASS FINDINGS[1]
🔵 Minor — foo.js:1 — test
EVAL
cat > eval-b.md << 'EVAL'
# Review B
VERDICT: PASS FINDINGS[1]
🔵 Minor — bar.js:1 — test
EVAL
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts eval-a.md,eval-b.md --dir . 2>/dev/null)
# Should succeed with unitType=unknown, no type-specific validation
assert_contains "$OUT" "unknown" "unitType=unknown when plan missing"
assert_field_eq "$OUT" "['completed']" "True" "completes despite missing plan"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# REAL-8: negative durationMs in implement artifact
# loop-tick.mjs:169-175, specifically durationMs < 0
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── REAL-8: negative durationMs"
D=$(mktemp -d)
cd "$D"
cat > plan.md << 'PLAN'
- F1.1: implement — build
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan plan.md --dir . > /dev/null 2>&1
$HARNESS next-tick --dir . > /dev/null 2>&1
TS=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
cat > result.json << EOF
{"tests_run": 5, "passed": 5, "_command": "npm test", "durationMs": -100, "_timestamp": "$TS"}
EOF
git init -q . 2>/dev/null || true
git add -A && git commit -q -m "init" 2>/dev/null || true
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts result.json --dir . 2>/dev/null)
assert_contains "$OUT" "durationMs" "negative durationMs detected"
assert_field_eq "$OUT" "['completed']" "False" "negative durationMs blocks completion"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# REAL-9: "frontend"/"fe" UI type variants require screenshot
# loop-tick.mjs:208
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── REAL-9: implement-frontend requires screenshot"
D=$(mktemp -d)
cd "$D"
cat > plan.md << 'PLAN'
- F1.1: implement-frontend — build UI
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan plan.md --dir . > /dev/null 2>&1
$HARNESS next-tick --dir . > /dev/null 2>&1
TS=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
cat > result.json << EOF
{"tests_run": 1, "passed": 1, "_command": "test", "_timestamp": "$TS"}
EOF
git init -q . 2>/dev/null || true
git add -A && git commit -q -m "init" 2>/dev/null || true
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts result.json --dir . 2>/dev/null)
assert_contains "$OUT" "screenshot" "frontend type requires screenshot"
# Now test with "fe" variant
rm -f loop-state.json
cat > plan.md << 'PLAN'
- F1.1: implement-fe — build UI
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan plan.md --dir . > /dev/null 2>&1
$HARNESS next-tick --dir . > /dev/null 2>&1
git add -A && git commit -q -m "update" 2>/dev/null || true
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts result.json --dir . 2>/dev/null)
assert_contains "$OUT" "screenshot" "fe type requires screenshot"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# DEFENSIVE-1: satisfiesVersion — null range → returns true
# flow-templates.mjs:101
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── DEF-1: external flow without opc_compat loads"
D=$(mktemp -d)
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/test-no-compat.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"}
}
EOF
cd "$D"
# Flow without opc_compat → satisfiesVersion(null, ...) → true → loads
OUT=$($HARNESS init --flow test-no-compat --dir . 2>/dev/null)
assert_field_eq "$OUT" "['created']" "True" "flow without opc_compat loads (null range)"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# DEFENSIVE-2: skip on flow without nodeTypes → fallback nodeType=execute
# flow-escape.mjs:56
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── DEF-2: skip on flow without nodeTypes → execute fallback"
D=$(mktemp -d)
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/test-no-types.json" << 'EOF'
{
  "nodes": ["x","y"],
  "edges": {"x": {"PASS": "y"}, "y": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5}
}
EOF
cd "$D"
$HARNESS init --flow test-no-types --dir . > /dev/null 2>&1
# Skip from 'x' → should create handshake with nodeType="execute" (fallback since no nodeTypes)
OUT=$($HARNESS skip --dir . 2>/dev/null)
assert_contains "$OUT" "skipped" "skip works on flow without nodeTypes"
# Verify handshake has nodeType=execute
HS=$(cat nodes/x/handshake.json 2>/dev/null || echo "{}")
assert_contains "$HS" "execute" "skip handshake nodeType defaults to execute"
rm -f "$HOME/.claude/flows/test-no-types.json"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# DEFENSIVE-3: cmdPass on node named exactly "gate" (not prefix)
# flow-escape.mjs:96
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── DEF-3: pass on node named exactly 'gate'"
D=$(mktemp -d)
cd "$D"
# build-verify has a node named "gate" with nodeType "gate"
$HARNESS init --flow build-verify --entry gate --dir . > /dev/null 2>&1
OUT=$($HARNESS pass --dir . 2>/dev/null)
# Gate PASS→null is terminal → "Use finalize instead"
assert_contains "$OUT" "finalize\|terminal" "pass on 'gate' node recognizes it as gate"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# DEFENSIVE-4: backlog enforcement — upstreamId null (no edges point to gate)
# flow-transition.mjs:164-168
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── DEF-4: gate with no upstream node → backlog skipped"
D=$(mktemp -d)
mkdir -p "$HOME/.claude/flows"
# Flow where gate-x is entry and nothing points to it
cat > "$HOME/.claude/flows/test-orphan-gate.json" << 'EOF'
{
  "nodes": ["gate-x", "end"],
  "edges": {"gate-x": {"PASS": "end", "FAIL": "end"}, "end": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"gate-x": "gate", "end": "build"},
  "opc_compat": ">=0.5"
}
EOF
cd "$D"
$HARNESS init --flow test-orphan-gate --entry gate-x --dir . > /dev/null 2>&1
# PASS from orphan gate → no upstream → backlog check should be skipped
OUT=$($HARNESS transition --from gate-x --to end --verdict PASS --flow test-orphan-gate --dir . 2>/dev/null)
assert_field_eq "$OUT" "['allowed']" "True" "orphan gate (no upstream) → transition allowed"
rm -rf "$D"
cd /tmp

rm -f "$HOME/.claude/flows/test-no-compat.json"
rm -f "$HOME/.claude/flows/test-no-types.json"
rm -f "$HOME/.claude/flows/test-orphan-gate.json"

print_results
