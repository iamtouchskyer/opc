#!/bin/bash
# test-bypass-chain.sh — validate-chain records bypass without waiving provenance.

set -u
cd "$(dirname "$0")/.." || exit 1

PASS=0
FAIL=0

run_test() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  ✅ $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name"
    FAIL=$((FAIL + 1))
  fi
}

TMP=$(mktemp -d)
HARNESS="${OPC_TEST_HARNESS_NAME:-.harness-bypass-chain-$$}"
cleanup() {
  rm -rf "$TMP" "$HARNESS"
  rm -f "/tmp/nb-stderr.$$"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

sync_hs() {
  SYNC_DIR="$HARNESS" bash -c 'source test/test-helpers.sh; sync_run_handshakes "$SYNC_DIR"'
}

# Seed a fake ~/.opc/config.json inside TMP (we'll override HOME for the test)
mkdir -p "$TMP/fake-home/.opc"
cat > "$TMP/fake-home/.opc/config.json" <<'EOF'
{ "requiredExtensions": ["non-existent-ext"] }
EOF

# Work inside a harness dir under cwd so resolveDir doesn't refuse it
rm -rf "$HARNESS"

echo "=== TEST: validate-chain records bypass without provenance waiver ==="

# 1) init under OPC_DISABLE_EXTENSIONS=1
echo "--- 1.1: init under OPC_DISABLE_EXTENSIONS=1 records bypassMode in flow-state"
HOME="$TMP/fake-home" OPC_DISABLE_EXTENSIONS=1 node bin/opc-harness.mjs init \
  --flow build-verify --entry code-review --dir "$HARNESS" >/dev/null 2>&1
if [ "${OPC_TEST_ABORT_AFTER_HARNESS_INIT:-0}" = "1" ]; then
  exit 97
fi
if [ -f "$HARNESS/flow-state.json" ]; then
  MODE=$(jq -r '.bypassMode.mode // "null"' "$HARNESS/flow-state.json")
  if [ "$MODE" = "disable-all" ]; then
    echo "  ✅ flow-state.bypassMode.mode = disable-all"
    PASS=$((PASS + 1))
  else
    echo "  ❌ flow-state.bypassMode.mode = '$MODE' (expected 'disable-all')"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  ❌ flow-state.json not created"
  FAIL=$((FAIL + 1))
fi

# 2) .ext-registry.json records bypass
echo "--- 1.2: .ext-registry.json records bypass marker"
if [ -f "$HARNESS/.ext-registry.json" ]; then
  BMODE=$(jq -r '.bypass.mode // "null"' "$HARNESS/.ext-registry.json")
  APPLIED=$(jq -r '.applied | length' "$HARNESS/.ext-registry.json")
  if [ "$BMODE" = "disable-all" ] && [ "$APPLIED" = "0" ]; then
    echo "  ✅ .ext-registry.json: bypass.mode=disable-all, applied=[]"
    PASS=$((PASS + 1))
  else
    echo "  ❌ .ext-registry.json mismatch: bypass=$BMODE, applied.length=$APPLIED"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  ❌ .ext-registry.json not created"
  FAIL=$((FAIL + 1))
fi

# 3) A capability-bearing current node claims no extension provenance.
mkdir -p "$HARNESS/nodes/code-review/run_1"
cat > "$HARNESS/nodes/code-review/handshake.json" <<'EOF'
{
  "nodeId": "code-review",
  "nodeType": "review",
  "runId": "run_1",
  "status": "completed",
  "summary": "review complete",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": []
}
EOF
sync_hs

echo "--- 1.3: validate-chain under bypass still enforces requiredExtensions"
OUT=$(HOME="$TMP/fake-home" OPC_DISABLE_EXTENSIONS=1 node bin/opc-harness.mjs validate-chain \
  --dir "$HARNESS" 2>/dev/null)
VALID=$(echo "$OUT" | jq -r '.valid // false')
ERRORS=$(echo "$OUT" | jq -r '.errors | join(" ")')
if [ "$VALID" = "false" ] && [[ "$ERRORS" == *"extensionsApplied missing"* ]]; then
  echo "  ✅ bypass cannot turn missing required provenance green"
  PASS=$((PASS + 1))
else
  echo "  ❌ validate-chain waived missing provenance under bypass: $OUT"
  FAIL=$((FAIL + 1))
fi

# 3b) Bypass remains machine-readable audit metadata, but waives nothing.
echo "--- 1.3b: validate-chain exposes bypass state without waiver"
BACTIVE=$(echo "$OUT" | jq -r '.bypassActive')
BSOURCE=$(echo "$OUT" | jq -r '.bypassSource')
WAIVED_COUNT=$(echo "$OUT" | jq -r '.waivedRequiredExtensions | length')
if [ "$BACTIVE" = "true" ] && [[ "$BSOURCE" == flow-state* ]] && [ "$WAIVED_COUNT" = "0" ]; then
  echo "  ✅ bypassActive=true, bypassSource=$BSOURCE, waived=[]"
  PASS=$((PASS + 1))
else
  echo "  ❌ JSON fields wrong: bypassActive=$BACTIVE bypassSource=$BSOURCE waived.length=$WAIVED_COUNT"
  FAIL=$((FAIL + 1))
fi

# 4) Without bypass, the same missing provenance fails for the same reason.
echo "--- 1.4: without bypass, required provenance is enforced without waiver"
rm -rf "$HARNESS"
HOME="$TMP/fake-home" node bin/opc-harness.mjs init \
  --flow build-verify --entry code-review --dir "$HARNESS" >/dev/null 2>&1
mkdir -p "$HARNESS/nodes/code-review/run_1"
cat > "$HARNESS/nodes/code-review/handshake.json" <<'EOF'
{
  "nodeId": "code-review",
  "nodeType": "review",
  "runId": "run_1",
  "status": "completed",
  "summary": "review complete",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": []
}
EOF
sync_hs
OUT_NB=$(HOME="$TMP/fake-home" node bin/opc-harness.mjs validate-chain --dir "$HARNESS" 2>/tmp/nb-stderr.$$)
MSG=$(grep -c "waiving requiredExtensions" /tmp/nb-stderr.$$ || true)
NB_VALID=$(echo "$OUT_NB" | jq -r '.valid')
NB_ERRORS=$(echo "$OUT_NB" | jq -r '.errors | join(" ")')
rm -f /tmp/nb-stderr.$$
if [ "$MSG" = "0" ] && [ "$NB_VALID" = "false" ] && [[ "$NB_ERRORS" == *"extensionsApplied missing"* ]]; then
  echo "  ✅ missing required provenance fails without waiver"
  PASS=$((PASS + 1))
else
  echo "  ❌ required provenance enforcement mismatch: $OUT_NB"
  FAIL=$((FAIL + 1))
fi

# 4b) Without bypass, JSON reports bypassActive=false
echo "--- 1.4b: without bypass, JSON reports bypassActive=false"
NB_ACTIVE=$(echo "$OUT_NB" | jq -r '.bypassActive')
NB_WAIVED=$(echo "$OUT_NB" | jq -r '.waivedRequiredExtensions | length')
if [ "$NB_ACTIVE" = "false" ] && [ "$NB_WAIVED" = "0" ]; then
  echo "  ✅ bypassActive=false, waived=[]"
  PASS=$((PASS + 1))
else
  echo "  ❌ JSON wrong without bypass: bypassActive=$NB_ACTIVE waived.length=$NB_WAIVED"
  FAIL=$((FAIL + 1))
fi

# 5) Required extension provenance must parse and corroborate the sidecar
# Use a capability-bearing node so validate-chain actually enters the provenance gate.
rm -rf "$HARNESS"
HOME="$TMP/fake-home" node bin/opc-harness.mjs init \
  --flow build-verify --entry code-review --dir "$HARNESS" >/dev/null 2>&1
mkdir -p "$HARNESS/nodes/code-review/run_1"
cat > "$HARNESS/nodes/code-review/run_1/eval-alpha.md" <<'EOF'
# Alpha Review
Role: alpha
LGTM from alpha after checking extension provenance.
VERDICT: LGTM
EOF
cat > "$HARNESS/nodes/code-review/run_1/eval-beta.md" <<'EOF'
# Beta Review
Role: beta
LGTM from beta after checking required extension sidecars.
VERDICT: LGTM
EOF
cat > "$HARNESS/nodes/code-review/handshake.json" <<'EOF'
{
  "nodeId": "code-review",
  "nodeType": "review",
  "runId": "run_1",
  "status": "completed",
  "summary": "review complete",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [
    {"type":"eval","path":"run_1/eval-alpha.md"},
    {"type":"eval","path":"run_1/eval-beta.md"}
  ],
  "extensionsApplied": ["non-existent-ext"]
}
EOF
sync_hs
printf '%s\n' '{broken' > "$HARNESS/nodes/code-review/run_1/eval-extensions.json"

OUT_BAD=$(HOME="$TMP/fake-home" node bin/opc-harness.mjs validate-chain --dir "$HARNESS" 2>/dev/null)
BAD_VALID=$(echo "$OUT_BAD" | jq -r '.valid')
BAD_ERROR=$(echo "$OUT_BAD" | jq -r '.errors | join(" ")')
if [ "$BAD_VALID" = "false" ] && [[ "$BAD_ERROR" == *"eval-extensions.json"*parse* ]]; then
  echo "  ✅ malformed extension sidecar fails closed"
  PASS=$((PASS + 1))
else
  echo "  ❌ malformed extension sidecar accepted: $OUT_BAD"
  FAIL=$((FAIL + 1))
fi

cat > "$HARNESS/nodes/code-review/run_1/eval-extensions.json" <<'EOF'
{
  "version": 1,
  "extensionsLoaded": [
    { "name": "non-existent-ext", "enabled": true }
  ],
  "extensionsApplied": ["non-existent-ext"],
  "findings": []
}
EOF
OUT_GOOD=$(HOME="$TMP/fake-home" node bin/opc-harness.mjs validate-chain --dir "$HARNESS" 2>/dev/null)
GOOD_VALID=$(echo "$OUT_GOOD" | jq -r '.valid')
if [ "$GOOD_VALID" = "true" ]; then
  echo "  ✅ canonical sidecar corroborates required participant"
  PASS=$((PASS + 1))
else
  echo "  ❌ canonical sidecar rejected: $OUT_GOOD"
  FAIL=$((FAIL + 1))
fi

# 5b) Canonical handshake runId is authoritative; a newer rogue run cannot corroborate it.
mkdir -p "$HARNESS/nodes/code-review/run_2"
printf '%s\n' '{broken' > "$HARNESS/nodes/code-review/run_1/eval-extensions.json"
cp "$HARNESS/nodes/code-review/run_1/eval-extensions.json" "$HARNESS/nodes/code-review/run_2/ignored-broken.json"
cat > "$HARNESS/nodes/code-review/run_2/eval-extensions.json" <<'EOF'
{
  "version": 1,
  "extensionsApplied": ["non-existent-ext"],
  "findings": []
}
EOF
OUT_BOUND=$(HOME="$TMP/fake-home" node bin/opc-harness.mjs validate-chain --dir "$HARNESS" 2>/dev/null)
BOUND_VALID=$(echo "$OUT_BOUND" | jq -r '.valid')
BOUND_ERROR=$(echo "$OUT_BOUND" | jq -r '.errors | join(" ")')
if [ "$BOUND_VALID" = "false" ] && [[ "$BOUND_ERROR" == *"run_1/eval-extensions.json"*parse* ]]; then
  echo "  ✅ sidecar corroboration is bound to canonical runId"
  PASS=$((PASS + 1))
else
  echo "  ❌ rogue run_2 corroborated run_1: $OUT_BOUND"
  FAIL=$((FAIL + 1))
fi

# 5c) Handshake self-reported nodeType cannot authorize prompt-phase exemption.
python3 - "$HARNESS/nodes/code-review/handshake.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["nodeType"] = "build"
json.dump(data, open(path, "w"))
PY
OUT_TYPE=$(HOME="$TMP/fake-home" node bin/opc-harness.mjs validate-chain --dir "$HARNESS" 2>/dev/null)
TYPE_VALID=$(echo "$OUT_TYPE" | jq -r '.valid')
if [ "$TYPE_VALID" = "false" ]; then
  echo "  ✅ forged nodeType cannot waive review provenance"
  PASS=$((PASS + 1))
else
  echo "  ❌ forged nodeType bypassed provenance: $OUT_TYPE"
  FAIL=$((FAIL + 1))
fi

# 5d) Handshake self-reported nodeId cannot authorize gate exemption.
python3 - "$HARNESS/nodes/code-review/handshake.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["nodeType"] = "review"
data["nodeId"] = "gate"
json.dump(data, open(path, "w"))
PY
OUT_ID=$(HOME="$TMP/fake-home" node bin/opc-harness.mjs validate-chain --dir "$HARNESS" 2>/dev/null)
ID_VALID=$(echo "$OUT_ID" | jq -r '.valid')
if [ "$ID_VALID" = "false" ]; then
  echo "  ✅ forged nodeId cannot waive review provenance"
  PASS=$((PASS + 1))
else
  echo "  ❌ forged nodeId bypassed provenance: $OUT_ID"
  FAIL=$((FAIL + 1))
fi

# 6) Cleanup
rm -rf "$HARNESS"

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

[ "$FAIL" -eq 0 ]
