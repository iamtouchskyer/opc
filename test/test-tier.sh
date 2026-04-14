#!/bin/bash
# Tests for quality tier verification: init --tier, tier-baseline, synthesize tier-aware
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
echo "=== TEST GROUP 1: init --tier ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 1.1: Init with valid tier ---"
rm -rf .h-tier && OUT=$($HARNESS init --flow build-verify --tier polished --dir .h-tier 2>/dev/null)
assert_field_eq "created" "$OUT" "created" "true"
assert_field_eq "tier in output" "$OUT" "tier" "\"polished\""
TIER=$(python3 -c "import json; print(json.load(open('.h-tier/flow-state.json'))['tier'])")
if [ "$TIER" = "polished" ]; then
  echo "  ✅ tier in state"
  PASS=$((PASS + 1))
else
  echo "  ❌ tier=$TIER"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 1.2: Init with invalid tier ---"
rm -rf .h-tier2 && OUT=$($HARNESS init --flow build-verify --tier banana --dir .h-tier2 2>/dev/null)
assert_field_eq "rejected" "$OUT" "created" "false"
assert_contains "explains invalid" "$OUT" "invalid tier"

echo ""
echo "--- 1.3: Init without tier ---"
rm -rf .h-tier3 && OUT=$($HARNESS init --flow build-verify --dir .h-tier3 2>/dev/null)
assert_field_eq "tier null" "$OUT" "tier" "__NULL__"
TIER=$(python3 -c "import json; print(json.load(open('.h-tier3/flow-state.json')).get('tier'))")
if [ "$TIER" = "None" ]; then
  echo "  ✅ tier null in state"
  PASS=$((PASS + 1))
else
  echo "  ❌ tier=$TIER"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 1.4: All valid tiers ---"
for t in functional polished delightful; do
  rm -rf ".h-$t" && OUT=$($HARNESS init --flow build-verify --tier $t --dir ".h-$t" 2>/dev/null)
  assert_field_eq "init $t" "$OUT" "tier" "\"$t\""
done

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 2: tier-baseline ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 2.1: Functional tier → 0 test cases ---"
OUT=$($HARNESS tier-baseline --tier functional)
assert_field_eq "functional total" "$OUT" "total" "0"

echo ""
echo "--- 2.2: Polished tier → test cases ---"
OUT=$($HARNESS tier-baseline --tier polished)
TOTAL=$(jq_field "$OUT" "total")
if [ "$TOTAL" -gt 0 ] 2>/dev/null; then
  echo "  ✅ polished has $TOTAL test cases"
  PASS=$((PASS + 1))
else
  echo "  ❌ polished total=$TOTAL"
  FAIL=$((FAIL + 1))
fi
assert_contains "has TC-TIER IDs" "$OUT" "TC-TIER"
assert_contains "all P0" "$OUT" "P0"
assert_contains "has steps" "$OUT" "steps"
assert_contains "has expected" "$OUT" "expected"

echo ""
echo "--- 2.3: Delightful tier → more test cases than polished ---"
OUT_D=$($HARNESS tier-baseline --tier delightful)
TOTAL_D=$(echo "$OUT_D" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])")
TOTAL_P=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])")
if [ "$TOTAL_D" -ge "$TOTAL_P" ]; then
  echo "  ✅ delightful ($TOTAL_D) >= polished ($TOTAL_P)"
  PASS=$((PASS + 1))
else
  echo "  ❌ delightful ($TOTAL_D) < polished ($TOTAL_P)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 2.4: Invalid tier ---"
OUT=$($HARNESS tier-baseline --tier banana)
assert_contains "error message" "$OUT" "invalid tier"

echo ""
echo "--- 2.5: Each test case has required fields ---"
OUT=$($HARNESS tier-baseline --tier polished)
VALID=$(echo "$OUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for tc in d['testCases']:
    for field in ['id', 'category', 'priority', 'description', 'steps', 'expected', 'failureImpact', 'baselineKey']:
        if field not in tc:
            print(f'MISSING:{field}')
            sys.exit(0)
print('ALL_PRESENT')
")
if [ "$VALID" = "ALL_PRESENT" ]; then
  echo "  ✅ all test cases have required fields"
  PASS=$((PASS + 1))
else
  echo "  ❌ $VALID"
  FAIL=$((FAIL + 1))
fi

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

Dark/light theme: prefers-color-scheme respected, toggle in header. Color tokens via CSS custom properties.

Navigation sidebar with active state indicator, collapses on mobile. Structured nav with sections.

Responsive layout tested at 320px, 768px, 1024px, 1440px. No horizontal scroll at any viewport/breakpoint.

Code blocks use Shiki for syntax highlighting with copy button. Theme-consistent colors.

Tables have striped rows, hover effect, proper cell padding. Horizontal scroll on mobile.

Loading states: skeleton screens on all async operations, spinner for form submissions.

Error states: error boundary with retry action. 404 page with navigation back.

Favicon and meta tags: custom favicon, og:image, title and description set.

Focus-visible styles: custom focus ring on all interactive elements. Keyboard navigation logical.

Page transitions: smooth fade between views — not hard cuts.

## VERDICT
VERDICT: LGTM — nothing found after thorough review
EVAL
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
## VERDICT
VERDICT: LGTM
EVAL
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
## VERDICT
VERDICT: LGTM — code correct
EVAL
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

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 4: verify — file:line reality check (Gap 1) ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 4.1: Finding with non-existent file rejected ---"
rm -rf .h-g1 && mkdir -p .h-g1 && cd .h-g1
cat > eval.md << 'EVAL'
# Review
## Findings
🔴 Bug in nonexistent.js:10 — file does not exist
→ Fix it
Reasoning: fabricated reference
## VERDICT
VERDICT: FAIL
EVAL
OUT=$($HARNESS verify eval.md 2>/dev/null)
COUNT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['invalid_file_refs_count'])")
if [ "$COUNT" -eq 1 ]; then
  echo "  ✅ invalid file ref detected"
  PASS=$((PASS + 1))
else
  echo "  ❌ invalid_file_refs_count=$COUNT"
  FAIL=$((FAIL + 1))
fi
assert_contains "reason: file does not exist" "$OUT" "file does not exist"
cd ..

echo ""
echo "--- 4.2: Finding with out-of-range line number rejected ---"
rm -rf .h-g2 && mkdir -p .h-g2 && cd .h-g2
echo "one line only" > src.js
cat > eval.md << 'EVAL'
# Review
## Findings
🔴 Bug in src.js:999 — line way beyond file length
→ Fix it
Reasoning: fabricated line number
## VERDICT
VERDICT: FAIL
EVAL
OUT=$($HARNESS verify eval.md 2>/dev/null)
COUNT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['invalid_file_refs_count'])")
if [ "$COUNT" -eq 1 ]; then
  echo "  ✅ out-of-range line detected"
  PASS=$((PASS + 1))
else
  echo "  ❌ count=$COUNT"
  FAIL=$((FAIL + 1))
fi
assert_contains "reason: line outside file" "$OUT" "outside file"
cd ..

echo ""
echo "--- 4.3: Valid file:line passes ---"
rm -rf .h-g3 && mkdir -p .h-g3 && cd .h-g3
printf "line 1\nline 2\nline 3\nline 4\nline 5\n" > src.js
cat > eval.md << 'EVAL'
# Review
## Findings
🔴 Bug in src.js:3 — valid line
→ Fix it
Reasoning: real reference
## VERDICT
VERDICT: FAIL
EVAL
OUT=$($HARNESS verify eval.md 2>/dev/null)
COUNT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['invalid_file_refs_count'])")
if [ "$COUNT" -eq 0 ]; then
  echo "  ✅ valid ref accepted"
  PASS=$((PASS + 1))
else
  echo "  ❌ count=$COUNT (should be 0)"
  FAIL=$((FAIL + 1))
fi
cd ..

echo ""
echo "--- 4.4: evidence_complete false when invalid refs present ---"
rm -rf .h-g4 && mkdir -p .h-g4 && cd .h-g4
cat > eval.md << 'EVAL'
# Review
## Findings
🔴 Bug in ghost.js:5 — ghost file
→ Fix it
Reasoning: fake
## VERDICT
VERDICT: FAIL
EVAL
OUT=$($HARNESS verify eval.md 2>/dev/null)
COMPLETE=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['evidence_complete'])")
if [ "$COMPLETE" = "False" ]; then
  echo "  ✅ evidence_complete=false with invalid refs"
  PASS=$((PASS + 1))
else
  echo "  ❌ evidence_complete=$COMPLETE"
  FAIL=$((FAIL + 1))
fi
cd ..

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 5: validate — tierCoverage enforcement (Gap 2) ==="
# ═══════════════════════════════════════════════════════════════

setup_tier_flow() {
  local dir="$1"
  rm -rf "$dir"
  $HARNESS init --flow full-stack --tier polished --entry test-execute --dir "$dir" 2>/dev/null >/dev/null
  mkdir -p "$dir/nodes/test-execute"
  touch "$dir/nodes/test-execute/screen.png"
}

echo "--- 5.1: Execute node missing tierCoverage rejected ---"
setup_tier_flow .h-t1
cat > .h-t1/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran tests",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "screen.png"}]
}
HS
OUT=$($HARNESS validate .h-t1/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "missing tierCoverage rejected" "$OUT" "valid" "false"
assert_contains "explains missing tierCoverage" "$OUT" "tierCoverage"

echo ""
echo "--- 5.2: tierCoverage with all items covered accepted ---"
setup_tier_flow .h-t2
cat > .h-t2/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran tests",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "screen.png"}],
  "tierCoverage": {
    "covered": ["typography","color-scheme","navigation","responsive","code-blocks","tables","loading-states","error-states","favicon-meta","focus-styles"],
    "skipped": []
  }
}
HS
OUT=$($HARNESS validate .h-t2/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "full coverage accepted" "$OUT" "valid" "true"

echo ""
echo "--- 5.3: Skipped without reason rejected ---"
setup_tier_flow .h-t3
cat > .h-t3/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "screen.png"}],
  "tierCoverage": {
    "covered": ["typography","color-scheme","navigation","responsive","code-blocks","tables","loading-states","error-states","favicon-meta"],
    "skipped": [{"key": "focus-styles", "reason": "nope"}]
  }
}
HS
OUT=$($HARNESS validate .h-t3/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "short reason rejected" "$OUT" "valid" "false"
assert_contains "explains reason length" "$OUT" "min 10 chars"

echo ""
echo "--- 5.4: Unknown baseline key rejected ---"
setup_tier_flow .h-t4
cat > .h-t4/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "screen.png"}],
  "tierCoverage": {
    "covered": ["typography","banana","color-scheme","navigation","responsive","code-blocks","tables","loading-states","error-states","favicon-meta","focus-styles"],
    "skipped": []
  }
}
HS
OUT=$($HARNESS validate .h-t4/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "unknown key rejected" "$OUT" "valid" "false"
assert_contains "explains unknown" "$OUT" "unknown baseline key"

echo ""
echo "--- 5.5: Missing required item rejected ---"
setup_tier_flow .h-t5
cat > .h-t5/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "screen.png"}],
  "tierCoverage": {
    "covered": ["typography","color-scheme","navigation","responsive"],
    "skipped": []
  }
}
HS
OUT=$($HARNESS validate .h-t5/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "incomplete coverage rejected" "$OUT" "valid" "false"
assert_contains "lists missing item" "$OUT" "missing required baseline"

echo ""
echo "--- 5.6: Valid skip with proper reason accepted ---"
setup_tier_flow .h-t6
cat > .h-t6/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "screen.png"}],
  "tierCoverage": {
    "covered": ["typography","color-scheme","navigation","responsive","tables","loading-states","error-states","favicon-meta","focus-styles"],
    "skipped": [{"key": "code-blocks", "reason": "product has no code blocks — it is a marketing site with no technical content"}]
  }
}
HS
OUT=$($HARNESS validate .h-t6/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "valid skip accepted" "$OUT" "valid" "true"

echo ""
echo "--- 5.7: Non-execute nodes unaffected by tier ---"
setup_tier_flow .h-t7
mkdir -p .h-t7/nodes/build
cat > .h-t7/nodes/build/handshake.json << 'HS'
{
  "nodeId": "build", "nodeType": "build", "runId": "run_1",
  "status": "completed", "summary": "built",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [], "verdict": null
}
HS
OUT=$($HARNESS validate .h-t7/nodes/build/handshake.json 2>/dev/null)
assert_field_eq "build node unaffected" "$OUT" "valid" "true"

echo ""
echo "--- 5.8: Functional tier — no tierCoverage required ---"
rm -rf .h-t8
$HARNESS init --flow full-stack --tier functional --entry test-execute --dir .h-t8 2>/dev/null >/dev/null
mkdir -p .h-t8/nodes/test-execute
touch .h-t8/nodes/test-execute/screen.png
cat > .h-t8/nodes/test-execute/handshake.json << 'HS'
{
  "nodeId": "test-execute", "nodeType": "execute", "runId": "run_1",
  "status": "completed", "verdict": "PASS", "summary": "ran",
  "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type": "screenshot", "path": "screen.png"}]
}
HS
OUT=$($HARNESS validate .h-t8/nodes/test-execute/handshake.json 2>/dev/null)
assert_field_eq "functional tier no coverage needed" "$OUT" "valid" "true"

# ═══════════════════════════════════════════════════════════════
print_results
