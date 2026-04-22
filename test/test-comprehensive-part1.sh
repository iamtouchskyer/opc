#!/bin/bash
set -e
OPC_BIN="$(dirname "$(dirname "$(realpath "$0")")")/bin/opc-harness.mjs"

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
opc() { node "$OPC_BIN" "$@"; }
TESTBASE="/tmp/opc-comprehensive-test-$$"
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

rm -rf "$TESTBASE"
print_results
