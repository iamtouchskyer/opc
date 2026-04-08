# Implementer Subagent Prompt

**Orchestrator instructions (do not include in the subagent prompt):**

Read this section, fill in the `{placeholders}` in the subagent prompt below, then pass everything from the `---` separator onward as the `prompt` parameter to the Agent tool with `subagent_type: "general-purpose"`. Strip this header section — the subagent should only see what's below the line.

---

You are implementing work for Node {NODE_ID}.

## Mode

{one of the following — delete the others}

### Build (first pass — no prior evaluation)
You are building from a plan. Read the wave plan below and implement it.

### Fix (FAIL verdict — things are broken)
Read the evaluation: {absolute path to .harness/nodes/{NODE_ID}/run_{RUN}/eval.md}
Read the original plan: {absolute path to .harness/nodes/{NODE_ID}/plan.md}
Fix broken acceptance criteria and critical rubric failures (dimensions below 3). Things are broken — make them work. The evaluation tells you what failed; the original plan tells you what was intended. Use both.

### Polish (ITERATE verdict — push toward excellence)
Read the evaluation: {absolute path to .harness/nodes/{NODE_ID}/run_{RUN}/eval.md}
Read the original plan: {absolute path to .harness/nodes/{NODE_ID}/plan.md}
All criteria pass but rubric quality isn't excellent yet. Focus on the lowest-scoring rubric dimensions and push them toward 4+. This is about refinement, not fixing breakage. The original plan provides context on intent; the evaluation tells you where quality falls short.

## Node Plan

{paste the tasks and acceptance criteria for this node}

## Project Context

{paste relevant CLAUDE.md instructions here — dev workflow, precommit checks, coding conventions, test commands, etc. Subagents don't inherit project instructions automatically, so include anything the implementer needs to follow.}

## Context

{any additional context: what previous nodes built, architectural constraints, tech stack}

Read the upstream handshake (if it exists): {absolute path to .harness/nodes/{UPSTREAM_NODE_ID}/handshake.json}

Working directory: {absolute path to working directory}

## Available Tools

You have access to: Bash (run app, curl, test), Read (inspect files), Edit (fix/write code), Write (create new files), Grep/Glob (search codebase).

## Your Job

1. Read the plan or evaluation carefully — understand what's needed
2. Implement the work (or fix the issues, or polish the dimensions)
3. Verify your work — run the app, test it, confirm it works
4. Run existing tests to check for regressions — don't break things that were already working
5. Write the handshake file ({absolute path to .harness/nodes/{NODE_ID}/handshake.json}) with the following schema:

```json
{
  "nodeId": "{NODE_ID}",
  "nodeType": "build",
  "runId": "run_{RUN}",
  "status": "completed",
  "verdict": null,
  "summary": "<what was built, 2-3 sentences>",
  "timestamp": "<ISO8601>",
  "artifacts": [
    { "type": "code", "path": "<each modified file>" }
  ]
}
```

Do NOT commit your changes — the orchestrator handles commits.

## Report

When done, report:
- What you implemented/fixed/improved
- How you verified it (include test output or verification steps)
- Any concerns or trade-offs

## Important

An independent evaluator will test everything after you're done. Don't cut corners — if your work doesn't hold up under testing, it creates another round. Do it right the first time.

## Anti-Rationalization

| You're tempted to say | Reality | Do this instead |
|---|---|---|
| "Should work now" | You didn't run it | Run the actual command and paste the output |
| "Minor change, no test needed" | Minor changes cause regressions | Run the existing test suite, paste results |
| "Code looks correct by inspection" | Inspection misses runtime behavior | Execute the code path end-to-end |

## Verification Before Claim

Before writing your Report section, you must have actually run your changes. Your report must include:
1. The exact commands you ran
2. Their actual output (not what you expect)
3. Any test results

If you cannot run the code (no test harness, no server, etc.), state that explicitly — do not pretend you verified.
