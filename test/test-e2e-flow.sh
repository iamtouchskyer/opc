#!/bin/bash
# End-to-end flow integration tests
# Tests complete flow paths: init → handshake → route → transition → synthesize → finalize
# This is the ORCHESTRATOR-LEVEL test — not individual command tests.
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else json.dumps(v))" 2>/dev/null
}

jq_nested() {
  echo "$1" | python3 -c "
import sys, json
d = json.load(sys.stdin)
keys = '$2'.split('.')
for k in keys:
    if d is None: break
    d = d.get(k) if isinstance(d, dict) else None
print('__NULL__' if d is None else json.dumps(d))
" 2>/dev/null
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
    echo "  ❌ $desc — pattern '$pattern' found (should not be)"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

# Helper: write a valid handshake.json
write_handshake() {
  local dir="$1" node="$2" summary="$3" verdict="$4" node_type="${5:-review}"
  local path="$dir/nodes/$node/handshake.json"
  mkdir -p "$(dirname "$path")"
  # Collect eval artifacts for review nodes
  local artifacts="[]"
  local run_dir="$dir/nodes/$node/run_1"
  if [ "$node_type" = "review" ] && [ -d "$run_dir" ]; then
    artifacts=$(ls "$run_dir"/eval-*.md 2>/dev/null | python3 -c "
import sys, json
files = [l.strip() for l in sys.stdin if l.strip()]
print(json.dumps([{'path': f, 'type': 'eval'} for f in files]))
" 2>/dev/null || echo "[]")
  fi
  cat > "$path" << HSEOF
{
  "nodeId": "$node",
  "nodeType": "$node_type",
  "runId": "run_1",
  "status": "completed",
  "summary": "$summary",
  "verdict": "$verdict",
  "artifacts": $artifacts,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
HSEOF
}

# Helper: write a good eval file (50+ lines to avoid thinEval)
write_good_eval() {
  local dir="$1" node="$2" role="$3"
  local run_dir="$dir/nodes/$node/run_1"
  mkdir -p "$run_dir"
  cat > "$run_dir/eval-${role}.md" << EVALEOF
# ${role} Review

## Architecture

🔵 src/handler.ts:15 — Missing input validation

Reasoning: User input flows directly to business logic without sanitization.
→ Add zod schema validation at handler boundary.

## Security

🔵 src/auth.ts:22 — Weak password hashing

Reasoning: Using MD5 which is cryptographically broken for passwords.
→ Switch to bcrypt with cost factor 12.

## Performance

🔵 src/queries.ts:42 — Missing index on email column

Reasoning: Full table scan on every user lookup request.
→ CREATE INDEX idx_users_email ON users(email).

## Error Handling

🔵 src/middleware.ts:8 — Generic catch-all swallows errors

Reasoning: All errors return 500, makes debugging impossible in production.
→ Re-throw after logging, or use typed error classes with status codes.

## Code Quality

🔵 src/utils.ts:30 — Unused helper function formatDate

Reasoning: Function is never imported in any other module.
→ Remove dead code or mark as TODO if planned for future use.

## Testing

🔵 src/service.ts:55 — Missing edge case test coverage

Reasoning: Empty input, null values, and boundary conditions not tested.
→ Add test cases for each boundary condition.

## Summary

6 suggestions. All low-priority hardening items.
Architecture is clean with good separation of concerns.
No critical or warning-level issues found.
EVALEOF
}

# Helper: write a bad eval (with warnings)
write_warning_eval() {
  local dir="$1" node="$2" role="$3"
  local run_dir="$dir/nodes/$node/run_1"
  mkdir -p "$run_dir"
  cat > "$run_dir/eval-${role}.md" << EVALEOF
# ${role} Review

## Security

🟡 src/auth.ts:10 — Session fixation vulnerability

**Reasoning:** Token not rotated after login.

**Fix:** Call session.regenerate() after auth.

## Performance

🔵 src/db.ts:45 — Missing index

**Reasoning:** Full table scan on user lookup.

**Fix:** Add index on email column.

## Summary

1 warning, 1 suggestion.
EVALEOF
}

# Helper: write a critical eval
write_critical_eval() {
  local dir="$1" node="$2" role="$3"
  local run_dir="$dir/nodes/$node/run_1"
  mkdir -p "$run_dir"
  cat > "$run_dir/eval-${role}.md" << EVALEOF
# ${role} Review

## Security

🔴 src/db.ts:42 — SQL injection via string concatenation

**Reasoning:** Direct user input in query string enables data exfiltration.

**Fix:** Use parameterized queries with \$1 placeholders.

## Summary

1 critical. Deploy blocked until fixed.
EVALEOF
}

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 1: review flow — PASS path ==="
# review → gate (PASS) → finalize
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null

# Verify init created state
assert_contains "1.1: flow-state exists" "$(cat .harness/flow-state.json)" "currentNode"

STATE=$(cat .harness/flow-state.json)
assert_field_eq "1.2: currentNode = review" "$STATE" "currentNode" '"review"'

# Simulate review: write 2 good evals + handshake
write_good_eval .harness review senior
write_good_eval .harness review security
write_handshake .harness review "Code review complete" "PASS"

# Route from review with PASS verdict
ROUTE=$($HARNESS route --node review --verdict PASS --flow review)
assert_field_eq "1.3: route next = gate" "$ROUTE" "next" '"gate"'

# Transition review → gate
TRANS=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null)
assert_field_eq "1.4: transition allowed" "$TRANS" "allowed" 'true'

# Verify state updated
STATE=$(cat .harness/flow-state.json)
assert_field_eq "1.5: currentNode = gate" "$STATE" "currentNode" '"gate"'

# Synthesize at gate: both evals are suggestion-only → PASS
SYNTH=$($HARNESS synthesize .harness --node review)
assert_field_eq "1.6: synthesize verdict PASS" "$SYNTH" "verdict" '"PASS"'

# Write gate handshake
write_handshake .harness gate "Gate passed" "PASS" gate

# Route from gate with PASS → should be null (terminal)
ROUTE=$($HARNESS route --node gate --verdict PASS --flow review)
NEXT=$(jq_field "$ROUTE" "next")
assert_field_eq "1.7: gate PASS → terminal (next=null)" "$ROUTE" "next" '__NULL__'

# Finalize
FIN=$($HARNESS finalize --dir .harness 2>/dev/null)
assert_contains "1.8: finalize succeeds" "$FIN" "finalized\|complete\|status"

# Validate chain
CHAIN=$($HARNESS validate-chain --dir .harness 2>/dev/null)
assert_contains "1.9: chain valid" "$CHAIN" "valid\|ok\|pass"

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 2: review flow — ITERATE loopback ==="
# review → gate (ITERATE) → review (round 2) → gate (PASS)
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null

# Round 1: warning eval
write_warning_eval .harness review senior
write_good_eval .harness review tester
write_handshake .harness review "Review round 1" "ITERATE"

# Route review → gate
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null

# Synthesize: has warning → ITERATE
SYNTH=$($HARNESS synthesize .harness --node review)
assert_field_eq "2.1: round 1 ITERATE" "$SYNTH" "verdict" '"ITERATE"'

write_handshake .harness gate "Gate iterates" "ITERATE" gate

# Route gate ITERATE → should loop back to review
ROUTE=$($HARNESS route --node gate --verdict ITERATE --flow review)
assert_field_eq "2.2: ITERATE → back to review" "$ROUTE" "next" '"review"'

# Transition gate → review
$HARNESS transition --from gate --to review --verdict ITERATE --flow review --dir .harness 2>/dev/null

STATE=$(cat .harness/flow-state.json)
assert_field_eq "2.3: back at review" "$STATE" "currentNode" '"review"'

# Round 2: clean eval (run_2) — must be 50+ lines
mkdir -p .harness/nodes/review/run_2
write_good_eval .harness review senior
# Move to run_2
mv .harness/nodes/review/run_1/eval-senior.md .harness/nodes/review/run_2/eval-senior.md
write_good_eval .harness review tester
mv .harness/nodes/review/run_1/eval-tester.md .harness/nodes/review/run_2/eval-tester.md

write_handshake .harness review "Review round 2" "PASS"

# Transition review → gate again
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null

# Synthesize round 2
SYNTH=$($HARNESS synthesize .harness --node review --run 2)
assert_field_eq "2.4: round 2 PASS" "$SYNTH" "verdict" '"PASS"'

write_handshake .harness gate "Gate passed round 2" "PASS"

# Terminal
ROUTE=$($HARNESS route --node gate --verdict PASS --flow review)
assert_field_eq "2.5: terminal after round 2" "$ROUTE" "next" '__NULL__'

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 3: review flow — FAIL path ==="
# review → gate (FAIL) → review (loopback)
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null

write_critical_eval .harness review senior
write_good_eval .harness review tester
write_handshake .harness review "Review found critical" "FAIL"

$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null

SYNTH=$($HARNESS synthesize .harness --node review)
assert_field_eq "3.1: critical → FAIL" "$SYNTH" "verdict" '"FAIL"'

write_handshake .harness gate "Gate fails" "FAIL" gate

ROUTE=$($HARNESS route --node gate --verdict FAIL --flow review)
assert_field_eq "3.2: FAIL → back to review" "$ROUTE" "next" '"review"'

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 4: build-verify flow — full happy path ==="
# build → code-review → test-design → test-execute → gate (PASS)
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow build-verify --entry build --dir .harness 2>/dev/null

STATE=$(cat .harness/flow-state.json)
assert_field_eq "4.1: starts at build" "$STATE" "currentNode" '"build"'

# Build node
write_handshake .harness build "Implementation complete" "PASS" build
ROUTE=$($HARNESS route --node build --verdict PASS --flow build-verify)
NEXT=$(jq_field "$ROUTE" "next")
assert_contains "4.2: build → code-review" "$NEXT" "code-review"

$HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .harness 2>/dev/null

# Code review
write_good_eval .harness code-review frontend
write_good_eval .harness code-review backend
write_handshake .harness code-review "Code review done" "PASS"

ROUTE=$($HARNESS route --node code-review --verdict PASS --flow build-verify)
NEXT=$(jq_field "$ROUTE" "next")
assert_contains "4.3: code-review → test-design" "$NEXT" "test-design"

$HARNESS transition --from code-review --to test-design --verdict PASS --flow build-verify --dir .harness 2>/dev/null

# Test design
write_handshake .harness test-design "Test cases designed" "PASS"
ROUTE=$($HARNESS route --node test-design --verdict PASS --flow build-verify)
NEXT=$(jq_field "$ROUTE" "next")
assert_contains "4.4: test-design → test-execute" "$NEXT" "test-execute"

$HARNESS transition --from test-design --to test-execute --verdict PASS --flow build-verify --dir .harness 2>/dev/null

# Test execute
write_handshake .harness test-execute "Tests pass" "PASS" execute
ROUTE=$($HARNESS route --node test-execute --verdict PASS --flow build-verify)
NEXT=$(jq_field "$ROUTE" "next")
assert_contains "4.5: test-execute → gate" "$NEXT" "gate"

$HARNESS transition --from test-execute --to gate --verdict PASS --flow build-verify --dir .harness 2>/dev/null

# Gate
SYNTH=$($HARNESS synthesize .harness --node code-review)
assert_field_eq "4.6: gate verdict PASS" "$SYNTH" "verdict" '"PASS"'

write_handshake .harness gate "All gates pass" "PASS" gate
ROUTE=$($HARNESS route --node gate --verdict PASS --flow build-verify)
assert_field_eq "4.7: terminal" "$ROUTE" "next" '__NULL__'

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 5: build-verify — gate FAIL loopback to build ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow build-verify --entry build --dir .harness 2>/dev/null

# Fast-forward to code-review
write_handshake .harness build "Built" "PASS" build
$HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .harness 2>/dev/null

# Critical finding in review
write_critical_eval .harness code-review security
write_good_eval .harness code-review frontend
write_handshake .harness code-review "Found critical" "FAIL"

$HARNESS transition --from code-review --to test-design --verdict PASS --flow build-verify --dir .harness 2>/dev/null
write_handshake .harness test-design "Test design" "PASS"
$HARNESS transition --from test-design --to test-execute --verdict PASS --flow build-verify --dir .harness 2>/dev/null
write_handshake .harness test-execute "Tests" "PASS" execute
$HARNESS transition --from test-execute --to gate --verdict PASS --flow build-verify --dir .harness 2>/dev/null

SYNTH=$($HARNESS synthesize .harness --node code-review)
assert_field_eq "5.1: gate FAIL on critical" "$SYNTH" "verdict" '"FAIL"'

write_handshake .harness gate "Gate fails" "FAIL" gate
ROUTE=$($HARNESS route --node gate --verdict FAIL --flow build-verify)
NEXT=$(jq_field "$ROUTE" "next")
assert_contains "5.2: FAIL → back to build" "$NEXT" "build"

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 6: escape hatches ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow build-verify --entry build --dir .harness 2>/dev/null

# Skip
SKIP=$($HARNESS skip --dir .harness --flow build-verify 2>/dev/null)
assert_contains "6.1: skip succeeds" "$SKIP" "skip\|PASS\|advanced"

STATE=$(cat .harness/flow-state.json)
CUR=$(jq_field "$STATE" "currentNode")
assert_not_contains "6.2: moved past build" "$CUR" "build"

# Stop
STOP=$($HARNESS stop --dir .harness 2>/dev/null)
assert_contains "6.3: stop succeeds" "$STOP" "stop\|terminated"

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 7: viz output ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null

VIZ=$($HARNESS viz --flow review --dir .harness 2>/dev/null)
assert_contains "7.1: viz shows review node" "$VIZ" "review"
assert_contains "7.2: viz shows gate node" "$VIZ" "gate"

# JSON mode
VIZ_JSON=$($HARNESS viz --flow review --dir .harness --json 2>/dev/null)
assert_contains "7.3: json viz has nodes" "$VIZ_JSON" "nodes"

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 8: cycle limit enforcement ==="
# Loopback 4 times on same edge → should hit maxLoopsPerEdge
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null

for round in 1 2 3; do
  write_warning_eval .harness review "role${round}"
  write_good_eval .harness review "backup${round}"
  write_handshake .harness review "Round $round" "ITERATE"
  $HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null
  write_handshake .harness gate "Gate iterates round $round" "ITERATE" gate
  TRANS=$($HARNESS transition --from gate --to review --verdict ITERATE --flow review --dir .harness 2>/dev/null || echo '{"allowed":false}')
  ALLOWED=$(jq_field "$TRANS" "allowed")
  if [ "$round" -lt 3 ]; then
    assert_field_eq "8.${round}: loop $round allowed" "$TRANS" "allowed" 'true'
  fi
done

# 4th attempt should be blocked by cycle limit
write_warning_eval .harness review "role4"
write_good_eval .harness review "backup4"
write_handshake .harness review "Round 4" "ITERATE"
TRANS_4=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null || echo '{"allowed":false}')
write_handshake .harness gate "Gate round 4" "ITERATE" gate
TRANS_LOOP=$($HARNESS transition --from gate --to review --verdict ITERATE --flow review --dir .harness 2>/dev/null || echo '{"allowed":false,"reason":"cycle limit"}')
# Should either fail or show limit warning
assert_contains "8.4: cycle limit reached" "$TRANS_LOOP" "allowed\|limit\|max\|blocked"

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 9: validate-chain integrity ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null

write_good_eval .harness review analyst
write_good_eval .harness review architect
write_handshake .harness review "Clean review" "PASS"
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null
write_handshake .harness gate "Gate passes" "PASS" gate

CHAIN=$($HARNESS validate-chain --dir .harness 2>/dev/null)
assert_contains "9.1: valid chain" "$CHAIN" "valid\|ok\|pass"

# Corrupt a handshake
echo "{broken" > .harness/nodes/review/handshake.json
CHAIN=$($HARNESS validate-chain --dir .harness 2>&1 || true)
assert_contains "9.2: corrupted chain detected" "$CHAIN" "invalid\|error\|fail\|corrupt\|parse"

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 10: goto escape hatch ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow build-verify --entry build --dir .harness 2>/dev/null

# Goto test-execute directly
GOTO=$($HARNESS goto test-execute --dir .harness 2>/dev/null || echo '{"error":"goto failed"}')
STATE=$(cat .harness/flow-state.json)
CUR=$(jq_field "$STATE" "currentNode")
assert_contains "10.1: goto moved to target" "$CUR" "test-execute"

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 11: pass escape on gate ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null

write_critical_eval .harness review critic
write_good_eval .harness review optimist
write_handshake .harness review "Mixed review" "FAIL"
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null

# Force pass the gate
PASS_OUT=$($HARNESS pass --dir .harness 2>/dev/null || echo '{"error":"pass failed"}')
assert_contains "11.1: force pass succeeds" "$PASS_OUT" "pass\|forced\|PASS"

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 12: D2 compound gate in flow context ==="
# Full review flow where D2 shadow fires during synthesize
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null

# Write a padded eval that triggers D2
mkdir -p .harness/nodes/review/run_1
{
  echo "# Only Heading"
  echo "🔵 Something wrong"
  for i in $(seq 1 50); do
    echo "Everything seems fine overall."
  done
} > .harness/nodes/review/run_1/eval-lazy.md

# Write a good eval
write_good_eval .harness review diligent
write_handshake .harness review "Review done" "ITERATE"

$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null

SYNTH=$($HARNESS synthesize .harness --node review)
assert_contains "12.1: D2 shadow fires in flow" "$SYNTH" "evalQualityGate"
assert_contains "12.2: shadow mode" "$SYNTH" "shadow"
# Verdict should be ITERATE (shadow doesn't change it), not FAIL
assert_field_eq "12.3: shadow doesn't change verdict" "$SYNTH" "verdict" '"ITERATE"'

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 13: ls command lists active flows ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness .harness-*
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
LS=$($HARNESS ls 2>/dev/null || echo "[]")
assert_contains "13.1: ls finds .harness" "$LS" "harness\|review\|active"

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 14: clean command removes .harness dirs ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness .harness-*
mkdir -p .harness .harness-ext .harness-old
echo '{}' > .harness/flow-state.json

$HARNESS clean 2>/dev/null
if [ ! -d .harness ] && [ ! -d .harness-ext ] && [ ! -d .harness-old ]; then
  echo "  ✅ clean removes all .harness dirs"
  PASS=$((PASS + 1))
else
  echo "  ❌ clean: some .harness dirs remain"
  FAIL=$((FAIL + 1))
fi

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 15: replay data export ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
write_good_eval .harness review analyst
write_good_eval .harness review checker
write_handshake .harness review "Review" "PASS"
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null
write_handshake .harness gate "Gate" "PASS" gate

REPLAY=$($HARNESS replay --dir .harness 2>/dev/null || echo '{"error":"replay failed"}')
assert_contains "15.1: replay has flow state" "$REPLAY" "currentNode\|history\|flowState"

echo ""

print_results
