#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
TMP="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM HUP

ok() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -q "$needle"; then ok "$label"; else fail "$label"; fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -q "$needle"; then fail "$label"; else ok "$label"; fi
}

print_results() {
  echo ""
  echo "==========================================="
  echo "  Results: $PASS passed, $FAIL failed"
  echo "==========================================="
  [ "$FAIL" -eq 0 ] || exit 1
}

echo "Test: install-hooks prereqs"
echo "================================================"

HOME_NO_JQ="$TMP/home-no-jq"
NO_JQ_PATH="$TMP/no-jq-path"
mkdir -p "$HOME_NO_JQ" "$NO_JQ_PATH"
HOME="$HOME_NO_JQ" "$NODE_BIN" "$REPO_ROOT/bin/opc.mjs" install > /dev/null

OUT=$(HOME="$HOME_NO_JQ" PATH="$NO_JQ_PATH" "$NODE_BIN" "$REPO_ROOT/bin/opc.mjs" install-hooks 2>&1)
assert_contains "$OUT" "PreToolUse" "PreToolUse guard installs without jq"
assert_contains "$OUT" "jq not found" "missing jq only skips compaction hooks"

NO_JQ_SETTINGS="$HOME_NO_JQ/.claude/settings.json"
NO_JQ_HOOKS=$(python3 - "$NO_JQ_SETTINGS" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("\n".join(d.get("hooks", {}).keys()))
PY
)
assert_contains "$NO_JQ_HOOKS" "PreToolUse" "no-jq settings contain PreToolUse"
assert_not_contains "$NO_JQ_HOOKS" "PreCompact" "no-jq settings omit PreCompact"
assert_not_contains "$NO_JQ_HOOKS" "PostCompact" "no-jq settings omit PostCompact"

HOME_OK="$TMP/home-ok"
mkdir -p "$HOME_OK"
HOME="$HOME_OK" "$NODE_BIN" "$REPO_ROOT/bin/opc.mjs" install > /dev/null
OUT_OK=$(HOME="$HOME_OK" "$NODE_BIN" "$REPO_ROOT/bin/opc.mjs" install-hooks 2>&1)
assert_contains "$OUT_OK" "PreCompact" "jq-enabled install registers compaction hooks"

SETTINGS="$HOME_OK/.claude/settings.json"
COMMANDS=$(python3 - "$SETTINGS" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
cmds = []
for group in ("PreCompact", "PostCompact"):
    for entry in d.get("hooks", {}).get(group, []):
        for hook in entry.get("hooks", []):
            cmds.append(hook.get("command", ""))
print("\n".join(cmds))
PY
)
assert_contains "$COMMANDS" "opc-pre-compact.sh" "PreCompact hook registered"
assert_contains "$COMMANDS" "opc-post-compact.sh" "PostCompact hook registered"
assert_not_contains "$COMMANDS" "|| true" "hook failures are not swallowed"
assert_not_contains "$COMMANDS" "2>/dev/null" "hook stderr is not hidden"

print_results
