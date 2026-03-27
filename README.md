# Swarm

Adaptive agent orchestrator for [Claude Code](https://claude.ai/code). Dispatches specialist sub-agents for code review, analysis, execution, or brainstorming — matching the process to the problem.

## What Makes This Different

Most multi-agent orchestrators run a fixed pipeline: split task → dispatch agents → merge results. Swarm does three things differently:

1. **Adaptive triage** — not every task needs the same process. Swarm picks from 4 modes (Review, Analysis, Execute, Brainstorm) based on what you're actually asking for.

2. **Adversarial quality control** — in Review mode, a coordinator challenges agent findings before presenting them to you. It verifies facts, questions severity, and dismisses false positives. You get a curated report, not a dump of everything agents said.

3. **Yolo + Interactive** — by default, agents infer all context themselves from your codebase (yolo). Add `-i` and agents ask you targeted questions first, then review with precise context.

## Quick Start

### Install as a Claude Code skill

```bash
# Copy to your skills directory
cp -r . ~/.claude/skills/swarm/

# Or symlink for easy updates
ln -s $(pwd) ~/.claude/skills/swarm
```

### Use it

```bash
# Review a PR
/swarm review the changes in this PR

# Analyze an architecture problem
/swarm analyze why the API is slow

# Execute with a plan
/swarm implement the migration plan in PLAN.md

# Brainstorm approaches
/swarm what are our options for auth?

# Interactive mode — agents ask you questions first
/swarm -i review the payment flow

# Explicit roles
/swarm security compliance
```

## Modes

| Mode | When | Process |
|------|------|---------|
| **Review** | PR review, audit, pre-launch | Full pipeline: role selection → context brief → parallel agents → adversarial Round 2 → synthesized report |
| **Analysis** | Architecture, performance, diagnosis | 1-2 focused experts → coordinator synthesis |
| **Execute** | Direction is set, just do it | Explore → plan → implement → verify |
| **Brainstorm** | Options, trade-offs, alternatives | Multiple perspectives → comparison table → recommendation |

## Built-in Roles

### Product
| Role | Focus |
|------|-------|
| **PM** | Requirements, user value, scope, prioritization |
| **Designer** | Interaction design, information architecture, visual system, accessibility |
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

## How Review Mode Works

```
You: /swarm review this PR

1. Triage     → Mode A: Review
2. Roles      → Frontend, Backend, Security (auto-selected from changed files)
3. Brief      → Coordinator builds context from git log, CLAUDE.md, specs
4. Dispatch   → 3 agents run in parallel, each with role expertise + context
5. Round 2    → Coordinator challenges findings:
                 - "Is this really Critical?"
                 - "Agent says function X doesn't exist — let me check... it does. Dismissed."
                 - "Two agents reported the same CORS issue — keeping the better one."
6. Report     → Curated findings with severity, file:line references, and fix suggestions
```

## Learning with memex (optional)

OPC integrates with [memex](https://github.com/iamtouchskyer/memex) — a Zettelkasten memory system for AI agents. When memex is installed, OPC:

- **Recalls** past review insights before starting (which roles worked, false positive patterns, project context)
- **Saves** new learnings after each session (role effectiveness, user preferences, project quirks)

OPC gets smarter over time — it won't repeat the same false positives, and it learns your preferences across sessions.

```bash
# Install memex (optional)
npm install -g @touchskyer/memex

# OPC auto-detects memex and uses it. No configuration needed.
```

Without memex, OPC works fine — it just starts from zero every session.

## Requirements

- [Claude Code](https://claude.ai/code) (CLI, desktop app, or IDE extension)
- That's it. No dependencies, no build step, no MCP server. Just markdown files.
- Optional: [memex](https://github.com/iamtouchskyer/memex) for cross-session learning

## License

MIT
