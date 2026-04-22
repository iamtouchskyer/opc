#!/bin/bash
# End-to-end tests for opc-harness flow commands — Part 1 (Groups 1-3)
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

# Create idea-factory fixture for testing (not a built-in template)
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/idea-factory.json" << 'FIXTURE'
{
  "nodes": ["discover", "validate", "build", "gate", "synthesize", "pitch"],
  "edges": {
    "discover": {"PASS": "validate"},
    "validate": {"PASS": "build"},
    "build": {"PASS": "gate"},
    "gate": {"PASS": "pitch", "FAIL": "synthesize", "ITERATE": "build"},
    "synthesize": {"PASS": "pitch"},
    "pitch": {"PASS": null}
  },
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 15, "maxNodeReentry": 5},
  "nodeTypes": {"discover": "discussion", "validate": "review", "build": "build", "gate": "gate", "synthesize": "discussion", "pitch": "discussion"},
  "softEvidence": true,
  "opc_compat": ">=0.5",
  "contextSchema": {
    "discover": {
      "required": ["topic"],
      "rules": {"topic": "non-empty-string"}
    }
  }
}
FIXTURE

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else json.dumps(v))" 2>/dev/null
}

assert_field_eq() {
  local desc="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(jq_field "$json" "$field")
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — $field: expected $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -q "$pattern"; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — pattern '$pattern' not found"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -q "$pattern"; then
    echo "  ❌ $desc — pattern '$pattern' unexpectedly found"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

assert_file_exists() {
  local desc="$1" path="$2"
  if [ -e "$path" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — not found: $path"
    FAIL=$((FAIL + 1))
  fi
}

# ═══════════════════════════════════════════════════════════════
echo "=== TEST GROUP 1: route ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 1.1: Route happy path ---"
OUT=$($HARNESS route --node build --verdict PASS --flow build-verify)
assert_field_eq "build PASS → code-review" "$OUT" "next" "\"code-review\""
assert_field_eq "valid true" "$OUT" "valid" "true"

echo ""
echo "--- 1.2: Route with FAIL edge ---"
OUT=$($HARNESS route --node gate --verdict FAIL --flow build-verify)
assert_field_eq "gate FAIL → build" "$OUT" "next" "\"build\""

echo ""
echo "--- 1.3: Route unknown flow ---"
OUT=$($HARNESS route --node x --verdict PASS --flow nonexistent)
assert_field_eq "invalid flow" "$OUT" "valid" "false"
assert_contains "explains unknown flow" "$OUT" "unknown flow"

echo ""
echo "--- 1.4: Route unknown node ---"
OUT=$($HARNESS route --node nonexistent --verdict PASS --flow build-verify)
assert_field_eq "unknown node" "$OUT" "valid" "false"
assert_contains "node not in flow" "$OUT" "not in flow"

echo ""
echo "--- 1.5: Route unknown verdict ---"
OUT=$($HARNESS route --node build --verdict ABORT --flow build-verify)
assert_field_eq "bad verdict" "$OUT" "valid" "false"
assert_contains "no edge for verdict" "$OUT" "no edge"

echo ""
echo "--- 1.6: Route terminal node (PASS → null) ---"
OUT=$($HARNESS route --node gate --verdict PASS --flow build-verify)
assert_field_eq "terminal PASS → null" "$OUT" "next" "__NULL__"

echo ""
echo "--- 1.7: Route idea-factory edges ---"
OUT=$($HARNESS route --node gate --verdict PASS --flow idea-factory)
assert_field_eq "gate PASS → pitch" "$OUT" "next" "\"pitch\""
OUT=$($HARNESS route --node gate --verdict ITERATE --flow idea-factory)
assert_field_eq "gate ITERATE → build" "$OUT" "next" "\"build\""
OUT=$($HARNESS route --node gate --verdict FAIL --flow idea-factory)
assert_field_eq "gate FAIL → synthesize" "$OUT" "next" "\"synthesize\""

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 2: init ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 2.1: Init build-verify ---"
rm -rf .h-init && OUT=$($HARNESS init --flow build-verify --dir .h-init 2>/dev/null)
assert_field_eq "created" "$OUT" "created" "true"
assert_field_eq "entry is build" "$OUT" "entry" "\"build\""
assert_file_exists "flow-state.json created" ".h-init/flow-state.json"

echo ""
echo "--- 2.2: Init with custom entry ---"
rm -rf .h-init2 && OUT=$($HARNESS init --flow build-verify --entry code-review --dir .h-init2 2>/dev/null)
assert_field_eq "entry override" "$OUT" "entry" "\"code-review\""

echo ""
echo "--- 2.3: Init rejects bad entry ---"
rm -rf .h-init3 && OUT=$($HARNESS init --flow build-verify --entry nonexistent --dir .h-init3 2>/dev/null)
assert_field_eq "bad entry rejected" "$OUT" "created" "false"

echo ""
echo "--- 2.4: Init rejects duplicate without force ---"
OUT=$($HARNESS init --flow build-verify --dir .h-init 2>/dev/null)
assert_field_eq "rejects dup" "$OUT" "created" "false"
assert_contains "already exists" "$OUT" "already exists"

echo ""
echo "--- 2.5: Init allows force ---"
OUT=$($HARNESS init --flow build-verify --dir .h-init --force 2>/dev/null)
assert_field_eq "force ok" "$OUT" "created" "true"

echo ""
echo "--- 2.6: Init unknown flow ---"
rm -rf .h-init4 && OUT=$($HARNESS init --flow nonexistent --dir .h-init4 2>/dev/null)
assert_field_eq "unknown flow" "$OUT" "created" "false"

echo ""
echo "--- 2.7: Init all built-in flows ---"
for f in build-verify review full-stack pre-release legacy-linear idea-factory; do
  rm -rf ".h-$f" && OUT=$($HARNESS init --flow $f --dir ".h-$f" 2>/dev/null)
  assert_field_eq "init $f" "$OUT" "created" "true"
done

echo ""
echo "--- 2.8: State has write nonce and sig ---"
NONCE=$(python3 -c "import json; d=json.load(open('.h-init/flow-state.json')); print(d.get('_write_nonce','MISSING'))")
SIG=$(python3 -c "import json; d=json.load(open('.h-init/flow-state.json')); print(d.get('_written_by','MISSING'))")
if [ "$SIG" = "opc-harness" ] && [ ${#NONCE} -eq 16 ]; then
  echo "  ✅ state has sig + nonce"
  PASS=$((PASS + 1))
else
  echo "  ❌ sig=$SIG nonce=$NONCE"
  FAIL=$((FAIL + 1))
fi

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 3: validate (handshake) ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 3.1: Valid handshake ---"
mkdir -p .h-val/nodes/build
cat > .h-val/nodes/build/handshake.json << 'HS'
{
  "nodeId": "build",
  "nodeType": "build",
  "runId": "run_1",
  "status": "completed",
  "summary": "Built feature X",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [],
  "verdict": null
}
HS
OUT=$($HARNESS validate .h-val/nodes/build/handshake.json)
assert_field_eq "valid handshake" "$OUT" "valid" "true"

echo ""
echo "--- 3.2: Invalid handshake (missing fields) ---"
cat > .h-val/bad.json << 'HS'
{"nodeId": "x"}
HS
OUT=$($HARNESS validate .h-val/bad.json)
assert_field_eq "invalid handshake" "$OUT" "valid" "false"
assert_contains "lists missing fields" "$OUT" "nodeType"

echo ""
echo "--- 3.3: Invalid nodeType ---"
cat > .h-val/bad2.json << 'HS'
{
  "nodeId": "x", "nodeType": "invalid-type", "runId": "run_1",
  "status": "completed", "summary": "x", "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": []
}
HS
OUT=$($HARNESS validate .h-val/bad2.json)
assert_field_eq "bad nodeType" "$OUT" "valid" "false"
assert_contains "invalid nodeType" "$OUT" "invalid nodeType"

echo ""
echo "--- 3.4: Invalid status ---"
cat > .h-val/bad3.json << 'HS'
{
  "nodeId": "x", "nodeType": "build", "runId": "run_1",
  "status": "running", "summary": "x", "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": []
}
HS
OUT=$($HARNESS validate .h-val/bad3.json)
assert_contains "bad status" "$OUT" "invalid status"

echo ""
echo "--- 3.5: Invalid verdict ---"
cat > .h-val/bad4.json << 'HS'
{
  "nodeId": "x", "nodeType": "build", "runId": "run_1",
  "status": "completed", "summary": "x", "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [], "verdict": "MAYBE"
}
HS
OUT=$($HARNESS validate .h-val/bad4.json)
assert_contains "bad verdict" "$OUT" "invalid verdict"

echo ""
echo "--- 3.6: Executor missing evidence ---"
cat > .h-val/exec.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "summary": "ran tests", "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "report", "path": "report.md"}]
}
HS
OUT=$($HARNESS validate .h-val/exec.json)
assert_contains "evidence required" "$OUT" "evidence"

echo ""
echo "--- 3.7: Unparseable file ---"
echo "not json" > .h-val/broken.json
OUT=$($HARNESS validate .h-val/broken.json)
assert_contains "parse error" "$OUT" "cannot read"

echo ""
echo "--- 3.8: Findings critical with PASS verdict ---"
cat > .h-val/conflict.json << 'HS'
{
  "nodeId": "x", "nodeType": "review", "runId": "run_1",
  "status": "completed", "summary": "x", "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [], "verdict": "PASS",
  "findings": {"critical": 2, "warning": 0}
}
HS
OUT=$($HARNESS validate .h-val/conflict.json)
assert_contains "critical+PASS conflict" "$OUT" "findings.critical"

echo ""
echo "--- 3.9: Loopback validation ---"
cat > .h-val/loop.json << 'HS'
{
  "nodeId": "x", "nodeType": "gate", "runId": "run_1",
  "status": "completed", "summary": "x", "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [], "loopback": {"iteration": 1}
}
HS
OUT=$($HARNESS validate .h-val/loop.json)
assert_contains "loopback.from required" "$OUT" "loopback.from"

# Cleanup idea-factory fixture
rm -f "$HOME/.claude/flows/idea-factory.json"
print_results
