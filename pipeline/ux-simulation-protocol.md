# UX Simulation Protocol — Red Flag Detection Gate

**Node type:** `execute` (orchestrator executes directly, not as a subagent)
**Purpose:** Detect concrete UX red flags through independent persona-based observation. This is the final quality gate before flow completion.

**Replaces:** `wtp-gate-protocol.md` (v0.9). The old protocol asked LLM personas to produce dollar amounts and PAY/NO_PAY decisions — cardinal economic signals that LLMs cannot reliably generate. This protocol asks for **ordinal pattern signals**: red flag detection, trust signal observation, delta comparison, and tier-fit bucketing.

## Why This Node Exists

Upstream nodes answer **technical** questions: does it work, is the code sound, does it meet tier baseline, is it accessible. None answer the **user experience** question: would a real user trust this product enough to keep using it?

The UX simulation gate answers that question by dispatching independent observers with lifecycle personas who **report what they see** — not what they'd pay. The gate logic is **mechanical**: it counts red flags, checks severity mappings, compares against baseline, and routes.

## Core Design Principles

### 1. Ordinal, Not Cardinal

Observers do NOT produce dollar amounts or binary purchase decisions. They produce:
- **Red flags** from a closed enum (code-enforced, not freeform)
- **Trust signals** (present or absent) from a pattern list
- **Friction observations** with stage and severity
- **Tier fit** as ordinal bucket: `free-only` / `below-tier` / `at-tier` / `above-tier`
- **Delta assessment** (from 2nd run onward): `regression` / `same` / `improvement` / `significant-improvement`

### 2. Closed Enum with Expansion Mechanism

Red flags are a fixed list (~10 stable patterns). Observers MUST pick from the enum. If they see something not in the enum, they use `other` with a description. The orchestrator reviews `other` entries across runs; confirmed patterns get added to the enum in future versions.

### 3. Code-Enforced Severity

The pattern-to-severity mapping is defined in `tier-baselines.mjs` and `$SESSION_DIR/red-flag-overrides.md`. Observers cannot override severity labels. They report what they see; the harness computes severity.

### 4. Delta as Primary Signal

From the 2nd run onward, the gate's primary signal is **comparison to previous run**, not absolute quality. LLMs are dramatically better at relative comparison ("is this better or worse than last time?") than absolute scoring ("is this a $30/mo product?").

## Position in Flow Templates

### `full-stack` flow

```
... -> e2e-user -> gate-e2e -> ux-simulation -> gate-final -> (terminal)
```

### `build-verify` flow (optional)

For UI-bearing `build-verify` flows with `tier=polished|delightful`, inserted before terminal gate when:
- `tier` is `polished` or `delightful`
- Product has a discoverable entry point (URL, CLI, mobile build)
- Task description mentions user-facing outcomes

### `functional` tier

Also runs UX simulation — with **tool-adopter** observation focus. CLI/API products get evaluated for developer UX: help output quality, error messages, discoverability, time-to-first-success.

## Red Flag Enum

The initial ~10 stable red flag patterns. Each has a `key`, `label`, and tier-parameterized `severity`.

```
RED_FLAGS = [
  default-favicon          # Browser tab shows framework default icon
  stack-trace-visible      # Raw stack trace / error dump shown to end user
  lorem-ipsum              # Placeholder text visible in shipped UI
  broken-link              # CTA or navigation link leads to 404/error
  no-empty-state           # Empty list/view is blank with zero guidance
  no-loading-feedback      # Async operation shows no spinner/skeleton/progress
  no-error-recovery        # Error state has no retry/back/recovery action
  first-value-over-5min    # Time from entry to first useful outcome > 5 minutes
  data-loss-on-error       # User input lost after error (form, editor, etc.)
  auth-before-value        # Must create account/pay before seeing any value
]
```

**Expansion mechanism:** Observers can report `other: { description: "..." }`. After 3+ independent observers flag the same `other` pattern, the orchestrator reviews and may promote it to the enum in the next version. The `other` slot is NOT freeform severity — `other` entries always receive `suggestion` severity in gate computation.

### Severity Mapping (tier-parameterized)

| Red flag | `functional` | `polished` | `delightful` |
|---|---|---|---|
| `default-favicon` | — | warning | critical |
| `stack-trace-visible` | warning | critical | critical |
| `lorem-ipsum` | warning | critical | critical |
| `broken-link` | critical | critical | critical |
| `no-empty-state` | suggestion | warning | critical |
| `no-loading-feedback` | suggestion | warning | critical |
| `no-error-recovery` | suggestion | warning | critical |
| `first-value-over-5min` | warning | critical | critical |
| `data-loss-on-error` | critical | critical | critical |
| `auth-before-value` | suggestion | warning | critical |

**Override mechanism:** `$SESSION_DIR/red-flag-overrides.md` can adjust severity for project-specific context:
```markdown
## Red Flag Overrides
- default-favicon: suggestion  # This is a CLI tool, favicon is irrelevant
- auth-before-value: —         # B2B product, auth-first is expected
```
Overrides are loaded by the harness and merged over defaults. Only severity can be overridden, not the enum itself.

## Execution Flow

### Step 1 — Prerequisites Check

Before dispatching observers, the orchestrator MUST verify:

1. **Product is running** (or buildable):
   - Web: dev server up, accessible URL
   - CLI: binary on PATH or in project directory
   - API: endpoints reachable
   - Library: import works from a fresh sandbox

2. **Flow has a tier set** (`flow-state.tier` is not null).

3. **At least one upstream handshake exists** with verified functional behavior.

If any prerequisite fails -> handshake `status: "blocked"` with reason, do not dispatch observers.

### Step 2 — Baseline Snapshot (for delta comparison)

Check for previous run data:
```
$SESSION_DIR/nodes/ux-simulation/run_{PREV}/ux-verdict.json
```

If exists, load it as `baseline`. Inject `baseline.red_flags` and `baseline.trust_signals` into each observer's prompt so they can report delta.

If no previous run exists, this is a first run — skip delta, use absolute gate logic.

### Step 3 — Observer Dispatch

Dispatch **3 parallel subagents** using the Agent tool, each receiving:

- **Base prompt:** `role-evaluator-prompt.md` with the role `.md` content (including Observation Mode section)
- **Observation appendix:** full content of `ux-observer-protocol.md`
- **Tier:** `flow-state.tier`
- **Product entry point:** absolute URL, CLI command, or module import path
- **Red flag enum:** the full list from this protocol (so observers know what to look for)
- **Baseline snapshot** (if exists): previous run's red flags and trust signals for delta reporting
- **Acceptance criteria:** `$SESSION_DIR/acceptance-criteria.md`

The three observers run **in parallel**. They MUST NOT see each other's outputs. Parallel dispatch is non-negotiable.

### Step 4 — Observer Report Collection

Each observer writes to:
```
$SESSION_DIR/nodes/ux-simulation/run_{RUN}/observer-{role}.md
```

Report format is enforced by `ux-observer-protocol.md` — single fenced JSON block.

### Step 5 — Mechanical Verdict Computation

Run:
```bash
opc-harness ux-verdict --dir $SESSION_DIR --run {RUN}
```

This command:

1. Reads all `observer-{role}.md` files under the run directory
2. Extracts JSON blocks, validates schema
3. Maps reported red flags to tier-parameterized severity (from `tier-baselines.mjs` + overrides)
4. Computes aggregate counts: `{ critical: N, warning: N, suggestion: N }`
5. Computes trust signal coverage: `{ present: [...], absent: [...] }`
6. Computes delta (if baseline exists): `{ regression: [...], improvement: [...], new: [...], resolved: [...] }`
7. Computes tier fit consensus: majority bucket wins
8. Outputs JSON verdict

### Step 6 — Gate Logic

#### First Run (no baseline)

```
if any observer report is malformed:
    verdict = BLOCKED

elif critical_count >= 1:
    verdict = FAIL
    # Any critical red flag is a hard stop

elif warning_count > THRESHOLD[tier]:
    verdict = ITERATE
    # Too many warnings — product needs work

elif tier_fit_consensus in [free-only, below-tier]:
    verdict = ITERATE
    # Product doesn't match its declared tier

else:
    verdict = PASS
```

**Warning thresholds by tier:**
- `functional`: 3 warnings before ITERATE
- `polished`: 2 warnings before ITERATE
- `delightful`: 1 warning before ITERATE

#### Subsequent Runs (baseline exists)

```
if critical_count >= 1:
    verdict = FAIL

elif regression is non-empty:
    verdict = FAIL
    # Something got worse — hard stop, investigate

elif improvement is non-empty AND warning_count <= THRESHOLD[tier]:
    verdict = PASS
    # Got better AND under threshold — ship it

elif improvement is non-empty AND warning_count > THRESHOLD[tier]:
    verdict = ITERATE
    # Got better but still not good enough

elif same AND warning_count > THRESHOLD[tier]:
    verdict = ITERATE
    # No change and still over threshold

elif same AND warning_count <= THRESHOLD[tier]:
    verdict = PASS
    # No change but was already acceptable
```

### Step 7 — Friction Aggregation

If verdict is FAIL or ITERATE:

```bash
opc-harness ux-friction-aggregate --dir $SESSION_DIR --run {RUN} --output $SESSION_DIR/nodes/ux-simulation/run_{RUN}/friction-report.md
```

Groups friction points by stage, severity, and frequency across observers. Friction report is injected into the next `build` node's prompt.

### Step 8 — Handshake

```json
{
  "nodeId": "ux-simulation",
  "nodeType": "execute",
  "runId": "run_{RUN}",
  "status": "completed",
  "verdict": "PASS" | "ITERATE" | "FAIL" | "BLOCKED",
  "summary": "<red flags: N critical, N warning. Trust signals: N/M present. Delta: improved/same/regressed>",
  "timestamp": "<ISO8601>",
  "artifacts": [
    { "type": "eval", "path": "run_{RUN}/observer-new-user.md" },
    { "type": "eval", "path": "run_{RUN}/observer-active-user.md" },
    { "type": "eval", "path": "run_{RUN}/observer-churned-user.md" },
    { "type": "report", "path": "run_{RUN}/friction-report.md" }
  ],
  "uxResult": {
    "tier": "polished",
    "observersTotal": 3,
    "redFlags": {
      "critical": 0,
      "warning": 2,
      "suggestion": 3,
      "other": 1
    },
    "trustSignals": {
      "present": ["changelog-visible", "error-messages-helpful", "favicon-custom"],
      "absent": ["pricing-visible", "team-page"]
    },
    "tierFitConsensus": "at-tier",
    "delta": {
      "vs_run": "run_1",
      "assessment": "improvement",
      "regressions": [],
      "improvements": ["no-loading-feedback resolved", "empty-state added"],
      "new_flags": [],
      "resolved_flags": ["no-loading-feedback", "no-empty-state"]
    },
    "warningThreshold": 2,
    "warningCount": 2
  },
  "findings": { "critical": 0, "warning": 2, "suggestion": 3 }
}
```

## Failure Routing

| Failure shape | Route to | Rationale |
|---|---|---|
| Any critical red flag in `first-30s` | `build` (full rework) | First-impression failures = requirements/scope problem |
| Any critical red flag in `core-flow` | `build` (full rework) | Core flow broken = design problem |
| Any critical red flag in `edge-case`/`exit` | `build` (targeted) | Missing feature, not rewrite |
| Regression (delta) | `build` (targeted at regressed items) | Something broke — fix specifically |
| Only warnings, no criticals | `build` in Polish mode | Tier baseline gap, not fundamental issue |
| Tier fit = `free-only` or `below-tier` | `build` in Polish mode with tier focus | Positioning issue |
| BLOCKED (malformed reports) | Re-dispatch observers up to 2x | Mechanical retry |

## Loopback Limits

UX simulation loopbacks count toward `maxLoopsPerEdge` (3). After 3 failures:
- `/opc pass` — force PASS
- `/opc stop` — terminate flow
- `/opc goto build` — manual redirect

3 rounds of red flag failure = product probably doesn't meet its declared tier. User intervention appropriate.

## Observer Report JSON Schema

Every `observer-{role}.md` file must contain exactly one fenced JSON block. Schema defined in `ux-observer-protocol.md`.

Schema enforcement is mechanical (in `ux-verdict` command):
- Missing top-level field -> BLOCKED
- Red flag key not in enum (and not `other`) -> BLOCKED
- `other` entries without `description` -> BLOCKED
- `tier_fit` not in valid enum -> BLOCKED
- Any friction point missing `reference` field -> BLOCKED
- `reasoning` shorter than 40 characters -> BLOCKED
- `reasoning` contains "users" / "people" / "one would" -> BLOCKED (speak as yourself)

## Relationship to Other Protocols

- **`ux-observer-protocol.md`** — defines what each dispatched observer does (pattern detection, output schema, anti-rationalization)
- **`role-evaluator-prompt.md`** — base prompt; UX simulation appends `ux-observer-protocol.md`
- **`criteria-lint.md`** — runs at flow START (DoD quality). Together with UX simulation, these are bookend defenses: front-end DoD lint + back-end UX observation
- **`gate-protocol.md`** — downstream `gate-final` uses UX verdict verbatim
- **`quality-tiers.md`** — `tier` determines severity mapping and warning thresholds
- **`tier-baselines.mjs`** — code source of truth for red flag severity mapping

## Anti-Patterns

- Do NOT ask observers for dollar amounts or purchase decisions — that's the old protocol's fatal flaw
- Do NOT dispatch observers serially — parallel is non-negotiable
- Do NOT run UX simulation without a product actually running
- Do NOT run without a tier set
- Do NOT let observers override severity labels — the harness maps flags to severity
- Do NOT treat `other` entries as equivalent to enum entries — `other` is always `suggestion` severity
- Do NOT skip delta comparison when baseline exists — delta is the primary signal from run 2 onward
- Do NOT let UX failure quietly loop forever — `maxLoopsPerEdge=3`
- Do NOT merge observer reports into a single document — independence is the point
