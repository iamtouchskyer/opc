#!/bin/bash
set -e
OPC_BIN="$(dirname "$(dirname "$(realpath "$0")")")/bin/opc-harness.mjs"

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
opc() { node "$OPC_BIN" "$@"; }
TESTBASE="/tmp/opc-comprehensive-test2-$$"
mkdir -p "$TESTBASE"
TOTAL=0

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

R=$(opc init-loop --skip-scope --plan plan.md --dir .harness)
check_json "init-loop --skip-scope parses plan" "d['initialized']==True and d['total_units']==2" "$R"

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

rm -rf "$TESTBASE"
print_results
