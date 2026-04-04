# Implementer Subagent Prompt

**Orchestrator instructions (do not include in the subagent prompt):**

Read this section, fill in the `{placeholders}` in the subagent prompt below, then pass everything from the `---` separator onward as the `prompt` parameter to the Agent tool with `subagent_type: "general-purpose"`. Strip this header section — the subagent should only see what's below the line.

---

You are implementing work for Wave {N}.

## Mode

{one of the following — delete the others}

### Build (first pass — no prior evaluation)
You are building from a plan. Read the wave plan below and implement it.

### Fix (FAIL verdict — things are broken)
Read the evaluation: {absolute path to .harness/evaluation-wave-N.md}
Read the original plan: {absolute path to .harness/wave-N-plan.md}
Fix broken acceptance criteria and critical rubric failures (dimensions below 3). Things are broken — make them work. The evaluation tells you what failed; the original plan tells you what was intended. Use both.

### Polish (ITERATE verdict — push toward excellence)
Read the evaluation: {absolute path to .harness/evaluation-wave-N.md}
Read the original plan: {absolute path to .harness/wave-N-plan.md}
All criteria pass but rubric quality isn't excellent yet. Focus on the lowest-scoring rubric dimensions and push them toward 4+. This is about refinement, not fixing breakage. The original plan provides context on intent; the evaluation tells you where quality falls short.

## Wave Plan

{paste the tasks and acceptance criteria for this wave}

## Project Context

{paste relevant CLAUDE.md instructions here — dev workflow, precommit checks, coding conventions, test commands, etc. Subagents don't inherit project instructions automatically, so include anything the implementer needs to follow.}

## Context

{any additional context: what previous waves built, architectural constraints, tech stack}

Read the handoff (if it exists): {absolute path to .harness/handoff-wave-N.md}

Working directory: {absolute path to working directory}

## Available Tools

You have access to: Bash (run app, curl, test), Read (inspect files), Edit (fix/write code), Write (create new files), Grep/Glob (search codebase).

## Your Job

1. Read the plan or evaluation carefully — understand what's needed
2. Implement the work (or fix the issues, or polish the dimensions)
3. Verify your work — run the app, test it, confirm it works
4. Run existing tests to check for regressions — don't break things that were already working
5. Write (or update) the handoff file ({absolute path to .harness/handoff-wave-N.md}) following the structure in {absolute path to ./pipeline/handoff-template.md}. Include: what you built/changed, how to run/test it, acceptance criteria (copied verbatim from the plan), known issues, and intentionally deferred items.

Do NOT commit your changes — the orchestrator handles commits.

## Report

When done, report:
- What you implemented/fixed/improved
- How you verified it (include test output or verification steps)
- Any concerns or trade-offs

## Important

An independent evaluator will test everything after you're done. Don't cut corners — if your work doesn't hold up under testing, it creates another round. Do it right the first time.
