#!/bin/bash
# test-tier — split part
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

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

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 4: verify — file:line reality check (Gap 1) ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 4.1: Finding with non-existent file rejected ---"
rm -rf .h-g1 && mkdir -p .h-g1 && cd .h-g1
cat > eval.md << 'EVAL'
# Review
## Findings
🔴 Bug in nonexistent.js:10 — file does not exist
→ Fix it
Reasoning: fabricated reference
## VERDICT
VERDICT: FAIL
EVAL
OUT=$($HARNESS verify eval.md 2>/dev/null)
COUNT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['invalid_file_refs_count'])")
if [ "$COUNT" -eq 1 ]; then
  echo "  ✅ invalid file ref detected"
  PASS=$((PASS + 1))
else
  echo "  ❌ invalid_file_refs_count=$COUNT"
  FAIL=$((FAIL + 1))
fi
assert_contains "reason: file does not exist" "$OUT" "file does not exist"
cd ..

echo ""
echo "--- 4.2: Finding with out-of-range line number rejected ---"
rm -rf .h-g2 && mkdir -p .h-g2 && cd .h-g2
echo "one line only" > src.js
cat > eval.md << 'EVAL'
# Review
## Findings
🔴 Bug in src.js:999 — line way beyond file length
→ Fix it
Reasoning: fabricated line number
## VERDICT
VERDICT: FAIL
EVAL
OUT=$($HARNESS verify eval.md 2>/dev/null)
COUNT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['invalid_file_refs_count'])")
if [ "$COUNT" -eq 1 ]; then
  echo "  ✅ out-of-range line detected"
  PASS=$((PASS + 1))
else
  echo "  ❌ count=$COUNT"
  FAIL=$((FAIL + 1))
fi
assert_contains "reason: line outside file" "$OUT" "outside file"
cd ..

echo ""
echo "--- 4.3: Valid file:line passes ---"
rm -rf .h-g3 && mkdir -p .h-g3 && cd .h-g3
printf "line 1\nline 2\nline 3\nline 4\nline 5\n" > src.js
cat > eval.md << 'EVAL'
# Review
## Findings
🔴 Bug in src.js:3 — valid line
→ Fix it
Reasoning: real reference
## VERDICT
VERDICT: FAIL
EVAL
OUT=$($HARNESS verify eval.md 2>/dev/null)
COUNT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['invalid_file_refs_count'])")
if [ "$COUNT" -eq 0 ]; then
  echo "  ✅ valid ref accepted"
  PASS=$((PASS + 1))
else
  echo "  ❌ count=$COUNT (should be 0)"
  FAIL=$((FAIL + 1))
fi
cd ..

echo ""
echo "--- 4.4: evidence_complete false when invalid refs present ---"
rm -rf .h-g4 && mkdir -p .h-g4 && cd .h-g4
cat > eval.md << 'EVAL'
# Review
## Findings
🔴 Bug in ghost.js:5 — ghost file
→ Fix it
Reasoning: fake
## VERDICT
VERDICT: FAIL
EVAL
OUT=$($HARNESS verify eval.md 2>/dev/null)
COMPLETE=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['evidence_complete'])")
if [ "$COMPLETE" = "False" ]; then
  echo "  ✅ evidence_complete=false with invalid refs"
  PASS=$((PASS + 1))
else
  echo "  ❌ evidence_complete=$COMPLETE"
  FAIL=$((FAIL + 1))
fi
cd ..

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 5: validate — tierCoverage enforcement (Gap 2) ==="
# ═══════════════════════════════════════════════════════════════

setup_tier_flow() {
  local dir="$1"
  rm -rf "$dir"
  $HARNESS init --flow full-stack --tier polished --entry test-execute --dir "$dir" 2>/dev/null >/dev/null
  mkdir -p "$dir/nodes/test-execute/run_1"
  touch "$dir/nodes/test-execute/run_1/screen.png"
}

echo "--- 5.1: Execute node missing tierCoverage rejected ---"
setup_tier_flow .h-t1
cat > .h-t1/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran tests",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "run_1/screen.png"}]
}
HS
sync_run_handshakes .h-t1
OUT=$($HARNESS validate .h-t1/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "missing tierCoverage rejected" "$OUT" "valid" "false"
assert_contains "explains missing tierCoverage" "$OUT" "tierCoverage"

echo ""
echo "--- 5.2: tierCoverage with all items covered accepted ---"
setup_tier_flow .h-t2
echo "npm test: 42 passed, 0 failed" > .h-t2/nodes/test-execute/run_1/test-output.txt
cat > .h-t2/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran tests",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "run_1/screen.png"}, {"type": "cli-output", "path": "run_1/test-output.txt"}],
  "tierCoverage": {
    "covered": ["typography","color-scheme","navigation","responsive","code-blocks","tables","loading-states","error-states","favicon-meta","focus-styles","testing-md"],
    "skipped": []
  }
}
HS
sync_run_handshakes .h-t2
OUT=$($HARNESS validate .h-t2/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "full coverage accepted" "$OUT" "valid" "true"

echo ""
echo "--- 5.3: Skipped without reason rejected ---"
setup_tier_flow .h-t3
cat > .h-t3/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "run_1/screen.png"}],
  "tierCoverage": {
    "covered": ["typography","color-scheme","navigation","responsive","code-blocks","tables","loading-states","error-states","favicon-meta"],
    "skipped": [{"key": "focus-styles", "reason": "nope"}]
  }
}
HS
sync_run_handshakes .h-t3
OUT=$($HARNESS validate .h-t3/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "short reason rejected" "$OUT" "valid" "false"
assert_contains "explains reason length" "$OUT" "min 10 chars"

echo ""
echo "--- 5.4: Unknown baseline key rejected ---"
setup_tier_flow .h-t4
cat > .h-t4/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "run_1/screen.png"}],
  "tierCoverage": {
    "covered": ["typography","banana","color-scheme","navigation","responsive","code-blocks","tables","loading-states","error-states","favicon-meta","focus-styles"],
    "skipped": []
  }
}
HS
sync_run_handshakes .h-t4
OUT=$($HARNESS validate .h-t4/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "unknown key rejected" "$OUT" "valid" "false"
assert_contains "explains unknown" "$OUT" "unknown baseline key"
assert_contains "prints valid key list" "$OUT" "Valid keys for polished"
assert_contains "points to tierCoverage schema" "$OUT" "pipeline/tier-coverage-schema.md"

echo ""
echo "--- 5.5: Missing required item rejected ---"
setup_tier_flow .h-t5
cat > .h-t5/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "run_1/screen.png"}],
  "tierCoverage": {
    "covered": ["typography","color-scheme","navigation","responsive"],
    "skipped": []
  }
}
HS
sync_run_handshakes .h-t5
OUT=$($HARNESS validate .h-t5/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "incomplete coverage rejected" "$OUT" "valid" "false"
assert_contains "lists missing item" "$OUT" "missing required baseline"

echo ""
echo "--- 5.6: Valid skip with proper reason accepted ---"
setup_tier_flow .h-t6
echo "npm test: all passed" > .h-t6/nodes/test-execute/run_1/test-output.txt
cat > .h-t6/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "run_1/screen.png"}, {"type": "cli-output", "path": "run_1/test-output.txt"}],
  "tierCoverage": {
    "covered": ["typography","color-scheme","navigation","responsive","tables","loading-states","error-states","favicon-meta","focus-styles","testing-md"],
    "skipped": [{"key": "code-blocks", "reason": "product has no code blocks — it is a marketing site with no technical content"}]
  }
}
HS
sync_run_handshakes .h-t6
OUT=$($HARNESS validate .h-t6/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "valid skip accepted" "$OUT" "valid" "true"

echo ""
echo "--- 5.7: Non-execute nodes unaffected by tier ---"
setup_tier_flow .h-t7
mkdir -p .h-t7/nodes/build
cat > .h-t7/nodes/build/handshake.json << 'HS'
{
  "nodeId": "build", "nodeType": "build", "runId": "run_1",
  "status": "completed", "summary": "built",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [], "verdict": null
}
HS
sync_run_handshakes .h-t7
python3 -c "
import json
p='.h-t7/flow-state.json'
s=json.load(open(p))
s['entryNode']='build'
s['currentNode']='build'
s['totalSteps']=1
s['history']=[{'nodeId':'build','runId':'run_1','timestamp':'2024-01-01T00:00:00.000Z'}]
json.dump(s, open(p,'w'), indent=2)
"
OUT=$($HARNESS validate .h-t7/nodes/build/handshake.json 2>/dev/null)
assert_field_eq "build node unaffected" "$OUT" "valid" "true"

echo ""
echo "--- 5.8: Functional tier — no tierCoverage required ---"
rm -rf .h-t8
$HARNESS init --flow full-stack --tier functional --entry test-execute --dir .h-t8 2>/dev/null >/dev/null
mkdir -p .h-t8/nodes/test-execute/run_1
touch .h-t8/nodes/test-execute/run_1/screen.png
cat > .h-t8/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "run_1/screen.png"}]
}
HS
sync_run_handshakes .h-t8
OUT=$($HARNESS validate .h-t8/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "functional tier no coverage needed" "$OUT" "valid" "true"

# ═══════════════════════════════════════════════════════════════


print_results
