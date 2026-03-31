---
name: harness
description: Build-and-verify pipeline that auto-scales to task complexity. For small tasks (bug fixes, features, refactors), runs a single wave. For complex tasks (multi-feature, full apps, large plans), runs multiple waves with structured evaluation. The core principle is always the same — the agent that writes the code never verifies it. Use when user says "harness", "gan", "generate and verify", "plan build verify", "autonomous build", or has any task that benefits from independent verification. Works for everything from a one-line fix to a full-stack app.
---

# Harness: Build and Verify

One principle: **the agent that writes the code never verifies it.**

Every task — from a one-line fix to a full-stack app — runs through the same pipeline: plan, build, evaluate. The only difference is how many waves it takes.

## Scaling to complexity

| Task looks like... | Waves |
|---|---|
| Bug fix, small feature, refactor, config change | 1 wave, skip Design/Plan phases |
| Clear spec with a few tasks, single-session work | 1 wave |
| Multi-feature project, full app, large plan | Multiple waves |
| Task touching many files across multiple concerns | Multiple waves |

**Default to 1 wave.** Only use multiple waves when the task genuinely needs it. When in doubt, start with 1 wave — you can always add more.

## Getting started

Assess what the user already has:

| User has... | Start at... |
|---|---|
| A vague idea or brief | Phase 1 (Design) |
| A spec or design doc | Phase 2 (Plan) — or Phase 3 if already task-decomposed |
| An implementation plan with tasks | Phase 3 (Build) |
| Code that needs QA | Phase 4 (Evaluate) |
| Everything done, needs wrap-up | Phase 5 (Deliver) |

**The most common entry point is Phase 3** — the user has a plan (or a clear task) and wants it executed with quality gates.

Before starting, you always need **acceptance criteria**. Extract concrete, testable criteria from the task description or spec — 3-7 bullet points, each a specific verifiable behavior (e.g., "clicking X shows Y", "API returns 200 with field Z"). The evaluator grades against these, so they must be unambiguous.

Set up the workspace:

```bash
mkdir -p .harness
```

### Superpowers integration (recommended)

If `superpowers` skills are available, use them across phases — structured brainstorming for design, rigorous plan writing, per-task implementation with spec/quality review, and branch delivery.

**If superpowers is not installed:** Tell the user: "The harness is more effective with the superpowers skill pack — it provides structured brainstorming, task planning, per-task implementation with spec/quality review, and branch delivery workflows. I'd recommend installing it: `claude install superpowers@superpowers-marketplace`. I can proceed without it, but the quality of each phase will be lower." Then proceed with the "Without" path if they choose not to install.

### Project context

Subagents don't inherit CLAUDE.md or project instructions automatically. When dispatching any subagent (planner, implementer, evaluator), **forward relevant project context**: dev workflow rules, precommit checks, coding conventions, test commands, and any project-specific constraints. Include this in every subagent prompt.

---

## Phase 1: Design (optional)

Only needed when starting from a vague idea.

- **With superpowers:** Invoke `superpowers:brainstorming` via the Skill tool.
- **Without:** Spawn a planner agent (Agent tool, subagent_type: "general-purpose") to explore the idea, research the codebase, and produce a design doc with features and scope.

Either way, the design must include **explicit acceptance criteria** per feature. Verify they're present and concrete. If not, write them yourself.

**Checkpoint:** Show the user the design and get approval.

---

## Phase 2: Plan (optional)

Only needed when you have a spec but no task decomposition. For simple tasks (bug fix, small feature), skip this — go straight to Build with a single wave.

- **With superpowers:** Invoke `superpowers:writing-plans` via the Skill tool.
- **Without:** Spawn a planner agent to decompose the spec into tasks. Write the plan to `.harness/wave-N-plan.md`.

The plan must include:
- Task decomposition (waves for large work, flat list for smaller work)
- Acceptance criteria per wave/group
- Dependencies — flag tightly coupled tasks

**Checkpoint:** Show the user the plan and get approval.

---

## Phase 3: Build

Takes a plan (any format) and executes it with quality gates. Run this phase once per wave. A simple task is just 1 wave.

### Prepare the build context

1. **Write a wave plan file** to `.harness/wave-N-plan.md`. Include:
   - The tasks to build (paste full text from the user's plan, or the task description for simple tasks)
   - Acceptance criteria for this wave
   - Context from previous waves if applicable

### Execute the tasks

2. **Spawn a planner agent** (optional — skip if the task/plan is already clear):
   - Give it the wave plan and relevant context
   - Ask it to produce a concrete implementation plan: what to change, where, and why
   - The planner reads code and returns a plan — it does not implement anything

3. **Spawn an implementer agent** using `./implementer-prompt.md` in Build mode:

   **With superpowers:** Invoke `superpowers:subagent-driven-development` via the Skill tool. Point it to `.harness/wave-N-plan.md`. The skill handles per-task implementer → spec review → code quality review.

   **Without superpowers:** Dispatch an implementer agent with the wave plan. For multi-task waves, each task gets its own implementer.

4. **Handle tightly coupled tasks.** Note in the wave plan that they must execute sequentially. If inseparable, combine into one task.

### After the build completes

5. **Write the handoff file** to `.harness/handoff-wave-N.md`. Read `./handoff-template.md` for the structure. Be thorough — the evaluator's entire understanding comes from this file.

6. **Update progress.** Append to `.harness/progress.md` what was completed. The evaluator reads this for context.

### Flexibility

- **Skip the planner** if the task is already clear
- **Skip the implementer** if the code is already written and just needs verification
- **Combine planner + implementer** if the task is simple enough for one agent — just keep the evaluator independent

---

## Phase 4: Evaluate

Dispatch an **evaluator subagent** to independently test the result.

### Dispatch the evaluator

Use the Agent tool with `subagent_type: "general-purpose"`. Read `./evaluator-prompt.md` for the prompt template. Fill in:
- Wave number (N)
- Acceptance criteria (paste inline)
- Absolute path to `.harness/handoff-wave-N.md`
- Absolute path to `.harness/progress.md`
- Absolute path to working directory
- Project context (CLAUDE.md instructions, dev workflow, conventions)

The evaluator writes `.harness/evaluation-wave-N.md` with a verdict of PASS, ITERATE, or FAIL — plus per-criterion results, optional rubric scores, bugs, and feedback.

### Handle the verdict

See **Verdict Handling** section below. The implementer dispatched for Fix/Polish skips the Build phase review cycle — the evaluator re-run IS the quality gate.

---

## Phase 5: Deliver

- **With superpowers:** Invoke `superpowers:finishing-a-development-branch` via the Skill tool.
- **Without:** Commit all work, present a summary to the user, and ask how they want to integrate (merge, PR, etc.).

Present: what was built, how to run it, evaluation results, known limitations.

---

## File-Based State

```
.harness/
  progress.md               # Running log — updated after each wave
  wave-1-plan.md            # Tasks and acceptance criteria for wave 1
  handoff-wave-1.md         # What was built, how to run it
  evaluation-wave-1.md      # Evaluator's verdict
  wave-2-plan.md            # (only if multiple waves)
  handoff-wave-2.md
  evaluation-wave-2.md
```

Even for single-wave tasks, use `.harness/` files. They provide the structured handoff between implementer and evaluator, and they persist as a record of what was done.

---

## Prompt Templates

### Subagent Prompts

Read the file, fill in `{placeholders}`, pass as the `prompt` parameter to the Agent tool.

- `./implementer-prompt.md` — Implementer (Build / Fix / Polish modes)
- `./evaluator-prompt.md` — Independent evaluator

### File Templates

Read the file and use as structural guide when writing output.

- `./handoff-template.md` — Handoff file structure

---

## Verdict Handling

Before acting on any verdict, sanity-check the evaluator's response: it must contain a clear PASS, ITERATE, or FAIL verdict with evidence. If the response is malformed, missing a verdict, or returns PASS with no evidence, re-run with a fresh evaluator.

**PASS:** Commit the work. Show the user the evaluator's assessment. Move to next wave or Phase 5.

**ITERATE:** All criteria pass but rubric average is below 4.0 or any dimension is below 4. Show the user the rubric scores. Dispatch an **implementer** in Polish mode using `./implementer-prompt.md`. Re-run the evaluator.

**FAIL:** Show the user what failed. Dispatch an **implementer** in Fix mode using `./implementer-prompt.md`. Re-run the evaluator.

**Cap at 10 rounds** (FAIL + ITERATE combined). If still not passing, surface it to the user.

---

## Resilience

**Agent spawn failures:** If an agent tool call fails (timeout, crash), retry once. If it fails again, surface the error to the user rather than looping.

**Context running low:** Write orchestrator state to `.harness/orchestrator-state.md` (phase, wave number, what's done, what's next). Tell the user to re-invoke and pick up from the state file.

**Fresh context per agent.** Always spawn new subagents. Files carry state; agents bring fresh capacity.
