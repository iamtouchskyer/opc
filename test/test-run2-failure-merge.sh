#!/bin/bash
# test-run2-failure-merge.sh — Unit-level proof of cross-command failure merge (G3 / U2.8c)
#
# Reviewer B (U2.8b) caught that the U2.8a regex-based merge was non-functional:
# `\S` without /u flag couldn't match emoji surrogate pairs, so the regex returned
# null on every line written by the same function. The merge silently degenerated
# to overwrite — which was the very bug U2.8a was supposed to fix.
#
# U2.8c switched writeFailureReport to a JSON sidecar architecture:
#   - extension-failures.json is the canonical machine-readable source of truth
#   - extension-failures.md is a derived view rendered from the sidecar
#   - merge reads the sidecar (no parser/writer skew possible)
#
# This test directly invokes writeFailureReport twice on the same dir with
# disjoint failure sets and asserts the union is present in BOTH the sidecar
# and the markdown view. Catches G3 regressions immediately.

set -u
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0
FAIL=0
FAIL_DETAILS=""

fail() {
  FAIL=$((FAIL + 1))
  FAIL_DETAILS="${FAIL_DETAILS}  ❌ $1"$'\n'
}
ok() {
  PASS=$((PASS + 1))
  echo "  ✅ $1"
}

TMP=$(mktemp -d -t opc-run2-merge-XXXXXX)
cleanup() {
  if [ "$FAIL" -eq 0 ]; then
    rm -rf "$TMP"
  else
    echo "  ⚠️  TMP preserved for diagnosis: $TMP" >&2
  fi
}
trap cleanup EXIT INT TERM HUP

echo "=== TEST: writeFailureReport cross-command merge (U2.8c JSON sidecar) ==="

# ── 1. Two consecutive calls with disjoint failures must union ─────
echo "--- 1.1: writeFailureReport called twice with disjoint failures → union ---"

cat > "$TMP/merge.mjs" <<EOF
import { writeFailureReport } from "$REPO_ROOT/bin/lib/extensions.mjs";
const dir = "$TMP/run";
import { mkdirSync } from "fs";
mkdirSync(dir, { recursive: true });

// First call: throw-ext failure (simulates verdict-phase CLI invocation)
writeFailureReport({
  failures: [{ ext: "throw-ext", hook: "verdictAppend", kind: "error", message: "intentional", at: "2025-04-18T00:00:01Z" }],
  failuresDropped: 0
}, dir);

// Second call: slow-ext failure (simulates a separate prompt-phase CLI invocation
// — fresh registry, empty failures[] from this command's perspective, but the file
// must still preserve throw-ext from the prior write)
writeFailureReport({
  failures: [{ ext: "slow-ext", hook: "promptAppend", kind: "timeout", message: "exceeded 500ms", at: "2025-04-18T00:00:02Z" }],
  failuresDropped: 0
}, dir);
EOF

node "$TMP/merge.mjs" 2>"$TMP/merge.err" || {
  fail "merge script crashed (see $TMP/merge.err)"
  cat "$TMP/merge.err" >&2
}

SIDECAR="$TMP/run/extension-failures.json"
MD="$TMP/run/extension-failures.md"

# ── 2. Sidecar (canonical) contains BOTH failures ──────────────────
if [ -f "$SIDECAR" ]; then
  COUNT=$(jq -r '.failures | length' "$SIDECAR" 2>/dev/null || echo "x")
  if [ "$COUNT" = "2" ]; then
    ok "sidecar: failures.length = 2 (union preserved)"
  else
    fail "sidecar: failures.length = $COUNT (expected 2 — merge degenerated to overwrite)"
    cat "$SIDECAR" >&2
  fi

  HAS_THROW=$(jq -r '[.failures[] | select(.ext == "throw-ext")] | length' "$SIDECAR" 2>/dev/null || echo "x")
  HAS_SLOW=$(jq -r '[.failures[] | select(.ext == "slow-ext")] | length' "$SIDECAR" 2>/dev/null || echo "x")
  if [ "$HAS_THROW" = "1" ]; then
    ok "sidecar: throw-ext entry present (prior failure not wiped)"
  else
    fail "sidecar: throw-ext entry missing (G3 regression — second write overwrote first)"
  fi
  if [ "$HAS_SLOW" = "1" ]; then
    ok "sidecar: slow-ext entry present (current failure recorded)"
  else
    fail "sidecar: slow-ext entry missing"
  fi
else
  fail "sidecar: extension-failures.json not written"
fi

# ── 3. Markdown view (derived) names BOTH extensions ───────────────
if [ -f "$MD" ]; then
  if grep -q "throw-ext" "$MD"; then
    ok "markdown: names throw-ext"
  else
    fail "markdown: missing throw-ext (derived view diverged from sidecar)"
    cat "$MD" >&2
  fi
  if grep -q "slow-ext" "$MD"; then
    ok "markdown: names slow-ext"
  else
    fail "markdown: missing slow-ext"
    cat "$MD" >&2
  fi
  # Severity emojis must round-trip — kind=error → 🟡, kind=timeout → 🟡
  if grep -q "🟡" "$MD"; then
    ok "markdown: severity marker rendered"
  else
    fail "markdown: no 🟡 severity marker (rendering broke)"
  fi
else
  fail "markdown: extension-failures.md not written"
fi

# ── 4. Dedup: same failure logged twice should appear once ─────────
echo "--- 4.1: writeFailureReport called twice with SAME failure → dedup ---"

DEDUP_DIR="$TMP/dedup"
cat > "$TMP/dedup.mjs" <<EOF
import { writeFailureReport } from "$REPO_ROOT/bin/lib/extensions.mjs";
import { mkdirSync } from "fs";
const dir = "$DEDUP_DIR";
mkdirSync(dir, { recursive: true });

const f = { ext: "throw-ext", hook: "verdictAppend", kind: "error", message: "intentional", at: "2025-04-18T00:00:01Z" };
writeFailureReport({ failures: [f], failuresDropped: 0 }, dir);
writeFailureReport({ failures: [f], failuresDropped: 0 }, dir);
EOF

node "$TMP/dedup.mjs" 2>"$TMP/dedup.err" || {
  fail "dedup script crashed (see $TMP/dedup.err)"
}

DEDUP_SIDECAR="$DEDUP_DIR/extension-failures.json"
if [ -f "$DEDUP_SIDECAR" ]; then
  DCOUNT=$(jq -r '.failures | length' "$DEDUP_SIDECAR" 2>/dev/null || echo "x")
  if [ "$DCOUNT" = "1" ]; then
    ok "dedup: identical failure recorded once (length=1)"
  else
    fail "dedup: failures.length = $DCOUNT (expected 1 — dedup not working)"
  fi
fi

# ── 5. Empty second write preserves prior content (Reviewer B's repro) ──
echo "--- 5.1: empty registry on second call MUST NOT wipe prior failures ---"

EMPTY_DIR="$TMP/empty"
cat > "$TMP/empty.mjs" <<EOF
import { writeFailureReport } from "$REPO_ROOT/bin/lib/extensions.mjs";
import { mkdirSync } from "fs";
const dir = "$EMPTY_DIR";
mkdirSync(dir, { recursive: true });

writeFailureReport({
  failures: [{ ext: "throw-ext", hook: "verdictAppend", kind: "error", message: "intentional", at: "2025-04-18T00:00:01Z" }],
  failuresDropped: 0
}, dir);
// Fresh registry for next CLI invocation — failures[] is empty
writeFailureReport({ failures: [], failuresDropped: 0 }, dir);
EOF

node "$TMP/empty.mjs" 2>"$TMP/empty.err" || fail "empty script crashed"

EMPTY_MD="$EMPTY_DIR/extension-failures.md"
if [ -f "$EMPTY_MD" ]; then
  if grep -q "throw-ext" "$EMPTY_MD"; then
    ok "empty-second-write: throw-ext preserved in markdown"
  else
    fail "empty-second-write: throw-ext WIPED — overwrite bug regressed!"
    cat "$EMPTY_MD" >&2
  fi
  if grep -q "No hook failures recorded" "$EMPTY_MD"; then
    fail "empty-second-write: 'No failures' message present despite prior throw-ext entry"
  else
    ok "empty-second-write: no false 'No failures' message"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  printf "%s" "$FAIL_DETAILS"
  exit 1
fi
