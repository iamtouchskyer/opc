#!/bin/bash
# E2E flow integration tests — Part 5 (Tests 15-17)
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
assert_contains "15.2: replay has meta" "$REPLAY" '"meta"'

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 16: full-stack discussion node path ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow full-stack --entry discuss --dir .harness 2>/dev/null
write_handshake .harness discuss "Discussion round complete" "PASS" discussion
$HARNESS transition --from discuss --to build --verdict PASS --flow full-stack --dir .harness 2>/dev/null
write_handshake .harness build "Implementation done" "PASS" build
$HARNESS transition --from build --to code-review --verdict PASS --flow full-stack --dir .harness 2>/dev/null
write_good_eval .harness code-review frontend
write_good_eval .harness code-review backend
write_good_eval .harness code-review skeptic-owner
write_handshake .harness code-review "Review done" "PASS"
$HARNESS transition --from code-review --to test-design --verdict PASS --flow full-stack --dir .harness 2>/dev/null
assert_contains "16.1: reached test-design" "$(cat .harness/flow-state.json)" '"test-design"'
assert_contains "16.2: discuss in history" "$(cat .harness/flow-state.json)" '"discuss"'

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 17: oscillation detection via diff ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
mkdir -p .harness/nodes/review/run_1
cat > .harness/round1-eval.md << 'EVALEOF'
# Review Round 1
## Security
🟡 src/auth.ts:10 — Session fixation vulnerability
Reasoning: Session ID not regenerated after login.
→ Call session.regenerate() after authentication.
## Performance
🟡 src/db.ts:42 — Missing connection pooling
Reasoning: Each request creates a new database connection.
→ Use connection pool with max 10 connections.
## Error Handling
🟡 src/api.ts:15 — Unhandled promise rejection
Reasoning: Async route handlers don't catch errors properly.
→ Wrap in try/catch or use express-async-errors.
## Testing
🔵 src/service.ts:30 — Insufficient test coverage
Reasoning: Core business logic has only 40% coverage.
→ Add tests for payment processing edge cases.
## Summary
VERDICT: ITERATE FINDINGS[4]
3 warnings, 1 suggestion.
EVALEOF
cat > .harness/round2-eval.md << 'EVALEOF'
# Review Round 2
## Security
🟡 src/auth.ts:10 — Session fixation vulnerability
Reasoning: Still not fixed since round 1.
→ Call session.regenerate() after authentication.
## Performance
🟡 src/db.ts:42 — Missing connection pooling
Reasoning: Connection pooling still not implemented.
→ Use connection pool with max 10 connections.
## Error Handling
🟡 src/api.ts:15 — Unhandled promise rejection
Reasoning: Async errors still unhandled.
→ Wrap in try/catch or use express-async-errors.
## Summary
VERDICT: ITERATE FINDINGS[3]
3 recurring warnings.
EVALEOF
DIFF_OUT=$($HARNESS diff .harness/round1-eval.md .harness/round2-eval.md 2>/dev/null)
assert_contains "17.1: diff detects recurring" "$DIFF_OUT" '"recurring"'
assert_contains "17.2: oscillation detected" "$DIFF_OUT" '"oscillation": true'
assert_contains "17.3: resolved count" "$DIFF_OUT" '"resolved"'

echo ""

print_results
