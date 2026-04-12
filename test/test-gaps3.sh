#!/usr/bin/env bash
# test-gaps3.sh — Zero-trust audit round 3: close ALL remaining REAL + DEFENSIVE gaps
# 9 REAL + 12 DEFENSIVE = 21 untested branches
set -euo pipefail

HARNESS="node $HOME/.claude/skills/opc/bin/opc-harness.mjs"
PASS=0; FAIL=0

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
# REAL-1: Executor happy-path evidence — valid evidence → no error
# flow-core.mjs:155-164 — hasEvidence=true path
# ─────────────────────────────────────────────────────────────────
echo "── REAL-1: executor with valid evidence → no error"
D=$(mktemp -d)
mkdir -p "$D/nodes/exec-node"
cat > "$D/nodes/exec-node/handshake.json" << 'EOF'
{
  "nodeId": "exec-node",
  "nodeType": "execute",
  "runId": "run_1",
  "status": "completed",
  "summary": "ran tests",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "test-result", "path": "results.json"}],
  "verdict": null
}
EOF
echo '{}' > "$D/nodes/exec-node/results.json"
cd "$D"
OUT=$($HARNESS validate nodes/exec-node/handshake.json 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "executor with test-result evidence is valid"
assert_not_contains "$OUT" "evidence" "no evidence error when evidence present"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# REAL-2: non-empty-object rule rejects array
# flow-core.mjs:231
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── REAL-2: non-empty-object rule rejects array"
D=$(mktemp -d)
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/test-obj-rule.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "opc_compat": ">=0.5",
  "contextSchema": {
    "a": {
      "required": [],
      "rules": {"config": "non-empty-object"}
    }
  }
}
EOF
cd "$D"
$HARNESS init --flow test-obj-rule --dir . > /dev/null 2>&1
echo '{"config": [1,2,3]}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-obj-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "array fails non-empty-object rule"
assert_contains "$OUT" "non-empty-object" "error references rule name"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# REAL-3: positive-integer rule rejects float
# flow-core.mjs:233
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── REAL-3: positive-integer rule rejects float"
D=$(mktemp -d)
cat > "$HOME/.claude/flows/test-int-rule.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "opc_compat": ">=0.5",
  "contextSchema": {
    "a": {
      "required": [],
      "rules": {"count": "positive-integer"}
    }
  }
}
EOF
cd "$D"
$HARNESS init --flow test-int-rule --dir . > /dev/null 2>&1
echo '{"count": 1.5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-int-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "float 1.5 fails positive-integer rule"
# Also test 0 (not positive)
echo '{"count": 0}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-int-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "zero fails positive-integer rule"
# Also test negative
echo '{"count": -3}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-int-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "negative fails positive-integer rule"
# Happy path: valid integer
echo '{"count": 5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-int-rule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "positive integer passes rule"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# REAL-4: Corrupt upstream handshake during backlog enforcement
# flow-transition.mjs:206-212
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── REAL-4: corrupt upstream handshake in backlog enforcement"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --dir . > /dev/null 2>&1
# Manually build state at gate with proper history
mkdir -p nodes/build nodes/code-review nodes/test-verify
# build handshake with warnings (triggers backlog check)
cat > nodes/build/handshake.json << 'EOF'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[],"verdict":null}
EOF
cat > nodes/code-review/handshake.json << 'EOF'
{"nodeId":"code-review","nodeType":"review","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[],"verdict":null}
EOF
# test-verify handshake is the upstream of gate — make it have warnings then corrupt it
cat > nodes/test-verify/handshake.json << 'EOF'
{"nodeId":"test-verify","nodeType":"execute","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[],"verdict":null,"findings":{"warning":2}}
EOF
# Advance state to gate
python3 -c "
import json
s=json.load(open('flow-state.json'))
s['currentNode']='gate'
s['history']=[
  {'nodeId':'build','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},
  {'nodeId':'code-review','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},
  {'nodeId':'test-verify','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},
  {'nodeId':'gate','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'}
]
s['totalSteps']=4
s['edgeCounts']={}
json.dump(s,open('flow-state.json','w'),indent=2)
"
# Now corrupt the upstream handshake AFTER state was built
echo "CORRUPT JSON {{{{" > nodes/test-verify/handshake.json
# ITERATE from gate triggers backlog check on upstream test-verify
OUT=$($HARNESS transition --from gate --to build --verdict ITERATE --flow build-verify --dir . 2>/dev/null)
assert_contains "$OUT" "corrupt" "corrupt upstream handshake detected"
assert_field_eq "$OUT" "['allowed']" "False" "transition blocked by corrupt upstream"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# REAL-5: Missing upstream handshake skips backlog check
# flow-transition.mjs:170-172
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── REAL-5: missing upstream handshake → backlog check skipped"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --dir . > /dev/null 2>&1
mkdir -p nodes/build nodes/code-review nodes/test-verify
cat > nodes/build/handshake.json << 'EOF'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[],"verdict":null}
EOF
cat > nodes/code-review/handshake.json << 'EOF'
{"nodeId":"code-review","nodeType":"review","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[],"verdict":null}
EOF
# DO NOT create test-verify handshake — upstream is missing
python3 -c "
import json
s=json.load(open('flow-state.json'))
s['currentNode']='gate'
s['history']=[
  {'nodeId':'build','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},
  {'nodeId':'code-review','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},
  {'nodeId':'test-verify','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'},
  {'nodeId':'gate','runId':'run_1','timestamp':'2024-01-01T00:00:00Z'}
]
s['totalSteps']=4
s['edgeCounts']={}
json.dump(s,open('flow-state.json','w'),indent=2)
"
# PASS from gate — no upstream handshake → backlog check should be silently skipped → transition allowed
OUT=$($HARNESS transition --from gate --to build --verdict ITERATE --flow build-verify --dir . 2>/dev/null)
# Without upstream handshake, no findings.warning to trigger backlog enforcement
assert_field_eq "$OUT" "['allowed']" "True" "missing upstream handshake → backlog skipped → allowed"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
# REAL-6: detectTestScript — "type-check" and "tsc" alternate keys
# loop-helpers.mjs:93-94
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── REAL-6: detectTestScript alternate typecheck keys"
D=$(mktemp -d)
cd "$D"
# Test "type-check" key
cat > package.json << 'EOF'
{"scripts": {"type-check": "tsc --noEmit"}}
EOF
cat > plan.md << 'PLAN'
- F1.1: implement — build
- F1.2: review — review
PLAN
OUT=$($HARNESS init-loop --plan plan.md --dir . 2>/dev/null)
assert_contains "$OUT" "typecheck" "type-check key detected as typecheck"
# Now test "tsc" key
echo '{"scripts": {"tsc": "tsc"}}' > package.json
rm -f loop-state.json
OUT=$($HARNESS init-loop --plan plan.md --dir . 2>/dev/null)
assert_contains "$OUT" "typecheck" "tsc key detected as typecheck"
# Also test "lint" via "eslint" key
echo '{"scripts": {"eslint": "eslint ."}}' > package.json
rm -f loop-state.json
OUT=$($HARNESS init-loop --plan plan.md --dir . 2>/dev/null)
assert_contains "$OUT" "lint" "eslint key detected as lint"
rm -rf "$D"
cd /tmp

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
$HARNESS init-loop --plan plan.md --dir . > /dev/null 2>&1
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
$HARNESS init-loop --plan plan.md --dir . > /dev/null 2>&1
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
$HARNESS init-loop --plan plan.md --dir . > /dev/null 2>&1
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
$HARNESS init-loop --plan plan.md --dir . > /dev/null 2>&1
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
$HARNESS init-loop --plan plan.md --dir . > /dev/null 2>&1
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
$HARNESS init-loop --plan plan.md --dir . > /dev/null 2>&1
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
$HARNESS init-loop --plan plan.md --dir . > /dev/null 2>&1
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
$HARNESS init-loop --plan plan.md --dir . > /dev/null 2>&1
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

# ─────────────────────────────────────────────────────────────────
# Cleanup test flows
# ─────────────────────────────────────────────────────────────────
rm -f "$HOME/.claude/flows/test-obj-rule.json"
rm -f "$HOME/.claude/flows/test-int-rule.json"
rm -f "$HOME/.claude/flows/test-no-compat.json"
rm -f "$HOME/.claude/flows/test-orphan-gate.json"
rm -f "$HOME/.claude/flows/test-str-rule.json"
rm -f "$HOME/.claude/flows/test-arr-rule.json"

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

[ "$FAIL" -eq 0 ] || exit 1
