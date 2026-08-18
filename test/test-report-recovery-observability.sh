#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="node $ROOT/bin/opc-harness.mjs"
PASS=0
FAIL=0

check() {
  local label="$1"
  local cond="$2"
  if eval "$cond"; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

write_review() {
  local dir="$1"
  mkdir -p "$dir/nodes/review/run_1"
  printf '# Reviewer A\n\n[SUGGESTION] src/app.js:12 — Report hides warning finding\n→ Render it in the final report\nReasoning: The warning must stay visible after recovery.\nVERDICT: PASS FINDINGS[1]\n' > "$dir/nodes/review/run_1/eval-a.md"
  printf '# Reviewer B\n\n[SUGGESTION] src/app.js:18 — Add recovery context\n→ Include cumulative findings in prompt context\nReasoning: Compaction needs prior findings.\nVERDICT: PASS FINDINGS[1]\n' > "$dir/nodes/review/run_1/eval-b.md"
  printf '# Skeptic Owner\n\n[SUGGESTION] src/app.js:22 — Keep recovery observable\n→ Preserve cumulative findings after transition\nReasoning: Mandatory reviewer presence should not hide recovery evidence.\nVERDICT: PASS FINDINGS[1]\n' > "$dir/nodes/review/run_1/eval-skeptic-owner.md"
  printf '# Legacy Review\n\n## Finding 1 — Real structured issue title\n**Severity**: 🔵\n**Location**: src/legacy.js:7\n**R2 Status**: ✅\n\nVERDICT: PASS FINDINGS[1]\n' > "$dir/nodes/review/run_1/eval-legacy.md"
  mkdir -p "$dir/nodes/review/run_2"
  printf '# Reviewer C\n\n[WARNING] src/retry.js:33 — Retry run finding stays visible\n→ Preserve loopback findings per run\nReasoning: Retry runs must not be hidden by node-level de-duplication.\nVERDICT: ITERATE FINDINGS[1]\n' > "$dir/nodes/review/run_2/eval-c.md"
  printf '{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","summary":"done","timestamp":"2026-06-20T00:00:00Z","artifacts":[{"type":"eval","path":"run_1/eval-a.md"},{"type":"eval","path":"run_1/eval-b.md"},{"type":"eval","path":"run_1/eval-skeptic-owner.md"}],"verdict":"PASS","fixes_applied":["Bound report parser to canonical eval severity parsing"]}\n' > "$dir/nodes/review/handshake.json"
  printf '{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","summary":"done","timestamp":"2026-06-20T00:00:00Z","artifacts":[{"type":"eval","path":"eval-a.md"},{"type":"eval","path":"eval-b.md"},{"type":"eval","path":"eval-skeptic-owner.md"}],"verdict":"PASS","fixes_applied":["Bound report parser to canonical eval severity parsing"]}\n' > "$dir/nodes/review/run_1/handshake.json"
}

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

cd "$TMPD"
$HARNESS init --flow review --entry review --dir .harness > /dev/null 2>&1
write_review ".harness"

$HARNESS transition --from review --to gate --verdict PASS --flow review --dir .harness > /dev/null 2>&1

check "transition writes cumulative findings" 'test -f .harness/cumulative-findings.md'
check "cumulative findings include warning" 'grep -q "Report hides warning finding" .harness/cumulative-findings.md'
check "cumulative findings include legacy structured title" 'grep -q "Real structured issue title" .harness/cumulative-findings.md'
check "cumulative findings lists retry run as forensic orphan" 'grep -q "review/run_2" .harness/cumulative-findings.md'
check "cumulative findings excludes orphan retry text" '! grep -q "Retry run finding stays visible" .harness/cumulative-findings.md'
check "cumulative findings include execution fix" 'grep -q "Bound report parser" .harness/cumulative-findings.md'

PROMPT_JSON=$(OPC_DISABLE_EXTENSIONS=1 $HARNESS prompt-context --node gate --role resume --dir .harness 2>/dev/null)
PROMPT_APPEND=$(printf '%s' "$PROMPT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["append"])')
check "prompt-context injects recovery context" 'printf "%s" "$PROMPT_APPEND" | grep -q "OPC Recovery Context"'
check "prompt-context includes prior warning" 'printf "%s" "$PROMPT_APPEND" | grep -q "Report hides warning finding"'
check "prompt-context includes legacy structured title" 'printf "%s" "$PROMPT_APPEND" | grep -q "Real structured issue title"'
check "prompt-context excludes orphan retry text" '! printf "%s" "$PROMPT_APPEND" | grep -q "Retry run finding stays visible"'

$HARNESS transition --from gate --to null --verdict PASS --flow review --dir .harness > /dev/null 2>&1
VIZ=$($HARNESS viz --flow review --dir .harness 2>/dev/null)
VIZ_JSON=$($HARNESS viz --flow review --dir .harness --json 2>/dev/null)

check "viz shows completed terminal state" 'grep -q "FLOW COMPLETED at gate" <<< "$VIZ"'
check "viz no longer marks terminal as current" '! grep -q "▶ gate" <<< "$VIZ"'
check "viz json exposes completion" 'grep -q "\"completed\": true" <<< "$VIZ_JSON"'
check "viz json exposes terminal node" 'grep -q "\"terminalNode\": \"gate\"" <<< "$VIZ_JSON"'

node "$ROOT/bin/opc-report.mjs" --dir .harness --output report.html --title "Recovery Report" > /dev/null
check "report includes parser warning finding" 'grep -q "Report hides warning finding" report.html'
check "report preserves legacy structured title" 'grep -q "Real structured issue title" report.html'
check "report does not render severity metadata as title" '! grep -q "<h4>\\*\\*Severity\\*\\*" report.html'
check "report includes execution fixes section" 'grep -q "Fixes Applied During Execution" report.html'
check "report includes execution fix text" 'grep -q "Bound report parser" report.html'

SESSION_ROOT="$TMPD/session-root"
mkdir -p "$SESSION_ROOT/nodes/code-review/run_1"
printf '{"currentNode":"code-review"}\n' > "$SESSION_ROOT/flow-state.json"
printf '# Frontend Review\n\n[WARNING] src/docs.js:9 — Session-root eval is visible\n→ Include node eval files in report JSON\nReasoning: Session layouts do not use a nested .harness directory.\nVERDICT: ITERATE FINDINGS[1]\n' > "$SESSION_ROOT/nodes/code-review/run_1/eval-frontend.md"
REPORT_JSON=$($HARNESS report "$SESSION_ROOT" --mode review --task "session root report" 2>/dev/null)
check "report command accepts session root dir" 'printf "%s" "$REPORT_JSON" | grep -q "Session-root eval is visible"'
check "report command labels node eval role" 'printf "%s" "$REPORT_JSON" | grep -q "code-review/frontend"'

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
