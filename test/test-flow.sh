#!/bin/bash
# End-to-end tests for opc-harness flow commands
# Covers: route, init, validate, transition, validate-chain, finalize,
#         validate-context, escape hatches (skip, pass, stop, goto), ls
#         eval commands (verify, synthesize, diff, report), viz, replay
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
# Set up review: skip review → gate, skip gate manually
rm -rf .h-fin && $HARNESS init --flow review --dir .h-fin >/dev/null 2>/dev/null
# Write review handshake
mkdir -p .h-fin/nodes/review
cat > .h-fin/nodes/review/handshake.json << 'HS'
{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
sleep 1
# Transition to gate
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .h-fin >/dev/null 2>/dev/null
# Write gate handshake
mkdir -p .h-fin/nodes/gate
cat > .h-fin/nodes/gate/handshake.json << 'HS'
{"nodeId":"gate","nodeType":"gate","runId":"run_1","status":"completed","summary":"passed","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
OUT=$($HARNESS finalize --dir .h-fin)
assert_field_eq "finalized" "$OUT" "finalized" "true"
# Check state.status=completed
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
# Add a fake history entry with missing handshake
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

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 7: escape hatches ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 7.1: skip ---"
rm -rf .h-skip && $HARNESS init --flow build-verify --dir .h-skip >/dev/null 2>/dev/null
OUT=$($HARNESS skip --dir .h-skip 2>/dev/null)
assert_field_eq "skip from build" "$OUT" "skipped" "\"build\""
assert_field_eq "skip to code-review" "$OUT" "next" "\"code-review\""
assert_file_exists "skip handshake" ".h-skip/nodes/build/handshake.json"
# Verify handshake has skipped=true
SKIPPED=$(python3 -c "import json; print(json.load(open('.h-skip/nodes/build/handshake.json')).get('skipped',False))")
if [ "$SKIPPED" = "True" ]; then
  echo "  ✅ handshake.skipped=true"
  PASS=$((PASS + 1))
else
  echo "  ❌ skipped=$SKIPPED"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 7.2: skip terminal node ---"
rm -rf .h-skip2 && $HARNESS init --flow review --entry gate --dir .h-skip2 >/dev/null 2>/dev/null
OUT=$($HARNESS skip --dir .h-skip2 2>/dev/null)
assert_contains "terminal skip blocked" "$OUT" "terminal"

echo ""
echo "--- 7.3: skip no state ---"
rm -rf .h-skip3 && mkdir -p .h-skip3
OUT=$($HARNESS skip --dir .h-skip3 2>/dev/null)
assert_contains "no state" "$OUT" "no flow-state"

echo ""
echo "--- 7.4: pass (gate) ---"
rm -rf .h-pass && $HARNESS init --flow build-verify --entry gate --dir .h-pass >/dev/null 2>/dev/null
OUT=$($HARNESS pass --dir .h-pass 2>/dev/null)
# gate PASS → null (terminal), so should get error
assert_contains "terminal gate" "$OUT" "terminal"

echo ""
echo "--- 7.5: pass (non-gate) ---"
rm -rf .h-pass2 && $HARNESS init --flow build-verify --dir .h-pass2 >/dev/null 2>/dev/null
OUT=$($HARNESS pass --dir .h-pass2 2>/dev/null)
assert_contains "not a gate" "$OUT" "not a gate"

echo ""
echo "--- 7.6: stop ---"
rm -rf .h-stop && $HARNESS init --flow build-verify --dir .h-stop >/dev/null 2>/dev/null
OUT=$($HARNESS stop --dir .h-stop)
assert_field_eq "stopped" "$OUT" "stopped" "true"
STATUS=$(python3 -c "import json; print(json.load(open('.h-stop/flow-state.json'))['status'])")
if [ "$STATUS" = "stopped" ]; then
  echo "  ✅ state.status=stopped"
  PASS=$((PASS + 1))
else
  echo "  ❌ status=$STATUS"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 7.7: stop already completed ---"
OUT=$($HARNESS stop --dir .h-fin)
assert_field_eq "cant stop completed" "$OUT" "stopped" "false"

echo ""
echo "--- 7.8: goto ---"
rm -rf .h-goto && $HARNESS init --flow build-verify --dir .h-goto >/dev/null 2>/dev/null
OUT=$($HARNESS goto test-design --dir .h-goto)
assert_field_eq "goto target" "$OUT" "goto" "\"test-design\""
CUR=$(python3 -c "import json; print(json.load(open('.h-goto/flow-state.json'))['currentNode'])")
if [ "$CUR" = "test-design" ]; then
  echo "  ✅ jumped to test-design"
  PASS=$((PASS + 1))
else
  echo "  ❌ currentNode=$CUR"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 7.9: goto invalid node ---"
OUT=$($HARNESS goto nonexistent --dir .h-goto)
assert_contains "node not found" "$OUT" "not a node"

echo ""
echo "--- 7.10: goto reentry limit ---"
rm -rf .h-reentry && $HARNESS init --flow build-verify --dir .h-reentry >/dev/null 2>/dev/null
# Max reentry is 5 — goto build 5 times then try 6th
for i in 1 2 3 4 5; do
  $HARNESS goto build --dir .h-reentry >/dev/null
done
OUT=$($HARNESS goto build --dir .h-reentry)
assert_contains "reentry limit" "$OUT" "maxNodeReentry"

echo ""
echo "--- 7.11: ls ---"
OUT=$($HARNESS ls --base .)
assert_contains "flows array" "$OUT" "flows"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 8: validate-context ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 8.1: No contextSchema ---"
OUT=$($HARNESS validate-context --flow build-verify --node build --dir .h-init)
assert_field_eq "no schema ok" "$OUT" "valid" "true"

echo ""
echo "--- 8.2: Missing context file ---"
rm -rf .h-ctx && mkdir -p .h-ctx
# Create a state so resolveDir doesn't error (just dir existing is enough)
OUT=$($HARNESS validate-context --flow build-verify --node build --dir .h-ctx)
# build-verify has no contextSchema → valid
assert_field_eq "no schema = valid" "$OUT" "valid" "true"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 9: viz ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 9.1: Viz ASCII ---"
OUT=$($HARNESS viz --flow build-verify)
assert_contains "has build" "$OUT" "build"
assert_contains "has gate" "$OUT" "gate"

echo ""
echo "--- 9.2: Viz JSON ---"
OUT=$($HARNESS viz --flow build-verify --json)
assert_contains "nodes array" "$OUT" "nodes"
assert_contains "loopbacks" "$OUT" "loopbacks"

echo ""
echo "--- 9.3: Viz with state ---"
OUT=$($HARNESS viz --flow build-verify --dir .h-trans)
assert_contains "marker symbols" "$OUT" "✅"

echo ""
echo "--- 9.4: Viz unknown flow ---"
OUT=$($HARNESS viz --flow nonexistent 2>&1) || true
assert_contains "unknown flow" "$OUT" "Unknown"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 10: eval commands ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 10.1: verify ---"
mkdir -p .h-eval
cat > .h-eval/eval.md << 'EVAL'
# Security Review

## Verdict: ITERATE

### Findings

#### 🔴 Critical: SQL injection
- **File:** user.js:42
- **Issue:** Raw SQL query with user input
- **Fix:** Use parameterized queries
- **Reasoning:** Direct string concatenation allows injection

#### 🟡 Warning: Missing rate limiting
- **File:** auth.js:10
- **Issue:** Login endpoint has no rate limit
- **Fix:** Add express-rate-limit middleware
- **Reasoning:** Brute force attacks possible
EVAL
OUT=$($HARNESS verify .h-eval/eval.md)
assert_contains "has verdict" "$OUT" "ITERATE"
assert_contains "critical count" "$OUT" "critical"

echo ""
echo "--- 10.2: synthesize ---"
mkdir -p .h-eval/nodes/code-review/run_1
cat > .h-eval/nodes/code-review/run_1/eval-security.md << 'EVAL'
# Security Review
## Verdict: ITERATE
### Findings
🔴 SQL injection in user.js:10 — missing parameterized query
→ Use prepared statements
Reasoning: Direct string concatenation allows injection
EVAL
cat > .h-eval/nodes/code-review/run_1/eval-perf.md << 'EVAL'
# Performance Review
## Verdict: PASS
### Findings
🔵 Consider caching — response.js:5 — add redis cache layer
EVAL
OUT=$($HARNESS synthesize .h-eval --node code-review)
assert_contains "FAIL verdict" "$OUT" "FAIL"

echo ""
echo "--- 10.3: diff ---"
cat > .h-eval/r1.md << 'EVAL'
# Review Round 1
## Verdict: FAIL
### Findings
🔴 Bug in auth — auth.js:10 — missing null check
→ Add null check before accessing user.id
Reasoning: Crashes on unauthenticated requests
EVAL
cat > .h-eval/r2.md << 'EVAL'
# Review Round 2
## Verdict: PASS
### Findings
No findings.
EVAL
OUT=$($HARNESS diff .h-eval/r1.md .h-eval/r2.md)
assert_contains "resolved count" "$OUT" "resolved"
assert_contains "round1 findings" "$OUT" "round1_findings"

echo ""
echo "--- 10.4: diff unreadable file ---"
OUT=$($HARNESS diff .h-eval/nonexistent.md .h-eval/r2.md)
assert_contains "error on bad file" "$OUT" "Cannot read"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 11: replay ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 11.1: replay data ---"
OUT=$($HARNESS replay --dir .h-fin)
assert_contains "has flowTemplate" "$OUT" "flowTemplate"
assert_contains "has nodes" "$OUT" "nodes"
assert_contains "has history" "$OUT" "history"

echo ""
echo "--- 11.2: replay no state ---"
rm -rf .h-replay-no && mkdir -p .h-replay-no
OUT=$($HARNESS replay --dir .h-replay-no 2>&1) || true
assert_contains "no state" "$OUT" "No flow-state"

# ═══════════════════════════════════════════════════════════════
# Cleanup idea-factory fixture
rm -f "$HOME/.claude/flows/idea-factory.json"

print_results
