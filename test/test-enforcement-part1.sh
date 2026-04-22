#!/bin/bash
# Enforcement mechanism tests — plan lint, drain gate (E1-E2)
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else json.dumps(v))" 2>/dev/null
}

jq_array_len() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2',[]); print(len(v) if isinstance(v,list) else 0)" 2>/dev/null
}

assert_field_eq() {
  local desc="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(jq_field "$json" "$field")
  if [ -z "$actual" ]; then
    echo "  FAIL $desc — no JSON output (field=$field)"
    FAIL=$((FAIL + 1))
    return
  fi
  actual=$(echo "$actual" | tr -d '"')
  if [ "$actual" = "$expected" ]; then
    echo "  PASS $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $desc — expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -q "$pattern"; then
    echo "  PASS $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $desc — pattern '$pattern' not found"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -q "$pattern"; then
    echo "  FAIL $desc — pattern '$pattern' found but should not be"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS $desc"
    PASS=$((PASS + 1))
  fi
}

# Helper: manipulate loop-state.json fields via python3
patch_state() {
  local dir="$1"; shift
  local py_lines="import json; d = json.load(open('${dir}/loop-state.json'))"
  for pair in "$@"; do
    local key="${pair%%=*}"
    local val="${pair#*=}"
    py_lines="${py_lines}; d['${key}'] = ${val}"
  done
  py_lines="${py_lines}; json.dump(d, open('${dir}/loop-state.json', 'w'), indent=2)"
  python3 -c "$py_lines"
}

# Helper: set up a loop at last unit (F1.2 = review), ready for complete-tick
setup_last_unit() {
  local dir="$1"
  rm -rf "$dir" && mkdir -p "$dir"
  cat > "$dir/plan.md" << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
  $HARNESS init-loop --skip-scope --plan "$dir/plan.md" --dir "$dir" >/dev/null 2>/dev/null
  patch_state "$dir" "tick=1" "next_unit='F1.2'" "status='in_progress'" "_written_by='opc-harness'"
  # Create eval artifacts for review unit
  mkdir -p "$dir/evals"
  printf '%s\n' '🔵 All good — code is clean' > "$dir/evals/eval-fe.md"
  printf '%s\n' '🔵 LGTM — no issues found' > "$dir/evals/eval-be.md"
}

# ═══════════════════════════════════════════════════════════════
echo "=== E1: Plan lint — test coverage warning ==="
# ═══════════════════════════════════════════════════════════════

echo "--- E1.1: Plan without test units produces warning ---"
rm -rf .e1 && mkdir -p .e1
cat > .e1/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — code review
PLAN
OUT=$($HARNESS init-loop --skip-scope --plan .e1/plan.md --dir .e1 2>/dev/null)
assert_field_eq "init succeeds" "$OUT" "initialized" "true"
assert_contains "test coverage warning" "$OUT" "0 test/e2e/accept units"

echo ""
echo "--- E1.2: Plan with e2e unit suppresses warning ---"
rm -rf .e2 && mkdir -p .e2
cat > .e2/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — code review
- F1.3: e2e — end to end verification
  - verify: echo e2e ok
- F1.4: review — final review
PLAN
OUT=$($HARNESS init-loop --skip-scope --plan .e2/plan.md --dir .e2 2>/dev/null)
assert_field_eq "init succeeds" "$OUT" "initialized" "true"
assert_not_contains "no test warning" "$OUT" "0 test/e2e/accept units"

echo ""
echo "--- E1.3: Plan with accept unit suppresses warning ---"
rm -rf .e3 && mkdir -p .e3
cat > .e3/plan.md << 'PLAN'
- F1.1: implement — build feature
  - verify: echo ok
- F1.2: review — code review
- F1.3: accept — acceptance test
  - eval: check it works
- F1.4: review — final review
PLAN
OUT=$($HARNESS init-loop --skip-scope --plan .e3/plan.md --dir .e3 2>/dev/null)
assert_field_eq "init succeeds" "$OUT" "initialized" "true"
assert_not_contains "no test warning with accept" "$OUT" "0 test/e2e/accept units"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== E2: Drain gate — backlog blocks termination ==="
# ═══════════════════════════════════════════════════════════════

echo "--- E2.1: Open backlog items trigger drain ---"
rm -rf .e4 && mkdir -p .e4
cat > .e4/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .e4/plan.md --dir .e4 >/dev/null 2>/dev/null
patch_state .e4 "tick=2" "next_unit=None" "status='idle'" "_written_by='opc-harness'"
cat > .e4/backlog.md << 'BL'
# Backlog
- [ ] 🔴 Critical bug in auth
- [ ] 🟡 Improve error messages
- [x] Done item
BL
OUT=$($HARNESS next-tick --dir .e4 2>/dev/null)
assert_field_eq "drain blocks terminate" "$OUT" "terminate" "false"
assert_field_eq "drain_required flag" "$OUT" "drain_required" "true"
assert_contains "drain reason" "$OUT" "open backlog items remain"

echo ""
echo "--- E2.2: Drain gate extracts actionable items ---"
OUT=$($HARNESS next-tick --dir .e4 2>/dev/null)
assert_contains "actionable items present" "$OUT" "actionable_items"
ACTIONABLE_COUNT=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total_actionable',0))" 2>/dev/null)
if [ "$ACTIONABLE_COUNT" = "2" ]; then
  echo "  PASS correct actionable count (2)"
  PASS=$((PASS + 1))
else
  echo "  FAIL expected 2 actionable items, got $ACTIONABLE_COUNT"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- E2.3: --force-terminate bypasses drain ---"
OUT=$($HARNESS next-tick --dir .e4 --force-terminate 2>/dev/null)
assert_field_eq "force bypasses drain" "$OUT" "terminate" "true"
assert_contains "pipeline complete" "$OUT" "pipeline complete"

echo ""
echo "--- E2.4: _drain_completed flag bypasses drain ---"
rm -rf .e5 && mkdir -p .e5
cat > .e5/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .e5/plan.md --dir .e5 >/dev/null 2>/dev/null
patch_state .e5 "tick=2" "next_unit=None" "status='idle'" "_written_by='opc-harness'" "_drain_completed=True"
cat > .e5/backlog.md << 'BL'
# Backlog
- [ ] 🔴 Remaining item
BL
OUT=$($HARNESS next-tick --dir .e5 2>/dev/null)
assert_field_eq "drain_completed bypasses" "$OUT" "terminate" "true"

echo ""
echo "--- E2.5: No backlog = no drain ---"
rm -rf .e6 && mkdir -p .e6
cat > .e6/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .e6/plan.md --dir .e6 >/dev/null 2>/dev/null
patch_state .e6 "tick=2" "next_unit=None" "status='idle'" "_written_by='opc-harness'"
OUT=$($HARNESS next-tick --dir .e6 2>/dev/null)
assert_field_eq "no backlog = terminate" "$OUT" "terminate" "true"

echo ""
echo "--- E2.6: Backlog with only completed items = no drain ---"
rm -rf .e7 && mkdir -p .e7
cat > .e7/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .e7/plan.md --dir .e7 >/dev/null 2>/dev/null
patch_state .e7 "tick=2" "next_unit=None" "status='idle'" "_written_by='opc-harness'"
cat > .e7/backlog.md << 'BL'
# Backlog
- [x] All done
- [x] This too
BL
OUT=$($HARNESS next-tick --dir .e7 2>/dev/null)
assert_field_eq "completed backlog = terminate" "$OUT" "terminate" "true"

# ═══════════════════════════════════════════════════════════════

print_results
