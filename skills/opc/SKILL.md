---
name: opc
description: "OPC — One Person Company. Task pipeline with independent multi-role evaluation. Builds, reviews, analyzes, and brainstorms with 11 specialist agents. Every task ends with evaluation. Use when asked to '/opc', 'review with multiple agents', 'multi-role evaluation', 'run opc review', 'one person company', 'team review', 'opc build', 'opc analyze', or 'opc brainstorm'."
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
| "plan", "decompose", "break this down", "scope", "estimate", "拆一下" | Plan → Evaluate |
| `mode:A` / `mode:B` / `mode:C` / `mode:D` | Legacy override — A→review, B→analysis, C→build, D→brainstorm |
| "verify", "test", "QA", "check before release", "发布前验收" | Context Brief → Evaluate (multi-role, verification tags) |
| "post-release", "user test", "onboarding check", "用户验收" | Context Brief → Evaluate (multi-role, post-release tags) |
| Complex, vague, or multi-keyword request | Design → Plan → Build → Evaluate → Deliver |

**Priority rules:**
- If user includes `mode:A/B/C/D`, that wins — skip inference.
- If task matches multiple rows (e.g., "review and fix the auth bug"), prefer the row that includes Build — code changes must precede review. When ambiguous, use the full pipeline (last row).
- `/opc <role> [role...]` without a task description = review of the current codebase using the named roles. Enters Context Brief → Evaluate (multi-role).
- `/opc` with no arguments = prompt user to describe their task.

Show triage result:
```
📌 Task type: {review|analysis|build|brainstorm|plan|verification|post-release|full pipeline}
⚡ Interaction: auto / interactive
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

**Before task inference**, check if `.harness/orchestrator-state.md` exists. If so, resume from the recorded state — show user what was saved and confirm before continuing.

Task Inference (above) determines WHICH phases run. The table below determines WHERE to enter if the user provides more or less context than the task verb implies. This table overrides Task Inference's default entry point:

| User has... | Start at... |
|---|---|
| A vague idea or brief | Phase 1 (Design) |
| A spec or design doc | Phase 2 (Plan) — or Phase 3 if already task-decomposed |
| An implementation plan with tasks | Phase 3 (Build) |
| Code that needs evaluation | Phase 4 (Evaluate) |
| Everything done, needs wrap-up | Phase 5 (Deliver) |

Before starting, extract **acceptance criteria** — 3-7 concrete, testable bullet points. Evaluators grade against these. If entering at Phase 4 or 5 directly (no prior phases ran), derive acceptance criteria from the user's task description or existing `.harness/` state. If neither provides enough, ask the user.

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
Product:     pm, designer
User Lens:   new-user, active-user, churned-user
Engineering: frontend, backend, devops
Quality:     security, tester, compliance
```

Role definitions live in `roles/<name>.md`. Add a `.md` file to `roles/` to create a custom role.

### Role Selection

1. **Tag filter** — from Task Inference, you know the task type. Map to stage tags:

| Task type | Stage tags |
|-----------|-----------|
| review, analysis | review |
| build | build |
| brainstorm | brainstorm |
| plan | plan |
| verification | verification |
| post-release | post-release |
| full pipeline | all tags |

   Read the `tags:` front matter from each `roles/<name>.md`. Keep only roles whose tags include at least one matching stage tag. This narrows the candidate pool from 11 to typically 3-6.

2. **Select from filtered pool** — from the filtered candidates, pick 2-5 roles with distinct angles for this specific task. Read each candidate's "When to Include" section to decide relevance.

- Each dispatched agent must have a DISTINCT angle. If two would produce 80%+ overlapping output, pick one.
- Not every task needs every role in the pool. A CSS fix doesn't need Security even if Security is in the verification pool.
- If user specified roles explicitly, use those — skip tag filtering entirely.

**Dynamic Role Creation:** If the task requires expertise not covered by any candidate in the filtered pool, create one on-the-fly following the same format (Identity + Expertise + When to Include + Anti-Patterns). Max 1 dynamic role per invocation.

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

1. **Read (or write, if Phase 2 was skipped) wave plan** at `.harness/wave-N-plan.md` — tasks, acceptance criteria, context from previous waves.

2. **Spawn implementer** using `./pipeline/implementer-prompt.md` in Build mode.

   **With superpowers:** Invoke `superpowers:subagent-driven-development` pointing to the wave plan.
   **Without:** Dispatch an implementer agent with the wave plan.

3. **Validate handoff.** The implementer writes `.harness/handoff-wave-N.md` as part of its job (see implementer-prompt.md step 5). After the implementer returns, verify the handoff file exists and follows the structure in `./pipeline/handoff-template.md`. Fill in any gaps the implementer missed.

4. **Update progress** in `.harness/progress.md`.

**Isolation:** When dispatching multiple implementer agents that modify different files, use `isolation: "worktree"` to prevent merge conflicts.

**Flexibility:** Skip the planner if the task is clear. Combine planner + implementer for simple tasks. Just keep the evaluator independent.

---

## Phase 4: Evaluate

Every task type goes through evaluation. Two paths: **single evaluator** (default) or **multi-role evaluation** (when roles add value).

### Choosing the Evaluation Path

- **Single evaluator:** Use for straightforward tasks: bug fixes touching ≤3 files, config changes, single-concern refactors, or when user explicitly asks for quick evaluation.
- **Multi-role:** Use when the task benefits from multiple specialist perspectives — user requests it, review/audit tasks, security-sensitive builds, tasks touching ≥5 files across multiple concerns, or any task where distinct specialist angles add value.

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

3. **Dispatch role evaluators** in parallel using `./pipeline/role-evaluator-prompt.md`. For each agent: select the matching output format section (Review/Analysis/Brainstorm), delete the other two, and paste into the `{SELECTED_OUTPUT_FORMAT}` placeholder. **Save each agent's agentId** — needed for deep-dive follow-ups. Track role→agentId mappings in memory. If saving state to `.harness/orchestrator-state.md` (context running low), include the agentId mappings. Scope each agent to specific files. If scope exceeds 20 files, split across multiple agents of the same role.

4. **Verification gate.** After all role evaluators return, follow `./pipeline/verification-gate.md` — mechanical checks, spot-checks, deep-dive on threads, synthesis of cross-cutting signals.

5. **Synthesize verdict** using the harness tool:

   ```bash
   opc-harness synthesize . --wave N
   ```

   The output JSON contains the definitive verdict (PASS/ITERATE/FAIL/BLOCKED) based on hardcoded rules: any 🔴 → FAIL, any 🟡 → ITERATE, all LGTM/🔵 → PASS, any BLOCKED → BLOCKED. **Use this verdict. Do not override it with your own judgment.**

   > **Note:** `synthesize` assumes findings are bugs/issues (review use case). For brainstorm/analysis tasks where findings are context markers rather than defects, use the single evaluator path instead.

   Write the verdict and per-role summary into `.harness/evaluation-wave-N.md`. Tag each finding with `[Role]` in the merged evaluation.

---

## Phase 5: Deliver

- **With superpowers:** Invoke `superpowers:finishing-a-development-branch` via the Skill tool.
- **Without:** Commit all work, present a summary, ask how to integrate.

Present results using the appropriate format from `./pipeline/report-format.md`. Save the JSON report.

---

## Verdict Handling

Sanity-check every verdict: it must be clear PASS, ITERATE, or FAIL with evidence. Malformed or evidence-free PASS → re-run with fresh evaluator. Cap malformed-output retries at 2 — after 2 consecutive malformed outputs, surface to user.

**PASS:** Commit the work. Show the assessment. Move to next wave or Phase 5.

**ITERATE:** Quality gaps but criteria pass. Show rubric/findings. Dispatch implementer in Polish mode using `./pipeline/implementer-prompt.md`. Re-run evaluation.

**FAIL:** Criteria failures or critical issues. Show what failed. Dispatch implementer in Fix mode using `./pipeline/implementer-prompt.md`. Re-run evaluation.

**Cap at 10 rounds** (FAIL + ITERATE combined). **Early exit:** detect oscillation programmatically.

Before re-evaluation (FAIL or ITERATE):
1. Rename `.harness/evaluation-wave-N.md` → `.harness/evaluation-wave-N-round{R}.md` (where R is the current round number)
2. Dispatch implementer (Fix or Polish mode)
3. Dispatch evaluator (writes new `.harness/evaluation-wave-N.md`)
4. If R ≥ 2, run oscillation detection:

```bash
opc-harness diff .harness/evaluation-wave-N-round{R-1}.md .harness/evaluation-wave-N-round{R}.md
```

If `oscillation: true`, surface to user after 3 rounds instead of burning through all 10.

---

## File-Based State

```
.harness/
  progress.md                       # Running log
  wave-1-plan.md                    # Tasks and acceptance criteria
  handoff-wave-1.md                 # What was built, how to run it
  evaluation-wave-1.md              # Final verdict (single or merged multi-role)
  evaluation-wave-1-round1.md       # Round 1 evaluation (created on re-evaluation)
  evaluation-wave-1-round2.md       # Round 2 evaluation (created on re-evaluation)
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
