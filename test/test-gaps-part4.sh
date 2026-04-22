#!/bin/bash
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

print_results
