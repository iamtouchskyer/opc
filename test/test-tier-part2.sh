#!/bin/bash
# test-tier — split part
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

jq_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('__NULL__' if v is None else json.dumps(v))" 2>/dev/null
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

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 3: synthesize with tier coverage ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 3.1: Synthesize with tier — lazy eval gets ITERATE ---"
rm -rf .h-synth && mkdir -p .h-synth/nodes/code-review/run_1
$HARNESS init --flow build-verify --tier polished --dir .h-synth 2>/dev/null >/dev/null
cat > .h-synth/nodes/code-review/run_1/eval-frontend.md << 'EVAL'
# Frontend Review
## VERDICT
VERDICT: LGTM — nothing found after thorough review
EVAL
OUT=$($HARNESS synthesize .h-synth --node code-review 2>/dev/null)
assert_field_eq "lazy eval ITERATE" "$OUT" "verdict" "\"ITERATE\""
assert_contains "has tierCoverage" "$OUT" "tierCoverage"
# Should have uncovered items
UNCOV=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tierCoverage']['uncovered'])")
if [ "$UNCOV" -gt 0 ] 2>/dev/null; then
  echo "  ✅ uncovered items found ($UNCOV)"
  PASS=$((PASS + 1))
else
  echo "  ❌ uncovered=$UNCOV"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 3.2: Synthesize with tier — thorough eval PASS ---"
rm -rf .h-synth2 && mkdir -p .h-synth2/nodes/code-review/run_1
$HARNESS init --flow build-verify --tier polished --dir .h-synth2 2>/dev/null >/dev/null
cat > .h-synth2/nodes/code-review/run_1/eval-designer.md << 'EVAL'
# Designer Review

## Domain Findings

Typography hierarchy uses Inter for body and Fira Code for monospace. Heading hierarchy clear.
The heading styles are well-defined with consistent sizing and spacing across the application.

Dark/light theme: prefers-color-scheme respected, toggle in header. Color tokens via CSS custom properties.
All surfaces and text adapt correctly to both modes. No hardcoded hex values found.

Navigation sidebar with active state indicator, collapses on mobile. Structured nav with sections.
The navigation tree depth is appropriate and the collapse animation is smooth.

Responsive layout tested at 320px, 768px, 1024px, 1440px. No horizontal scroll at any viewport/breakpoint.
Grid system adapts cleanly between breakpoints. Touch targets are appropriately sized on mobile.

Code blocks use Shiki for syntax highlighting with copy button. Theme-consistent colors.
The syntax theme follows the app's color palette. Line numbers are present and aligned.

Tables have striped rows, hover effect, proper cell padding. Horizontal scroll on mobile.
The table header is sticky on long tables. Sort indicators are visible and functional.

Loading states: skeleton screens on all async operations, spinner for form submissions.
The skeleton shimmer animation matches the brand colors. No blank flashes during transitions.

Error states: error boundary with retry action. 404 page with navigation back.
Error messages are human-readable and provide context-specific recovery suggestions.

Favicon and meta tags: custom favicon, og:image, title and description set.
The favicon renders well at both 16x16 and 32x32. Social preview image looks professional.

Focus-visible styles: custom focus ring on all interactive elements. Keyboard navigation logical.
Tab order follows visual layout. Focus ring contrast ratio meets WCAG AA requirements.

Page transitions: smooth fade between views — not hard cuts.
Transition duration is consistent at 200ms. No content flash during view changes.

TESTING.md present with feature inventory, setup instructions, and cleanup steps.
Testing documentation covers all major user flows with step-by-step reproduction instructions.

## Summary
All quality baseline items verified. The product meets polished tier requirements across all categories.
Design implementation is consistent with the specification and brand guidelines.
No critical or warning-level issues found. Product is ready for acceptance testing.
The visual hierarchy guides the user's eye through the content naturally.
Interaction patterns are consistent and predictable across all views.

## VERDICT
VERDICT: LGTM — nothing found after thorough review
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
OUT=$($HARNESS synthesize .h-synth2 --node code-review 2>/dev/null)
assert_field_eq "thorough eval PASS" "$OUT" "verdict" "\"PASS\""
COV=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tierCoverage']['covered'])")
UNCOV=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tierCoverage']['uncovered'])")
echo "  → covered: $COV, uncovered: $UNCOV"
if [ "$UNCOV" -eq 0 ]; then
  echo "  ✅ all baseline items covered"
  PASS=$((PASS + 1))
else
  echo "  ❌ $UNCOV items uncovered"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 3.3: Synthesize without tier — no tierCoverage ---"
rm -rf .h-synth3 && mkdir -p .h-synth3/nodes/code-review/run_1
$HARNESS init --flow build-verify --dir .h-synth3 2>/dev/null >/dev/null
cat > .h-synth3/nodes/code-review/run_1/eval-basic.md << 'EVAL'
# Review

## Analysis

The code has been reviewed for correctness, maintainability, and performance.
All functions follow the established naming conventions in the project.
Error handling is present and follows the try-catch pattern consistently.
The implementation matches the acceptance criteria specified in the task description.
No security issues found — input validation present on all user-facing endpoints.
Dependencies are up to date and no known CVEs in the dependency tree.
Build pipeline passes without warnings. Linting rules are satisfied.
Test coverage for the changed modules is above the project threshold.
Code comments are present for non-obvious logic and public API surfaces.
The changes are backward compatible and do not break existing integrations.
Documentation has been updated to reflect the changes made.
The pull request description accurately describes the changes and their rationale.
Overall code quality is good. No issues found in this review cycle.
The architecture decisions align with the project's technical direction.
Performance characteristics are acceptable for the expected load profile.
Logging is adequate for debugging without being excessive in production.
Configuration values are externalized and not hardcoded.
The implementation follows the single responsibility principle.
Functions are appropriately sized and focused on their designated task.
The module structure facilitates testing and future maintenance.
Type definitions are accurate and provide good IDE support.
The API surface area is minimal — no unnecessary exports or public methods.
Edge cases have been considered and handled gracefully.
The error messages are informative and actionable for operators.
The code is ready to merge.

The implementation demonstrates good engineering practices throughout.
I found no issues that would warrant blocking this change.
The code is clean, well-tested, and production-ready.

## Detailed Module Review

The authentication module correctly validates JWT tokens and refreshes expired sessions.
The database layer uses connection pooling with configurable pool sizes per environment.
The API routes follow RESTful conventions with consistent error response shapes.
Middleware ordering is correct — auth before validation before handler.
The caching layer uses appropriate TTLs and invalidation strategies.
Rate limiting is configured per-endpoint based on sensitivity.
The logging middleware captures request IDs for distributed tracing.
CORS configuration is locked down to known origins.
Static asset serving includes proper cache headers.
Health check endpoint reports dependency status accurately.
The graceful shutdown handler drains connections before exit.
Environment variable validation happens at startup, not lazily.
The test helpers provide clean database state between test runs.
Mock factories generate realistic test data with proper relationships.

## VERDICT
VERDICT: LGTM
EVAL
cat > .h-synth3/nodes/code-review/run_1/eval-skeptic-owner.md <<'SOEOF'
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
OUT=$($HARNESS synthesize .h-synth3 --node code-review 2>/dev/null)
assert_field_eq "no tier PASS" "$OUT" "verdict" "\"PASS\""
TC=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tierCoverage'))")
if [ "$TC" = "None" ]; then
  echo "  ✅ no tierCoverage when no tier set"
  PASS=$((PASS + 1))
else
  echo "  ❌ tierCoverage=$TC"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 3.4: Synthesize functional tier — no extra warnings ---"
rm -rf .h-synth4 && mkdir -p .h-synth4/nodes/code-review/run_1
$HARNESS init --flow build-verify --tier functional --dir .h-synth4 2>/dev/null >/dev/null
cat > .h-synth4/nodes/code-review/run_1/eval-eng.md << 'EVAL'
# Engineering Review

## Analysis

The code has been reviewed for correctness, performance, and maintainability.
All functions are well-tested with appropriate unit test coverage.
Error handling follows the established project patterns consistently.
The implementation satisfies the acceptance criteria in the task specification.
No security vulnerabilities found in the changed code paths.
Dependencies are current and have no known CVE advisories.
Build and lint pass without warnings or errors.
The module boundaries are clean with well-defined interfaces.
Type definitions provide good IDE support and catch common errors.
Configuration is externalized and environment-specific values are not hardcoded.
Logging output is appropriate for production debugging needs.
The API contract is backward compatible with previous versions.
Database migrations are idempotent and can be safely re-run.
The implementation follows SOLID principles throughout.
Code documentation covers public APIs and non-obvious implementation details.
Performance characteristics are suitable for the expected workload.
The test suite includes both positive and negative test cases.
Edge cases are handled gracefully with appropriate error messages.
The CI pipeline validates all quality gates before merge.
No dead code or unused imports in the changed files.
The changes are appropriately scoped — one logical change per commit.
Inter-module dependencies are minimal and well-documented.
Concurrency handling is correct for the shared resources used.
The error recovery path has been tested manually.
Resource cleanup happens correctly in all code paths.

## Infrastructure Verification

The Docker configuration builds successfully with no cache invalidation issues.
The Kubernetes manifests pass schema validation for the target cluster version.
Health check probes have appropriate timeouts and failure thresholds.
The service mesh configuration routes traffic correctly between versions.
Secrets management uses the approved vault integration pattern.
The monitoring dashboard has panels for all key business metrics.
Alert thresholds are set based on historical P95 values with adequate headroom.
The rollback procedure has been tested in staging successfully.
The deployment pipeline includes automated smoke tests post-deploy.
Blue-green deployment configuration allows zero-downtime releases.
The autoscaling policy is based on CPU and memory utilization.
Database connection pooling is configured for the expected concurrent load.
The CDN cache invalidation strategy covers all affected asset paths.
Log aggregation captures structured JSON with correlation IDs.
The backup schedule meets the RPO requirement for this service tier.

## VERDICT
VERDICT: LGTM — code correct
EVAL
cat > .h-synth4/nodes/code-review/run_1/eval-skeptic-owner.md <<'SOEOF'
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
OUT=$($HARNESS synthesize .h-synth4 --node code-review 2>/dev/null)
assert_field_eq "functional PASS" "$OUT" "verdict" "\"PASS\""
# functional tier has no warning/critical items → uncovered items are all suggestions → no extra warnings
WARN=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['totals']['warning'])")
if [ "$WARN" -eq 0 ]; then
  echo "  ✅ functional tier adds no warnings"
  PASS=$((PASS + 1))
else
  echo "  ❌ warnings=$WARN (should be 0 for functional)"
  FAIL=$((FAIL + 1))
fi



print_results
