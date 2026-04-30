#!/bin/bash
set -e
source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else json.dumps(v))" 2>/dev/null
}

assert_field_eq() {
  local desc="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(jq_field "$json" "$field")
  if [ -z "$actual" ]; then
    echo "  ❌ $desc — no JSON output (field=$field)"
    FAIL=$((FAIL + 1))
    return
  fi
  actual=$(echo "$actual" | tr -d '"')
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — expected '$expected', got '$actual'"
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
    echo "  ❌ $desc — pattern '$pattern' found but should not be"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

assert_exit_nonzero() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>/dev/null; then
    echo "  ❌ $desc — expected nonzero exit"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

echo ""
echo "=== GAP-7: Synthesize verdict paths ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 7.1: Synthesize FAIL verdict (thin eval + D2 enforce) ---"
rm -rf .h-synth && mkdir -p .h-synth/nodes/code-review/run_1
cat > .h-synth/nodes/code-review/run_1/eval-engineer.md << 'EVAL'
# Engineer Review
VERDICT: PASS FINDINGS[2]
🟡 Warning A — util.js:10 — missing error handling
🟡 Warning B — api.js:20 — timeout not set
EVAL
OUT=$($HARNESS synthesize .h-synth --node code-review)
# Thin eval (5 lines) + singleHeading + missingReasoning + missingFix = 4 layers → D2 enforce → FAIL
assert_contains "FAIL verdict (D2)" "$OUT" "FAIL"

echo ""
echo "--- 7.2: Synthesize PASS verdict (suggestions only) ---"
rm -rf .h-synth2 && mkdir -p .h-synth2/nodes/code-review/run_1
# Eval must be fat enough (≥50 lines, multiple sections, diverse content)
# to clear the compound defense thin-eval / single-heading / variance layers.
cat > .h-synth2/nodes/code-review/run_1/eval-engineer.md << 'EVAL'
# Engineer Review

## Context
Reviewed the stylesheet for maintainability and consistency.
Checked naming conventions, variable usage, and selector specificity.
The codebase uses a mix of modules with varying maturity levels.
Primary focus: tokens, layout, responsive behavior, and animation timing.
Secondary focus: specificity, inheritance, and cascade interactions.

## Methodology
Walked through the stylesheet file by file noting patterns.
Each section was examined for repetition that could be abstracted.
Color values and spacing units received particular attention.
Browser prefix coverage was cross-checked against caniuse data.
Animation easing curves were verified against the design tokens.

## Findings

🔵 Consider using CSS variables — style.css:5 — hex color #3366cc appears 7 times
→ Extract to --color-primary custom property declared at :root
Reasoning: Centralizing color definitions makes theme updates trivial and prevents drift across components.

## Positive Observations
The selector specificity is generally well-controlled throughout the file.
No !important declarations were found outside the reset block.
Media queries are consistently ordered mobile-first with logical breakpoints.
Animation durations use a reasonable set of values (100ms, 200ms, 400ms).
Z-index values are clustered in recognizable ranges by layer role.
Font stack declarations include appropriate fallbacks for all major platforms.
Focus styles are present on every interactive element.
Hover states respect the prefers-reduced-motion media query.

## Areas Reviewed
Color and typography tokens were audited against the design system.
Layout and spacing systems use a consistent 4px base unit throughout.
Component class naming follows a BEM-inspired convention reliably.
Responsive breakpoint usage is consistent across pages and components.
Animation and transition timing matches the documented motion tokens.
Browser prefix coverage is appropriate for the stated support matrix.
Custom scrollbar styles are gated behind feature detection.
Print stylesheet is minimal but covers the critical reset cases.

## Conclusion
The stylesheet is in good shape overall and ready for the next release cycle.
One minor optimization suggestion was noted above in the findings section.
No blocking issues were identified during this pass of the codebase.
The team has clearly invested in CSS architecture and it shows in the quality.

VERDICT: PASS FINDINGS[1]
EVAL
cat > .h-synth2/nodes/code-review/run_1/eval-skeptic-owner.md <<'SOEOF'
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
OUT=$($HARNESS synthesize .h-synth2 --node code-review)
assert_contains "PASS verdict" "$OUT" "PASS"
assert_contains "LGTM reason" "$OUT" "LGTM\|suggestions only"

echo ""
echo "--- 7.3: Synthesize --run explicit ---"
rm -rf .h-synth3 && mkdir -p .h-synth3/nodes/code-review/run_2
cat > .h-synth3/nodes/code-review/run_2/eval-security.md << 'EVAL'
# Security Review
VERDICT: FAIL FINDINGS[1]
🔴 Critical — auth.js:1 — SQL injection
→ Use parameterized queries
Reasoning: user input concatenated into SQL
EVAL
OUT=$($HARNESS synthesize .h-synth3 --node code-review --run 2)
assert_contains "explicit run" "$OUT" "FAIL"

echo ""
echo "--- 7.4: Synthesize no runs found → BLOCKED ---"
rm -rf .h-synth4 && mkdir -p .h-synth4/nodes/code-review
OUT=$($HARNESS synthesize .h-synth4 --node code-review 2>/dev/null)
assert_contains "synth no runs" "$OUT" "BLOCKED"

echo ""
echo "--- 7.5: Synthesize no eval files → BLOCKED ---"
rm -rf .h-synth5 && mkdir -p .h-synth5/nodes/code-review/run_1
echo "not an eval" > .h-synth5/nodes/code-review/run_1/readme.txt
OUT=$($HARNESS synthesize .h-synth5 --node code-review 2>/dev/null)
assert_contains "synth no evals" "$OUT" "BLOCKED"

echo ""
echo "--- 7.6: Synthesize role name from eval.md ---"
rm -rf .h-synth6 && mkdir -p .h-synth6/nodes/code-review/run_1
cat > .h-synth6/nodes/code-review/run_1/eval.md << 'EVAL'
# Generic Review
VERDICT: PASS FINDINGS[0]
EVAL
OUT=$($HARNESS synthesize .h-synth6 --node code-review)
assert_contains "evaluator role" "$OUT" "evaluator"

echo ""
echo "--- 7.7: Synthesize ROUND_RE filter ---"
rm -rf .h-wave && mkdir -p .h-wave/.harness
# Fat eval to clear compound defense — legacy --wave mode still runs
# synthesize against eval-parser which applies thin-eval checks.
cat > .h-wave/.harness/evaluation-wave-1-security.md << 'EVAL'
# Security Review

## Scope
Reviewed authentication, authorization, input validation, and data storage.
Scanned for OWASP Top 10 categories with a focus on injection and broken access control.
Verified session and token lifecycle end-to-end for the critical user journeys.

## Methodology
Walked through each request handler end-to-end from entry to response.
Cross-referenced with the existing security headers configuration file.
Verified that secrets do not appear in logs or error messages on any path.
Ran a static analysis sweep focused on taint sources and sinks in handlers.
Checked that all outbound HTTP calls validate the target host before dispatch.

## Areas Reviewed
Session management and token handling across all authenticated endpoints.
SQL query construction and parameterization in the data access layer.
User input sanitization on all public-facing and internal-public endpoints.
File upload handling, MIME validation, and storage path containment.
Rate limiting configuration on authentication and password-reset endpoints.
Outbound request validation to prevent server-side request forgery attacks.
Cookie attributes including Secure, HttpOnly, SameSite, and Domain scope.
Content Security Policy headers and their effective directives.

## Positive Observations
Password hashing uses a modern algorithm with appropriate cost factor.
JWT tokens are signed with an asymmetric key and include sensible expiration.
All database queries use parameterized statements via the ORM layer.
CORS is configured narrowly to the known production and staging origins.
Secrets are loaded from environment variables and are never logged.
Security headers are applied consistently via middleware on every response.
Error responses avoid leaking stack traces or internal identifiers.
Session invalidation on logout clears both server and client state.

## Cross-Cutting Concerns
The team maintains a security posture document updated each release.
Dependency scanning runs in CI and blocks merges on critical advisories.
Penetration test findings from the last engagement have all been resolved.
A threat model exists for the authentication subsystem and is current.

## No Findings
No critical, warning, or suggestion-level issues were found during this pass.
The codebase demonstrates mature security hygiene across all surfaces reviewed.
No follow-up actions are required from this review cycle at this time.

## Summary
The security review concluded without identifying any defects.
The combination of architectural discipline and tooling investment shows.
Recommendation is to proceed to the next stage of the release process.
Continue current practices for dependency hygiene and CI security gates.
A follow-up review of the new microservice is scheduled for next sprint.

VERDICT: PASS FINDINGS[0]
EVAL
# This round file should be excluded
cat > .h-wave/.harness/evaluation-wave-1-round1-security.md << 'EVAL'
Round 1 draft — should be filtered
EVAL
cat > .h-wave/.harness/evaluation-wave-1-skeptic-owner.md << 'SOEOF'
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
OUT=$($HARNESS synthesize .h-wave --wave 1)
assert_contains "round filtered" "$OUT" "PASS"
assert_not_contains "round not included" "$OUT" "Round 1 draft"


print_results
