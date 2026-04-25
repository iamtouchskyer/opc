#!/bin/bash
# E2E flow integration tests — Part 1 (Tests 1-2)
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

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
    echo "  ❌ $desc — pattern '$pattern' found (should not be)"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

write_handshake() {
  local dir="$1" node="$2" summary="$3" verdict="$4" node_type="${5:-review}"
  local path="$dir/nodes/$node/handshake.json"
  mkdir -p "$(dirname "$path")"
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
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
assert_contains "1.1: flow-state exists" "$(cat .harness/flow-state.json)" "currentNode"
STATE=$(cat .harness/flow-state.json)
assert_field_eq "1.2: currentNode = review" "$STATE" "currentNode" '"review"'
write_good_eval .harness review senior
write_good_eval .harness review security
write_good_eval .harness review skeptic-owner
write_handshake .harness review "Code review complete" "PASS"
ROUTE=$($HARNESS route --node review --verdict PASS --flow review)
assert_field_eq "1.3: route next = gate" "$ROUTE" "next" '"gate"'
TRANS=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null)
assert_field_eq "1.4: transition allowed" "$TRANS" "allowed" 'true'
STATE=$(cat .harness/flow-state.json)
assert_field_eq "1.5: currentNode = gate" "$STATE" "currentNode" '"gate"'
SYNTH=$($HARNESS synthesize .harness --node review)
assert_field_eq "1.6: synthesize verdict PASS" "$SYNTH" "verdict" '"PASS"'
write_handshake .harness gate "Gate passed" "PASS" gate
ROUTE=$($HARNESS route --node gate --verdict PASS --flow review)
assert_field_eq "1.7: gate PASS → terminal (next=null)" "$ROUTE" "next" '__NULL__'
FIN=$($HARNESS finalize --dir .harness 2>/dev/null)
assert_contains "1.8: finalize succeeds" "$FIN" "finalized\|complete\|status"
CHAIN=$($HARNESS validate-chain --dir .harness 2>/dev/null)
assert_contains "1.9: chain valid" "$CHAIN" "valid\|ok\|pass"

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 2: review flow — ITERATE loopback ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
write_warning_eval .harness review senior
write_good_eval .harness review tester
write_handshake .harness review "Review round 1" "ITERATE"
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null
SYNTH=$($HARNESS synthesize .harness --node review)
assert_field_eq "2.1: round 1 ITERATE" "$SYNTH" "verdict" '"ITERATE"'
write_handshake .harness gate "Gate iterates" "ITERATE" gate
ROUTE=$($HARNESS route --node gate --verdict ITERATE --flow review)
assert_field_eq "2.2: ITERATE → back to review" "$ROUTE" "next" '"review"'
$HARNESS transition --from gate --to review --verdict ITERATE --flow review --dir .harness 2>/dev/null
STATE=$(cat .harness/flow-state.json)
assert_field_eq "2.3: back at review" "$STATE" "currentNode" '"review"'
mkdir -p .harness/nodes/review/run_2
write_good_eval .harness review senior
mv .harness/nodes/review/run_1/eval-senior.md .harness/nodes/review/run_2/eval-senior.md
write_good_eval .harness review tester
mv .harness/nodes/review/run_1/eval-tester.md .harness/nodes/review/run_2/eval-tester.md
write_handshake .harness review "Review round 2" "PASS"
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null
SYNTH=$($HARNESS synthesize .harness --node review --run 2)
assert_field_eq "2.4: round 2 PASS" "$SYNTH" "verdict" '"PASS"'
write_handshake .harness gate "Gate passed round 2" "PASS"
ROUTE=$($HARNESS route --node gate --verdict PASS --flow review)
assert_field_eq "2.5: terminal after round 2" "$ROUTE" "next" '__NULL__'

echo ""

print_results
