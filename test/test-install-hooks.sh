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
HOME="$HOME_NO_JQ" "$NODE_BIN" "$REPO_ROOT/bin/opc.mjs" install --host claude > /dev/null

set +e
OUT=$(HOME="$HOME_NO_JQ" PATH="$NO_JQ_PATH" "$NODE_BIN" "$REPO_ROOT/bin/opc.mjs" install-hooks --host claude 2>&1)
STATUS=$?
set -e

if [ "$STATUS" -ne 0 ]; then ok "install-hooks fails when jq is absent"; else fail "install-hooks should fail without jq"; fi
assert_contains "$OUT" "requires 'jq'" "missing jq error is explicit"
if [ ! -f "$HOME_NO_JQ/.claude/settings.json" ]; then ok "settings not written after failed prereq"; else fail "settings should not be written when prereq fails"; fi

HOME_OK="$TMP/home-ok"
mkdir -p "$HOME_OK"
HOME="$HOME_OK" "$NODE_BIN" "$REPO_ROOT/bin/opc.mjs" install --host claude > /dev/null
OUT_OK=$(HOME="$HOME_OK" "$NODE_BIN" "$REPO_ROOT/bin/opc.mjs" install-hooks --host claude 2>&1)
assert_contains "$OUT_OK" "Verified: hook scripts present and jq available" "successful install verifies hook prereqs"

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

HOME_CODEX="$TMP/home-codex"
mkdir -p "$HOME_CODEX"
OUT_CODEX=$(HOME="$HOME_CODEX" "$NODE_BIN" "$REPO_ROOT/bin/opc.mjs" install 2>&1)
if [ -f "$HOME_CODEX/.codex/skills/opc/SKILL.md" ]; then ok "default install targets Codex"; else fail "default install should target Codex"; fi
assert_contains "$OUT_CODEX" ".codex/skills/opc" "default install reports Codex path"

set +e
OUT_CODEX_HOOK=$(HOME="$HOME_CODEX" "$NODE_BIN" "$REPO_ROOT/bin/opc.mjs" install-hooks 2>&1)
STATUS_CODEX_HOOK=$?
set -e
if [ "$STATUS_CODEX_HOOK" -eq 2 ]; then ok "Codex install refuses Claude-only hooks"; else fail "Codex install-hooks should exit 2"; fi
assert_contains "$OUT_CODEX_HOOK" "Claude Code compatibility" "Codex hook refusal is explicit"

print_results
