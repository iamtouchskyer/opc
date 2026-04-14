#!/usr/bin/env bash
# test-gaps4.sh — Final branch coverage: file-lock, lock-not-acquired paths,
#                  contextSchema edge branches, and remaining defensive gaps
set -euo pipefail

source "$(dirname "$0")/test-helpers.sh"

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qE "$needle"; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected pattern '$needle'"; FAIL=$((FAIL+1))
    echo "     GOT: $(echo "$haystack" | head -3)"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qE "$needle"; then
    echo "  ❌ $label — did NOT expect '$needle'"; FAIL=$((FAIL+1))
  else
    echo "  ✅ $label"; PASS=$((PASS+1))
  fi
}

assert_field_eq() {
  local json="$1" field="$2" expected="$3" label="$4"
  local actual
  actual=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d${field})" 2>/dev/null || echo "__PARSE_ERROR__")
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected $field=$expected, got '$actual'"; FAIL=$((FAIL+1))
  fi
}

assert_exit_nonzero() {
  local label="$1"; shift
  if "$@" > /dev/null 2>&1; then
    echo "  ❌ $label — expected nonzero exit"; FAIL=$((FAIL+1))
  else
    echo "  ✅ $label"; PASS=$((PASS+1))
  fi
}

mkdir -p "$HOME/.claude/flows"

# ═══════════════════════════════════════════════════════════════════
echo "=== PART 1: file-lock.mjs branches ==="
# ═══════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 1.1: Corrupt lock file (not valid JSON) → treat as stale, acquire anyway"
# file-lock.mjs L41-44: JSON.parse fails → catch → unlinkSync → fall through
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
# Write a corrupt .lock file
echo "NOT-VALID-JSON{{{" > flow-state.json.lock
# Skip should succeed (corrupt lock treated as stale)
OUT=$($HARNESS skip --dir . 2>/dev/null)
assert_field_eq "$OUT" "['skipped']" "review" "1.1a: skip succeeds despite corrupt lock"
# Lock file should be cleaned up
if [ ! -f flow-state.json.lock ]; then
  echo "  ✅ 1.1b: corrupt lock cleaned up"; PASS=$((PASS+1))
else
  echo "  ❌ 1.1b: corrupt lock should have been cleaned up"; FAIL=$((FAIL+1))
fi
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 1.2: Lock held by OUR OWN process → timeout → acquired:false"
# file-lock.mjs L55-56: Date.now() >= deadline → return { acquired: false }
# PID 1 (launchd) returns EPERM from kill(1,0) → isPidAlive=false → stale.
# We use $$ (current shell PID) which is definitely alive and same user.
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
# Create lock owned by our shell process (definitely alive, same user)
cat > flow-state.json.lock << EOF
{"pid": $$, "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "command": "fake-holder"}
EOF
OUT=$($HARNESS skip --dir . 2>/dev/null || true)
assert_contains "$OUT" "could not acquire lock" "1.2a: skip fails when lock held by live process"
rm -f flow-state.json.lock
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 1.3: Lock held by live process blocks stop too"
# flow-escape.mjs cmdStop L138-142: lock not acquired
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
cat > flow-state.json.lock << EOF
{"pid": $$, "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "command": "fake-holder"}
EOF
OUT=$($HARNESS stop --dir . 2>/dev/null || true)
assert_contains "$OUT" "could not acquire lock" "1.3a: stop fails when lock held"
rm -f flow-state.json.lock
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 1.4: Lock held by live process blocks goto"
# flow-escape.mjs cmdGoto L179-183: lock not acquired
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --dir . > /dev/null 2>&1
cat > flow-state.json.lock << EOF
{"pid": $$, "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "command": "fake-holder"}
EOF
OUT=$($HARNESS goto code-review --dir . 2>/dev/null || true)
assert_contains "$OUT" "could not acquire lock" "1.4a: goto fails when lock held"
rm -f flow-state.json.lock
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 1.5: Lock held by live process blocks transition"
# flow-transition.mjs cmdTransition L45-47: lock not acquired
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
mkdir -p nodes/review
cat > nodes/review/handshake.json << 'HS'
{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[]}
HS
cat > flow-state.json.lock << EOF
{"pid": $$, "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "command": "fake-holder"}
EOF
OUT=$($HARNESS transition --from review --to gate --verdict PASS --flow review --dir . 2>/dev/null || true)
assert_contains "$OUT" "could not acquire lock" "1.5a: transition fails when lock held"
rm -f flow-state.json.lock
rm -rf "$D"
cd /tmp

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 2: contextSchema load-time validation edge branches ==="
# ═══════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.1: contextSchema is an array (not object) → skip flow"
# flow-templates.mjs L163-166: contextSchema must be an object
cat > "$HOME/.claude/flows/test-cs-isarray.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "contextSchema": [{"a": {"required": ["foo"]}}]
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-isarray --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.1a: contextSchema as array → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.2: contextSchema.rules is an array (not object) → skip flow"
# flow-templates.mjs L183-187: rules must be an object
cat > "$HOME/.claude/flows/test-cs-rules-array.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "contextSchema": {
    "a": {"rules": ["non-empty-string"]}
  }
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-rules-array --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.2a: rules as array → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.3: contextSchema nodeTypes key not in nodes → skip flow"
# flow-templates.mjs L149-153: nodeTypes key not in nodes array
cat > "$HOME/.claude/flows/test-cs-nt-bad-key.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate", "nonexistent": "review"}
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-nt-bad-key --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.3a: nodeTypes key not in nodes → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.4: nodeTypes with invalid type value → skip flow"
# flow-templates.mjs L154-158: invalid nodeType value
cat > "$HOME/.claude/flows/test-cs-nt-bad-type.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "invalid-type"}
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-nt-bad-type --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.4a: invalid nodeType value → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.5: edge source not in nodes → skip flow"
# flow-templates.mjs L131-134: edge source not in nodes
cat > "$HOME/.claude/flows/test-cs-edge-badsrc.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}, "nonexistent": {"PASS": "a"}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5}
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-edge-badsrc --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.5a: edge source not in nodes → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.6: edge target not in nodes → skip flow"
# flow-templates.mjs L137-141: edge target not in nodes
cat > "$HOME/.claude/flows/test-cs-edge-badtgt.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "nonexistent"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5}
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-edge-badtgt --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.6a: edge target not in nodes → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.7: opc_compat version too high → skip flow"
# flow-templates.mjs L202-205: version constraint not met
cat > "$HOME/.claude/flows/test-cs-compat-high.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "opc_compat": ">=99.99"
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-compat-high --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.7a: opc_compat too high → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.8: malformed JSON in external flow file → skip"
# flow-templates.mjs L207-209: JSON parse error
cat > "$HOME/.claude/flows/test-cs-malformed.json" << 'EOF'
THIS IS NOT JSON AT ALL!!!!
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-malformed --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.8a: malformed JSON → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.9: missing required fields (no nodes array) → skip"
# flow-templates.mjs L124-127: missing nodes/edges/limits
cat > "$HOME/.claude/flows/test-cs-noflds.json" << 'EOF'
{
  "edges": {"a": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3}
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-noflds --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.9a: missing nodes → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.10: empty nodes array → skip"
# flow-templates.mjs L124: nodes.length === 0
cat > "$HOME/.claude/flows/test-cs-emptynodes.json" << 'EOF'
{
  "nodes": [],
  "edges": {},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5}
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow test-cs-emptynodes --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.10a: empty nodes → flow rejected"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 2.11: prototype pollution guard (__proto__ name)"
# flow-templates.mjs L120: skip __proto__
cat > "$HOME/.claude/flows/__proto__.json" << 'EOF'
{
  "nodes": ["a"],
  "edges": {"a": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5}
}
EOF
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS init --flow __proto__ --dir . 2>/dev/null || true)
assert_contains "$OUT" "unknown flow template" "2.11a: __proto__ name → flow rejected"
rm -f "$HOME/.claude/flows/__proto__.json"
rm -rf "$D"
cd /tmp

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 3: flow-core.mjs remaining edge branches ==="
# ═══════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.1: validate-context with unknown rule in RULE_VALIDATORS"
# flow-core.mjs L289-292: unknown rule name
D=$(mktemp -d)
cd "$D"
# Create a flow with contextSchema that passes load-time validation
# but has a field with a rule that is valid at load time.
# We test validate-context with a manually crafted context.
cat > "$HOME/.claude/flows/test-vc-goodrule.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "nodeTypes": {"a": "build", "b": "gate"},
  "contextSchema": {
    "a": {
      "required": ["name"],
      "rules": {"name": "non-empty-string", "count": "positive-integer"}
    }
  }
}
EOF
$HARNESS init --flow test-vc-goodrule --dir . > /dev/null 2>&1
# Write context with count=0 (fails positive-integer rule)
echo '{"name":"valid","count":0}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-goodrule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "3.1a: count=0 fails positive-integer rule"
assert_contains "$OUT" "positive-integer" "3.1b: error mentions rule name"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.2: validate-context with missing required field"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow test-vc-goodrule --dir . > /dev/null 2>&1
echo '{"count":5}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-goodrule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "3.2a: missing 'name' field fails validation"
assert_contains "$OUT" "missing required" "3.2b: error mentions missing required"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.3: validate-context with non-empty-object rule failure"
D=$(mktemp -d)
cd "$D"
cat > "$HOME/.claude/flows/test-vc-objrule.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "contextSchema": {
    "a": {
      "rules": {"config": "non-empty-object"}
    }
  }
}
EOF
$HARNESS init --flow test-vc-objrule --dir . > /dev/null 2>&1
echo '{"config":{}}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-objrule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "3.3a: empty object fails non-empty-object rule"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.4: validate-context with non-empty-array rule failure"
D=$(mktemp -d)
cd "$D"
cat > "$HOME/.claude/flows/test-vc-arrrule.json" << 'EOF'
{
  "nodes": ["a","b"],
  "edges": {"a": {"PASS": "b"}, "b": {"PASS": null}},
  "limits": {"maxLoopsPerEdge": 3, "maxTotalSteps": 10, "maxNodeReentry": 5},
  "contextSchema": {
    "a": {
      "rules": {"items": "non-empty-array"}
    }
  }
}
EOF
$HARNESS init --flow test-vc-arrrule --dir . > /dev/null 2>&1
echo '{"items":[]}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-arrrule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "3.4a: empty array fails non-empty-array rule"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.5: validate-context — no contextSchema for requested node (happy path)"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow test-vc-goodrule --dir . > /dev/null 2>&1
echo '{}' > flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-goodrule --node b --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "True" "3.5a: no schema for node b → valid"
assert_contains "$OUT" "no contextSchema" "3.5b: note mentions no contextSchema for node"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.6: validate-context — corrupt flow-context.json"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow test-vc-goodrule --dir . > /dev/null 2>&1
echo 'NOT-JSON' > flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-goodrule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "3.6a: corrupt context JSON fails validation"
assert_contains "$OUT" "cannot parse" "3.6b: error mentions parse failure"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 3.7: validate-context — no flow-context.json file"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow test-vc-goodrule --dir . > /dev/null 2>&1
# Don't create flow-context.json
OUT=$($HARNESS validate-context --flow test-vc-goodrule --node a --dir . 2>/dev/null)
assert_field_eq "$OUT" "['valid']" "False" "3.7a: missing context file fails validation"
assert_contains "$OUT" "flow-context.json not found" "3.7b: error mentions missing file"
rm -rf "$D"
cd /tmp

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 4: eval-parser.mjs + eval-commands.mjs edge branches ==="
# ═══════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 4.1: parseEvaluation — finding with fix arrow line containing hedging"
# eval-parser.mjs L84-89: fix line with hedging
D=$(mktemp -d)
cat > "$D/eval-hedge-fix.md" << 'EVAL'
🔴 critical — api.js:10 — Missing auth check
→ You might consider adding authentication here
Reasoning: This could potentially be a security issue
VERDICT: FAIL FINDINGS[1]
EVAL
OUT=$($HARNESS verify "$D/eval-hedge-fix.md" 2>/dev/null)
# Both fix line ("might consider") and reasoning line ("could potentially") have hedging
HEDGING_COUNT=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['hedging_detected']))" 2>/dev/null || echo "0")
if [ "$HEDGING_COUNT" -ge 2 ]; then
  echo "  ✅ 4.1a: hedging detected in fix AND reasoning line ($HEDGING_COUNT items)"; PASS=$((PASS+1))
else
  echo "  ❌ 4.1a: expected ≥2 hedging items, got $HEDGING_COUNT"; FAIL=$((FAIL+1))
fi
rm -rf "$D"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 4.2: parseEvaluation — reasoning line with hedging"
# eval-parser.mjs L93-98: reasoning line with hedging
D=$(mktemp -d)
cat > "$D/eval-hedge-reason.md" << 'EVAL'
🟡 warning — api.js:20 — Slow query
→ Add index
Reasoning: This could potentially cause performance issues
VERDICT: ITERATE FINDINGS[1]
EVAL
OUT=$($HARNESS verify "$D/eval-hedge-reason.md" 2>/dev/null)
assert_contains "$OUT" "could potentially" "4.2a: hedging detected in reasoning line"
rm -rf "$D"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 4.3: parseEvaluation — CRLF line endings handled"
# eval-parser.mjs L17: replace \r\n with \n
D=$(mktemp -d)
printf "🔴 critical — api.js:10 — Bug\r\n→ Fix it\r\nVERDICT: FAIL FINDINGS[1]\r\n" > "$D/eval-crlf.md"
OUT=$($HARNESS verify "$D/eval-crlf.md" 2>/dev/null)
assert_field_eq "$OUT" "['critical']" "1" "4.3a: CRLF eval parsed correctly"
assert_field_eq "$OUT" "['verdict_present']" "True" "4.3b: verdict found despite CRLF"
rm -rf "$D"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 4.4: synthesize — run flag selects specific run directory"
# eval-commands.mjs L85-86: --run flag
# Evals must be fat (≥50 lines) to clear compound defense thin-eval layer.
D=$(mktemp -d)
mkdir -p "$D/nodes/code-review/run_1"
mkdir -p "$D/nodes/code-review/run_2"
# Generate fat evals programmatically to avoid heredoc bloat
python3 -c "
header = '# Code Review\n\n## Scope\nThe review covered the entire module with focus on correctness and reliability.\n\n## Methodology\n'
body = '\n'.join(['Walked through step {} of the data flow and verified the expected behavior.'.format(i) for i in range(1, 40)])
footer = '\n\n## Findings\n🔴 critical — old.js:1 — old finding from run_1\n→ Fix the issue immediately\nReasoning: This is a regression from the previous version and blocks release.\n\n## Conclusion\nOne critical issue found.\n\nVERDICT: FAIL FINDINGS[1]\n'
open('$D/nodes/code-review/run_1/eval-old.md', 'w').write(header + body + footer)
"
python3 -c "
header = '# Code Review\n\n## Scope\nThe review examined the fix applied in the second run of this unit.\n\n## Methodology\n'
body = '\n'.join(['Validated that layer {} now behaves correctly after the fix.'.format(i) for i in range(1, 40)])
footer = '\n\n## Findings\n🔵 suggestion — new.js:2 — minor style thing\n→ Use a more descriptive variable name here\nReasoning: The name does not communicate intent to readers unfamiliar with the module.\n\n🔵 suggestion — new.js:8 — add a brief comment above the helper function\n→ Document the pre-condition the caller must uphold\nReasoning: The function assumes sorted input but this is not obvious from the signature.\n\n## Conclusion\nTwo minor style suggestions remain.\n\nVERDICT: PASS FINDINGS[2]\n'
open('$D/nodes/code-review/run_2/eval-new.md', 'w').write(header + body + footer)
"
OUT=$($HARNESS synthesize "$D" --node code-review --run 2 2>/dev/null)
assert_field_eq "$OUT" "['verdict']" "PASS" "4.4a: --run 2 uses run_2 (PASS verdict)"
# Verify run_1 would give FAIL
OUT=$($HARNESS synthesize "$D" --node code-review --run 1 2>/dev/null)
assert_field_eq "$OUT" "['verdict']" "FAIL" "4.4b: --run 1 uses run_1 (FAIL verdict)"
rm -rf "$D"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 4.5: verify — file not found (ENOENT) exits nonzero"
# eval-commands.mjs L20-21: ENOENT branch
assert_exit_nonzero "4.5a: verify nonexistent file" $HARNESS verify /tmp/nonexistent-eval-file.md

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 4.6: synthesize — eval.md (no role prefix) → roleName 'evaluator'"
# eval-commands.mjs L157-158: f.name === "eval.md" → "evaluator"
D=$(mktemp -d)
mkdir -p "$D/nodes/review/run_1"
cat > "$D/nodes/review/run_1/eval.md" << 'EVAL'
🟡 warning — slow query
VERDICT: ITERATE FINDINGS[1]
EVAL
OUT=$($HARNESS synthesize "$D" --node review 2>/dev/null)
assert_field_eq "$OUT" "['roles'][0]['role']" "evaluator" "4.6a: eval.md maps to role 'evaluator'"
rm -rf "$D"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 5: viz-commands.mjs branches ==="
# ═══════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 5.1: getMarker — entryNode visited but not current → ✅"
# viz-commands.mjs L13: entryNode !== currentNode → ✅
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow review --dir . > /dev/null 2>&1
# Review node needs ≥2 distinct eval artifacts for transition to succeed.
mkdir -p nodes/review/run_1
cat > nodes/review/run_1/eval-a.md << 'EVAL'
# Reviewer A
Checked the implementation for correctness and style.
No blocking issues found in this pass.
EVAL
cat > nodes/review/run_1/eval-b.md << 'EVAL'
# Reviewer B
Traced the data flow through the core module.
Identified no regressions relative to the prior version.
EVAL
cat > nodes/review/handshake.json << 'HS'
{"nodeId":"review","nodeType":"review","runId":"run_1","status":"completed","summary":"ok","timestamp":"2024-01-01T00:00:00Z","artifacts":[{"type":"eval","path":"run_1/eval-a.md"},{"type":"eval","path":"run_1/eval-b.md"}]}
HS
$HARNESS transition --from review --to gate --verdict PASS --flow review --dir . > /dev/null 2>&1
OUT=$($HARNESS viz --flow review --dir . 2>/dev/null)
assert_contains "$OUT" "✅ review" "5.1a: visited entry node shows ✅"
assert_contains "$OUT" "▶ gate" "5.1b: current node shows ▶"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 5.2: viz --json outputs JSON with nodes and loopbacks arrays"
D=$(mktemp -d)
cd "$D"
$HARNESS init --flow build-verify --dir . > /dev/null 2>&1
OUT=$($HARNESS viz --flow build-verify --dir . --json 2>/dev/null)
assert_field_eq "$OUT" "['nodes'][0]['id']" "build" "5.2a: JSON output has first node"
assert_contains "$OUT" "loopbacks" "5.2b: JSON output has loopbacks array"
rm -rf "$D"
cd /tmp

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "=== PART 6: flow-transition.mjs — finalize edge branches ==="
# ═══════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 6.1: finalize — no flow-state.json"
D=$(mktemp -d)
cd "$D"
OUT=$($HARNESS finalize --dir . 2>/dev/null || true)
assert_field_eq "$OUT" "['finalized']" "False" "6.1a: finalize with no state file"
assert_contains "$OUT" "not found" "6.1b: error mentions not found"
rm -rf "$D"
cd /tmp

# ─────────────────────────────────────────────────────────────────
echo ""
echo "── 6.2: finalize — unknown flow template in state"
D=$(mktemp -d)
cd "$D"
mkdir -p nodes
cat > flow-state.json << 'EOF'
{"version":"1.0","flowTemplate":"nonexistent-flow","currentNode":"a","entryNode":"a","totalSteps":0,"history":[],"edgeCounts":{},"_written_by":"opc-harness","_last_modified":"2024-01-01T00:00:00Z","_write_nonce":"abc123"}
EOF
OUT=$($HARNESS finalize --dir . 2>/dev/null || true)
assert_field_eq "$OUT" "['finalized']" "False" "6.2a: finalize with unknown flow"
assert_contains "$OUT" "unknown flow" "6.2b: error mentions unknown flow"
rm -rf "$D"
cd /tmp

# ═══════════════════════════════════════════════════════════════════
# Cleanup test flows
# ═══════════════════════════════════════════════════════════════════
rm -f "$HOME/.claude/flows/test-cs-isarray.json"
rm -f "$HOME/.claude/flows/test-cs-rules-array.json"
rm -f "$HOME/.claude/flows/test-cs-nt-bad-key.json"
rm -f "$HOME/.claude/flows/test-cs-nt-bad-type.json"
rm -f "$HOME/.claude/flows/test-cs-edge-badsrc.json"
rm -f "$HOME/.claude/flows/test-cs-edge-badtgt.json"
rm -f "$HOME/.claude/flows/test-cs-compat-high.json"
rm -f "$HOME/.claude/flows/test-cs-malformed.json"
rm -f "$HOME/.claude/flows/test-cs-noflds.json"
rm -f "$HOME/.claude/flows/test-cs-emptynodes.json"
rm -f "$HOME/.claude/flows/__proto__.json"
rm -f "$HOME/.claude/flows/test-vc-goodrule.json"
rm -f "$HOME/.claude/flows/test-vc-objrule.json"
rm -f "$HOME/.claude/flows/test-vc-arrrule.json"

print_results
