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
6. **Content safety scan** — if this is a public repo, grep for real names, internal project names, internal URLs, API keys, or other PII in ALL files (not just code — include prompts, examples, comments, markdown). Flag anything that looks like a real identifier rather than a generic placeholder.

Write a brief (5-15 lines):
```
## Design Context Brief
1. Key design decisions (DO NOT flag): ...
2. Known limitations: ...
3. Project conventions: ...
4. Content safety: public repo? Any PII/real names/internal refs found?
```

For Modes B/C/D, light context gathering (read key files) is sufficient — no formal brief needed.

---

## Step 5: Dispatch Agents

Launch agents in parallel. Each agent prompt is assembled from:

```
Mode guidance (from this file, per mode)
+ Role expertise (from roles/<name>.md)
+ Role anti-patterns (from roles/<name>.md ## Anti-Patterns — inject as constraints)
+ Project context (Brief for Mode A, or light context for others)
+ Role-specific context (user answers from interactive mode, or self-inferred in yolo)
+ Task scope (specific files/features)
```

### Mode A — Review: Agent Instructions

```
You are a {Role} specialist reviewing code for issues in your domain.

{Role expertise from roles/<name>.md}
{Role anti-patterns from roles/<name>.md — DO NOT exhibit these patterns}

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

## Terminal State (HARD-GATE)
Your output MUST end with exactly one of:
- VERDICT: FINDINGS [N] — you found N real issues (must match actual count)
- VERDICT: LGTM — you found nothing after thorough review
- VERDICT: BLOCKED [reason] — you cannot complete (missing access, unclear scope)

Output not ending with a VERDICT line will be REJECTED and you will be re-dispatched.
```

### Mode B — Analysis: Agent Instructions

```
You are a {Role} specialist analyzing a specific problem.

{Role expertise from roles/<name>.md}
{Role anti-patterns from roles/<name>.md — DO NOT exhibit these patterns}

## Task
{specific question or analysis request}

## Scope
{specific files}

## Output Format
1. Current state — what exists and how it works
2. Problems/gaps — what's wrong or missing (with file:line references)
3. Recommendation — concrete steps to fix/improve

## Terminal State (HARD-GATE)
Your output MUST end with exactly one of:
- VERDICT: ANALYSIS COMPLETE — findings and recommendations provided
- VERDICT: INSUFFICIENT DATA [what's missing] — cannot analyze without more info
- VERDICT: BLOCKED [reason] — cannot complete

Output not ending with a VERDICT line will be REJECTED.
```

### Mode C — Execute: Agent Instructions

```
You are a {Role} specialist implementing changes.

{Role expertise from roles/<name>.md}
{Role anti-patterns from roles/<name>.md — DO NOT exhibit these patterns}

## Task
{what to build/change}

## Scope
{specific files to create/modify}

## Guidelines
- Follow existing project conventions
- Write clean, minimal code — no over-engineering
- Verify your changes work (run tests, check imports)

## Verification (HARD-GATE)
After implementation, you MUST:
1. Run the project's existing test suite (if any). Report pass/fail with output.
2. If no test suite: write and run a verification command that proves the change works.
3. List every file you modified and why (1 line each).
4. State what you did NOT do that the user might expect (explicit scope boundary).

You are NOT done until verification output is shown. Do not claim "done" without evidence.

## Terminal State (HARD-GATE)
Your output MUST end with exactly one of:
- VERDICT: IMPLEMENTED — changes made and verification passed
- VERDICT: PARTIAL [what remains] — some work done, or tests failing (MUST use this if tests fail)
- VERDICT: BLOCKED [reason] — cannot proceed

Output not ending with a VERDICT line will be REJECTED.
```

### Mode D — Brainstorm: Agent Instructions

```
You are a {Role} specialist proposing solutions.

{Role expertise from roles/<name>.md}
{Role anti-patterns from roles/<name>.md — DO NOT exhibit these patterns}

## Task
Propose an approach for: {problem description}

## Constraints
{known constraints}

## Output Format
1. Recommended approach (1-2 paragraphs)
2. Key trade-offs (pros and cons)
3. Risks or gotchas from your domain perspective

## Terminal State (HARD-GATE)
Your output MUST end with exactly one of:
- VERDICT: OPTIONS [N] — N distinct approaches proposed
- VERDICT: RECOMMENDATION [approach] — one clear winner identified
- VERDICT: NEED INPUT [question] — cannot proceed without user decision

Output not ending with a VERDICT line will be REJECTED.
```

---

## Step 6: Verification Gate

CRITICAL: Do Not Trust the Agent Reports.

### Mechanical Checks (HARD-GATE — auto-reject, no judgment needed)

For EVERY agent output, reject if:
1. **No VERDICT line** → REJECT, re-dispatch
2. **No file:line references** (Mode A/B, engineering + quality roles only) → REJECT finding. For user persona roles (new-user, active-user, churned-user), findings must reference a specific step in the user flow or a specific file (README, docs, UI page).
3. **VERDICT count mismatch** (Mode A only) — agent says FINDINGS [3] but only 2 findings in body → REJECT, re-dispatch. Use grep/count tool if available; do not rely on mental arithmetic.
4. **Hedging without evidence** — finding uses "might", "could potentially", "consider" without a concrete scenario → REJECT finding
5. **Mode C: No verification output** — agent claims IMPLEMENTED but shows no test run or verification results → REJECT, re-dispatch

### Spot-Check (Mode A/B — coordinator reads code to verify)

For findings that pass mechanical checks:
1. **Verify facts** — if agent claims "function X doesn't exist", open the file and check
2. **Challenge severity** — "Is this really 🔴? What's the concrete exploit path?"
3. **Deduplicate** — multiple agents reporting same issue → keep best-articulated one

### Effort Check (Mode A/B)

- Count files agent referenced vs files in assigned scope
- If scope ≤ 5 files: coverage must be 100%. If scope > 5 files: coverage ≥ 50%.
- If output is suspiciously thin for scope complexity → RE-DISPATCH with explicit file list
- Mode C: verify all files in scope were addressed. Mode D: check that key constraints were considered.

### Coordinator Actions

For each questionable finding:
- **Dismiss** with one-line reason (clearly wrong or contradicts Design Context Brief)
- **Downgrade** severity with explanation
- **Re-dispatch** for defense (only if genuinely uncertain — use the re-dispatch prompt from below)

Re-dispatch prompt (rare):
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

## Step 8: Learning Loop

After presenting results, the coordinator evaluates whether this session produced non-trivial learnings worth persisting.

### Trigger Conditions (skip if none apply)

- A role was surprisingly effective or produced mostly false positives
- Coordinator dismissed a recurring pattern of findings (not a one-off)
- User overrode role selection or mode choice
- Discovered project-specific context not in CLAUDE.md

If no trigger fires, skip this step entirely. Do NOT prompt on routine sessions.

### Flow

1. Run `which memex` to check if memex is installed.

2. **If installed** → run `memex retro` silently. Memex handles its own logic. Done.

3. **If not installed** → show the user what was learned, then offer:

```
💡 Learning from this session:
   {1-2 sentence concrete insight, e.g. "Security role found real issues on CORS
   and input validation — high value for this project. Backend had 60% overlap
   with Security on auth checks — consider skipping next time."}

   memex can save this across sessions so OPC gets smarter over time.
   Install? → npm install -g @touchskyer/memex
```

4. **Yolo mode behavior**: If the learning is strong (coordinator dismissed >50% findings from a role, or a role found all the critical issues), install memex automatically without asking. If borderline, skip — don't nag.

5. **After install**: run `memex retro` to save the current session's learnings immediately.

---

## Notes

- Agents run via the Agent tool with `subagent_type: "general-purpose"`.
- Agents are READ-ONLY by default. No code changes except in Mode C.
- Scope each agent to specific files — don't let them scan everything.
- If scope exceeds 20 files, split across multiple agents of the same role.
- Omit agents with no findings from the report.
- **Err toward lighter modes.** When uncertain, pick the lighter one.
