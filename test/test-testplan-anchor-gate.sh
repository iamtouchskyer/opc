#!/bin/bash
set -e

# P1-1 mechanical gate: test-design P0/P1 cases must carry an Anchor (a build-artifact
# citation) proving the asserted behavior exists in the built code. This turns the
# test-design-protocol "Anchor (P0/P1 mandatory)" prompt rule into an enforced verdict:
#   - P0/P1 case missing Anchor            → totals.warning += 1 → verdict ITERATE
#   - P0/P1 case Anchor is file:line but    → totals.warning += 1 → verdict ITERATE
#       the path does not resolve
#   - P2 case missing Anchor                → NOT flagged
#   - P0/P1 case with valid file:line       → NOT flagged
#   - TC-TIER-* cases (mechanically injected baselines, not role-authored build
#       assertions) are EXEMPT even at P0 with no Anchor
#
# Anti-fake-green: every trigger assertion also checks that `reason` names the anchor
# (not just verdict=ITERATE — which could come from an unrelated warning). The session
# always includes eval-skeptic-owner.md so the mandatory-role warning never masks the gate.

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

# A substantive 🔵-only eval (no critical/warning findings, real file refs, multi-section)
# so the compound quality gate does not trip and the baseline can reach PASS.
write_eval() {
  local path="$1" title="$2"
  {
    echo "# $title"
    echo ""
    echo "## Analysis"
    echo "Reviewed the implementation against the test plan in detail."
    echo "Coverage of the public surface looks adequate for this feature."
    echo "Edge cases around pagination and empty input are addressed."
    echo ""
    echo "## Findings"
    echo "🔵 src/app.ts:12 — the helper could expose a named constant"
    echo "→ Fix: extract the literal to a documented const for readability"
    echo "Reasoning: a named constant reads better than a bare literal here."
    echo ""
    echo "## Coverage Analysis"
    echo "Unit tests exercise the core parsing path thoroughly."
    echo "Integration tests verify the end-to-end submit flow."
    echo "Negative tests reject malformed input with explicit error codes."
    echo "Accessibility checks cover keyboard navigation and contrast."
    echo ""
    echo "## Quality Assessment"
    echo "Assertions are binary and steps are mechanically followable."
    echo "Expected results are concrete, not aspirational."
    echo "Failure impacts are documented for each priority-zero case."
    echo ""
    echo "VERDICT: PASS FINDINGS[1]"
  } > "$path"
}

# Write a test-design session whose test-plan.md satisfies the existing layer/depth/command
# gate. The caller passes the TC-case block markdown to splice under L1, so the ONLY variable
# across tests is the anchor situation of those cases.
setup_plan() {
  local tc_blocks="$1"
  rm -rf .harness
  mkdir -p .harness/nodes/test-design/run_1
  cat > .harness/flow-state.json << 'EOF'
{"currentNode":"test-design","history":[{"node":"test-design","run":1}],"edgeCounts":{},"stepCount":1}
EOF
  write_eval .harness/nodes/test-design/run_1/eval-skeptic-owner.md "Skeptic Owner Review"
  write_eval .harness/nodes/test-design/run_1/eval-tester.md "Test Design — tester"
  # A real build artifact in the session so file:line anchors can resolve.
  cat > .harness/nodes/test-design/run_1/build.ts << 'EOF'
export function paginate(items, page) {
  if (page < 1) return [];
  return items.slice((page - 1) * 10, page * 10);
}
EOF
  cat > .harness/nodes/test-design/run_1/test-plan.md << EOF
# Test Plan

## L1: Unit / Smoke
- Run \`npm test\` for unit coverage of the paginate helper
- Vitest coverage must exceed 80 percent on changed files
- Every changed module has a corresponding unit test file

$tc_blocks

## L2: Contract / Edge Cases
- Validate schema compliance and reject invalid input with error codes
- Test boundary values: empty string, max length, unicode payloads
- Confirm error code mapping matches the documented contract

## L3: Integration / E2E Flows
- Test integration end-to-end flow: load to submit to verify
- Run a multi-step workflow against a real test database container
- Verify webhook delivery on each state transition

## L4: UI / Visual / A11y
- Playwright screenshot at 1440px and 375px viewport widths
- Verify responsive layout breakpoints render correctly
- Run axe-core accessibility scan with zero serious violations

## L5: Tier Baseline / Polish
- Verify dark mode toggle preserves the user preference
- Check typography hierarchy across heading and body fonts
- Confirm navigation active states and favicon are present
EOF
}

echo "=== Test-plan Anchor mechanical gate (P1-1) ==="

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- A0 (baseline): all P0/P1 cases carry valid file:line anchors → reason has no Anchor issue ---"
setup_plan '### TC-TESTER-01: empty page boundary
- **Category**: edge-case
- **Priority**: P0
- **Anchor**: `nodes/test-design/run_1/build.ts:2` — `if (page < 1) return []`
- **Expected**: returns empty array for page 0

### TC-TESTER-02: slice window
- **Category**: unit
- **Priority**: P1
- **Anchor**: `nodes/test-design/run_1/build.ts:3` — slice math
- **Expected**: returns 10 items for a full page'
OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_not_contains "valid anchors → no anchor issue in reason" "$OUT" "Anchor"
assert_field_eq "valid anchors → verdict PASS" "$OUT" "verdict" '"PASS"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- A1: P0 case missing Anchor → ITERATE, reason names the case ---"
setup_plan '### TC-TESTER-01: empty page boundary
- **Category**: edge-case
- **Priority**: P0
- **Expected**: returns empty array for page 0'
OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_field_eq "P0 no anchor → verdict ITERATE" "$OUT" "verdict" '"ITERATE"'
assert_contains "reason names missing Anchor" "$OUT" "missing Anchor"
assert_contains "reason names the offending case id" "$OUT" "TC-TESTER-01"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- A2: P1 case missing Anchor → ITERATE ---"
setup_plan '### TC-TESTER-01: slice window
- **Category**: unit
- **Priority**: P1
- **Expected**: returns 10 items for a full page'
OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_field_eq "P1 no anchor → verdict ITERATE" "$OUT" "verdict" '"ITERATE"'
assert_contains "reason names missing Anchor (P1)" "$OUT" "missing Anchor"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- A3 (guard): P2 case missing Anchor → NOT flagged ---"
setup_plan '### TC-TESTER-01: nice-to-have polish check
- **Category**: e2e-ui
- **Priority**: P2
- **Anchor**: `nodes/test-design/run_1/build.ts:2`
- **Expected**: page renders

### TC-TESTER-02: cosmetic spacing
- **Category**: e2e-ui
- **Priority**: P2
- **Expected**: spacing is consistent'
OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_not_contains "P2 missing anchor → no anchor issue" "$OUT" "missing Anchor"
assert_field_eq "P2 missing anchor → verdict PASS" "$OUT" "verdict" '"PASS"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- A4 (guard): P0 with valid file:line Anchor → NOT flagged ---"
setup_plan '### TC-TESTER-01: empty page boundary
- **Category**: edge-case
- **Priority**: P0
- **Anchor**: `nodes/test-design/run_1/build.ts:2`
- **Expected**: returns empty array for page 0'
OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_not_contains "valid file:line anchor → no anchor issue" "$OUT" "Anchor ref unresolved"
assert_not_contains "valid file:line anchor → no missing-anchor issue" "$OUT" "missing Anchor"
assert_field_eq "valid file:line anchor → verdict PASS" "$OUT" "verdict" '"PASS"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- A5: P0 with invalid file:line Anchor → ITERATE ---"
setup_plan '### TC-TESTER-01: empty page boundary
- **Category**: edge-case
- **Priority**: P0
- **Anchor**: `nodes/test-design/run_1/ghost-nonexistent-9999.ts:5`
- **Expected**: returns empty array for page 0'
OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_field_eq "invalid file:line anchor → verdict ITERATE" "$OUT" "verdict" '"ITERATE"'
assert_contains "reason names unresolved anchor ref" "$OUT" "Anchor ref unresolved"

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- A6 (guard): TC-TIER P0 case with no Anchor → EXEMPT (not flagged) ---"
setup_plan '### TC-TIER-01: responsive layout baseline
- **Category**: e2e-ui
- **Priority**: P0
- **Expected**: layout reflows at mobile breakpoint'
OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_not_contains "TC-TIER P0 no anchor → exempt, no anchor issue" "$OUT" "missing Anchor"
assert_field_eq "TC-TIER P0 no anchor → verdict PASS" "$OUT" "verdict" '"PASS"'

# ───────────────────────────────────────────────────────────────
echo ""
echo "--- A7 (guard): grep-token Anchor (not file:line) on P0 → accepted structurally ---"
setup_plan '### TC-TESTER-01: empty page boundary
- **Category**: edge-case
- **Priority**: P0
- **Anchor**: grep `function paginate` — proves the helper exists
- **Expected**: returns empty array for page 0'
OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_not_contains "grep-token anchor → no unresolved-ref issue" "$OUT" "Anchor ref unresolved"
assert_not_contains "grep-token anchor → no missing-anchor issue" "$OUT" "missing Anchor"
assert_field_eq "grep-token anchor → verdict PASS" "$OUT" "verdict" '"PASS"'

# ───────────────────────────────────────────────────────────────
# A8: file exists but the cited LINE is out of range. Existence alone is NOT
#     enough — a phantom test can hang a fabricated line off a real file. The
#     line number must be within the file's bounds or the Anchor is invalid.
echo ""
echo "--- A8: P0 Anchor file exists but line out of range → ITERATE ---"
setup_plan '### TC-TESTER-01: empty page boundary
- **Category**: edge-case
- **Priority**: P0
- **Anchor**: `nodes/test-design/run_1/build.ts:9999`
- **Expected**: returns empty array for page 0'
OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_field_eq "out-of-range anchor line → verdict ITERATE" "$OUT" "verdict" '"ITERATE"'
assert_contains "reason names out-of-range anchor" "$OUT" "Anchor line out of range"

# A8b (guard): line 0 is also out of range (1-indexed)
echo ""
echo "--- A8b: P0 Anchor line 0 (below 1-indexed floor) → ITERATE ---"
setup_plan '### TC-TESTER-01: empty page boundary
- **Category**: edge-case
- **Priority**: P0
- **Anchor**: `nodes/test-design/run_1/build.ts:0`
- **Expected**: returns empty array for page 0'
OUT=$($HARNESS synthesize .harness --node test-design 2>/dev/null)
assert_field_eq "anchor line 0 → verdict ITERATE" "$OUT" "verdict" '"ITERATE"'
assert_contains "reason names out-of-range anchor (line 0)" "$OUT" "Anchor line out of range"

print_results
