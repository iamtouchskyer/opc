#!/bin/bash
# test-node-preflight-empty-task.sh - direct node-preflight skips empty AC

set -u
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0
FAIL=0
TMP=$(mktemp -d -t opc-node-preflight-empty-XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM HUP

ok() { PASS=$((PASS + 1)); echo "  [ok] $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  [fail] $1"; }

EXT_DIR="$TMP/extensions"
mkdir -p "$EXT_DIR/design-ext"
cat > "$EXT_DIR/design-ext/ext.json" <<'JSON'
{
  "name": "design-ext",
  "version": "1.0.0",
  "meta": { "provides": ["design-preflight@1"], "compatibleCapabilities": [] }
}
JSON
cat > "$EXT_DIR/design-ext/hook.mjs" <<'JS'
export const meta = { provides: ["design-preflight@1"] };
export function preflight() {
  return { type: "design", confidence: 0.1, reason: "should not run" };
}
JS

FLOW_FILE="$TMP/flow.json"
cat > "$FLOW_FILE" <<'JSON'
{
  "opc_compat": ">=0.0",
  "nodes": ["build"],
  "edges": { "build": { "PASS": null } },
  "limits": { "maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5 },
  "nodeTypes": { "build": "build" },
  "nodeCapabilities": { "build": ["design-preflight@1"] }
}
JSON

HARNESS="$TMP/harness"
mkdir -p "$HARNESS/.opc"
cat > "$HARNESS/.opc/config.json" <<JSON
{ "extensionsDir": "$EXT_DIR" }
JSON
cat > "$HARNESS/acceptance-criteria.md" <<'MD'
# Acceptance Criteria
MD

HARNESS_BIN="node $REPO_ROOT/bin/opc-harness.mjs"
OUT=$(OPC_BREAKER_STATE=disabled $HARNESS_BIN node-preflight --node build --dir "$HARNESS" --flow-file "$FLOW_FILE" 2>/dev/null)

echo "=== Direct Node Preflight Empty Task Test ==="
if echo "$OUT" | grep -q '"skipped":true'; then
  ok "node-preflight reports skipped"
else
  fail "expected skipped output: $OUT"
fi

if echo "$OUT" | grep -q '"preflightResults":0'; then
  ok "node-preflight produced no preflight results"
else
  fail "expected zero preflight results: $OUT"
fi

if [ ! -f "$HARNESS/design-mode.json" ] && [ ! -f "$HARNESS/di-state.json" ]; then
  ok "node-preflight wrote no design artifacts"
else
  fail "expected no design artifacts"
fi

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
