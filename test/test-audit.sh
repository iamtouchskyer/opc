#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

# ── Setup: create fake sessions for audit to scan ──
# Audit uses getSessionsBaseDir which hashes git root.
# We'll use --base with a custom dir structure instead.

SESSIONS_BASE="$TMPDIR/fake-opc/sessions"
HASH="abcdef123456"
mkdir -p "$SESSIONS_BASE/$HASH"

# ── Session 1: complete, has skeptic-owner, deep evals, criteria ──
S1="$SESSIONS_BASE/$HASH/session-good"
mkdir -p "$S1/nodes/code-review/run_1"

cat > "$S1/flow-state.json" <<'EOF'
{
  "flowTemplate": "build-verify",
  "currentNode": null,
  "status": "completed",
  "tier": "polished",
  "totalSteps": 5,
  "history": [
    {"node": "build", "verdict": "PASS"},
    {"node": "code-review", "verdict": "PASS"},
    {"node": "gate", "verdict": "PASS"}
  ]
}
EOF

# Deep eval (>50 lines) with skeptic-owner
python3 -c "
lines = ['# Skeptic Owner Review', '', '## Summary', 'Thorough check.', '']
lines += ['Finding line %d: detail about code quality.' % i for i in range(60)]
lines += ['', '## Verdict', 'PASS']
print('\n'.join(lines))
" > "$S1/nodes/code-review/run_1/eval-skeptic-owner.md"

python3 -c "
lines = ['# Frontend Review', '', '## Summary', 'Looks good.', '']
lines += ['Line %d of frontend analysis with specific code references.' % i for i in range(55)]
lines += ['', '## Verdict', 'PASS']
print('\n'.join(lines))
" > "$S1/nodes/code-review/run_1/eval-frontend.md"

echo "# Acceptance Criteria" > "$S1/acceptance-criteria.md"

# ── Session 2: incomplete, no skeptic-owner, thin evals, skipped node ──
S2="$SESSIONS_BASE/$HASH/session-bad"
mkdir -p "$S2/nodes/code-review/run_1"

cat > "$S2/flow-state.json" <<'EOF'
{
  "flowTemplate": "review",
  "currentNode": "gate",
  "status": "active",
  "tier": "functional",
  "totalSteps": 2,
  "history": [
    {"node": "review", "verdict": "PASS", "skipped": true}
  ]
}
EOF

# Thin eval (< 50 lines), no skeptic-owner
cat > "$S2/nodes/code-review/run_1/eval-backend.md" <<'EOF'
# Backend Review

Looks fine.

## Verdict
PASS
EOF

echo ""
echo "Test: opc-harness audit"
echo "================================================"
echo ""

# ── We need to trick audit into scanning our fake dir ──
# audit uses getSessionsBaseDir(projectDir) which does SHA256(git-root).
# Instead, we'll symlink so the hash matches.
# Actually, audit.mjs scans getSessionsBaseDir which resolves to ~/.opc/sessions/{hash}.
# We can't easily override that, so let's test by passing --base and creating
# a git repo whose hash matches our dir structure.

# Simpler approach: patch HOME so getSessionsBaseDir resolves to our fake dir.
export HOME="$TMPDIR/fake-home"
mkdir -p "$HOME/.opc/sessions"
# Create a project dir with git init, get its hash
PROJ="$TMPDIR/fake-project"
mkdir -p "$PROJ"
cd "$PROJ"
git init -q .
git config user.email "test@test.com"
git config user.name "Test"
echo "x" > x.txt && git add . && git commit -q -m "init"

# Get the hash that audit will compute (must match realpathSync in util.mjs)
REAL_HASH=$(python3 -c "import os,hashlib; print(hashlib.sha256(os.path.realpath('$(git rev-parse --show-toplevel)').encode()).hexdigest()[:12])")

# Create sessions under that hash
mkdir -p "$HOME/.opc/sessions/$REAL_HASH"
cp -r "$S1" "$HOME/.opc/sessions/$REAL_HASH/session-good"
cp -r "$S2" "$HOME/.opc/sessions/$REAL_HASH/session-bad"

# ── Test 1: audit --format json produces valid output ──
echo "1. audit --format json → valid JSON with expected structure"
OUT=$($HARNESS audit --format json --base "$PROJ" 2>/dev/null || true)

if echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'sessions' in d and 'aggregate' in d" 2>/dev/null; then
  echo "  ✅ JSON has sessions + aggregate"
  PASS=$((PASS + 1))
else
  echo "  ❌ Invalid JSON structure"
  echo "  Output: $(echo "$OUT" | head -5)"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: correct session count ──
echo "2. Detects both sessions"
COUNT=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['aggregate']['total_sessions'])" 2>/dev/null)
if [ "$COUNT" = "2" ]; then
  echo "  ✅ total_sessions=2"
  PASS=$((PASS + 1))
else
  echo "  ❌ total_sessions=$COUNT (expected 2)"
  FAIL=$((FAIL + 1))
fi

# ── Test 3: good session has higher conformance than bad ──
echo "3. Good session scores higher than bad session"
SCORES=$(echo "$OUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for s in d['sessions']:
    print(s['id'], s['conformance_score'])
" 2>/dev/null)

GOOD_SCORE=$(echo "$SCORES" | grep "session-good" | awk '{print $2}')
BAD_SCORE=$(echo "$SCORES" | grep "session-bad" | awk '{print $2}')

if python3 -c "assert float('$GOOD_SCORE') > float('$BAD_SCORE')" 2>/dev/null; then
  echo "  ✅ good ($GOOD_SCORE) > bad ($BAD_SCORE)"
  PASS=$((PASS + 1))
else
  echo "  ❌ good=$GOOD_SCORE, bad=$BAD_SCORE"
  FAIL=$((FAIL + 1))
fi

# ── Test 4: bad session has no_manual_bypass = false (skipped: true in history) ──
echo "4. Skipped node → no_manual_bypass=false"
BYPASS=$(echo "$OUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for s in d['sessions']:
    if s['id'] == 'session-bad':
        print(s['checks']['no_manual_bypass'])
" 2>/dev/null)

if [ "$BYPASS" = "False" ]; then
  echo "  ✅ no_manual_bypass=False for bad session"
  PASS=$((PASS + 1))
else
  echo "  ❌ no_manual_bypass=$BYPASS (expected False)"
  FAIL=$((FAIL + 1))
fi

# ── Test 5: good session has acceptance_criteria_exists = true ──
echo "5. acceptance-criteria.md present → check passes"
AC=$(echo "$OUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for s in d['sessions']:
    if s['id'] == 'session-good':
        print(s['checks']['acceptance_criteria_exists'])
" 2>/dev/null)

if [ "$AC" = "True" ]; then
  echo "  ✅ acceptance_criteria_exists=True"
  PASS=$((PASS + 1))
else
  echo "  ❌ acceptance_criteria_exists=$AC"
  FAIL=$((FAIL + 1))
fi

# ── Test 6: --last 1 returns only 1 session ──
echo "6. --last 1 limits output"
OUT_LAST=$($HARNESS audit --format json --last 1 --base "$PROJ" 2>/dev/null || true)
LAST_COUNT=$(echo "$OUT_LAST" | python3 -c "import sys,json; print(json.load(sys.stdin)['aggregate']['total_sessions'])" 2>/dev/null)
if [ "$LAST_COUNT" = "1" ]; then
  echo "  ✅ --last 1 returns 1 session"
  PASS=$((PASS + 1))
else
  echo "  ❌ --last 1 returned $LAST_COUNT sessions"
  FAIL=$((FAIL + 1))
fi

print_results
