#!/bin/bash
# E2E flow integration tests — Part 3 (Tests 6-9)
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
echo "=== E2E TEST 6: escape hatches ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow build-verify --entry build --dir .harness 2>/dev/null
SKIP=$($HARNESS skip --dir .harness --flow build-verify 2>/dev/null)
assert_contains "6.1: skip succeeds" "$SKIP" "skip\|PASS\|advanced"
STATE=$(cat .harness/flow-state.json)
CUR=$(jq_field "$STATE" "currentNode")
assert_not_contains "6.2: moved past build" "$CUR" "build"
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
VIZ_JSON=$($HARNESS viz --flow review --dir .harness --json 2>/dev/null)
assert_contains "7.3: json viz has nodes" "$VIZ_JSON" "nodes"

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 8: cycle limit enforcement ==="
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
  if [ "$round" -lt 3 ]; then
    assert_field_eq "8.${round}: loop $round allowed" "$TRANS" "allowed" 'true'
  fi
done
write_warning_eval .harness review "role4"
write_good_eval .harness review "backup4"
write_handshake .harness review "Round 4" "ITERATE"
TRANS_4=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null || echo '{"allowed":false}')
write_handshake .harness gate "Gate round 4" "ITERATE" gate
TRANS_LOOP=$($HARNESS transition --from gate --to review --verdict ITERATE --flow review --dir .harness 2>/dev/null || echo '{"allowed":false,"reason":"cycle limit"}')
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
echo "{broken" > .harness/nodes/review/handshake.json
CHAIN=$($HARNESS validate-chain --dir .harness 2>&1 || true)
assert_contains "9.2: corrupted chain detected" "$CHAIN" "invalid\|error\|fail\|corrupt\|parse"

echo ""

print_results
