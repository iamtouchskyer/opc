#!/bin/bash
# Tests for OUT-1 (pass refuses on ITERATE/FAIL) and OUT-2 (mandatory role enforcement)
source "$(dirname "$0")/test-helpers.sh"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
setup_tmpdir
setup_git

# ─── Helper: write eval ───
write_good_eval() {
  local dir="$1" node="$2" role="$3"
  local run_dir
  run_dir=$(ls -d "$dir/nodes/$node"/run_* 2>/dev/null | sort -V | tail -1)
  [ -z "$run_dir" ] && run_dir="$dir/nodes/$node/run_1" && mkdir -p "$run_dir"
  # Generate ≥51 lines with file:line refs and distinct content per role to pass D2
  python3 -c "
role='${role}'
lines = [f'# {role} Review — Evaluation Report', '', '## Process']
for i in range(20):
    lines.append(f'Reviewed aspect {i} of the {role} domain. Traced code path {i} through handler.')
lines += ['', '## Scope', f'Reviewed src/api/{role}-handler.ts:1-150, src/middleware/{role}-auth.ts:1-80.', '']
lines += ['## Domain Findings', 'LGTM — no findings in scope.', '']
for i in range(15):
    lines.append(f'Additional verification note {i}: All checks passed for {role} area {i}.')
lines += ['', '## Threads', 'No open threads.', '', '## VERDICT', 'VERDICT: LGTM']
print('\n'.join(lines))
" > "$run_dir/eval-${role}.md"
}

write_warning_eval() {
  local dir="$1" node="$2" role="$3"
  local run_dir
  run_dir=$(ls -d "$dir/nodes/$node"/run_* 2>/dev/null | sort -V | tail -1)
  [ -z "$run_dir" ] && run_dir="$dir/nodes/$node/run_1" && mkdir -p "$run_dir"
  cat > "$run_dir/eval-${role}.md" << EVALEOF
# ${role} review
🟡 src/foo.ts:10 — Missing null check
  reasoning: Could crash at runtime if input is undefined
  fix: Add \`if (!input) return;\` guard
VERDICT: FINDINGS [1]
EVALEOF
}

write_critical_eval() {
  local dir="$1" node="$2" role="$3"
  local run_dir
  run_dir=$(ls -d "$dir/nodes/$node"/run_* 2>/dev/null | sort -V | tail -1)
  [ -z "$run_dir" ] && run_dir="$dir/nodes/$node/run_1" && mkdir -p "$run_dir"
  cat > "$run_dir/eval-${role}.md" << EVALEOF
# ${role} review
🔴 src/bar.ts:5 — SQL injection vulnerability
  reasoning: User input is concatenated into query string
  fix: Use parameterized queries
VERDICT: FINDINGS [1]
EVALEOF
}

write_handshake() {
  local dir="$1" node="$2" summary="$3" verdict="$4" nodeType="${5:-review}"
  local path="$dir/nodes/$node/handshake.json"
  mkdir -p "$(dirname "$path")"
  local run_dir
  run_dir=$(ls -d "$dir/nodes/$node"/run_* 2>/dev/null | sort -V | tail -1)
  local artifacts="[]"
  if [ -n "$run_dir" ]; then
    artifacts=$(ls "$run_dir"/eval-*.md 2>/dev/null | python3 -c "
import sys, json
files = [l.strip() for l in sys.stdin if l.strip()]
print(json.dumps([{'path': f, 'type': 'eval'} for f in files]))
")
  fi
  cat > "$path" << EOF
{
  "nodeId": "$node",
  "nodeType": "$nodeType",
  "runId": "run_1",
  "status": "completed",
  "verdict": "$verdict",
  "summary": "$summary",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "artifacts": $artifacts,
  "findings": null
}
EOF
}

# ═══════════════════════════════════════════════════════════════
echo "=== OUT-1: pass refuses on ITERATE/FAIL upstream verdict ==="
# ═══════════════════════════════════════════════════════════════

# Helper: set up full-stack flow to gate-test with review evals
setup_at_gate_test() {
  local evalfn="$1"  # write_good_eval or write_warning_eval or write_critical_eval
  DIR=$(mktemp -d)
  cd "$DIR"
  $HARNESS init --flow full-stack --entry discuss --dir .harness 2>/dev/null
  # discuss → build
  write_handshake .harness discuss "Discuss done" "PASS" discussion
  $HARNESS transition --from discuss --to build --verdict PASS --flow full-stack --dir .harness 2>/dev/null
  # build → code-review
  write_handshake .harness build "Build done" "PASS" build
  $HARNESS transition --from build --to code-review --verdict PASS --flow full-stack --dir .harness 2>/dev/null
  # code-review → test-design (need evals)
  write_good_eval .harness code-review senior
  write_good_eval .harness code-review tester
  write_handshake .harness code-review "Review done" "PASS"
  $HARNESS transition --from code-review --to test-design --verdict PASS --flow full-stack --dir .harness 2>/dev/null
  # test-design → test-execute
  write_good_eval .harness test-design senior
  write_good_eval .harness test-design tester
  write_handshake .harness test-design "Test design done" "PASS"
  $HARNESS transition --from test-design --to test-execute --verdict PASS --flow full-stack --dir .harness 2>/dev/null
  # test-execute → gate-test (need evidence)
  mkdir -p .harness/nodes/test-execute/run_1
  echo "test output" > .harness/nodes/test-execute/run_1/test-results.json
  cat > .harness/nodes/test-execute/handshake.json << EOF
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","verdict":"PASS","summary":"Tests pass","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","artifacts":[{"type":"test-result","path":"run_1/test-results.json"}]}
EOF
  $HARNESS transition --from test-execute --to gate-test --verdict PASS --flow full-stack --dir .harness 2>/dev/null
  # Now at gate-test. Write upstream review evals to test-design for synthesize
  # (synthesize looks at the latest non-gate node)
  # But actually the upstream for gate-test is test-execute (execute), not review.
  # We need the upstream to be a review node with evals. Let me use the code-review node.
}

# Test 1: pass allowed when upstream synthesize → PASS
echo "--- 1.1: pass allowed when upstream verdict is PASS ---"
DIR=$(mktemp -d)
cd "$DIR"
# Simpler: use review flow. The gate PASS edge is null (terminal), so pass says "use finalize".
# Instead, directly test the verdict check logic by looking at the error message.
# Actually, let me use a flow file approach.
# Simplest: create a custom flow file for testing.
cat > /tmp/opc-test-guardrail-flow.json << 'FLOWEOF'
{
  "opc_compat": ">=0.5",
  "nodes": ["review", "gate", "done"],
  "edges": {
    "review": {"PASS": "gate"},
    "gate": {"PASS": "done", "FAIL": "review", "ITERATE": "review"},
    "done": {"PASS": null}
  },
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"review": "review", "gate": "gate", "done": "build"},
  "softEvidence": true
}
FLOWEOF
$HARNESS init --flow-file /tmp/opc-test-guardrail-flow.json --entry review --dir .harness 2>/dev/null
write_good_eval .harness review engineer
write_good_eval .harness review skeptic-owner
write_handshake .harness review "Review done" "PASS"
$HARNESS transition --from review --to gate --verdict PASS --flow-file /tmp/opc-test-guardrail-flow.json --dir .harness 2>/dev/null
# Now at gate, upstream PASS evals → pass should work
OUT=$($HARNESS pass --dir .harness 2>/dev/null)
if echo "$OUT" | grep -q '"allowed":true\|"allowed": true'; then
  echo "  ✅ pass allowed with PASS upstream"; PASS=$((PASS+1))
else
  echo "  ❌ pass should be allowed with PASS upstream (got: $OUT)"; FAIL=$((FAIL+1))
fi

# Test 2: pass refused when upstream verdict is ITERATE
echo "--- 1.2: pass refused when upstream verdict is ITERATE ---"
DIR=$(mktemp -d)
cd "$DIR"
$HARNESS init --flow-file /tmp/opc-test-guardrail-flow.json --entry review --dir .harness 2>/dev/null
write_warning_eval .harness review engineer
write_good_eval .harness review skeptic-owner
write_handshake .harness review "Review with warnings" "PASS"
$HARNESS transition --from review --to gate --verdict PASS --flow-file /tmp/opc-test-guardrail-flow.json --dir .harness 2>/dev/null
OUT=$($HARNESS pass --dir .harness 2>/dev/null)
if echo "$OUT" | grep -q "Cannot force-pass"; then
  echo "  ✅ pass refused with ITERATE upstream"; PASS=$((PASS+1))
else
  echo "  ❌ pass should refuse with ITERATE upstream (got: $OUT)"; FAIL=$((FAIL+1))
fi

# Test 3: pass refused when upstream verdict is FAIL
echo "--- 1.3: pass refused when upstream verdict is FAIL ---"
DIR=$(mktemp -d)
cd "$DIR"
$HARNESS init --flow-file /tmp/opc-test-guardrail-flow.json --entry review --dir .harness 2>/dev/null
write_critical_eval .harness review engineer
write_critical_eval .harness review skeptic-owner
write_handshake .harness review "Review with critical" "PASS"
$HARNESS transition --from review --to gate --verdict PASS --flow-file /tmp/opc-test-guardrail-flow.json --dir .harness 2>/dev/null
OUT=$($HARNESS pass --dir .harness 2>/dev/null)
if echo "$OUT" | grep -q "Cannot force-pass"; then
  echo "  ✅ pass refused with FAIL upstream"; PASS=$((PASS+1))
else
  echo "  ❌ pass should refuse with FAIL upstream (got: $OUT)"; FAIL=$((FAIL+1))
fi

# Test 4: skip still works when pass is blocked
echo "--- 1.4: skip works when pass would be blocked ---"
DIR=$(mktemp -d)
cd "$DIR"
$HARNESS init --flow-file /tmp/opc-test-guardrail-flow.json --entry review --dir .harness 2>/dev/null
write_warning_eval .harness review engineer
write_good_eval .harness review skeptic-owner
write_handshake .harness review "Review with warnings" "PASS"
$HARNESS transition --from review --to gate --verdict PASS --flow-file /tmp/opc-test-guardrail-flow.json --dir .harness 2>/dev/null
OUT=$($HARNESS skip --dir .harness 2>/dev/null)
if echo "$OUT" | grep -q '"skipped"\|"next"'; then
  echo "  ✅ skip works when pass is blocked"; PASS=$((PASS+1))
else
  echo "  ❌ skip should work when pass is blocked (got: $OUT)"; FAIL=$((FAIL+1))
fi

echo ""

# ═══════════════════════════════════════════════════════════════
echo "=== OUT-2: mandatory role enforcement ==="
# ═══════════════════════════════════════════════════════════════

# Test 5: transition from review with all mandatory roles present
echo "--- 2.1: transition allowed with mandatory roles present ---"
DIR=$(mktemp -d)
cd "$DIR"
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
write_good_eval .harness review engineer
write_good_eval .harness review skeptic-owner
write_handshake .harness review "Review done" "PASS"
TRANS=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null)
if echo "$TRANS" | grep -q '"allowed":true\|"allowed": true'; then
  echo "  ✅ transition allowed with mandatory roles"; PASS=$((PASS+1))
else
  echo "  ❌ transition should be allowed (got: $TRANS)"; FAIL=$((FAIL+1))
fi

# Test 6: transition from review missing mandatory role (skeptic-owner)
echo "--- 2.2: transition refused missing mandatory role ---"
DIR=$(mktemp -d)
cd "$DIR"
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
write_good_eval .harness review engineer
write_good_eval .harness review frontend
write_handshake .harness review "Review done" "PASS"
TRANS=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null)
if echo "$TRANS" | grep -q "Missing mandatory role"; then
  echo "  ✅ transition refused for missing mandatory role"; PASS=$((PASS+1))
else
  echo "  ❌ transition should refuse (got: $TRANS)"; FAIL=$((FAIL+1))
fi

# Test 7: transition from review with ALL unknown roles — mandatory check skipped (no known role overlap)
echo "--- 2.3: transition allowed with all-unknown roles (no enforcement) ---"
DIR=$(mktemp -d)
cd "$DIR"
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
write_good_eval .harness review xsenior
write_good_eval .harness review xtester
write_handshake .harness review "Review done" "PASS"
TRANS=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null)
if echo "$TRANS" | grep -q '"allowed":true\|"allowed": true'; then
  echo "  ✅ transition allowed with all-unknown roles (enforcement skipped)"; PASS=$((PASS+1))
else
  echo "  ❌ transition should be allowed with all-unknown roles (got: $TRANS)"; FAIL=$((FAIL+1))
fi

# Test 7b: transition with MIX of known + unknown roles, missing mandatory → refused
echo "--- 2.3b: transition refused with mix of known/unknown roles missing mandatory ---"
DIR=$(mktemp -d)
cd "$DIR"
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
write_good_eval .harness review engineer
write_good_eval .harness review custom-role
write_handshake .harness review "Review done" "PASS"
TRANS=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null)
if echo "$TRANS" | grep -q "Missing mandatory role"; then
  echo "  ✅ transition refused — mandatory check active with known+unknown mix"; PASS=$((PASS+1))
else
  echo "  ❌ transition should refuse (known role present triggers enforcement) (got: $TRANS)"; FAIL=$((FAIL+1))
fi

# Test 8: missingRoles field present in error response
echo "--- 2.4: error includes missingRoles array ---"
DIR=$(mktemp -d)
cd "$DIR"
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
write_good_eval .harness review engineer
write_good_eval .harness review frontend
write_handshake .harness review "Review done" "PASS"
TRANS=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null)
if echo "$TRANS" | grep -q '"missingRoles"'; then
  echo "  ✅ missingRoles field present"; PASS=$((PASS+1))
else
  echo "  ❌ missingRoles field should be present (got: $TRANS)"; FAIL=$((FAIL+1))
fi

# ═══════════════════════════════════════════════════════════════
echo "=== OUT-2b: review node must have eval artifacts ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 2.5: transition refused when review node has no eval artifacts ---"
DIR=$(mktemp -d)
cd "$DIR"
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
# Write handshake with no eval artifacts
mkdir -p .harness/nodes/review
cat > .harness/nodes/review/handshake.json << EOF
{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","verdict":"PASS","summary":"No evals","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","artifacts":[{"type":"code","path":"src/foo.ts"}]}
EOF
TRANS=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null)
if echo "$TRANS" | grep -q "no eval-type artifacts\|eval artifacts"; then
  echo "  ✅ transition refused when review has no eval artifacts"; PASS=$((PASS+1))
else
  echo "  ❌ transition should refuse review with no eval artifacts (got: $TRANS)"; FAIL=$((FAIL+1))
fi

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== CRLF front matter parsing ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 3.1: CRLF line endings in role front matter still detected ---"
DIR=$(mktemp -d)
cd "$DIR"
# Create a role file with CRLF endings to test that mandatory detection works
ROLES_DIR="$REPO_DIR/roles"
# Create a temp mandatory role file with CRLF
TMP_ROLE="$ROLES_DIR/_test-crlf-role.md"
printf -- "---\r\ntags: [review]\r\nmandatory: true\r\n---\r\n\r\n# Test CRLF Role\r\n" > "$TMP_ROLE"

$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
write_good_eval .harness review engineer
write_good_eval .harness review skeptic-owner
# Missing _test-crlf-role → should refuse
write_handshake .harness review "Review done" "PASS"
TRANS=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null)
rm -f "$TMP_ROLE"
if echo "$TRANS" | grep -q "Missing mandatory role.*_test-crlf-role\|_test-crlf-role"; then
  echo "  ✅ CRLF front matter correctly parsed as mandatory"; PASS=$((PASS+1))
else
  echo "  ❌ CRLF front matter should be parsed (got: $TRANS)"; FAIL=$((FAIL+1))
fi

echo "--- 3.2: malformed front matter doesn't crash ---"
DIR=$(mktemp -d)
cd "$DIR"
ROLES_DIR="$REPO_DIR/roles"
TMP_ROLE="$ROLES_DIR/_test-bad-fm.md"
printf "%s" "---
this is not yaml at all {{{{
" > "$TMP_ROLE"
$HARNESS init --flow review --entry review --dir .harness 2>/dev/null
write_good_eval .harness review engineer
write_good_eval .harness review skeptic-owner
write_handshake .harness review "Review done" "PASS"
TRANS=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness 2>/dev/null)
rm -f "$TMP_ROLE"
# Should not crash — either allowed or refused for legitimate reasons, not an unhandled error
if [ -n "$TRANS" ]; then
  echo "  ✅ malformed front matter handled without crash"; PASS=$((PASS+1))
else
  echo "  ❌ malformed front matter caused crash (empty output)"; FAIL=$((FAIL+1))
fi

print_results
