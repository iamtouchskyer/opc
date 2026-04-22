#!/bin/bash
set -e
source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else 'true' if v is True else 'false' if v is False else json.dumps(v) if isinstance(v, (dict,list)) else str(v))" 2>/dev/null
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
echo "=== TEST GROUP 1: Structural checks ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 1.1: Valid acceptance criteria passes ---"
cat > good.md << 'EOF'
## Outcomes
- OUT-1: API returns user data within 200ms as measured by p95 latency
- OUT-2: Login form rejects invalid email with error message containing "invalid email"
- OUT-3: Dashboard renders 1000 items without page scroll freeze (measured by Lighthouse performance score > 80)

## Verification
- OUT-1: Load test with k6 — 100 concurrent requests, verify p95 < 200ms
- OUT-2: Playwright test: submit form with "notanemail", assert error text contains "invalid email"
- OUT-3: Lighthouse audit on populated dashboard, verify performance score > 80

## Quality Constraints
- All API responses < 500ms p99
- No console errors in production build

## Out of Scope
- Mobile app (web only for v1)
- Admin panel
EOF
OUT=$($HARNESS criteria-lint good.md 2>/dev/null)
assert_field_eq "valid criteria pass" "$OUT" "pass" "true"

echo ""
echo "--- 1.2: Missing outcomes section fails ---"
cat > no-outcomes.md << 'EOF'
## Verification
- Nothing to verify

## Quality Constraints
- Be good

## Out of Scope
- Everything
EOF
OUT=$($HARNESS criteria-lint no-outcomes.md 2>/dev/null) || true
assert_field_eq "missing outcomes fails" "$OUT" "pass" "false"
assert_contains "reports outcomes-exist" "$OUT" "outcomes-exist"

echo ""
echo "--- 1.3: Missing verification section fails ---"
cat > no-verify.md << 'EOF'
## Outcomes
- OUT-1: Feature works with 100 items
- OUT-2: Error returns HTTP 400 status code
- OUT-3: Data exports as CSV with all columns present

## Quality Constraints
- Fast

## Out of Scope
- Nothing
EOF
OUT=$($HARNESS criteria-lint no-verify.md 2>/dev/null) || true
assert_field_eq "missing verification fails" "$OUT" "pass" "false"
assert_contains "reports verification-exists" "$OUT" "verification-exists"

echo ""
echo "--- 1.4: Too few outcomes fails ---"
cat > few-outcomes.md << 'EOF'
## Outcomes
- OUT-1: Thing works
- OUT-2: Error handled

## Verification
- OUT-1: Test it
- OUT-2: Test it

## Quality Constraints
- ok

## Out of Scope
- nothing
EOF
OUT=$($HARNESS criteria-lint few-outcomes.md 2>/dev/null) || true
assert_field_eq "too few outcomes fails" "$OUT" "pass" "false"
assert_contains "reports outcomes-count" "$OUT" "outcomes-count"

echo ""
echo "--- 1.5: Unmapped outcome in verification fails ---"
cat > unmapped.md << 'EOF'
## Outcomes
- OUT-1: Feature returns 200 status code
- OUT-2: Error returns 400 status code
- OUT-3: Rate limit returns 429 after 100 requests per minute

## Verification
- OUT-1: curl endpoint, check status
- OUT-2: curl with bad data, check status

## Quality Constraints
- None

## Out of Scope
- Admin
EOF
OUT=$($HARNESS criteria-lint unmapped.md 2>/dev/null) || true
assert_field_eq "unmapped outcome fails" "$OUT" "pass" "false"
assert_contains "reports verification-mapped" "$OUT" "verification-mapped"

echo ""
echo "--- 1.6: Missing quality constraints fails ---"
cat > no-quality.md << 'EOF'
## Outcomes
- OUT-1: Returns data within 100ms p95
- OUT-2: Handles 500 error with retry button
- OUT-3: Exports data as JSON with all fields present

## Verification
- OUT-1: k6 load test
- OUT-2: Mock 500, check retry
- OUT-3: Export and diff against schema

## Out of Scope
- Mobile
EOF
OUT=$($HARNESS criteria-lint no-quality.md 2>/dev/null) || true
assert_field_eq "missing quality fails" "$OUT" "pass" "false"
assert_contains "reports quality-section" "$OUT" "quality-section"

print_results
