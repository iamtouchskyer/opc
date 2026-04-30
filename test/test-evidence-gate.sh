#!/usr/bin/env bash
set -euo pipefail

# Test: Fix 1 (recon gate) + Fix 3 (evidence timestamp + test runner error)

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

H() { (cd "$TMPD" && $HARNESS "$@" 2>&1); }

write_valid_plan() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/plan.md" << 'EOF'
## Task Scope
- SCOPE-1: Build feature X

## Units
- F1.1: implement — build feature X
  verify: npm test
- F1.2: review — review feature X
  eval: check quality
EOF
  cat > "$dir/acceptance-criteria.md" << 'EOF'
## Acceptance Criteria
- AC-1: Feature X works end-to-end
- AC-2: Tests pass with coverage > 80%

## Verification
- Run `npm test` and confirm all pass

## Quality
- No regressions in existing tests
EOF
}

# ═══════════════════════════════════════════════════════════════════
echo "── Fix 1: Recon Gate ──"

echo "  Case 1: --recon with missing file"
DIR="$TMPD/t1"
write_valid_plan "$DIR"
OUT=$(H init-loop --plan "$DIR/plan.md" --recon "$DIR/nonexistent.md" --dir "$DIR" --skip-lint)
check "rejects missing recon file" '[[ "$OUT" == *"recon file not found"* ]]'

echo "  Case 2: --recon with too-small file"
DIR="$TMPD/t2"
write_valid_plan "$DIR"
echo "short" > "$DIR/recon.md"
OUT=$(H init-loop --plan "$DIR/plan.md" --recon "$DIR/recon.md" --dir "$DIR" --skip-lint)
check "rejects small recon file" '[[ "$OUT" == *"recon file too small"* ]]'

echo "  Case 3: --recon with valid file"
DIR="$TMPD/t3"
write_valid_plan "$DIR"
python3 -c "print('x' * 300)" > "$DIR/recon.md"
OUT=$(H init-loop --plan "$DIR/plan.md" --recon "$DIR/recon.md" --dir "$DIR" --skip-lint)
check "accepts valid recon file" '[[ "$OUT" == *"initialized\":true"* ]]'

echo "  Case 4: no --recon flag still works (backward compat)"
DIR="$TMPD/t4"
write_valid_plan "$DIR"
OUT=$(H init-loop --plan "$DIR/plan.md" --dir "$DIR" --skip-lint)
check "no recon flag = init succeeds" '[[ "$OUT" == *"initialized\":true"* ]]'

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "── Fix 3: Evidence Timestamp Gate ──"

setup_loop_state() {
  local dir="$1"
  mkdir -p "$dir"
  # Set _last_modified to NOW so artifacts must be fresh
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  cat > "$dir/loop-state.json" << EOFSTATE
{
  "tick": 1,
  "unit": "F1.1",
  "description": "implement feature",
  "status": "in_progress",
  "artifacts": [],
  "next_unit": "F1.2",
  "blockers": [],
  "review_of_previous": "",
  "plan_file": "$dir/plan.md",
  "units_total": 2,
  "unit_ids": ["F1.1", "F1.2"],
  "_written_by": "opc-harness/1",
  "_plan_hash": "abc123",
  "_last_modified": "$ts",
  "_git_head": "deadbeef",
  "_tick_history": [],
  "_max_total_ticks": 6,
  "_started_at": "$ts",
  "_max_duration_hours": 24,
  "_write_nonce": "testnonce1234567",
  "_external_validators": {
    "pre_commit_hooks": false,
    "test_script": "npm test",
    "lint_script": null,
    "typecheck_script": null
  }
}
EOFSTATE
  write_valid_plan "$dir"
}

echo "  Case 5: stale artifact rejected"
DIR="$TMPD/t5"
setup_loop_state "$DIR"
# Create artifact with OLD mtime (touch -t sets to 2020)
mkdir -p "$DIR"
echo "some output" > "$DIR/output.log"
touch -t 202001010000 "$DIR/output.log"
sleep 1
# Now update _last_modified to be AFTER the artifact
NEW_TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
sed -i.bak "s/_last_modified.*/_last_modified\": \"$NEW_TS\",/" "$DIR/loop-state.json"
OUT=$(H complete-tick --unit F1.1 --artifacts "$DIR/output.log" --dir "$DIR" 2>&1 || true)
check "rejects stale artifact" '[[ "$OUT" == *"stale"* ]]'

echo "  Case 6: fresh artifact accepted (no stale error)"
DIR="$TMPD/t6"
setup_loop_state "$DIR"
# Wait a moment then create artifact (mtime > state._last_modified)
sleep 1
echo "3 tests passed, 0 failed" > "$DIR/output.log"
OUT=$(H complete-tick --unit F1.1 --artifacts "$DIR/output.log" --dir "$DIR" 2>&1 || true)
check "no stale error for fresh artifact" '[[ "$OUT" != *"stale"* ]]'

echo "  Case 7: missing test runner output = error (not warning)"
DIR="$TMPD/t7"
setup_loop_state "$DIR"
sleep 1
echo "just some log without test markers" > "$DIR/output.log"
OUT=$(H complete-tick --unit F1.1 --artifacts "$DIR/output.log" --dir "$DIR" 2>&1 || true)
check "test runner missing = error" '[[ "$OUT" == *"must pass tests"* ]]'
check "complete-tick fails" '[[ "$OUT" == *"\"valid\":false"* || "$OUT" == *"errors"* ]]'

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
