#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

echo "Test: Synthesize Golden Snapshots"
echo "================================================"
echo ""

# ── Setup: create session with known eval files ──
SESSION_DIR="$TMPDIR/.harness"
mkdir -p "$SESSION_DIR/nodes/code-review/run_1"

cat > "$SESSION_DIR/flow-state.json" <<'EOF'
{
  "flowTemplate": "build-verify",
  "currentNode": "gate",
  "status": "active",
  "tier": "functional",
  "totalSteps": 3,
  "history": [
    {"node": "build", "verdict": "PASS"},
    {"node": "code-review", "verdict": "PASS"}
  ]
}
EOF

# Create a well-formed eval with known severities (must be ≥50 lines to avoid thinEval)
python3 -c "
lines = []
lines.append('# Frontend Review')
lines.append('')
lines.append('## Summary')
lines.append('Found issues in the component rendering path. The application has several problems')
lines.append('that need to be addressed before we can ship this to production safely.')
lines.append('')
lines.append('## Findings')
lines.append('')
lines.append('🔴 **Critical** — \`src/app.tsx:10\` — Unhandled null reference')
lines.append('**Reasoning:** Will crash on first render when data is undefined because the component')
lines.append('  attempts to destructure properties from a null object without any guard clause.')
lines.append('  This affects all users on first page load when the API has not yet responded.')
lines.append('**Fix:** Add null check before accessing \`.items\` — use optional chaining or')
lines.append('  early return pattern.')
lines.append('')
lines.append('🟡 **Warning** — \`src/utils.ts:25\` — No input validation')
lines.append('**Reasoning:** User input flows directly to DOM without sanitization which opens')
lines.append('  the application to XSS attacks. Any user-submitted content could execute')
lines.append('  arbitrary JavaScript in other users browsers.')
lines.append('**Fix:** Use \`DOMPurify.sanitize()\` before insertion into the DOM.')
lines.append('')
lines.append('🔵 **Suggestion** — \`src/index.ts:1\` — Consider barrel exports')
lines.append('**Reasoning:** Multiple imports from the same module are verbose and make refactoring')
lines.append('  harder when files move around. A barrel export centralizes the public API.')
lines.append('**Fix:** Create index.ts with re-exports for all public symbols.')
lines.append('')
lines.append('## Analysis')
lines.append('')
lines.append('The codebase shows signs of rapid development without adequate error handling.')
lines.append('The null reference issue is particularly concerning because it affects the')
lines.append('critical render path. The XSS vulnerability in utils.ts suggests that input')
lines.append('validation was not considered during the initial implementation phase.')
lines.append('')
lines.append('### Recommendations')
lines.append('')
lines.append('1. Add comprehensive null checks throughout the render pipeline')
lines.append('2. Implement a sanitization layer at the form boundary')
lines.append('3. Consider adding TypeScript strict null checks to catch these at compile time')
lines.append('4. Add integration tests that cover the null-data scenario')
lines.append('5. Review all user-input touchpoints for similar XSS vectors')
lines.append('')
lines.append('### Impact Assessment')
lines.append('')
lines.append('The critical finding blocks deployment. The warning should be fixed before')
lines.append('the next release cycle. The suggestion is low priority but improves DX.')
lines.append('')
lines.append('## Verdict')
lines.append('VERDICT: FAIL — critical null reference must be fixed.')
print('\n'.join(lines))
" > "$SESSION_DIR/nodes/code-review/run_1/eval-frontend.md"

# Create source files so file:line refs are valid
mkdir -p "$TMPDIR/src"
printf '%s\n' {1..30} > "$TMPDIR/src/app.tsx"
printf '%s\n' {1..30} > "$TMPDIR/src/utils.ts"
printf '%s\n' {1..5} > "$TMPDIR/src/index.ts"
echo '{"name":"test"}' > "$TMPDIR/package.json"

# ── Test 1: synthesize produces valid JSON ──
echo "1. synthesize → valid JSON output"
OUT=$($HARNESS synthesize "$SESSION_DIR" --node code-review --run 1 --base "$TMPDIR" --no-strict 2>/dev/null || true)

if echo "$OUT" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  echo "  ✅ Valid JSON"
  PASS=$((PASS + 1))
else
  echo "  ❌ Invalid JSON"
  echo "  Output: $(echo "$OUT" | head -3)"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: correct severity counts (per-role, excludes quality gate warnings) ──
echo "2. Correct severity counts (1 critical, 1 warning, 1 suggestion)"
CRIT=$(echo "$OUT" | python3 -c "import sys,json; r=json.load(sys.stdin)['roles'][0]; print(r['critical'])" 2>/dev/null)
WARN=$(echo "$OUT" | python3 -c "import sys,json; r=json.load(sys.stdin)['roles'][0]; print(r['warning'])" 2>/dev/null)
SUGG=$(echo "$OUT" | python3 -c "import sys,json; r=json.load(sys.stdin)['roles'][0]; print(r['suggestion'])" 2>/dev/null)

if [ "$CRIT" = "1" ] && [ "$WARN" = "1" ] && [ "$SUGG" = "1" ]; then
  echo "  ✅ critical=$CRIT warning=$WARN suggestion=$SUGG"
  PASS=$((PASS + 1))
else
  echo "  ❌ critical=$CRIT warning=$WARN suggestion=$SUGG"
  FAIL=$((FAIL + 1))
fi

# ── Test 3: verdict is FAIL when critical present ──
echo "3. Verdict = FAIL when critical findings exist"
VERDICT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['verdict'])" 2>/dev/null)
if [ "$VERDICT" = "FAIL" ]; then
  echo "  ✅ verdict=FAIL"
  PASS=$((PASS + 1))
else
  echo "  ❌ verdict=$VERDICT (expected FAIL)"
  FAIL=$((FAIL + 1))
fi

# ── Test 4: roles array contains frontend ──
echo "4. Roles array includes frontend"
ROLE=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['roles'][0]['role'])" 2>/dev/null)
if [ "$ROLE" = "frontend" ]; then
  echo "  ✅ role=frontend"
  PASS=$((PASS + 1))
else
  echo "  ❌ role=$ROLE"
  FAIL=$((FAIL + 1))
fi

# ── Test 5: PASS verdict when only suggestions ──
echo "5. Verdict = PASS when only suggestions"
python3 -c "
lines = []
lines.append('# Frontend Review')
lines.append('')
lines.append('## Summary')
lines.append('Minor suggestions only. The code is well-structured and follows best practices.')
lines.append('No blocking issues found during this review cycle.')
lines.append('')
lines.append('## Findings')
lines.append('')
lines.append('🔵 **Suggestion** — \`src/app.tsx:5\` — Consider memoization')
lines.append('**Reasoning:** Prevents unnecessary re-renders when parent state changes but props')
lines.append('  remain the same. This is a performance optimization that becomes important')
lines.append('  as the component tree grows deeper.')
lines.append('**Fix:** Wrap with React.memo and provide a custom comparison function.')
lines.append('')
lines.append('🔵 **Suggestion** — \`src/app.tsx:10\` — Add aria-label')
lines.append('**Reasoning:** Improves accessibility for screen reader users who cannot see the')
lines.append('  visual context of the button. Without a label the button is announced as')
lines.append('  just button which is not helpful for navigation.')
lines.append('**Fix:** Add aria-label=\"Submit form\" to the button element.')
lines.append('')
lines.append('## Analysis')
lines.append('')
lines.append('Overall the code quality is good. The component follows React conventions')
lines.append('and the file structure is clean. The two suggestions above are nice-to-have')
lines.append('improvements that would make the code slightly better but are not blockers.')
lines.append('')
lines.append('### Code Quality Notes')
lines.append('')
lines.append('- Consistent naming conventions throughout')
lines.append('- Proper use of TypeScript types')
lines.append('- Good separation of concerns between components')
lines.append('- Tests cover the critical paths adequately')
lines.append('- Error boundaries are in place for the main routes')
lines.append('')
lines.append('### Performance Observations')
lines.append('')
lines.append('- Bundle size is within acceptable limits')
lines.append('- No unnecessary re-renders detected in profiling')
lines.append('- Lazy loading is properly configured for route-level splits')
lines.append('- The memoization suggestion above is purely a future-proofing measure')
lines.append('')
lines.append('### Accessibility Audit')
lines.append('')
lines.append('- All interactive elements are keyboard navigable')
lines.append('- Color contrast meets WCAG AA standards')
lines.append('- The aria-label suggestion is the only gap found')
lines.append('- Focus management works correctly on route transitions')
lines.append('')
lines.append('## Verdict')
lines.append('VERDICT: PASS — suggestions only.')
print('\n'.join(lines))
" > "$SESSION_DIR/nodes/code-review/run_1/eval-frontend.md"

# Add skeptic-owner eval to satisfy mandatory role check
python3 -c "
lines = []
lines.append('# Skeptic Owner Review')
lines.append('')
lines.append('## Summary')
lines.append('No concerns from ownership perspective. Code changes are well-scoped')
lines.append('and do not introduce unnecessary complexity or maintenance burden.')
lines.append('')
lines.append('## Findings')
lines.append('')
lines.append('🔵 **Suggestion** — \`src/app.tsx:1\` — Consider adding ownership comment')
lines.append('**Reasoning:** New modules benefit from a brief ownership comment at the top')
lines.append('  to help future maintainers understand who to contact for questions.')
lines.append('**Fix:** Add a comment block with team ownership information.')
lines.append('')
lines.append('## Analysis')
lines.append('')
lines.append('The changes are minimal and well-contained within the component boundary.')
lines.append('No cross-cutting concerns or architectural issues detected. The code')
lines.append('follows established patterns in the codebase and will be easy to maintain.')
lines.append('')
lines.append('### Ownership Assessment')
lines.append('')
lines.append('- Clear module boundaries maintained')
lines.append('- No orphaned code or dead imports')
lines.append('- Dependencies are well-managed and minimal')
lines.append('- Test coverage exists for the critical paths')
lines.append('- No shared state introduced that could cause coupling')
lines.append('')
lines.append('### Maintenance Risk')
lines.append('')
lines.append('- Low complexity score (cyclomatic < 5 per function)')
lines.append('- No external service dependencies added')
lines.append('- Rollback path is straightforward if issues arise')
lines.append('- Feature flag not required for this scope of change')
lines.append('')
lines.append('## Verdict')
lines.append('VERDICT: PASS — no ownership concerns.')
print('\n'.join(lines))
" > "$SESSION_DIR/nodes/code-review/run_1/eval-skeptic-owner.md"

OUT2=$($HARNESS synthesize "$SESSION_DIR" --node code-review --run 1 --base "$TMPDIR" --no-strict 2>/dev/null || true)
VERDICT2=$(echo "$OUT2" | python3 -c "import sys,json; print(json.load(sys.stdin)['verdict'])" 2>/dev/null)
if [ "$VERDICT2" = "PASS" ]; then
  echo "  ✅ verdict=PASS (suggestions only)"
  PASS=$((PASS + 1))
else
  echo "  ❌ verdict=$VERDICT2 (expected PASS)"
  FAIL=$((FAIL + 1))
fi

# ── Test 6: ITERATE verdict when warnings only ──
echo "6. Verdict = ITERATE when warnings present (no critical)"
python3 -c "
lines = []
lines.append('# Frontend Review')
lines.append('')
lines.append('## Summary')
lines.append('Found warnings that should be addressed before shipping.')
lines.append('')
lines.append('## Findings')
lines.append('')
lines.append('🟡 **Warning** — \`src/app.tsx:5\` — Missing error handling')
lines.append('**Reasoning:** Async call without try/catch will silently fail and leave the user')
lines.append('  staring at a loading spinner forever. The promise rejection is swallowed')
lines.append('  by the event loop without any user-visible feedback.')
lines.append('**Fix:** Wrap in try/catch with user notification via toast or error state.')
lines.append('')
lines.append('## Analysis')
lines.append('')
lines.append('The error handling gap is concerning but not critical since the feature')
lines.append('still works in the happy path. Users will only be affected when the API')
lines.append('returns an error or times out, which is an edge case but one that should')
lines.append('be handled gracefully before production deployment.')
lines.append('')
lines.append('### Error Handling Patterns')
lines.append('')
lines.append('The rest of the codebase uses a consistent error boundary pattern but this')
lines.append('particular component bypasses it by making a raw fetch call instead of going')
lines.append('through the shared API client that has retry and error handling built in.')
lines.append('')
lines.append('### Recommendations')
lines.append('')
lines.append('1. Use the shared apiClient.get() instead of raw fetch')
lines.append('2. Add loading and error states to the component')
lines.append('3. Consider adding a timeout to prevent infinite loading')
lines.append('4. Add a retry mechanism for transient failures')
lines.append('5. Log the error for debugging purposes')
lines.append('')
lines.append('### Testing Notes')
lines.append('')
lines.append('- Happy path tests pass')
lines.append('- No error path tests exist for this component')
lines.append('- Integration tests do not cover API failure scenarios')
lines.append('- Consider adding MSW handlers for error responses')
lines.append('')
lines.append('## Verdict')
lines.append('VERDICT: ITERATE — warnings need addressing.')
print('\n'.join(lines))
" > "$SESSION_DIR/nodes/code-review/run_1/eval-frontend.md"

OUT3=$($HARNESS synthesize "$SESSION_DIR" --node code-review --run 1 --base "$TMPDIR" --no-strict 2>/dev/null || true)
VERDICT3=$(echo "$OUT3" | python3 -c "import sys,json; print(json.load(sys.stdin)['verdict'])" 2>/dev/null)
if [ "$VERDICT3" = "ITERATE" ]; then
  echo "  ✅ verdict=ITERATE"
  PASS=$((PASS + 1))
else
  echo "  ❌ verdict=$VERDICT3 (expected ITERATE)"
  FAIL=$((FAIL + 1))
fi

# ── Test 7: BLOCKED verdict ──
echo "7. Verdict = BLOCKED when evaluator says BLOCKED"
python3 -c "
lines = []
lines.append('# Frontend Review')
lines.append('')
lines.append('## Summary')
lines.append('Cannot review — dependency not available. The build environment is broken')
lines.append('and I cannot verify any of the code changes without a working build.')
lines.append('')
lines.append('## Findings')
lines.append('')
lines.append('🔴 **Critical** — \`package.json:1\` — Missing react dependency')
lines.append('**Reasoning:** Build fails entirely because react is listed as a peer dependency')
lines.append('  but is not installed. This blocks all downstream work including testing,')
lines.append('  type checking, and bundle analysis.')
lines.append('**Fix:** Run npm install react react-dom to install the required dependencies.')
lines.append('')
lines.append('## Analysis')
lines.append('')
lines.append('This review is BLOCKED because the project cannot build. Without a working')
lines.append('build, I cannot verify component behavior, run tests, or check for runtime')
lines.append('errors. The missing dependency must be resolved before any meaningful review')
lines.append('can proceed.')
lines.append('')
lines.append('### Environment State')
lines.append('')
lines.append('- npm install fails with ERESOLVE error')
lines.append('- TypeScript compilation fails (cannot find module react)')
lines.append('- Dev server cannot start')
lines.append('- Test suite cannot run')
lines.append('- Linting partially works but misses JSX-specific rules')
lines.append('')
lines.append('### Prerequisites')
lines.append('')
lines.append('1. Fix package.json dependency declarations')
lines.append('2. Run npm install successfully')
lines.append('3. Verify build completes without errors')
lines.append('4. Then re-run this review')
lines.append('')
lines.append('### Impact')
lines.append('')
lines.append('All code review findings would be speculative without a working build.')
lines.append('I refuse to guess at runtime behavior when I cannot verify it.')
lines.append('')
lines.append('## Verdict')
lines.append('VERDICT: BLOCKED — cannot build without dependencies.')
print('\n'.join(lines))
" > "$SESSION_DIR/nodes/code-review/run_1/eval-frontend.md"

OUT4=$($HARNESS synthesize "$SESSION_DIR" --node code-review --run 1 --base "$TMPDIR" --no-strict 2>/dev/null || true)
VERDICT4=$(echo "$OUT4" | python3 -c "import sys,json; print(json.load(sys.stdin)['verdict'])" 2>/dev/null)
if [ "$VERDICT4" = "BLOCKED" ]; then
  echo "  ✅ verdict=BLOCKED"
  PASS=$((PASS + 1))
else
  echo "  ❌ verdict=$VERDICT4 (expected BLOCKED)"
  FAIL=$((FAIL + 1))
fi

print_results
