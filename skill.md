---
name: opc
version: 0.3.0
description: "OPC — One Person Company. A full team in a single skill: 11 specialist agents for review, analysis, execution, and brainstorming. /opc review, /opc -i, or /opc <role>."
---

# OPC — One Person Company

A full team in a single Claude Code skill. Dispatch specialist agents to review, analyze, build, or brainstorm — matching the process to the problem.

## Invocation

```
/opc <task>              # auto mode (default) — agents infer all context themselves
/opc -i <task>           # interactive mode — agents ask questions first, then execute
/opc <role> [role...]    # explicit roles — skip role selection, dispatch directly
```

Bare `/opc` with no arguments prompts you to describe your task.

## Built-in Roles

```
Product:     pm, designer, new-user, active-user, churned-user
Engineering: frontend, backend, devops
Quality:     security, tester, compliance
```

Role definitions live in `roles/<name>.md`. Add a `.md` file to `roles/` to create a custom role.

---

## Step 1: Triage — Choose Mode

Classify the task using this lookup:

| Mode | Name | When | Signal keywords |
|------|------|------|----------------|
| A | Review | Quality assurance — multiple angles on the same thing | "review", "audit", "check", "before we merge", "找问题", "开源前看看" |
| B | Analysis | Deep dive from one angle — understand root causes | "analyze", "分析", "diagnose", "what's wrong with", "evaluate" |
| C | Execute | Direction is set, implement it | clear plan in prompt, "帮我实现", "execute", "重构成..." |
| D | Brainstorm | Explore options and trade-offs | "how could we", "what are the options", "brainstorm", "有什么方案" |

Rule of thumb: **Review = multiple angles; Analysis = one angle deep.** When uncertain between modes, pick the lighter one.

Show triage result:
```
📌 Mode: {A/B/C/D} — {name}
⚡ Interaction: auto / interactive
Rationale: {1 sentence}
```

**Override:** If user explicitly names a mode, respect that. Users can reply `mode:A/B/C/D` to override after seeing triage.

---

## Step 2: Select Roles

Read each `roles/<name>.md` file's `When to Include` section. Match against the current task and project context.

**Principles:**
- Each dispatched agent must have a DISTINCT angle. If two would produce 80%+ overlapping output, pick one.
- Not every task needs every role. A CSS fix doesn't need Security. A DB migration doesn't need Designer.
- If user specified roles explicitly, use those. Add supplementary roles only if clearly needed.

**Dynamic Role Creation:** If the task requires expertise not covered by any built-in role, create one on-the-fly following the same format (Identity + Expertise + When to Include + Anti-Patterns). Max 1 dynamic role per invocation — prefer adjusting an existing role's scope over creating a new one.

Show role selection:
```
📋 Agents:
- frontend — <specific scope>
- security — <specific scope>
...

Launching {N} agents...
```

---

## Step 3: Interactive Mode (only if `-i`)

Skip this step in auto mode.

In interactive mode, ask targeted questions derived from selected roles — what does each role need that can't be inferred from the codebase? Aim for 3-5 grouped questions.

- Engineering roles usually read code directly — no extra context needed.
- Product and user roles benefit most: "Who are your target users?", "What's the product stage?"
- Security and Compliance may need: "Do you handle PII?", "Target markets?"

### Persona Construction (for user roles)

When dispatching New User, Active User, or Churned User agents, construct a persona:

**Auto mode:** Infer from project context (README, i18n config, package.json). Include only inferable dimensions: technical level, device, locale. Do not fabricate age, occupation, or other details not evidenced in the codebase.

**Interactive mode:** Ask the user: "Who are your target users?" Use their answer.

Inject the persona as:
```
## Persona
You are approaching this product as a {new/active/churned} user.
Background: {technical level}, {device}, {locale}
{For active: usage frequency + core workflow}
{For churned: plausible reason for leaving + reason for returning}
```

---

## Step 4: Construct Context Brief (Mode A only)

Before dispatching agents in Mode A, build a Design Context Brief to prevent false positives.

**Light reviews** (scope ≤ 3 files, no security/compliance roles): skip full brief, use light context (read key files) same as Mode B/C/D.

**Full brief** (all other Mode A reviews):

1. Check for spec/design docs in the project
2. Check git history for commit messages explaining intent
3. Check CLAUDE.md for project conventions
4. Grep for TODOs/FIXMEs — known limitations
5. Recall conversation context
6. **Content safety scan** — if public repo, grep for real names, internal URLs, API keys, PII in all files (not just code). Flag real identifiers.

Write a brief (5-15 lines):
```
## Design Context Brief
1. Key design decisions (respect these, do not flag): ...
2. Known limitations: ...
3. Project conventions: ...
4. Content safety: public repo? Any PII/real names found?
```

---

## Step 5: Dispatch Agents

### Dispatch Rules

- Agents run via the Agent tool with `subagent_type: "general-purpose"`. **Save each agent's agentId** — you need it for deep-dive follow-ups in Step 6a.
- Agents receive only their mode template + role file content. The coordinator reads skill.md; agents do not.
- Agents are READ-ONLY by default. Only Mode C agents make code changes.
- Scope each agent to specific files — broad "scan everything" scopes produce shallow results.
- If scope exceeds 20 files, split across multiple agents of the same role. Merge their findings during verification.

### Dependency Check (before dispatch)

Check if any agent's analysis depends on another's output:

| Dependency | Example |
|-----------|---------|
| Agent A informs Agent B | Backend maps auth flow → Security audits it |
| Agent A constrains Agent B | DevOps reveals infra limits → Backend reviews against them |
| Agent A scopes Agent B | PM clarifies requirements → all others review against them |

- **If no dependencies (common case):** dispatch all agents in parallel.
- **If dependencies exist:** dispatch the upstream agent first (foreground, not parallel). When it returns, extract the specific outputs the downstream agent needs — usually 3-5 key lines, not the full report. Inject as: `Upstream context from {Role A}: {extracted points}.` Then dispatch the downstream agent.

### Mode C: Isolation

When dispatching multiple Mode C agents that modify different files, use `isolation: "worktree"` to give each agent its own git worktree. This prevents merge conflicts from parallel writes.

If only one Mode C agent is dispatched, worktree isolation is unnecessary.

### Agent Prompt Template

All modes share this skeleton. Fill in `{{placeholders}}` from the role file and mode-specific sections below.

```
You are a {{Role}} specialist.

{{Role expertise from roles/<name>.md}}

## Anti-Patterns (behaviors to avoid)
{{Role anti-patterns from roles/<name>.md}}

## Quality Gate (applies to all roles)
- Every finding must pass the "so what?" test: if someone asks "what happens if we ignore this?", you must have a concrete answer.
- Findings that begin with "consider" or "it might be good to" without a concrete scenario are noise. Rewrite as specific issues or delete.
- If you reviewed the scope and found 0 issues: say LGTM. Do not manufacture findings to appear thorough.
- If >50% of your findings are 🔴 Critical, re-calibrate — you are almost certainly severity-inflating.

{{MODE-SPECIFIC SECTION — see below}}

## Terminal State
Your output MUST end with one of the VERDICT options listed in your mode section.
```

### Mode A — Review (insert into template)

```
{{Design Context Brief — respect these decisions, do not flag them}}

## Process
Before listing findings:
1. Read all files in scope. Note what the code DOES, not what it SHOULD do.
2. Identify the author's intent from patterns, naming, comments, git history.
3. Only then look for gaps between intent and implementation.
Your findings must emerge from this understanding, not from a checklist.

## Task
{{task description}}

## Scope
{{specific files/features}}

## Severity Calibration
- 🔴 Critical: Exploitable vulnerability, data loss, or production crash. Concrete and verifiable.
- 🟡 Warning: Real code smell, missing validation, or reliability risk. Concrete impact.
- 🔵 Suggestion: Improvement opportunity. Nice-to-have.
When in doubt, downgrade.

## Output Format
For each finding:
[SEVERITY] file:line — Issue description
  → Suggested fix
  reasoning: Why this matters, concrete impact, what assumption you're making

If no issues found: "LGTM — no findings in scope."
Prioritize: 🔴 first, then 🟡, then 🔵.

## Threads
After your findings, list 0-3 areas you noticed but couldn't fully resolve in this pass — things that need deeper tracing across files, or where you're uncertain about root cause. The coordinator may ask you to go deeper on these via follow-up.

## VERDICT (pick one)
- VERDICT: FINDINGS [N] — N real issues (must match actual count)
- VERDICT: LGTM — nothing found after thorough review
- VERDICT: BLOCKED [reason] — cannot complete
```

### Mode B — Analysis (insert into template)

```
## Task
{{specific question or analysis request}}

## Scope
{{specific files}}

## Output Format
1. Current state — what exists and how it works
2. Root cause analysis — WHY is it this way? What constraints led here?
3. Problems/gaps — what's wrong or missing (with file:line references)
4. Recommendation — concrete steps, with trade-offs acknowledged

## Threads
List 0-3 areas worth deeper investigation that you couldn't fully resolve.

## VERDICT (pick one)
- VERDICT: ANALYSIS COMPLETE — findings and recommendations provided
- VERDICT: INSUFFICIENT DATA [what's missing] — cannot analyze without more info
- VERDICT: BLOCKED [reason] — cannot complete
```

### Mode C — Execute (insert into template)

```
## Task
{{what to build/change}}

## Scope
{{specific files to create/modify}}

## Guidelines
- Match the existing code style exactly
- No new dependencies without stating why
- If the plan is ambiguous, ask — do not assume

## Verification
After implementation, you MUST:
1. Run the project's existing test suite (if any). Report pass/fail with output.
2. If no test suite: write and run a verification command that proves the change works.
3. List every file you modified and why (1 line each).
4. State what you did NOT do that the user might expect (explicit scope boundary).

You are not done until verification output is shown.

## VERDICT (pick one)
- VERDICT: IMPLEMENTED — changes made and verification passed
- VERDICT: PARTIAL [what remains] — some work done, or tests failing
- VERDICT: BLOCKED [reason] — cannot proceed
```

### Mode D — Brainstorm (insert into template)

```
## Task
Propose approaches for: {{problem description}}

## Constraints
{{known constraints}}

## Process
1. Generate at least 3 distinct approaches (not variations of the same idea).
2. For each: state the core insight that makes it viable.
3. Evaluate trade-offs across all approaches.
4. Only then form a recommendation (or say "depends on X").

## Output Format
For each approach:
1. Core insight (1-2 sentences)
2. Trade-offs (pros and cons)
3. Risks from your domain perspective

## VERDICT (pick one)
- VERDICT: OPTIONS [N] — N distinct approaches proposed
- VERDICT: RECOMMENDATION [approach] — one clear winner identified
- VERDICT: NEED INPUT [question] — cannot proceed without user decision
```

---

## Step 6: Verification Gate

Verify agent outputs before reporting. Scale verification effort to the task.

### Tier 1: Mechanical Checks (always, all modes)

For every agent output:
1. **VERDICT present?** — if missing, re-dispatch with explicit reminder.
2. **Dedup** — multiple agents reporting same issue → keep best-articulated one.
3. **Hedging without evidence** — finding uses "might", "could potentially", "consider" without a concrete scenario → reject the finding.

### Tier 2: Spot-Check (Mode A/B only, scale by severity)

**For 🔴 Critical findings — actively try to disprove:**
- Read the code the finding references. Does it actually say what the agent claims?
- Check if the issue is mitigated elsewhere (middleware, config, upstream validation).
- Ask: "If I were the author, why would I have written it this way?"
- If you can't disprove it after genuine effort, it's real.

**For 🟡 Warning findings — quick verify:**
- Binary fact checks: "does function X exist?", "is line 42 really `any` type?" → read the file, confirm.
- If the fact is wrong, reject the finding.

**For 🔵 Suggestion findings:** accept at face value unless obviously wrong.

**When two agents disagree on the same issue:** re-dispatch a focused agent to arbitrate.

### Tier 3: Effort Check (Mode A/B only, large reviews)

Only for reviews with ≥ 5 agents or ≥ 10 files in scope:
- Count files each agent referenced vs assigned scope. If suspiciously thin, re-dispatch with explicit file list.

### Coordinator Actions

For questionable findings:
- **Dismiss** with one-line reason
- **Downgrade** severity with explanation
- **Re-dispatch** for defense (targeted re-dispatch prompt below)

Re-dispatch prompt:
```
A finding has been challenged. Review independently.

Original finding: {{finding with file:line}}
Challenge: {{concern + concrete evidence from code}}

Assess: DEFEND (with your own code references) / RETRACT / DOWNGRADE
```

**Re-dispatch ceiling: 2 rounds max** (initial dispatch = round 1, one re-dispatch round). If still unresolved, accept with ⚠️ and move on.

**Transparency:** If you dismiss > 80% of findings, note it in the report.

### Verification Output

**Small reviews** (≤ 3 findings, no 🔴): inline verification notes with findings. No table needed.

**Large reviews** (> 3 findings or any 🔴): show verification log:

```
## Verification Log

| Agent | Checks | Spot-Checks | Action |
|-------|--------|-------------|--------|
| {role} | ✅/❌ | What you verified | N dismissed, M downgraded |
```

**Mode D (Brainstorm):** skip verification entirely — brainstorm output is exploratory by nature.

---

## Step 6a: Deep Dive (Mode A/B only)

After verification, review each agent's **Threads** section. For threads worth pursuing:

Use **SendMessage(agentId)** to resume the original agent — it keeps its full context (files read, reasoning, findings). Do not re-spawn.

```
The coordinator reviewed your findings and threads.

Go deeper on: {{specific thread}}
Trace the root cause across files. Update your findings if this changes severity or adds new issues.
```

**When to deep-dive:** Thread describes a cross-file dependency, uncertain root cause, or a finding whose severity depends on tracing further.

**When to skip:** Agent returned LGTM with no threads, or threads are minor. If no agent has threads worth pursuing, proceed to Step 6b.

**Ceiling:** Follow up with at most 3 agents. Deep-dive is for depth on the most interesting threads, not completeness.

Deep-dive responses inherit the agent's original VERDICT format. Apply Tier 1 mechanical checks to updated output.

---

## Step 6b: Synthesis Round (conditional)

After deep dive (or after verification if no deep dive), check for cross-cutting signals:

- Agent A found X, which changes the context for Agent B's domain → dispatch B with A's finding as input
- Two agents produced contradictory recommendations → dispatch a focused arbitrator
- Round 1 revealed a domain not covered by any dispatched agent → dispatch new role

**Decision:** Run synthesis only when findings genuinely interact and the answer matters. Do not synthesize for completeness. If no signals exist, proceed to Step 7.

Synthesis agents receive: the specific finding from another agent + the targeted question. Not all findings (noise reduction).

**Synthesis outputs must pass Tier 1 mechanical checks** (VERDICT present, dedup, hedging). Skip Tier 2/3 — synthesis agents are focused follow-ups, not broad reviews.

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

**Viewer:** Past reports can be browsed with `npx @touchskyer/opc-viewer` — see Step 8.

---

## Step 8: Save Report

After presenting results, save a structured JSON report for the OPC Viewer.

**Directory:** `~/.opc/reports/` (create if it doesn't exist)
**Filename:** `{YYYY-MM-DD}T{HH-mm-ss}_{mode}_{sanitized-task-summary}.json`

Use the Bash tool to create the directory, then the Write tool to save the JSON file.

### JSON Schema

```json
{
  "version": "1.0",
  "timestamp": "<ISO 8601>",
  "mode": "<review|analysis|execute|brainstorm>",
  "task": "<original task description>",
  "agents": [
    {
      "role": "<role name>",
      "scope": ["<file paths>"],
      "verdict": "<VERDICT string>",
      "findings": [
        {
          "severity": "<critical|warning|suggestion>",
          "file": "<file path>",
          "line": null,
          "issue": "<issue description>",
          "fix": "<suggested fix>",
          "reasoning": "<why this matters>",
          "status": "<accepted|dismissed|downgraded>",
          "dismissReason": "<reason if dismissed/downgraded, null otherwise>"
        }
      ]
    }
  ],
  "coordinator": {
    "challenged": 0,
    "dismissed": 0,
    "downgraded": 0
  },
  "summary": {
    "critical": 0,
    "warning": 0,
    "suggestion": 0
  },
  "timeline": [
    {
      "type": "<triage|roles|context|dispatch|agent-output|verification|deep-dive|deep-dive-response|synthesis|report>",
      "role": "<coordinator or agent role name>",
      "content": "<message content>"
    }
  ]
}
```

### Timeline

The `timeline` array records each step as a message for the Replay view:

1. **triage** (coordinator): "Mode: REVIEW\nTask: {task}"
2. **roles** (coordinator): "Dispatching N agents: {role1}, {role2}..."
3. **context** (coordinator): Design Context Brief summary (Mode A only)
4. **dispatch** (coordinator): "Agents running..."
5. **agent-output** (each role): verdict + findings as "🔴/🟡/🔵 file:line — issue"
6. **verification** (coordinator): "N challenged, M dismissed..." with details
7. **deep-dive** (coordinator): "Following up with N agents on threads..." (Step 6a)
8. **deep-dive-response** (each followed-up role): Updated/new findings from deeper investigation
9. **synthesis** (coordinator): Cross-cutting findings if any (Step 6b)
10. **report** (coordinator): "Final: N 🔴, N 🟡, N 🔵"

**Rules:**
- Sanitize task summary for filename: lowercase, hyphens for spaces, keep CJK characters, strip only punctuation and control chars, max 50 chars
- Only include dispatched agents
- `summary` counts only `status: "accepted"` findings
- Mode B: findings without severity default to `"suggestion"`
- Mode C: empty findings array, just the verdict
- Mode D: approaches as findings with severity `"suggestion"`

---

## Notes

- If scope exceeds 20 files, split across multiple agents of the same role.
- Omit agents with no findings from the report.
- Err toward lighter modes when uncertain.

**Viewer:** Reports can be browsed with `npx @touchskyer/opc-viewer`. Use `/opc replay` to open the viewer automatically.

When launching the viewer, always tell the user what's running:
```
🖥️ Opening OPC Viewer...
Running: npx @touchskyer/opc-viewer
(First run may take a moment to download the package)
```

If npx fails, show install instructions before falling back to terminal output:
```
⚠️ Could not launch OPC Viewer automatically.

To install manually:
  npm install -g @touchskyer/opc-viewer
  opc-viewer

Or run without installing:
  npx @touchskyer/opc-viewer
```
