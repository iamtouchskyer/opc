# Executor Protocol

You are an executor agent. Your job is to **actually run and use the product**, not review code.

**Important:** Executor nodes are executed by the orchestrator directly (not as a subagent), because executors need access to Skill tools and full system capabilities.

## Capability Matrix

| Capability | Tool | Evidence |
|-----------|------|----------|
| CLI verification | Bash tool | stdout/stderr capture |
| GUI verification | Bash + Playwright script | Screenshots (.png) |
| API verification | Bash (curl/httpie) | Response body + status code |
| Non-web app | CLI only | Skip GUI, annotate `cli-only` |
| Mobile app verification | Bash (adb/xcrun) + Appium/Detox | Screenshots + device logs |
| Desktop app verification | Bash + Playwright (Electron) | Screenshots + process output |
| Cross-platform parity | Multiple tools per platform | Side-by-side comparison artifacts |

## Execution Flow

### Step 1 — Smoke Test

Verify tool availability before testing. Do not guess results.

**CLI:**
```bash
which node  # or relevant binary
```

**GUI (Playwright):**
```bash
python3 -c "from playwright.sync_api import sync_playwright; print('ok')"
```

- If a tool is unavailable → set `handshake.status = "blocked"` with reason `BLOCKED: {tool} unavailable`
- Do not skip silently. Do not fabricate results.

### Step 1b — Dev Server Lifecycle

When executing browser-based evidence capture, ensure a dev server is running:

1. **Check if already running**: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000` (or project-configured port from `package.json`, `.env`, `vite.config.*`, `next.config.*`)
2. **If not running**: Start it in background and wait for ready:
   ```bash
   npm run dev &
   DEV_PID=$!
   # Wait for ready (max 30s)
   for i in $(seq 1 30); do
     curl -s http://localhost:3000 > /dev/null 2>&1 && break
     sleep 1
   done
   ```
3. **After evidence capture**: Do NOT kill the server — leave it running for subsequent executor/review ticks in the same flow
4. **Port detection priority**: `PORT` in `.env` → `vite.config.*` server.port → `next.config.*` → default 3000

The implement tick that builds the app SHOULD leave the dev server running in background. The orchestrator SHOULD NOT kill background processes between ticks.

### Step 2 — Read Acceptance Criteria

Read from upstream handshake summary and `$SESSION_DIR/progress.md`. Each acceptance criterion becomes a test scenario.

If `flow-state.json` or `loop-state.json` contains `mission`, also read the pinned
`mission-contract.json`. Execute its `endToEndScenario` and map evidence to the
active `OUT-N`/`FLOOR-N` IDs. Do not infer global coverage from test names,
descriptions, or keyword overlap.

If Design Intelligence sidecars are present (`design-brief.md`,
`design-tokens.json`, `design-mode.json`), read them for expected visual and
interaction constraints. They are not execution evidence by themselves; you
still need runtime screenshots, CLI output, or test results from the built
product.

### Step 3 — Execute Scenarios

For each acceptance criterion:

1. **Construct** the concrete steps (commands to run, pages to visit, inputs to provide)
2. **Execute** using appropriate tool:
   - CLI: Run command via Bash, capture output
   - GUI: Write and execute a Playwright Python script:
     ```python
     from playwright.sync_api import sync_playwright
     with sync_playwright() as p:
         browser = p.chromium.launch(headless=True)
         page = browser.new_page()
         page.goto("http://localhost:PORT")
         page.wait_for_load_state("networkidle")
         page.screenshot(path="$SESSION_DIR/nodes/{NODE_ID}/run_{RUN}/screenshot-{N}.png", full_page=True)
         # ... interact and verify
         browser.close()
     ```
   - API: `curl -s http://localhost:PORT/endpoint | jq .`
3. **Capture evidence** — save to `$SESSION_DIR/nodes/{NODE_ID}/run_{RUN}/`:
   - CLI: `command-output-{N}.txt`
   - GUI: `screenshot-{N}.png`
   - API: `api-response-{N}.json`
4. **Judge** PASS or FAIL for this scenario

### Step 4 — Write Handshake

For a custom execute node, write the following shape. Its `evidence` block is an
audit declaration only: custom execute nodes (including `e2e-user` and
`post-launch-sim`) currently remain `scope: local` and cannot mint standard-flow
Mission criterion coverage. For built-in `test-execute` reached from
`test-design`/`hotfix`, do not replace the handshake that the harness already
minted; use `seal` only to merge discovered artifacts.

```json
{
  "nodeId": "{NODE_ID}",
  "nodeType": "execute",
  "runId": "run_{RUN}",
  "status": "completed",
  "verdict": "PASS|FAIL|ITERATE",
  "summary": "<what was tested, results, N/M scenarios passed>",
  "timestamp": "<ISO8601>",
  "artifacts": [
    { "type": "cli-output", "path": "run_{RUN}/command-output-1.txt" },
    { "type": "screenshot", "path": "run_{RUN}/screenshot-1.png" }
  ],
  "evidence": {
    "sliceId": "{NODE_ID}",
    "scenarioId": "SCENARIO-1",
    "validatorType": "e2e",
    "validator": "checkout-e2e",
    "satisfies": ["OUT-1", "OUT-2", "FLOOR-1"]
  },
  "findings": { "critical": 0, "warning": 1, "suggestion": 0 }
}
```

**Evidence requirement (enforced by code):** `nodeType=execute` handshakes must contain at least one artifact with type ∈ {test-result, screenshot, cli-output}. Missing evidence → `opc-harness validate` rejects the handshake.

The `evidence` object on a custom execute node records what was attempted but is
not authority for integrated Mission coverage. The only implemented
standard-flow minting path is built-in, harness-run `test-execute`, where the
harness copies the frozen plan tuple into its own handshake. A future custom
path must provide a comparable trusted harness execution record; caller-authored
fallback is never accepted. Mission-less handshakes and local-only execute nodes
keep the legacy shape.

For a Mission receipt, every declared evidence path must be relative to the
sealed latest `run_N` for that execute node. The harness rejects absolute paths,
older run directories, symlinks, non-regular files, and paths that escape the
current run after canonicalization. An integrated receipt also requires a
current-run JSON `test-result` with a machine-readable PASS; screenshots or
reviewer prose alone cannot mint integrated success.

When the flow template requires OPC-owned test execution, do not hand-author a
passing result. `test-design`/`hotfix` supplies `test-execution.json` with a
`testCommand`; the transition into `test-execute` runs that command through the
harness. The resulting handshake and `test-command-result.json` are bound to
the command hash, source test-plan hash, result hash, node/run identity, and the
OPC signed provenance ledger. Gate validation rejects an unsigned, edited,
stale-run, or mismatched result even when its public JSON says PASS.

For Mission coverage, the source `test-plan.md` must already contain exactly one
`scenario:`/`validator-type:`/`satisfies:` tuple. The harness hashes that plan
before execution and later derives the receipt mapping from those frozen lines,
not from executor-authored handshake fields. Any missing, duplicate, changed,
or post-result relabeling is rejected. The command must also prove a non-vacuous
PASS: either non-empty TAP with a positive executed-test count and zero
failures, or—on a loop verification command—a valid `OPC_ORACLE` record whose
non-empty checks all pass with `total > 0`. Exit code zero alone is not
integrated evidence.

The execute handshake is harness-owned. If artifact sealing runs afterward, it
merges discovered artifacts into the existing handshake while preserving the
test command, frozen-plan hash, result hash, node/run identity, and signed
ledger record. For built-in `test-execute`, the harness also auto-populates the
frozen scenario/validator/satisfies tuple. Do not overwrite or reconstruct those
provenance or mapping fields.

### Mission Evidence Receipts

On a PASS transition from the built-in, harness-run `test-execute` node, the
harness turns eligible handshake evidence into an `EV-N` receipt. Other
standard execute nodes remain local even when their declaration names
integration criteria. For autonomous loop verification units, provide the same
bindings to `complete-tick`:

```bash
opc-harness complete-tick \
  --unit F1.8 --artifacts "$EVIDENCE_PATH" \
  --scenario SCENARIO-1 --validator-type e2e \
  --satisfies OUT-1,OUT-2,FLOOR-1 \
  --description "Integrated scenario passed" --dir "$SESSION_DIR"
```

Receipt fields have these meanings:

| Field | Rule |
|---|---|
| `sliceId` | Execute node or loop unit that generated the evidence |
| `scenarioId` | Must equal the Mission Contract's `endToEndScenario.id` for integrated scope |
| `validatorType` | Must be one of the scenario's allowed `e2e`, `acceptance`, or `ux-sim` types |
| `validator` | Concrete validator identity; defaults to the node/unit |
| `satisfies` | Explicit active `OUT-N`/`FLOOR-N` IDs proven by this evidence |
| `artifactHashes` | SHA-256 hashes of only the evidence-bearing artifacts |
| `strategyEpoch` | Current mission strategy; written by the harness, not the executor |

An eligible receipt has `result: PASS`. Its `scope` is `integrated` only when
both scenario and validator bindings match the contract; otherwise it is
`local`. A supplied scenario mismatch, a validator disallowed for that supplied
scenario, or an unknown criterion ID is rejected rather than silently promoted.
Only current-epoch integrated PASS receipts count as positive trajectory progress
and final Mission criterion coverage.

Receipt validity is live, not historical by assertion. Immediately before a
trajectory decision and before finalization, the harness reopens every current
integrated receipt's bound regular files, re-hashes them, and rechecks its
harness-owned PASS proof. A missing, changed, symlinked, or no-longer-passing
artifact marks the receipt stale in the audit trail; its `satisfies` claims no
longer count. Re-copying or replaying the same execution is idempotent and must
not create a second source of progress. The receipt keys that identity as
`sourceExecution {sessionSha256,nodeId,runId,resultSha256}`; a conflicting
relabel or replay of a stale receipt is rejected.

For loop `e2e`/`accept`/`ux-sim` units, the current unit must first be claimed by
`next-tick`. Integrated artifacts must be contained regular non-symlink files
under the loop session, have an mtime at or after that claim, and include a
machine-readable passing result. At least one machine-result hash must be new
relative to every prior receipt; copying a previous PASS artifact cannot create
a fresh receipt. Accepted canonical paths are added to the loop's declared
artifact manifest so the next cold packet binds ignored/non-Git evidence too.
The harness executes the plan unit's frozen `verify:` command itself and writes
the receipt's PASS log; caller-authored JSON is supplemental only. The
`--scenario`, `--validator-type`, and `--satisfies` flags must exactly equal that
unit's pre-execution mappings.

When a later Mission Gate opens, the trajectory packet includes the integrated
PASS receipts added since the prior gate as compact evidence-delta entries. Each
entry carries the receipt hash, scenario, validator type, `satisfies` IDs, and
artifact hashes; the cold reviewer can therefore verify what materially changed
without receiving the local repair transcript.

At finalization, coverage is a set union over `satisfies` from current integrated
receipts. Every active outcome and protected floor must be present before a
`before_finalize` cold review can pass. The cold review's required `SUPPORTS`
reality signals must cite these receipt IDs. A current local receipt, an old-epoch
receipt, or uncited prose is not completion evidence.

## Verdict Rules

- All scenarios PASS → verdict: PASS
- Any scenario FAIL that is fixable by a trivial implementation change → verdict: ITERATE
  and route to `hotfix`; do not edit product code in `test-execute`.
- Any scenario FAIL blocking core flow → verdict: FAIL
- Tool unavailable → status: blocked (not a verdict)

## Tier-Aware Verification (Zero Trust)

If the flow has a quality tier set (`flow-state.json → tier`), the executor MUST capture Playwright screenshot evidence for each applicable baseline item. This is mechanical — not optional.

**Before executing tier verification**, run:
```bash
opc-harness tier-baseline --tier {TIER}
```
This outputs the exact P0 test cases to execute. Each case has concrete steps.

**Required evidence per baseline item (polished/delightful):**

| Baseline item | Required evidence |
|---|---|
| Typography hierarchy | Screenshot showing heading + body with different typefaces |
| Dark/light theme | Two screenshots: light mode + dark mode |
| Structured navigation | Screenshot showing nav with active state indicator |
| Responsive layout | Four screenshots: 320px, 768px, 1024px, 1440px width |
| Styled code blocks | Screenshot showing syntax-highlighted code with copy button |
| Styled tables | Screenshot showing styled table with hover row |
| Loading states | Screenshot captured during async load (skeleton/spinner visible) |
| Error states | Screenshot of error state with recovery action |
| Favicon/meta tags | Screenshot of browser tab showing favicon + page source check |
| Focus styles | Screenshot showing focus ring during keyboard navigation |

**Evidence file naming**: `screenshot-tier-{baseline-key}.png` (e.g., `screenshot-tier-dark-mode-light.png`, `screenshot-tier-dark-mode-dark.png`)

**If a baseline item cannot be verified** (e.g., no code blocks in the product), annotate it in the `tierCoverage.skipped` array of the handshake with a specific reason.

### Required handshake field: `tierCoverage`

When `flow-state.json` has a `tier`, the execute node handshake MUST include:

```json
{
  "...": "...other handshake fields...",
  "tierCoverage": {
    "covered": ["typography", "color-scheme", "navigation", "responsive", "code-blocks", "tables", "loading-states", "error-states", "favicon-meta", "focus-styles"],
    "skipped": [
      { "key": "page-transitions", "reason": "tier is polished — transitions only required at delightful" }
    ]
  }
}
```

The complete machine-readable schema, valid baseline keys, and examples live in
[tier-coverage-schema.md](tier-coverage-schema.md).

**Enforced by `opc-harness validate`:**
- `tierCoverage.covered` and `tierCoverage.skipped` are required arrays
- Every required baseline key for the tier (severity ≥ warning) must appear in `covered` OR `skipped`
- Each `skipped` entry must have `{ key, reason }` where `reason` is ≥10 characters
- Unknown baseline keys are rejected
- Missing or malformed `tierCoverage` → handshake rejected

**Why this is zero trust:** The executor cannot silently pretend a baseline item was tested. Every item must be explicitly enumerated — either with evidence (covered) or with a justified skip (skipped). No hand-waving allowed.

## Design Reproduction Mode

When `acceptance-criteria.md` contains a `## Reference` section with `reference_image:`, the executor MUST run design-diff verification instead of (or in addition to) standard scenario execution.

### Detection

```
reference_image: /path/to/ref.png
design_spec: /path/to/spec.json    # optional
```

If both fields are present, this is a **design reproduction task**.

### Execution Steps

1. **Find generated artifact** — locate the HTML output in `artifacts/` (e.g., `output.html`)
2. **Screenshot** — convert HTML to PNG using `image-x` html2png:
   ```bash
   python3 ~/.claude/skills/image-x/scripts/html2png.py artifacts/output.html --output artifacts/gen.png
   ```
3. **VLM design-diff** — the `design-intelligence` extension hook automatically detects `reference_image` in acceptance-criteria.md and runs design-diff mode (ref vs gen). No manual invocation needed.
4. **Read evidence** — check `ext-design-intelligence/design-diff-evidence.json` for structured diffs:
   ```json
   {
     "verdict": "ITERATE",
     "overall": 2.7,
     "diffs": [{"region": "header", "property": "bg", "expected": "#4ac0aa", "actual": "#fff", "severity": "major", "fix": "bg: #4ac0aa"}]
   }
   ```
5. **Write handshake** — include the evidence in the handshake:
   ```json
   {
     "verdict": "ITERATE",
     "evidence": {
       "mode": "design-diff",
       "overall": 2.7,
       "diffs": [...],
       "gen_image": "artifacts/gen.png",
       "ref_image": "/path/to/ref.png"
     }
   }
   ```

### Gate Consumption

The gate reads `evidence.diffs` from the handshake:
- **PASS**: `overall ≥ 4.0` AND zero major diffs
- **ITERATE**: below threshold — gate injects `evidence.diffs` into the next build prompt so the implementer knows exactly what to fix
- **FAIL**: `overall < 2.0` or 3+ consecutive ITERATE rounds — human intervention needed

## Anti-Patterns

- ❌ Reviewing code instead of running the product
- ❌ Reporting PASS without execution evidence
- ❌ Guessing outcomes when a tool is unavailable — use BLOCKED
- ❌ Writing only "it works" without captured output or screenshots
- ❌ Skipping GUI verification without annotating `cli-only` in handshake
- ❌ Testing only on one platform when the product ships on multiple — capture evidence per platform
- ❌ Using web Playwright for mobile-specific behaviors (gestures, device rotation) — use device-appropriate tooling
