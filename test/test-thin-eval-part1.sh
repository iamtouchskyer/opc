#!/bin/bash
set -e
source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else json.dumps(v))" 2>/dev/null
}

jq_nested() {
  echo "$1" | python3 -c "
import sys, json
d = json.load(sys.stdin)
keys = '$2'.split('.')
for k in keys:
    if isinstance(d, dict):
        d = d.get(k)
    else:
        d = None
        break
print('__NULL__' if d is None else json.dumps(d))
" 2>/dev/null
}

assert_field_eq() {
  local desc="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(jq_field "$json" "$field")
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — $field: expected $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -q "$pattern"; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — pattern '$pattern' not found"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -q "$pattern"; then
    echo "  ❌ $desc — pattern '$pattern' found (should not be)"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

# ═══════════════════════════════════════════════════════════════
echo "=== TEST GROUP 1: Thin eval detection in synthesize ==="
# ═══════════════════════════════════════════════════════════════

# Setup: create a .harness-like structure for synthesize
mkdir -p .harness/nodes/code-review/run_1

echo "--- 1.1: Thin eval (< 50 lines) → warning ---"
# Create a thin eval (20 lines)
cat > .harness/nodes/code-review/run_1/eval-short.md <<'EOF'
# Short Review

🔵 src/main.ts:10 — Minor issue
→ Fix it
Reasoning: Style.

VERDICT: PASS FINDINGS[1]
EOF

# Create a normal-length eval (60+ lines)
cat > .harness/nodes/code-review/run_1/eval-long.md <<'EVALEOF'
# Thorough Code Review

## Architecture
The codebase follows a clean layered architecture with clear separation of concerns.

## Findings

🔵 src/main.ts:10 — Import ordering inconsistent
→ Group external imports before internal ones
Reasoning: Following the project's established convention in other files.

🔵 src/utils.ts:25 — Unused helper function
→ Remove `formatDate` — it's not called anywhere
Reasoning: Dead code increases maintenance burden.

🔵 src/db.ts:42 — Connection pool size hardcoded
→ Move to environment variable
Reasoning: Production environments may need different pool sizes.

## Summary

Overall code quality is good. Three minor suggestions found, all style/cleanup.
No critical or warning issues detected.
The implementation follows existing patterns well.

Line 30: Additional padding for test purposes.
Line 31: Additional padding for test purposes.
Line 32: Additional padding for test purposes.
Line 33: Additional padding for test purposes.
Line 34: Additional padding for test purposes.
Line 35: Additional padding for test purposes.
Line 36: Additional padding for test purposes.
Line 37: Additional padding for test purposes.
Line 38: Additional padding for test purposes.
Line 39: Additional padding for test purposes.
Line 40: Additional padding for test purposes.
Line 41: Additional padding for test purposes.
Line 42: Additional padding for test purposes.
Line 43: Additional padding for test purposes.
Line 44: Additional padding for test purposes.
Line 45: Additional padding for test purposes.
Line 46: Additional padding for test purposes.
Line 47: Additional padding for test purposes.
Line 48: Additional padding for test purposes.
Line 49: Additional padding for test purposes.
Line 50: Additional padding for test purposes.
Line 51: Additional padding for test purposes.

VERDICT: PASS FINDINGS[3]
EVALEOF

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
# Short eval has reasoning + fix + file ref → substance exempt from thinEval
assert_not_contains "thin eval exempted (substance)" "$OUT" "eval is thin"
assert_field_eq "verdict PASS (substance exempt)" "$OUT" "verdict" '"PASS"'

echo ""
echo "--- 1.2: All evals thick → no thinEvalWarnings ---"
rm -f .harness/nodes/code-review/run_1/eval-short.md
# Only eval-long.md remains
OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_not_contains "no thin warning" "$OUT" "eval is thin"

echo ""
echo "--- 1.3: Eval with 0 file:line refs but findings → warning ---"
cat > .harness/nodes/code-review/run_1/eval-norefs.md <<'EVALEOF'
# Review Without References

## Findings

🔵 The code has some style issues that should be fixed
→ Run the linter
Reasoning: Consistent style is important for maintainability.

🔵 Some functions could be better documented
→ Add JSDoc comments
Reasoning: Documentation helps future developers.

## Summary

Minor issues found. Overall the code is acceptable.
The implementation follows established patterns.
No critical issues detected in this review.
The architecture looks sound and well-structured.
Testing coverage appears adequate.
Error handling is present but could be improved.
Logging is minimal but sufficient.
Configuration management follows best practices.
The build pipeline is well-configured.
Dependencies are up to date.
Security best practices are generally followed.
Performance seems acceptable for current scale.
The API design is RESTful and consistent.
Database queries are reasonable.
Frontend components are well-organized.
State management is clean.
Routing is straightforward.
Authentication flow is secure.
Authorization checks are in place.
Input validation is present.
Output encoding is correct.
CORS configuration is appropriate.
Rate limiting is configured.
Caching strategy is reasonable.
Error responses are informative.
Pagination is implemented correctly.
Search functionality works as expected.
File upload handling is secure.
Email sending is queued properly.
Background jobs are reliable.
Monitoring is configured.
Alerting thresholds are sensible.
Deployment process is automated.
Rollback procedure is documented.
Feature flags are used appropriately.
A/B testing infrastructure exists.
Analytics tracking is comprehensive.
Privacy controls are in place.
GDPR compliance is addressed.
Accessibility basics are covered.
Mobile responsiveness is adequate.
Browser compatibility is tested.
CDN configuration is optimal.
SSL certificates are valid.
DNS configuration is correct.
Backup strategy is documented.

VERDICT: PASS FINDINGS[2]
EVALEOF

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_contains "no file:line warning" "$OUT" "0 file:line references"

print_results
