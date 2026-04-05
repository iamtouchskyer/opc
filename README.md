# OPC — One Person Company

> A full team in a single Claude Code skill. You're the CEO — OPC is everyone else.

11 specialist agents (PM, Designer, Security, Tester, and more) that review, analyze, build, and brainstorm your code — so you don't have to context-switch between hats.

## Why not just ask Claude directly?

You can — and for code-level bugs, a single Claude prompt is often more thorough. We tested both on this repo:

| | Single Claude | OPC (3 agents) |
|---|:---:|:---:|
| Code bugs (variable shadowing, DRY violations, exit codes) | **14 found** | 9 found |
| UX issues ("new user runs `opc review` in terminal expecting a CLI command") | 0 found | **5 found** |

Single Claude found more code issues. OPC found **different types of issues** — things that require thinking from a specific persona's perspective. A security engineer looks for content exposure. A new user tries the install flow and gets confused. A DevOps engineer checks npm packaging. Claude won't switch to these mindsets unless you explicitly ask.

**OPC's value isn't finding more bugs. It's finding bugs you wouldn't think to look for.**

## How It Works

One principle: **the agent that does the work never evaluates it.**

1. **Task inference** — OPC reads your request and picks the right pipeline: review, analysis, build, brainstorm, plan, or full pipeline. Every path ends with independent evaluation.

2. **Parallel specialists** — 2-5 role-specific agents run in parallel, each with domain expertise and anti-patterns (what NOT to flag). They don't see each other's output.

3. **Verification gate** — the orchestrator checks agent findings: verifies facts, challenges severity, dismisses false positives, and synthesizes a verdict (PASS / ITERATE / FAIL).

4. **Iteration loop** — if the verdict is FAIL or ITERATE, the implementer fixes or polishes, and the evaluator re-tests. Up to 10 rounds, with early exit on oscillation.

## Quick Start

### Install

```bash
npm install -g @touchskyer/opc
```

Skill files are automatically copied to `~/.claude/skills/opc/`. If the postinstall fails, run `opc install` manually.

#### Manual install (no npm)

```bash
git clone https://github.com/iamtouchskyer/opc.git
ln -s $(pwd)/opc ~/.claude/skills/opc
```

> **Note:** Symlink tracks the repo — `git pull` updates the skill immediately. Use `cp -r` instead if you want a stable snapshot.

### Use it

```bash
# Review a PR
/opc review the changes in this PR

# Analyze an architecture problem
/opc analyze why the API is slow

# Execute with a plan
/opc implement the migration plan in PLAN.md

# Brainstorm approaches
/opc what are our options for auth?

# Interactive mode — agents ask you questions first
/opc -i review the payment flow

# Explicit roles
/opc security compliance

# Open the report viewer
/opc replay
```

## Task Types

| Task type | When | Pipeline |
|-----------|------|----------|
| **Review** | PR review, audit, pre-launch | Context brief → multi-role evaluation → verification gate → report |
| **Analysis** | Architecture, performance, diagnosis | Context brief → single deep-role evaluation → report |
| **Build** | Direction is set, implement it | Plan → build → independent evaluation → iterate until PASS |
| **Brainstorm** | Options, trade-offs, alternatives | Role perspectives → comparison table → evaluation → recommendation |
| **Plan** | Scope, decompose, estimate | Task decomposition → evaluation → report |
| **Verification** | QA, test, pre-release check | Context brief → multi-role evaluation (verification tags) → report |
| **Post-release** | User test, onboarding check | Context brief → multi-role evaluation (post-release tags) → report |
| **Full pipeline** | Complex or vague request | Design → Plan → Build → Evaluate → Deliver |

## Built-in Roles

### Product
| Role | Focus |
|------|-------|
| **PM** | Requirements, user value, scope, prioritization |
| **Designer** | Interaction design, information architecture, visual system, accessibility |

### User Lens
| Role | Focus |
|------|-------|
| **New User** | First impression, onboarding, setup friction, trust signals |
| **Active User** | Workflow efficiency, power features, scale behavior, customization |
| **Churned User** | Re-entry experience, change communication, win-back signals |

### Engineering
| Role | Focus |
|------|-------|
| **Frontend** | Component architecture, framework patterns, performance, i18n, type safety |
| **Backend** | API design, database, auth, input validation, data consistency |
| **DevOps** | CI/CD, containers, deployment, secrets, monitoring, developer experience |

### Quality
| Role | Focus |
|------|-------|
| **Security** | Vulnerabilities (OWASP), dependency audit, secrets, auth security, attack surface |
| **Tester** | Boundary cases, state coverage, regression risk, integration points |
| **Compliance** | GDPR/CCPA, WCAG accessibility, license compatibility, industry regulations |

## Custom Roles

Add a `.md` file to `roles/` following this format:

```markdown
# Role Name

## Identity
One sentence: who you are and what you care about.

## Expertise
- **Area** — what you know about it
- **Area** — what you know about it
...

## When to Include
- Condition that triggers this role
- Condition that triggers this role
...
```

The coordinator reads `When to Include` to decide whether to dispatch your role. It's available immediately — no configuration needed.

If a task needs expertise not covered by any role file, the coordinator creates a temporary role on-the-fly.

## How Review Works

```
You: /opc review this PR

1. Triage     → Task type: review
2. Roles      → Frontend, Backend, Security (auto-selected from changed files)
3. Brief      → Orchestrator builds context from git log, CLAUDE.md, specs
4. Dispatch   → 3 role evaluators run in parallel, each with role expertise + context
5. Verify     → Mechanical checks auto-reject incomplete outputs (no file:line, no VERDICT).
                 Orchestrator spot-checks facts, challenges severity, deduplicates.
6. Report     → Curated findings with severity, file:line references, and fix suggestions
```

## Requirements

- [Claude Code](https://claude.ai/code) (CLI, desktop app, or IDE extension)
- Node.js ≥ 18 (for npm install only — not needed if you install manually)
- That's it. No runtime dependencies, no build step, no MCP server. Just markdown files.

## Works better with memex (optional)

OPC works standalone — but pair it with [memex](https://github.com/iamtouchskyer/memex) and it learns across sessions. Memex remembers which roles were useful, which findings were false positives, and your project-specific context. OPC doesn't need to know how memex works — memex drives itself.

```bash
npm install -g @touchskyer/memex
```

## Visualize reports (optional)

OPC saves structured reports to `~/.opc/reports/` after every run. Browse them in a web UI:

```bash
npx @touchskyer/opc-viewer
```

Or use `/opc replay` in Claude Code to open the viewer automatically.

The viewer shows a Slack-like replay of your review team's conversation, plus a filterable summary of findings by severity.

## License

MIT
