#!/usr/bin/env bash
# test-gaps4 — split part
set -euo pipefail

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

assert_exit_nonzero() {
  local label="$1"; shift
  if "$@" > /dev/null 2>&1; then
    echo "  ❌ $label — expected nonzero exit"; FAIL=$((FAIL+1))
  else
    echo "  ✅ $label"; PASS=$((PASS+1))
  fi
}

mkdir -p "$HOME/.claude/flows"


# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 4: eval-parser.mjs + eval-commands.mjs edge branches ==="
# ═══════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 4.1: parseEvaluation — finding with fix arrow line containing hedging"
# eval-parser.mjs L84-89: fix line with hedging
D=$(mktemp -d)
cat > "$D/eval-hedge-fix.md" << 'EVAL'
🔴 critical — api.js:10 — Missing auth check
→ You might consider adding authentication here
Reasoning: This could potentially be a security issue
VERDICT: FAIL FINDINGS[1]
EVAL
OUT=$($HARNESS verify "$D/eval-hedge-fix.md" 2>/dev/null)
# Both fix line ("might consider") and reasoning line ("could potentially") have hedging
HEDGING_COUNT=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['hedging_detected']))" 2>/dev/null || echo "0")
if [ "$HEDGING_COUNT" -ge 2 ]; then
  echo "  ✅ 4.1a: hedging detected in fix AND reasoning line ($HEDGING_COUNT items)"; PASS=$((PASS+1))
else
  echo "  ❌ 4.1a: expected ≥2 hedging items, got $HEDGING_COUNT"; FAIL=$((FAIL+1))
fi
rm -rf "$D"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 4.2: parseEvaluation — reasoning line with hedging"
# eval-parser.mjs L93-98: reasoning line with hedging
D=$(mktemp -d)
cat > "$D/eval-hedge-reason.md" << 'EVAL'
🟡 warning — api.js:20 — Slow query
→ Add index
Reasoning: This could potentially cause performance issues
VERDICT: ITERATE FINDINGS[1]
EVAL
OUT=$($HARNESS verify "$D/eval-hedge-reason.md" 2>/dev/null)
assert_contains "$OUT" "could potentially" "4.2a: hedging detected in reasoning line"
rm -rf "$D"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 4.3: parseEvaluation — CRLF line endings handled"
# eval-parser.mjs L17: replace \r\n with \n
D=$(mktemp -d)
printf "🔴 critical — api.js:10 — Bug\r\n→ Fix it\r\nVERDICT: FAIL FINDINGS[1]\r\n" > "$D/eval-crlf.md"
OUT=$($HARNESS verify "$D/eval-crlf.md" 2>/dev/null)
assert_field_eq "$OUT" "['critical']" "1" "4.3a: CRLF eval parsed correctly"
assert_field_eq "$OUT" "['verdict_present']" "True" "4.3b: verdict found despite CRLF"
rm -rf "$D"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 4.4: synthesize — run flag selects specific run directory"
# eval-commands.mjs L85-86: --run flag
# Evals must be fat (≥50 lines) to clear compound defense thin-eval layer.
D=$(mktemp -d)
mkdir -p "$D/nodes/code-review/run_1"
mkdir -p "$D/nodes/code-review/run_2"
# Generate fat evals programmatically to avoid heredoc bloat
python3 -c "
header = '# Code Review\n\n## Scope\nThe review covered the entire module with focus on correctness and reliability.\n\n## Methodology\n'
body = '\n'.join(['Walked through step {} of the data flow and verified the expected behavior.'.format(i) for i in range(1, 40)])
footer = '\n\n## Findings\n🔴 critical — old.js:1 — old finding from run_1\n→ Fix the issue immediately\nReasoning: This is a regression from the previous version and blocks release.\n\n## Conclusion\nOne critical issue found.\n\nVERDICT: FAIL FINDINGS[1]\n'
open('$D/nodes/code-review/run_1/eval-old.md', 'w').write(header + body + footer)
"
python3 -c "
header = '# Code Review\n\n## Scope\nThe review examined the fix applied in the second run of this unit.\n\n## Methodology\n'
body = '\n'.join(['Validated that layer {} now behaves correctly after the fix.'.format(i) for i in range(1, 40)])
footer = '\n\n## Findings\n🔵 suggestion — new.js:2 — minor style thing\n→ Use a more descriptive variable name here\nReasoning: The name does not communicate intent to readers unfamiliar with the module.\n\n🔵 suggestion — new.js:8 — add a brief comment above the helper function\n→ Document the pre-condition the caller must uphold\nReasoning: The function assumes sorted input but this is not obvious from the signature.\n\n## Conclusion\nTwo minor style suggestions remain.\n\nVERDICT: PASS FINDINGS[2]\n'
open('$D/nodes/code-review/run_2/eval-new.md', 'w').write(header + body + footer)
"
cat > "$D/nodes/code-review/run_2/eval-skeptic-owner.md" <<'SOEOF'
# Skeptic-Owner Evaluation

## Mechanism Audit
🔵 src/config.ts:1 — Config values not validated at startup
→ Add runtime validation with zod schema at boot
Reasoning: Invalid config will cause runtime errors instead of fast startup failure.

## Lifecycle
🔵 src/server.ts:5 — No graceful shutdown handler
→ Add SIGTERM handler that drains connections
Reasoning: Hard shutdown drops in-flight requests during deployment.

## Summary
2 suggestions. No critical or warning issues.
SOEOF
OUT=$($HARNESS synthesize "$D" --node code-review --run 2 2>/dev/null)
assert_field_eq "$OUT" "['verdict']" "PASS" "4.4a: --run 2 uses run_2 (PASS verdict)"
# Verify run_1 would give FAIL
OUT=$($HARNESS synthesize "$D" --node code-review --run 1 2>/dev/null)
assert_field_eq "$OUT" "['verdict']" "FAIL" "4.4b: --run 1 uses run_1 (FAIL verdict)"
rm -rf "$D"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 4.5: verify — file not found (ENOENT) exits nonzero"
# eval-commands.mjs L20-21: ENOENT branch
assert_exit_nonzero "4.5a: verify nonexistent file" $HARNESS verify /tmp/nonexistent-eval-file.md

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 4.6: synthesize — eval.md (no role prefix) → roleName 'evaluator'"
# eval-commands.mjs L157-158: f.name === "eval.md" → "evaluator"
D=$(mktemp -d)
mkdir -p "$D/nodes/review/run_1"
cat > "$D/nodes/review/run_1/eval.md" << 'EVAL'
🟡 warning — slow query
VERDICT: ITERATE FINDINGS[1]
EVAL
OUT=$($HARNESS synthesize "$D" --node review 2>/dev/null)
assert_field_eq "$OUT" "['roles'][0]['role']" "evaluator" "4.6a: eval.md maps to role 'evaluator'"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 5: viz-commands.mjs branches ==="
# ═══════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 5.1: getMarker — entryNode visited but not current → ✅"
# viz-commands.mjs L13: entryNode !== currentNode → ✅
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
# Review node needs ≥2 distinct eval artifacts for transition to succeed.
mkdir -p nodes/review/run_1
cat > nodes/review/run_1/eval-a.md << 'EVAL'
# Reviewer A
Checked the implementation for correctness and style.
No blocking issues found in this pass.
EVAL
cat > nodes/review/run_1/eval-b.md << 'EVAL'
# Reviewer B
Traced the data flow through the core module.
Identified no regressions relative to the prior version.
EVAL
cat > nodes/review/handshake.json << 'HS'
{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[{"type":"eval","path":"run_1/eval-a.md"},{"type":"eval","path":"run_1/eval-b.md"}]}
HS
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir . > /dev/null 2>&1
OUT=$($HARNESS viz --flow review --dir . 2>/dev/null)
assert_contains "$OUT" "✅ review" "5.1a: visited entry node shows ✅"
assert_contains "$OUT" "▶ gate" "5.1b: current node shows ▶"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 5.2: viz --json outputs JSON with nodes and loopbacks arrays"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --dir . > /dev/null 2>&1
OUT=$($HARNESS viz --flow build-verify --dir . --json 2>/dev/null)
assert_field_eq "$OUT" "['nodes'][0]['id']" "build" "5.2a: JSON output has first node"
assert_contains "$OUT" "loopbacks" "5.2b: JSON output has loopbacks array"
rm -rf "$D"
cd /tmp

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 6: flow-transition.mjs — finalize edge branches ==="
# ═══════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 6.1: finalize — no flow-state.json"
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS finalize --dir . 2>/dev/null || true)
assert_field_eq "$OUT" "['finalized']" "False" "6.1a: finalize with no state file"
assert_contains "$OUT" "not found" "6.1b: error mentions not found"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 6.2: finalize — unknown flow template in state"
D=$(mktemp -d)
cd "$D"
mkdir -p nodes
cat > flow-state.json << 'EOF'
{"version":"1.0","flowTemplate":"nonexistent-flow","currentNode":"a","entryNode":"a","totalSteps":0,"history":[],"edgeCounts":{},"_written_by":"opc-harness","_last_modified":"2024-01-01T00:00:00Z","_write_nonce":"abc123"}
EOF
OUT=$($HARNESS finalize --dir . 2>/dev/null || true)
assert_field_eq "$OUT" "['finalized']" "False" "6.2a: finalize with unknown flow"
assert_contains "$OUT" "unknown flow" "6.2b: error mentions unknown flow"
rm -rf "$D"
cd /tmp


print_results
