#!/bin/bash
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git

json_field() {
  echo "$1" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$2'))"
}

assert_route_next() {
  local desc="$1" flow="$2" node="$3" verdict="$4" expected="$5"
  local out next valid
  out=$($HARNESS route --node "$node" --verdict "$verdict" --flow "$flow" 2>/dev/null)
  next=$(json_field "$out" "next")
  valid=$(json_field "$out" "valid")
  if [ "$valid" = "True" ] && [ "$next" = "$expected" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — valid=$valid next=$next output=$out"
    FAIL=$((FAIL + 1))
  fi
}

write_review_handshake() {
  local dir="$1" verdict="$2"
  mkdir -p "$dir/nodes/code-review/run_1"
  cat > "$dir/nodes/code-review/handshake.json" <<EOF
{"nodeId":"code-review","nodeType":"review","runId":"run_1","status":"completed","verdict":"$verdict","summary":"review found work for producer","timestamp":"2026-01-01T00:00:00.000Z","artifacts":[{"type":"eval","path":"run_1/eval-a.md"},{"type":"eval","path":"run_1/eval-b.md"}]}
EOF
  sync_run_handshakes "$dir"
  echo "# Eval A" > "$dir/nodes/code-review/run_1/eval-a.md"
  echo "# Eval B" > "$dir/nodes/code-review/run_1/eval-b.md"
}

assert_transition_back_to_build() {
  local desc="$1" dir="$2" verdict="$3"
  local out allowed node
  $HARNESS init --flow build-verify --entry code-review --dir "$dir" 2>/dev/null >/dev/null
  write_review_handshake "$dir" "$verdict"
  out=$($HARNESS transition --from code-review --to build --verdict "$verdict" --flow build-verify --dir "$dir" 2>/dev/null)
  allowed=$(json_field "$out" "allowed")
  node=$(python3 -c "import json; print(json.load(open('$dir/flow-state.json'))['currentNode'])")
  if [ "$allowed" = "True" ] && [ "$node" = "build" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — allowed=$allowed currentNode=$node output=$out"
    FAIL=$((FAIL + 1))
  fi
}

echo "Test: Review failure routes"
echo "================================================"
echo ""

echo "1. code-review negative verdicts route to build"
assert_route_next "build-verify code-review PASS unchanged" build-verify code-review PASS test-design
assert_route_next "build-verify code-review FAIL → build" build-verify code-review FAIL build
assert_route_next "build-verify code-review ITERATE → build" build-verify code-review ITERATE build
assert_route_next "full-stack code-review FAIL → build" full-stack code-review FAIL build
assert_route_next "full-stack code-review ITERATE → build" full-stack code-review ITERATE build

echo ""
echo "2. quick review negative verdicts route to build"
assert_route_next "quick review FAIL → build" quick review FAIL build
assert_route_next "quick review ITERATE → build" quick review ITERATE build

echo ""
echo "3. transition accepts code-review negative routes"
assert_transition_back_to_build "code-review FAIL transition returns to build" .harness-fail FAIL
assert_transition_back_to_build "code-review ITERATE transition returns to build" .harness-iterate ITERATE

print_results
