#!/bin/bash
# Shared test helpers for opc-harness test suite
# Source this file at the top of each test script:
#   source "$(dirname "$0")/test-helpers.sh"

# ── Repo-relative harness path (portable, no hardcoded install path) ──
HARNESS="node $(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/opc-harness.mjs"

# ── Counters ──
PASS=0
FAIL=0

# ── Temp directory with cleanup ──
setup_tmpdir() {
  TMPDIR=$(mktemp -d)
  trap "rm -rf $TMPDIR" EXIT
  cd "$TMPDIR"
}

# ── Git repo init (many tests need this) ──
setup_git() {
  git init -q .
  git config user.email "test@test.com"
  git config user.name "Test"
  echo "init" > dummy.txt
  git add dummy.txt && git commit -q -m "init"
}

# ── Print results and exit with appropriate code ──
print_results() {
  echo ""
  echo "==========================================="
  echo "  Results: $PASS passed, $FAIL failed"
  echo "==========================================="
  [ "$FAIL" -eq 0 ] || exit 1
}

# ── Write a golden brief that passes brief-lint to a given path ──
write_golden_brief() {
  local target="$1"
  cat > "$target" << 'BRIEF'
## File Plan
- index.html — main entry, ~200 lines
- styles.css — all styles, ~150 lines

## Technology Decisions
- Chart.js v4.4.0 via https://cdn.jsdelivr.net/npm/chart.js@4.4.0
- Tailwind CSS v3.4.1 via CDN

## Design Tokens (resolved)
- Primary: #0EA5E9
- Background: #FFFFFF
- Text: #1E293B

## Component Inventory
- Dashboard: 4 cards showing KPI (¥126,560 revenue, 8,846 visits)
- Chart: line chart with 12 monthly data points

## Constraints
- Contrast: 4.5:1 body, 3:1 large text
- Responsive: 992px, 768px, 375px breakpoints
- Animation: 200ms ease-out transitions
BRIEF
}

write_complete_test_plan() {
  local target="$1"
  cat > "$target" << 'PLAN'
# Test Plan

## Unit smoke
Run npm test for unit coverage.
Cover module smoke behavior.
Assert basic render success.

## Contract edge case
Validate schema boundaries.
Cover invalid input.
Assert error code stability.

## Integration e2e flow
Run playwright test through the workflow.
Cover multi-step happy path.
Assert persisted state.

## UI visual accessibility
Capture screenshot at desktop and mobile viewport.
Check responsive layout.
Run a11y smoke checks.

## Tier baseline polish
Check typography hierarchy.
Check navigation affordance.
Check dark mode baseline.
PLAN
}
