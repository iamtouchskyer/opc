#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$REPO_DIR/bin/opc-harness.mjs"
PASS=0
FAIL=0

ok() { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

DIR="$REPO_DIR/.tmp-extension-version-state-$$"
EXT_DIR="$DIR/exts"
rm -rf "$DIR"
trap 'rm -rf "$DIR"' EXIT
mkdir -p "$EXT_DIR/versioned-ext"

cat > "$EXT_DIR/versioned-ext/ext.json" <<'JSON'
{
  "name": "versioned-ext",
  "version": "4.5.6",
  "meta": {
    "provides": ["design-system-injection@1"]
  }
}
JSON

cat > "$EXT_DIR/versioned-ext/hook.mjs" <<'JS'
export const meta = { provides: ["design-system-injection@1"] };
JS

(
  cd "$REPO_DIR"
  OPC_EXTENSIONS_DIR="$EXT_DIR" "$HARNESS" init --flow build-verify --entry brief --dir "$DIR/.harness" >/dev/null
)

VERSION=$(python3 - "$DIR/.harness/flow-state.json" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
versions = {e["name"]: e["version"] for e in state.get("extensionVersions", [])}
print(versions.get("versioned-ext", "missing"))
PY
)

if [ "$VERSION" = "4.5.6" ]; then
  ok "init records ext.json version in flow-state"
else
  bad "expected 4.5.6, got $VERSION"
fi

echo ""
echo "Extension version state tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
