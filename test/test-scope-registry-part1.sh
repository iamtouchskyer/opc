#!/bin/bash
# Task Scope Registry tests — part 1 (tests 1-8)
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else json.dumps(v) if isinstance(v,(dict,list,bool)) else str(v))" 2>/dev/null
}

assert_field_eq() {
  local desc="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(jq_field "$json" "$field")
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

write_acceptance() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/acceptance-criteria.md" <<'CRITERIA'
## Outcomes
- OUT-1: Task scope registry validates plan coverage at loop end
- OUT-2: init-loop rejects plans without Task Scope section
- OUT-3: complete-tick blocks termination when scope items are uncovered

## Verification
- OUT-1: run test-scope-registry.sh — all pass
- OUT-2: init-loop returns error JSON with scope hint
- OUT-3: complete-tick returns error listing uncovered SCOPE-N items

## Quality Constraints
- No regressions in existing tests

## Out of Scope
- UI changes
CRITERIA
}

echo "=== Task Scope Registry Tests (Part 1) ==="
echo ""

# ─── 1. init-loop: plan without Task Scope → fails ───
echo "--- Test 1: init-loop rejects plan without Task Scope ---"
mkdir -p .harness
write_acceptance .harness
cat > .harness/plan.md <<'EOF'
## Units
- F1.1: implement — Build auth API
- F1.2: review — Review auth API
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null || true)
assert_contains "init-loop rejects missing scope" "$OUT" "Task Scope"
assert_field_eq "initialized is false" "$OUT" "initialized" "false"

# ─── 2. init-loop: plan with empty Task Scope → fails ───
echo "--- Test 2: init-loop rejects empty Task Scope ---"
rm -f .harness/loop-state.json
cat > .harness/plan.md <<'EOF'
## Task Scope

## Units
- F1.1: implement — Build auth API
- F1.2: review — Review auth API
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null || true)
assert_contains "init-loop rejects empty scope" "$OUT" "Task Scope"

# ─── 3. init-loop: valid Task Scope → succeeds ───
echo "--- Test 3: init-loop accepts valid Task Scope ---"
rm -f .harness/loop-state.json
cat > .harness/plan.md <<'EOF'
## Task Scope
- SCOPE-1: Build authentication API
- SCOPE-2: Review and test auth implementation

## Units
- F1.1: implement — Build auth API (SCOPE-1)
- F1.2: review — Review auth API (SCOPE-2)
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null || true)
assert_field_eq "initialized is true" "$OUT" "initialized" "true"

# ─── 4. init-loop stores _task_scope in state ───
echo "--- Test 4: _task_scope stored in loop-state.json ---"
SCOPE=$(python3 -c "import json; d=json.load(open('.harness/loop-state.json')); print(len(d.get('_task_scope', [])))")
if [ "$SCOPE" = "2" ]; then
  echo "  ✅ _task_scope has 2 items"
  PASS=$((PASS + 1))
else
  echo "  ❌ _task_scope has $SCOPE items, expected 2"
  FAIL=$((FAIL + 1))
fi

# ─── 5. init-loop: --skip-scope bypasses scope validation ───
echo "--- Test 5: --skip-scope bypasses scope validation ---"
rm -f .harness/loop-state.json
cat > .harness/plan.md <<'EOF'
## Units
- F1.1: implement — Build auth API
- F1.2: review — Review auth API
EOF
OUT=$($HARNESS init-loop --dir .harness --skip-scope 2>/dev/null || true)
assert_field_eq "initialized with --skip-scope" "$OUT" "initialized" "true"

# ─── 6. complete-tick: all scope covered → succeeds ───
echo "--- Test 6: complete-tick succeeds when all scope items covered ---"
rm -f .harness/loop-state.json
cat > .harness/plan.md <<'EOF'
## Task Scope
- SCOPE-1: Build authentication API
- SCOPE-2: Review auth implementation

## Units
- F1.1: implement — Build authentication API
- F1.2: review — Review auth implementation
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null || true)
# Simulate tick 1: implement
echo "test evidence" > .harness/evidence1.txt
echo "1 test passed" >> .harness/evidence1.txt
echo "change" >> dummy.txt && git add -A && git commit -q -m "implement auth"
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts .harness/evidence1.txt --description "Built authentication API" --dir .harness 2>/dev/null || true)
assert_field_eq "tick 1 completed" "$OUT" "completed" "true"
# Simulate tick 2: review (final tick)
cat > .harness/eval-eng.md <<'EOF'
## Evaluation
🔵 Code structure is clean
LGTM
EOF
cat > .harness/eval-sec.md <<'EOF'
## Evaluation
🔵 No security issues
LGTM
EOF
OUT=$($HARNESS complete-tick --unit F1.2 --artifacts .harness/eval-eng.md,.harness/eval-sec.md --description "Reviewed auth implementation" --dir .harness 2>/dev/null || true)
assert_field_eq "tick 2 completed (scope covered)" "$OUT" "completed" "true"

# ─── 7. complete-tick: uncovered scope → fails ───
echo "--- Test 7: complete-tick blocks when scope item uncovered ---"
rm -rf .harness/loop-state.json
cat > .harness/plan.md <<'EOF'
## Task Scope
- SCOPE-1: Build authentication API
- SCOPE-2: Browser E2E tests for login flow
- SCOPE-3: Unit tests with 100% coverage

## Units
- F1.1: implement — Build authentication API
- F1.2: review — Review auth API
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null || true)
echo "test evidence" > .harness/evidence2.txt
echo "1 test passed" >> .harness/evidence2.txt
echo "change2" >> dummy.txt && git add -A && git commit -q -m "implement auth 2"
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts .harness/evidence2.txt --description "Built authentication API" --dir .harness 2>/dev/null || true)
assert_field_eq "tick 1 ok" "$OUT" "completed" "true"
cat > .harness/eval-eng2.md <<'EOF'
## Evaluation
🔵 Looks good
LGTM
EOF
cat > .harness/eval-sec2.md <<'EOF'
## Evaluation
🔵 No issues
LGTM
EOF
OUT=$($HARNESS complete-tick --unit F1.2 --artifacts .harness/eval-eng2.md,.harness/eval-sec2.md --description "Reviewed auth API" --dir .harness 2>/dev/null || true)
assert_field_eq "final tick blocked by uncovered scope" "$OUT" "completed" "false"
assert_contains "mentions SCOPE-2" "$OUT" "SCOPE-2"
assert_contains "mentions SCOPE-3" "$OUT" "SCOPE-3"

# ─── 8. complete-tick: --skip-scope-check bypasses ───
echo "--- Test 8: --skip-scope-check bypasses scope validation ---"
OUT=$($HARNESS complete-tick --unit F1.2 --artifacts .harness/eval-eng2.md,.harness/eval-sec2.md --description "Reviewed auth API" --dir .harness --skip-scope-check 2>/dev/null || true)
assert_field_eq "tick completed with --skip-scope-check" "$OUT" "completed" "true"

print_results
