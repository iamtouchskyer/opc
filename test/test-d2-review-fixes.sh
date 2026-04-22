#!/bin/bash
# Regression tests for review findings on D2 new layers + evaluatorGuidance
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

# ── helpers ──
assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label — expected to find '$needle'"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  ❌ $label — should NOT contain '$needle'"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  fi
}

setup_review_node() {
  rm -rf .harness
  $HARNESS init --flow review --entry review --dir .harness 2>/dev/null
  mkdir -p .harness/nodes/code-review/run_1
}

# ═══════════════════════════════════════════════════════════════
echo "=== TEST: aspirationalClaims only scans finding lines ==="
# Prose with "long-term" and "future improvement" should NOT trigger
# Only finding/fix/reasoning lines with aspirational patterns count

setup_review_node
{
  echo "# Security Review"
  echo ""
  echo "This codebase has long-term tech debt that future improvement cycles should address."
  echo "The long-term architecture needs rethinking."
  echo "Future enhancement: consider modular design."
  echo ""
  echo "## Findings"
  echo ""
  echo "🔴 src/auth.ts:10 — SQL injection vulnerability"
  echo "Reasoning: User input concatenated into query string."
  echo "→ Use parameterized queries."
  echo ""
  echo "🟡 src/db.ts:25 — N+1 query pattern"
  echo "Reasoning: Each user triggers separate role query."
  echo "→ Use batch loading."
  echo ""
  echo "🟡 src/api.ts:42 — Uncaught promise rejection"
  echo "Reasoning: Missing try/catch in async middleware."
  echo "→ Add error boundary."
  echo ""
  echo "## Summary"
  echo "VERDICT: ITERATE FINDINGS[3]"
  for i in $(seq 1 20); do echo "Detailed analysis line $i covering auth and db patterns."; done
} > .harness/nodes/code-review/run_1/eval-security.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
# aspirationalClaims: false in role JSON is fine; check that no aspirational WARNING fired
assert_not_contains "1.1: prose long-term not aspirational warning" "$OUT" "aspirational.*claims"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST: aspirationalClaims DOES fire on finding lines ==="

setup_review_node
{
  echo "# Code Review"
  echo ""
  echo "## Findings"
  echo ""
  echo "🔴 src/auth.ts:10 — Password handling"
  echo "It would be nice to hash passwords before storage."
  echo "→ Should consider using bcrypt."
  echo ""
  echo "🟡 src/auth.ts:20 — Session management"
  echo "Worth exploring reducing session timeout."
  echo "→ May want to set maxAge=1800."
  echo ""
  echo "🟡 src/auth.ts:30 — Rate limiting"
  echo "Reasoning: Could be improved with rate limiting."
  echo "→ Ideally add a rate limiter middleware."
  echo ""
  echo "## Summary"
  echo "VERDICT: ITERATE FINDINGS[3]"
  for i in $(seq 1 25); do echo "Review line $i with unique detailed content."; done
} > .harness/nodes/code-review/run_1/eval-lazy.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_contains "2.1: finding-line aspirational fires" "$OUT" "aspirational"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST: changeScopeCoverage path matching ==="
# Full-path and parent/file matching should work, not just basename

BASE_DIR=$(mktemp -d)
mkdir -p "$BASE_DIR/src/utils" "$BASE_DIR/src/auth" "$BASE_DIR/tests"
git -C "$BASE_DIR" init -q
git -C "$BASE_DIR" config user.email "t@t.com"
git -C "$BASE_DIR" config user.name "T"
echo "init" > "$BASE_DIR/dummy.txt"
git -C "$BASE_DIR" add -A && git -C "$BASE_DIR" commit -q -m "init"
# Create files in second commit
echo "a" > "$BASE_DIR/src/utils/index.ts"
echo "b" > "$BASE_DIR/src/auth/index.ts"
echo "c" > "$BASE_DIR/tests/index.ts"
echo "d" > "$BASE_DIR/src/auth/handler.ts"
git -C "$BASE_DIR" add -A && git -C "$BASE_DIR" commit -q -m "add files"

setup_review_node
{
  echo "# Code Review"
  echo ""
  echo "## Auth"
  echo "🔴 src/auth/index.ts:1 — Auth issue"
  echo "Reasoning: Concrete reason."
  echo "→ Fix it."
  echo ""
  echo "## Handler"
  echo "🟡 src/auth/handler.ts:1 — Handler issue"
  echo "Reasoning: Concrete reason."
  echo "→ Fix it."
  echo ""
  echo "## Summary"
  echo "VERDICT: ITERATE FINDINGS[2]"
  for i in $(seq 1 30); do echo "Detailed review content line $i about auth patterns."; done
} > .harness/nodes/code-review/run_1/eval-scope.md

OUT=$($HARNESS synthesize .harness --node code-review --base "$BASE_DIR" 2>/dev/null)
# Eval mentions 2/4 diff files (auth/index.ts + auth/handler.ts) = 50% > 30% → should NOT trigger warning
assert_not_contains "3.1: 50% coverage = no scope warning" "$OUT" "cover change scope"

rm -rf "$BASE_DIR"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST: evaluatorGuidance exhaustive hint coverage ==="
# LAYER_HINTS must cover all ALL_LAYER_KEYS — tested by runtime check
# If we can run synthesize at all, the exhaustive check passed

setup_review_node
{
  echo "# Quick Review"
  echo "Looks fine."
  echo "🔴 bad — thing"
  echo "VERDICT: ITERATE FINDINGS[1]"
  for i in $(seq 1 12); do echo "Filler $i."; done
} > .harness/nodes/code-review/run_1/eval-test.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_contains "4.1: synthesize runs (hints exhaustive check passed)" "$OUT" "verdict"
assert_contains "4.2: guidance has hints array" "$OUT" "hints"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST: git timeout produces warning, not crash ==="
# Can't easily test real timeout, but verify synthesize works with --base on non-git dir

NOGIT_DIR=$(mktemp -d)
mkdir -p "$NOGIT_DIR/src"
echo "code" > "$NOGIT_DIR/src/app.ts"

setup_review_node
{
  echo "# Code Review"
  echo "## Findings"
  echo "🔴 src/app.ts:1 — Issue found"
  echo "Reasoning: Real issue."
  echo "→ Fix it."
  echo "VERDICT: ITERATE FINDINGS[1]"
  for i in $(seq 1 30); do echo "Review line $i."; done
} > .harness/nodes/code-review/run_1/eval-nogit.md

OUT=$($HARNESS synthesize .harness --node code-review --base "$NOGIT_DIR" 2>/dev/null)
# Should not crash, changeScopeCoverage just skips
assert_contains "5.1: synthesize succeeds on non-git base" "$OUT" "verdict"

rm -rf "$NOGIT_DIR"

print_results
