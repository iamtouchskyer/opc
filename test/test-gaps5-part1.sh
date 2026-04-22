#!/usr/bin/env bash
# test-gaps5 — split part
set -uo pipefail
# NOTE: no set -e — we handle errors explicitly per assertion

source "$(dirname "$0")/test-helpers.sh"

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qE "$needle"; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected pattern '$needle'"; FAIL=$((FAIL+1))
    echo "     GOT: $(echo "$haystack" | head -3)"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qE "$needle"; then
    echo "  ❌ $label — did NOT expect '$needle'"; FAIL=$((FAIL+1))
  else
    echo "  ✅ $label"; PASS=$((PASS+1))
  fi
}

assert_field_eq() {
  local json="$1" field="$2" expected="$3" label="$4"
  local actual
  actual=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d${field})" 2>/dev/null || echo "__PARSE_ERROR__")
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected $field=$expected, got '$actual'"; FAIL=$((FAIL+1))
  fi
}

mkdir -p "$HOME/.claude/flows"
ORIG_DIR=$(pwd)

# ═══════════════════════════════════════════════════════════════════
echo "=== PART 1: 🔴 HIGH — flow-core.mjs findings non-numeric ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 1.1: findings.critical with non-numeric string value"
# flow-core.mjs L167-170: (data.findings.critical || 0) > 0
# Use nodeType=build to isolate this test from review independence check
# (the test is about findings.critical numeric validation, not review logic).
D=$(mktemp -d)
cat > "$D/hs.json" << 'EOF'
{
  "nodeId": "test",
  "nodeType": "build",
  "runId": "run_1",
  "status": "completed",
  "summary": "test",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [],
  "findings": {"critical": "abc", "warning": 0, "suggestion": 0}
}
EOF
OUT=$($HARNESS validate "$D/hs.json" 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "1.1a: non-numeric findings.critical doesn't crash"

cat > "$D/hs2.json" << 'EOF'
{
  "nodeId": "test",
  "nodeType": "build",
  "runId": "run_1",
  "status": "completed",
  "summary": "test",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [],
  "verdict": "PASS",
  "findings": {"critical": 5, "warning": 0, "suggestion": 0}
}
EOF
OUT=$($HARNESS validate "$D/hs2.json" 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "1.1b: findings.critical=5 + PASS → error"
assert_contains "$OUT" "critical.*0" "1.1c: error mentions critical > 0"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 2: 🟡 MEDIUM — eval-commands synthesize readErr ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 2.1: synthesize with one unreadable eval file"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --dir . > /dev/null 2>&1
mkdir -p nodes/code-review/run_1
cat > nodes/code-review/run_1/eval-good.md << 'EOF'
# Review

### 🔵 suggestion — Minor style issue
→ Use const

VERDICT: PASS — FINDINGS[1]
EOF
mkdir -p nodes/code-review/run_1/eval-bad.md
STDOUT_FILE=$(mktemp)
STDERR_FILE=$(mktemp)
$HARNESS synthesize . --node code-review > "$STDOUT_FILE" 2> "$STDERR_FILE" || true
STDOUT_OUT=$(cat "$STDOUT_FILE")
STDERR_OUT=$(cat "$STDERR_FILE")
assert_contains "$STDOUT_OUT" "verdict" "2.1a: synthesize produces output despite one bad file"
assert_contains "$STDERR_OUT" "Cannot read" "2.1b: stderr warns about unreadable file"
rm -f "$STDOUT_FILE" "$STDERR_FILE"
cd "$ORIG_DIR"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 3: 🟡 MEDIUM — eval-report readErr + zero findings ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 3.1: report with zero findings"
# eval-report.mjs expects evaluation-wave-N.md or evaluation-wave-N-role.md files
D=$(mktemp -d)
mkdir -p "$D/.harness"
cat > "$D/.harness/evaluation-wave-1.md" << 'EOF'
# Review — clean code

No issues found.

VERDICT: PASS — FINDINGS[0]
EOF
OUT=$($HARNESS report "$D" --mode review --task "test" 2>/dev/null)
assert_contains "$OUT" "agents" "3.1a: report produces output for zero-finding eval"
assert_contains "$OUT" '"suggestion": 0' "3.1b: zero suggestions"
rm -rf "$D"

echo ""
echo "── 3.2: diff with two empty evals (zero findings both)"
D=$(mktemp -d)
cat > "$D/eval1.md" << 'EOF'
# Round 1 Review
VERDICT: PASS — FINDINGS[0]
EOF
cat > "$D/eval2.md" << 'EOF'
# Round 2 Review
VERDICT: PASS — FINDINGS[0]
EOF
OUT=$($HARNESS diff "$D/eval1.md" "$D/eval2.md" 2>/dev/null)
assert_field_eq "$OUT" "['recurring']" "0" "3.2a: 0 recurring findings"
assert_field_eq "$OUT" "['new']" "0" "3.2b: 0 new findings"
assert_field_eq "$OUT" "['resolved']" "0" "3.2c: 0 resolved findings"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 4: 🟡 MEDIUM — flow-escape.mjs cmdGoto edge cases ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 4.1: goto with --flow flag having no value (dangling)"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --entry build --dir . > /dev/null 2>&1
mkdir -p nodes/build
cat > nodes/build/handshake.json << 'EOF'
{"nodeId":"build","nodeType":"build","status":"completed","summary":"done","timestamp":"2024-01-01T00:00:00Z"}
EOF
$HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir . > /dev/null 2>&1
# Dangling --flow at end (no value after it)
OUT=$($HARNESS goto build --dir . --flow 2>/dev/null || true)
# NOTE: `\|` is BRE, `|` is ERE. grep -qE uses ERE, so use `|`
assert_contains "$OUT" "goto|error" "4.1a: goto handles dangling flag gracefully"

echo ""
echo "── 4.2: goto with flags reordered: target after --dir value"
D2=$(mktemp -d)
cd "$D2"
$HARNESS init --flow build-verify --entry build --dir . > /dev/null 2>&1
mkdir -p nodes/build
cat > nodes/build/handshake.json << 'EOF'
{"nodeId":"build","nodeType":"build","status":"completed","summary":"done","timestamp":"2024-01-01T00:00:00Z"}
EOF
$HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir . > /dev/null 2>&1
OUT=$($HARNESS goto --dir . build 2>/dev/null || true)
assert_contains "$OUT" '"goto"' "4.2a: goto finds target after --dir flag"
cd "$ORIG_DIR"
rm -rf "$D" "$D2"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 5: 🟡 MEDIUM — file-lock release edge cases ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 5.1: release when lock file already deleted"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
OUT=$($HARNESS skip --dir . 2>/dev/null)
assert_not_contains "$(ls)" "flow-state.json.lock" "5.1a: no lock file after skip completes"

echo ""
echo "── 5.2: stale lock from dead PID gets cleaned up"
D2=$(mktemp -d)
cd "$D2"
$HARNESS init --flow review --dir . > /dev/null 2>&1
echo '{"pid": 99999, "timestamp": "2024-01-01T00:00:00Z", "command": "other"}' > flow-state.json.lock
OUT=$($HARNESS skip --dir . 2>/dev/null)
assert_contains "$OUT" "skipped|next" "5.2a: stale lock from dead PID cleaned up, skip succeeds"
cd "$ORIG_DIR"
rm -rf "$D" "$D2"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 6: 🟡 MEDIUM — loop-tick unknown unit type ==="
# ═══════════════════════════════════════════════════════════════════

echo ""
echo "── 6.1: complete-tick with unknown unit type"
D=$(mktemp -d)
cd "$D"
mkdir -p .harness
cat > .harness/plan.md << 'EOF'
- u1.1: foobar — do something unknown type
EOF
$HARNESS init-loop --skip-scope --dir .harness > /dev/null 2>&1
$HARNESS next-tick --dir .harness > /dev/null 2>&1
echo '{"pass": true}' > artifact.json
OUT=$($HARNESS complete-tick --dir .harness --unit u1.1 --status completed --artifacts "$(pwd)/artifact.json" 2>/dev/null)
assert_field_eq "$OUT" "['completed']" "True" "6.1a: unknown unit type still completes"
cd "$ORIG_DIR"
rm -rf "$D"


print_results
