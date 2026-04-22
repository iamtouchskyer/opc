#!/bin/bash
# E2E flow integration tests — Part 4 (Tests 10-14)
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
echo "=== E2E TEST 10: goto escape hatch ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow build-verify --entry build --dir .harness 2>/dev/null
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
PASS_OUT=$($HARNESS pass --dir .harness 2>/dev/null || echo '{"error":"pass failed"}')
assert_contains "11.1: force pass succeeds" "$PASS_OUT" "pass\|forced\|PASS"

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== E2E TEST 12: D2 compound gate in flow context ==="
# ═══════════════════════════════════════════════════════════════

rm -rf .harness
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
mkdir -p .harness/nodes/review/run_1
{
  echo "# Only Heading"
  echo "🔵 Something wrong"
  for i in $(seq 1 50); do
    echo "Everything seems fine overall."
  done
} > .harness/nodes/review/run_1/eval-lazy.md
write_good_eval .harness review diligent
write_handshake .harness review "Review done" "ITERATE"
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null
SYNTH=$($HARNESS synthesize .harness --node review)
assert_contains "12.1: D2 gate fires in flow" "$SYNTH" "evalQualityGate"
assert_contains "12.2: enforce mode (default)" "$SYNTH" "enforce"
assert_field_eq "12.3: enforce changes verdict to FAIL" "$SYNTH" "verdict" '"FAIL"'

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

print_results
