#!/bin/bash
# Shared test helpers for opc-harness test suite
# Source this file at the top of each test script:
#   source "$(dirname "$0")/test-helpers.sh"

# ── Repo-relative harness path (portable, no hardcoded install path) ──
OPC_HARNESS_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/opc-harness.mjs"
opc_harness() {
  node "$OPC_HARNESS_BIN" "$@"
}
HARNESS=opc_harness

# ── Counters ──
PASS=0
FAIL=0

# ── Temp directory with cleanup ──
setup_tmpdir() {
  TMPDIR=$(mktemp -d)
  if [ -n "${OPC_TEST_HOME_OVERRIDE:-}" ]; then
    export HOME="$OPC_TEST_HOME_OVERRIDE"
  else
    export HOME="$TMPDIR/home"
  fi
  mkdir -p "$HOME"
  if [ -n "${OPC_TEST_HOME_PROBE:-}" ]; then
    printf '%s\n' "$HOME" > "$OPC_TEST_HOME_PROBE"
  fi
  trap 'rm -rf "$TMPDIR"' EXIT
  trap 'exit 130' HUP INT TERM
  cd "$TMPDIR"
}

# ── Git repo init (many tests need this) ──
setup_git() {
  git init -q .
  git config user.email "test@test.com"
  git config user.name "Test"
  echo "init" > dummy.txt
  git add dummy.txt && git commit -q -m "init"
}

# ── Print results and exit with appropriate code ──
print_results() {
  echo ""
  echo "==========================================="
  echo "  Results: $PASS passed, $FAIL failed"
  echo "==========================================="
  [ "$FAIL" -eq 0 ] || exit 1
}

# ── Write a golden brief that passes brief-lint to a given path ──
write_golden_brief() {
  local target="$1"
  cat > "$target" << 'BRIEF'
## File Plan
- index.html — main entry, ~200 lines
- styles.css — all styles, ~150 lines

## Technology Decisions
- Chart.js v4.4.0 via https://cdn.jsdelivr.net/npm/chart.js@4.4.0
- Tailwind CSS v3.4.1 via CDN

## Design Tokens (resolved)
- Primary: #0EA5E9
- Background: #FFFFFF
- Text: #1E293B

## Component Inventory
- Dashboard: 4 cards showing KPI (¥126,560 revenue, 8,846 visits)
- Chart: line chart with 12 monthly data points

## Constraints
- Contrast: 4.5:1 body, 3:1 large text
- Responsive: 992px, 768px, 375px breakpoints
- Animation: 200ms ease-out transitions
BRIEF
}

write_complete_test_plan() {
  local target="$1"
  cat > "$target" << 'PLAN'
# Test Plan

## Unit smoke
Run npm test for unit coverage.
Cover module smoke behavior.
Assert basic render success.

## Contract edge case
Validate schema boundaries.
Cover invalid input.
Assert error code stability.

## Integration e2e flow
Run playwright test through the workflow.
Cover multi-step happy path.
Assert persisted state.

## UI visual accessibility
Capture screenshot at desktop and mobile viewport.
Check responsive layout.
Run a11y smoke checks.

## Tier baseline polish
Check typography hierarchy.
Check navigation affordance.
Check dark mode baseline.
PLAN
}

sync_run_handshakes() {
  local dir="$1"
  python3 - "$dir" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
nodes = root / "nodes"
if not nodes.exists():
    raise SystemExit(0)

for canonical in nodes.glob("*/handshake.json"):
    try:
        data = json.loads(canonical.read_text())
    except Exception:
        continue
    run_id = data.get("runId")
    if not isinstance(run_id, str) or not run_id.startswith("run_"):
        continue
    run_data = dict(data)
    run_dir = canonical.parent / run_id
    artifacts = []
    for artifact in data.get("artifacts") or []:
        if not isinstance(artifact, dict):
            artifacts.append(artifact)
            continue
        copied = dict(artifact)
        path = copied.get("path")
        prefix = f"{run_id}/"
        if isinstance(path, str) and path.startswith(prefix):
            copied["path"] = path[len(prefix):]
        elif isinstance(path, str) and not pathlib.Path(path).is_absolute():
            node_relative = canonical.parent / path
            run_relative = run_dir / path
            if node_relative.exists() and not run_relative.exists():
                copied["path"] = f"../{path}"
        artifacts.append(copied)
    run_data["artifacts"] = artifacts
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "handshake.json").write_text(json.dumps(run_data, indent=2) + "\n")
PY
}
