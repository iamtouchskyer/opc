#!/usr/bin/env bash
set -euo pipefail

# Test: transition handles --to null (terminal transitions)

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS=(node "$SCRIPT_DIR/bin/opc-harness.mjs")
PASS=0; FAIL=0

check() {
  local label="$1" cond="$2"
  if eval "$cond"; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label"
    FAIL=$((FAIL + 1))
  fi
}

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

write_review_hs() {
  local dir="$1" node="$2"
  local verdict="${3:-PASS}"
  local finding="${4:-FINDINGS[0]}"
  local line="VERDICT: $verdict $finding"
  mkdir -p "$dir/nodes/$node/run_1"
  printf '# E1\n%s\n' "$line" > "$dir/nodes/$node/run_1/eval-a.md"
  printf '# E2\n%s\n' "$line" > "$dir/nodes/$node/run_1/eval-b.md"
  printf '{"nodeId":"%s","nodeType":"review","runId":"run_1","status":"completed","summary":"Done","timestamp":"%s","artifacts":[{"type":"eval","path":"run_1/eval-a.md"},{"type":"eval","path":"run_1/eval-b.md"}],"verdict":"%s"}\n' \
    "$node" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$verdict" > "$dir/nodes/$node/handshake.json"
  printf '{"nodeId":"%s","nodeType":"review","runId":"run_1","status":"completed","summary":"Done","timestamp":"%s","artifacts":[{"type":"eval","path":"eval-a.md"},{"type":"eval","path":"eval-b.md"}],"verdict":"%s"}\n' \
    "$node" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$verdict" > "$dir/nodes/$node/run_1/handshake.json"
}

set_gate_state() {
  python3 - <<'PY'
import json
path = ".harness/flow-state.json"
data = json.load(open(path))
data["currentNode"] = "gate"
data["history"] = [
  {"nodeId": "review", "runId": "run_1", "timestamp": "2026-01-01T00:00:00.000Z"},
  {"nodeId": "gate", "runId": "run_1", "timestamp": "2026-01-01T00:01:00.000Z"},
]
open(path, "w").write(json.dumps(data, indent=2) + "\n")
PY
  mkdir -p .harness/nodes/gate/run_1
  printf '{"nodeId":"gate","nodeType":"gate","runId":"run_1","status":"completed","summary":"gate ready","timestamp":"%s","artifacts":[],"verdict":"PASS"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .harness/nodes/gate/run_1/handshake.json
  cp .harness/nodes/gate/run_1/handshake.json .harness/nodes/gate/handshake.json
}

echo "=== TEST GROUP 1: --to null delegates to finalize ==="

D1="$TMPD/t1"
mkdir -p "$D1" && cd "$D1"
"${HARNESS[@]}" init --flow review --entry review --dir .harness > /dev/null 2>&1
write_review_hs ".harness" "review"
"${HARNESS[@]}" transition --from review --to gate --verdict PASS --flow review --dir .harness > /dev/null 2>&1

RESULT=$(cd "$D1" && "${HARNESS[@]}" transition --from gate --to null --verdict PASS --flow review --dir .harness 2>&1)
check "terminal transition returns finalized" 'echo "$RESULT" | grep -q "finalized"'

echo ""
echo "=== TEST GROUP 2: --to null with invalid edge fails ==="

D2="$TMPD/t2"
mkdir -p "$D2" && cd "$D2"
"${HARNESS[@]}" init --flow review --entry review --dir .harness > /dev/null 2>&1

RESULT2=$(cd "$D2" && "${HARNESS[@]}" transition --from review --to null --verdict PASS --flow review --dir .harness 2>&1)
check "non-terminal node rejects --to null" 'echo "$RESULT2" | grep -q "no terminal edge"'

echo ""
echo "=== TEST GROUP 3: route returns null for terminal ==="

ROUTE_RESULT=$("${HARNESS[@]}" route --node gate --verdict PASS --flow review 2>&1)
check "route returns null for terminal" 'echo "$ROUTE_RESULT" | grep -q "\"next\":null"'

echo ""
echo "=== TEST GROUP 4: sealed ITERATE can structurally enter gate ==="

D3="$TMPD/t3"
mkdir -p "$D3" && cd "$D3"
"${HARNESS[@]}" init --flow review --entry review --dir .harness > /dev/null 2>&1
write_review_hs ".harness" "review" "ITERATE" "FINDINGS[1]"

RESULT3=$(cd "$D3" && "${HARNESS[@]}" transition --from review --to gate --verdict PASS --flow review --dir .harness 2>&1)
check "review PASS edge reaches gate for gate adjudication" 'echo "$RESULT3" | grep -q "\"allowed\":true"'

echo ""
echo "=== TEST GROUP 5: direct finalize blocks upstream non-PASS verdict ==="

D4="$TMPD/t4"
mkdir -p "$D4" && cd "$D4"
"${HARNESS[@]}" init --flow review --entry review --dir .harness > /dev/null 2>&1
write_review_hs ".harness" "review" "ITERATE" "FINDINGS[1]"
set_gate_state

RESULT4=$(cd "$D4" && "${HARNESS[@]}" finalize --dir .harness 2>&1)
check "finalize rejects gate with upstream ITERATE" 'echo "$RESULT4" | grep -q "sealed verdict for review is ITERATE"'

echo ""
echo "=== TEST GROUP 6: direct finalize blocks corrupt upstream handshake ==="

D5="$TMPD/t5"
mkdir -p "$D5" && cd "$D5"
"${HARNESS[@]}" init --flow review --entry review --dir .harness > /dev/null 2>&1
write_review_hs ".harness" "review"
set_gate_state
printf '{broken json\n' > .harness/nodes/review/handshake.json
printf '{broken json\n' > .harness/nodes/review/run_1/handshake.json

RESULT5=$(cd "$D5" && "${HARNESS[@]}" finalize --dir .harness 2>&1)
check "finalize rejects corrupt upstream handshake" 'echo "$RESULT5" | grep -q "parse error"'

echo ""
echo "=== TEST GROUP 7: direct finalize blocks missing upstream handshake ==="

D6="$TMPD/t6"
mkdir -p "$D6" && cd "$D6"
"${HARNESS[@]}" init --flow review --entry review --dir .harness > /dev/null 2>&1
write_review_hs ".harness" "review"
set_gate_state
rm -f .harness/nodes/review/handshake.json
rm -f .harness/nodes/review/run_1/handshake.json

RESULT6=$(cd "$D6" && "${HARNESS[@]}" finalize --dir .harness 2>&1)
check "finalize rejects missing upstream handshake" 'echo "$RESULT6" | grep -q "missing handshake for node '\''review'\'' run '\''run_1'\''"'

echo ""
echo "=== TEST GROUP 8: direct finalize blocks missing review eval artifact ==="

D7="$TMPD/t7"
mkdir -p "$D7" && cd "$D7"
"${HARNESS[@]}" init --flow review --entry review --dir .harness > /dev/null 2>&1
write_review_hs ".harness" "review"
set_gate_state
rm -f .harness/nodes/review/run_1/eval-a.md

RESULT7=$(cd "$D7" && "${HARNESS[@]}" finalize --dir .harness 2>&1)
check "finalize rejects missing review eval artifact" 'echo "$RESULT7" | grep -q "review eval artifact for review unreadable"'

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[ "$FAIL" -eq 0 ] || exit 1
