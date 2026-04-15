# OPC — One Person Company

> A full team in a single Claude Code skill. You're the CEO — OPC is everyone else.

16 specialist agents (PM, Designer, Security, Devil's Advocate, and more) that build, review, and evaluate your code through a digraph-based pipeline with code-enforced quality gates.

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
1. **Decompose** — breaks task into atomic units (spec, implement, review, fix, e2e)
2. **Definition of done** — establishes verify/eval criteria per unit before any work starts
3. **Schedule** — durable cron (survives process restart) fires every 10 min
4. **Execute** — each tick runs one unit through the appropriate OPC flow
5. **Guard** — `opc-harness` enforces: git commit required, ≥2 independent reviewers, no plan tampering, no state forgery, artifact freshness, tick limits
6. **Terminate** — auto-stops when plan complete, tick limit hit, or wall-clock deadline reached

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

## Harness Commands (v0.10b)

### `ux-verdict` — UX simulation verdict

Aggregates red flags from persona-based observer reports, computes tier-parameterized severity, compares against a baseline run, and produces a mechanical PASS/ITERATE/FAIL gate verdict.

```bash
opc-harness ux-verdict --dir .harness --run 1
```

- Reads `observer-*.md` files from `nodes/ux-simulation/run_N/`
- Validates observer JSON schema (7 reject conditions: missing fields, invalid flag keys, short reasoning, third-person language, etc.)
- Aggregates red flags across observers, deduplicates by key, takes worst severity
- Delta comparison against previous run: regressions → FAIL, improvements → PASS/ITERATE
- Gate logic: any critical = FAIL, warnings over tier threshold = ITERATE
- Supports `red-flag-overrides.md` to reclassify flag severity per project

Related: `ux-friction-aggregate` generates a friction report grouped by UX stage:

```bash
opc-harness ux-friction-aggregate --dir .harness --run 1 --output friction.md
```

### `criteria-lint` — Acceptance criteria quality check

Zero-token-cost structural and content validation for `acceptance-criteria.md` files. Runs 14 checks (7 structural, 4 content, 3 warnings) in a single pass.

```bash
opc-harness criteria-lint acceptance-criteria.md --tier polished
```

**Structural checks:** required sections (Outcomes, Verification, Quality Constraints, Out of Scope), outcome count (3–7), verification mapping (every OUT-N has a method), tier baseline section when `--tier` is set.

**Content checks:** vague outcomes without measurement thresholds (`fast`, `clean`, `intuitive`), impossible-to-fail criteria (`should work`, `as expected`), manual-only verification, near-duplicate outcomes (Jaccard >80%).

**Warnings:** empty scope section, no failure-mode outcomes, high outcome count (>5).

Exits 0 on pass, 1 on failure. JSON on stdout, human-readable on stderr.

### Compound Defense — Eval quality probability stacking

Built into `opc-harness synthesize`, compound defense applies 9 independent quality layers to eval files and test plans. Each layer is ~30% bypassable independently; stacked, bypass probability drops to ~0.24%.

**Eval layers** (applied per reviewer file):

| Layer | Detects |
|-------|---------|
| Thin eval | <50 lines |
| No code refs | 0 `file:line` references in findings |
| Low unique content | >40% duplicate lines (copy-paste padding) |
| Single heading | 1 heading in 30+ lines (no structural diversity) |
| Low finding density | Few findings relative to line count (bulk filler) |
| Missing reasoning | >50% of findings lack "Reasoning:" explanation |
| Missing fix | >50% of findings lack "→" fix suggestion |
| Uniform line length | Suspiciously low variance (template fill) |
| Fabricated refs | `file:line` references that don't exist in `--base` dir |

**Test plan layers** (applied to `test-plan.md`):

| Layer | Detects |
|-------|---------|
| Shallow sections | Layer sections with <3 content lines |
| No actionable commands | 0 backtick-quoted commands in 10+ line plan |

```bash
# Eval layers run automatically during synthesize:
opc-harness synthesize .harness --node code-review

# Enable file:line reality check with --base:
opc-harness synthesize .harness --node code-review --base ./src
```

Each triggered layer adds a warning to the synthesize verdict. Any warning downgrades the verdict to ITERATE.

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

## Requirements

- [Claude Code](https://claude.ai/code) (CLI, desktop app, or IDE extension)
- Node.js >= 18
- No runtime dependencies, no MCP server, no build step

## Works better with memex (optional)

OPC works standalone — pair it with [memex](https://github.com/iamtouchskyer/memex) for cross-session memory. Memex remembers which roles were useful, which findings were false positives, and your project-specific context.

```bash
npm install -g @touchskyer/memex
```

## License

MIT
