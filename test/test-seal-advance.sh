#!/usr/bin/env bash
set -euo pipefail

# Test: seal + advance commands

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="node $SCRIPT_DIR/bin/opc-harness.mjs"
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

echo "=== TEST GROUP 1: seal — basic artifact scanning ==="

D1="$TMPD/s1"
mkdir -p "$D1/nodes/review/run_1"
echo '{"version":"1.0","flowTemplate":"review","currentNode":"review","entryNode":"review","totalSteps":0,"_written_by":"opc-harness","_write_nonce":"abc","_last_modified":"2025-01-01","history":[],"edgeCounts":{}}' > "$D1/flow-state.json"

# Create eval files
cat > "$D1/nodes/review/run_1/eval-architect.md" << 'EVALEOF'
# Eval: Architecture Review
**ITERATE**
## Findings
- 🔴 Critical issue found
- 🟡 Warning about design
- 🔵 Suggestion for improvement
EVALEOF

cat > "$D1/nodes/review/run_1/eval-engineer.md" << 'EVALEOF'
# Eval: Engineering Review
**PASS**
## Findings
- 🟡 Minor code style issue
EVALEOF

SEAL_OUT=$(cd "$D1" && $HARNESS seal --node review --dir "$D1" 2>/dev/null)
check "seal produces JSON" 'echo "$SEAL_OUT" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null'
check "seal reports sealed=true" 'echo "$SEAL_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"sealed\"]==True"'
check "seal finds 2 artifacts" 'echo "$SEAL_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"artifacts\"]==2, str(d[\"artifacts\"])"'

# Check handshake.json was written
check "handshake.json exists" '[ -f "$D1/nodes/review/handshake.json" ]'
HS=$(cat "$D1/nodes/review/handshake.json")
check "handshake has findings.critical=1" 'echo "$HS" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"findings\"][\"critical\"]==1"'
check "handshake has findings.warning=2" 'echo "$HS" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"findings\"][\"warning\"]==2"'

echo ""
echo "=== TEST GROUP 2: seal — review node warns on < 2 evals ==="

D2="$TMPD/s2"
mkdir -p "$D2/nodes/review/run_1"
echo '{"version":"1.0","flowTemplate":"review","currentNode":"review","entryNode":"review","totalSteps":0,"_written_by":"opc-harness","_write_nonce":"abc","_last_modified":"2025-01-01","history":[],"edgeCounts":{}}' > "$D2/flow-state.json"
echo "# Solo eval" > "$D2/nodes/review/run_1/eval-solo.md"

SEAL_ERR=$(cd "$D2" && $HARNESS seal --node review --dir "$D2" 2>&1 1>/dev/null || true)
check "warns about < 2 evals for review" 'echo "$SEAL_ERR" | grep -q "expected.*2"'

echo ""
echo "=== TEST GROUP 3: seal — no run dirs ==="

D3="$TMPD/s3"
mkdir -p "$D3/nodes/build"
echo '{"version":"1.0","flowTemplate":"build-verify","currentNode":"build","entryNode":"build","totalSteps":0,"_written_by":"opc-harness","_write_nonce":"abc","_last_modified":"2025-01-01","history":[],"edgeCounts":{}}' > "$D3/flow-state.json"

SEAL_FAIL=$(cd "$D3" && $HARNESS seal --node build --dir "$D3" 2>/dev/null)
check "seal fails when no run dirs" 'echo "$SEAL_FAIL" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"sealed\"]==False"'

echo ""
echo "=== TEST GROUP 4: advance — error on non-gate ==="

D4="$TMPD/s4"
mkdir -p "$D4/nodes/review"
echo '{"version":"1.0","flowTemplate":"review","currentNode":"review","entryNode":"review","totalSteps":0,"_written_by":"opc-harness","_write_nonce":"abc","_last_modified":"2025-01-01","history":[],"edgeCounts":{}}' > "$D4/flow-state.json"

ADV_OUT=$(cd "$D4" && $HARNESS advance --dir "$D4" 2>/dev/null)
check "advance fails on non-gate node" 'echo "$ADV_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"advanced\"]==False"'
check "advance error mentions gate" 'echo "$ADV_OUT" | grep -q "gate"'

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[ "$FAIL" -eq 0 ] || exit 1
