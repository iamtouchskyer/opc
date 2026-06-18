#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

json_field() {
  echo "$1" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$2'))"
}

write_test_design_handshake() {
  local dir="$1" command="$2"
  mkdir -p "$dir/nodes/test-design"
  echo "# Eval A" > "$dir/nodes/test-design/eval-a.md"
  echo "# Eval B" > "$dir/nodes/test-design/eval-b.md"
  python3 - "$dir/nodes/test-design/handshake.json" "$command" <<'PY'
import json, sys
path, command = sys.argv[1], sys.argv[2]
data = {
  "nodeId": "test-design",
  "nodeType": "review",
  "runId": "run_1",
  "status": "completed",
  "verdict": "PASS",
  "summary": "tests designed",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [
    {"type": "eval", "path": "eval-a.md"},
    {"type": "eval", "path": "eval-b.md"}
  ],
  "testCommand": command,
  "prerequisites": ["local fixture command"]
}
open(path, "w").write(json.dumps(data))
PY
}

write_test_execution_spec() {
  local dir="$1" command="$2" cwd="$3"
  mkdir -p "$dir/nodes/test-design"
  python3 - "$dir/nodes/test-design/test-execution.json" "$command" "$cwd" <<'PY'
import json, sys
path, command, cwd = sys.argv[1], sys.argv[2], sys.argv[3]
data = {
  "testCommand": command,
  "cwd": cwd,
  "prerequisites": ["cwd must exist"]
}
open(path, "w").write(json.dumps(data))
PY
}

echo "Test: test-design testCommand executes in test-execute"
echo "====================================================="
echo ""

$HARNESS init --flow build-verify --entry test-design --dir .harness >/dev/null 2>/dev/null
write_test_design_handshake .harness "node -e \"process.exit(0)\""
OUT=$($HARNESS transition --from test-design --to test-execute --verdict PASS --flow build-verify --dir .harness 2>/dev/null)
EXECUTED=$(python3 -c "import json,sys; print(json.load(sys.stdin)['testCommandExecution']['executed'])" <<< "$OUT")
EXIT_CODE=$(python3 -c "import json; print(json.load(open('.harness/nodes/test-execute/run_1/test-command-result.json'))['exitCode'])")
if [ "$EXECUTED" = "True" ] && [ "$EXIT_CODE" = "0" ]; then
  echo "  ✅ testCommand executed and wrote result evidence"
  PASS=$((PASS + 1))
else
  echo "  ❌ testCommand evidence missing: executed=$EXECUTED exit=$EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

if [ -f .harness/nodes/test-execute/handshake.json ] &&
   grep -q '"type": "test-result"' .harness/nodes/test-execute/handshake.json &&
   grep -q '"type": "cli-output"' .harness/nodes/test-execute/handshake.json; then
  echo "  ✅ test-execute handshake records test-result and cli-output"
  PASS=$((PASS + 1))
else
  echo "  ❌ test-execute handshake missing evidence artifacts"
  FAIL=$((FAIL + 1))
fi

$HARNESS init --flow build-verify --entry test-design --dir .harness-fail >/dev/null 2>/dev/null
write_test_design_handshake .harness-fail "node -e \"process.exit(7)\""
$HARNESS transition --from test-design --to test-execute --verdict PASS --flow build-verify --dir .harness-fail >/dev/null 2>/dev/null
$HARNESS transition --from test-execute --to gate --verdict PASS --flow build-verify --dir .harness-fail >/dev/null 2>/dev/null
OUT=$($HARNESS transition --from gate --to null --verdict PASS --flow build-verify --dir .harness-fail 2>/dev/null)
ALLOWED=$(json_field "$OUT" "allowed")
if [ "$ALLOWED" = "False" ] && grep -q "test(s) failed" <<< "$OUT"; then
  echo "  ✅ failed testCommand blocks gate PASS through structured result"
  PASS=$((PASS + 1))
else
  echo "  ❌ failed testCommand did not block gate PASS: $OUT"
  FAIL=$((FAIL + 1))
fi

$HARNESS init --flow build-verify --entry test-design --dir .harness-bad-cwd >/dev/null 2>/dev/null
write_test_design_handshake .harness-bad-cwd "node -e \"process.exit(0)\""
write_test_execution_spec .harness-bad-cwd "node -e \"process.exit(0)\"" "/tmp/opc-missing-test-cwd"
$HARNESS transition --from test-design --to test-execute --verdict PASS --flow build-verify --dir .harness-bad-cwd >/dev/null 2>/dev/null
EXIT_CODE=$(python3 -c "import json; print(json.load(open('.harness-bad-cwd/nodes/test-execute/run_1/test-command-result.json'))['exitCode'])")
if [ "$EXIT_CODE" = "1" ] && grep -q "ENOENT" .harness-bad-cwd/nodes/test-execute/run_1/test-command-output.txt; then
  echo "  ✅ invalid cwd writes failing test evidence"
  PASS=$((PASS + 1))
else
  echo "  ❌ invalid cwd failed open"
  FAIL=$((FAIL + 1))
fi

print_results
