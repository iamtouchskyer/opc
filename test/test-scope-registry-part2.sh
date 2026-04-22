#!/bin/bash
# Task Scope Registry tests — part 2 (tests 9-15)
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

echo "=== Task Scope Registry Tests (Part 2) ==="
echo ""

mkdir -p .harness
write_acceptance .harness

# ─── 9. scope matching via keyword overlap ───
echo "--- Test 9: scope matching via keyword overlap ---"
rm -rf .harness/loop-state.json
cat > .harness/plan.md <<'EOF'
## Task Scope
- SCOPE-1: Build user authentication backend
- SCOPE-2: Write comprehensive unit tests

## Units
- F1.1: implement — Implement user auth backend with JWT tokens
- F1.2: review — Review implementation
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null || true)
echo "test evidence" > .harness/evidence3.txt
echo "5 tests passed" >> .harness/evidence3.txt
echo "change3" >> dummy.txt && git add -A && git commit -q -m "implement jwt"
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts .harness/evidence3.txt --description "Implemented user auth backend with JWT" --dir .harness 2>/dev/null || true)
assert_field_eq "keyword overlap match succeeds" "$OUT" "completed" "true"

# ─── 10. scope matching via explicit SCOPE-N reference ───
echo "--- Test 10: scope matching via explicit SCOPE-N reference ---"
cat > .harness/eval-a.md <<'EOF'
## Evaluation
🔵 Code covers SCOPE-2 requirements
LGTM
EOF
cat > .harness/eval-b.md <<'EOF'
## Evaluation
🔵 Tests comprehensive
LGTM
EOF
OUT=$($HARNESS complete-tick --unit F1.2 --artifacts .harness/eval-a.md,.harness/eval-b.md --description "Review covers SCOPE-2 unit tests" --dir .harness 2>/dev/null || true)
assert_field_eq "explicit SCOPE-N ref matches" "$OUT" "completed" "true"

# ─── 11. next-tick: uncovered_scope in termination output ───
echo "--- Test 11: next-tick surfaces uncovered_scope ---"
rm -rf .harness/loop-state.json
cat > .harness/plan.md <<'EOF'
## Task Scope
- SCOPE-1: Build API
- SCOPE-2: Browser E2E tests
- SCOPE-3: Performance benchmarks

## Units
- F1.1: implement — Build API endpoint
- F1.2: review — Review API
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null || true)
echo "api evidence" > .harness/evidence4.txt
echo "3 tests passed" >> .harness/evidence4.txt
echo "change4" >> dummy.txt && git add -A && git commit -q -m "api endpoint"
$HARNESS complete-tick --unit F1.1 --artifacts .harness/evidence4.txt --description "Built API endpoint" --dir .harness --skip-scope-check 2>/dev/null || true
cat > .harness/eval-c.md <<'EOF'
## Evaluation
🔵 API looks good
LGTM
EOF
cat > .harness/eval-d.md <<'EOF'
## Evaluation
🔵 OK
LGTM
EOF
$HARNESS complete-tick --unit F1.2 --artifacts .harness/eval-c.md,.harness/eval-d.md --description "Reviewed API" --dir .harness --skip-scope-check 2>/dev/null || true
OUT=$($HARNESS next-tick --dir .harness 2>/dev/null || true)
assert_contains "next-tick mentions uncovered_scope" "$OUT" "uncovered_scope"
assert_contains "mentions SCOPE-2" "$OUT" "SCOPE-2"
assert_contains "mentions SCOPE-3" "$OUT" "SCOPE-3"

# ─── 12. parseTaskScope: handles multi-line scope items ───
echo "--- Test 12: parseTaskScope handles various formats ---"
rm -rf .harness/loop-state.json
cat > .harness/plan.md <<'EOF'
## Task Scope
- SCOPE-1: Build the backend API with REST endpoints
- SCOPE-2: Create frontend React components for dashboard
- SCOPE-3: Write integration tests

## Units
- F1.1: implement — Build REST API backend
- F1.2: review — Review backend
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null || true)
assert_field_eq "3 scope items parsed" "$OUT" "initialized" "true"
SCOPE_COUNT=$(python3 -c "import json; d=json.load(open('.harness/loop-state.json')); print(len(d.get('_task_scope', [])))")
if [ "$SCOPE_COUNT" = "3" ]; then
  echo "  ✅ 3 scope items in state"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected 3 scope items, got $SCOPE_COUNT"
  FAIL=$((FAIL + 1))
fi

# ─── 13. complete-tick: partial coverage (1 of 3) → error ───
echo "--- Test 13: partial coverage blocks termination ---"
echo "api evidence" > .harness/evidence5.txt
echo "2 tests passed" >> .harness/evidence5.txt
echo "change5" >> dummy.txt && git add -A && git commit -q -m "rest api"
$HARNESS complete-tick --unit F1.1 --artifacts .harness/evidence5.txt --description "Built REST API backend" --dir .harness --skip-scope-check 2>/dev/null || true
cat > .harness/eval-e.md <<'EOF'
## Evaluation
🔵 Backend is solid
LGTM
EOF
cat > .harness/eval-f.md <<'EOF'
## Evaluation
🔵 Clean code
LGTM
EOF
OUT=$($HARNESS complete-tick --unit F1.2 --artifacts .harness/eval-e.md,.harness/eval-f.md --description "Reviewed backend" --dir .harness 2>/dev/null || true)
assert_field_eq "partial coverage blocks" "$OUT" "completed" "false"
assert_contains "lists uncovered SCOPE-2" "$OUT" "SCOPE-2"
assert_contains "lists uncovered SCOPE-3" "$OUT" "SCOPE-3"

# ─── 14. scope items with no match at all → all uncovered ───
echo "--- Test 14: completely unrelated plan → all scope uncovered ---"
rm -rf .harness/loop-state.json
cat > .harness/plan.md <<'EOF'
## Task Scope
- SCOPE-1: Implement dark mode theme
- SCOPE-2: Add accessibility audit

## Units
- F1.1: implement — Fix typo in README
- F1.2: review — Review typo fix
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null || true)
echo "typo evidence" > .harness/evidence6.txt
echo "0 tests passed" >> .harness/evidence6.txt
echo "change6" >> dummy.txt && git add -A && git commit -q -m "fix typo"
$HARNESS complete-tick --unit F1.1 --artifacts .harness/evidence6.txt --description "Fixed typo in README" --dir .harness --skip-scope-check 2>/dev/null || true
cat > .harness/eval-g.md <<'EOF'
## Evaluation
🔵 Typo fixed
LGTM
EOF
cat > .harness/eval-h.md <<'EOF'
## Evaluation
🔵 OK
LGTM
EOF
OUT=$($HARNESS complete-tick --unit F1.2 --artifacts .harness/eval-g.md,.harness/eval-h.md --description "Reviewed typo fix" --dir .harness 2>/dev/null || true)
assert_field_eq "completely unrelated blocks" "$OUT" "completed" "false"
assert_contains "SCOPE-1 uncovered" "$OUT" "SCOPE-1"
assert_contains "SCOPE-2 uncovered" "$OUT" "SCOPE-2"

# ─── 15. loop-protocol.md Task Scope format respected ───
echo "--- Test 15: mixed SCOPE numbering works ---"
rm -rf .harness/loop-state.json
cat > .harness/plan.md <<'EOF'
## Task Scope
- SCOPE-1: Primary deliverable
- SCOPE-5: Secondary deliverable
- SCOPE-10: Tertiary deliverable

## Units
- F1.1: implement — Deliver primary and secondary and tertiary
- F1.2: review — Final review
EOF
OUT=$($HARNESS init-loop --dir .harness 2>/dev/null || true)
SCOPE_COUNT=$(python3 -c "import json; d=json.load(open('.harness/loop-state.json')); print(len(d.get('_task_scope', [])))")
if [ "$SCOPE_COUNT" = "3" ]; then
  echo "  ✅ non-sequential SCOPE numbering works"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected 3, got $SCOPE_COUNT"
  FAIL=$((FAIL + 1))
fi

print_results
