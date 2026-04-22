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

### Step 2 — Read Acceptance Criteria

Read from upstream handshake summary and `$SESSION_DIR/progress.md`. Each acceptance criterion becomes a test scenario.

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
    { "type": "cli-output", "path": "$SESSION_DIR/nodes/{NODE_ID}/run_{RUN}/command-output-1.txt" },
    { "type": "screenshot", "path": "$SESSION_DIR/nodes/{NODE_ID}/run_{RUN}/screenshot-1.png" }
  ],
  "findings": { "critical": 0, "warning": 1, "suggestion": 0 }
}
```

**Evidence requirement (enforced by code):** `nodeType=execute` handshakes must contain at least one artifact with type ∈ {test-result, screenshot, cli-output}. Missing evidence → `opc-harness validate` rejects the handshake.

## Verdict Rules

- All scenarios PASS → verdict: PASS
- Any scenario FAIL with workaround → verdict: ITERATE
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

**Enforced by `opc-harness validate`:**
- `tierCoverage.covered` and `tierCoverage.skipped` are required arrays
- Every required baseline key for the tier (severity ≥ warning) must appear in `covered` OR `skipped`
- Each `skipped` entry must have `{ key, reason }` where `reason` is ≥10 characters
- Unknown baseline keys are rejected
- Missing or malformed `tierCoverage` → handshake rejected

**Why this is zero trust:** The executor cannot silently pretend a baseline item was tested. Every item must be explicitly enumerated — either with evidence (covered) or with a justified skip (skipped). No hand-waving allowed.

## Anti-Patterns

- ❌ Reviewing code instead of running the product
- ❌ Reporting PASS without execution evidence
- ❌ Guessing outcomes when a tool is unavailable — use BLOCKED
- ❌ Writing only "it works" without captured output or screenshots
- ❌ Skipping GUI verification without annotating `cli-only` in handshake
- ❌ Testing only on one platform when the product ships on multiple — capture evidence per platform
- ❌ Using web Playwright for mobile-specific behaviors (gestures, device rotation) — use device-appropriate tooling
