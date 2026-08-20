#!/bin/bash
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

ok() {
  echo "  PASS $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL $1"
  FAIL=$((FAIL + 1))
}

expect_abort() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    fail "$name did not abort"
  else
    ok "$name aborted"
  fi
}

expect_finishes_with_open_stdin() {
  local name="$1"
  shift
  local fifo="$TMP/stdin-fifo-$$"
  mkfifo "$fifo"
  node -e 'const fs=require("fs"); fs.openSync(process.argv[1],"w"); setTimeout(()=>{},90000)' "$fifo" &
  local writer=$!
  "$@" < "$fifo" >/dev/null 2>&1 &
  local pid=$!
  child_done() {
    local stat
    stat=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    [ -z "$stat" ] || [[ "$stat" == Z* ]]
  }
  local deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if child_done; then
      wait "$pid"
      kill "$writer" 2>/dev/null || true
      wait "$writer" 2>/dev/null || true
      rm -f "$fifo"
      ok "$name"
      return
    fi
    sleep 1
  done
  if child_done; then
    wait "$pid"
    kill "$writer" 2>/dev/null || true
    wait "$writer" 2>/dev/null || true
    rm -f "$fifo"
    ok "$name"
    return
  fi
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  sleep 1
  kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  kill "$writer" 2>/dev/null || true
  wait "$writer" 2>/dev/null || true
  rm -f "$fifo"
  fail "$name hung with open stdin"
}

echo "=== Shell cleanup fault contracts ==="

HARNESS_NAME=".harness-bypass-chain-cleanup-$$"
expect_abort "bypass-chain fault injection" \
  env OPC_TEST_HARNESS_NAME="$HARNESS_NAME" OPC_TEST_ABORT_AFTER_HARNESS_INIT=1 \
  bash "$ROOT/test/test-bypass-chain.sh"
if [ ! -e "$ROOT/$HARNESS_NAME" ]; then
  ok "bypass-chain removes repo-local harness"
else
  fail "bypass-chain left repo-local harness"
  rm -rf "$ROOT/$HARNESS_NAME"
fi

FLOW_HOME="$TMP/flow-home"
FLOW_HOME_PROBE="$TMP/flow-home-probe"
mkdir -p "$FLOW_HOME/.claude/flows"
printf '%s\n' 'user idea-factory sentinel' > "$FLOW_HOME/.claude/flows/idea-factory.json"
expect_abort "flow-part3 fault injection" \
  env OPC_TEST_HOME_OVERRIDE="$FLOW_HOME" OPC_TEST_HOME_PROBE="$FLOW_HOME_PROBE" \
  OPC_TEST_ABORT_AFTER_FLOW_FIXTURE=1 bash "$ROOT/test/test-flow-part3.sh"
if [ "$(cat "$FLOW_HOME_PROBE" 2>/dev/null)" = "$FLOW_HOME" ]; then
  ok "flow-part3 used the injected fixture HOME"
else
  fail "flow-part3 did not use the injected fixture HOME"
fi
if [ "$(cat "$FLOW_HOME/.claude/flows/idea-factory.json" 2>/dev/null)" = "user idea-factory sentinel" ]; then
  ok "flow-part3 restores pre-existing flow fixture"
else
  fail "flow-part3 overwrote pre-existing flow fixture"
fi

COVERAGE_HOME="$TMP/coverage-home"
COVERAGE_HOME_PROBE="$TMP/coverage-home-probe"
mkdir -p "$COVERAGE_HOME/.claude/flows"
printf '%s\n' 'user coverage idea sentinel' > "$COVERAGE_HOME/.claude/flows/idea-factory.json"
printf '%s\n' 'user context sentinel' > "$COVERAGE_HOME/.claude/flows/test-ctx-flow.json"
expect_abort "coverage-part1 fault injection" \
  env OPC_TEST_HOME_OVERRIDE="$COVERAGE_HOME" OPC_TEST_HOME_PROBE="$COVERAGE_HOME_PROBE" \
  OPC_TEST_ABORT_AFTER_CONTEXT_FIXTURE=1 bash "$ROOT/test/test-coverage-part1.sh"
if [ "$(cat "$COVERAGE_HOME_PROBE" 2>/dev/null)" = "$COVERAGE_HOME" ]; then
  ok "coverage-part1 used the injected fixture HOME"
else
  fail "coverage-part1 did not use the injected fixture HOME"
fi
if [ "$(cat "$COVERAGE_HOME/.claude/flows/idea-factory.json" 2>/dev/null)" = "user coverage idea sentinel" ]; then
  ok "coverage-part1 restores idea-factory fixture"
else
  fail "coverage-part1 overwrote idea-factory fixture"
fi
if [ "$(cat "$COVERAGE_HOME/.claude/flows/test-ctx-flow.json" 2>/dev/null)" = "user context sentinel" ]; then
  ok "coverage-part1 restores context fixture"
else
  fail "coverage-part1 overwrote context fixture"
fi

expect_finishes_with_open_stdin "gaps-part1 does not hang when stdin stays open" \
  bash "$ROOT/test/test-gaps-part1.sh"
if grep -q 'bash "$f" < /dev/null' "$ROOT/test/run-all.sh"; then
  ok "run-all closes child stdin"
else
  fail "run-all does not close child stdin"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
