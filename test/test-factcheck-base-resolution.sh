#!/bin/bash
set -e

# F9: fact-check ref resolution must also look in the session dir, not only --base.
#     An eval legitimately citing a session artifact (e.g. test-plan.md) must NOT
#     be flagged invalidRef just because that artifact lives outside the project base.
# F2: a non-git --base must not (a) leak git's "fatal: not a git repository" to the
#     terminal, nor (b) silently skip change-scope verification. It must emit an
#     explicit verificationWarnings entry so "verification didn't run" is visible.

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else json.dumps(v))" 2>/dev/null
}

assert_contains() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -q "$pattern"; then
    echo "  ✅ $desc"; PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — pattern '$pattern' not found"; FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -q "$pattern"; then
    echo "  ❌ $desc — pattern '$pattern' found (should not be)"; FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"; PASS=$((PASS + 1))
  fi
}

assert_field_eq() {
  local desc="$1" json="$2" field="$3" expected="$4" actual
  actual=$(jq_field "$json" "$field")
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $desc"; PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — $field: expected $expected, got $actual"; FAIL=$((FAIL + 1))
  fi
}

# Build a git project base with N committed files. Echoes the base path.
make_git_base() {
  local b
  b=$(mktemp -d)
  ( cd "$b" \
    && git init -q . \
    && git config user.email t@t.t \
    && git config user.name t \
    && echo "export function realThing() { return 1; }" > real.ts \
    && echo "export const other = 2;" > other.ts \
    && git add . \
    && git commit -q -m init ) >/dev/null 2>&1
  echo "$b"
}

# Build a NON-git base dir with one source file. Echoes the base path.
make_nongit_base() {
  local b
  b=$(mktemp -d)
  echo "export function realThing() { return 1; }" > "$b/real.ts"
  echo "$b"
}

setup_session() {
  rm -rf .harness
  mkdir -p .harness/nodes/code-review/run_1
  cat > .harness/flow-state.json << 'EOF'
{"currentNode":"code-review","history":[{"node":"code-review","run":1}],"edgeCounts":{},"stepCount":1}
EOF
}

echo "=== Fact-check base/session ref resolution (F2 + F9) ==="

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- F9.1: eval cites a SESSION artifact not in --base → NOT invalidRef ---"
setup_session
# session-relative artifact lives next to the flow-state, outside project base
cat > .harness/test-plan.md << 'EOF'
# Test Plan
L1 unit coverage
L2 integration coverage
L3 pagination coverage scenario — empty page and last page
L4 e2e coverage
L5 a11y coverage
EOF
cat > .harness/nodes/code-review/run_1/eval-tester.md << 'EOF'
# Test Design Review

🔵 test-plan.md:4 — pagination coverage scenario is under-specified

**Reasoning:** the plan omits pagination boundary tests for empty and last page.

**Fix:** add explicit pagination coverage cases.
EOF
BASE_F9=$(make_git_base)
OUT=$($HARNESS synthesize .harness --node code-review --base "$BASE_F9" 2>/dev/null)
assert_not_contains "session ref not flagged as fabricated" "$OUT" "fabricated refs detected"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- F9.2 (guard): a GENUINELY missing ref is still invalidRef ---"
setup_session
cat > .harness/nodes/code-review/run_1/eval-tester.md << 'EOF'
# Review

🔵 src/ghost-nonexistent-9999.ts:5 — references a file that exists nowhere

**Reasoning:** this file does not exist in base or session.

**Fix:** n/a.
EOF
BASE_F9B=$(make_git_base)
OUT=$($HARNESS synthesize .harness --node code-review --base "$BASE_F9B" 2>/dev/null)
assert_contains "genuine fake ref still flagged fabricated" "$OUT" "fabricated refs detected"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- F2.1: non-git --base emits explicit verificationWarnings ---"
setup_session
cat > .harness/nodes/code-review/run_1/eval-tester.md << 'EOF'
# Review

🟡 real.ts:1 — realThing returns a magic number

**Reasoning:** realThing hardcodes a return value.

**Fix:** make realThing configurable.
EOF
BASE_NG=$(make_nongit_base)
OUT=$($HARNESS synthesize .harness --node code-review --base "$BASE_NG" 2>/dev/null)
assert_contains "non-git base surfaces verificationWarnings" "$OUT" "verificationWarnings"
assert_contains "verificationWarnings explains git repo requirement" "$OUT" "not a git repository"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- F2.2: non-git --base does NOT leak git stderr to terminal ---"
setup_session
cat > .harness/nodes/code-review/run_1/eval-tester.md << 'EOF'
# Review

🟡 real.ts:1 — realThing returns a magic number

**Reasoning:** realThing hardcodes a return value.

**Fix:** make realThing configurable.
EOF
BASE_NG2=$(make_nongit_base)
ERR=$($HARNESS synthesize .harness --node code-review --base "$BASE_NG2" 2>&1 1>/dev/null)
assert_not_contains "no git 'fatal:' leaked to stderr" "$ERR" "fatal:"
assert_not_contains "no git 'usage:' leaked to stderr" "$ERR" "usage: git"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- F2.3 (guard): git --base happy path emits no false verificationWarnings ---"
setup_session
cat > .harness/nodes/code-review/run_1/eval-tester.md << 'EOF'
# Review

🟡 real.ts:1 — realThing returns a magic number

**Reasoning:** realThing hardcodes a return value.

**Fix:** make realThing configurable.
EOF
BASE_G=$(make_git_base)
OUT=$($HARNESS synthesize .harness --node code-review --base "$BASE_G" 2>/dev/null)
assert_field_eq "git base → verificationWarnings absent" "$OUT" "verificationWarnings" "__NULL__"

# ───────────────────────────────────────────────────────────────
# F2.4: non-git --base is an infrastructure evidence gap, not a product defect.
#       A 🔵-suggestion-only eval should keep its PASS verdict while surfacing
#       verificationWarnings loudly for the operator/report layer.
#       NOTE: the eval is written as the mandatory 'skeptic-owner' role so the
#       mandatory-role check does NOT add its own warning — that would mask the
#       policy by making the verdict ITERATE for an unrelated reason.
echo ""
echo "--- F2.4: 🔵-only eval + non-git --base keeps PASS with warning ---"
setup_session
cat > .harness/nodes/code-review/run_1/eval-skeptic-owner.md << 'EOF'
# Skeptic Owner Review

🔵 real.ts:1 — realThing could expose a named constant

**Reasoning:** a named constant would read better than a literal.

**Fix:** extract the magic number to a const.
EOF
BASE_NG3=$(make_nongit_base)
OUT=$($HARNESS synthesize .harness --node code-review --base "$BASE_NG3" 2>/dev/null)
assert_field_eq "non-git base does not false-red verdict" "$OUT" "verdict" '"PASS"'
assert_contains "non-git base still surfaces warning" "$OUT" "verificationWarnings"

print_results
