#!/usr/bin/env bash
# OPC Harness Comprehensive Verification Test Suite
# Tests all ⚠️ (partially verified) and ❌ (unverified) items from the OPC v0.7 assessment.
#
# Run: bash test/test-comprehensive.sh
# Exit code: 0 = all pass, 1 = failures

set -euo pipefail

OPC_BIN="$(dirname "$(dirname "$(realpath "$0")")")/bin/opc-harness.mjs"
opc() { node "$OPC_BIN" "$@"; }
TESTBASE="/tmp/opc-comprehensive-test-$$"
mkdir -p "$TESTBASE"
PASS=0; FAIL=0; TOTAL=0

check() {
  TOTAL=$((TOTAL + 1))
  local NAME="$1"; shift
  if "$@" > /dev/null 2>&1; then
    PASS=$((PASS + 1))
    echo "  ✅ $NAME"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $NAME"
  fi
}

check_json() {
  TOTAL=$((TOTAL + 1))
  local NAME="$1" EXPR="$2" INPUT="$3"
  local RESULT
  RESULT=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print($EXPR)" 2>/dev/null)
  if [ "$RESULT" = "True" ] || [ "$RESULT" = "true" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ $NAME"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $NAME (got: $RESULT)"
  fi
}

write_review_hs() {
  local DIR="$1" NODE="$2" VERDICT="${3:-PASS}"
  mkdir -p "$DIR/nodes/$NODE/run_1"
  printf '# Review A\nPerspective: Security\nVERDICT: %s FINDINGS[0]\n' "$VERDICT" > "$DIR/nodes/$NODE/run_1/eval-a.md"
  printf '# Review B\nPerspective: Performance\nVERDICT: %s FINDINGS[0]\n' "$VERDICT" > "$DIR/nodes/$NODE/run_1/eval-b.md"
  printf '{"nodeId":"%s","nodeType":"review","runId":"run_1","status":"completed","summary":"Done","timestamp":"%s","artifacts":[{"type":"eval","path":"run_1/eval-a.md"},{"type":"eval","path":"run_1/eval-b.md"}],"verdict":"%s"}\n' \
    "$NODE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$VERDICT" > "$DIR/nodes/$NODE/handshake.json"
}

write_build_hs() {
  local DIR="$1" NODE="$2"
  mkdir -p "$DIR/nodes/$NODE/run_1"
  echo "output" > "$DIR/nodes/$NODE/run_1/output.md"
  printf '{"nodeId":"%s","nodeType":"build","runId":"run_1","status":"completed","summary":"Built","timestamp":"%s","artifacts":[{"type":"source","path":"run_1/output.md"}],"verdict":null}\n' \
    "$NODE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/nodes/$NODE/handshake.json"
}

write_exec_hs() {
  local DIR="$1" NODE="$2"
  mkdir -p "$DIR/nodes/$NODE/run_1"
  echo "test output" > "$DIR/nodes/$NODE/run_1/output.txt"
  printf '{"nodeId":"%s","nodeType":"execute","runId":"run_1","status":"completed","summary":"Executed","timestamp":"%s","artifacts":[{"type":"cli-output","path":"run_1/output.txt"}],"verdict":null}\n' \
    "$NODE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/nodes/$NODE/handshake.json"
}

# ─────────────────────────────────────────────────────────────────
echo "━━━ U1: FAIL/ITERATE Loopback ━━━"

T="$TESTBASE/u1"
mkdir -p "$T" && cd "$T"

opc init --flow review --entry review --dir .harness 2>/dev/null

# Cycle 1-3: review → gate (PASS) then gate → review (FAIL)
for i in 1 2 3; do
  write_review_hs ".harness" "review" "FAIL"
  sleep 1
  opc transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null > /dev/null
  sleep 1
  opc transition --from gate --to review --verdict FAIL --flow review --dir .harness 2>/dev/null > /dev/null
done

# 4th cycle should be blocked
write_review_hs ".harness" "review" "FAIL"
sleep 1
R=$(opc transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null)
check_json "maxLoopsPerEdge blocks 4th cycle" "d['allowed']==False" "$R"

# Synthesize FAIL verdict
T1F="$TESTBASE/u1-fail"
mkdir -p "$T1F" && cd "$T1F"
opc init --flow review --entry review --dir .harness 2>/dev/null
mkdir -p .harness/nodes/review/run_1
printf '# Review\n🔴 file.py:10 — Bug\n→ Fix\nReasoning: Broken\nVERDICT: FAIL FINDINGS[1]\n' > .harness/nodes/review/run_1/eval-q.md
R=$(opc synthesize .harness --node review)
check_json "synthesize 🔴 → FAIL" "d['verdict']=='FAIL'" "$R"

# Synthesize ITERATE verdict
T1I="$TESTBASE/u1-iter"
mkdir -p "$T1I" && cd "$T1I"
opc init --flow review --entry review --dir .harness 2>/dev/null
mkdir -p .harness/nodes/review/run_1
printf '# Review\n🟡 file.py:10 — Warning\n→ Fix\nReasoning: Should fix\nVERDICT: ITERATE FINDINGS[1]\n' > .harness/nodes/review/run_1/eval-q.md
R=$(opc synthesize .harness --node review)
check_json "synthesize 🟡 → ITERATE" "d['verdict']=='ITERATE'" "$R"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━ U2: Emoji False-Positive Fix ━━━"

T2="$TESTBASE/u2"
mkdir -p "$T2" && cd "$T2"
cat > eval.md << 'EOF'
# Review
🔴 Must Fix:
None.
🟡 Should Fix:
None.
VERDICT: PASS FINDINGS[0]
EOF
R=$(opc verify eval.md)
check_json "section labels not counted as findings" "d['critical']==0 and d['warning']==0" "$R"

cat > eval-real.md << 'EOF'
# Review
🔴 file.py:10 — Real bug
→ Fix
Reasoning: Broken
VERDICT: FAIL FINDINGS[1]
EOF
R=$(opc verify eval-real.md)
check_json "real findings still detected" "d['critical']==1" "$R"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━ U3: Finalize Terminal Gate ━━━"

T3="$TESTBASE/u3"
mkdir -p "$T3" && cd "$T3"
opc init --flow review --entry review --dir .harness 2>/dev/null
write_review_hs ".harness" "review"
opc transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null > /dev/null
R=$(opc finalize --dir .harness)
check_json "finalize auto-creates gate handshake" "d['finalized']==True" "$R"
check "gate handshake.json exists" test -f .harness/nodes/gate/handshake.json

# ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━ U4: External Flow Templates ━━━"

mkdir -p ~/.claude/flows
cat > ~/.claude/flows/_opc_test_ext.json << 'EOF'
{"nodes":["a","b","gate"],"edges":{"a":{"PASS":"b"},"b":{"PASS":"gate"},"gate":{"PASS":null,"FAIL":"a"}},"limits":{"maxLoopsPerEdge":3,"maxTotalSteps":10,"maxNodeReentry":5},"nodeTypes":{"a":"build","b":"review","gate":"gate"}}
EOF
T4="$TESTBASE/u4"
mkdir -p "$T4" && cd "$T4"
R=$(opc init --flow _opc_test_ext --entry a --dir .harness 2>/dev/null)
check_json "external flow loads" "d['created']==True" "$R"
R=$(opc route --node gate --verdict FAIL --flow _opc_test_ext)
check_json "external flow routing works" "d['next']=='a'" "$R"

# Bad flow
cat > ~/.claude/flows/_opc_test_bad.json << 'EOF'
{"nodes":["a"],"edges":{"a":{"PASS":"missing"}},"limits":{"maxLoopsPerEdge":1,"maxTotalSteps":5,"maxNodeReentry":3}}
EOF
R=$(opc init --flow _opc_test_bad --entry a --dir .harness-bad 2>&1)
check_json "bad edge target rejected" "d.get('error','').startswith('unknown')" "$(echo "$R" | grep '^{')"

# Prototype pollution
cat > ~/.claude/flows/__proto__.json << 'EOF'
{"nodes":["a"],"edges":{"a":{"PASS":null}},"limits":{"maxLoopsPerEdge":1,"maxTotalSteps":5,"maxNodeReentry":3}}
EOF
R=$(opc init --flow __proto__ --entry a --dir .harness-proto 2>&1)
check_json "prototype pollution blocked" "d.get('error','').startswith('unknown')" "$(echo "$R" | grep '^{')"

rm -f ~/.claude/flows/_opc_test_ext.json ~/.claude/flows/_opc_test_bad.json ~/.claude/flows/__proto__.json

# ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━ U5: Escape Hatches ━━━"

T5="$TESTBASE/u5"
mkdir -p "$T5" && cd "$T5"
opc init --flow build-verify --entry build --dir .harness 2>/dev/null

# goto
R=$(opc goto test-execute --dir .harness)
check_json "goto jumps to target" "d['goto']=='test-execute'" "$R"

# goto non-existent
R=$(opc goto nonexistent --dir .harness)
check_json "goto non-existent fails" "'not a node' in d.get('error','')" "$R"

# goto maxNodeReentry (init does NOT add to history; goto test-execute doesn't count for build)
# Need 5 gotos to build to fill history with 5 entries, then 6th is blocked
for i in 1 2 3 4 5; do opc goto build --dir .harness > /dev/null 2>&1; done
R=$(opc goto build --dir .harness)
check_json "maxNodeReentry enforced" "'maxNodeReentry' in d.get('error','')" "$R"

# stop
T5S="$TESTBASE/u5-stop"
mkdir -p "$T5S" && cd "$T5S"
opc init --flow review --entry review --dir .harness 2>/dev/null
R=$(opc stop --dir .harness)
check_json "stop preserves state" "d['stopped']==True" "$R"
check "state has stopped status" python3 -c "import json; assert json.load(open('.harness/flow-state.json'))['status']=='stopped'"

# pass on non-terminal gate
T5P="$TESTBASE/u5-pass"
mkdir -p "$T5P" && cd "$T5P"
opc init --flow full-stack --entry discuss --dir .harness 2>/dev/null
opc goto gate-test --dir .harness > /dev/null 2>&1
R=$(opc pass --dir .harness 2>/dev/null)
check_json "pass advances gate" "d.get('next')=='acceptance'" "$R"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━ U6: Oscillation Detection ━━━"

T6="$TESTBASE/u6"
mkdir -p "$T6" && cd "$T6"
cat > r1.md << 'EOF'
# Review
🔴 file.py:10 — Bug
→ Fix
Reasoning: Broken
VERDICT: FAIL FINDINGS[1]
EOF
cp r1.md r2.md

R=$(opc diff r1.md r2.md)
check_json "diff detects oscillation" "d['oscillation']==True" "$R"

cat > r3.md << 'EOF'
# Review
🟡 utils.js:5 — New issue
→ Fix
Reasoning: Different
VERDICT: ITERATE FINDINGS[1]
EOF
R=$(opc diff r1.md r3.md)
check_json "diff no oscillation on different findings" "d['oscillation']==False" "$R"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━ U7: Context Recovery ━━━"

T7="$TESTBASE/u7"
mkdir -p "$T7" && cd "$T7"
opc init --flow build-verify --entry build --dir .harness 2>/dev/null
write_build_hs ".harness" "build"
opc transition --from build --to code-review --verdict PASS --flow build-verify --dir .harness 2>/dev/null > /dev/null

R=$(opc validate-chain --dir .harness)
check_json "validate-chain mid-flow" "d['valid']==True" "$R"

# Resume
write_review_hs ".harness" "code-review"
sleep 1
R=$(opc transition --from code-review --to test-design --verdict PASS --flow build-verify --dir .harness 2>/dev/null)
check_json "resume from saved state" "d['allowed']==True" "$R"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━ U8: contextSchema Validation ━━━"

mkdir -p ~/.claude/flows
cat > ~/.claude/flows/_opc_test_schema.json << 'EOF'
{"nodes":["build","gate"],"edges":{"build":{"PASS":"gate"},"gate":{"PASS":null}},"limits":{"maxLoopsPerEdge":3,"maxTotalSteps":10,"maxNodeReentry":5},"nodeTypes":{"build":"build","gate":"gate"},"contextSchema":{"build":{"required":["task"],"rules":{"task":"non-empty-string"}}}}
EOF
T8="$TESTBASE/u8"
mkdir -p "$T8" && cd "$T8"
opc init --flow _opc_test_schema --entry build --dir .harness 2>/dev/null

R=$(opc validate-context --flow _opc_test_schema --node build --dir .harness)
check_json "missing flow-context.json" "d['valid']==False" "$R"

echo '{"task":"implement auth"}' > .harness/flow-context.json
R=$(opc validate-context --flow _opc_test_schema --node build --dir .harness)
check_json "valid context passes" "d['valid']==True" "$R"

echo '{"task":""}' > .harness/flow-context.json
R=$(opc validate-context --flow _opc_test_schema --node build --dir .harness)
check_json "empty string fails non-empty-string" "d['valid']==False" "$R"

rm -f ~/.claude/flows/_opc_test_schema.json

# ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━ U9: Loop Protocol ━━━"

T9="$TESTBASE/u9"
mkdir -p "$T9" && cd "$T9"
git init -q && git commit --allow-empty -m "init" -q

cat > plan.md << 'EOF'
- T1.1: implement — Build feature
  - verify: npm test
- T1.2: review — Review feature
  - eval: check quality
EOF

R=$(opc init-loop --plan plan.md --dir .harness)
check_json "init-loop parses plan" "d['initialized']==True and d['total_units']==2" "$R"

R=$(opc next-tick --dir .harness)
check_json "next-tick returns first unit" "d['next_unit']=='T1.1'" "$R"

echo "evidence" > ev.txt
git commit --allow-empty -m "build" -q
R=$(opc complete-tick --unit T1.1 --artifacts ev.txt --description "Built" --dir .harness)
check_json "complete-tick advances" "d['next_unit']=='T1.2'" "$R"

R=$(opc next-tick --dir .harness)
check_json "next-tick returns second unit" "d['next_unit']=='T1.2'" "$R"

printf '# R1\n🔵 ok\n→ fix\nReasoning: fine\nVERDICT: PASS FINDINGS[1]\n' > e1.md
printf '# R2\n🔵 good\n→ fix\nReasoning: ok\nVERDICT: PASS FINDINGS[1]\n' > e2.md
R=$(opc complete-tick --unit T1.2 --artifacts e1.md,e2.md --description "Reviewed" --dir .harness)
check_json "pipeline terminates" "d['terminate']==True" "$R"

R=$(opc next-tick --dir .harness)
check_json "next-tick confirms completion" "d['terminate']==True" "$R"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━ U10: Multi-Template Flows ━━━"

# build-verify complete
T10="$TESTBASE/u10"
mkdir -p "$T10" && cd "$T10"
opc init --flow build-verify --entry build --dir .harness 2>/dev/null
write_build_hs ".harness" "build"
sleep 1; opc transition --from build --to code-review --verdict PASS --flow build-verify --dir .harness 2>/dev/null > /dev/null
write_review_hs ".harness" "code-review"
sleep 1; opc transition --from code-review --to test-design --verdict PASS --flow build-verify --dir .harness 2>/dev/null > /dev/null
write_review_hs ".harness" "test-design"
sleep 1; opc transition --from test-design --to test-execute --verdict PASS --flow build-verify --dir .harness 2>/dev/null > /dev/null
write_exec_hs ".harness" "test-execute"
sleep 1; opc transition --from test-execute --to gate --verdict PASS --flow build-verify --dir .harness 2>/dev/null > /dev/null
R=$(opc finalize --dir .harness)
check_json "build-verify complete" "d['finalized']==True" "$R"

# legacy-linear routing
R=$(opc route --node evaluate --verdict FAIL --flow legacy-linear)
check_json "legacy-linear FAIL → build" "d['next']=='build'" "$R"
R=$(opc route --node deliver --verdict PASS --flow legacy-linear)
check_json "legacy-linear terminal" "d['next']==None" "$R"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

rm -rf "$TESTBASE"
exit $FAIL
