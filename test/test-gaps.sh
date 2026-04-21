#!/bin/bash
# Gap coverage tests — targets every untested branch identified by coverage audit.
# Covers: resolveDir security, finalize error paths, synthesize verdicts,
#         loop-tick validation, loop-advance edge cases, eval-parser CRLF,
#         external flow loading, viz/replay errors, help output, and more.
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

# ═══════════════════════════════════════════════════════════════
echo "=== GAP-1: opc-harness help + unknown command ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 1.1: No-args shows help ---"
OUT=$(node "$(cd "$(dirname "$0")/.." 2>/dev/null || echo "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)")" 2>&1 || true)
# Use the HARNESS variable properly
OUT=$($HARNESS 2>&1 || true)
assert_contains "help output" "$OUT" "opc-harness"
assert_contains "flow commands" "$OUT" "Flow commands"

echo ""
echo "--- 1.2: Unknown command shows help ---"
OUT=$($HARNESS nonexistent-cmd 2>&1 || true)
assert_contains "unknown cmd help" "$OUT" "opc-harness"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-2: resolveDir path traversal guard ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 2.1: --dir /etc exits nonzero ---"
assert_exit_nonzero "traversal /etc" $HARNESS init --flow build-verify --dir /etc

echo ""
echo "--- 2.2: --dir ../../../ exits nonzero ---"
assert_exit_nonzero "traversal ../../.." $HARNESS init --flow build-verify --dir ../../../tmp

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-3: Flow command missing-args exit codes ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 3.1: route missing flags exits nonzero ---"
assert_exit_nonzero "route no-args" $HARNESS route

echo ""
echo "--- 3.2: init missing flow returns error JSON ---"
OUT=$($HARNESS init 2>/dev/null)
assert_field_eq "init no-flow" "$OUT" "created" "false"

echo ""
echo "--- 3.3: viz missing flow exits nonzero ---"
assert_exit_nonzero "viz no-flow" $HARNESS viz

echo ""
echo "--- 3.4: verify no-args exits nonzero ---"
assert_exit_nonzero "verify no-args" $HARNESS verify

echo ""
echo "--- 3.5: verify nonexistent file exits nonzero ---"
assert_exit_nonzero "verify missing file" $HARNESS verify /nonexistent/eval.md

echo ""
echo "--- 3.6: diff missing files exits nonzero ---"
assert_exit_nonzero "diff no-args" $HARNESS diff

echo ""
echo "--- 3.7: report no dir exits nonzero ---"
assert_exit_nonzero "report no-dir" $HARNESS report

echo ""
echo "--- 3.8: report missing mode/task exits nonzero ---"
assert_exit_nonzero "report no-mode" $HARNESS report /tmp --task test

echo ""
echo "--- 3.9: synthesize missing flags exits nonzero ---"
assert_exit_nonzero "synthesize no-dir" $HARNESS synthesize

echo ""
echo "--- 3.10: synthesize --node no nodeId exits nonzero ---"
assert_exit_nonzero "synth --node empty" $HARNESS synthesize /tmp --node

echo ""
echo "--- 3.11: synthesize --wave no number exits nonzero ---"
assert_exit_nonzero "synth --wave empty" $HARNESS synthesize /tmp --wave

echo ""
echo "--- 3.12: goto missing nodeId exits nonzero ---"
assert_exit_nonzero "goto no-node" $HARNESS goto --dir .harness

echo ""
echo "--- 3.13: complete-tick missing unit exits nonzero ---"
assert_exit_nonzero "ctick no-unit" $HARNESS complete-tick --dir .harness

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-4: Finalize error branches ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 4.1: finalize with tampered writer sig ---"
rm -rf .h-fin1 && $HARNESS init --flow build-verify --dir .h-fin1 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-fin1/flow-state.json'))
d['_written_by'] = 'evil-script'
json.dump(d, open('.h-fin1/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS finalize --dir .h-fin1 2>/dev/null)
assert_field_eq "finalize tamper" "$OUT" "finalized" "false"
assert_contains "finalize tamper msg" "$OUT" "not written by opc-harness"

echo ""
echo "--- 4.2: finalize with unknown template ---"
rm -rf .h-fin2 && $HARNESS init --flow build-verify --dir .h-fin2 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-fin2/flow-state.json'))
d['flowTemplate'] = 'nonexistent-template'
json.dump(d, open('.h-fin2/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS finalize --dir .h-fin2 2>/dev/null)
assert_field_eq "finalize bad template" "$OUT" "finalized" "false"
assert_contains "finalize unknown tpl" "$OUT" "unknown flow"

echo ""
echo "--- 4.3: finalize non-terminal node ---"
rm -rf .h-fin3 && $HARNESS init --flow build-verify --dir .h-fin3 >/dev/null 2>/dev/null
# build is not terminal (PASS→code-review, not null)
OUT=$($HARNESS finalize --dir .h-fin3 2>/dev/null)
assert_field_eq "finalize non-terminal" "$OUT" "finalized" "false"
assert_contains "non-terminal msg" "$OUT" "not a terminal"

echo ""
echo "--- 4.4: finalize with missing handshake at terminal gate (auto-creates) ---"
rm -rf .h-fin4 && $HARNESS init --flow review --entry gate --dir .h-fin4 >/dev/null 2>/dev/null
# gate PASS→null so it's terminal. finalize auto-creates gate handshake
# (commit f61d70e: terminal gate finalize auto-writes handshake).
OUT=$($HARNESS finalize --dir .h-fin4 2>/dev/null)
assert_field_eq "finalize auto-creates terminal gate handshake" "$OUT" "finalized" "true"
if [ -f ".h-fin4/nodes/gate/handshake.json" ]; then
  echo "  ✅ gate handshake auto-written to disk"
  PASS=$((PASS + 1))
else
  echo "  ❌ gate handshake not auto-written"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 4.5: finalize with non-completed terminal handshake ---"
# Use fresh dir — 4.4's successful finalize sets state.status=completed.
rm -rf .h-fin5 && $HARNESS init --flow review --entry gate --dir .h-fin5 >/dev/null 2>/dev/null
mkdir -p .h-fin5/nodes/gate
cat > .h-fin5/nodes/gate/handshake.json << 'HS'
{"nodeId":"gate","nodeType":"gate","runId":"run_1","status":"failed","summary":"x","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
OUT=$($HARNESS finalize --dir .h-fin5 2>/dev/null)
assert_field_eq "finalize bad status" "$OUT" "finalized" "false"
assert_contains "status not completed" "$OUT" "status is"

echo ""
echo "--- 4.6: finalize with corrupt terminal handshake ---"
# Fresh dir — pre-existing handshake must be corrupted before finalize runs.
rm -rf .h-fin6 && $HARNESS init --flow review --entry gate --dir .h-fin6 >/dev/null 2>/dev/null
mkdir -p .h-fin6/nodes/gate
echo "not json" > .h-fin6/nodes/gate/handshake.json
OUT=$($HARNESS finalize --dir .h-fin6 2>/dev/null)
assert_field_eq "finalize corrupt hs" "$OUT" "finalized" "false"
assert_contains "corrupt hs msg" "$OUT" "cannot parse"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-5: Transition error branches ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 5.1: transition with corrupt flow-state.json ---"
rm -rf .h-trans1 && mkdir -p .h-trans1
echo "not json" > .h-trans1/flow-state.json
OUT=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .h-trans1 2>/dev/null)
assert_field_eq "corrupt state" "$OUT" "allowed" "false"
assert_contains "corrupt msg" "$OUT" "corrupt"

echo ""
echo "--- 5.2: transition corrupt pre-transition handshake ---"
rm -rf .h-trans2 && $HARNESS init --flow build-verify --dir .h-trans2 >/dev/null 2>/dev/null
mkdir -p .h-trans2/nodes/build
echo "not json" > .h-trans2/nodes/build/handshake.json
OUT=$($HARNESS transition --from build --to code-review --verdict PASS --flow build-verify --dir .h-trans2 2>/dev/null)
assert_field_eq "corrupt handshake" "$OUT" "allowed" "false"
assert_contains "parse handshake" "$OUT" "parse"

echo ""
echo "--- 5.3: Backlog enforcement with PASS verdict (not just ITERATE) ---"
rm -rf .h-bp && $HARNESS init --flow build-verify --entry gate --dir .h-bp >/dev/null 2>/dev/null
mkdir -p .h-bp/nodes/test-execute
cat > .h-bp/nodes/test-execute/handshake.json << 'HS'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["ev.txt"],"findings":{"warning":1,"critical":0}}
HS
echo "evidence" > .h-bp/nodes/test-execute/ev.txt
# gate PASS→null in build-verify, but we need a non-null PASS target
# Use full-stack: gate-test PASS→acceptance, FAIL→discuss
rm -rf .h-bp2 && $HARNESS init --flow full-stack --entry gate-test --dir .h-bp2 >/dev/null 2>/dev/null
mkdir -p .h-bp2/nodes/test-execute
cat > .h-bp2/nodes/test-execute/handshake.json << 'HS'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["ev.txt"],"findings":{"warning":1,"critical":0}}
HS
echo "evidence" > .h-bp2/nodes/test-execute/ev.txt
OUT=$($HARNESS transition --from gate-test --to acceptance --verdict PASS --flow full-stack --dir .h-bp2 2>/dev/null)
assert_field_eq "PASS backlog check" "$OUT" "allowed" "false"
assert_contains "PASS backlog msg" "$OUT" "backlog"

echo ""
echo "--- 5.4: Backlog 0 matching entries blocked ---"
rm -rf .h-bp3 && $HARNESS init --flow full-stack --entry gate-test --dir .h-bp3 >/dev/null 2>/dev/null
mkdir -p .h-bp3/nodes/test-execute
cat > .h-bp3/nodes/test-execute/handshake.json << 'HS'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["ev.txt"],"findings":{"warning":1,"critical":0}}
HS
echo "evidence" > .h-bp3/nodes/test-execute/ev.txt
# Backlog exists but no entries from test-execute
cat > .h-bp3/backlog.md << 'BL'
# Backlog
- [ ] 🟡 Some other concern [build]
BL
OUT=$($HARNESS transition --from gate-test --to acceptance --verdict PASS --flow full-stack --dir .h-bp3 2>/dev/null)
assert_field_eq "0 entries blocked" "$OUT" "allowed" "false"
assert_contains "no entries msg" "$OUT" "no formatted entries"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-6: Escape hatch error branches ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 6.1: skip with unknown flow template ---"
rm -rf .h-esc1 && $HARNESS init --flow build-verify --dir .h-esc1 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-esc1/flow-state.json'))
d['flowTemplate'] = 'nonexistent'
json.dump(d, open('.h-esc1/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS skip --dir .h-esc1 2>/dev/null)
assert_contains "skip unknown flow" "$OUT" "unknown flow"

echo ""
echo "--- 6.2: pass with no state ---"
rm -rf .h-esc2 && mkdir -p .h-esc2
OUT=$($HARNESS pass --dir .h-esc2 2>/dev/null)
assert_contains "pass no state" "$OUT" "no flow-state"

echo ""
echo "--- 6.3: stop with no state ---"
OUT=$($HARNESS stop --dir .h-esc2 2>/dev/null)
assert_contains "stop no state" "$OUT" "no flow-state"

echo ""
echo "--- 6.4: goto with unknown flow ---"
rm -rf .h-esc3 && $HARNESS init --flow build-verify --dir .h-esc3 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-esc3/flow-state.json'))
d['flowTemplate'] = 'fake'
json.dump(d, open('.h-esc3/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS goto build --dir .h-esc3 2>/dev/null)
assert_contains "goto unknown flow" "$OUT" "unknown flow"

echo ""
echo "--- 6.5: pass succeeds on gate with non-null transition ---"
# full-stack: gate-test PASS→acceptance
rm -rf .h-esc4 && $HARNESS init --flow full-stack --entry gate-test --dir .h-esc4 >/dev/null 2>/dev/null
# gate-test upstream = test-execute. Create handshake with no warnings to skip backlog check.
mkdir -p .h-esc4/nodes/test-execute
cat > .h-esc4/nodes/test-execute/handshake.json << 'HS'
{"nodeId":"test-execute","nodeType":"execute","runId":"run_1","status":"completed","summary":"done",
 "timestamp":"2024-01-01T00:00:00Z","artifacts":["ev.txt"],"findings":{"warning":0,"critical":0}}
HS
echo "evidence" > .h-esc4/nodes/test-execute/ev.txt
OUT=$($HARNESS pass --dir .h-esc4 2>/dev/null)
assert_field_eq "pass gate→acceptance" "$OUT" "allowed" "true"

echo ""
echo "--- 6.6: pass with unknown flow ---"
rm -rf .h-esc5 && $HARNESS init --flow build-verify --entry gate --dir .h-esc5 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-esc5/flow-state.json'))
d['flowTemplate'] = 'fake-flow'
json.dump(d, open('.h-esc5/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS pass --dir .h-esc5 2>/dev/null)
assert_contains "pass unknown flow" "$OUT" "unknown flow"

echo ""
echo "--- 6.7: ls with .harness-* directories ---"
rm -rf .harness-test1 && $HARNESS init --flow build-verify --dir .harness-test1 >/dev/null 2>/dev/null
OUT=$($HARNESS ls --base . 2>/dev/null)
assert_contains "ls finds .harness-*" "$OUT" ".harness-test1"

echo ""
echo "--- 6.8: ls with nested harness ---"
rm -rf .harness && mkdir -p .harness/subflow
# Create a nested flow-state
$HARNESS init --flow review --dir .harness/subflow >/dev/null 2>/dev/null
OUT=$($HARNESS ls --base . 2>/dev/null)
assert_contains "ls finds nested" "$OUT" "subflow"

# ═══════════════════════════════════════════════════════════════
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
echo "--- 7.4: Synthesize no runs found exits nonzero ---"
rm -rf .h-synth4 && mkdir -p .h-synth4/nodes/code-review
assert_exit_nonzero "synth no runs" $HARNESS synthesize .h-synth4 --node code-review

echo ""
echo "--- 7.5: Synthesize no eval files exits nonzero ---"
rm -rf .h-synth5 && mkdir -p .h-synth5/nodes/code-review/run_1
echo "not an eval" > .h-synth5/nodes/code-review/run_1/readme.txt
assert_exit_nonzero "synth no evals" $HARNESS synthesize .h-synth5 --node code-review

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
OUT=$($HARNESS synthesize .h-wave --wave 1)
assert_contains "round filtered" "$OUT" "PASS"
assert_not_contains "round not included" "$OUT" "Round 1 draft"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-8: eval-parser edge cases ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 8.1: CRLF normalized ---"
rm -rf .h-crlf && mkdir -p .h-crlf
printf "# Review\r\nVERDICT: PASS FINDINGS[1]\r\n🔴 Bug — test.js:1 — an issue\r\n→ fix it\r\nReasoning: broken\r\n" > .h-crlf/crlf-eval.md
OUT=$($HARNESS verify .h-crlf/crlf-eval.md)
assert_field_eq "crlf critical" "$OUT" "critical" "1"
assert_field_eq "crlf verdict" "$OUT" "verdict_present" "true"

echo ""
echo "--- 8.2: Finding without em-dash ---"
cat > .h-crlf/nodash-eval.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[1]
🔴 Missing return statement in error handler
→ Add return after res.send()
Reasoning: falls through to next handler
EVAL
OUT=$($HARNESS verify .h-crlf/nodash-eval.md)
assert_field_eq "nodash critical" "$OUT" "critical" "1"
# Issue should be the full trimmed line (no dash to split on)
assert_contains "full issue" "$OUT" "Missing return"

echo ""
echo "--- 8.3: Hedging in continuation line ---"
cat > .h-crlf/hedge-cont-eval.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[1]
🔴 Security issue — auth.js:10 — improper validation
This might lead to unauthorized access
→ Add proper validation
Reasoning: auth checks missing
EVAL
OUT=$($HARNESS verify .h-crlf/hedge-cont-eval.md)
assert_contains "hedging continuation" "$OUT" "hedging"
assert_contains "might detected" "$OUT" "might"

echo ""
echo "--- 8.4: verdictCountMatch null when no FINDINGS[N] ---"
cat > .h-crlf/no-fn-eval.md << 'EVAL'
# Review
VERDICT: FAIL
🔴 A bug — test.js:1 — broken
→ fix
Reasoning: bad
EVAL
OUT=$($HARNESS verify .h-crlf/no-fn-eval.md)
assert_field_eq "count match null" "$OUT" "verdict_count_match" "__NULL__"

echo ""
echo "--- 8.5: findings_without_reasoning detected ---"
cat > .h-crlf/noreason-eval.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[1]
🔴 Some bug — code.js:5 — it's broken
→ fix it
EVAL
OUT=$($HARNESS verify .h-crlf/noreason-eval.md)
NOREASON=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('findings_without_reasoning',[])))")
if [ "$NOREASON" -ge 1 ]; then
  echo "  ✅ no-reasoning detected"
  PASS=$((PASS + 1))
else
  echo "  ❌ no-reasoning not detected"
  FAIL=$((FAIL + 1))
fi

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-9: Validate handshake edge cases ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 9.1: artifacts not array ---"
rm -rf .h-val && mkdir -p .h-val
cat > .h-val/bad-hs.json << 'HS'
{"nodeId":"x","nodeType":"build","runId":"run_1","status":"completed","summary":"x","timestamp":"2024-01-01T00:00:00Z","artifacts":"not-an-array"}
HS
OUT=$($HARNESS validate .h-val/bad-hs.json)
assert_field_eq "not array" "$OUT" "valid" "false"
assert_contains "artifacts array" "$OUT" "artifacts must be an array"

echo ""
echo "--- 9.2: loopback not object ---"
cat > .h-val/lb-hs.json << 'HS'
{"nodeId":"x","nodeType":"build","runId":"run_1","status":"completed","summary":"x","timestamp":"2024-01-01T00:00:00Z","artifacts":[],"loopback":"wrong"}
HS
OUT=$($HARNESS validate .h-val/lb-hs.json)
assert_field_eq "lb not obj" "$OUT" "valid" "false"
assert_contains "lb must be obj" "$OUT" "loopback must be an object"

echo ""
echo "--- 9.3: loopback.iteration not number ---"
cat > .h-val/lb2-hs.json << 'HS'
{"nodeId":"x","nodeType":"build","runId":"run_1","status":"completed","summary":"x","timestamp":"2024-01-01T00:00:00Z","artifacts":[],"loopback":{"from":"a","reason":"b","iteration":"nope"}}
HS
OUT=$($HARNESS validate .h-val/lb2-hs.json)
assert_field_eq "lb iter" "$OUT" "valid" "false"
assert_contains "iter not num" "$OUT" "iteration must be a number"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-10: External flow loading gaps ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 10.1: constructor name skipped ---"
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/constructor.json" << 'FL'
{"nodes": ["a"], "edges": {"a": {"PASS": null}}, "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5}}
FL
OUT=$($HARNESS init --flow constructor --dir .h-constr 2>&1 || true)
assert_contains "constructor skipped" "$OUT" "unknown flow\|Unknown flow"

echo ""
echo "--- 10.2: prototype name skipped ---"
cat > "$HOME/.claude/flows/prototype.json" << 'FL'
{"nodes": ["a"], "edges": {"a": {"PASS": null}}, "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5}}
FL
OUT=$($HARNESS init --flow prototype --dir .h-proto2 2>&1 || true)
assert_contains "prototype skipped" "$OUT" "unknown flow\|Unknown flow"

echo ""
echo "--- 10.3: Built-in name collision skipped ---"
cat > "$HOME/.claude/flows/build-verify.json" << 'FL'
{"nodes": ["custom-only"], "edges": {"custom-only": {"PASS": null}}, "limits": {"maxTotalSteps": 5, "maxLoopsPerEdge": 1, "maxNodeReentry": 1}}
FL
# If collision is handled, built-in build-verify should still work normally
OUT=$($HARNESS init --flow build-verify --dir .h-collide 2>/dev/null)
assert_field_eq "collision uses builtin" "$OUT" "created" "true"

echo ""
echo "--- 10.4: Malformed JSON in flows dir ---"
echo "not valid json" > "$HOME/.claude/flows/bad-json.json"
# Should not crash the harness — bad file silently skipped
OUT=$($HARNESS init --flow build-verify --dir .h-badjson 2>/dev/null)
assert_field_eq "malformed skipped" "$OUT" "created" "true"

echo ""
echo "--- 10.5: nodeTypes key not in nodes ---"
cat > "$HOME/.claude/flows/bad-nt-key.json" << 'FL'
{
  "nodes": ["a", "b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5},
  "nodeTypes": {"nonexistent": "build", "a": "build", "b": "gate"}
}
FL
OUT=$($HARNESS init --flow bad-nt-key --dir .h-badntk 2>&1 || true)
assert_contains "nt key not in nodes" "$OUT" "unknown flow\|Unknown flow"

echo ""
echo "--- 10.6: satisfiesVersion malformed range ---"
cat > "$HOME/.claude/flows/bad-compat.json" << 'FL'
{
  "nodes": ["a"], "edges": {"a": {"PASS": null}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5},
  "opc_compat": "~1.0"
}
FL
OUT=$($HARNESS init --flow bad-compat --dir .h-badcomp 2>&1 || true)
assert_contains "malformed range" "$OUT" "unknown flow\|Unknown flow\|malformed"

# Cleanup
rm -f "$HOME/.claude/flows/constructor.json"
rm -f "$HOME/.claude/flows/prototype.json"
rm -f "$HOME/.claude/flows/build-verify.json"
rm -f "$HOME/.claude/flows/bad-json.json"
rm -f "$HOME/.claude/flows/bad-nt-key.json"
rm -f "$HOME/.claude/flows/bad-compat.json"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-11: Viz + Replay error branches ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 11.1: replay with corrupt state ---"
rm -rf .h-rep1 && mkdir -p .h-rep1
echo "not json" > .h-rep1/flow-state.json
OUT=$($HARNESS replay --dir .h-rep1 2>&1 || true)
assert_contains "replay corrupt" "$OUT" "Cannot parse\|parse"

echo ""
echo "--- 11.2: replay with unknown template ---"
rm -rf .h-rep2 && $HARNESS init --flow build-verify --dir .h-rep2 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-rep2/flow-state.json'))
d['flowTemplate'] = 'nonexistent'
json.dump(d, open('.h-rep2/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS replay --dir .h-rep2 2>&1 || true)
assert_contains "replay bad template" "$OUT" "Unknown flow\|unknown flow"

echo ""
echo "--- 11.3: replay with run_* detail collection ---"
rm -rf .h-rep3 && $HARNESS init --flow build-verify --dir .h-rep3 >/dev/null 2>/dev/null
mkdir -p .h-rep3/nodes/build/run_1
echo "test output" > .h-rep3/nodes/build/run_1/result.md
cat > .h-rep3/nodes/build/handshake.json << 'HS'
{"nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","summary":"done","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
OUT=$($HARNESS replay --dir .h-rep3 2>/dev/null)
assert_contains "detail collected" "$OUT" "test output"

echo ""
echo "--- 11.4: diff file2 unreadable ---"
echo "dummy" > .h-rep3/r1.md
OUT=$($HARNESS diff .h-rep3/r1.md /nonexistent/r2.md)
assert_contains "file2 error" "$OUT" "Cannot read"

echo ""
echo "--- 11.5: diff oscillation=false (round1=0 findings) ---"
rm -rf .h-diffz && mkdir -p .h-diffz
cat > .h-diffz/empty.md << 'EVAL'
# Review
VERDICT: PASS FINDINGS[0]
EVAL
cat > .h-diffz/r2.md << 'EVAL'
# Review
VERDICT: FAIL FINDINGS[1]
🔴 New issue — test.js:1 — broken
EVAL
OUT=$($HARNESS diff .h-diffz/empty.md .h-diffz/r2.md)
assert_field_eq "osc false" "$OUT" "oscillation" "false"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-12: Loop-init gaps ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 12.1: init-loop --skip-scope plan not found ---"
rm -rf .h-li1 && mkdir -p .h-li1
OUT=$($HARNESS init-loop --skip-scope --plan /nonexistent/plan.md --dir .h-li1 2>/dev/null)
assert_field_eq "plan not found" "$OUT" "initialized" "false"
assert_contains "not found msg" "$OUT" "plan file not found"

echo ""
echo "--- 12.2: init-loop --skip-scope empty plan ---"
rm -rf .h-li2 && mkdir -p .h-li2
echo "nothing here" > .h-li2/plan.md
OUT=$($HARNESS init-loop --skip-scope --plan .h-li2/plan.md --dir .h-li2 2>/dev/null)
assert_field_eq "empty plan" "$OUT" "initialized" "false"
assert_contains "no units" "$OUT" "no units"

echo ""
echo "--- 12.3: init-loop --skip-scope corrupt existing state overwritten ---"
rm -rf .h-li3 && mkdir -p .h-li3
# Create corrupt loop-state.json
echo "not json" > .h-li3/loop-state.json
cat > .h-li3/plan.md << 'PLAN'
- F1.1: implement — build it
  - verify: echo ok
- F1.2: review — review it
PLAN
OUT=$($HARNESS init-loop --skip-scope --plan .h-li3/plan.md --dir .h-li3 2>/dev/null)
assert_field_eq "corrupt overwritten" "$OUT" "initialized" "true"

echo ""
echo "--- 12.4: init-loop --skip-scope plan ends with implement ---"
rm -rf .h-li4 && mkdir -p .h-li4
cat > .h-li4/plan.md << 'PLAN'
- F1.1: implement — build it
PLAN
OUT=$($HARNESS init-loop --skip-scope --plan .h-li4/plan.md --dir .h-li4 2>/dev/null)
assert_field_eq "trailing impl" "$OUT" "initialized" "false"
assert_contains "no review follows" "$OUT" "no review"

echo ""
echo "--- 12.5: fix unit type triggers verify warning ---"
rm -rf .h-li5 && mkdir -p .h-li5
cat > .h-li5/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
- F1.3: fix — fix findings
PLAN
OUT=$($HARNESS init-loop --skip-scope --plan .h-li5/plan.md --dir .h-li5 2>/dev/null)
assert_field_eq "fix init ok" "$OUT" "initialized" "true"
assert_contains "fix verify warn" "$OUT" "verify"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-13: Loop-tick gaps ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 13.1: complete-tick invalid status ---"
rm -rf .h-lt1 && mkdir -p .h-lt1
cat > .h-lt1/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt1/plan.md --dir .h-lt1 >/dev/null 2>/dev/null
OUT=$($HARNESS complete-tick --unit F1.1 --status invalid --artifacts dummy.txt --dir .h-lt1 2>/dev/null)
assert_field_eq "invalid status" "$OUT" "completed" "false"
assert_contains "invalid status msg" "$OUT" "invalid status"

echo ""
echo "--- 13.2: complete-tick failed status keeps same unit ---"
# Re-init
rm -rf .h-lt2 && mkdir -p .h-lt2
cat > .h-lt2/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt2/plan.md --dir .h-lt2 >/dev/null 2>/dev/null
OUT=$($HARNESS complete-tick --unit F1.1 --status failed --artifacts dummy.txt --description "it broke" --dir .h-lt2 2>/dev/null)
assert_field_eq "failed completed" "$OUT" "completed" "true"
assert_field_eq "failed same unit" "$OUT" "next_unit" "F1.1"

echo ""
echo "--- 13.3: complete-tick on terminated pipeline ---"
rm -rf .h-lt3 && mkdir -p .h-lt3
cat > .h-lt3/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt3/plan.md --dir .h-lt3 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-lt3/loop-state.json'))
d['status'] = 'terminated'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-lt3/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts dummy.txt --dir .h-lt3 2>/dev/null)
assert_field_eq "terminated blocked" "$OUT" "completed" "false"
assert_contains "terminated msg" "$OUT" "terminated"

echo ""
echo "--- 13.4: implement artifact not found ---"
rm -rf .h-lt4 && mkdir -p .h-lt4
cat > .h-lt4/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt4/plan.md --dir .h-lt4 >/dev/null 2>/dev/null
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts /nonexistent/file.json --dir .h-lt4 2>/dev/null)
assert_field_eq "artifact not found" "$OUT" "completed" "false"
assert_contains "not found msg" "$OUT" "artifact not found"

echo ""
echo "--- 13.5: implement empty artifact ---"
echo "" > empty-art.json
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts empty-art.json --dir .h-lt4 2>/dev/null)
assert_field_eq "empty artifact" "$OUT" "completed" "false"
assert_contains "empty msg" "$OUT" "empty"

echo ""
echo "--- 13.6: JSON artifact future timestamp ---"
cat > future-art.json << 'JSON'
{"tests_run":1,"passed":1,"_timestamp":"2099-12-31T23:59:59Z","durationMs":100}
JSON
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts future-art.json --dir .h-lt4 2>/dev/null)
assert_contains "future ts" "$OUT" "future timestamp"

echo ""
echo "--- 13.7: JSON artifact durationMs zero ---"
cat > zero-dur-art.json << 'JSON'
{"tests_run":1,"passed":1,"_command":"test","durationMs":0,"_timestamp":"2026-01-01T00:00:00Z"}
JSON
# Reset state to F1.1
python3 -c "
import json
d = json.load(open('.h-lt4/loop-state.json'))
d['next_unit'] = 'F1.1'
d['status'] = 'initialized'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-lt4/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts zero-dur-art.json --dir .h-lt4 2>/dev/null)
assert_contains "zero duration" "$OUT" "durationMs"

echo ""
echo "--- 13.8: UI implement needs screenshot ---"
rm -rf .h-lt5 && mkdir -p .h-lt5
cat > .h-lt5/plan.md << 'PLAN'
- F1.1: implement-ui — build UI
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt5/plan.md --dir .h-lt5 >/dev/null 2>/dev/null
echo "content" > ui-artifact.json
OUT=$($HARNESS complete-tick --unit F1.1 --artifacts ui-artifact.json --dir .h-lt5 2>/dev/null)
assert_contains "no screenshot" "$OUT" "screenshot"

echo ""
echo "--- 13.9: validateFixArtifacts eval tamper detection ---"
rm -rf .h-lt6 && mkdir -p .h-lt6
cat > .h-lt6/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
- F1.3: fix — fix findings
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt6/plan.md --dir .h-lt6 >/dev/null 2>/dev/null

# Simulate: implement done, review done (with eval hash stored), now fix
echo "original eval content" > eval-engineer.md
echo "original eval content 2" > eval-security.md

python3 -c "
import json, hashlib
d = json.load(open('.h-lt6/loop-state.json'))
d['tick'] = 2
d['next_unit'] = 'F1.3'
d['_git_head'] = 'aaa'  # will differ from current HEAD
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
# Store eval hashes (simulating review tick output)
h1 = hashlib.sha256(open('eval-engineer.md','rb').read()).hexdigest()[:16]
h2 = hashlib.sha256(open('eval-security.md','rb').read()).hexdigest()[:16]
d['_last_review_evals'] = {'eval-engineer.md': h1, 'eval-security.md': h2}
json.dump(d, open('.h-lt6/loop-state.json', 'w'), indent=2)
"
# Tamper with one eval file
echo "TAMPERED content" > eval-engineer.md

# Create fix artifact with finding references
echo "🔴 Fixed auth.js:10" > fix-notes.md

OUT=$($HARNESS complete-tick --unit F1.3 --artifacts fix-notes.md --dir .h-lt6 2>/dev/null)
assert_field_eq "tamper detected" "$OUT" "completed" "false"
assert_contains "tamper msg" "$OUT" "modified after review"

echo ""
echo "--- 13.10: validateFixArtifacts eval file deleted ---"
# Delete the other eval file
rm -f eval-security.md
# Reset state
python3 -c "
import json
d = json.load(open('.h-lt6/loop-state.json'))
d['tick'] = 2
d['next_unit'] = 'F1.3'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-lt6/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS complete-tick --unit F1.3 --artifacts fix-notes.md --dir .h-lt6 2>/dev/null)
assert_field_eq "deleted detected" "$OUT" "completed" "false"
assert_contains "deleted msg" "$OUT" "deleted"

echo ""
echo "--- 13.11: e2e unit with no artifacts ---"
rm -rf .h-lt7 && mkdir -p .h-lt7
cat > .h-lt7/plan.md << 'PLAN'
- F1.1: e2e — end to end test
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt7/plan.md --dir .h-lt7 >/dev/null 2>/dev/null
OUT=$($HARNESS complete-tick --unit F1.1 --dir .h-lt7 2>/dev/null)
assert_field_eq "e2e no artifacts" "$OUT" "completed" "false"
assert_contains "e2e needs evidence" "$OUT" "verification evidence"

echo ""
echo "--- 13.12: review without severity markers ---"
rm -rf .h-lt8 && mkdir -p .h-lt8
cat > .h-lt8/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt8/plan.md --dir .h-lt8 >/dev/null 2>/dev/null
# Skip to F1.2
python3 -c "
import json
d = json.load(open('.h-lt8/loop-state.json'))
d['tick'] = 1
d['next_unit'] = 'F1.2'
d['_written_by'] = 'opc-harness'
d['_last_modified'] = '2026-01-01T00:00:00Z'
json.dump(d, open('.h-lt8/loop-state.json', 'w'), indent=2)
"
echo "Just some text without any markers" > eval-a.md
echo "Another review without severity emojis" > eval-b.md
OUT=$($HARNESS complete-tick --unit F1.2 --artifacts eval-a.md,eval-b.md --dir .h-lt8 2>/dev/null)
assert_field_eq "no markers" "$OUT" "completed" "false"
assert_contains "no markers msg" "$OUT" "severity markers"

echo ""
echo "--- 13.13: review identical files detected ---"
rm -rf .h-lt9 && mkdir -p .h-lt9
cat > .h-lt9/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-lt9/plan.md --dir .h-lt9 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-lt9/loop-state.json'))
d['tick'] = 1
d['next_unit'] = 'F1.2'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-lt9/loop-state.json', 'w'), indent=2)
"
cat > dup-eval-a.md << 'EVAL'
# Security Review
VERDICT: PASS FINDINGS[1]
🔵 Minor — utils.js:5 — add input validation
EVAL
cp dup-eval-a.md dup-eval-b.md
OUT=$($HARNESS complete-tick --unit F1.2 --artifacts dup-eval-a.md,dup-eval-b.md --dir .h-lt9 2>/dev/null)
assert_field_eq "identical evals" "$OUT" "completed" "false"
assert_contains "identical msg" "$OUT" "identical"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-14: Loop-advance gaps ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 14.1: next-tick with no loop-state ---"
rm -rf .h-la1 && mkdir -p .h-la1
OUT=$($HARNESS next-tick --dir .h-la1 2>/dev/null)
assert_field_eq "no state terminate" "$OUT" "terminate" "true"
assert_contains "no state msg" "$OUT" "not found"

echo ""
echo "--- 14.2: next-tick on terminated pipeline ---"
rm -rf .h-la2 && mkdir -p .h-la2
cat > .h-la2/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-la2/plan.md --dir .h-la2 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-la2/loop-state.json'))
d['status'] = 'pipeline_complete'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-la2/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-la2 2>/dev/null)
assert_field_eq "terminated" "$OUT" "terminate" "true"
assert_contains "already msg" "$OUT" "already"

echo ""
echo "--- 14.3: 2 consecutive same unit does NOT stall ---"
rm -rf .h-la3 && mkdir -p .h-la3
cat > .h-la3/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-la3/plan.md --dir .h-la3 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-la3/loop-state.json'))
d['tick'] = 2
d['next_unit'] = 'F1.1'
d['status'] = 'idle'
d['_tick_history'] = [
    {'unit': 'F1.1', 'tick': 1, 'status': 'failed'},
    {'unit': 'F1.1', 'tick': 2, 'status': 'failed'}
]
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-la3/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-la3 2>/dev/null)
assert_field_eq "2x no stall" "$OUT" "ready" "true"
assert_not_contains "no stall msg" "$OUT" "stalled"

echo ""
echo "--- 14.4: 4 alternating does NOT oscillate ---"
rm -rf .h-la4 && mkdir -p .h-la4
cat > .h-la4/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-la4/plan.md --dir .h-la4 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-la4/loop-state.json'))
d['tick'] = 4
d['next_unit'] = 'F1.1'
d['status'] = 'idle'
d['_tick_history'] = [
    {'unit': 'F1.1', 'tick': 1, 'status': 'failed'},
    {'unit': 'F1.2', 'tick': 2, 'status': 'failed'},
    {'unit': 'F1.1', 'tick': 3, 'status': 'failed'},
    {'unit': 'F1.2', 'tick': 4, 'status': 'failed'}
]
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-la4/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-la4 2>/dev/null)
assert_field_eq "4x no oscillation" "$OUT" "ready" "true"
assert_not_contains "no osc msg" "$OUT" "oscillation"

echo ""
echo "--- 14.5: Backlog drain gate at pipeline completion ---"
rm -rf .h-la5 && mkdir -p .h-la5
cat > .h-la5/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-la5/plan.md --dir .h-la5 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-la5/loop-state.json'))
d['tick'] = 2
d['next_unit'] = None
d['status'] = 'idle'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-la5/loop-state.json', 'w'), indent=2)
"
# Create backlog with open items — drain gate should block termination
cat > .h-la5/backlog.md << 'BL'
# Backlog
- [ ] Fix input validation
- [x] Add error handling
- [ ] Improve test coverage
BL
OUT=$($HARNESS next-tick --dir .h-la5 2>/dev/null)
assert_field_eq "drain blocks termination" "$OUT" "terminate" "false"
assert_field_eq "drain required flag" "$OUT" "drain_required" "true"
assert_contains "backlog surfaced" "$OUT" "backlog\|open_items"

# Force-terminate bypasses drain gate
OUT=$($HARNESS next-tick --dir .h-la5 --force-terminate 2>/dev/null)
assert_field_eq "force-terminate works" "$OUT" "terminate" "true"

echo ""
echo "--- 14.6: next-tick no plan file ---"
rm -rf .h-la6 && mkdir -p .h-la6
cat > .h-la6/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-la6/plan.md --dir .h-la6 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-la6/loop-state.json'))
d['next_unit'] = 'F1.1'
d['status'] = 'idle'
d['_written_by'] = 'opc-harness'
# Point to non-existent plan
d['plan_file'] = '.h-la6/deleted-plan.md'
json.dump(d, open('.h-la6/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-la6 2>/dev/null)
assert_contains "no plan error" "$OUT" "plan file.*not found\|plan.*not found"

echo ""
echo "--- 14.7: next-tick tamper warning ---"
rm -rf .h-la7 && mkdir -p .h-la7
cat > .h-la7/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-la7/plan.md --dir .h-la7 >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-la7/loop-state.json'))
d['next_unit'] = 'F1.1'
d['status'] = 'idle'
d['_written_by'] = 'someone-else'
d['_write_nonce'] = None
json.dump(d, open('.h-la7/loop-state.json', 'w'), indent=2)
"
OUT=$($HARNESS next-tick --dir .h-la7 2>/dev/null)
assert_contains "tamper warning" "$OUT" "not written by\|possible direct edit"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-15: Report + validate-context edge cases ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 15.1: Report finding status filtering ---"
rm -rf .h-rp1 && mkdir -p .h-rp1/.harness
cat > .h-rp1/.harness/evaluation-wave-1-engineer.md << 'EVAL'
# Engineer Review
VERDICT: PASS FINDINGS[2]
🔴 Critical — auth.js:1 — XSS vulnerability
→ Sanitize input
Reasoning: user input unescaped
🔵 Minor — style.css:1 — use variables
EVAL
OUT=$($HARNESS report .h-rp1 --mode review --task "test")
# Both findings should be counted (both default to status=accepted)
assert_contains "critical counted" "$OUT" '"critical": 1'
assert_contains "suggestion counted" "$OUT" '"suggestion": 1'

echo ""
echo "--- 15.2: validate-context unknown template ---"
OUT=$($HARNESS validate-context --flow nonexistent-flow --node x --dir .h-la1 2>/dev/null)
assert_field_eq "vc unknown tpl" "$OUT" "valid" "false"
assert_contains "vc unknown msg" "$OUT" "unknown flow"

echo ""
echo "--- 15.3: validate-context unknown rule name (rejected at load-time) ---"
# Create external flow with unknown rule — now rejected at load-time by contextSchema validation
mkdir -p "$HOME/.claude/flows"
cat > "$HOME/.claude/flows/bad-rule.json" << 'FL'
{
  "nodes": ["s1", "s2"],
  "edges": {"s1": {"PASS": "s2"}, "s2": {"PASS": null}},
  "limits": {"maxTotalSteps": 10, "maxLoopsPerEdge": 3, "maxNodeReentry": 5},
  "nodeTypes": {"s1": "build", "s2": "gate"},
  "contextSchema": {"s1": {"required": ["x"], "rules": {"x": "unknown-rule-type"}}},
  "opc_compat": ">=0.5"
}
FL
# Flow should fail to load due to contextSchema validation — init returns unknown template
OUT=$($HARNESS init --flow bad-rule --dir .h-vc1 2>/dev/null || true)
assert_contains "unknown rule rejected at load" "$OUT" "unknown flow template"
# validate-context also returns unknown since the flow never loaded
OUT=$($HARNESS validate-context --flow bad-rule --node s1 --dir .h-vc1 2>/dev/null || true)
assert_contains "unknown rule msg" "$OUT" "unknown flow"
rm -f "$HOME/.claude/flows/bad-rule.json"

# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== GAP-16: Loop-helpers gaps ==="
# ═══════════════════════════════════════════════════════════════

echo "--- 16.1: detectTestScript with package.json ---"
rm -rf .h-pkg && mkdir -p .h-pkg
cat > package.json << 'PKG'
{"scripts":{"test":"jest","lint":"eslint ."}}
PKG
cat > .h-pkg/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
OUT=$($HARNESS init-loop --skip-scope --plan .h-pkg/plan.md --dir .h-pkg 2>/dev/null)
assert_contains "test script detected" "$OUT" "test script"
assert_contains "lint script detected" "$OUT" "lint script"

echo ""
echo "--- 16.2: validate-chain handshake parse error ---"
rm -rf .h-vc2 && $HARNESS init --flow build-verify --dir .h-vc2 >/dev/null 2>/dev/null
mkdir -p .h-vc2/nodes/build
echo "not json" > .h-vc2/nodes/build/handshake.json
# Add history so validator checks build's handshake
python3 -c "
import json
d = json.load(open('.h-vc2/flow-state.json'))
d['history'] = [{'nodeId': 'build', 'runId': 'run_1', 'timestamp': '2024-01-01T00:00:00Z'}]
d['currentNode'] = 'code-review'
json.dump(d, open('.h-vc2/flow-state.json', 'w'), indent=2)
"
OUT=$($HARNESS validate-chain --dir .h-vc2 2>/dev/null)
assert_field_eq "chain parse error" "$OUT" "valid" "false"
assert_contains "parse error chain" "$OUT" "parse error"

echo ""
echo "--- 16.3: Review headings identical warning ---"
rm -rf .h-hd && mkdir -p .h-hd
cat > .h-hd/plan.md << 'PLAN'
- F1.1: implement — build
  - verify: echo ok
- F1.2: review — review
PLAN
$HARNESS init-loop --skip-scope --plan .h-hd/plan.md --dir .h-hd >/dev/null 2>/dev/null
python3 -c "
import json
d = json.load(open('.h-hd/loop-state.json'))
d['tick'] = 1
d['next_unit'] = 'F1.2'
d['_written_by'] = 'opc-harness'
json.dump(d, open('.h-hd/loop-state.json', 'w'), indent=2)
"
# Two files with identical heading but different content
cat > head-a.md << 'EVAL'
# Security Review
VERDICT: PASS FINDINGS[1]
🔵 Minor A — utils.js:5 — add validation
EVAL
cat > head-b.md << 'EVAL'
# Security Review
VERDICT: PASS FINDINGS[1]
🔵 Minor B — api.js:10 — add timeout
EVAL
OUT=$($HARNESS complete-tick --unit F1.2 --artifacts head-a.md,head-b.md --dir .h-hd 2>/dev/null)
assert_contains "identical heading" "$OUT" "identical heading"

# Cleanup
rm -f package.json

print_results
