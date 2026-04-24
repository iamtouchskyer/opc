# OPC — One Person Company

> A full team in a single Claude Code skill. You're the CEO — OPC is everyone else.

16 specialist agents (PM, Designer, Security, Devil's Advocate, and more) that build, review, and evaluate your code through a digraph-based pipeline with code-enforced quality gates.

## What's Different in v0.8

**Compound eval quality gate (D2).** 11-layer substance check on every eval — thin content, missing code refs, low uniqueness, fabricated references, aspirational claims, change scope coverage, etc. ≥3 layers tripped → hard FAIL (enforce by default); `--no-strict` downgrades to shadow mode. thinEval substance exemption: short evals with complete reasoning/fix/refs are exempt. Evaluator guidance: when D2 triggers, `evaluatorGuidance` output tells the evaluator exactly which layers failed and how to fix.

**Iteration escalation (D3).** Persistent eval warnings across ≥2 iterations auto-escalate to FAIL. No more infinite loops of shallow reviews.

**Task Scope Registry.** Loop mode plans require `## Task Scope` with SCOPE-N items. The harness validates at init and blocks completion if any scope item is uncovered — preventing the #1 failure mode where LLM decomposition silently drops requirements.

**Pipeline E2E lint.** Tasks containing pipeline keywords (cron, webhook, CI/CD) must have an e2e-live-trigger acceptance criterion. Proxy evidence (unit tests) ≠ live evidence.

**Evaluator prompt hardening (D6).** 5 evidence standards baked into the evaluator protocol: cite evidence, address anomalies, no aspirational claims, distinguish root cause vs symptom, cover change scope.

## What's Different in v0.7

**Third-party extension authoring.** `docs/extension-authoring.md` (7800+ words) + `examples/extensions/_starter/` (30-min walkthrough). Hardened via DX litmus: an independent agent built an extension using only the doc + starter.

## What's Different in v0.6

**Digraph engine.** Tasks flow through typed nodes (build → review → gate → ...) with mechanical verdict routing. No more linear pipelines.

**Autonomous loop.** `opc loop` decomposes a feature into units, schedules a durable cron, and runs 8-16 hours unattended — with code-enforced guardrails that survive context compaction.

**Code-enforced, not honor-system.** 29 test suites verify: tamper detection (write nonce), atomic state writes, review independence, oscillation detection, tick limits, scope coverage, compound defense, and JSON crash recovery.

**External validator integration.** Pre-commit hooks, test suites, Playwright E2E, and CI pipelines are formally part of the quality architecture — the agent is supervised by tools it doesn't control.

## How It Works

One principle: **the agent that does the work never evaluates it.**

```
Task → Flow Selection → Node Execution → Gate Verdict → Route Next
                              ↑                              ↓
                              └──────── ITERATE/FAIL ────────┘
```

1. **Task inference** — reads your request, picks a flow template (review, build-verify, full-stack, pre-release), and enters at the right node.

2. **Typed nodes** — each node has a type (discussion, build, review, execute, gate) with specific protocols. Build nodes produce commits. Review nodes dispatch parallel subagents. Gate nodes compute verdicts from code, not LLM judgment.

3. **Mechanical gates** — verdicts are computed by `opc-harness synthesize`: any red = FAIL, any yellow = ITERATE, all green = PASS. No LLM gets to decide if a finding is "important enough."

4. **Cycle limits** — max 3 loops per edge, 5 re-entries per node, 20-30 total steps depending on flow. Oscillation detection catches A↔B loops.

## Quick Start

### Install

```bash
npm install -g @touchskyer/opc
```

Skill files are automatically copied to `~/.claude/skills/opc/`.

#### Manual install (no npm)

```bash
git clone https://github.com/iamtouchskyer/opc.git
cp -r opc ~/.claude/skills/opc
```

### Use it

```bash
# Review — dispatches 2-5 role agents in parallel
/opc review the auth changes

# Build — implements + independent review + gate
/opc implement user authentication with email/password

# Autonomous loop — decomposes, schedules cron, runs unattended
/opc loop build features F1-F4 from PLAN.md

# Interactive mode — asks clarifying questions first
/opc -i redesign the onboarding flow

# Explicit roles
/opc security devil-advocate

# Flow control
/opc skip          # skip current node
/opc pass          # force-pass gate
/opc stop          # terminate, preserve state
/opc goto build    # jump to node
```

## Extensions

OPC has a capability-routed extension surface. Extensions live in
`~/.claude/skills/opc-extension/<name>/` — each with `ext.json` (capability
declarations) + `hook.mjs` exporting any of `promptAppend` / `verdictAppend`
/ `executeRun` / `artifactEmit` hooks. No fork, no rebuild. Hooks are
sandboxed via per-extension timeouts + circuit breakers, so a broken
third-party extension can't take down the harness.

The companion repo **[opc-extensions](https://github.com/iamtouchskyer/opc-extensions)** ships 4 extensions: `design-intelligence` (theme injection + design coverage + VLM visual eval), `git-changeset-review`, `memex-recall`, and `session-logex`.

Full authoring guide: **[docs/extension-authoring.md](docs/extension-authoring.md)** — zero-OPC-context
quickstart + reference, plus a starter template at `examples/extensions/_starter/`.

## Flow Templates

| Template | Nodes | When |
|----------|-------|------|
| **review** | code-review → gate | PR review, audit, "find problems" |
| **build-verify** | build → code-review → test-design → test-execute → gate | "implement X", "fix bug Y" |
| **full-stack** | discuss → build → review → test → acceptance → audit → e2e → gates | Complex/vague requests |
| **pre-release** | acceptance → audit → e2e → gates | "verify before release" |

## Autonomous Loop (v0.6)

```bash
/opc loop build the math tutoring app features F1-F4
```

What happens:
1. **Runbook lookup** — `opc-harness runbook match "<task>"` checks `--dir` flag → `OPC_RUNBOOKS_DIR` → `~/.opc/runbooks/` for a matching recipe. If one hits, its `units` / `flow` / `tier` become the plan; otherwise fall through to step 2. Disable per-invocation with `OPC_DISABLE_RUNBOOKS=1`. See [docs/runbooks.md](docs/runbooks.md) and [examples/runbooks/add-feature.md](examples/runbooks/add-feature.md).
2. **Decompose** (runbook miss only) — breaks task into atomic units (spec, implement, review, fix, e2e)
3. **Definition of done** — establishes verify/eval criteria per unit before any work starts
4. **Schedule** — durable cron (survives process restart) fires every 10 min
5. **Execute** — each tick runs one unit through the appropriate OPC flow
6. **Guard** — `opc-harness` enforces: git commit required, ≥2 independent reviewers, no plan tampering, no state forgery, artifact freshness, tick limits
7. **Terminate** — auto-stops when plan complete, tick limit hit, or wall-clock deadline reached

### Guardrails (code-enforced, not prompt-level)

| Guard | Enforcement |
|-------|-------------|
| Write nonce | Random SHA256 at init; state written by harness only |
| Atomic writes | write → rename (POSIX atomic); no truncated JSON on crash |
| Plan integrity | SHA256 hash at init; verified every tick |
| Review independence | ≥2 eval files, identical content rejected, line overlap warned |
| Git commit required | HEAD must change for implement/fix units |
| Screenshot required | UI units must produce .png/.jpg artifact |
| Tick limits | maxTotalTicks (units×3) + 24h wall-clock deadline |
| Oscillation detection | A↔B pattern over 4-6 ticks = warning/hard stop |
| Concurrent tick mutex | in_progress status blocks overlapping cron fires |
| JSON crash recovery | try/catch on all JSON.parse; structured errors, not crashes |
| External validators | Pre-commit hooks, test suites detected at init and leveraged |

## Built-in Roles

```
Product:     pm, designer
User Lens:   new-user, active-user, churned-user
Engineering: frontend, backend, devops, architect, engineer
Quality:     security, tester, compliance, a11y
Specialist:  planner, user-simulator, devil-advocate
```

**Devil's Advocate** (the 10th person) is auto-included when consensus is near-unanimous or decisions are irreversible. Comes with an automated verification script that checks its own findings.

### Custom Roles

Add a `.md` file to `roles/`:

```markdown
---
tags: [review, build]
---
# Role Name

## Identity
One sentence: who you are and what you care about.

## Expertise
- **Area** — what you know about it

## When to Include
- Condition that triggers this role
```

Available immediately, no configuration needed.

## CLI Reference

### Flow commands

```
init --flow <tpl> [--flow-file <p>] [--entry <node>] [--dir <p>]
route --node <id> --verdict <V> --flow <tpl> [--flow-file <p>]
transition --from <n> --to <n> --verdict <V> --flow <tpl> [--flow-file <p>] --dir <p>
validate <handshake.json>
validate-chain [--dir <p>]
validate-context --flow <tpl> [--flow-file <p>] --node <id> [--dir <p>]
finalize [--dir <p>] [--strict]
viz --flow <tpl> [--flow-file <p>] [--dir <p>] [--json]
replay [--dir <p>]
seal --node <id> [--run <N>] [--dir <p>]             # Auto-generate handshake from artifacts
advance [--dir <p>]                                  # One-click gate: synthesize → route → transition
```

### Escape hatches

```
skip [--dir <p>]          # Skip current node via PASS
pass [--dir <p>]          # Force-pass current gate
stop [--dir <p>]          # Terminate flow, preserve state
goto <nodeId> [--dir <p>] # Jump to a node
ls [--base <p>]           # List active flows
```

### Eval commands

```
verify <file>                                        # Parse evaluation → JSON
synthesize <dir> --node <id> [--run N]               # Merge evaluations → verdict
report <dir> --mode <m> --task <t>                   # Generate full report JSON
diff <file1> <file2>                                 # Compare two evaluation rounds
tier-baseline --tier <functional|polished|delightful> # Generate P0 test cases for tier
```

### UX simulation

```
ux-verdict --dir <p> --run <N>                       # Compute UX verdict from observers
ux-friction-aggregate --dir <p> --run <N> --output <p> # Aggregate friction points
criteria-lint <file> [--tier <t>]                    # Lint acceptance criteria DoD
```

### Config commands

```
config resolve [--dir <p>]   # Print merged OPC config w/ _source map
```

### Runbook commands

```
runbook list [--dir <p>]     # List all runbooks
runbook show <id> [--dir <p>] # Print runbook details
runbook match <task...> [--dir <p>] # Match task to best runbook
```

### Extension commands

```
extension-test --ext <p> [--hook <name>] [--context <json>] [--all-hooks] [--fixture-dir <p>] [--lint]
                                         # Dry-run extension hook(s); --fixture-dir seeds ctx.flowDir; --lint runs authoring checks only
extension-verdict --node <id> --dir <p>  # Fire verdict.append → writes eval-extensions.{md,json}
extension-artifact --node <id> --dir <p> # Fire artifact.emit → writes artifacts/
prompt-context --node <id> --role <role> --dir <p>
                                         # Fire prompt.append → emit extra prompt context
```

### Loop commands

```
init-loop [--plan <file>] [--flow-template <name>] [--flow-file <p>] [--handlers <json>] [--dir <p>]
reinit-loop --unit <id> --sub-units <csv> [--dir <p>]
complete-tick --unit <id> --artifacts <a,b> --description <text> [--dir <p>]
next-tick [--dir <p>]
```

## Testing

```bash
bash test/run-all.sh
```

92 test files covering init-loop, complete-tick, next-tick, review independence, JSON crash recovery, compound defense, scope registry, criteria lint, pipeline E2E lint, D2 calibration, seal/advance, session resolution, and orchestrator-level E2E flow tests.

## Reproducing benchmarks

OPC ships with an extension system (v0.5, Run 1) so you can plug in additional hooks — visual checks, design-system audits, a11y scans — without forking the skill. The extension loader honors three bypasses so a single harness invocation can ignore locally-configured extensions:

```bash
# Disable every extension for one harness run
OPC_DISABLE_EXTENSIONS=1 node bin/opc-harness.mjs init --flow review --entry review --dir .harness

# Same effect, CLI flag form
node bin/opc-harness.mjs init --flow review --entry review --dir .harness --no-extensions

# Whitelist specific extensions only
node bin/opc-harness.mjs init --flow review --entry review --dir .harness --extensions visual-check,a11y
```

Priority order: `OPC_DISABLE_EXTENSIONS=1` env var > `--no-extensions` CLI flag > `--extensions foo,bar` whitelist > config in `~/.claude/skills/opc-extension/config.json`. See `docs/specs/2026-04-16-opc-extension-system-design.md` for the full contract.

**Note:** `bash test/run-all.sh` runs OPC's own internal test suite, which includes tests that intentionally *load* extensions to exercise the system. Don't set `OPC_DISABLE_EXTENSIONS=1` when running the suite — use the bypasses only on real benchmarking / workflow invocations.

## Requirements

- [Claude Code](https://claude.ai/code) (CLI, desktop app, or IDE extension)
- Node.js >= 18
- No runtime dependencies, no MCP server, no build step

## Works better with memex (optional)

OPC works standalone — pair it with [memex](https://github.com/iamtouchskyer/memex) for cross-session memory. Memex remembers which roles were useful, which findings were false positives, and your project-specific context.

```bash
npm install -g @touchskyer/memex
```

## Community

Using OPC? Share your setup in [Discussions → Show and tell](https://github.com/iamtouchskyer/opc/discussions/categories/show-and-tell). Questions go in [Q&A](https://github.com/iamtouchskyer/opc/discussions/categories/q-a). Feature ideas in [Ideas](https://github.com/iamtouchskyer/opc/discussions/categories/ideas).

## License

MIT
