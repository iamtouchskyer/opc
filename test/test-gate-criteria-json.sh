#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

json_field() {
  echo "$1" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$2'))"
}

write_state_history() {
  local dir="$1"
  python3 - "$dir/flow-state.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["history"] = [{"nodeId": "test-execute", "runId": "run_1", "timestamp": "2026-01-01T00:00:00.000Z"}]
data["currentNode"] = "gate"
json.dump(data, open(path, "w"), indent=2)
PY
}

write_state_history_two_runs() {
  local dir="$1"
  python3 - "$dir/flow-state.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["history"] = [
  {"nodeId": "test-execute", "runId": "run_1", "timestamp": "2026-01-01T00:00:00.000Z"},
  {"nodeId": "test-execute", "runId": "run_2", "timestamp": "2026-01-01T00:01:00.000Z"},
]
data["currentNode"] = "gate"
json.dump(data, open(path, "w"), indent=2)
PY
}

write_test_execute_report_handshake() {
  local dir="$1" run_id="$2"
  python3 - "$dir/nodes/test-execute/handshake.json" "$run_id" <<'PY'
import json, sys
path, run_id = sys.argv[1], sys.argv[2]
data = {
  "nodeId": "test-execute",
  "nodeType": "execute",
  "runId": run_id,
  "status": "completed",
  "verdict": "PASS",
  "summary": "test execution report available",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [{"type": "report", "path": f"{run_id}/report.json"}]
}
open(path, "w").write(json.dumps(data))
PY
}

echo "Test: gate-criteria.json"
echo "========================"
echo ""

$HARNESS init --flow build-verify --entry gate --dir .harness >/dev/null 2>/dev/null
cat > .harness/report.json <<'JSON'
{"summary":{"average_score":1.5}}
JSON
cat > .harness/gate-criteria.json <<'JSON'
{"checks":[{"id":"ai-smell-average","source":"report.json","path":"$.summary.average_score","operator":"<","threshold":2.0}]}
JSON
OUT=$($HARNESS transition --from gate --to null --verdict PASS --flow build-verify --dir .harness 2>/dev/null)
FINALIZED=$(json_field "$OUT" "finalized")
if [ "$FINALIZED" = "True" ]; then
  echo "  ✅ passing root gate criteria allows PASS"
  PASS=$((PASS + 1))
else
  echo "  ❌ passing root gate criteria blocked: $OUT"
  FAIL=$((FAIL + 1))
fi

$HARNESS init --flow build-verify --entry gate --dir .harness-fail >/dev/null 2>/dev/null
cat > .harness-fail/report.json <<'JSON'
{"summary":{"average_score":3.1}}
JSON
cat > .harness-fail/gate-criteria.json <<'JSON'
{"checks":[{"id":"ai-smell-average","source":"report.json","path":"$.summary.average_score","operator":"<","threshold":2.0}]}
JSON
OUT=$($HARNESS transition --from gate --to null --verdict PASS --flow build-verify --dir .harness-fail 2>/dev/null)
ALLOWED=$(json_field "$OUT" "allowed")
if [ "$ALLOWED" = "False" ] && grep -q "does not satisfy" <<< "$OUT"; then
  echo "  ✅ failing root gate criteria blocks PASS"
  PASS=$((PASS + 1))
else
  echo "  ❌ failing root gate criteria did not block: $OUT"
  FAIL=$((FAIL + 1))
fi

$HARNESS init --flow build-verify --entry gate --dir .harness-run >/dev/null 2>/dev/null
mkdir -p .harness-run/nodes/test-execute/run_1
write_state_history .harness-run
cat > .harness-run/nodes/test-execute/run_1/report.json <<'JSON'
{"summary":{"average_score":4.2}}
JSON
write_test_execute_report_handshake .harness-run run_1
cat > .harness-run/nodes/test-execute/run_1/gate-criteria.json <<'JSON'
{"checks":[{"id":"run-score","source":"report.json","path":"$.summary.average_score","operator":">=","threshold":4.0}]}
JSON
OUT=$($HARNESS transition --from gate --to null --verdict PASS --flow build-verify --dir .harness-run 2>/dev/null)
FINALIZED=$(json_field "$OUT" "finalized")
if [ "$FINALIZED" = "True" ]; then
  echo "  ✅ run-level gate criteria resolves source relative to run dir"
  PASS=$((PASS + 1))
else
  echo "  ❌ run-level criteria blocked unexpectedly: $OUT"
  FAIL=$((FAIL + 1))
fi

$HARNESS init --flow build-verify --entry gate --dir .harness-retry >/dev/null 2>/dev/null
mkdir -p .harness-retry/nodes/test-execute/run_1 .harness-retry/nodes/test-execute/run_2
write_state_history_two_runs .harness-retry
cat > .harness-retry/nodes/test-execute/run_1/report.json <<'JSON'
{"summary":{"average_score":1.0}}
JSON
cat > .harness-retry/nodes/test-execute/run_1/gate-criteria.json <<'JSON'
{"checks":[{"id":"score-old","source":"report.json","path":"$.summary.average_score","operator":">=","threshold":4.0}]}
JSON
cat > .harness-retry/nodes/test-execute/run_2/report.json <<'JSON'
{"summary":{"average_score":4.5}}
JSON
write_test_execute_report_handshake .harness-retry run_2
cat > .harness-retry/nodes/test-execute/run_2/gate-criteria.json <<'JSON'
{"checks":[{"id":"score-new","source":"report.json","path":"$.summary.average_score","operator":">=","threshold":4.0}]}
JSON
OUT=$($HARNESS transition --from gate --to null --verdict PASS --flow build-verify --dir .harness-retry 2>/dev/null)
FINALIZED=$(json_field "$OUT" "finalized")
if [ "$FINALIZED" = "True" ] && ! grep -q "score-old" <<< "$OUT"; then
  echo "  ✅ stale run-level criteria ignored after retry pass"
  PASS=$((PASS + 1))
else
  echo "  ❌ stale run criteria blocked retry: $OUT"
  FAIL=$((FAIL + 1))
fi

$HARNESS init --flow build-verify --entry gate --dir .harness-missing >/dev/null 2>/dev/null
cat > .harness-missing/gate-criteria.json <<'JSON'
{"checks":[{"id":"missing-source","source":"missing.json","path":"$.x","operator":"==","threshold":1}]}
JSON
OUT=$($HARNESS transition --from gate --to null --verdict PASS --flow build-verify --dir .harness-missing 2>/dev/null)
ALLOWED=$(json_field "$OUT" "allowed")
if [ "$ALLOWED" = "False" ] && grep -q "source missing" <<< "$OUT"; then
  echo "  ✅ missing source fails closed"
  PASS=$((PASS + 1))
else
  echo "  ❌ missing source did not fail closed: $OUT"
  FAIL=$((FAIL + 1))
fi

print_results
