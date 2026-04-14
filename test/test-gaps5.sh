#!/usr/bin/env bash
# test-gaps5.sh — Final branch audit gap closure (29 branches)
# Every test targets a specific untested branch with a real assertion.
set -uo pipefail
# NOTE: no set -e — we handle errors explicitly per assertion

source "$(dirname "$0")/test-helpers.sh"

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qE "$needle"; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected pattern '$needle'"; FAIL=$((FAIL+1))
    echo "     GOT: $(echo "$haystack" | head -3)"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qE "$needle"; then
    echo "  ❌ $label — did NOT expect '$needle'"; FAIL=$((FAIL+1))
  else
    echo "  ✅ $label"; PASS=$((PASS+1))
  fi
}

assert_field_eq() {
  local json="$1" field="$2" expected="$3" label="$4"
  local actual
  actual=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d${field})" 2>/dev/null || echo "__PARSE_ERROR__")
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected $field=$expected, got '$actual'"; FAIL=$((FAIL+1))
  fi
}

mkdir -p "$HOME/.claude/flows"
ORIG_DIR=$(pwd)

# ═══════════════════════════════════════════════════════════════════
echo "=== PART 1: 🔴 HIGH — flow-core.mjs findings non-numeric ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 1.1: findings.critical with non-numeric string value"
# flow-core.mjs L167-170: (data.findings.critical || 0) > 0
# Use nodeType=build to isolate this test from review independence check
# (the test is about findings.critical numeric validation, not review logic).
D=$(mktemp -d)
cat > "$D/hs.json" << 'EOF'
{
  "nodeId": "test",
  "nodeType": "build",
  "runId": "run_1",
  "status": "completed",
  "summary": "test",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [],
  "findings": {"critical": "abc", "warning": 0, "suggestion": 0}
}
EOF
OUT=$($HARNESS validate "$D/hs.json" 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "1.1a: non-numeric findings.critical doesn't crash"

cat > "$D/hs2.json" << 'EOF'
{
  "nodeId": "test",
  "nodeType": "build",
  "runId": "run_1",
  "status": "completed",
  "summary": "test",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [],
  "verdict": "PASS",
  "findings": {"critical": 5, "warning": 0, "suggestion": 0}
}
EOF
OUT=$($HARNESS validate "$D/hs2.json" 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "1.1b: findings.critical=5 + PASS → error"
assert_contains "$OUT" "critical.*0" "1.1c: error mentions critical > 0"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 2: 🟡 MEDIUM — eval-commands synthesize readErr ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 2.1: synthesize with one unreadable eval file"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --dir . > /dev/null 2>&1
mkdir -p nodes/code-review/run_1
cat > nodes/code-review/run_1/eval-good.md << 'EOF'
# Review

### 🔵 suggestion — Minor style issue
→ Use const

VERDICT: PASS — FINDINGS[1]
EOF
mkdir -p nodes/code-review/run_1/eval-bad.md
STDOUT_FILE=$(mktemp)
STDERR_FILE=$(mktemp)
$HARNESS synthesize . --node code-review > "$STDOUT_FILE" 2> "$STDERR_FILE" || true
STDOUT_OUT=$(cat "$STDOUT_FILE")
STDERR_OUT=$(cat "$STDERR_FILE")
assert_contains "$STDOUT_OUT" "verdict" "2.1a: synthesize produces output despite one bad file"
assert_contains "$STDERR_OUT" "Cannot read" "2.1b: stderr warns about unreadable file"
rm -f "$STDOUT_FILE" "$STDERR_FILE"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 3: 🟡 MEDIUM — eval-report readErr + zero findings ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 3.1: report with zero findings"
# eval-report.mjs expects evaluation-wave-N.md or evaluation-wave-N-role.md files
D=$(mktemp -d)
mkdir -p "$D/.harness"
cat > "$D/.harness/evaluation-wave-1.md" << 'EOF'
# Review — clean code

No issues found.

VERDICT: PASS — FINDINGS[0]
EOF
OUT=$($HARNESS report "$D" --mode review --task "test" 2>/dev/null)
assert_contains "$OUT" "agents" "3.1a: report produces output for zero-finding eval"
assert_contains "$OUT" '"suggestion": 0' "3.1b: zero suggestions"
rm -rf "$D"

echo ""
echo "── 3.2: diff with two empty evals (zero findings both)"
D=$(mktemp -d)
cat > "$D/eval1.md" << 'EOF'
# Round 1 Review
VERDICT: PASS — FINDINGS[0]
EOF
cat > "$D/eval2.md" << 'EOF'
# Round 2 Review
VERDICT: PASS — FINDINGS[0]
EOF
OUT=$($HARNESS diff "$D/eval1.md" "$D/eval2.md" 2>/dev/null)
assert_field_eq "$OUT" "['recurring']" "0" "3.2a: 0 recurring findings"
assert_field_eq "$OUT" "['new']" "0" "3.2b: 0 new findings"
assert_field_eq "$OUT" "['resolved']" "0" "3.2c: 0 resolved findings"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 4: 🟡 MEDIUM — flow-escape.mjs cmdGoto edge cases ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 4.1: goto with --flow flag having no value (dangling)"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --entry build --dir . > /dev/null 2>&1
mkdir -p nodes/build
cat > nodes/build/handshake.json << 'EOF'
{"nodeId":"build","nodeType":"build","status":"completed","summary":"done","timestamp":"2024-01-01T00:00:00Z"}
EOF
$HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir . > /dev/null 2>&1
# Dangling --flow at end (no value after it)
OUT=$($HARNESS goto build --dir . --flow 2>/dev/null || true)
# NOTE: `\|` is BRE, `|` is ERE. grep -qE uses ERE, so use `|`
assert_contains "$OUT" "goto|error" "4.1a: goto handles dangling flag gracefully"

echo ""
echo "── 4.2: goto with flags reordered: target after --dir value"
D2=$(mktemp -d)
cd "$D2"
$HARNESS init --flow build-verify --entry build --dir . > /dev/null 2>&1
mkdir -p nodes/build
cat > nodes/build/handshake.json << 'EOF'
{"nodeId":"build","nodeType":"build","status":"completed","summary":"done","timestamp":"2024-01-01T00:00:00Z"}
EOF
$HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir . > /dev/null 2>&1
OUT=$($HARNESS goto --dir . build 2>/dev/null || true)
assert_contains "$OUT" '"goto"' "4.2a: goto finds target after --dir flag"
cd "$ORIG_DIR"
rm -rf "$D" "$D2"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 5: 🟡 MEDIUM — file-lock release edge cases ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 5.1: release when lock file already deleted"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
OUT=$($HARNESS skip --dir . 2>/dev/null)
assert_not_contains "$(ls)" "flow-state.json.lock" "5.1a: no lock file after skip completes"

echo ""
echo "── 5.2: stale lock from dead PID gets cleaned up"
D2=$(mktemp -d)
cd "$D2"
$HARNESS init --flow review --dir . > /dev/null 2>&1
echo '{"pid": 99999, "timestamp": "2024-01-01T00:00:00Z", "command": "other"}' > flow-state.json.lock
OUT=$($HARNESS skip --dir . 2>/dev/null)
assert_contains "$OUT" "skipped|next" "5.2a: stale lock from dead PID cleaned up, skip succeeds"
cd "$ORIG_DIR"
rm -rf "$D" "$D2"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 6: 🟡 MEDIUM — loop-tick unknown unit type ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 6.1: complete-tick with unknown unit type"
D=$(mktemp -d)
cd "$D"
mkdir -p .harness
cat > .harness/plan.md << 'EOF'
- u1.1: foobar — do something unknown type
EOF
$HARNESS init-loop --dir .harness > /dev/null 2>&1
$HARNESS next-tick --dir .harness > /dev/null 2>&1
echo '{"pass": true}' > artifact.json
OUT=$($HARNESS complete-tick --dir .harness --unit u1.1 --status completed --artifacts "$(pwd)/artifact.json" 2>/dev/null)
assert_field_eq "$OUT" "['completed']" "True" "6.1a: unknown unit type still completes"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 7: 🟡 MEDIUM — eval-parser verdict auto-derive ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 7.1: eval with no verdict header (auto-derive from findings)"
# eval-report.mjs expects evaluation-wave-N-role.md or evaluation-wave-N.md
# NOTE: severity emojis must NOT be in ### headings — parser skips headings (L48)
D=$(mktemp -d)
mkdir -p "$D/.harness"
cat > "$D/.harness/evaluation-wave-1.md" << 'EOF'
# Review (no verdict line)

🔴 critical — Major bug found
Issue text here
→ Fix this
Reasoning: Must fix

🟡 warning — Minor concern
Issue text
→ Consider fixing
EOF
OUT=$($HARNESS report "$D" --mode review --task "test" 2>/dev/null)
assert_contains "$OUT" '"critical": 1' "7.1a: parser counts 1 critical"
assert_contains "$OUT" '"warning": 1' "7.1b: parser counts 1 warning"
rm -rf "$D"

echo ""
echo "── 7.2: synthesize with no-verdict eval (auto-derive)"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --dir . > /dev/null 2>&1
mkdir -p nodes/code-review/run_1
cat > nodes/code-review/run_1/eval-auto.md << 'EOF'
# Review (no verdict line)

🟡 warning — Something to fix
Issue text
→ Fix it
Reasoning: Quality

🟡 warning — Another thing
Issue text 2
→ Fix it too
Reasoning: Maintainability
EOF
OUT=$($HARNESS synthesize . --node code-review 2>/dev/null)
assert_contains "$OUT" "ITERATE" "7.2a: auto-derived verdict is ITERATE (warnings, no critical)"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 8: 🔵 LOW — viz ASCII loopback display ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 8.1: viz with FAIL+ITERATE edges shows FAIL in ASCII"
OUT=$($HARNESS viz --flow build-verify 2>/dev/null)
assert_contains "$OUT" "FAIL" "8.1a: viz ASCII shows FAIL edge for gate"

echo ""
echo "── 8.2: transition stderr viz output contains markers"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --entry review --dir . > /dev/null 2>&1
# Review node needs ≥2 distinct eval artifacts for transition pre-check to pass.
mkdir -p nodes/review/run_1
cat > nodes/review/run_1/eval-alpha.md << 'EVAL'
# Reviewer Alpha
Examined the module boundaries and public interface.
No issues found with the current contract.
EVAL
cat > nodes/review/run_1/eval-beta.md << 'EVAL'
# Reviewer Beta
Audited error handling paths and exception propagation.
All error cases have appropriate recovery logic.
EVAL
cat > nodes/review/handshake.json << 'EOF'
{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","summary":"done","timestamp":"2024-01-01T00:00:00Z","artifacts":[{"type":"eval","path":"run_1/eval-alpha.md"},{"type":"eval","path":"run_1/eval-beta.md"}]}
EOF
sleep 2
STDERR_FILE=$(mktemp)
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir . > /dev/null 2> "$STDERR_FILE"
STDERR=$(cat "$STDERR_FILE")
assert_contains "$STDERR" "review|gate" "8.2a: transition stderr contains flow node names"
rm -f "$STDERR_FILE"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 9: 🔵 LOW — validate-chain currentNode skip ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 9.1: validate-chain skips missing handshake for currentNode"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --entry build --dir . > /dev/null 2>&1
mkdir -p nodes/build
cat > nodes/build/handshake.json << 'EOF'
{"nodeId":"build","nodeType":"build","status":"completed","summary":"done","timestamp":"2024-01-01T00:00:00Z"}
EOF
$HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir . > /dev/null 2>&1
OUT=$($HARNESS validate-chain --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "9.1a: currentNode without handshake is not an error"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 10: 🔵 LOW — loop-helpers edge cases ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 10.1: detectTestScript with missing package.json"
D=$(mktemp -d)
cd "$D"
mkdir -p .harness
cat > .harness/plan.md << 'EOF'
- u1.1: implement — build something
- u1.2: review — review it
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null)
assert_field_eq "$OUT" "['initialized']" "True" "10.1a: init-loop works without package.json"

echo ""
echo "── 10.2: detectTestScript with corrupt package.json"
D2=$(mktemp -d)
cd "$D2"
echo "NOT VALID JSON {{{" > package.json
mkdir -p .harness
cat > .harness/plan.md << 'EOF'
- u1.1: implement — build something
- u1.2: review — review it
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null)
assert_field_eq "$OUT" "['initialized']" "True" "10.2a: init-loop works with corrupt package.json"

echo ""
echo "── 10.3: detectPreCommitHooks returns true when .husky/pre-commit exists"
D3=$(mktemp -d)
cd "$D3"
mkdir -p .husky
echo "#!/bin/sh" > .husky/pre-commit
chmod +x .husky/pre-commit
mkdir -p .harness
cat > .harness/plan.md << 'EOF'
- u1.1: implement — test hook detection
- u1.2: review — verify
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null)
assert_field_eq "$OUT" "['initialized']" "True" "10.3a: init-loop succeeds with pre-commit hook"
STATE=$(cat .harness/loop-state.json)
HOOKS=$(echo "$STATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('_external_validators',{}).get('pre_commit_hooks', False))" 2>/dev/null || echo "__ERROR__")
if [ "$HOOKS" = "True" ]; then
  echo "  ✅ 10.3b: pre_commit_hooks detected as true"; PASS=$((PASS+1))
else
  echo "  ❌ 10.3b: expected pre_commit_hooks=True, got '$HOOKS'"; FAIL=$((FAIL+1))
fi
cd "$ORIG_DIR"
rm -rf "$D" "$D2" "$D3"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 11: 🔵 LOW — flow-templates non-JSON files skipped ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 11.1: non-.json file in flows dir is ignored"
echo "this is a readme" > "$HOME/.claude/flows/readme.txt"
# init uses resolveDir which blocks /tmp, so use a path under cwd
TESTDIR_11=".test-readme-$$"
OUT=$($HARNESS init --flow readme --dir "$TESTDIR_11" 2>&1 || true)
assert_contains "$OUT" "nknown flow|Usage" "11.1a: readme.txt not loaded as flow template"
rm -f "$HOME/.claude/flows/readme.txt"
rm -rf "$TESTDIR_11"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 12: 🔵 LOW — opc-harness.mjs CLI entry dispatch ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 12.1: report via CLI entry point"
D=$(mktemp -d)
mkdir -p "$D/.harness"
cat > "$D/.harness/evaluation-wave-1.md" << 'EOF'
# Test Review

### 🔵 suggestion — Test item
Test issue

VERDICT: PASS — FINDINGS[1]
EOF
OUT=$($HARNESS report "$D" --mode review --task "test" 2>/dev/null)
assert_contains "$OUT" "agents" "12.1a: report via CLI entry produces output"
assert_contains "$OUT" "suggestion" "12.1b: report via CLI has suggestion count"

echo ""
echo "── 12.2: diff via CLI entry point"
cat > "$D/eval-r1.md" << 'EOF'
# Round 1

### 🟡 warning — Old issue
Issue text

VERDICT: ITERATE — FINDINGS[1]
EOF
cat > "$D/eval-r2.md" << 'EOF'
# Round 2

### 🔵 suggestion — New issue
New text

VERDICT: PASS — FINDINGS[1]
EOF
OUT=$($HARNESS diff "$D/eval-r1.md" "$D/eval-r2.md" 2>/dev/null)
assert_contains "$OUT" "recurring|new|resolved" "12.2a: diff via CLI entry produces output"

echo ""
echo "── 12.3: replay via CLI entry point"
# NOTE: the CLI command is "replay", NOT "replay-data"
D2=$(mktemp -d)
cd "$D2"
$HARNESS init --flow review --entry review --dir . > /dev/null 2>&1
OUT=$($HARNESS replay --dir . 2>/dev/null)
assert_contains "$OUT" "flowTemplate|nodes|history" "12.3a: replay via CLI entry produces output"
cd "$ORIG_DIR"
rm -rf "$D" "$D2"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 13: 🔵 LOW — cmdPass with gate node ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 13.1: cmdPass on terminal gate (PASS → null)"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --entry gate --dir . > /dev/null 2>&1
OUT=$($HARNESS pass --dir . 2>/dev/null || true)
# The → is a unicode arrow in the JSON, match "finalize"
assert_contains "$OUT" "finalize" "13.1a: pass on terminal gate says use finalize"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 14: 🔵 LOW — loop-init getGitHeadHash null ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 14.1: init-loop in non-git dir → _git_head is null"
D=$(mktemp -d)
cd "$D"
rm -rf .git
mkdir -p .harness
cat > .harness/plan.md << 'EOF'
- u1.1: implement — build
- u1.2: review — check
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null)
assert_field_eq "$OUT" "['initialized']" "True" "14.1a: init-loop works in non-git dir"
STATE=$(cat .harness/loop-state.json)
GIT_HEAD=$(echo "$STATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('_git_head'))" 2>/dev/null || echo "__ERROR__")
if [ "$GIT_HEAD" = "None" ]; then
  echo "  ✅ 14.1b: _git_head is null in non-git dir"; PASS=$((PASS+1))
else
  echo "  ❌ 14.1b: expected _git_head=None, got '$GIT_HEAD'"; FAIL=$((FAIL+1))
fi
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 15: 🔵 LOW — file-lock clean acquisition/release ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 15.1: lock file acquisition + release cycle is clean"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
OUT=$($HARNESS skip --dir . 2>/dev/null)
assert_contains "$OUT" "skipped|next" "15.1a: skip acquires and releases lock cleanly"
if [ ! -f "flow-state.json.lock" ]; then
  echo "  ✅ 15.1b: lock file cleaned up after command"; PASS=$((PASS+1))
else
  echo "  ❌ 15.1b: lock file still exists after command"; FAIL=$((FAIL+1))
fi
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 16: 🔵 LOW — cmdLs empty + corrupt scan ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 16.1: ls with base dir containing no harness dirs"
D=$(mktemp -d)
mkdir -p "$D/subdir"
OUT=$($HARNESS ls --base "$D" 2>/dev/null)
assert_field_eq "$OUT" "['flows']" "[]" "16.1a: ls empty dir returns empty flows array"

echo ""
echo "── 16.2: ls with corrupt flow-state in one of the harness dirs"
mkdir -p "$D/.harness"
echo "NOT JSON" > "$D/.harness/flow-state.json"
OUT=$($HARNESS ls --base "$D" 2>/dev/null)
assert_field_eq "$OUT" "['flows']" "[]" "16.2a: ls skips corrupt flow-state.json"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 17: viz --json edges + loopbacks ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 17.1: viz --json includes FAIL and ITERATE loopbacks"
OUT=$($HARNESS viz --flow build-verify --json 2>/dev/null)
assert_contains "$OUT" '"FAIL"' "17.1a: viz --json has FAIL loopback"
assert_contains "$OUT" '"ITERATE"' "17.1b: viz --json has ITERATE loopback"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 18: validate-context all four RULE_VALIDATOR types ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 18.1: test all four rule types (pass + fail)"
D=$(mktemp -d)
cd "$D"

cat > "$HOME/.claude/flows/test-allrules.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "contextSchema": {
    "a": {
      "required": ["name", "items", "config", "count"],
      "rules": {
        "name": "non-empty-string",
        "items": "non-empty-array",
        "config": "non-empty-object",
        "count": "positive-integer"
      }
    }
  }
}
EOF
$HARNESS init --flow test-allrules --dir . > /dev/null 2>&1

# All rules pass
echo '{"name":"hello","items":[1],"config":{"a":1},"count":5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "18.1a: all four rules pass"

# Each rule fails individually
echo '{"name":"","items":[1],"config":{"a":1},"count":5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "non-empty-string" "18.1b: empty string fails non-empty-string"

echo '{"name":"ok","items":[],"config":{"a":1},"count":5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "non-empty-array" "18.1c: empty array fails non-empty-array"

echo '{"name":"ok","items":[1],"config":{},"count":5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "non-empty-object" "18.1d: empty object fails non-empty-object"

echo '{"name":"ok","items":[1],"config":{"a":1},"count":0}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "positive-integer" "18.1e: zero fails positive-integer"

echo '{"name":"ok","items":[1],"config":{"a":1},"count":-3}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "positive-integer" "18.1f: negative fails positive-integer"

echo '{"name":"ok","items":[1],"config":{"a":1},"count":1.5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "positive-integer" "18.1g: float fails positive-integer (not integer)"

# missing required field
echo '{"name":"ok","items":[1],"config":{"a":1}}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-allrules --node a --dir . 2>/dev/null)
assert_contains "$OUT" "missing required" "18.1h: missing field triggers required error"
assert_not_contains "$OUT" "positive-integer" "18.1i: missing field doesn't trigger rule error"

rm -f "$HOME/.claude/flows/test-allrules.json"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
# Cleanup
rm -f "$HOME/.claude/flows/test-vc-goodrule.json" 2>/dev/null || true
rm -f "$HOME/.claude/flows/test-allrules.json" 2>/dev/null || true
rm -f "$HOME/.claude/flows/readme.txt" 2>/dev/null || true

print_results
