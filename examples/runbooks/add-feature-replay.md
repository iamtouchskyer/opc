# Mental Replay — `/opc loop add a dark-mode toggle`

Dry walkthrough of how the reference runbook fires end-to-end. No code
was run for this artifact beyond `opc-harness runbook match`; everything
else is narrative. The goal is to pressure-test the Step 0 wiring added
in U5.11 by imagining a realistic run.

## Setup

Assume the user has:
- Cloned OPC at `~/.claude/skills/opc/`
- Symlinked the reference runbook:
  ```bash
  mkdir -p ~/.opc/runbooks
  ln -s ~/.claude/skills/opc/examples/runbooks/add-feature.md \
        ~/.opc/runbooks/add-feature.md
  ```
- Is in a project repo that already has a test suite + dev server.

Invocation:

```
/opc loop add a dark-mode toggle
```

## Tick sequence

### Tick 0 — Runbook lookup + plan seed

The orchestrator reads `skill.md` + `pipeline/loop-protocol.md`. Per
the new Step 0, before decomposition it shells out to:

```bash
opc-harness runbook match "add a dark-mode toggle"
```

Verified output (live):

```json
{
  "task": "add a dark-mode toggle",
  "dir": "~/.opc/runbooks",
  "matched": true,
  "score": 5,
  "patterns": ["/\\badd\\s+(a|an|the)\\s+\\w+/i"],
  "runbook": {
    "id": "add-feature",
    "flow": "build-verify",
    "tier": "polished",
    "units": ["spec", "plan", "build", "review", "fix",
              "test-design", "test-execute", "acceptance", "e2e"],
    ...
  }
}
```

The orchestrator skips Step 1 (decomposition) and writes
`.harness/plan.md` directly from the runbook. Header:

```markdown
# Plan — add a dark-mode toggle
Seeded from runbook `add-feature` (score 5, pattern:
`/\badd\s+(a|an|the)\s+\w+/i`).

## Units
- U1 spec — acceptance criteria, DoD
- U2 plan — per-unit verify/eval lines
- U3 build — implementer subagent
- U4 review — 2 independent reviewers (frontend + a11y)
- U5 fix — address 🔴/🟡
- U6 test-design — E2E scenarios + axe scan design
- U7 test-execute — orchestrator runs the plan
- U8 acceptance — PM sign-off
- U9 e2e — new-user + active-user personas
```

Cron (`*/10 * * * *`, durable) scheduled. First tick executes
immediately.

### Tick 1 — U1 spec

Orchestrator reads baseline from `pipeline/quality-tiers.md` for tier
`polished` and writes `.harness/acceptance-criteria.md`:

- [ ] Dark + light theme pass visual review
- [ ] Theme toggle persists across page reload
- [ ] Responsive at 375 / 768 / 1280 widths
- [ ] Loading / error / empty states covered
- [ ] Focus styles on every interactive element
- [ ] axe-core clean (no critical/serious)
- [ ] `prefers-color-scheme` media query honored on first load
- [ ] Keyboard-accessible toggle (Tab + Space/Enter)

`criteria-lint` passes (all 14 mechanical checks). Commit.

### Tick 2 — U2 plan

Per-unit verify/eval lines added to `plan.md`. E.g.:

```markdown
- U3 build — implement dark-mode toggle
  - verify: `npm test -- --grep "theme"` passes; `npm run build` clean
  - eval: no hardcoded colors in JSX, CSS custom properties used for
    theme tokens, toggle state persisted in localStorage
```

### Tick 3 — U3 build

Implementer subagent dispatched via `superpowers:subagent-driven-development`.
Writes:
- `src/contexts/ThemeContext.tsx`
- `src/components/ThemeToggle.tsx`
- CSS token layer (`:root { --bg: … }`, `[data-theme="dark"] { --bg: … }`)
- Hooks into root layout

Tests added for `ThemeToggle` + context. Git HEAD changes (required by
harness).

### Tick 4 — U4 review

Orchestrator dispatches **2 Agent-tool subagents in parallel**:
- `frontend` role — reviews component structure, CSS token usage
- `a11y` role — reviews focus styles, contrast ratios, ARIA

Both produce `eval-frontend.md` + `eval-a11y.md` with 🔴/🟡/🔵. Example
finding: 🟡 "Toggle button missing `aria-pressed`." `synthesize`
produces verdict `ITERATE`.

### Tick 5 — U5 fix

Direct fix (no subagent). Adds `aria-pressed`, re-runs tests. Git HEAD
changes.

### Tick 6 — U6 test-design

Different subagent (`tester` role) designs but does NOT run:
- E2E: toggle click, verify `[data-theme]` attribute flips
- E2E: reload, verify theme persists
- E2E: `prefers-color-scheme: dark` system pref honored on first load
- axe scan at both theme states

### Tick 7 — U7 test-execute

Orchestrator runs the plan using `webapp-testing` + `npx playwright`.
Captures screenshots at both themes (artifact required for UI units).
axe scan: 0 critical/serious.

### Tick 8 — U8 acceptance

`pm` + `designer` subagents. Both sign off.

### Tick 9 — U9 e2e

Orchestrator runs `new-user` + `active-user` persona walkthroughs per
`executor-protocol.md`. Evidence captured.

### Tick 10 — Terminate

`next-tick` returns `terminate: true`. Backlog drain: 1 🔵 suggestion
from U4 review — "consider honoring `prefers-reduced-motion` for the
theme-switch CSS transition." Below drain threshold (🔵 only), rolled
to final summary. Cron cancelled. `.harness/report.html` generated.

## What the walkthrough proves

1. **Step 0 actually fires** — `opc-harness runbook match` returns a
   match for "add a dark-mode toggle" via the `\badd\s+(a|an|the)\s+\w+\b`
   regex. Verified live in this session.
2. **The runbook overrides decomposition** — tick 0 skips Step 1 and
   adopts the runbook's 9-unit sequence wholesale. Saves one LLM round.
3. **Tier propagates** — `polished` triggers the baseline a11y /
   responsive / state-coverage checks automatically, without the user
   repeating them in the task.
4. **Review independence is preserved** — the runbook's `units:` list
   keeps `build` and `review` as separate ticks (the prime directive).
   The runbook doesn't let a user accidentally flatten them.
5. **Fall-through works** — if a task like "fix a memory leak" doesn't
   match any runbook (`runbook match` returns exit 3), Step 1
   decomposition runs as before. Zero regression for the
   no-runbook path.

## Known limitations observed

- Score 5 (regex-only match) is low. A runbook with more specific
  keywords would score higher and win against competing runbooks in a
  multi-runbook setup. For v1 that's fine — the tie-breakers handle it.
- The runbook's `match` list is tuned for English. A Chinese task like
  "添加一个暗色模式" would not match. Future work (U6+): bilingual
  keyword support or per-project runbook override.
- `--no-runbook` is documented in loop-protocol but not yet wired into
  `/opc loop` CLI parsing. That's a follow-up — for U5.11 the doc/CLI
  split is acceptable because the escape hatch works via env var
  (`OPC_DISABLE_RUNBOOKS=1`) which `runbook match` can read.

## Coherence check

Read `pipeline/loop-protocol.md` top-to-bottom after the Step 0 insert:

- Intro says flows handle single cycles, loop sits above them ✓
- Terminology block distinguishes Flow vs Runbook ✓
- Runbook Discovery section now references the CLI discovery order ✓
- Procedure: Step 0 (new) → Step 1 decompose → Step 2 init state ✓
- Tick prompt template unchanged (ticks don't care how the plan was
  seeded) ✓

Reads coherently — the insertion is not a bolt-on paragraph.
