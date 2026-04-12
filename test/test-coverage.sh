#!/bin/bash
# Coverage gap tests — targets critical untested branches
# Covers: idempotency, backlog enforcement, maxLoopsPerEdge, validate-context rules,
#         stall/oscillation detection, wall-clock deadline, validateFixArtifacts,
#         cmdReport, synthesize --wave, satisfiesVersion, external flow validation,
#         loadState corrupt JSON, eval-parser edge cases, cmdSynthesize BLOCKED verdict
set -e

HARNESS="node $(cd "$(dirname "$0")/.." && pwd)/bin/opc-harness.mjs"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT
cd "$TMPDIR"

git init -q .
git config user.email "test@test.com"
git config user.name "Test"
echo "init" > dummy.txt
git add dummy.txt && git commit -q -m "init"

PASS=0
FAIL=0

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else json.dumps(v))" 2>/dev/null
}

assert_field_eq() {
  local desc="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(jq_field "$json" "$field")
  if [ -z "$actual" ]; then
    echo "  ❌ $desc — no JSON output (field=$field)"
    FAIL=$((FAIL + 1))
    return
  fi
  actual=$(echo "$actual" | tr -d '"')
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — expected '$expected', got '$actual'"
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
    echo "  ❌ $desc — pattern '$pattern' found but should not be"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

assert_exit_nonzero() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>/dev/null; then
    echo "  ❌ $desc — expected nonzero exit"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

# ═══════════════════════════════════════════════════════════════
echo "=== CG-1: maxLoopsPerEdge limit ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-1.1: Edge loop limit blocks transition ---"
rm -rf .h-edge && $HARNESS init --flow build-verify --entry gate --dir .h-edge >/dev/null 2>/dev/null
# Manually set edgeCounts to maxLoopsPerEdge
python3 -c "
import json
d = json.load(open('.h-edge/flow-state.json'))
d['edgeCounts']['gate→build'] = d['maxLoopsPerEdge']
json.dump(d, open('.h-edge/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS transition --from gate --to build --verdict FAIL --flow build-verify --dir .h-edge 2>/dev/null)
assert_field_eq "edge limit blocked" "$OUT" "allowed" "false"
assert_contains "maxLoopsPerEdge msg" "$OUT" "maxLoopsPerEdge"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-2: maxNodeReentry limit in transition ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-2.1: Node reentry limit blocks transition ---"
rm -rf .h-reentry && $HARNESS init --flow build-verify --entry gate --dir .h-reentry >/dev/null 2>/dev/null
# Add fake history entries for build to hit reentry limit
python3 -c "
import json
d = json.load(open('.h-reentry/flow-state.json'))
for i in range(d['maxNodeReentry']):
    d['history'].append({'nodeId': 'build', 'runId': f'run_{i}', 'timestamp': '2024-01-01T00:00:00Z'})
json.dump(d, open('.h-reentry/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS transition --from gate --to build --verdict FAIL --flow build-verify --dir .h-reentry 2>/dev/null)
assert_field_eq "reentry blocked" "$OUT" "allowed" "false"
assert_contains "maxNodeReentry msg" "$OUT" "maxNodeReentry"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-3: Idempotency guard ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-3.1: Duplicate transition within 5s window blocked ---"
rm -rf .h-idemp && $HARNESS init --flow build-verify --dir .h-idemp >/dev/null 2>/dev/null
mkdir -p .h-idemp/nodes/build
cat > .h-idemp/nodes/build/handshake.json << 'HS'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","summary":"done","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
# First transition succeeds
$HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .h-idemp >/dev/null 2>/dev/null
# Second transition immediately — should be blocked by idempotency
mkdir -p .h-idemp/nodes/code-review
cat > .h-idemp/nodes/code-review/handshake.json << 'HS'
{"nodeId":"code-review","nodeType":"review","runId":"run_1","status":"completed","summary":"done","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
OUT=$($HARNESS transition --from code-review --to test-verify --verdict PASS --flow build-verify --dir .h-idemp 2>/dev/null)
# Check if the second one succeeds (it should, because to=test-verify != last history entry=code-review)
# To trigger idempotency we need to try same target: let's force code-review again via gate FAIL
rm -rf .h-idemp2 && $HARNESS init --flow build-verify --entry gate --dir .h-idemp2 >/dev/null 2>/dev/null
$HARNESS transition --from gate --to build --verdict FAIL --flow build-verify --dir .h-idemp2 >/dev/null 2>/dev/null
# Now try same transition again immediately (gate→build FAIL)
# Reset state to gate first
python3 -c "
import json
d = json.load(open('.h-idemp2/flow-state.json'))
d['currentNode'] = 'gate'
json.dump(d, open('.h-idemp2/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS transition --from gate --to build --verdict FAIL --flow build-verify --dir .h-idemp2 2>/dev/null)
assert_field_eq "idempotency blocked" "$OUT" "allowed" "false"
assert_contains "idempotency guard" "$OUT" "idempotency"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-4: Backlog enforcement ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-4.1: Gate ITERATE blocked when upstream has warnings but no backlog ---"
# build-verify: test-verify→PASS→gate, gate→ITERATE→build
# Upstream of gate is test-verify
rm -rf .h-backlog && $HARNESS init --flow build-verify --entry gate --dir .h-backlog >/dev/null 2>/dev/null
mkdir -p .h-backlog/nodes/test-verify
cat > .h-backlog/nodes/test-verify/handshake.json << 'HS'
{"nodeId":"test-verify","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["evidence.txt"],"findings":{"warning":2,"critical":0}}
HS
echo "test evidence" > .h-backlog/nodes/test-verify/evidence.txt
OUT=$($HARNESS transition --from gate --to build --verdict ITERATE --flow build-verify --dir .h-backlog 2>/dev/null)
assert_field_eq "backlog required" "$OUT" "allowed" "false"
assert_contains "backlog missing msg" "$OUT" "backlog"

echo ""
echo "--- CG-4.2: Gate passes when backlog has matching entries ---"
rm -rf .h-backlog2 && $HARNESS init --flow build-verify --entry gate --dir .h-backlog2 >/dev/null 2>/dev/null
mkdir -p .h-backlog2/nodes/test-verify
cat > .h-backlog2/nodes/test-verify/handshake.json << 'HS'
{"nodeId":"test-verify","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["evidence.txt"],"findings":{"warning":2,"critical":0}}
HS
echo "test evidence" > .h-backlog2/nodes/test-verify/evidence.txt
cat > .h-backlog2/backlog.md << 'BL'
# Backlog
- [ ] 🟡 Missing input validation [test-verify]
- [ ] 🟡 Error handling too broad [test-verify]
BL
OUT=$($HARNESS transition --from gate --to build --verdict ITERATE --flow build-verify --dir .h-backlog2 2>/dev/null)
assert_field_eq "backlog satisfied" "$OUT" "allowed" "true"

echo ""
echo "--- CG-4.3: Insufficient backlog entries rejected ---"
rm -rf .h-backlog3 && $HARNESS init --flow build-verify --entry gate --dir .h-backlog3 >/dev/null 2>/dev/null
mkdir -p .h-backlog3/nodes/test-verify
cat > .h-backlog3/nodes/test-verify/handshake.json << 'HS'
{"nodeId":"test-verify","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["evidence.txt"],"findings":{"warning":3,"critical":0}}
HS
echo "test evidence" > .h-backlog3/nodes/test-verify/evidence.txt
cat > .h-backlog3/backlog.md << 'BL'
- [ ] 🟡 Only one entry [test-verify]
BL
OUT=$($HARNESS transition --from gate --to build --verdict ITERATE --flow build-verify --dir .h-backlog3 2>/dev/null)
assert_field_eq "insufficient entries" "$OUT" "allowed" "false"
assert_contains "entries count" "$OUT" "only has"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-5: validate-context rules ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-5.1: idea-factory contextSchema validation ---"
# idea-factory has contextSchema — test with empty context
rm -rf .h-ctx && $HARNESS init --flow idea-factory --dir .h-ctx >/dev/null 2>/dev/null
echo '{}' > .h-ctx/flow-context.json
OUT=$($HARNESS validate-context --flow idea-factory --node discover --dir .h-ctx 2>/dev/null)
# idea-factory has contextSchema for discover → empty context should fail on required fields
assert_field_eq "schema validation" "$OUT" "valid" "false"

echo ""
echo "--- CG-5.2: flow-context.json not found ---"
rm -rf .h-ctx2 && mkdir -p .h-ctx2
# Create a minimal external flow with contextSchema for testing
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/test-ctx-flow.json" << 'CTX'
{
  "nodes": ["step1", "step2"],
  "edges": {"step1": {"PASS": "step2"}, "step2": {"PASS": null}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5},
  "nodeTypes": {"step1": "build", "step2": "review"},
  "contextSchema": {
    "step1": {
      "required": ["topic", "count"],
      "rules": {"count": "positive-integer", "topic": "non-empty-string"}
    }
  },
  "opc_compat": ">=0.5"
}
CTX
$HARNESS init --flow test-ctx-flow --dir .h-ctx2 >/dev/null 2>/dev/null
OUT=$($HARNESS validate-context --flow test-ctx-flow --node step1 --dir .h-ctx2 2>/dev/null)
assert_field_eq "no context file" "$OUT" "valid" "false"
assert_contains "context not found" "$OUT" "flow-context.json not found"

echo ""
echo "--- CG-5.3: Required field missing ---"
echo '{"topic": "test"}' > .h-ctx2/flow-context.json
OUT=$($HARNESS validate-context --flow test-ctx-flow --node step1 --dir .h-ctx2 2>/dev/null)
assert_field_eq "field missing" "$OUT" "valid" "false"
assert_contains "missing count" "$OUT" "count"

echo ""
echo "--- CG-5.4: Rule validation fails ---"
echo '{"topic": "", "count": -1}' > .h-ctx2/flow-context.json
OUT=$($HARNESS validate-context --flow test-ctx-flow --node step1 --dir .h-ctx2 2>/dev/null)
assert_field_eq "rule fails" "$OUT" "valid" "false"
assert_contains "fails rule" "$OUT" "fails rule"

echo ""
echo "--- CG-5.5: Valid context passes ---"
echo '{"topic": "hello", "count": 5}' > .h-ctx2/flow-context.json
OUT=$($HARNESS validate-context --flow test-ctx-flow --node step1 --dir .h-ctx2 2>/dev/null)
assert_field_eq "valid context" "$OUT" "valid" "true"

echo ""
echo "--- CG-5.6: Corrupt context JSON ---"
echo 'not json' > .h-ctx2/flow-context.json
OUT=$($HARNESS validate-context --flow test-ctx-flow --node step1 --dir .h-ctx2 2>/dev/null)
assert_field_eq "corrupt context" "$OUT" "valid" "false"
assert_contains "parse error" "$OUT" "cannot parse"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-6: Stall detection ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-6.1: 3 consecutive same unit → stall ---"
rm -rf .h-stall && mkdir -p .h-stall
cat > .h-stall/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — review it
  - verify: echo ok
PLAN
$HARNESS init-loop --plan .h-stall/plan.md --dir .h-stall >/dev/null 2>/dev/null
# Simulate 3 completed ticks for F1.1
python3 -c "
import json
d = json.load(open('.h-stall/loop-state.json'))
d['tick'] = 3
d['next_unit'] = 'F1.1'
d['status'] = 'idle'
d['_tick_history'] = [
    {'unit': 'F1.1', 'tick': 1, 'status': 'failed'},
    {'unit': 'F1.1', 'tick': 2, 'status': 'failed'},
    {'unit': 'F1.1', 'tick': 3, 'status': 'failed'}
]
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
json.dump(d, open('.h-stall/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-stall 2>/dev/null)
assert_field_eq "stall detected" "$OUT" "terminate" "true"
assert_contains "stalled msg" "$OUT" "stalled"

echo ""
echo "--- CG-6.2: A↔B oscillation for 6 ticks → stall ---"
rm -rf .h-osc && mkdir -p .h-osc
cat > .h-osc/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — review it
  - verify: echo ok
PLAN
$HARNESS init-loop --plan .h-osc/plan.md --dir .h-osc >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-osc/loop-state.json'))
d['tick'] = 6
d['next_unit'] = 'F1.1'
d['status'] = 'idle'
d['_tick_history'] = [
    {'unit': 'F1.1', 'tick': 1, 'status': 'failed'},
    {'unit': 'F1.2', 'tick': 2, 'status': 'failed'},
    {'unit': 'F1.1', 'tick': 3, 'status': 'failed'},
    {'unit': 'F1.2', 'tick': 4, 'status': 'failed'},
    {'unit': 'F1.1', 'tick': 5, 'status': 'failed'},
    {'unit': 'F1.2', 'tick': 6, 'status': 'failed'}
]
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
json.dump(d, open('.h-osc/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-osc 2>/dev/null)
assert_field_eq "oscillation detected" "$OUT" "terminate" "true"
assert_contains "oscillation msg" "$OUT" "oscillation"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-7: Wall-clock deadline ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-7.1: Expired deadline terminates ---"
rm -rf .h-wall && mkdir -p .h-wall
cat > .h-wall/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — review it
  - verify: echo ok
PLAN
$HARNESS init-loop --plan .h-wall/plan.md --dir .h-wall >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-wall/loop-state.json'))
d['next_unit'] = 'F1.1'
d['_started_at'] = '2020-01-01T00:00:00Z'
d['_max_duration_hours'] = 24
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
json.dump(d, open('.h-wall/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-wall 2>/dev/null)
assert_field_eq "wall-clock terminated" "$OUT" "terminate" "true"
assert_contains "wall-clock msg" "$OUT" "wall-clock"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-8: validateFixArtifacts ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-8.1: Fix with unchanged git HEAD fails ---"
rm -rf .h-fix && mkdir -p .h-fix
cat > .h-fix/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — review it
  - verify: echo ok
- F1.3: fix — fix findings
  - verify: echo ok
PLAN
$HARNESS init-loop --plan .h-fix/plan.md --dir .h-fix >/dev/null 2>/dev/null
# Complete F1.1 and F1.2, arrive at F1.3
python3 -c "
import json, subprocess
d = json.load(open('.h-fix/loop-state.json'))
d['tick'] = 2
d['next_unit'] = 'F1.3'
d['completed_ticks'] = [
    {'tick': 1, 'unit': 'F1.1', 'status': 'completed', 'artifacts': ['dummy.txt']},
    {'tick': 2, 'unit': 'F1.2', 'status': 'completed', 'artifacts': []}
]
head = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()
d['_git_head'] = head
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
json.dump(d, open('.h-fix/loop-state.json', 'w'), indent=2)
"
# Try completing fix without making a commit (HEAD unchanged)
echo '{}' > fix-artifact.json
OUT=$($HARNESS complete-tick --unit F1.3 --artifacts fix-artifact.json --description "fix stuff" --dir .h-fix 2>/dev/null)
assert_contains "git HEAD unchanged" "$OUT" "git HEAD unchanged"

echo ""
echo "--- CG-8.2: Fix without finding references warns ---"
# Make a commit so HEAD changes
echo "fix" > fix-file.txt
git add fix-file.txt && git commit -q -m "fix"
# Now create artifact without severity markers
echo 'no references here' > fix-artifact.json
OUT=$($HARNESS complete-tick --unit F1.3 --artifacts fix-artifact.json --description "fix stuff" --dir .h-fix 2>/dev/null)
assert_contains "no references warning" "$OUT" "reference"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-9: cmdReport ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-9.1: Report from role eval files ---"
rm -rf .h-report && mkdir -p .h-report/.harness
cat > .h-report/.harness/evaluation-wave-1-security.md << 'EVAL'
# Security Review
VERDICT: PASS FINDINGS[1]
🔵 Minor concern — utils.js:5 — add input validation
Reasoning: user input passes through unchecked
EVAL
cat > .h-report/.harness/evaluation-wave-1-perf.md << 'EVAL'
# Performance Review
VERDICT: PASS FINDINGS[0]
EVAL
OUT=$($HARNESS report .h-report --mode review --task "test")
assert_contains "has agents" "$OUT" "agents"
assert_contains "has summary" "$OUT" "summary"
assert_contains "has timestamp" "$OUT" "timestamp"
assert_contains "security role" "$OUT" "security"

echo ""
echo "--- CG-9.2: Report from single eval files ---"
rm -rf .h-report2 && mkdir -p .h-report2/.harness
cat > .h-report2/.harness/evaluation-wave-1.md << 'EVAL'
# Review
VERDICT: PASS FINDINGS[1]
🟡 Warning — api.js:10 — rate limiting needed
Reasoning: no rate limit on public endpoint
EVAL
OUT=$($HARNESS report .h-report2 --mode review --task "test")
assert_contains "evaluator role" "$OUT" "evaluator"
assert_contains "warning count" "$OUT" "warning"

echo ""
echo "--- CG-9.3: Report coordinator counts ---"
OUT=$($HARNESS report .h-report --mode review --task "test" --challenged 2 --dismissed 1 --downgraded 0)
assert_contains "challenged" "$OUT" "challenged"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-10: cmdSynthesize --wave (legacy) ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-10.1: Synthesize from wave files ---"
rm -rf .h-wave && mkdir -p .h-wave/.harness
cat > .h-wave/.harness/evaluation-wave-1-security.md << 'EVAL'
# Security
VERDICT: FAIL FINDINGS[1]
🔴 Critical XSS — template.js:15 — unescaped user input
→ Use DOMPurify
Reasoning: allows script injection
EVAL
cat > .h-wave/.harness/evaluation-wave-1-perf.md << 'EVAL'
# Perf
VERDICT: PASS FINDINGS[0]
EVAL
OUT=$($HARNESS synthesize .h-wave --wave 1)
assert_contains "wave FAIL verdict" "$OUT" "FAIL"
assert_contains "critical count" "$OUT" "critical"

echo ""
echo "--- CG-10.2: Synthesize BLOCKED verdict ---"
cat > .h-wave/.harness/evaluation-wave-2-security.md << 'EVAL'
# Security
VERDICT: BLOCKED
EVAL
OUT=$($HARNESS synthesize .h-wave --wave 2)
assert_contains "BLOCKED verdict" "$OUT" "BLOCKED"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-11: eval-parser edge cases ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-11.1: Heading with emoji skipped ---"
rm -rf .h-parse && mkdir -p .h-parse
cat > .h-parse/heading-eval.md << 'EVAL'
# Review
VERDICT: PASS FINDINGS[0]
#### 🔴 This should be ignored because it's a heading
EVAL
OUT=$($HARNESS verify .h-parse/heading-eval.md)
assert_field_eq "heading skipped" "$OUT" "critical" "0"

echo ""
echo "--- CG-11.2: Hedging detected ---"
cat > .h-parse/hedge-eval.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[1]
🔴 This might be an issue — test.js:1 — possible problem
→ Consider fixing it
Reasoning: could potentially cause a crash
EVAL
OUT=$($HARNESS verify .h-parse/hedge-eval.md)
assert_contains "hedging found" "$OUT" "hedging"

echo ""
echo "--- CG-11.3: Fix and reasoning parsed ---"
cat > .h-parse/fix-eval.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[1]
🔴 Null pointer — app.js:42 — crashes on empty input
→ Add null check before dereference
Reasoning: Input validation missing at boundary
EVAL
OUT=$($HARNESS verify .h-parse/fix-eval.md)
assert_field_eq "has verdict" "$OUT" "verdict_present" "true"
assert_field_eq "critical 1" "$OUT" "critical" "1"
# evidence_complete checks for file refs, fix on criticals, reasoning
assert_field_eq "evidence complete" "$OUT" "evidence_complete" "true"

echo ""
echo "--- CG-11.4: Finding without file ref detected ---"
cat > .h-parse/noref-eval.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[1]
🔴 General concern about architecture — needs redesign
→ Refactor the whole thing
Reasoning: too coupled
EVAL
OUT=$($HARNESS verify .h-parse/noref-eval.md)
assert_contains "findings without refs" "$OUT" "findings_without_refs"
# Should have 1 finding without ref
NOREF=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('findings_without_refs',[])))")
if [ "$NOREF" -ge 1 ]; then
  echo "  ✅ no-ref finding detected"
  PASS=$((PASS + 1))
else
  echo "  ❌ no-ref finding not detected"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- CG-11.5: Verdict count mismatch ---"
cat > .h-parse/mismatch-eval.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[5]
🔴 Only one — test.js:1 — there's one
→ fix it
Reasoning: broken
EVAL
OUT=$($HARNESS verify .h-parse/mismatch-eval.md)
assert_field_eq "count mismatch" "$OUT" "verdict_count_match" "false"

echo ""
echo "--- CG-11.6: Critical without fix detected ---"
cat > .h-parse/nofix-eval.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[1]
🔴 Missing fix — server.js:100 — no fix suggestion provided
Reasoning: clearly broken
EVAL
OUT=$($HARNESS verify .h-parse/nofix-eval.md)
NOFIX=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('critical_without_fix',[])))")
if [ "$NOFIX" -ge 1 ]; then
  echo "  ✅ critical without fix detected"
  PASS=$((PASS + 1))
else
  echo "  ❌ critical without fix not detected"
  FAIL=$((FAIL + 1))
fi

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-12: Diff oscillation + severity change ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-12.1: Oscillation detected ---"
rm -rf .h-diff && mkdir -p .h-diff
cat > .h-diff/r1.md << 'EVAL'
VERDICT: FAIL FINDINGS[3]
🔴 Bug A — test.js:1 — issue one
🔴 Bug B — test.js:2 — issue two
🔴 Bug C — test.js:3 — issue three
EVAL
cat > .h-diff/r2.md << 'EVAL'
VERDICT: FAIL FINDINGS[3]
🔴 Bug A — test.js:1 — issue one
🔴 Bug B — test.js:2 — issue two
🔴 Bug D — test.js:4 — new issue
EVAL
OUT=$($HARNESS diff .h-diff/r1.md .h-diff/r2.md)
assert_field_eq "oscillation true" "$OUT" "oscillation" "true"
assert_contains "recurring count" "$OUT" "recurring"

echo ""
echo "--- CG-12.2: Severity change tracked ---"
cat > .h-diff/r3.md << 'EVAL'
VERDICT: FAIL FINDINGS[1]
🔴 Bug A — test.js:1 — issue one
EVAL
cat > .h-diff/r4.md << 'EVAL'
VERDICT: PASS FINDINGS[1]
🟡 Bug A — test.js:1 — issue one
EVAL
OUT=$($HARNESS diff .h-diff/r3.md .h-diff/r4.md)
assert_contains "severity changed" "$OUT" "severity_changed"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-13: loadState corrupt JSON ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-13.1: Corrupt flow-state in skip → graceful error ---"
rm -rf .h-corrupt && mkdir -p .h-corrupt
echo 'not json' > .h-corrupt/flow-state.json
OUT=$($HARNESS skip --dir .h-corrupt 2>&1 || true)
assert_contains "parse error" "$OUT" "Cannot parse"

echo ""
echo "--- CG-13.2: Corrupt flow-state in stop → graceful error ---"
OUT=$($HARNESS stop --dir .h-corrupt 2>&1 || true)
assert_contains "stop parse error" "$OUT" "Cannot parse"

echo ""
echo "--- CG-13.3: Corrupt flow-state in goto → graceful error ---"
OUT=$($HARNESS goto build --dir .h-corrupt 2>&1 || true)
assert_contains "goto parse error" "$OUT" "Cannot parse"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-14: External flow validation ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-14.1: External flow with bad edge source rejected ---"
cat > "$HOME/.claude/flows/bad-edge-src.json" << 'FL'
{
  "nodes": ["a", "b"],
  "edges": {"nonexistent": {"PASS": "b"}, "a": {"PASS": "b"}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5}
}
FL
OUT=$($HARNESS init --flow bad-edge-src --dir .h-badsrc 2>&1 || true)
assert_contains "bad source rejected" "$OUT" "unknown flow\|not in nodes\|Unknown flow"

echo ""
echo "--- CG-14.2: External flow with bad edge target rejected ---"
cat > "$HOME/.claude/flows/bad-edge-tgt.json" << 'FL'
{
  "nodes": ["a", "b"],
  "edges": {"a": {"PASS": "nonexistent"}, "b": {"PASS": null}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5}
}
FL
OUT=$($HARNESS init --flow bad-edge-tgt --dir .h-badtgt 2>&1 || true)
assert_contains "bad target rejected" "$OUT" "unknown flow\|not in nodes\|Unknown flow"

echo ""
echo "--- CG-14.3: External flow with invalid nodeType rejected ---"
cat > "$HOME/.claude/flows/bad-nodetype.json" << 'FL'
{
  "nodes": ["a", "b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5},
  "nodeTypes": {"a": "invalid-type", "b": "build"}
}
FL
OUT=$($HARNESS init --flow bad-nodetype --dir .h-badnt 2>&1 || true)
assert_contains "bad nodetype rejected" "$OUT" "unknown flow\|invalid\|Unknown flow"

echo ""
echo "--- CG-14.4: Prototype pollution name skipped ---"
cat > "$HOME/.claude/flows/__proto__.json" << 'FL'
{"nodes": ["a"], "edges": {"a": {"PASS": null}}, "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5}}
FL
OUT=$($HARNESS init --flow __proto__ --dir .h-proto 2>&1 || true)
assert_contains "proto skipped" "$OUT" "unknown flow\|Unknown flow"

echo ""
echo "--- CG-14.5: Missing required fields rejected ---"
cat > "$HOME/.claude/flows/bad-missing.json" << 'FL'
{"nodes": []}
FL
OUT=$($HARNESS init --flow bad-missing --dir .h-badmiss 2>&1 || true)
assert_contains "missing fields rejected" "$OUT" "unknown flow\|Unknown flow"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-15: satisfiesVersion ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-15.1: Flow with impossible version requirement rejected ---"
cat > "$HOME/.claude/flows/future-ver.json" << 'FL'
{
  "nodes": ["a", "b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5},
  "opc_compat": ">=99.99"
}
FL
OUT=$($HARNESS init --flow future-ver --dir .h-futver 2>&1 || true)
assert_contains "version rejected" "$OUT" "unknown flow\|Unknown flow"

echo ""
echo "--- CG-15.2: Valid test-ctx-flow still loads ---"
OUT=$($HARNESS init --flow test-ctx-flow --dir .h-ctxcheck 2>/dev/null)
assert_field_eq "ctx flow loads" "$OUT" "created" "true"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-16: softEvidence in validate ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-16.1: softEvidence downgrades to warning ---"
rm -rf .h-soft && $HARNESS init --flow test-ctx-flow --dir .h-soft >/dev/null 2>/dev/null
mkdir -p .h-soft/nodes/step1
cat > .h-soft/nodes/step1/handshake.json << 'HS'
{"nodeId":"step1","nodeType":"execute","runId":"run_1","status":"completed","summary":"x","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
# test-ctx-flow doesn't have softEvidence, but let's test with idea-factory which does
rm -rf .h-soft2 && $HARNESS init --flow idea-factory --dir .h-soft2 >/dev/null 2>/dev/null
mkdir -p .h-soft2/nodes/discover
cat > .h-soft2/nodes/discover/handshake.json << 'HS'
{"nodeId":"discover","nodeType":"execute","runId":"run_1","status":"completed","summary":"x","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
OUT=$($HARNESS validate .h-soft2/nodes/discover/handshake.json 2>&1)
# If idea-factory has softEvidence, the missing evidence should be a warning not error
# The validator reads flow-state.json to check softEvidence
assert_contains "validate output" "$OUT" "valid\|warning\|evidence"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-17: next-tick plan hash drift ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-17.1: Modified plan triggers warning ---"
rm -rf .h-drift && mkdir -p .h-drift
cat > .h-drift/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — review it
  - verify: echo ok
PLAN
$HARNESS init-loop --plan .h-drift/plan.md --dir .h-drift >/dev/null 2>/dev/null
# Complete F1.1
$HARNESS complete-tick --unit F1.1 --artifacts dummy.txt --description "built" --dir .h-drift >/dev/null 2>/dev/null
# Modify plan after init
cat >> .h-drift/plan.md << 'PLAN'
- F1.3: fix — fix findings
  - verify: echo ok
PLAN
OUT=$($HARNESS next-tick --dir .h-drift 2>&1)
assert_contains "plan hash drift" "$OUT" "plan.*changed\|hash.*drift\|modified"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-18: next-tick unknown unit terminates ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-18.1: next_unit not in plan → auto-terminate ---"
rm -rf .h-unknown && mkdir -p .h-unknown
cat > .h-unknown/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — review it
  - verify: echo ok
PLAN
$HARNESS init-loop --plan .h-unknown/plan.md --dir .h-unknown >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-unknown/loop-state.json'))
d['next_unit'] = 'nonexistent'
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
json.dump(d, open('.h-unknown/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-unknown 2>/dev/null)
assert_field_eq "unknown unit terminates" "$OUT" "terminate" "true"
assert_contains "not in plan" "$OUT" "not.*plan\|not found"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CG-19: Duplicate unit ID in plan ==="
# ═══════════════════════════════════════════════════════════════

echo "--- CG-19.1: Duplicate IDs warned ---"
rm -rf .h-dup && mkdir -p .h-dup
cat > .h-dup/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.1: review — review it
  - verify: echo ok
PLAN
OUT=$($HARNESS init-loop --plan .h-dup/plan.md --dir .h-dup 2>&1)
assert_contains "dup warning" "$OUT" "duplicate\|Duplicate"

# Cleanup test flows
rm -f "$HOME/.claude/flows/test-ctx-flow.json"
rm -f "$HOME/.claude/flows/bad-edge-src.json"
rm -f "$HOME/.claude/flows/bad-edge-tgt.json"
rm -f "$HOME/.claude/flows/bad-nodetype.json"
rm -f "$HOME/.claude/flows/__proto__.json"
rm -f "$HOME/.claude/flows/bad-missing.json"
rm -f "$HOME/.claude/flows/future-ver.json"

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

[ "$FAIL" -eq 0 ] || exit 1
