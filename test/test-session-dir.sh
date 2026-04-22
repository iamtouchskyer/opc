#!/bin/bash
# Tests for Solution C: session directory management (~/.opc/sessions/)
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

# Override HOME so we don't pollute real ~/.opc
export HOME="$TMPDIR/fakehome"
mkdir -p "$HOME"

# ── helpers ──
jq_field() { node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));const v=$2;process.stdout.write(String(v??''))" <<< "$1"; }

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label — expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label — expected to find '$needle'"
    FAIL=$((FAIL + 1))
  fi
}

# ═══════════════════════════════════════════════════════════════
echo "=== TEST 1: init without --dir creates session dir ==="

OUT=$($HARNESS init --flow review --entry review 2>/dev/null)
CREATED=$(jq_field "$OUT" "d.created")
DIR_FIELD=$(jq_field "$OUT" "d.dir")

assert_eq "1.1: created=true" "$CREATED" "true"
assert_contains "1.2: dir under ~/.opc/sessions" "$DIR_FIELD" ".opc/sessions/"

# Verify flow-state.json exists in the session dir
assert_eq "1.3: flow-state.json exists" "$(test -f "$DIR_FIELD/flow-state.json" && echo yes)" "yes"

# Verify latest symlink
SESSIONS_BASE=$(dirname "$DIR_FIELD")
LATEST_TARGET=$(readlink "$SESSIONS_BASE/latest" 2>/dev/null || echo "")
SESSION_NAME=$(basename "$DIR_FIELD")
assert_eq "1.4: latest symlink points to session" "$LATEST_TARGET" "$SESSION_NAME"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST 2: second init creates separate session ==="

OUT2=$($HARNESS init --flow review --entry review 2>/dev/null)
DIR2=$(jq_field "$OUT2" "d.dir")

# Should be different dir
if [ "$DIR_FIELD" != "$DIR2" ]; then
  echo "  ✅ 2.1: second session is different dir"
  PASS=$((PASS + 1))
else
  echo "  ❌ 2.1: second session same as first"
  FAIL=$((FAIL + 1))
fi

# Both flow-state.json should exist
assert_eq "2.2: first session still exists" "$(test -f "$DIR_FIELD/flow-state.json" && echo yes)" "yes"
assert_eq "2.3: second session exists" "$(test -f "$DIR2/flow-state.json" && echo yes)" "yes"

# latest symlink updated to second
LATEST2=$(readlink "$SESSIONS_BASE/latest" 2>/dev/null || echo "")
assert_eq "2.4: latest updated to second session" "$LATEST2" "$(basename "$DIR2")"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST 3: --dir flag still works (backward compat) ==="

mkdir -p .harness
OUT3=$($HARNESS init --flow review --entry review --dir .harness 2>/dev/null)
DIR3=$(jq_field "$OUT3" "d.dir")

assert_contains "3.1: explicit dir used" "$DIR3" ".harness"
assert_eq "3.2: flow-state in explicit dir" "$(test -f .harness/flow-state.json && echo yes)" "yes"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST 4: ls discovers session-based flows ==="

OUT4=$($HARNESS ls 2>/dev/null)
# Should find at least 3 flows (2 session + 1 explicit)
COUNT=$(echo "$OUT4" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.flows.length)")

if [ "$COUNT" -ge 3 ]; then
  echo "  ✅ 4.1: ls found ≥3 flows ($COUNT)"
  PASS=$((PASS + 1))
else
  echo "  ❌ 4.1: ls found only $COUNT flows, expected ≥3"
  FAIL=$((FAIL + 1))
fi

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST 5: project hash is deterministic ==="

# Two inits from same cwd should land in same project hash dir
HASH1=$(basename "$SESSIONS_BASE")
OUT5=$($HARNESS init --flow review --entry review 2>/dev/null)
DIR5=$(jq_field "$OUT5" "d.dir")
HASH2=$(basename "$(dirname "$DIR5")")

assert_eq "5.1: same project hash" "$HASH1" "$HASH2"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST 6: other commands work with session dir ==="

# route, validate-chain etc. should work when --dir points to session
OUT6=$($HARNESS route --node review --verdict PASS --flow review --dir "$DIR2" 2>/dev/null)
NEXT=$(jq_field "$OUT6" "d.next")
assert_eq "6.1: route works with session dir" "$NEXT" "gate"

print_results
