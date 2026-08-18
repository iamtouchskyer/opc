#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

echo "Test: Scenario — Cycle Limit Enforcement"
echo "================================================"
echo ""

$HARNESS init --flow build-verify --entry brief --dir .harness 2>/dev/null

current_run_id() {
  local node="$1"
  python3 - .harness/flow-state.json "$node" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
history = state.get("history", [])
tail = history[-1] if history else None
if tail and tail.get("nodeId") == sys.argv[2] and tail.get("runId"):
    print(tail["runId"])
elif (state.get("totalSteps") == 0 and not history and
      state.get("currentNode") == state.get("entryNode") == sys.argv[2] and
      state.get("flowStartedAt")):
    print("run_1")
else:
    raise SystemExit(1)
PY
}

advance_build_to_gate() {
  local run_id
  run_id=$(current_run_id build) || return 1
  mkdir -p ".harness/nodes/build/$run_id"
  cat > .harness/nodes/build/handshake.json <<EOF
{"nodeId":"build","nodeType":"build","runId":"$run_id","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:01:00.000Z","artifacts":[{"type":"code","path":"$run_id/x"}]}
EOF
  touch ".harness/nodes/build/$run_id/x"
  sync_run_handshakes ".harness"
  $HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null

  run_id=$(current_run_id code-review) || return 1
  mkdir -p ".harness/nodes/code-review/$run_id"
  cat > .harness/nodes/code-review/handshake.json <<EOF
{"nodeId":"code-review","nodeType":"review","runId":"$run_id","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:02:00.000Z","artifacts":[{"type":"eval","path":"$run_id/eval-a.md"},{"type":"eval","path":"$run_id/eval-b.md"}]}
EOF
  echo "# Eval A - review findings" > ".harness/nodes/code-review/$run_id/eval-a.md"
  echo "# Eval B - secondary review" > ".harness/nodes/code-review/$run_id/eval-b.md"
  sync_run_handshakes ".harness"
  $HARNESS transition --from code-review --to test-design --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null

  run_id=$(current_run_id test-design) || return 1
  mkdir -p ".harness/nodes/test-design/$run_id"
  cat > .harness/nodes/test-design/handshake.json <<EOF
{"nodeId":"test-design","nodeType":"review","runId":"$run_id","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:03:00.000Z","artifacts":[{"type":"eval","path":"$run_id/eval-a.md"},{"type":"eval","path":"$run_id/eval-b.md"},{"type":"test-plan","path":"$run_id/test-plan.md"}]}
EOF
  echo "# Eval A - test design findings" > ".harness/nodes/test-design/$run_id/eval-a.md"
  echo "# Eval B - test design secondary" > ".harness/nodes/test-design/$run_id/eval-b.md"
  write_complete_test_plan ".harness/nodes/test-design/$run_id/test-plan.md"
  printf '%s\n' "{\"nodeId\":\"test-design\",\"runId\":\"$run_id\",\"testCommand\":\"node -e \\\"process.exit(0)\\\"\",\"prerequisites\":[\"fixture\"]}" > ".harness/nodes/test-design/$run_id/test-execution.json"
  sync_run_handshakes ".harness"
  $HARNESS transition --from test-design --to test-execute --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null

  run_id=$(current_run_id test-execute) || return 1
  mkdir -p ".harness/nodes/test-execute/$run_id"
  cat > .harness/nodes/test-execute/handshake.json <<EOF
{"nodeId":"test-execute","nodeType":"execute","runId":"$run_id","status":"completed","verdict":"PASS","summary":"ok","timestamp":"2026-01-01T00:04:00.000Z","artifacts":[{"type":"test-result","path":"$run_id/o"}]}
EOF
  touch ".harness/nodes/test-execute/$run_id/o"
  sync_run_handshakes ".harness"
  $HARNESS transition --from test-execute --to gate --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null
}

# ── Helper: advance brief→build→code-review→test-design→test-execute→gate ──
advance_to_gate() {
  local run_id
  run_id=$(current_run_id brief) || return 1
  mkdir -p ".harness/nodes/brief/$run_id"
  cat > .harness/nodes/brief/handshake.json <<EOF
{"nodeId":"brief","nodeType":"brief","runId":"$run_id","status":"completed","verdict":"PASS","summary":"brief done","timestamp":"2026-01-01T00:00:30.000Z","artifacts":[{"type":"brief","path":"build-brief.md"},{"type":"report","path":"$run_id/brief-lint-result.json"}]}
EOF
  write_golden_brief .harness/nodes/brief/build-brief.md
  if [ "$run_id" != "run_1" ]; then
    printf '\n## Iteration Delta\n- Applied the prior gate findings for %s.\n' "$run_id" >> .harness/nodes/brief/build-brief.md
  fi
  echo '{"pass":true}' > ".harness/nodes/brief/$run_id/brief-lint-result.json"
  sync_run_handshakes ".harness"
  $HARNESS transition --from brief --to build --verdict PASS --flow build-verify --dir .harness 2>/dev/null >/dev/null
  advance_build_to_gate
}

loopback_gate_to_brief() {
  local run_id
  run_id=$(current_run_id gate) || return 1
  mkdir -p ".harness/nodes/gate/$run_id"
  cat > .harness/nodes/gate/handshake.json <<EOF
{"nodeId":"gate","nodeType":"gate","runId":"$run_id","status":"completed","verdict":"FAIL","summary":"fail","timestamp":"2026-01-01T00:05:00.000Z","artifacts":[]}
EOF
  echo "- fix" > .harness/backlog.md
  sync_run_handshakes ".harness"
  $HARNESS transition --from gate --to brief --verdict FAIL --flow build-verify --dir .harness 2>/dev/null >/dev/null
}

# Loop 1
advance_to_gate
loopback_gate_to_brief

# Loop 2
advance_to_gate
loopback_gate_to_brief

# Loop 3
advance_to_gate
loopback_gate_to_brief

# ── Test 1: forward PASS remains available after 3 repair loops ──
echo "1. After 3 repairs, the 4th brief→build forward PASS remains available"
BRIEF_RUN=$(current_run_id brief)
mkdir -p ".harness/nodes/brief/$BRIEF_RUN"
cat > .harness/nodes/brief/handshake.json <<EOF
{"nodeId":"brief","nodeType":"brief","runId":"$BRIEF_RUN","status":"completed","verdict":"PASS","summary":"brief done","timestamp":"2026-01-01T00:00:30.000Z","artifacts":[{"type":"brief","path":"build-brief.md"},{"type":"report","path":"$BRIEF_RUN/brief-lint-result.json"}]}
EOF
write_golden_brief .harness/nodes/brief/build-brief.md
printf '\n## Iteration Delta\n- Applied the prior gate findings for %s.\n' "$BRIEF_RUN" >> .harness/nodes/brief/build-brief.md
echo '{"pass":true}' > ".harness/nodes/brief/$BRIEF_RUN/brief-lint-result.json"
sync_run_handshakes ".harness"
TRANS=$($HARNESS transition --from brief --to build --verdict PASS --flow build-verify --dir .harness 2>/dev/null || true)
ALLOWED=$(echo "$TRANS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allowed', False))" 2>/dev/null)
if [ "$ALLOWED" = "True" ]; then
  echo "  ✅ 4th forward traversal allowed"
  PASS=$((PASS + 1))
else
  echo "  ❌ was blocked: $TRANS"
  FAIL=$((FAIL + 1))
fi

# The explicit transition above already entered build; continue from that state.
advance_build_to_gate
GATE_RUN=$(current_run_id gate)
mkdir -p ".harness/nodes/gate/$GATE_RUN"
cat > .harness/nodes/gate/handshake.json <<EOF
{"nodeId":"gate","nodeType":"gate","runId":"$GATE_RUN","status":"completed","verdict":"FAIL","summary":"fail","timestamp":"2026-01-01T00:05:00.000Z","artifacts":[]}
EOF
echo "- fix" > .harness/backlog.md
sync_run_handshakes ".harness"
REPAIR=$($HARNESS transition --from gate --to brief --verdict FAIL --flow build-verify --dir .harness 2>/dev/null || true)

# ── Test 2: fourth semantic repair is blocked by maxLoopsPerEdge ──
echo "2. Fourth gate→brief repair is blocked by maxLoopsPerEdge"
REPAIR_ALLOWED=$(echo "$REPAIR" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allowed', True))" 2>/dev/null)
REASON=$(echo "$REPAIR" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)
if [ "$REPAIR_ALLOWED" = "False" ] && echo "$REASON" | grep -q "maxLoopsPerEdge"; then
  echo "  ✅ reason: $REASON"
  PASS=$((PASS + 1))
else
  echo "  ❌ repair was not blocked: $REPAIR"
  FAIL=$((FAIL + 1))
fi

print_results
