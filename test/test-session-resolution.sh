#!/usr/bin/env bash
set -euo pipefail

# Test: session resolution — git-root hashing, legacy fallback, error messages

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="node $SCRIPT_DIR/bin/opc-harness.mjs"
PASS=0; FAIL=0

check() {
  local label="$1" cond="$2"
  if eval "$cond"; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label"
    FAIL=$((FAIL + 1))
  fi
}

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

echo "=== TEST GROUP 1: git-root hashing — subdirs get same hash ==="

mkdir -p "$TMPD/repo/src/deep"
(cd "$TMPD/repo" && git init -q && git commit --allow-empty -m "init" -q)

HASH_ROOT=$(cd "$TMPD/repo" && node -e "
  import { getProjectHash } from '$SCRIPT_DIR/bin/lib/util.mjs';
  console.log(getProjectHash());
" 2>&1)

HASH_SUBDIR=$(cd "$TMPD/repo/src/deep" && node -e "
  import { getProjectHash } from '$SCRIPT_DIR/bin/lib/util.mjs';
  console.log(getProjectHash());
" 2>&1)

check "git root and subdir produce same hash" '[ "$HASH_ROOT" = "$HASH_SUBDIR" ]'

echo ""
echo "=== TEST GROUP 2: non-git dir uses normalized cwd ==="

mkdir -p "$TMPD/nongit/sub"

HASH_NG=$(cd "$TMPD/nongit" && node -e "
  import { getProjectHash } from '$SCRIPT_DIR/bin/lib/util.mjs';
  console.log(getProjectHash());
" 2>&1)

HASH_NG_SUB=$(cd "$TMPD/nongit/sub" && node -e "
  import { getProjectHash } from '$SCRIPT_DIR/bin/lib/util.mjs';
  console.log(getProjectHash());
" 2>&1)

check "non-git different dirs get different hashes" '[ "$HASH_NG" != "$HASH_NG_SUB" ]'

echo ""
echo "=== TEST GROUP 3: symlink to git repo gets same hash ==="

ln -s "$TMPD/repo" "$TMPD/repo-link"

HASH_LINK=$(cd "$TMPD/repo-link" && node -e "
  import { getProjectHash } from '$SCRIPT_DIR/bin/lib/util.mjs';
  console.log(getProjectHash());
" 2>&1)

check "symlink to repo gets same hash as repo" '[ "$HASH_ROOT" = "$HASH_LINK" ]'

echo ""
echo "=== TEST GROUP 4: error message includes diagnostics ==="

ERR_MSG=$(cd "$TMPD/nongit" && $HARNESS transition --from x --to y --verdict PASS --flow review 2>&1 || true)
check "error includes cwd" 'echo "$ERR_MSG" | grep -q "nongit"'
check "error includes hash" 'echo "$ERR_MSG" | grep -q "hash:"'
check "error suggests --dir" 'echo "$ERR_MSG" | grep -q "\-\-dir"'

echo ""
echo "=== TEST GROUP 5: explicit --dir works from any cwd ==="

D5="$TMPD/repo5"
mkdir -p "$D5/.harness/nodes/review"
echo '{"version":"1.0","flowTemplate":"review","currentNode":"review","entryNode":"review","totalSteps":0}' > "$D5/.harness/flow-state.json"

# Run viz from /tmp with explicit --dir pointing to D5
VIZ_OUT=$(cd /tmp && $HARNESS viz --flow review --dir "$D5/.harness" 2>&1)
check "viz with explicit --dir from /tmp works" 'echo "$VIZ_OUT" | grep -q "review\|gate"'

echo ""
echo "=== TEST GROUP 6: legacy session fallback ==="

# Compute legacy hash the same way the old code did (process.cwd() inside Node)
LEGACY_HASH=$(cd "$TMPD/repo" && node --input-type=module -e "
  import { createHash } from 'crypto';
  console.log(createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12));
")

# If legacy hash differs from git-root hash, create a legacy session
if [ "$LEGACY_HASH" != "$HASH_ROOT" ]; then
  LEGACY_BASE="$HOME/.opc/sessions/$LEGACY_HASH"
  mkdir -p "$LEGACY_BASE/legacy-sess"
  echo '{"version":"1.0","flowTemplate":"review","currentNode":"review"}' > "$LEGACY_BASE/legacy-sess/flow-state.json"
  ln -sf "legacy-sess" "$LEGACY_BASE/latest"

  FOUND=$(cd "$TMPD/repo" && node --input-type=module -e "
    import { getLatestSessionDir } from '$SCRIPT_DIR/bin/lib/util.mjs';
    const r = getLatestSessionDir();
    console.log(r ? 'found' : 'null');
  " 2>&1)
  check "legacy session found via fallback" 'echo "$FOUND" | grep -q "found"'

  # Clean up legacy session
  rm -rf "$LEGACY_BASE"
else
  check "legacy hash same as git hash (no fallback needed)" 'true'
fi

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[ "$FAIL" -eq 0 ] || exit 1
