# Mode E: Harness — OPC Integration

This file defines how OPC's coordinator runs Mode E by combining the harness pipeline with OPC's multi-role evaluation. The harness skill files in this directory (`SKILL.md`, `implementer-prompt.md`, `evaluator-prompt.md`, `handoff-template.md`) are the standard harness — they can be updated independently.

## How Mode E Differs from Standalone Harness

The only difference: **harness's single evaluator is replaced by multiple OPC role evaluators.** Everything else — the implementer, `.harness/` file state, handoff template, fix-and-retest loop — works exactly as described in `SKILL.md`.

## Mode E Flow

### Phase 1: Build (same as harness Phase 3)

1. Extract concrete acceptance criteria from the task (3-7 bullet points, each a specific verifiable behavior).
2. Write task + criteria to `.harness/wave-N-plan.md`.
3. Dispatch implementer using `harness/implementer-prompt.md` in Build mode.
4. Write handoff to `.harness/handoff-wave-N.md` using `harness/handoff-template.md`.
5. Update `.harness/progress.md`.

### Phase 2: Multi-Role Evaluation (replaces harness Phase 4)

Instead of dispatching one evaluator, dispatch OPC role agents. Each role evaluates from its specialist angle using the template below.

6. Select roles as you would for Mode A (multiple distinct angles relevant to the implementation).
7. Dispatch role agents in parallel (same dependency-check rules as Mode A).
8. Each role returns per-criterion PASS/FAIL, domain findings with severity, and a VERDICT.

### Phase 3: Verdict Synthesis

9. Apply OPC's Tier 1 + Tier 2 verification to each evaluator's output.
10. Synthesize the combined verdict:
    - Any role returns FAIL with validated critical findings → **FAIL**
    - All roles pass criteria but any returns ITERATE or has quality gaps → **ITERATE**
    - All roles return PASS → **PASS**
11. Write `.harness/evaluation-wave-N.md` with synthesized verdict and per-role breakdown. Prefix each finding with `[Role]`.

### Phase 4: Iteration (same as harness Verdict Handling)

12. **PASS:** Commit. Present report. Save OPC report JSON.
13. **ITERATE:** Dispatch implementer in Polish mode → re-run Phase 2 with fresh evaluators.
14. **FAIL:** Dispatch implementer in Fix mode → re-run Phase 2 with fresh evaluators.
15. **Cap at 10 rounds.** Surface to user with full iteration history if not resolved.

On re-evaluation rounds, narrow to roles whose domain had findings plus one regression-check role. Re-run all roles only if findings spanned 3+ domains.

## Role Evaluator Template

Use OPC's standard agent prompt skeleton. Insert this as the `{{MODE-SPECIFIC SECTION}}`:

```
## Implementation Under Review

An independent implementer has built code for this task. You did NOT write this code. Your job is to evaluate it from your {{Role}} specialist perspective.

Read the handoff: {{absolute path to .harness/handoff-wave-N.md}}
Progress log: {{absolute path to .harness/progress.md}}
Working directory: {{absolute path to working directory}}

## Task
{{task description}}

## Acceptance Criteria
{{paste acceptance criteria from wave plan}}

## Scope
{{specific files the implementer changed — extract from handoff}}

## Your Evaluation Approach

**Test end-to-end from your specialist perspective.** Do not just read code — run it, interact with it, verify it works. Reading code is not testing.

1. Read the handoff file to understand what was built
2. Review the implementation through your {{Role}} lens
3. For each acceptance criterion: does it hold up from your angle? PASS or FAIL with evidence.
4. Identify issues specific to your domain

## Severity Calibration
- 🔴 Critical: Blocks acceptance. Exploitable vulnerability, data loss, broken core functionality, or acceptance criterion failure.
- 🟡 Warning: Does not block acceptance but degrades quality. Real code smell, missing edge case, reliability risk.
- 🔵 Suggestion: Improvement opportunity. Nice-to-have.
When in doubt, downgrade.

## Output Format

### Acceptance Criteria Results
For each criterion:
- [PASS/FAIL] {criterion} — {evidence from actual testing}

### Domain Findings
For each finding:
[SEVERITY] file:line — Issue description
  → Suggested fix
  reasoning: Why this matters from your {{Role}} perspective

### Quality Assessment
If relevant to your domain, score applicable quality dimensions 1-5 with reasoning.

## Threads
After your evaluation, list 0-3 areas you noticed but couldn't fully resolve — things that need deeper tracing or where you're uncertain. The coordinator may follow up.

## VERDICT (pick one)
- VERDICT: PASS — all criteria hold from {{Role}} perspective, no critical issues
- VERDICT: ITERATE — criteria pass but quality needs improvement (list what)
- VERDICT: FAIL [reasons] — criteria failures or critical issues found
- VERDICT: BLOCKED [reason] — cannot evaluate
```

## Report Format

```
## OPC Harness — {task summary}

### Implementation
Wave {N} — {what was built, 2-3 sentences}

### Evaluation (Round {R})

#### Per-Role Results
| Role | Verdict | 🔴 | 🟡 | 🔵 |
|------|---------|-----|-----|-----|
| {role} | {PASS/ITERATE/FAIL} | {count} | {count} | {count} |

#### 🔴 Critical ({count})
[{Role}] {findings}

#### 🟡 Warning ({count})
[{Role}] {findings}

#### 🔵 Suggestion ({count})
[{Role}] {findings}

#### Dismissed ({count})
{findings removed with brief reason}

### Iteration History
{Round 1 → FAIL (security: XSS) → Round 2 → ITERATE (tester: edge case) → Round 3 → PASS}

---
Verdict: {PASS/ITERATE/FAIL}
Agents: implementer + {evaluator roles list}
Rounds: {N}
Coordinator: {N challenged, M dismissed, K downgraded}
```

## JSON Report Extensions

When saving the OPC report (Step 8), Mode E adds:

- `"mode": "harness"` in the mode field
- `"harness"` object:
  ```json
  {
    "wave": 1,
    "round": 3,
    "finalVerdict": "PASS",
    "iterationHistory": [
      { "round": 1, "verdict": "FAIL", "reason": "security: XSS in form handler", "implementerMode": "Build" },
      { "round": 2, "verdict": "ITERATE", "reason": "tester: edge case in empty state", "implementerMode": "Fix" },
      { "round": 3, "verdict": "PASS", "reason": "All roles pass", "implementerMode": "Polish" }
    ],
    "acceptanceCriteria": [
      { "criterion": "description", "status": "pass", "evidence": "tested by running X" }
    ]
  }
  ```
- Timeline types: `build`, `implementer-output`, `evaluation-synthesis`, `iteration`
