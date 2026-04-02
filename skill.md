---
name: opc
version: 0.4.0
description: "OPC — One Person Company. Task pipeline with independent multi-role evaluation. Builds, reviews, analyzes, and brainstorms with 11 specialist agents. Every task ends with evaluation. /opc <task>, /opc -i <task>, /opc <role> [role...]"
---

# OPC — One Person Company

One principle: **the agent that does the work never evaluates it.**

A full team in a single skill. The pipeline handles any task — building code, reviewing code, analyzing problems, brainstorming designs. It infers which phases to run from the task itself, and every path ends with independent evaluation.

## Invocation

```
/opc <task>              # auto mode — infer phases and roles from the task
/opc -i <task>           # interactive mode — ask questions before dispatch
/opc <role> [role...]    # explicit roles — skip role selection, dispatch directly
```

## Task Inference

The pipeline reads the task and decides what to do. Every path ends with evaluation.

| Task says... | Phases to run |
|---|---|
| "review", "audit", "check", "before we merge", "找问题", "开源前看看" | Context Brief → Evaluate (multi-role) |
| "analyze", "diagnose", "what's wrong with", "分析" | Context Brief → Evaluate (single deep role) |
| "build", "implement", "create", "fix bug", "帮我实现", "重构成..." | Build → Evaluate |
| "brainstorm", "explore options", "what are the approaches", "有什么方案" | Design (with role perspectives) → Evaluate |
| "plan", "decompose", "break this down" | Plan → Evaluate |
| Complex or vague request | Design → Plan → Build → Evaluate → Deliver |

**Legacy mode override:** Users can still use `mode:A/B/C/D` — map A→review, B→analysis, C→build, D→brainstorm.

Show triage result:
```
📌 Task type: {review|analysis|build|brainstorm|plan|full pipeline}
⚡ Interaction: auto / interactive
📋 Phases: {which phases will run}
Rationale: {1 sentence}
```

**Override:** If user explicitly names a task type, respect that. Users can adjust after seeing triage.

## Scaling to Complexity

| Task looks like... | Waves |
|---|---|
| Bug fix, small feature, refactor, config change | 1 wave, skip Design/Plan phases |
| Clear spec with a few tasks, single-session work | 1 wave |
| Multi-feature project, full app, large plan | Multiple waves |
| Task touching many files across multiple concerns | Multiple waves |

**Default to 1 wave.** Only use multiple waves when genuinely needed.

## Getting Started

| User has... | Start at... |
|---|---|
| A vague idea or brief | Phase 1 (Design) |
| A spec or design doc | Phase 2 (Plan) — or Phase 3 if already task-decomposed |
| An implementation plan with tasks | Phase 3 (Build) |
| Code that needs evaluation | Phase 4 (Evaluate) |
| Everything done, needs wrap-up | Phase 5 (Deliver) |

Before starting, extract **acceptance criteria** — 3-7 concrete, testable bullet points. Evaluators grade against these.

```bash
mkdir -p .harness
```

### Interactive Mode (only if `-i`)

Ask targeted questions derived from selected roles — what does each role need that can't be inferred from the codebase? Aim for 3-5 grouped questions.

- Engineering roles usually read code directly — no extra context needed.
- Product and user roles benefit most: "Who are your target users?", "What's the product stage?"
- Security and Compliance may need: "Do you handle PII?", "Target markets?"

**Persona construction** for user roles (new-user, active-user, churned-user): In auto mode, infer from project context (README, i18n, package.json) — technical level, device, locale only. In interactive mode, ask the user directly. Inject as: `## Persona\nYou are approaching this product as a {new/active/churned} user.\nBackground: {details}`

### Project Context

Subagents don't inherit CLAUDE.md or project instructions automatically. When dispatching any subagent, **forward relevant project context**: dev workflow rules, precommit checks, coding conventions, test commands. Include this in every subagent prompt.

### Superpowers Integration

If `superpowers` skills are available, use them: brainstorming for design, plan writing, subagent-driven development for build, and branch delivery.

---

## Built-in Roles

```
Product:     pm, designer, new-user, active-user, churned-user
Engineering: frontend, backend, devops
Quality:     security, tester, compliance
```

Role definitions live in `roles/<name>.md`. Add a `.md` file to `roles/` to create a custom role.

### Role Selection

Read each `roles/<name>.md` file's "When to Include" section. Match against the task and project context.

- Each dispatched agent must have a DISTINCT angle. If two would produce 80%+ overlapping output, pick one.
- Not every task needs every role. A CSS fix doesn't need Security. A DB migration doesn't need Designer.
- If user specified roles explicitly, use those. Add supplementary roles only if clearly needed.

**Dynamic Role Creation:** If the task requires expertise not covered by any built-in role, create one on-the-fly following the same format (Identity + Expertise + When to Include + Anti-Patterns). Max 1 dynamic role per invocation.

Show role selection:
```
📋 Agents:
- frontend — <specific scope>
- security — <specific scope>
...

Launching {N} agents...
```

---

## Phase 1: Design (optional)

Only needed when starting from a vague idea.

- **With superpowers:** Invoke `superpowers:brainstorming` via the Skill tool.
- **Without:** Spawn a planner agent to explore the idea, research the codebase, and produce a design doc with features and scope.

The design must include **explicit acceptance criteria** per feature.

**Checkpoint:** Show the user the design and get approval.

---

## Phase 2: Plan (optional)

Only needed when you have a spec but no task decomposition.

- **With superpowers:** Invoke `superpowers:writing-plans` via the Skill tool.
- **Without:** Spawn a planner agent to decompose the spec into tasks. Write to `.harness/wave-N-plan.md`.

The plan must include: task decomposition, acceptance criteria per wave, and dependencies.

**Checkpoint:** Show the user the plan and get approval.

---

## Phase 3: Build (skip for review/analysis/evaluate-only tasks)

Run this phase once per wave.

1. **Write wave plan** to `.harness/wave-N-plan.md` — tasks, acceptance criteria, context from previous waves.

2. **Spawn implementer** using `./pipeline/implementer-prompt.md` in Build mode.

   **With superpowers:** Invoke `superpowers:subagent-driven-development` pointing to the wave plan.
   **Without:** Dispatch an implementer agent with the wave plan.

3. **Write handoff** to `.harness/handoff-wave-N.md` using `./pipeline/handoff-template.md`.

4. **Update progress** in `.harness/progress.md`.

**Isolation:** When dispatching multiple implementer agents that modify different files, use `isolation: "worktree"` to prevent merge conflicts.

**Flexibility:** Skip the planner if the task is clear. Combine planner + implementer for simple tasks. Just keep the evaluator independent.

---

## Phase 4: Evaluate

Every task type goes through evaluation. Two paths: **single evaluator** (default) or **multi-role evaluation** (when roles add value).

### Choosing the Evaluation Path

- **Single evaluator:** Use when no `roles/` directory exists, or the task is straightforward and one evaluator suffices.
- **Multi-role:** Use when the task benefits from multiple specialist perspectives — user requests it, review/audit tasks, security-sensitive builds, or any task where distinct specialist angles add value.

### Context Brief (review/analysis tasks only)

Before dispatching evaluators for review or analysis tasks, build a context brief. Read `./pipeline/context-brief.md` for the procedure.

### Single Evaluator

Dispatch one evaluator using `./pipeline/evaluator-prompt.md`. Fill in wave number, acceptance criteria, handoff path, progress path, working directory, and project context.

The evaluator writes `.harness/evaluation-wave-N.md` with PASS, ITERATE, or FAIL.

### Multi-Role Evaluation

1. **Select roles** per the Role Selection rules above.

2. **Dependency check** before dispatch:
   - If no dependencies (common case): dispatch all agents in parallel.
   - If dependencies exist (e.g., backend maps auth flow → security audits it): dispatch upstream agent first, extract 3-5 key lines, inject as upstream context, then dispatch downstream.

3. **Dispatch role evaluators** in parallel using `./pipeline/role-evaluator-prompt.md`. **Save each agent's agentId** — needed for deep-dive follow-ups. Scope each agent to specific files. If scope exceeds 20 files, split across multiple agents of the same role.

4. **Verification gate.** After all role evaluators return, follow `./pipeline/verification-gate.md` — mechanical checks, spot-checks, deep-dive on threads, synthesis of cross-cutting signals.

5. **Synthesize verdict** into `.harness/evaluation-wave-N.md`:
   - Any role has validated 🔴 Critical findings → **FAIL**
   - All criteria pass but roles have 🟡 Warning findings affecting quality → **ITERATE**
   - All roles return LGTM or only 🔵 Suggestions → **PASS**
   - Tag each finding with `[Role]` in the merged evaluation.

---

## Phase 5: Deliver

- **With superpowers:** Invoke `superpowers:finishing-a-development-branch` via the Skill tool.
- **Without:** Commit all work, present a summary, ask how to integrate.

Present results using the appropriate format from `./pipeline/report-format.md`. Save the JSON report.

---

## Verdict Handling

Sanity-check every verdict: it must be clear PASS, ITERATE, or FAIL with evidence. Malformed or evidence-free PASS → re-run with fresh evaluator.

**PASS:** Commit the work. Show the assessment. Move to next wave or Phase 5.

**ITERATE:** Quality gaps but criteria pass. Show rubric/findings. Dispatch implementer in Polish mode using `./pipeline/implementer-prompt.md`. Re-run evaluation.

**FAIL:** Criteria failures or critical issues. Show what failed. Dispatch implementer in Fix mode using `./pipeline/implementer-prompt.md`. Re-run evaluation.

**Cap at 10 rounds** (FAIL + ITERATE combined). Surface to user if not resolved.

---

## File-Based State

```
.harness/
  progress.md                       # Running log
  wave-1-plan.md                    # Tasks and acceptance criteria
  handoff-wave-1.md                 # What was built, how to run it
  evaluation-wave-1.md              # Final verdict (single or merged multi-role)
  evaluation-wave-1-security.md     # Per-role evaluation (multi-role only)
  evaluation-wave-1-tester.md       # Per-role evaluation (multi-role only)
```

Even for single-wave tasks, use `.harness/` files.

---

## Prompt Templates

All templates live in `./pipeline/`:

- `evaluator-prompt.md` — Single generic evaluator
- `role-evaluator-prompt.md` — Role-specific evaluator (review, analysis, brainstorm outputs)
- `implementer-prompt.md` — Implementer (Build / Fix / Polish modes)
- `handoff-template.md` — Handoff file structure
- `context-brief.md` — Design context brief procedure
- `verification-gate.md` — 3-tier verification + deep-dive + synthesis
- `report-format.md` — Presentation templates + JSON schema + replay

---

## Resilience

**Agent spawn failures:** Retry once. If it fails again, surface to user.

**Context running low:** Write state to `.harness/orchestrator-state.md` (phase, wave, what's done, what's next). Tell user to re-invoke.

**Fresh context per agent.** Always spawn new subagents. Files carry state; agents bring fresh capacity.
