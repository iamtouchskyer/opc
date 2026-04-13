#!/bin/bash
# Run all OPC test files
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
TOTAL_PASS=0
TOTAL_FAIL=0

for f in "$DIR"/test-*.sh; do
  [ "$(basename "$f")" = "test-helpers.sh" ] && continue
  echo ""
  echo "═══════════════════════════════════════════"
  echo "  Running $(basename "$f")"
  echo "═══════════════════════════════════════════"
  if bash "$f"; then
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    echo "  ⚠️  $(basename "$f") had failures"
  fi
done

echo ""
echo "═══════════════════════════════════════════"
echo "  Suite: $TOTAL_PASS files passed, $TOTAL_FAIL files failed"
echo "═══════════════════════════════════════════"

[ "$TOTAL_FAIL" -eq 0 ] || exit 1
