# Criteria Lint — Mechanical DoD Quality Check

**Purpose:** Single-pass mechanical validation of Definition of Done (DoD) structure. Replaces the 3-round serial devil-advocate protocol (`devil-advocate-drafting.md`) with a code-enforceable lint that runs in <1 second.

**Replaces:** `devil-advocate-drafting.md` (v0.9). The old protocol dispatched a devil-advocate subagent for up to 3 adversarial rounds. Problems: (1) LLM-vs-LLM adversarial debate produces predictable theater, not genuine quality improvement; (2) 3 rounds costs ~$3-5 in tokens for marginal gain; (3) quarantine mechanism was a non-blocking gate dressed as a gate. This protocol replaces it with mechanical checks that catch the same structural failures at zero token cost.

## When This Runs

**Every mode** — both YOLO (`/opc <task>`) and interactive (`/opc <task> -i`).

The lint runs after the orchestrator drafts `acceptance-criteria.md` and BEFORE `opc-harness init`. Init is gated — if criteria-lint fails, init refuses to start.

```
1. User invokes /opc <task>
2. Orchestrator analyzes task, selects tier
3. Orchestrator drafts .harness/acceptance-criteria.md
4. opc-harness criteria-lint .harness/acceptance-criteria.md  <-- THIS
5. If PASS: opc-harness init --flow X --tier Y
6. If FAIL: orchestrator revises DoD automatically, re-runs lint (max 3 attempts)
7. If still FAIL after 3 attempts: surface to user with specific failures
```

## What criteria-lint Checks

### Structural Checks (MUST pass)

| Check | Rule | Failure message |
|---|---|---|
| `outcomes-exist` | `## Outcomes` section exists with >=1 `OUT-N:` prefixed bullet | "No outcomes section or no OUT-N bullets found" |
| `outcomes-count` | 3-7 `OUT-N:` bullets | "Found {N} outcomes — must be 3-7" |
| `verification-exists` | `## Verification` section exists | "No verification section" |
| `verification-mapped` | Every `OUT-N` referenced in Verification section | "OUT-{N} has no verification method" |
| `quality-section` | `## Quality Constraints` section exists (can be empty list) | "No quality constraints section" |
| `scope-section` | `## Out of Scope` section exists (can be empty list) | "No out-of-scope section" |
| `tier-section` | If tier is set: `## Quality Baseline ({tier})` section exists | "Tier is {tier} but no quality baseline section" |

### Content Checks (MUST pass)

| Check | Rule | Failure message |
|---|---|---|
| `no-vague-outcomes` | No outcome contains ONLY subjective words without measurement. Detected by: outcome text matches `/^OUT-\d+:.*\b(fast|clean|intuitive|responsive|robust|secure|correct|handles edge cases|user-friendly|seamless|smooth)\b/i` AND does NOT contain a number, threshold, unit, or "measured by" | "OUT-{N} uses '{word}' without a measurement threshold" |
| `no-impossible-to-fail` | No outcome matches `/^OUT-\d+:.*\b(should work|intended purpose|as expected|properly|correctly)\b/i` without a concrete test | "OUT-{N} is impossible to fail — '{phrase}' has no concrete test" |
| `verification-not-manual` | Verification methods don't contain `/\b(manual inspection|code review|looks correct|it should be obvious|visually inspect)\b/i` as the SOLE method | "OUT-{N} verification is manual-only — add a mechanical check" |
| `outcomes-unique` | No two OUT-N bullets have >80% word overlap (Jaccard similarity on lowercased word sets) | "OUT-{M} and OUT-{N} are >80% similar — merge or differentiate" |

### Warning Checks (reported but don't block)

| Check | Rule | Warning message |
|---|---|---|
| `scope-empty` | Out of Scope section is empty | "Out of Scope is empty — consider listing at least 1 explicit exclusion" |
| `no-failure-modes` | No outcome mentions error, failure, invalid, or edge case | "No outcomes address failure modes — consider adding at least 1" |
| `high-outcome-count` | >5 outcomes | "6+ outcomes increases scope risk — consider whether all are essential" |

## Output Format

```bash
$ opc-harness criteria-lint .harness/acceptance-criteria.md

# On success:
✅ criteria-lint: 7 checks passed, 1 warning
  ⚠️ scope-empty: Out of Scope is empty — consider listing at least 1 explicit exclusion

# On failure:
❌ criteria-lint: 2 failures, 1 warning
  ❌ no-vague-outcomes: OUT-2 uses 'fast' without a measurement threshold
  ❌ verification-not-manual: OUT-4 verification is manual-only — add a mechanical check
  ⚠️ no-failure-modes: No outcomes address failure modes

Exit code: 0 on pass, 1 on fail
```

## Orchestrator Auto-Fix (YOLO mode)

In YOLO mode, when criteria-lint fails, the orchestrator:

1. Reads the failure messages
2. Revises `acceptance-criteria.md` to address each failure
3. Re-runs criteria-lint
4. Max 3 auto-fix attempts

If still failing after 3 attempts, surface to user:
```
⛔ DoD failed criteria-lint after 3 revision attempts:
  ❌ {remaining failures}
Use /opc edit-criteria to fix manually, or /opc force-init to bypass.
```

`/opc force-init` sets `flow-state._criteria_lint_bypassed = true`, which is surfaced as a warning in downstream gates.

## Interactive Mode (`-i`)

Same lint runs, but failures are shown to the user directly:
```
Your acceptance criteria have issues:
  ❌ OUT-2 uses 'fast' without a measurement threshold
  ❌ OUT-4 verification is manual-only

Fix these before proceeding. Edit .harness/acceptance-criteria.md, then run:
  /opc lint-criteria
```

User fixes and re-runs. No auto-fix in interactive mode — the user IS the quality control.

## Integration with flow-state

On lint pass:
```json
{
  "_criteria_lint": {
    "passed": true,
    "checks_passed": 7,
    "warnings": 1,
    "timestamp": "<ISO8601>",
    "bypassed": false
  }
}
```

On bypass:
```json
{
  "_criteria_lint": {
    "passed": false,
    "checks_failed": 2,
    "failures": ["no-vague-outcomes:OUT-2", "verification-not-manual:OUT-4"],
    "bypassed": true,
    "timestamp": "<ISO8601>"
  }
}
```

The `bypassed` flag propagates to downstream gates — the UX simulation gate's prompt includes: "Note: DoD criteria-lint was bypassed. Pay extra attention to OUT-2 and OUT-4 which had unresolved lint failures."

## Relationship to Other Protocols

- **`ux-simulation-protocol.md`** — runs at the END of flow. Together with criteria-lint, these are bookend defenses: front-end DoD lint + back-end UX observation.
- **`quality-tiers.md`** — tier affects which checks apply (tier-section check).
- **`gate-protocol.md`** — criteria-lint is pre-init, not a gate node. But its bypass flag propagates through gates.

## Anti-Patterns

- Do NOT skip criteria-lint because "the DoD looks fine" — lint is mandatory
- Do NOT suppress warnings — they're reported to the orchestrator for consideration
- Do NOT use `/opc force-init` in YOLO mode without surfacing to user first
- Do NOT treat criteria-lint pass as "DoD is good" — lint checks structure, not substance. A well-structured bad idea will pass lint.
- Do NOT add LLM-judgment checks to criteria-lint — this is a mechanical tool. If it requires understanding meaning, it doesn't belong here.

## What This Does NOT Replace

Criteria-lint checks **structure**. It cannot check:
- Whether the outcomes are the RIGHT outcomes for the task
- Whether the verification methods actually test what they claim
- Whether the scope is appropriate
- Whether the tier selection is correct

These are judgment calls that the orchestrator makes during drafting. The downstream UX simulation gate catches the consequences of bad judgment — if the outcomes are wrong, the product won't pass red flag detection.

The old devil-advocate protocol attempted to catch these judgment failures through LLM debate. The replacement strategy is: don't try to catch bad judgment upfront (LLM debate is unreliable). Instead, tighten the structure (criteria-lint) and catch the consequences downstream (UX simulation).
