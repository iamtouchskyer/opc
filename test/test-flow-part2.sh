#!/bin/bash
# End-to-end tests for opc-harness flow commands — Part 2 (Groups 4-6)
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

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
echo ""
echo "=== TEST GROUP 4: transition ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 4.1: Happy transition ---"
rm -rf .h-trans && $HARNESS init --flow build-verify --dir .h-trans >/dev/null 2>/dev/null
# Write handshake for build node
mkdir -p .h-trans/nodes/build
cat > .h-trans/nodes/build/handshake.json << 'HS'
{
  "nodeId": "build", "nodeType": "build", "runId": "run_1",
  "status": "completed", "summary": "built", "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": []
}
HS
sleep 1
OUT=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .h-trans 2>/dev/null)
assert_field_eq "transition ok" "$OUT" "allowed" "true"
assert_field_eq "next is code-review" "$OUT" "next" "\"code-review\""
# Verify state updated
CUR=$(python3 -c "import json; print(json.load(open('.h-trans/flow-state.json'))['currentNode'])")
if [ "$CUR" = "code-review" ]; then
  echo "  ✅ state.currentNode updated"
  PASS=$((PASS + 1))
else
  echo "  ❌ currentNode=$CUR, expected code-review"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 4.2: Transition from wrong node ---"
OUT=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .h-trans 2>/dev/null)
assert_field_eq "wrong node" "$OUT" "allowed" "false"
assert_contains "not at build" "$OUT" "not 'build'"

echo ""
echo "--- 4.3: Transition invalid edge ---"
OUT=$($HARNESS transition --from code-review --to gate --verdict PASS --flow build-verify --dir .h-trans 2>/dev/null)
assert_field_eq "invalid edge" "$OUT" "allowed" "false"
assert_contains "edge not in flow" "$OUT" "not in flow"

echo ""
echo "--- 4.4: Transition unknown flow ---"
OUT=$($HARNESS transition --from build --to x --verdict PASS --flow nonexistent --dir .h-trans 2>/dev/null)
assert_field_eq "unknown flow" "$OUT" "allowed" "false"

echo ""
echo "--- 4.5: Pre-transition handshake missing ---"
rm -rf .h-trans2 && $HARNESS init --flow build-verify --dir .h-trans2 >/dev/null 2>/dev/null
OUT=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .h-trans2 2>/dev/null)
assert_field_eq "hs missing" "$OUT" "allowed" "false"
assert_contains "handshake missing" "$OUT" "handshake.json missing"

echo ""
echo "--- 4.6: Pre-transition status not completed ---"
rm -rf .h-trans3 && $HARNESS init --flow build-verify --dir .h-trans3 >/dev/null 2>/dev/null
mkdir -p .h-trans3/nodes/build
cat > .h-trans3/nodes/build/handshake.json << 'HS'
{
  "nodeId": "build", "nodeType": "build", "runId": "run_1",
  "status": "failed", "summary": "x", "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": []
}
HS
OUT=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .h-trans3 2>/dev/null)
assert_field_eq "status not completed" "$OUT" "allowed" "false"
assert_contains "expected completed" "$OUT" "expected 'completed'"

echo ""
echo "--- 4.7: Tampered state ---"
rm -rf .h-trans4 && $HARNESS init --flow build-verify --dir .h-trans4 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-trans4/flow-state.json'))
d['_written_by'] = 'evil'
json.dump(d, open('.h-trans4/flow-state.json', 'w'), indent=2)
"
mkdir -p .h-trans4/nodes/build
cat > .h-trans4/nodes/build/handshake.json << 'HS'
{
  "nodeId": "build", "nodeType": "build", "runId": "run_1",
  "status": "completed", "summary": "x", "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": []
}
HS
OUT=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .h-trans4 2>/dev/null)
assert_field_eq "tamper detected" "$OUT" "allowed" "false"
assert_contains "direct edit" "$OUT" "direct edit"

echo ""
echo "--- 4.8: maxTotalSteps limit ---"
rm -rf .h-limit && $HARNESS init --flow review --dir .h-limit >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-limit/flow-state.json'))
d['totalSteps'] = d['maxTotalSteps']
json.dump(d, open('.h-limit/flow-state.json', 'w'), indent=2)
"
mkdir -p .h-limit/nodes/review
cat > .h-limit/nodes/review/handshake.json << 'HS'
{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","summary":"x","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
OUT=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir .h-limit 2>/dev/null)
assert_field_eq "steps limit" "$OUT" "allowed" "false"
assert_contains "maxTotalSteps" "$OUT" "maxTotalSteps"

echo ""
echo "--- 4.9: Gate auto-writes handshake ---"
rm -rf .h-gate && $HARNESS init --flow build-verify --entry gate --dir .h-gate >/dev/null 2>/dev/null
OUT=$($HARNESS transition --from gate --to build --verdict FAIL --flow build-verify --dir .h-gate 2>/dev/null)
assert_field_eq "gate transition ok" "$OUT" "allowed" "true"
assert_file_exists "gate handshake auto-written" ".h-gate/nodes/gate/handshake.json"

echo ""
echo "--- 4.10: Run directory created ---"
assert_file_exists "run_1 dir exists" ".h-gate/nodes/build/run_1"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 5: validate-chain ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 5.1: Valid chain ---"
OUT=$($HARNESS validate-chain --dir .h-trans)
assert_field_eq "chain valid" "$OUT" "valid" "true"

echo ""
echo "--- 5.2: Missing state ---"
rm -rf .h-empty && mkdir -p .h-empty
OUT=$($HARNESS validate-chain --dir .h-empty)
assert_field_eq "no state" "$OUT" "valid" "false"

echo ""
echo "--- 5.3: Corrupt state ---"
rm -rf .h-corrupt && mkdir -p .h-corrupt
echo "not json" > .h-corrupt/flow-state.json
OUT=$($HARNESS validate-chain --dir .h-corrupt)
assert_field_eq "corrupt state" "$OUT" "valid" "false"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 6: finalize ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 6.1: Finalize non-terminal node ---"
OUT=$($HARNESS finalize --dir .h-trans)
assert_field_eq "non-terminal" "$OUT" "finalized" "false"
assert_contains "not terminal" "$OUT" "not a terminal"

echo ""
echo "--- 6.2: Finalize terminal node ---"
rm -rf .h-fin && $HARNESS init --flow review --dir .h-fin >/dev/null 2>/dev/null
mkdir -p .h-fin/nodes/review/run_1
printf '# Review A\nPerspective: Security\nVERDICT: PASS FINDINGS[0]\n' > .h-fin/nodes/review/run_1/eval-a.md
printf '# Review B\nPerspective: Performance\nVERDICT: PASS FINDINGS[0]\n' > .h-fin/nodes/review/run_1/eval-b.md
cat > .h-fin/nodes/review/handshake.json << 'HS'
{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[{"type":"eval","path":"run_1/eval-a.md"},{"type":"eval","path":"run_1/eval-b.md"}]}
HS
sleep 1
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .h-fin >/dev/null 2>/dev/null
mkdir -p .h-fin/nodes/gate
cat > .h-fin/nodes/gate/handshake.json << 'HS'
{"nodeId":"gate","nodeType":"gate","runId":"run_1","status":"completed","summary":"passed","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
OUT=$($HARNESS finalize --dir .h-fin)
assert_field_eq "finalized" "$OUT" "finalized" "true"
STATUS=$(python3 -c "import json; print(json.load(open('.h-fin/flow-state.json'))['status'])")
if [ "$STATUS" = "completed" ]; then
  echo "  ✅ state.status=completed"
  PASS=$((PASS + 1))
else
  echo "  ❌ status=$STATUS"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 6.3: Finalize already finalized ---"
OUT=$($HARNESS finalize --dir .h-fin)
assert_field_eq "already finalized" "$OUT" "finalized" "true"
assert_contains "already note" "$OUT" "already"

echo ""
echo "--- 6.4: Finalize --strict with missing handshake ---"
rm -rf .h-strict && $HARNESS init --flow review --entry gate --dir .h-strict >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-strict/flow-state.json'))
d['history'].append({'nodeId': 'review', 'runId': 'run_1', 'timestamp': '2024-01-01T00:00:00Z'})
json.dump(d, open('.h-strict/flow-state.json', 'w'), indent=2)
"
mkdir -p .h-strict/nodes/gate
cat > .h-strict/nodes/gate/handshake.json << 'HS'
{"nodeId":"gate","nodeType":"gate","runId":"run_1","status":"completed","summary":"x","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
OUT=$($HARNESS finalize --dir .h-strict --strict)
assert_field_eq "strict fails" "$OUT" "finalized" "false"
assert_contains "chain validation" "$OUT" "chain validation"

echo ""
echo "--- 6.5: Finalize no state ---"
rm -rf .h-nostate && mkdir -p .h-nostate
OUT=$($HARNESS finalize --dir .h-nostate)
assert_field_eq "no state" "$OUT" "finalized" "false"

# Cleanup idea-factory fixture
rm -f "$HOME/.claude/flows/idea-factory.json"
print_results
