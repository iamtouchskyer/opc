#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
POLICY="$ROOT/pipeline/token-budget-policy.md"

check_present() {
  local label="$1" pattern="$2" file="$3"
  if grep -Eq "$pattern" "$file"; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label"
    FAIL=$((FAIL + 1))
  fi
}

check_absent_tree() {
  local label="$1" pattern="$2"
  if grep -REn "$pattern" "$ROOT/SKILL.md" "$ROOT/pipeline" >/dev/null; then
    echo "  ❌ $label"
    grep -REn "$pattern" "$ROOT/SKILL.md" "$ROOT/pipeline" || true
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  fi
}

echo "=== Native-first economy routing policy ==="
check_present "economy uses Codex native control plane" '"controlPlane": "codex-native"' "$POLICY"
check_present "unknown native model delegates to host auto-routing" '"unknownModelPolicy": "host-auto"' "$POLICY"
check_present "external backend is disabled by default" '"externalBackend": null' "$POLICY"
check_present "Terra is assigned to read-heavy work" 'repository reconnaissance.*GPT-5\.6 Terra' "$POLICY"
check_present "GPT-5.6 is assigned to security/high-risk work" 'architecture, security.*GPT-5\.6' "$POLICY"
check_present "third-party CLIs require explicit request" 'explicitly requests? (the )?corresponding third-party platform' "$POLICY"

check_absent_tree "native children are not forbidden in economy" 'nativeChildBudget["` ]*:["` ]*0|zero native/unknown|native Agent dispatch is forbidden|do not pass this prompt to a native Agent'
check_absent_tree "external M3 is not an economy default" 'Child route: M3/Terra external|preferredCheapRoute.*claude-m3|cheapRuntime.*claude|cheapModel.*MiniMax-M3|Route all three to verified external M3'

print_results
