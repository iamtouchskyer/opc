# OPC — One Person Company

> A full team in a single Claude Code skill. You're the CEO — OPC is everyone else.

16 specialist agents (PM, Designer, Security, Devil's Advocate, and more) that build, review, and evaluate your code through a digraph-based pipeline with code-enforced quality gates.

## What's Different in v0.7

**Third-party extension authoring.** The v0.5.1 extension surface is now documented + template'd for outside authors. `docs/extension-authoring.md` (7800+ words, zero "see internal" pointers) + `examples/extensions/_starter/` (30-min junior-dev walkthrough) + `examples/extensions/lint-prompt-length/` (outsider-built reference). Hardened via DX litmus: an independent agent built an extension using only the doc + starter, with every gap logged and patched.

## What's Different in v0.6

**Digraph engine.** Tasks flow through typed nodes (build → review → gate → ...) with mechanical verdict routing. No more linear pipelines.

**Autonomous loop.** `opc loop` decomposes a feature into units, schedules a durable cron, and runs 8-16 hours unattended — with code-enforced guardrails that survive context compaction.

**Code-enforced, not honor-system.** 34 automated tests verify: tamper detection (write nonce), atomic state writes, review independence checks (eval distinctness), oscillation detection, tick limits, and JSON crash recovery.

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

OPC has a capability-routed extension surface. Drop a directory into
`~/.opc/extensions/<name>/` with `ext.json` + `hook.mjs` exporting any of
`promptAppend` / `verdictAppend` / `executeRun` / `artifactEmit` hooks — no
fork, no rebuild. Hooks are sandboxed via per-extension timeouts + circuit
breakers, so a broken third-party extension can't take down the harness.

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
1. **Runbook lookup** — `opc-harness runbook match "<task>"` checks `.opc/runbooks/` → `~/.opc/runbooks/` for a matching recipe. If one hits, its `units` / `flow` / `tier` become the plan. See [docs/runbooks.md](docs/runbooks.md) and [examples/runbooks/add-feature.md](examples/runbooks/add-feature.md).
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

## Testing

```bash
bash test/test-harness.sh
```

34 end-to-end tests covering init-loop, complete-tick, next-tick, review independence, JSON crash recovery, and plan parsing.

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

Priority order: `OPC_DISABLE_EXTENSIONS=1` env var > `--no-extensions` CLI flag > `--extensions foo,bar` whitelist > config in `.opc/config.json` and `~/.opc/config.json`. See `docs/specs/2026-04-16-opc-extension-system-design.md` for the full contract.

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
