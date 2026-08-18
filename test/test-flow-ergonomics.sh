#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/test-helpers.sh"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
setup_tmpdir
export HOME="$(pwd -P)/home"
mkdir -p "$HOME"

check() {
  local label="$1" cond="$2"
  if eval "$cond"; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label"
    FAIL=$((FAIL + 1))
  fi
}

check_json() {
  local label="$1" expr="$2" input="$3"
  local result
  result=$(printf "%s" "$input" | python3 -c "import json,sys; d=json.load(sys.stdin); print($expr)" 2>/dev/null)
  check "$label" '[ "$result" = "True" ] || [ "$result" = "true" ]'
}

echo "=== FE1: extension-test --dev-server shorthand ==="
mkdir -p ext
cat > ext/hook.mjs <<'HOOK'
export default {
  hooks: {
    "execute.run": async (ctx) => {
      if (ctx.devServerUrl !== "http://localhost:8787") {
        throw new Error(`bad devServerUrl: ${ctx.devServerUrl || ""}`);
      }
      return { devServerUrl: ctx.devServerUrl };
    }
  }
};
HOOK
OUT=$($HARNESS extension-test --ext ext --hook execute.run --context '{"devServerUrl":"http://wrong"}' --dev-server http://localhost:8787 2>/dev/null)
check "dev-server shorthand overrides context" 'echo "$OUT" | grep -q "localhost:8787"'
OUT=$($HARNESS extension-test --ext ext --hook execute.run --context '{"devServerUrl":"http://wrong"}' --dev-server=http://localhost:8787 2>/dev/null)
check "dev-server equals form works" 'echo "$OUT" | grep -q "localhost:8787"'

echo ""
echo "=== FE2: validate/finalize resolve latest session ==="
mkdir -p project && cd project
git init -q
git config user.email test@test.com
git config user.name Test
git commit --allow-empty -m init -q
$HARNESS init --flow review --entry review --no-extensions >/dev/null 2>/dev/null
SESSION=$(node --input-type=module -e "import { getLatestSessionDir } from '$ROOT/bin/lib/util.mjs'; console.log(getLatestSessionDir());")
mkdir -p "$SESSION/nodes/review/run_1"
printf '# A\nVERDICT: PASS FINDINGS[0]\n' > "$SESSION/nodes/review/run_1/eval-a.md"
printf '# B\nVERDICT: PASS FINDINGS[0]\n' > "$SESSION/nodes/review/run_1/eval-b.md"
cat > "$SESSION/nodes/review/run_1/handshake.json" <<'JSON'
{
  "nodeId": "review",
  "nodeType": "review",
  "runId": "run_1",
  "status": "completed",
  "verdict": "PASS",
  "summary": "ok",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [
    { "type": "eval", "path": "eval-a.md" },
    { "type": "eval", "path": "eval-b.md" }
  ]
}
JSON
$HARNESS seal --node review --dir "$SESSION" >/dev/null 2>/dev/null
OUT=$($HARNESS validate 2>/dev/null)
check_json "validate without path uses latest current handshake" "d['valid']==True" "$OUT"
$HARNESS transition --from review --to gate --verdict PASS --flow review >/dev/null 2>/dev/null
OUT=$($HARNESS finalize 2>/dev/null)
check_json "finalize without --dir uses latest session" "d['finalized']==True" "$OUT"
cd "$TMPDIR"

echo ""
echo "=== FE3: hotfix node boundary ==="
mkdir -p hotfix && cd hotfix
$HARNESS init --flow build-verify --entry test-execute --dir .harness --no-extensions >/dev/null 2>/dev/null
mkdir -p .harness/nodes/test-execute/run_1
printf 'tests failed on trivial aria label\n' > .harness/nodes/test-execute/run_1/output.txt
cat > .harness/nodes/test-execute/handshake.json <<'JSON'
{
  "nodeId": "test-execute",
  "nodeType": "execute",
  "runId": "run_1",
  "status": "completed",
  "verdict": "ITERATE",
  "summary": "one trivial failure",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [{ "type": "cli-output", "path": "run_1/output.txt" }]
}
JSON
sync_run_handshakes ".harness"
OUT=$($HARNESS transition --from test-execute --to hotfix --verdict ITERATE --flow build-verify --dir .harness 2>/dev/null)
check_json "test-execute ITERATE routes to hotfix" "d['allowed']==True and d['next']=='hotfix'" "$OUT"

mkdir -p .harness/nodes/hotfix/run_1
mkdir -p .harness/nodes/test-design/run_1
cat > .harness/nodes/test-design/run_1/test-plan.md <<'PLAN'
# Test Plan

Run the hotfix retest command.
PLAN
cat > .harness/nodes/test-design/run_1/test-execution.json <<'JSON'
{ "runId": "run_1", "testCommand": "printf retest > hotfix-retest.txt", "timeoutMs": 10000 }
JSON
cat > .harness/nodes/test-design/run_1/handshake.json <<'JSON'
{
  "nodeId": "test-design",
  "nodeType": "review",
  "runId": "run_1",
  "status": "completed",
  "verdict": "PASS",
  "summary": "Retest command selected.",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [{ "type": "test-plan", "path": "run_1/test-plan.md" }]
}
JSON
sync_run_handshakes ".harness"
python3 - <<'PY'
import json
p = ".harness/flow-state.json"
s = json.load(open(p))
s["history"] = [
  {"nodeId": "test-design", "runId": "run_1", "timestamp": "2026-01-01T00:00:00.000Z"},
  {"nodeId": "test-execute", "runId": "run_1", "timestamp": "2026-01-01T00:00:01.000Z"},
  {"nodeId": "hotfix", "runId": "run_1", "timestamp": "2026-01-01T00:00:02.000Z"},
]
s["currentNode"] = "hotfix"
s["totalSteps"] = 3
json.dump(s, open(p, "w"), indent=2)
PY
printf 'Added aria-label only.\n' > .harness/nodes/hotfix/run_1/hotfix-report.md
cat > .harness/nodes/hotfix/handshake.json <<'JSON'
{
  "nodeId": "hotfix",
  "nodeType": "hotfix",
  "runId": "run_1",
  "status": "completed",
  "verdict": "PASS",
  "summary": "Added aria-label only.",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [{ "type": "hotfix-report", "path": "run_1/hotfix-report.md" }],
  "hotfix": {
    "scope": "trivial",
    "allowedOperations": ["aria-label"],
    "forbiddenOperations": [],
    "structuralChange": false
  }
}
JSON
sync_run_handshakes ".harness"
OUT=$($HARNESS transition --from hotfix --to test-execute --verdict PASS --flow build-verify --dir .harness 2>/dev/null)
check_json "hotfix PASS routes back to test-execute evidence node" "d['allowed']==True and d['next']=='test-execute' and d['testCommandExecution']['executed']==True" "$OUT"

cat > .harness/nodes/hotfix/handshake.json <<'JSON'
{
  "nodeId": "hotfix",
  "nodeType": "hotfix",
  "runId": "run_1",
  "status": "completed",
  "verdict": "PASS",
  "summary": "Reworked component.",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [{ "type": "hotfix-report", "path": "run_1/hotfix-report.md" }],
  "hotfix": {
    "scope": "structural",
    "allowedOperations": ["component-rewrite"],
    "forbiddenOperations": ["component-rewrite"],
    "structuralChange": true
  }
}
JSON
sync_run_handshakes ".harness"
OUT=$($HARNESS validate .harness/nodes/hotfix/handshake.json 2>/dev/null)
check_json "structural hotfix handshake is rejected" "d['valid']==False and any('hotfix.scope' in e for e in d['errors'])" "$OUT"

print_results
