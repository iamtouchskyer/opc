#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

PASS=0
FAIL=0

ok() { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

write_run_handshake() {
  local dir="$1"
  mkdir -p "$dir/nodes/build/run_1"
  echo "output" > "$dir/nodes/build/run_1/output.md"
  cat > "$dir/nodes/build/run_1/handshake.json" <<'JSON'
{
  "nodeId": "build",
  "nodeType": "build",
  "runId": "run_1",
  "status": "completed",
  "verdict": null,
  "summary": "built",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [{ "type": "source", "path": "output.md" }]
}
JSON
}

write_build_state() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/flow-state.json" <<'JSON'
{
  "version": "1.0",
  "flowTemplate": "build-verify",
  "currentNode": "build",
  "entryNode": "build",
  "totalSteps": 1,
  "maxTotalSteps": 25,
  "maxLoopsPerEdge": 3,
  "maxNodeReentry": 5,
  "history": [{ "nodeId": "build", "runId": "run_1", "timestamp": "2026-01-01T00:00:00.000Z" }],
  "edgeCounts": {},
  "repairEdgeCounts": {},
  "_written_by": "opc-harness",
  "_write_nonce": "test-run-handshake-fallback",
  "_last_modified": "2026-01-01T00:00:00.000Z"
}
JSON
}

write_run_handshake_with_failing_report() {
  local dir="$1"
  mkdir -p "$dir/nodes/test-execute/run_1"
  cat > "$dir/nodes/test-execute/run_1/test-command-result.json" <<'JSON'
{
  "test_fail_count": 1
}
JSON
  cat > "$dir/nodes/test-execute/run_1/handshake.json" <<'JSON'
{
  "nodeId": "test-execute",
  "nodeType": "execute",
  "runId": "run_1",
  "status": "completed",
  "verdict": null,
  "summary": "tests failed",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [{ "type": "test-result", "path": "test-command-result.json" }]
}
JSON
}

echo "--- run-level handshake validates through node-level path ---"
DIR="$PWD/fallback-validate"
rm -rf "$DIR"
write_run_handshake "$DIR/.harness"
write_build_state "$DIR/.harness"
OUT=$($HARNESS validate "$DIR/.harness/nodes/build/handshake.json" 2>/dev/null)
if echo "$OUT" | grep -q '"valid":true'; then
  ok "validate falls back to state-selected run_N/handshake.json"
else
  bad "validate did not use run fallback: $OUT"
fi

echo "--- transition accepts latest run-level handshake ---"
DIR="$PWD/fallback-transition"
rm -rf "$DIR"
$HARNESS init --flow build-verify --entry build --dir fallback-transition/.harness --no-extensions >/dev/null 2>/dev/null
write_run_handshake "$DIR/.harness"
OUT=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir fallback-transition/.harness 2>/dev/null)
if echo "$OUT" | grep -q '"allowed":true'; then
  ok "transition falls back to state-selected run_N/handshake.json"
else
  bad "transition did not use run fallback: $OUT"
fi

OUT=$($HARNESS validate-chain --dir fallback-transition/.harness 2>/dev/null)
if echo "$OUT" | grep -q '"valid":true'; then
  ok "validate-chain accepts state-selected run_N/handshake.json"
else
  bad "validate-chain did not use run fallback: $OUT"
fi

echo "--- pre-transition gate consumes run-level structured results ---"
DIR="$PWD/fallback-gate"
rm -rf "$DIR"
$HARNESS init --flow build-verify --entry test-execute --dir fallback-gate/.harness --no-extensions >/dev/null 2>/dev/null
write_run_handshake_with_failing_report "$DIR/.harness"
node - "$DIR/.harness/flow-state.json" <<'JS'
const fs = require("fs");
const path = process.argv[2];
const state = JSON.parse(fs.readFileSync(path, "utf8"));
state.history = [{ nodeId: "test-execute", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" }];
state.currentNode = "test-execute";
fs.writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
JS
OUT=$($HARNESS transition --from test-execute --to gate --verdict PASS --flow build-verify --dir fallback-gate/.harness 2>/dev/null)
if echo "$OUT" | grep -q '"allowed":false' && echo "$OUT" | grep -q "1 test(s) failed"; then
  ok "test-execute blocks failing structured result from run_N/handshake.json"
else
  bad "test-execute did not consume run-level structured result: $OUT"
fi

echo ""
echo "Run handshake fallback tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
