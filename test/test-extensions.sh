#!/bin/bash
# Shim suite that runs Node.js built-in test-runner .test.mjs files under bin/lib/.
# These files use `node --test` and live next to their modules so they can be run
# standalone during development; the shim exists so the shell-level suite
# (`test/run-all.sh`) counts them as first-class suites too.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FAIL=0
for f in bin/lib/*.test.mjs; do
  echo "--- node --test $f ---"
  if ! node --test "$f"; then
    FAIL=$((FAIL + 1))
  fi
done

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ all node --test suites passed"
  exit 0
else
  echo "  ❌ $FAIL node --test suite(s) failed"
  exit 1
fi
