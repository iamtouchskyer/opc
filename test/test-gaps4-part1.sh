#!/usr/bin/env bash
# test-gaps4 — split part
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

rm -f "$HOME/.claude/flows/test-cs-isarray.json"
rm -f "$HOME/.claude/flows/test-cs-rules-array.json"
rm -f "$HOME/.claude/flows/test-cs-nt-bad-key.json"
rm -f "$HOME/.claude/flows/test-cs-nt-bad-type.json"
rm -f "$HOME/.claude/flows/test-cs-edge-badsrc.json"
rm -f "$HOME/.claude/flows/test-cs-edge-badtgt.json"

print_results
