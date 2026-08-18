#!/bin/bash
# Regression tests for brief-lint checks
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

assert_pass() {
  local desc="$1" file="$2" extra="${3:-}"
  local OUT
  OUT=$($HARNESS brief-lint "$file" $extra 2>/dev/null) || true
  local ok
  ok=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('pass',False))" 2>/dev/null)
  if [ "$ok" = "True" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — expected pass, got: $OUT"
    FAIL=$((FAIL + 1))
  fi
}

assert_fail() {
  local desc="$1" file="$2" check="$3" extra="${4:-}"
  local OUT
  OUT=$($HARNESS brief-lint "$file" $extra 2>/dev/null) || true
  local ok
  ok=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('pass',False))" 2>/dev/null)
  if [ "$ok" = "False" ]; then
    if echo "$OUT" | grep -q "$check"; then
      echo "  ✅ $desc"
      PASS=$((PASS + 1))
    else
      echo "  ❌ $desc — failed but wrong check: $OUT"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "  ❌ $desc — expected fail, got pass"
    FAIL=$((FAIL + 1))
  fi
}

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 1: Golden pass ==="
# ═══════════════════════════════════════════════════════════════

cat > golden.md << 'EOF'
## File Plan
- index.html — main entry, ~200 lines
- styles.css — all styles, ~150 lines

## Technology Decisions
- Chart.js v4.4.0 via https://cdn.jsdelivr.net/npm/chart.js@4.4.0
- Tailwind CSS v3.4.1 via CDN

## Design Tokens (resolved)
- Primary: #0EA5E9
- Background: #FFFFFF
- Text: #1E293B

## Component Inventory
- Dashboard: 4 cards showing KPI (¥126,560 revenue, 8,846 visits)
- Chart: line chart with 12 monthly data points

## Constraints
- Contrast: 4.5:1 body, 3:1 large text
- Responsive: 992px, 768px, 375px breakpoints
- Animation: 200ms ease-out transitions
EOF

echo "--- 1.1: Golden brief passes ---"
assert_pass "golden brief" golden.md

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 2: tech-decisions checks ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 2.1: No version number ---"
cat > no-version.md << 'EOF'
## File Plan
- index.html — entry, ~200 lines

## Technology Decisions
- Chart.js via CDN
- Tailwind CSS via CDN

## Design Tokens (resolved)
- Primary: #0EA5E9
- Background: #FFFFFF
- Text: #1E293B

## Component Inventory
- Dashboard: 4 cards showing KPI (¥126,560 revenue)

## Constraints
- Contrast: 4.5:1 body text
- Responsive: 992px breakpoint
EOF
assert_fail "no version" no-version.md "tech-decisions-resolved"

echo ""
echo "--- 2.2: Open-ended tech choice ---"
cat > open-ended.md << 'EOF'
## File Plan
- index.html — entry, ~200 lines

## Technology Decisions
- Use a charting library v1.0 via CDN

## Design Tokens (resolved)
- Primary: #0EA5E9
- Background: #FFFFFF
- Text: #1E293B

## Component Inventory
- Dashboard: 4 cards showing KPI (¥126,560 revenue)

## Constraints
- Contrast: 4.5:1 body text
- Responsive: 992px breakpoint
EOF
assert_fail "open-ended" open-ended.md "tech-decisions-resolved"

echo ""
echo "--- 2.3: Bare language name without library ---"
cat > bare-lang.md << 'EOF'
## File Plan
- index.html — entry, ~200 lines

## Technology Decisions
- Use JavaScript v1.0 via CDN

## Design Tokens (resolved)
- Primary: #0EA5E9
- Background: #FFFFFF
- Text: #1E293B

## Component Inventory
- Dashboard: 4 cards showing KPI (¥126,560 revenue)

## Constraints
- Contrast: 4.5:1 body text
- Responsive: 992px breakpoint
EOF
assert_fail "bare language" bare-lang.md "tech-decisions-resolved"

echo ""
echo "--- 2.4: Language + specific library is OK ---"
cat > lang-with-lib.md << 'EOF'
## File Plan
- index.html — entry, ~200 lines

## Technology Decisions
- Use JavaScript with Chart.js v4.4.0 via https://cdn.jsdelivr.net/npm/chart.js@4.4.0

## Design Tokens (resolved)
- Primary: #0EA5E9
- Background: #FFFFFF
- Text: #1E293B

## Component Inventory
- Dashboard: 4 cards showing KPI (¥126,560 revenue)

## Constraints
- Contrast: 4.5:1 body text
- Responsive: 992px breakpoint
EOF
assert_pass "language + library OK" lang-with-lib.md

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 3: file-plan checks ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 3.1: Missing line estimates ---"
cat > no-estimates.md << 'EOF'
## File Plan
- index.html — main entry
- styles.css — all styles

## Technology Decisions
- Chart.js v4.4.0 via https://cdn.jsdelivr.net/npm/chart.js@4.4.0

## Design Tokens (resolved)
- Primary: #0EA5E9
- Background: #FFFFFF
- Text: #1E293B

## Component Inventory
- Dashboard: 4 cards showing KPI (¥126,560 revenue)

## Constraints
- Contrast: 4.5:1 body text
- Responsive: 992px breakpoint
EOF
assert_fail "no line estimates" no-estimates.md "file-plan-estimates"

echo ""
echo "--- 3.2: Incomplete markers ---"
cat > incomplete.md << 'EOF'
## File Plan
- index.html — main entry, ~200 lines
- styles.css — all styles etc.

## Technology Decisions
- Chart.js v4.4.0 via https://cdn.jsdelivr.net/npm/chart.js@4.4.0

## Design Tokens (resolved)
- Primary: #0EA5E9
- Background: #FFFFFF
- Text: #1E293B

## Component Inventory
- Dashboard: 4 cards showing KPI (¥126,560 revenue)

## Constraints
- Contrast: 4.5:1 body text
- Responsive: 992px breakpoint
EOF
assert_fail "etc marker" incomplete.md "file-plan-complete"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 4: vague design checks ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 4.1: Vague design term ---"
cat > vague.md << 'EOF'
## File Plan
- index.html — entry, ~200 lines

## Technology Decisions
- Chart.js v4.4.0 via https://cdn.jsdelivr.net/npm/chart.js@4.4.0

## Design Tokens (resolved)
- Primary: #0EA5E9
- Background: #FFFFFF
- Text: use an appropriate color

## Component Inventory
- Dashboard: 4 cards showing KPI (¥126,560 revenue)

## Constraints
- Contrast: 4.5:1 body text
- Responsive: 992px breakpoint
EOF
assert_fail "vague design" vague.md "no-vague-design"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 5: iteration-delta ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 5.1: Missing delta when prior findings exist ---"
assert_fail "missing delta" golden.md "iteration-delta" "--has-prior-findings"

echo ""
echo "--- 5.2: With delta section ---"
cat > with-delta.md << 'EOF'
## File Plan
- index.html — entry, ~200 lines

## Technology Decisions
- Chart.js v4.4.0 via https://cdn.jsdelivr.net/npm/chart.js@4.4.0

## Design Tokens (resolved)
- Primary: #0EA5E9
- Background: #FFFFFF
- Text: #1E293B

## Component Inventory
- Dashboard: 4 cards showing KPI (¥126,560 revenue)

## Constraints
- Contrast: 4.5:1 body text
- Responsive: 992px breakpoint

## Iteration Delta
- Fix chart color from #FF0000 to #0EA5E9 per gate finding
EOF
assert_pass "with delta" with-delta.md "--has-prior-findings"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== TEST GROUP 6: forgery resistance ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 6.1: CLI pass field is boolean ---"
cat > forge-attempt.md << 'EOF'
## File Plan
- index.html — entry, ~200 lines

## Technology Decisions
- Chart.js v4.4.0 via https://cdn.jsdelivr.net/npm/chart.js@4.4.0

## Design Tokens (resolved)
- Primary: #0EA5E9
- Background: #FFFFFF
- Text: #1E293B

## Component Inventory
- Dashboard: 4 cards showing KPI (¥126,560 revenue)

## Constraints
- Contrast: 4.5:1 body text
- Responsive: 992px breakpoint
EOF
OUT=$($HARNESS brief-lint forge-attempt.md 2>/dev/null) || true
PASS_VAL=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(type(d.get('pass')).__name__, d.get('pass'))" 2>/dev/null)
if echo "$PASS_VAL" | grep -q "bool"; then
  echo "  ✅ pass field is boolean"
  PASS=$((PASS + 1))
else
  echo "  ❌ pass field type: $PASS_VAL"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 6.2: Validate catches forged report (bad brief + fake pass:true) ---"
# Anti-forgery: a vague brief with a hand-crafted {"pass":true} report must be rejected
# by opc-harness validate, which re-runs brief-lint on the actual content.
rm -rf .h-forge && $HARNESS init --flow build-verify --dir .h-forge >/dev/null 2>/dev/null
mkdir -p .h-forge/nodes/brief/run_1
# Write a BAD brief — vague, missing sections
echo "# Vague brief with no structure" > .h-forge/nodes/brief/build-brief.md
# Write a FORGED report claiming pass
echo '{"pass":true,"checksRun":8,"checksPassed":8,"failures":[],"warnings":[]}' > .h-forge/nodes/brief/run_1/brief-lint-result.json
# Write handshake referencing both artifacts
cat > .h-forge/nodes/brief/handshake.json << 'HS'
{
  "nodeId": "brief", "nodeType": "brief", "runId": "run_1",
  "status": "completed", "summary": "forged", "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type":"brief","path":"build-brief.md"},{"type":"report","path":"run_1/brief-lint-result.json"}]
}
HS
sync_run_handshakes .h-forge
OUT=$($HARNESS validate .h-forge/nodes/brief/handshake.json 2>/dev/null)
VALID=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('valid'))" 2>/dev/null)
if [ "$VALID" = "False" ]; then
  echo "  ✅ validate rejects forged report (re-runs lint on actual brief)"
  PASS=$((PASS + 1))
else
  echo "  ❌ validate accepted forged report: $OUT"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 6.3: Validate accepts real brief with real passing lint ---"
rm -rf .h-real && $HARNESS init --flow build-verify --dir .h-real >/dev/null 2>/dev/null
mkdir -p .h-real/nodes/brief/run_1
write_golden_brief .h-real/nodes/brief/build-brief.md
echo '{"pass":true}' > .h-real/nodes/brief/run_1/brief-lint-result.json
cat > .h-real/nodes/brief/handshake.json << 'HS'
{
  "nodeId": "brief", "nodeType": "brief", "runId": "run_1",
  "status": "completed", "summary": "real", "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type":"brief","path":"build-brief.md"},{"type":"report","path":"run_1/brief-lint-result.json"}]
}
HS
sync_run_handshakes .h-real
OUT=$($HARNESS validate .h-real/nodes/brief/handshake.json 2>/dev/null)
VALID=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('valid'))" 2>/dev/null)
if [ "$VALID" = "True" ]; then
  echo "  ✅ validate accepts legitimate brief"
  PASS=$((PASS + 1))
else
  echo "  ❌ validate rejected legitimate brief: $OUT"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 6.4: Forged report error mentions brief-lint ---"
OUT=$($HARNESS validate .h-forge/nodes/brief/handshake.json 2>/dev/null)
ERRORS=$(echo "$OUT" | python3 -c "import sys,json; print(' '.join(json.load(sys.stdin).get('errors',[])))" 2>/dev/null)
if echo "$ERRORS" | grep -q "brief-lint"; then
  echo "  ✅ error message mentions brief-lint re-run"
  PASS=$((PASS + 1))
else
  echo "  ❌ error: $ERRORS"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 6.5: Validate enforces Iteration Delta on gate loopback (run_2, no delta) ---"
# A brief re-entered as run_2 (gate sent it back) MUST have an Iteration Delta
# section. The golden brief has none → validate must reject it at run_2.
rm -rf .h-loop && $HARNESS init --flow build-verify --dir .h-loop >/dev/null 2>/dev/null
mkdir -p .h-loop/nodes/brief/run_2
write_golden_brief .h-loop/nodes/brief/build-brief.md
echo '{"pass":true}' > .h-loop/nodes/brief/run_2/brief-lint-result.json
cat > .h-loop/nodes/brief/run_2/handshake.json << 'HS'
{
  "nodeId": "brief", "nodeType": "brief", "runId": "run_2",
  "status": "completed", "summary": "loopback no delta", "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type":"brief","path":"../build-brief.md"},{"type":"report","path":"brief-lint-result.json"}]
}
HS
mkdir -p .h-loop/nodes/brief/run_1
python3 - <<'PY'
import json, pathlib
p = pathlib.Path(".h-loop/nodes/brief/run_2/handshake.json")
d = json.loads(p.read_text())
d["runId"] = "run_1"
pathlib.Path(".h-loop/nodes/brief/run_1/handshake.json").write_text(json.dumps(d, indent=2) + "\n")
PY
python3 -c "
import json
p='.h-loop/flow-state.json'
s=json.load(open(p))
s['history']=[{'nodeId':'brief','runId':'run_2','timestamp':'2024-01-01T00:00:00.000Z'}]
s['totalSteps']=1
json.dump(s, open(p,'w'), indent=2)
"
OUT=$($HARNESS validate .h-loop/nodes/brief/run_2/handshake.json 2>/dev/null)
VALID=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('valid'))" 2>/dev/null)
ERRORS=$(echo "$OUT" | python3 -c "import sys,json; print(' '.join(json.load(sys.stdin).get('errors',[])))" 2>/dev/null)
if [ "$VALID" = "False" ] && echo "$ERRORS" | grep -q "Iteration Delta"; then
  echo "  ✅ validate rejects loopback brief missing Iteration Delta"
  PASS=$((PASS + 1))
else
  echo "  ❌ validate did not enforce Iteration Delta on run_2: $OUT"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 6.6: Validate accepts loopback brief WITH Iteration Delta (run_2) ---"
rm -rf .h-loop2 && $HARNESS init --flow build-verify --dir .h-loop2 >/dev/null 2>/dev/null
mkdir -p .h-loop2/nodes/brief/run_2
{ write_golden_brief /dev/stdout; printf '\n## Iteration Delta\n- Fixed contrast on KPI cards to 4.5:1 per prior finding\n- Added 200ms transition to chart hover\n'; } > .h-loop2/nodes/brief/build-brief.md
echo '{"pass":true}' > .h-loop2/nodes/brief/run_2/brief-lint-result.json
cat > .h-loop2/nodes/brief/run_2/handshake.json << 'HS'
{
  "nodeId": "brief", "nodeType": "brief", "runId": "run_2",
  "status": "completed", "summary": "loopback with delta", "timestamp": "2024-01-01T00:00:00Z",
  "artifacts": [{"type":"brief","path":"../build-brief.md"},{"type":"report","path":"brief-lint-result.json"}]
}
HS
mkdir -p .h-loop2/nodes/brief/run_1
python3 - <<'PY'
import json, pathlib
p = pathlib.Path(".h-loop2/nodes/brief/run_2/handshake.json")
d = json.loads(p.read_text())
d["runId"] = "run_1"
pathlib.Path(".h-loop2/nodes/brief/run_1/handshake.json").write_text(json.dumps(d, indent=2) + "\n")
PY
python3 -c "
import json
p='.h-loop2/flow-state.json'
s=json.load(open(p))
s['history']=[{'nodeId':'brief','runId':'run_2','timestamp':'2024-01-01T00:00:00.000Z'}]
s['totalSteps']=1
json.dump(s, open(p,'w'), indent=2)
"
OUT=$($HARNESS validate .h-loop2/nodes/brief/run_2/handshake.json 2>/dev/null)
VALID=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('valid'))" 2>/dev/null)
if [ "$VALID" = "True" ]; then
  echo "  ✅ validate accepts loopback brief with Iteration Delta"
  PASS=$((PASS + 1))
else
  echo "  ❌ validate rejected valid loopback brief: $OUT"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 6.7: run_1 brief does NOT require Iteration Delta (first pass) ---"
# Regression guard: first-pass brief (run_1) must still pass without a delta section.
OUT=$($HARNESS validate .h-real/nodes/brief/handshake.json 2>/dev/null)
VALID=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('valid'))" 2>/dev/null)
if [ "$VALID" = "True" ]; then
  echo "  ✅ run_1 brief passes without Iteration Delta"
  PASS=$((PASS + 1))
else
  echo "  ❌ run_1 brief wrongly required Iteration Delta: $OUT"
  FAIL=$((FAIL + 1))
fi

print_results
