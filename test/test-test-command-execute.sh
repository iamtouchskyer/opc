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
  mkdir -p "$dir/nodes/test-design/run_1"
  echo "# Eval A" > "$dir/nodes/test-design/run_1/eval-a.md"
  echo "# Eval B" > "$dir/nodes/test-design/run_1/eval-b.md"
  write_complete_test_plan "$dir/nodes/test-design/run_1/test-plan.md"
  python3 - "$dir/nodes/test-design/handshake.json" "$dir/nodes/test-design/run_1/handshake.json" "$command" <<'PY'
import json, sys
path, run_path, command = sys.argv[1], sys.argv[2], sys.argv[3]
data = {
  "nodeId": "test-design",
  "nodeType": "review",
  "runId": "run_1",
  "status": "completed",
  "verdict": "PASS",
  "summary": "tests designed",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [
    {"type": "eval", "path": "run_1/eval-a.md"},
    {"type": "eval", "path": "run_1/eval-b.md"},
    {"type": "test-plan", "path": "run_1/test-plan.md"}
  ],
  "testCommand": command,
  "prerequisites": ["local fixture command"]
}
open(path, "w").write(json.dumps(data))
run_data = dict(data)
for artifact in run_data["artifacts"]:
  artifact["path"] = artifact["path"].replace("run_1/", "")
open(run_path, "w").write(json.dumps(run_data))
PY
}

write_test_execution_spec() {
  local dir="$1" command="$2" cwd="$3"
  mkdir -p "$dir/nodes/test-design/run_1"
  python3 - "$dir/nodes/test-design/run_1/test-execution.json" "$command" "$cwd" <<'PY'
import json, sys
path, command, cwd = sys.argv[1], sys.argv[2], sys.argv[3]
data = {
  "nodeId": "test-design",
  "runId": "run_1",
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

if grep -q '"kind": "opc-test-command"' .harness/nodes/test-execute/handshake.json &&
   grep -q '"sourcePlanHash":' .harness/nodes/test-execute/handshake.json &&
   grep -q '"sourceRunId": "run_1"' .harness/nodes/test-execute/handshake.json &&
   grep -q '"resultHash":' .harness/nodes/test-execute/handshake.json &&
   grep -q '"ledger":' .harness/nodes/test-execute/handshake.json &&
   [ -f .harness/.opc-provenance.jsonl ] &&
   grep -q '"executionActor": "opc-harness:test-command"' .harness/nodes/test-execute/handshake.json &&
   grep -q '"kind": "opc-test-command"' .harness/nodes/test-execute/run_1/test-command-result.json &&
   grep -q '"sourcePlanHash":' .harness/nodes/test-execute/run_1/test-command-result.json &&
   grep -q '"sourceRunId": "run_1"' .harness/nodes/test-execute/run_1/test-command-result.json &&
   grep -q '"executionActor": "opc-harness:test-command"' .harness/nodes/test-execute/run_1/test-command-result.json; then
  echo "  ✅ testCommand evidence records OPC provenance"
  PASS=$((PASS + 1))
else
  echo "  ❌ testCommand evidence missing OPC provenance"
  FAIL=$((FAIL + 1))
fi

SEAL_OUT=$($HARNESS seal --node test-execute --dir .harness 2>/dev/null)
SEAL_ERRORS=$(json_field "$SEAL_OUT" "validationErrors")
if grep -q '"kind": "opc-test-command"' .harness/nodes/test-execute/handshake.json &&
   grep -q '"resultHash":' .harness/nodes/test-execute/handshake.json &&
   [ "$SEAL_ERRORS" = "[]" ]; then
  echo "  ✅ seal preserves harness testCommand provenance"
  PASS=$((PASS + 1))
else
  echo "  ❌ seal clobbered testCommand provenance or reported errors: $SEAL_OUT"
  FAIL=$((FAIL + 1))
fi

python3 - <<'PY'
import json
path = ".harness/nodes/test-execute/run_1/test-command-result.json"
data = json.load(open(path))
data["tampered"] = True
open(path, "w").write(json.dumps(data, indent=2) + "\n")
PY
OUT=$($HARNESS transition --from test-execute --to gate --verdict PASS --flow build-verify --dir .harness 2>/dev/null)
ALLOWED=$(json_field "$OUT" "allowed")
if [ "$ALLOWED" = "False" ] && grep -q "result hash" <<< "$OUT"; then
  echo "  ✅ modified testCommand result blocks gate"
  PASS=$((PASS + 1))
else
  echo "  ❌ modified testCommand result passed gate: $OUT"
  FAIL=$((FAIL + 1))
fi

$HARNESS init --flow build-verify --entry test-design --dir .harness-auto-cwd >/dev/null 2>/dev/null
mkdir -p app/node_modules/fixture-pkg
printf '{"name":"app","private":true}\n' > app/package.json
printf 'module.exports = 42;\n' > app/node_modules/fixture-pkg/index.js
write_test_design_handshake .harness-auto-cwd "node -e \"require.resolve('fixture-pkg')\""
$HARNESS transition --from test-design --to test-execute --verdict PASS --flow build-verify --dir .harness-auto-cwd >/dev/null 2>/dev/null
EXIT_CODE=$(python3 -c "import json; print(json.load(open('.harness-auto-cwd/nodes/test-execute/run_1/test-command-result.json'))['exitCode'])")
CWD_SOURCE=$(python3 -c "import json; print(json.load(open('.harness-auto-cwd/nodes/test-execute/run_1/test-command-result.json'))['cwdSource'])")
if [ "$EXIT_CODE" = "0" ] && [ "$CWD_SOURCE" = "auto-js-project" ]; then
  echo "  ✅ testCommand auto-resolves unique JS package cwd"
  PASS=$((PASS + 1))
else
  echo "  ❌ testCommand cwd auto-resolution failed: exit=$EXIT_CODE cwdSource=$CWD_SOURCE"
  FAIL=$((FAIL + 1))
fi

$HARNESS init --flow build-verify --entry test-design --dir .harness-fail >/dev/null 2>/dev/null
write_test_design_handshake .harness-fail "node -e \"process.exit(7)\""
$HARNESS transition --from test-design --to test-execute --verdict PASS --flow build-verify --dir .harness-fail >/dev/null 2>/dev/null
OUT=$($HARNESS transition --from test-execute --to gate --verdict PASS --flow build-verify --dir .harness-fail 2>/dev/null)
ALLOWED=$(json_field "$OUT" "allowed")
if [ "$ALLOWED" = "False" ] && { grep -q "test(s) failed" <<< "$OUT" || grep -q "sealed verdict is.*FAIL" <<< "$OUT"; }; then
  echo "  ✅ failed testCommand blocks test-execute → gate through structured result"
  PASS=$((PASS + 1))
else
  echo "  ❌ failed testCommand did not block test-execute → gate PASS: $OUT"
  FAIL=$((FAIL + 1))
fi

$HARNESS init --flow build-verify --entry test-execute --dir .harness-forged >/dev/null 2>/dev/null
mkdir -p .harness-forged/nodes/test-execute/run_1
cat > .harness-forged/nodes/test-execute/run_1/test-execution.json <<'JSON'
{"summary":{"passed":["fake"]},"checks":[{"id":"fake-pass","pass":true,"total":1}]}
JSON
cat > .harness-forged/nodes/test-execute/handshake.json <<'JSON'
{
  "nodeId": "test-execute",
  "nodeType": "execute",
  "runId": "run_1",
  "status": "completed",
  "verdict": "PASS",
  "summary": "self-authored pass",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [{"type": "test-result", "path": "run_1/test-execution.json"}]
}
JSON
python3 - <<'PY'
import json
data = json.load(open('.harness-forged/nodes/test-execute/handshake.json'))
run_data = dict(data)
run_data["artifacts"] = [{"type": "test-result", "path": "test-execution.json"}]
open('.harness-forged/nodes/test-execute/run_1/handshake.json', 'w').write(json.dumps(run_data))
PY
OUT=$($HARNESS transition --from test-execute --to gate --verdict PASS --flow build-verify --dir .harness-forged 2>/dev/null)
ALLOWED=$(json_field "$OUT" "allowed")
if [ "$ALLOWED" = "False" ] && grep -q "lacks matching OPC testCommand provenance" <<< "$OUT"; then
  echo "  ✅ self-authored structured test evidence blocks before gate"
  PASS=$((PASS + 1))
else
  echo "  ❌ self-authored structured test evidence passed early gate: $OUT"
  FAIL=$((FAIL + 1))
fi

$HARNESS init --flow build-verify --entry test-execute --dir .harness-consistent-forge >/dev/null 2>/dev/null
mkdir -p .harness-consistent-forge/nodes/test-design/run_1 .harness-consistent-forge/nodes/test-execute/run_1
write_complete_test_plan .harness-consistent-forge/nodes/test-design/run_1/test-plan.md
COMMAND='node -e "process.exit(0)"'
python3 - <<'PY'
import hashlib, json
command = 'node -e "process.exit(0)"'
plan = open('.harness-consistent-forge/nodes/test-design/run_1/test-plan.md').read()
command_hash = hashlib.sha256(command.encode()).hexdigest()
plan_hash = hashlib.sha256(plan.encode()).hexdigest()
result = {
  "testCommand": command,
  "provenance": {
    "kind": "opc-test-command",
    "sourceNode": "test-design",
    "sourceRunId": "run_1",
    "commandHash": command_hash,
    "sourcePlanHash": plan_hash,
    "executionActor": "opc-harness:test-command"
  },
  "checks": [{"id": "fake-pass", "pass": True, "total": 1}],
  "test_fail_count": 0
}
result_text = json.dumps(result, indent=2) + "\n"
open('.harness-consistent-forge/nodes/test-execute/run_1/test-command-result.json', 'w').write(result_text)
result_hash = hashlib.sha256(result_text.encode()).hexdigest()
design_hs = {
  "nodeId": "test-design", "nodeType": "review", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "tests designed",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [{"type": "test-plan", "path": "run_1/test-plan.md"}],
  "testCommand": command
}
exec_hs = {
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "forged public hashes",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [{"type": "test-result", "path": "run_1/test-command-result.json"}],
	  "testEvidenceProvenance": {
	    "kind": "opc-test-command",
	    "sourceNode": "test-design",
	    "sourceRunId": "run_1",
	    "commandHash": command_hash,
    "sourcePlanHash": plan_hash,
    "resultHash": result_hash,
    "executionActor": "opc-harness:test-command"
	  },
	  "testEvidencePolicy": {"allowVacuousChecks": []}
	}
design_run_hs = dict(design_hs)
design_run_hs["artifacts"] = [{"type": "test-plan", "path": "test-plan.md"}]
exec_run_hs = dict(exec_hs)
exec_run_hs["artifacts"] = [{"type": "test-result", "path": "test-command-result.json"}]
open('.harness-consistent-forge/nodes/test-design/handshake.json', 'w').write(json.dumps(design_hs))
open('.harness-consistent-forge/nodes/test-design/run_1/handshake.json', 'w').write(json.dumps(design_run_hs))
open('.harness-consistent-forge/nodes/test-execute/handshake.json', 'w').write(json.dumps(exec_hs))
open('.harness-consistent-forge/nodes/test-execute/run_1/handshake.json', 'w').write(json.dumps(exec_run_hs))
PY
OUT=$($HARNESS transition --from test-execute --to gate --verdict PASS --flow build-verify --dir .harness-consistent-forge 2>/dev/null)
ALLOWED=$(json_field "$OUT" "allowed")
if [ "$ALLOWED" = "False" ] && grep -q "signed provenance ledger" <<< "$OUT"; then
  echo "  ✅ consistent forged public hashes block without signed ledger"
  PASS=$((PASS + 1))
else
  echo "  ❌ consistent forged public hashes passed gate: $OUT"
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
