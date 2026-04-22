#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

mkdir -p .harness/nodes/code-review/run_1

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
echo ""
echo "=== TEST GROUP 7: File:line reality check via --base ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 7.1: Fabricated file:line refs caught with --base ---"
# Create a project dir with short files
mkdir -p project/src
echo "// placeholder" > project/src/main.ts
echo "// placeholder" > project/src/auth.ts

# Eval references line 10 and line 15 — files only have 1 line
cat > .harness/nodes/code-review/run_1/eval-faker.md <<'EVALEOF'
# Code Review

## Architecture
Clean modular structure with proper layering.
Services abstract business logic from handlers.

## Findings

🔵 src/main.ts:10 — Import ordering inconsistent
→ Group external imports before internal ones
Reasoning: Following convention.

🔵 src/auth.ts:15 — Token expiry issue
→ Add expiry check
Reasoning: Security.

## Security
No injection vectors. Auth is solid.
CORS and CSP properly configured.

## Performance
Queries use proper indexing throughout.
No N+1 patterns detected anywhere.

## Testing
Good unit test coverage on core modules.
Integration tests cover main flows.

## Error Handling
Try-catch on all async routes.
Proper status codes returned.

## Summary
Two suggestions. Code quality is good overall.
No critical vulnerabilities found in review.
Patterns are consistently followed throughout.

VERDICT: PASS FINDINGS[2]
EVALEOF
rm -f .harness/nodes/code-review/run_1/eval-reasoned.md

OUT=$($HARNESS synthesize .harness --node code-review --base project 2>/dev/null)
assert_contains "fabricated refs caught" "$OUT" "fabricated refs"
assert_field_eq "verdict ITERATE (fake refs)" "$OUT" "verdict" '"ITERATE"'

echo ""
echo "--- 7.2: Valid file:line refs pass with --base ---"
# Make files long enough
python3 -c "
for i in range(50):
    print(f'const line{i+1} = \"implementation\";')
" > project/src/main.ts
python3 -c "
for i in range(50):
    print(f'const auth{i+1} = \"implementation\";')
" > project/src/auth.ts

OUT=$($HARNESS synthesize .harness --node code-review --base project 2>/dev/null)
assert_not_contains "no fabricated refs for valid files" "$OUT" "fabricated refs"

echo ""
echo "--- 7.3: Without --base, file ref check is skipped ---"
echo "// placeholder" > project/src/main.ts
echo "// placeholder" > project/src/auth.ts

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_not_contains "no ref check without --base" "$OUT" "fabricated refs"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 8: D1 — --base deprecation warning ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 8.1: No --base → stderr deprecation warning ---"
mkdir -p .harness/nodes/code-review/run_1
rm -f .harness/nodes/code-review/run_1/eval-*.md
cat > .harness/nodes/code-review/run_1/eval-simple.md <<'EVALEOF'
# Code Review

## Architecture
Clean structure.

## Findings

🔵 src/main.ts:10 — Minor issue
→ Fix it
Reasoning: Convention.

## Security
No issues found in review.
CORS configured properly.

## Performance
Queries indexed properly.
No N+1 patterns found.

## Testing
Good coverage on core.
Integration tests pass.

## Summary
One minor suggestion found.
Code quality is good overall.
Patterns followed consistently.

VERDICT: PASS FINDINGS[1]
EVALEOF

STDERR=$($HARNESS synthesize .harness --node code-review 2>&1 1>/dev/null)
assert_contains "--base deprecation warning emitted" "$STDERR" "base not provided"

echo ""
echo "--- 8.2: With --base → no deprecation warning ---"
mkdir -p project/src
python3 -c "for i in range(50): print(f'const x{i} = 1;')" > project/src/main.ts
STDERR=$($HARNESS synthesize .harness --node code-review --base project 2>&1 1>/dev/null)
assert_not_contains "no deprecation with --base" "$STDERR" "base not provided"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 9: D2 — Compound eval quality gate ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 9.1: ≥3 layers tripped → enforce mode (evalQualityGate.triggered) ---"
rm -f .harness/nodes/code-review/run_1/eval-*.md
{
  echo "# Only Heading"
  echo ""
  echo "🔵 Something is wrong — no real finding"
  echo ""
  for i in $(seq 1 55); do
    echo "This is a padding line that should not count."
  done
  echo ""
  echo "VERDICT: PASS FINDINGS[1]"
} > .harness/nodes/code-review/run_1/eval-garbage.md

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
# Should trigger ≥3 layers: lowUniqueContent, singleHeading, noCodeRefs, findingDensityLow = 4
assert_contains "evalQualityGate triggered" "$OUT" "evalQualityGate"
assert_contains "enforce mode (default)" "$OUT" '"enforce"'
# With enforce default, verdict is FAIL
assert_field_eq "verdict FAIL (D2 enforce default)" "$OUT" "verdict" '"FAIL"'

echo ""
echo "--- 9.2: ≥3 layers + --strict → verdict FAIL ---"
OUT=$($HARNESS synthesize .harness --node code-review --strict 2>/dev/null)
assert_field_eq "verdict FAIL with --strict" "$OUT" "verdict" '"FAIL"'
assert_contains "enforce mode" "$OUT" '"enforce"'

echo ""
echo "--- 9.3: <3 layers → no evalQualityGate ---"
rm -f .harness/nodes/code-review/run_1/eval-*.md
cat > .harness/nodes/code-review/run_1/eval-ok.md <<'EVALEOF'
# Thorough Code Review

## Architecture Analysis
The codebase follows a well-structured MVC pattern.
Dependency injection is used consistently.
Module boundaries are clearly defined.

## Findings

🔵 src/main.ts:10 — Import ordering inconsistent
→ Group external imports before internal ones
Reasoning: Convention.

🔵 src/utils.ts:25 — Unused helper function
→ Remove dead code
Reasoning: Maintenance burden.

🟡 src/auth.ts:42 — Token refresh too narrow
→ Increase refresh window to 300s
Reasoning: Users with slow connections lose session.

🔵 src/db.ts:88 — Pool size hardcoded
→ Move to env var
Reasoning: Prod needs more.

## Security
No injection. Auth applied. CORS configured.
Input validation on all endpoints.

## Performance
Queries indexed. No N+1. Caching applied.
Bundle splitting configured.

## Summary
4 issues: 1 warning, 3 suggestions.
Code quality strong overall.

VERDICT: ITERATE FINDINGS[4]
EVALEOF

OUT=$($HARNESS synthesize .harness --node code-review 2>/dev/null)
assert_not_contains "no evalQualityGate for clean eval" "$OUT" "evalQualityGate"


print_results
