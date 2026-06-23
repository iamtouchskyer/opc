#!/bin/bash
# Tests for text-based severity parsing + formatErrors
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

parse_eval() {
  local file="$1"
  # Use synthesize with a single file to exercise parseEvaluation
  echo "$($HARNESS verify "$file" 2>/dev/null)"
}

echo "=== TEST GROUP 1: Text-based severity parsing ==="
echo ""

# ── 1.1: Emoji severity still works (regression) ──
echo "--- 1.1: Emoji severity (regression) ---"
cat > emoji.md << 'EOF'
# Review
## Security
🔴 src/app.ts:10 — XSS vulnerability in user input
Reasoning: User input rendered without escaping.
→ Use textContent instead of innerHTML.
## Summary
VERDICT: FINDINGS[1]
EOF
OUT=$(parse_eval emoji.md)
CRIT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('critical',0))" 2>/dev/null)
if [ "$CRIT" = "1" ]; then
  echo "  ✅ emoji 🔴 parsed as critical"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected critical=1, got: $CRIT"
  FAIL=$((FAIL + 1))
fi

# ── 1.2: [CRITICAL] text severity ──
echo "--- 1.2: [CRITICAL] text severity ---"
cat > text-crit.md << 'EOF'
# Review
## Security
[CRITICAL] src/app.ts:10 — XSS vulnerability in user input
Reasoning: User input rendered without escaping.
→ Use textContent instead of innerHTML.
## Summary
VERDICT: FINDINGS[1]
EOF
OUT=$(parse_eval text-crit.md)
CRIT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('critical',0))" 2>/dev/null)
if [ "$CRIT" = "1" ]; then
  echo "  ✅ [CRITICAL] parsed as critical"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected critical=1, got: $CRIT"
  FAIL=$((FAIL + 1))
fi

# ── 1.3: [WARNING] text severity ──
echo "--- 1.3: [WARNING] text severity ---"
cat > text-warn.md << 'EOF'
# Review
## Performance
[WARNING] src/db.ts:42 — Missing connection pooling
Reasoning: Each request creates a new database connection.
→ Use connection pool with max 10 connections.
## Summary
VERDICT: FINDINGS[1]
EOF
OUT=$(parse_eval text-warn.md)
WARN=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('warning',0))" 2>/dev/null)
if [ "$WARN" = "1" ]; then
  echo "  ✅ [WARNING] parsed as warning"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected warning=1, got: $WARN"
  FAIL=$((FAIL + 1))
fi

# ── 1.4: [SUGGESTION] text severity ──
echo "--- 1.4: [SUGGESTION] text severity ---"
cat > text-sug.md << 'EOF'
# Review
## Code Quality
[SUGGESTION] src/utils.ts:30 — Unused helper function
Reasoning: Function is never imported in any other module.
→ Remove dead code.
## Summary
VERDICT: FINDINGS[1]
EOF
OUT=$(parse_eval text-sug.md)
SUG=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('suggestion',0))" 2>/dev/null)
if [ "$SUG" = "1" ]; then
  echo "  ✅ [SUGGESTION] parsed as suggestion"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected suggestion=1, got: $SUG"
  FAIL=$((FAIL + 1))
fi

# ── 1.5: Lowercase [critical] text severity ──
echo "--- 1.5: Lowercase [critical] ---"
cat > text-lower.md << 'EOF'
# Review
## Security
[critical] src/app.ts:10 — SQL injection in query builder
Reasoning: String concatenation used for SQL queries.
→ Use parameterized queries.
## Summary
VERDICT: FINDINGS[1]
EOF
OUT=$(parse_eval text-lower.md)
CRIT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('critical',0))" 2>/dev/null)
if [ "$CRIT" = "1" ]; then
  echo "  ✅ [critical] lowercase parsed"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected critical=1, got: $CRIT"
  FAIL=$((FAIL + 1))
fi

# ── 1.6: Mixed emoji + text in same eval ──
echo "--- 1.6: Mixed emoji + text severity ---"
cat > mixed.md << 'EOF'
# Review
## Security
🔴 src/auth.ts:10 — Session fixation
Reasoning: Session not regenerated after login.
→ Call session.regenerate() after auth.
## Performance
[WARNING] src/db.ts:42 — N+1 query pattern
Reasoning: Loading related records in a loop.
→ Use JOIN or batch loading.
## Code Quality
🔵 src/utils.ts:30 — Unused import
Reasoning: Dead import clutters readability.
→ Remove unused import.
## Summary
VERDICT: FINDINGS[3]
EOF
OUT=$(parse_eval mixed.md)
TOTAL=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('critical',0)+d.get('warning',0)+d.get('suggestion',0))" 2>/dev/null)
if [ "$TOTAL" = "3" ]; then
  echo "  ✅ mixed: 3 findings total"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected 3 findings, got: $TOTAL"
  FAIL=$((FAIL + 1))
fi

# ── 1.7: Bare CRITICAL without brackets → NOT parsed ──
echo "--- 1.7: Bare CRITICAL without brackets (no false positive) ---"
cat > bare.md << 'EOF'
# Review
## Notes
This is a critical component of the system.
The warning about memory leaks is important.
No suggestion for improvement needed.
## Summary
VERDICT: LGTM
EOF
OUT=$(parse_eval bare.md)
TOTAL=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('critical',0)+d.get('warning',0)+d.get('suggestion',0))" 2>/dev/null)
if [ "$TOTAL" = "0" ]; then
  echo "  ✅ bare words not parsed as severity"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected 0, got: $TOTAL (false positive)"
  FAIL=$((FAIL + 1))
fi

# ── 1.8: Legacy metadata severity line → NOT parsed ──
echo "--- 1.8: Legacy metadata line (no false positive) ---"
cat > legacy-meta.md << 'EOF'
# Review

## Finding 1 — Real structured issue title
**Severity**: 🔴
**Location**: src/legacy.js:7

VERDICT: FINDINGS[1]
EOF
OUT=$(parse_eval legacy-meta.md)
TOTAL=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('critical',0)+d.get('warning',0)+d.get('suggestion',0))" 2>/dev/null)
if [ "$TOTAL" = "0" ]; then
  echo "  ✅ metadata severity is not parsed as a finding"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected 0 metadata findings, got: $TOTAL"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== TEST GROUP 2: formatErrors ==="
echo ""

# ── 2.1: Unstructured severity line → formatError ──
echo "--- 2.1: Unstructured severity → formatError ---"
cat > unstructured.md << 'EOF'
# Review
## Issues
🔴 This is bad code
🟡 Performance could be better
🔵 Consider refactoring
## Summary
VERDICT: FINDINGS[3]
EOF
OUT=$(parse_eval unstructured.md)
# verify returns formatErrors array — check it has entries
FE_COUNT=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('formatErrors',[])))" 2>/dev/null)
if [ "$FE_COUNT" = "3" ]; then
  echo "  ✅ 3 formatErrors collected for unstructured findings"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected 3 formatErrors, got: $FE_COUNT"
  FAIL=$((FAIL + 1))
fi

# ── 2.2: formatErrors with 0 structured → synthesize produces warning ──
echo "--- 2.2: formatErrors + 0 structured → synthesize warns ---"
# Set up a proper harness dir for synthesize
rm -rf .h-fe
$HARNESS init --flow review --entry review --dir .h-fe 2>/dev/null
mkdir -p .h-fe/nodes/review/run_1
# Analyst: all unstructured (no em-dash, no file:line)
cat > .h-fe/nodes/review/run_1/eval-analyst.md << 'EVALEOF'
# Analyst Review
## Issues
🔴 This is bad
🟡 That is bad
🔵 Everything is bad
## Summary
VERDICT: FINDINGS[3]
EVALEOF
# Checker: properly structured
cat > .h-fe/nodes/review/run_1/eval-checker.md << 'EVALEOF'
# Checker Review
## Security
🔴 src/auth.ts:10 — Session fixation vulnerability
Reasoning: Session ID not regenerated after login.
→ Call session.regenerate() after authentication.
## Performance
🔵 src/db.ts:42 — Consider adding connection pooling
Reasoning: Creates new connection per request.
→ Use connection pool.
## Summary
VERDICT: FINDINGS[2]
EVALEOF
OUT=$($HARNESS synthesize .h-fe --node review 2>/dev/null)
WARNINGS=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(d.get('thinEvalWarnings',[])))" 2>/dev/null)
if echo "$WARNINGS" | grep -q "format"; then
  echo "  ✅ synthesize warns about format errors"
  PASS=$((PASS + 1))
else
  echo "  ❌ no format warning in: $WARNINGS"
  FAIL=$((FAIL + 1))
fi

# ── 2.3: formatErrors increment warning totals ──
echo "--- 2.3: formatErrors move synthesize verdict ---"
rm -rf .h-fe-count
$HARNESS init --flow review --entry review --dir .h-fe-count 2>/dev/null
mkdir -p .h-fe-count/nodes/review/run_1
cat > .h-fe-count/nodes/review/run_1/eval-skeptic-owner.md << 'EVALEOF'
# Skeptic Owner Review

## Findings
🟡 This severity marker is intentionally unstructured
Reasoning: the parser must not silently drop a severity marker.
→ Rewrite the finding with file:line and an em dash.

## Scope
EVALEOF
for i in $(seq 1 55); do echo "Format error regression line $i has varied review context for the parser." >> .h-fe-count/nodes/review/run_1/eval-skeptic-owner.md; done
cat >> .h-fe-count/nodes/review/run_1/eval-skeptic-owner.md << 'EVALEOF'

VERDICT: FINDINGS[1]
EVALEOF
OUT=$($HARNESS synthesize .h-fe-count --node review 2>/dev/null)
SYNTH_VERDICT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('verdict'))" 2>/dev/null)
WARN_TOTAL=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totals',{}).get('warning',0))" 2>/dev/null)
if [ "$SYNTH_VERDICT" = "ITERATE" ] && [ "$WARN_TOTAL" -ge 2 ]; then
  echo "  ✅ formatErrors contribute warning totals and ITERATE"
  PASS=$((PASS + 1))
else
  echo "  ❌ expected ITERATE with warning total >=2, got verdict=$SYNTH_VERDICT warning=$WARN_TOTAL"
  FAIL=$((FAIL + 1))
fi

print_results
