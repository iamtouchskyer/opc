#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
setup_tmpdir
CASE_DIR="$PWD"

echo "Test: readTaskFromAC"
echo "===================="
echo ""

cat > acceptance-criteria.md <<'EOF'
# Acceptance Criteria

Build an Ant Design Pro analytics dashboard with KPI cards and filters.
EOF
OUT=$(cd "$REPO" && node --input-type=module - "$CASE_DIR" <<'NODE'
import { readTaskFromAC } from "./bin/lib/ext-commands.mjs";
console.log(readTaskFromAC(process.argv[2]));
NODE
)
if grep -q "Ant Design Pro analytics dashboard" <<< "$OUT"; then
  echo "  ✅ skips boilerplate heading and reads task line"
  PASS=$((PASS + 1))
else
  echo "  ❌ wrong task: $OUT"
  FAIL=$((FAIL + 1))
fi

cat > acceptance-criteria.md <<'EOF'
# Build a fintech risk dashboard

- It must show live exposure and failed checks.
EOF
OUT=$(cd "$REPO" && node --input-type=module - "$CASE_DIR" <<'NODE'
import { readTaskFromAC } from "./bin/lib/ext-commands.mjs";
console.log(readTaskFromAC(process.argv[2]));
NODE
)
if [ "$OUT" = "Build a fintech risk dashboard" ]; then
  echo "  ✅ preserves meaningful first heading"
  PASS=$((PASS + 1))
else
  echo "  ❌ meaningful heading lost: $OUT"
  FAIL=$((FAIL + 1))
fi

print_results
