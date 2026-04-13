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
