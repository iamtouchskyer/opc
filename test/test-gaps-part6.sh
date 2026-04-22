#!/bin/bash
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
  if [ -z "$actual" ]; then
    echo "  ❌ $desc — no JSON output (field=$field)"
    FAIL=$((FAIL + 1))
    return
  fi
  actual=$(echo "$actual" | tr -d '"')
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — expected '$expected', got '$actual'"
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

assert_not_contains() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -q "$pattern"; then
    echo "  ❌ $desc — pattern '$pattern' found but should not be"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

assert_exit_nonzero() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>/dev/null; then
    echo "  ❌ $desc — expected nonzero exit"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

echo ""
echo "=== GAP-13: Loop-tick gaps ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 13.1: complete-tick invalid status ---"
rm -rf .h-lt1 && mkdir -p .h-lt1
cat > .h-lt1/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt1/plan.md --dir .h-lt1 >/dev/null 2>/dev/null
OUT=$($HARNESS complete-tick --unit F1.1 --status invalid --artifacts dummy.txt --dir .h-lt1 2>/dev/null)
assert_field_eq "invalid status" "$OUT" "completed" "false"
assert_contains "invalid status msg" "$OUT" "invalid status"

echo ""
echo "--- 13.2: complete-tick failed status keeps same unit ---"
# Re-init
rm -rf .h-lt2 && mkdir -p .h-lt2
cat > .h-lt2/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt2/plan.md --dir .h-lt2 >/dev/null 2>/dev/null
OUT=$($HARNESS complete-tick --unit F1.1 --status failed --artifacts dummy.txt --description "it broke" --dir .h-lt2 2>/dev/null)
assert_field_eq "failed completed" "$OUT" "completed" "true"
assert_field_eq "failed same unit" "$OUT" "next_unit" "F1.1"

echo ""
echo "--- 13.3: complete-tick on terminated pipeline ---"
rm -rf .h-lt3 && mkdir -p .h-lt3
cat > .h-lt3/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt3/plan.md --dir .h-lt3 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-lt3/loop-state.json'))
d['status'] = 'terminated'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-lt3/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts dummy.txt --dir .h-lt3 2>/dev/null)
assert_field_eq "terminated blocked" "$OUT" "completed" "false"
assert_contains "terminated msg" "$OUT" "terminated"

echo ""
echo "--- 13.4: implement artifact not found ---"
rm -rf .h-lt4 && mkdir -p .h-lt4
cat > .h-lt4/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt4/plan.md --dir .h-lt4 >/dev/null 2>/dev/null
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts /nonexistent/file.json --dir .h-lt4 2>/dev/null)
assert_field_eq "artifact not found" "$OUT" "completed" "false"
assert_contains "not found msg" "$OUT" "artifact not found"

echo ""
echo "--- 13.5: implement empty artifact ---"
echo "" > empty-art.json
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts empty-art.json --dir .h-lt4 2>/dev/null)
assert_field_eq "empty artifact" "$OUT" "completed" "false"
assert_contains "empty msg" "$OUT" "empty"

echo ""
echo "--- 13.6: JSON artifact future timestamp ---"
cat > future-art.json << 'JSON'
{"tests_run":1,"passed":1,"_timestamp":"2099-12-31T23:59:59Z","durationMs":100}
JSON
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts future-art.json --dir .h-lt4 2>/dev/null)
assert_contains "future ts" "$OUT" "future timestamp"

echo ""
echo "--- 13.7: JSON artifact durationMs zero ---"
cat > zero-dur-art.json << 'JSON'
{"tests_run":1,"passed":1,"_command":"test","durationMs":0,"_timestamp":"2026-01-01T00:00:00Z"}
JSON
# Reset state to F1.1
python3 -c "
import json
d = json.load(open('.h-lt4/loop-state.json'))
d['next_unit'] = 'F1.1'
d['status'] = 'initialized'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-lt4/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts zero-dur-art.json --dir .h-lt4 2>/dev/null)
assert_contains "zero duration" "$OUT" "durationMs"

echo ""
echo "--- 13.8: UI implement needs screenshot ---"
rm -rf .h-lt5 && mkdir -p .h-lt5
cat > .h-lt5/plan.md << 'PLAN'
- F1.1: implement-ui — build UI
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt5/plan.md --dir .h-lt5 >/dev/null 2>/dev/null
echo "content" > ui-artifact.json
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts ui-artifact.json --dir .h-lt5 2>/dev/null)
assert_contains "no screenshot" "$OUT" "screenshot"

echo ""
echo "--- 13.9: validateFixArtifacts eval tamper detection ---"
rm -rf .h-lt6 && mkdir -p .h-lt6
cat > .h-lt6/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
- F1.3: fix — fix findings
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt6/plan.md --dir .h-lt6 >/dev/null 2>/dev/null

# Simulate: implement done, review done (with eval hash stored), now fix
echo "original eval content" > eval-engineer.md
echo "original eval content 2" > eval-security.md

python3 -c "
import json, hashlib
d = json.load(open('.h-lt6/loop-state.json'))
d['tick'] = 2
d['next_unit'] = 'F1.3'
d['_git_head'] = 'aaa'  # will differ from current HEAD
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
# Store eval hashes (simulating review tick output)
h1 = hashlib.sha256(open('eval-engineer.md','rb').read()).hexdigest()[:16]
h2 = hashlib.sha256(open('eval-security.md','rb').read()).hexdigest()[:16]
d['_last_review_evals'] = {'eval-engineer.md': h1, 'eval-security.md': h2}
json.dump(d, open('.h-lt6/loop-state.json', 'w'), indent=2)
"
# Tamper with one eval file
echo "TAMPERED content" > eval-engineer.md

# Create fix artifact with finding references
echo "🔴 Fixed auth.js:10" > fix-notes.md

OUT=$($HARNESS complete-tick --unit F1.3 --artifacts fix-notes.md --dir .h-lt6 2>/dev/null)
assert_field_eq "tamper detected" "$OUT" "completed" "false"
assert_contains "tamper msg" "$OUT" "modified after review"

echo ""
echo "--- 13.10: validateFixArtifacts eval file deleted ---"
# Delete the other eval file
rm -f eval-security.md
# Reset state
python3 -c "
import json
d = json.load(open('.h-lt6/loop-state.json'))
d['tick'] = 2
d['next_unit'] = 'F1.3'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-lt6/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS complete-tick --unit F1.3 --artifacts fix-notes.md --dir .h-lt6 2>/dev/null)
assert_field_eq "deleted detected" "$OUT" "completed" "false"
assert_contains "deleted msg" "$OUT" "deleted"

echo ""
echo "--- 13.11: e2e unit with no artifacts ---"
rm -rf .h-lt7 && mkdir -p .h-lt7
cat > .h-lt7/plan.md << 'PLAN'
- F1.1: e2e — end to end test
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt7/plan.md --dir .h-lt7 >/dev/null 2>/dev/null
OUT=$($HARNESS complete-tick --unit F1.1 --dir .h-lt7 2>/dev/null)
assert_field_eq "e2e no artifacts" "$OUT" "completed" "false"
assert_contains "e2e needs evidence" "$OUT" "verification evidence"

echo ""
echo "--- 13.12: review without severity markers ---"
rm -rf .h-lt8 && mkdir -p .h-lt8
cat > .h-lt8/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt8/plan.md --dir .h-lt8 >/dev/null 2>/dev/null
# Skip to F1.2
python3 -c "
import json
d = json.load(open('.h-lt8/loop-state.json'))
d['tick'] = 1
d['next_unit'] = 'F1.2'
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
json.dump(d, open('.h-lt8/loop-state.json', 'w'), indent=2)
"
echo "Just some text without any markers" > eval-a.md
echo "Another review without severity emojis" > eval-b.md
OUT=$($HARNESS complete-tick --unit F1.2 --artifacts eval-a.md,eval-b.md --dir .h-lt8 2>/dev/null)
assert_field_eq "no markers" "$OUT" "completed" "false"
assert_contains "no markers msg" "$OUT" "severity markers"

echo ""
echo "--- 13.13: review identical files detected ---"
rm -rf .h-lt9 && mkdir -p .h-lt9
cat > .h-lt9/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt9/plan.md --dir .h-lt9 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-lt9/loop-state.json'))
d['tick'] = 1
d['next_unit'] = 'F1.2'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-lt9/loop-state.json', 'w'), indent=2)
"
cat > dup-eval-a.md << 'EVAL'
# Security Review
VERDICT: PASS FINDINGS[1]
🔵 Minor — utils.js:5 — add input validation
EVAL
cp dup-eval-a.md dup-eval-b.md
OUT=$($HARNESS complete-tick --unit F1.2 --artifacts dup-eval-a.md,dup-eval-b.md --dir .h-lt9 2>/dev/null)
assert_field_eq "identical evals" "$OUT" "completed" "false"
assert_contains "identical msg" "$OUT" "identical"


print_results
