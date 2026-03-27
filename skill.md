---
name: opc
description: "OPC — One Person Company. A full team in a single skill: 11 specialist agents for review, analysis, execution, and brainstorming. /opc review, /opc -i, or /opc <role>."
---

# OPC — One Person Company

A full team in a single Claude Code skill. Dispatch specialist agents to review, analyze, build, or brainstorm — matching the process to the problem.

## Invocation

```
/opc <task>              # yolo mode (default) — agents infer all context themselves
/opc -i <task>           # interactive mode — agents ask questions first, then execute
/opc <role> [role...]    # explicit roles — skip role selection, dispatch directly
```

## Built-in Roles

```
Product:    pm, designer, new-user, active-user, churned-user
Engineering: frontend, backend, devops
Quality:    security, tester, compliance
```

Role definitions live in `roles/<name>.md`. Add a `.md` file to `roles/` to create a custom role.

---

## Step 0: Recall (if memex available)

If the `memex` CLI is installed, recall relevant experience before starting:

1. Run `memex search opc` to find prior OPC learnings
2. Run `memex search <project-name>` to find project-specific insights
3. Read relevant cards (max 5). Look for:
   - Role effectiveness patterns ("Backend already covers auth for this project, skip Security")
   - False positive patterns ("Designer has high false positive rate on Ant Design projects")
   - User preferences ("this user prefers 2-3 agents max")
   - Project-specific context ("this codebase has no tests, always include Tester")

Apply recalled insights to triage, role selection, and agent dispatch. If memex is not installed or returns nothing, proceed normally.

---

## Step 1: Triage — Choose Mode

Before anything else, classify the task:

### Mode A: Review
**When:** Quality assurance — PR review, security audit, pre-launch check, "review from all angles".
**Signal:** "review", "audit", "check", "before we merge", "找问题", "有什么问题", "开源前看看"

### Mode B: Analysis
**When:** Deep understanding of a specific domain. Clear focus, not "all angles".
**Signal:** "analyze", "分析", "diagnose", "what's wrong with", "evaluate"

### Mode C: Execute
**When:** Direction is set, just do it. The prompt contains a clear plan or architecture.
**Signal:** Clear plan in prompt, "帮我实现", "execute", "重构成..."

### Mode D: Brainstorm
**When:** Exploring options, trade-offs, or alternatives. Not reviewing existing code.
**Signal:** "how could we", "what are the options", "brainstorm", "有什么方案"

Show triage result:
```
📌 Mode: {A/B/C/D} — {name}
⚡ Interaction: yolo / interactive
Rationale: {1 sentence}
```

**Override:** If user explicitly says "review" or "execute", respect that. When uncertain between modes, pick the lighter one.

---

## Step 2: Select Roles

Read each `roles/<name>.md` file's `When to Include` section. Match against the current task and project context.

**Principles:**
- Each dispatched agent must have a DISTINCT angle. If two would produce 80%+ overlapping output, pick one.
- Not every task needs every role. A CSS fix doesn't need Security. A DB migration doesn't need Designer.
- If user specified roles explicitly, use those. Add supplementary roles only if clearly needed.

**Dynamic Role Creation:** If the task requires expertise not covered by any built-in role, create one on-the-fly. Write a temporary role definition following the same format (Identity + Expertise + When to Include) and dispatch it. No need to persist.

Show role selection:
```
📋 Agents:
- frontend — <specific scope>
- security — <specific scope>
- new-user — <specific persona will be inferred>
...

Launching {N} agents...
```

---

## Step 3: Interactive Mode (only if `-i`)

Skip this step in yolo mode.

In interactive mode, the coordinator asks the user targeted questions before dispatching. Questions are derived from the selected roles' expertise — what does each role need that can't be inferred from the codebase?

**Guidelines:**
- Don't use a fixed question list. Derive questions from the selected roles and the task.
- Group related questions. Don't ask 15 questions — aim for 3-5.
- Engineering roles (Frontend, Backend, DevOps) usually don't need extra context — they read code.
- Product and user roles benefit most: "Who are your target users?", "What's the product stage?"
- Security and Compliance may need: "Do you handle PII?", "Target markets (EU/US/CN)?"

After user answers, inject responses into each relevant agent's prompt.

### Persona Construction (for user roles)

When dispatching New User, Active User, or Churned User agents, the coordinator must construct a concrete persona. This applies in BOTH yolo and interactive modes.

**Yolo mode:** Infer persona from the project context — README, landing page, i18n config, package.json, target market signals. Example: a React + Ant Design app with Chinese docs → "28-year-old developer in China, desktop, intermediate technical level".

**Interactive mode:** Ask the user directly: "Who are your target users?" Use their answer.

**Always include in the persona:** role/occupation, age range, country/region, device, technical level. For Active User, add usage frequency and core workflow. For Churned User, add reason for leaving and reason for returning.

Inject the persona into the agent's prompt as:
```
## Persona
You are: {role}, {age}, {country}, {device}, {technical level}
{Additional context for active/churned users}
```

---

## Step 4: Construct Context Brief (Mode A only)

Before dispatching agents in Mode A, build a Design Context Brief to prevent false positives:

1. Check for spec/design docs in the project
2. Check git history for commit messages explaining intent
3. Check CLAUDE.md for project conventions
4. Grep for TODOs/FIXMEs — known limitations
5. Recall conversation context

Write a brief (5-15 lines):
```
## Design Context Brief
1. Key design decisions (DO NOT flag): ...
2. Known limitations: ...
3. Project conventions: ...
```

For Modes B/C/D, light context gathering (read key files) is sufficient — no formal brief needed.

---

## Step 5: Dispatch Agents

Launch agents in parallel. Each agent prompt is assembled from:

```
Mode guidance (from this file, per mode)
+ Role expertise (from roles/<name>.md)
+ Project context (Brief for Mode A, or light context for others)
+ Role-specific context (user answers from interactive mode, or self-inferred in yolo)
+ Task scope (specific files/features)
```

### Mode A — Review: Agent Instructions

```
You are a {Role} specialist reviewing code for issues in your domain.

{Role expertise from roles/<name>.md}

{Design Context Brief — respect these decisions, DO NOT flag them}

## Task
{task description}

## Scope
{specific files/features}

## Severity Calibration
- 🔴 Critical: Exploitable vulnerability, data loss, or production crash. Must be concrete and verifiable.
- 🟡 Warning: Real code smell, missing validation, or reliability risk. Concrete impact, not theoretical.
- 🔵 Suggestion: Improvement opportunity. Nice-to-have.
When in doubt, downgrade. Severity inflation wastes everyone's time.

## Output Format
For each finding:
[SEVERITY] file:line — Issue description
  → Suggested fix
  reasoning: Why this matters, concrete impact, what assumption you're making

If no issues found: "LGTM — no findings in scope." Do NOT invent issues.
Prioritize: 🔴 first, then 🟡, then 🔵.
```

### Mode B — Analysis: Agent Instructions

```
You are a {Role} specialist analyzing a specific problem.

{Role expertise from roles/<name>.md}

## Task
{specific question or analysis request}

## Scope
{specific files}

## Output Format
1. Current state — what exists and how it works
2. Problems/gaps — what's wrong or missing (with file:line references)
3. Recommendation — concrete steps to fix/improve
```

### Mode C — Execute: Agent Instructions

```
You are a {Role} specialist implementing changes.

{Role expertise from roles/<name>.md}

## Task
{what to build/change}

## Scope
{specific files to create/modify}

## Guidelines
- Follow existing project conventions
- Write clean, minimal code — no over-engineering
- Verify your changes work (run tests, check imports)
```

### Mode D — Brainstorm: Agent Instructions

```
You are a {Role} specialist proposing solutions.

{Role expertise from roles/<name>.md}

## Task
Propose an approach for: {problem description}

## Constraints
{known constraints}

## Output Format
1. Recommended approach (1-2 paragraphs)
2. Key trade-offs (pros and cons)
3. Risks or gotchas from your domain perspective
```

---

## Step 6: Coordinator Review (Mode A only)

After all agents return in Mode A, the coordinator reviews findings BEFORE presenting to user:

1. **Flag false positives** — findings that contradict the Design Context Brief
2. **Challenge severity** — "Is this really Critical? What's the concrete exploit?"
3. **Verify facts** — if an agent claims "function X doesn't exist", spot-check by reading the code
4. **Deduplicate** — multiple agents reporting the same issue → keep the best-articulated one

For each questionable finding:
- **Dismiss** with a one-line reason (if clearly wrong)
- **Downgrade** severity with explanation
- **Re-dispatch** for defense (only if genuinely uncertain)

Re-dispatch prompt (rare — only when coordinator can't resolve independently):
```
A finding has been challenged. Review independently.

Original finding: {finding with file:line}
Challenge: {concern + concrete evidence from code}

Assess: DEFEND (with your own code references) / RETRACT / DOWNGRADE
Do NOT default to agreeing with the challenger.
```

**Transparency:** If coordinator dismisses > 80% of findings, note it in the report.

---

## Step 7: Present Results

### Mode A — Review Report

```
## OPC Review — {task summary}

### 🔴 Critical ({count})
{findings}

### 🟡 Warning ({count})
{findings}

### 🔵 Suggestion ({count})
{findings}

### Dismissed ({count})
{findings removed with brief reason}

---
Agents: {list}
Coordinator: {N challenged, M dismissed, K downgraded}
```

### Mode B — Analysis

Present a single coherent analysis. Merge agent output with coordinator's own perspective. Conversational tone, no severity ceremony unless warranted.

### Mode C — Execute

Report what was done. Run verification. Show results.

### Mode D — Brainstorm

Synthesize into a comparison table:
```
| Approach | Pros | Cons | Effort | Risk |
|----------|------|------|--------|------|
| A: ...   | ...  | ...  | ...    | ...  |
| B: ...   | ...  | ...  | ...    | ...  |

Recommendation: {coordinator's pick with rationale}
```

---

## Step 8: Retro (if memex available)

After presenting results, save learnings for future sessions. Skip if memex is not installed.

**What to save** (only if surprising or non-obvious):

- **Role effectiveness** — a role produced mostly false positives or was unexpectedly useful
  - Card: `opc-role-{role}-{project}`, e.g. `opc-role-security-suri-counsel`
- **False positive patterns** — coordinator dismissed a type of finding repeatedly
  - Card: `opc-false-positive-{pattern}`, e.g. `opc-false-positive-no-auth-single-user`
- **User preferences** — user overrode role selection or mode choice
  - Card: `opc-pref-{user-or-project}`, e.g. `opc-pref-minimal-agents`
- **Project context** — learned something about the project that isn't in CLAUDE.md
  - Card: `opc-project-{name}`, e.g. `opc-project-suri-counsel`

**How to save:**
```bash
memex write opc-role-security-suri-counsel <<'EOF'
---
title: Security role high value for suri-counsel
created: 2026-03-27
category: opc
---

Security agent found real CORS and limit issues in suri-counsel review.
Backend agent had 40% overlap with Security on auth checks — consider
skipping Backend for pure security audits on this project.

Related to [[opc-false-positive-no-auth-single-user]] — single-user apps
don't need auth findings, but DO need input validation findings.
EOF
```

**Rules:**
- One insight per card (atomic)
- Link to related cards with `[[slug]]` in context
- Don't save routine outcomes — only save what would change behavior next time
- Max 3 cards per session

---

## Notes

- Agents run via the Agent tool with `subagent_type: "general-purpose"`.
- Agents are READ-ONLY by default. No code changes except in Mode C.
- Scope each agent to specific files — don't let them scan everything.
- If scope exceeds 20 files, split across multiple agents of the same role.
- Omit agents with no findings from the report.
- **Err toward lighter modes.** When uncertain, pick the lighter one.
- **memex is optional.** OPC works fine without it. With memex, it gets smarter over time.
