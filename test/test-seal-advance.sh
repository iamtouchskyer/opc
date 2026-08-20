#!/usr/bin/env bash
set -euo pipefail

# Test: seal + advance commands

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS=(node "$SCRIPT_DIR/bin/opc-harness.mjs")
PASS=0; FAIL=0

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

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

echo "=== TEST GROUP 1: seal — basic artifact scanning ==="

D1="$TMPD/s1"
mkdir -p "$D1/nodes/review/run_1"
echo '{"version":"1.0","flowTemplate":"review","currentNode":"review","entryNode":"review","totalSteps":0,"_written_by":"opc-harness","_write_nonce":"abc","_last_modified":"2025-01-01","history":[],"edgeCounts":{}}' > "$D1/flow-state.json"

# Create eval files
cat > "$D1/nodes/review/run_1/eval-architect.md" << 'EVALEOF'
# Eval: Architecture Review
**ITERATE**
## Findings
- 🔴 Critical issue found
- 🟡 Warning about design
- 🔵 Suggestion for improvement
EVALEOF

cat > "$D1/nodes/review/run_1/eval-engineer.md" << 'EVALEOF'
# Eval: Engineering Review
**PASS**
## Findings
- 🟡 Minor code style issue
EVALEOF

SEAL_OUT=$(cd "$D1" && "${HARNESS[@]}" seal --node review --dir "$D1" 2>/dev/null)
check "seal produces JSON" 'echo "$SEAL_OUT" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null'
check "seal reports sealed=true" 'echo "$SEAL_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"sealed\"]==True"'
check "seal finds 2 artifacts" 'echo "$SEAL_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"artifacts\"]==2, str(d[\"artifacts\"])"'

# Check handshake.json was written
check "handshake.json exists" '[ -f "$D1/nodes/review/handshake.json" ]'
HS=$(cat "$D1/nodes/review/handshake.json")
check "handshake has findings.critical=1" 'echo "$HS" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"findings\"][\"critical\"]==1"'
check "handshake has findings.warning=2" 'echo "$HS" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"findings\"][\"warning\"]==2"'

echo ""
echo "=== TEST GROUP 2: seal — review node warns on < 2 evals ==="

D2="$TMPD/s2"
mkdir -p "$D2/nodes/review/run_1"
echo '{"version":"1.0","flowTemplate":"review","currentNode":"review","entryNode":"review","totalSteps":0,"_written_by":"opc-harness","_write_nonce":"abc","_last_modified":"2025-01-01","history":[],"edgeCounts":{}}' > "$D2/flow-state.json"
echo "# Solo eval" > "$D2/nodes/review/run_1/eval-solo.md"

SEAL_ERR=$(cd "$D2" && "${HARNESS[@]}" seal --node review --dir "$D2" 2>&1 1>/dev/null || true)
check "warns about < 2 evals for review" 'echo "$SEAL_ERR" | grep -q "expected.*2"'

echo ""
echo "=== TEST GROUP 3: seal — no run dirs ==="

D3="$TMPD/s3"
mkdir -p "$D3/nodes/build"
echo '{"version":"1.0","flowTemplate":"build-verify","currentNode":"build","entryNode":"build","totalSteps":0,"_written_by":"opc-harness","_write_nonce":"abc","_last_modified":"2025-01-01","history":[],"edgeCounts":{}}' > "$D3/flow-state.json"

SEAL_FAIL=$(cd "$D3" && "${HARNESS[@]}" seal --node build --dir "$D3" 2>/dev/null)
check "seal fails when no run dirs" 'echo "$SEAL_FAIL" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"sealed\"]==False"'

echo ""
echo "=== TEST GROUP 4: advance — error on non-gate ==="

D4="$TMPD/s4"
mkdir -p "$D4/nodes/review"
echo '{"version":"1.0","flowTemplate":"review","currentNode":"review","entryNode":"review","totalSteps":0,"_written_by":"opc-harness","_write_nonce":"abc","_last_modified":"2025-01-01","history":[],"edgeCounts":{}}' > "$D4/flow-state.json"

ADV_OUT=$(cd "$D4" && "${HARNESS[@]}" advance --dir "$D4" 2>/dev/null)
check "advance fails on non-gate node" 'echo "$ADV_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"advanced\"]==False"'
check "advance error mentions gate" 'echo "$ADV_OUT" | grep -q "gate"'

echo ""
echo "=== TEST GROUP 5: seal — brief artifacts satisfy validator ==="

D5="$TMPD/s5"
mkdir -p "$D5/nodes/brief/run_1"
echo '{"version":"1.0","flowTemplate":"build-verify","currentNode":"brief","entryNode":"brief","totalSteps":0,"_written_by":"opc-harness","_write_nonce":"abc","_last_modified":"2025-01-01","history":[],"edgeCounts":{}}' > "$D5/flow-state.json"
cat > "$D5/nodes/brief/build-brief.md" <<'BRIEF'
## File Plan
- index.html — main entry, ~200 lines
- styles.css — all styles, ~150 lines

## Technology Decisions
- Chart.js v4.4.0 via https://cdn.jsdelivr.net/npm/chart.js@4.4.0
- Tailwind CSS v3.4.1 via CDN

## Design Tokens (resolved)
- Primary: #0EA5E9
- Background: #FFFFFF
- Text: #1E293B

## Component Inventory
- Dashboard: 4 cards showing KPI (¥126,560 revenue, 8,846 visits)
- Button: copy share link control with "Copied!" confirmation

## Constraints
- Contrast: 4.5:1 body, 3:1 large text
- Responsive: 992px, 768px, 375px breakpoints
- Animation: 200ms ease-out transitions
BRIEF
echo '{"pass":true}' > "$D5/nodes/brief/run_1/brief-lint-result.json"
SEAL_BRIEF=$(cd "$D5" && "${HARNESS[@]}" seal --node brief --dir "$D5" 2>/dev/null)
check "brief seal has no validation errors" 'echo "$SEAL_BRIEF" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"validationErrors\"]==[], d[\"validationErrors\"]"'
check "brief handshake includes brief artifact" 'python3 - "$D5/nodes/brief/handshake.json" <<PY
import json,sys
d=json.load(open(sys.argv[1]))
assert any(a["type"]=="brief" for a in d["artifacts"])
PY'
check "brief handshake includes report artifact" 'python3 - "$D5/nodes/brief/handshake.json" <<PY
import json,sys
d=json.load(open(sys.argv[1]))
assert any(a["type"]=="report" for a in d["artifacts"])
PY'

echo ""
echo "=== TEST GROUP 6: seal — recursive source and canonical eval parser ==="

D6="$TMPD/s6"
mkdir -p "$D6/nodes/build/run_1/src" "$D6/nodes/review/run_1"
echo '{"version":"1.0","flowTemplate":"build-verify","currentNode":"build","entryNode":"build","totalSteps":0,"_written_by":"opc-harness","_write_nonce":"abc","_last_modified":"2025-01-01","history":[],"edgeCounts":{}}' > "$D6/flow-state.json"
echo 'export const x = 1;' > "$D6/nodes/build/run_1/src/app.ts"
echo '.copy { color: black; }' > "$D6/nodes/build/run_1/src/app.css"
SEAL_BUILD=$(cd "$D6" && "${HARNESS[@]}" seal --node build --dir "$D6" 2>/dev/null)
check "build seal finds recursive source artifacts" 'python3 - "$D6/nodes/build/handshake.json" <<PY
import json,sys
d=json.load(open(sys.argv[1]))
sources=[a for a in d["artifacts"] if a["type"]=="source"]
assert len(sources)>=2, sources
PY'
cat > "$D6/nodes/review/run_1/eval-frontend.md" <<'EOF'
# Frontend Review

No 🔴 critical findings remain. The prior 🟡 issue was fixed.

VERDICT: PASS FINDINGS[0]
EOF
cat > "$D6/nodes/review/run_1/eval-skeptic-owner.md" <<'EOF'
# Skeptic Owner Review

[CRITICAL] src/app.ts:1 — demo critical finding
Reasoning: This line is intentionally cited.
→ Fix: remove the demo issue.

VERDICT: FAIL FINDINGS[1]
EOF
python3 - "$D6/flow-state.json" <<'PY'
import json, sys
path = sys.argv[1]
state = json.load(open(path))
state["currentNode"] = "review"
state["history"] = [{"nodeId": "review", "runId": "run_1", "timestamp": "2026-01-01T00:00:00.000Z"}]
state["totalSteps"] = 1
json.dump(state, open(path, "w"))
PY
SEAL_REVIEW=$(cd "$D6" && "${HARNESS[@]}" seal --node review --dir "$D6" 2>/dev/null)
check "referential severity prose does not inflate warnings" 'python3 - "$D6/nodes/review/handshake.json" <<PY
import json,sys
d=json.load(open(sys.argv[1]))
assert d["findings"]["warning"] == 0, d["findings"]
PY'
check "text severity critical makes seal FAIL" 'python3 - "$D6/nodes/review/handshake.json" <<PY
import json,sys
d=json.load(open(sys.argv[1]))
assert d["verdict"] == "FAIL", d
assert d["findings"]["critical"] == 1, d["findings"]
PY'

echo ""
echo "=== TEST GROUP 7: seal — test-execution spec is not result evidence ==="

D7="$TMPD/s7"
mkdir -p "$D7/nodes/test-execute/run_1"
echo '{"version":"1.0","flowTemplate":"build-verify","currentNode":"test-execute","entryNode":"test-execute","totalSteps":0,"_written_by":"opc-harness","_write_nonce":"abc","_last_modified":"2025-01-01","history":[],"edgeCounts":{}}' > "$D7/flow-state.json"
cat > "$D7/nodes/test-execute/test-execution.json" <<'JSON'
{ "testCommand": "echo ok" }
JSON
echo "ok" > "$D7/nodes/test-execute/run_1/cli-output.txt"
SEAL_EXEC=$(cd "$D7" && "${HARNESS[@]}" seal --node test-execute --dir "$D7" 2>/dev/null)
check "test-execution.json is classified as plan/spec" 'python3 - "$D7/nodes/test-execute/handshake.json" <<PY
import json,sys
d=json.load(open(sys.argv[1]))
assert any(a["type"]=="test-plan" and a["path"]=="test-execution.json" for a in d["artifacts"]), d["artifacts"]
assert not any(a["type"]=="test-result" and a["path"]=="test-execution.json" for a in d["artifacts"]), d["artifacts"]
PY'
check "test-execution spec does not trigger result provenance errors" 'echo "$SEAL_EXEC" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"validationErrors\"]==[], d[\"validationErrors\"]"'

printf '{broken' > "$D7/nodes/test-execute/test-execution.json"
SEAL_EXEC_MALFORMED=$(cd "$D7" && "${HARNESS[@]}" seal --node test-execute --dir "$D7" 2>/dev/null)
check "malformed test-execution JSON rejects sealing" 'echo "$SEAL_EXEC_MALFORMED" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"sealed\"] is False, d"'
check "malformed test-execution JSON produces validation error" 'echo "$SEAL_EXEC_MALFORMED" | python3 -c "import json,sys; d=json.load(sys.stdin); assert any(\"test-execution.json\" in e for e in d[\"validationErrors\"]), d[\"validationErrors\"]"'
check "malformed test-execution leaves prior canonical handshake unchanged" 'python3 - "$D7/nodes/test-execute/handshake.json" <<PY
import json, sys
handshake = json.load(open(sys.argv[1]))
assert handshake["status"] == "completed", handshake
assert {"type": "test-plan", "path": "test-execution.json"} in handshake["artifacts"], handshake["artifacts"]
PY'

echo ""
echo "=== TEST GROUP 8: seal — run-level machine-readable acceptance JSON ==="

D8="$TMPD/s8"
RUN8="$D8/nodes/build/run_1"
mkdir -p "$RUN8"
echo '{"version":"1.0","flowTemplate":"build-verify","currentNode":"build","entryNode":"build","totalSteps":0,"_written_by":"opc-harness","_write_nonce":"abc","_last_modified":"2025-01-01","history":[],"edgeCounts":{}}' > "$D8/flow-state.json"
for name in \
  functional-lifecycle-assertions.json \
  functional-lifecycle-eval-extensions.json \
  functional-lifecycle-execute-handshake.json \
  immutability-fresh-before.json \
  immutability-fresh-after.json \
  immutability-fresh-comparison.json \
  runtime-parity.json; do
  printf '{"checks":[],"artifact":"%s"}\n' "$name" > "$RUN8/$name"
done
printf '{"checks":[]}\n' > "$RUN8/acceptance-report.json"
printf '{"checks":[]}\n' > "$RUN8/test-command-result.json"
printf '{"status":"internal-envelope"}\n' > "$RUN8/handshake.json"
printf '{"status":"internal-state"}\n' > "$RUN8/flow-state.json"
printf '{"status":"outside-run"}\n' > "$D8/nodes/build/outside.json"

SEAL_ACCEPTANCE=$(cd "$D8" && "${HARNESS[@]}" seal --node build --dir "$D8" 2>/dev/null)
check "build acceptance seal has no validation errors" 'echo "$SEAL_ACCEPTANCE" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"validationErrors\"]==[], d[\"validationErrors\"]"'
check "all run-level acceptance JSON files enter handshake as reports" 'python3 - "$D8/nodes/build/handshake.json" <<PY
import json, sys
handshake = json.load(open(sys.argv[1]))
artifacts = {a["path"]: a["type"] for a in handshake["artifacts"]}
expected = {
    "run_1/functional-lifecycle-assertions.json",
    "run_1/functional-lifecycle-eval-extensions.json",
    "run_1/functional-lifecycle-execute-handshake.json",
    "run_1/immutability-fresh-before.json",
    "run_1/immutability-fresh-after.json",
    "run_1/immutability-fresh-comparison.json",
    "run_1/runtime-parity.json",
}
assert expected <= artifacts.keys(), (expected - artifacts.keys(), artifacts)
assert all(artifacts[path] == "report" for path in expected), artifacts
PY'
check "named report and test-result special classifications remain specific" 'python3 - "$D8/nodes/build/handshake.json" <<PY
import json, sys
handshake = json.load(open(sys.argv[1]))
artifacts = {a["path"]: a["type"] for a in handshake["artifacts"]}
assert artifacts["run_1/acceptance-report.json"] == "report", artifacts
assert artifacts["run_1/test-command-result.json"] == "test-result", artifacts
PY'
check "seal excludes reserved state envelopes and node-level non-run JSON" 'python3 - "$D8/nodes/build/handshake.json" <<PY
import json, sys
handshake = json.load(open(sys.argv[1]))
paths = {a["path"] for a in handshake["artifacts"]}
assert "run_1/handshake.json" not in paths, paths
assert "run_1/flow-state.json" not in paths, paths
assert "outside.json" not in paths, paths
PY'

echo ""
echo "=== TEST GROUP 9: seal — malformed machine-readable JSON fails closed ==="

D9="$TMPD/s9"
RUN9="$D9/nodes/build/run_1"
mkdir -p "$RUN9"
echo '{"version":"1.0","flowTemplate":"build-verify","currentNode":"build","entryNode":"build","totalSteps":0,"_written_by":"opc-harness","_write_nonce":"abc","_last_modified":"2025-01-01","history":[],"edgeCounts":{}}' > "$D9/flow-state.json"
printf '{broken' > "$RUN9/acceptance-evidence.json"

SEAL_MALFORMED=$(cd "$D9" && "${HARNESS[@]}" seal --node build --dir "$D9" 2>/dev/null)
check "malformed acceptance JSON rejects sealing" 'echo "$SEAL_MALFORMED" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"sealed\"] is False, d"'
check "malformed acceptance JSON produces validation error" 'echo "$SEAL_MALFORMED" | python3 -c "import json,sys; d=json.load(sys.stdin); assert any(\"acceptance-evidence.json\" in e for e in d[\"validationErrors\"]), d[\"validationErrors\"]"'
check "malformed JSON does not create canonical handshake" '[ ! -f "$D9/nodes/build/handshake.json" ]'

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[ "$FAIL" -eq 0 ] || exit 1
