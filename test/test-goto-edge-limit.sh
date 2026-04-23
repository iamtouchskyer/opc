#!/usr/bin/env bash
set -euo pipefail

# Test: goto maxLoopsPerEdge enforcement

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

H() { (cd "$TMPD" && $HARNESS "$@" 2>&1); }

setup_flow() {
  local reldir="$1"
  local absdir="$TMPD/$reldir"
  mkdir -p "$absdir/nodes/build/run_1" "$absdir/nodes/code-review/run_1"
  cat > "$absdir/flow-state.json" << EOF
{
  "flowTemplate": "build-verify",
  "currentNode": "build",
  "entryNode": "build",
  "status": "in_progress",
  "totalSteps": 0,
  "history": [{"nodeId": "build", "runId": "run_1", "timestamp": "2026-01-01T00:00:00Z"}],
  "edgeCounts": {},
  "_written_by": "opc-harness",
  "_last_modified": "2026-01-01T00:00:00Z"
}
EOF
}

echo "=== TEST GROUP 1: goto respects maxLoopsPerEdge ==="

setup_flow "run1"

R1=$(H goto code-review --dir run1)
check "first goto succeeds" 'echo "$R1" | grep -q "\"goto\":\"code-review\""'
check "edgeCounts updated" 'grep -q "build→code-review" "$TMPD/run1/flow-state.json"'

R2=$(H goto build --dir run1)
check "goto back to build succeeds" 'echo "$R2" | grep -q "\"goto\":\"build\""'

R3=$(H goto code-review --dir run1)
check "second goto code-review succeeds" 'echo "$R3" | grep -q "\"goto\":\"code-review\""'

H goto build --dir run1 > /dev/null
R5=$(H goto code-review --dir run1)
check "third goto code-review succeeds" 'echo "$R5" | grep -q "\"goto\":\"code-review\""'

# 4th goto code-review from build — should fail (maxLoopsPerEdge=3)
H goto build --dir run1 > /dev/null
R7=$(H goto code-review --dir run1)
check "4th goto code-review blocked" 'echo "$R7" | grep -q "maxLoopsPerEdge"'

echo ""
echo "=== TEST GROUP 2: edgeCounts persisted ==="

setup_flow "run2"
H goto code-review --dir run2 > /dev/null
EDGE_COUNT=$(node -e "const s=JSON.parse(require('fs').readFileSync('$TMPD/run2/flow-state.json','utf8')); console.log(s.edgeCounts['build→code-review'] || 0)")
check "edge count is 1" '[ "$EDGE_COUNT" = "1" ]'

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[ "$FAIL" -eq 0 ] || exit 1
