#!/usr/bin/env bash
# test-gaps5 — split part
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
OUT=$($HARNESS init-loop --skip-scope --dir .harness 2>/dev/null)
assert_field_eq "$OUT" "['initialized']" "True" "10.1a: init-loop --skip-scope works without package.json"

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
OUT=$($HARNESS init-loop --skip-scope --dir .harness 2>/dev/null)
assert_field_eq "$OUT" "['initialized']" "True" "10.2a: init-loop --skip-scope works with corrupt package.json"

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
OUT=$($HARNESS init-loop --skip-scope --dir .harness 2>/dev/null)
assert_field_eq "$OUT" "['initialized']" "True" "10.3a: init-loop --skip-scope succeeds with pre-commit hook"
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


print_results
