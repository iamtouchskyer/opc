#!/bin/bash
# Tests for _accumulateBacklog: auto-accumulation of review findings into backlog.md
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

# JSON field check via python3
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

assert_file_contains() {
  local desc="$1" file="$2" pattern="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — pattern '$pattern' not found in $file"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_not_contains() {
  local desc="$1" file="$2" pattern="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo "  ❌ $desc — pattern '$pattern' unexpectedly found in $file"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

# Helper: set up a loop and advance through implement to review
setup_at_review() {
  rm -rf .harness
  mkdir -p .harness
  cat > .harness/plan.md << 'PLAN'
- F1.1: implement-a — Build feature
  - verify: echo test
- F1.2: review-a — Review feature
  - eval: Check quality
PLAN
  $HARNESS init-loop --dir .harness --plan .harness/plan.md >/dev/null 2>/dev/null
  $HARNESS next-tick --dir .harness >/dev/null 2>/dev/null
  # Complete implement tick — use unique content per call to ensure git diff
  echo "code-$(date +%s%N)" > feature.js
  git add feature.js && git commit -q -m "feat"
  echo '{"tests_run":1,"passed":1,"_command":"test","durationMs":100}' > t.json
  $HARNESS complete-tick --dir .harness --unit F1.1 --status completed --artifacts t.json >/dev/null 2>/dev/null
  # Advance to review
  $HARNESS next-tick --dir .harness >/dev/null 2>/dev/null
}

# ═══════════════════════════════════════════════════════════════
echo "=== TEST GROUP 1: Backlog creation on FAIL verdict ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 1.1: Backlog created when review has 🔴 findings ---"
setup_at_review
mkdir -p .harness/nodes/F1.2/run_1
cat > .harness/nodes/F1.2/run_1/eval-security.md << 'EVAL'
# Security Review
## Findings
- 🔴 SQL injection vulnerability in user handler at db.js:42
- 🟡 Missing input validation on email field
EVAL
cat > .harness/nodes/F1.2/run_1/eval-perf.md << 'EVAL'
# Performance Review
## Findings
- 🔵 Consider adding index on users.email
EVAL
OUT=$($HARNESS complete-tick --dir .harness --unit F1.2 --status completed --artifacts ".harness/nodes/F1.2/run_1/eval-security.md,.harness/nodes/F1.2/run_1/eval-perf.md" 2>/dev/null)
assert_field_eq "review completes" "$OUT" "completed" "true"
assert_field_eq "verdict is FAIL" "$OUT" "verdict" '"FAIL"'

# Backlog should exist
if [ -f .harness/backlog.md ]; then
  echo "  ✅ backlog.md created"
  PASS=$((PASS + 1))
else
  echo "  ❌ backlog.md not created"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 1.2: Backlog has correct header ---"
assert_file_contains "has top-level header" .harness/backlog.md "^# Backlog"

echo ""
echo "--- 1.3: Backlog captures 🔴 findings ---"
assert_file_contains "has SQL injection finding" .harness/backlog.md "SQL injection"

echo ""
echo "--- 1.4: Backlog captures 🟡 findings ---"
assert_file_contains "has input validation finding" .harness/backlog.md "Missing input validation"

echo ""
echo "--- 1.5: Backlog does NOT capture 🔵 suggestions ---"
assert_file_not_contains "no blue suggestions" .harness/backlog.md "Consider adding index"

echo ""
echo "--- 1.6: Backlog has source tracing ---"
assert_file_contains "has source path" .harness/backlog.md "_(from .harness/nodes/F1.2/run_1/eval-security.md)_"

echo ""
echo "--- 1.7: Backlog items are checkboxes ---"
assert_file_contains "has checkbox format" .harness/backlog.md "\- \[ \]"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 2: No backlog on PASS verdict ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 2.1: No backlog when all findings are 🔵 ---"
setup_at_review
rm -f .harness/backlog.md
mkdir -p .harness/nodes/F1.2/run_1
cat > .harness/nodes/F1.2/run_1/eval-a.md << 'EVAL'
# Review A
## Findings
- 🔵 Minor style suggestion
EVAL
cat > .harness/nodes/F1.2/run_1/eval-b.md << 'EVAL'
# Review B
## Findings
LGTM — code looks good
EVAL
OUT=$($HARNESS complete-tick --dir .harness --unit F1.2 --status completed --artifacts ".harness/nodes/F1.2/run_1/eval-a.md,.harness/nodes/F1.2/run_1/eval-b.md" 2>/dev/null)
assert_field_eq "review completes" "$OUT" "completed" "true"
assert_field_eq "verdict is PASS" "$OUT" "verdict" '"PASS"'
if [ ! -f .harness/backlog.md ]; then
  echo "  ✅ no backlog.md on PASS"
  PASS=$((PASS + 1))
else
  echo "  ❌ backlog.md should not exist on PASS"
  FAIL=$((FAIL + 1))
fi

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 3: Backlog on ITERATE verdict ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 3.1: Backlog created when review has only 🟡 findings ---"
setup_at_review
rm -f .harness/backlog.md
mkdir -p .harness/nodes/F1.2/run_1
cat > .harness/nodes/F1.2/run_1/eval-a.md << 'EVAL'
# Code Review
## Findings
- 🟡 Missing error handling in API response at handler.js:15
- 🟡 Should add rate limiting to login endpoint
EVAL
cat > .harness/nodes/F1.2/run_1/eval-b.md << 'EVAL'
# Architecture Review
## Findings
- 🔵 Nice separation of concerns
EVAL
OUT=$($HARNESS complete-tick --dir .harness --unit F1.2 --status completed --artifacts ".harness/nodes/F1.2/run_1/eval-a.md,.harness/nodes/F1.2/run_1/eval-b.md" 2>/dev/null)
assert_field_eq "verdict is ITERATE" "$OUT" "verdict" '"ITERATE"'
if [ -f .harness/backlog.md ]; then
  echo "  ✅ backlog.md created on ITERATE"
  PASS=$((PASS + 1))
else
  echo "  ❌ backlog.md not created on ITERATE"
  FAIL=$((FAIL + 1))
fi
assert_file_contains "has error handling finding" .harness/backlog.md "Missing error handling"
assert_file_contains "has rate limiting finding" .harness/backlog.md "rate limiting"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 4: List prefix stripping ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 4.1: No double list prefix in backlog ---"
setup_at_review
rm -f .harness/backlog.md
mkdir -p .harness/nodes/F1.2/run_1
cat > .harness/nodes/F1.2/run_1/eval-a.md << 'EVAL'
# Review
- 🔴 Critical bug in auth flow
* 🟡 Warning about memory leak
EVAL
cat > .harness/nodes/F1.2/run_1/eval-b.md << 'EVAL'
# Review B
🔴 Another critical issue without list prefix
EVAL
OUT=$($HARNESS complete-tick --dir .harness --unit F1.2 --status completed --artifacts ".harness/nodes/F1.2/run_1/eval-a.md,.harness/nodes/F1.2/run_1/eval-b.md" 2>/dev/null)
# Check no double prefix: "- [ ] - 🔴" should NOT appear
assert_file_not_contains "no double dash prefix" .harness/backlog.md "\- \[ \] - "
assert_file_not_contains "no double star prefix" .harness/backlog.md "\- \[ \] \* "
# But the content should still be there
assert_file_contains "has auth flow finding" .harness/backlog.md "Critical bug in auth flow"
assert_file_contains "has no-prefix finding" .harness/backlog.md "Another critical issue"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 5: Section headers per review unit ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 5.1: Section header includes unit ID ---"
setup_at_review
rm -f .harness/backlog.md
mkdir -p .harness/nodes/F1.2/run_1
cat > .harness/nodes/F1.2/run_1/eval-a.md << 'EVAL'
# Review
- 🟡 Some warning
EVAL
cat > .harness/nodes/F1.2/run_1/eval-b.md << 'EVAL'
# Review B
- 🔵 Suggestion only (triggers PASS but we need separate 🟡)
- 🟡 Another warning for ITERATE
EVAL
OUT=$($HARNESS complete-tick --dir .harness --unit F1.2 --status completed --artifacts ".harness/nodes/F1.2/run_1/eval-a.md,.harness/nodes/F1.2/run_1/eval-b.md" 2>/dev/null)
assert_file_contains "section header has unit ID" .harness/backlog.md "## From review unit F1.2"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 6: Non-md artifacts ignored ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 6.1: JSON artifacts not scanned for backlog ---"
setup_at_review
rm -f .harness/backlog.md
mkdir -p .harness/nodes/F1.2/run_1
cat > .harness/nodes/F1.2/run_1/eval-a.md << 'EVAL'
# Review
- 🟡 Issue found
EVAL
cat > .harness/nodes/F1.2/run_1/eval-b.md << 'EVAL'
# Review B
- 🟡 Another issue
EVAL
echo '{"🔴": "fake finding in json"}' > .harness/nodes/F1.2/run_1/data.json
OUT=$($HARNESS complete-tick --dir .harness --unit F1.2 --status completed --artifacts ".harness/nodes/F1.2/run_1/eval-a.md,.harness/nodes/F1.2/run_1/eval-b.md,.harness/nodes/F1.2/run_1/data.json" 2>/dev/null)
assert_file_not_contains "json content not in backlog" .harness/backlog.md "fake finding in json"

# ═══════════════════════════════════════════════════════════════
print_results
