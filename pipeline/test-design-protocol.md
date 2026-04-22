# Test Design Protocol

**Node type:** review (multi-role)

The test-design node separates **what to test** from **how to run it**. Multiple roles design test cases from their perspectives; the downstream test-execute node runs them.

Core principle: **the person who decides what to test must not be the person who runs the tests.** This prevents the executor from unconsciously narrowing scope to what's easy to verify.

## Roles at This Node

Select 2-4 roles from the filtered pool. Recommended combinations:

| Project type | Roles |
|---|---|
| API/Backend | tester, backend, security |
| Full-stack web app | tester, new-user, frontend |
| Data pipeline | tester, backend, compliance |
| Library/SDK | tester, engineer, devil-advocate |
| Mobile app (RN/Flutter) | tester, mobile, new-user |
| Cross-platform app | tester, mobile, frontend |
| Desktop app (Electron/Tauri) | tester, frontend, engineer |

Each role designs test cases from their angle — the tester thinks in edge cases and coverage; the end-user thinks in real workflows; the security reviewer thinks in attack surface.

## Role Instructions

Each dispatched role evaluator receives these additional instructions (append to role-evaluator-prompt.md):

---

**Your task is to DESIGN test cases, not execute them.**

You are reviewing the implementation from `{upstream build node}` and designing a comprehensive test plan. Your output will be handed to an executor who runs every case you specify.

### What You Produce

For each test case, specify:

1. **ID**: `TC-{ROLE}-{N}` (e.g., `TC-TESTER-01`, `TC-NEW-USER-03`)
2. **Category**: One of: `api`, `e2e-ui`, `integration`, `edge-case`, `security`, `performance`, `platform-mobile`, `platform-desktop`, `cross-platform`
3. **Priority**: `P0` (must pass for ship) / `P1` (should pass) / `P2` (nice to verify)
4. **Description**: What to test, in plain language
5. **Steps**: Concrete steps the executor should follow
6. **Expected result**: What constitutes PASS
7. **Failure impact**: What breaks if this fails (the "so what?" test)

### Output Format

Write to: `$SESSION_DIR/nodes/test-design/run_{RUN}/eval-{role}.md`

```markdown
# Test Design — {role_name}

## Summary
- Total cases: N
- By priority: P0: X, P1: Y, P2: Z
- By category: api: A, e2e-ui: B, edge-case: C, ...

## Test Cases

### TC-{ROLE}-01: {short name}
- **Category**: api
- **Priority**: P0
- **Description**: {what to test}
- **Preconditions**: {setup needed}
- **Steps**:
  1. {step}
  2. {step}
- **Expected**: {concrete expected result}
- **Failure impact**: {what breaks}

### TC-{ROLE}-02: {short name}
...

## Coverage Assessment
{What this role's cases cover and what they intentionally don't cover}

### Platform Coverage Matrix (multi-platform projects only)
If the project ships on multiple platforms, include a matrix showing test coverage per platform:

| Feature | Web | iOS | Android | Desktop |
|---------|-----|-----|---------|---------|
| {feature} | TC-{ROLE}-{N} | TC-{ROLE}-{N} | TC-{ROLE}-{N} | — |

Cells with "—" must note whether the platform is out of scope or genuinely untested (and if untested, why).

## VERDICT
VERDICT: TEST-CASES [N] — N test cases designed
```

### Quality Rules

- Every P0 case must have concrete steps that an executor can follow mechanically (no "verify it works correctly")
- Every case must have an expected result that is binary (PASS or FAIL, no "should be reasonable")
- Do not design cases for things you haven't read in the code — read the implementation first
- Aim for 5-15 cases per role. Fewer is fine if scope is narrow. More than 20 suggests you're testing too broadly — split by feature
- Test cases MUST reference the actual implementation (endpoints, components, functions) — not hypothetical features
- Include at least one negative test (what should fail/be rejected) per P0 feature
- For multi-platform projects: at least one test case per role must target a platform-specific failure mode (not just "it renders correctly"). Include cases that verify behavior ACROSS platforms, not just ON each platform independently

---

## Orchestrator Responsibilities

1. Dispatch role evaluators in parallel using role-evaluator-prompt.md with the test-design appendix above
2. Collect all `eval-{role}.md` files
3. **Merge and deduplicate**: Combine test cases across roles. If two roles designed overlapping cases, keep the more specific one
4. **Auto-inject tier baseline test cases**: If the flow has a quality tier (`flow-state.json → tier`), run `opc-harness tier-baseline --tier {TIER}` and append the output test cases to the merged plan. These are P0 — non-negotiable. Do not deduplicate them away even if a role designed a similar case. The tier cases have standardized IDs (`TC-TIER-01`, `TC-TIER-02`, ...) and must appear verbatim.
5. Write merged test plan to `$SESSION_DIR/nodes/test-design/run_{RUN}/test-plan.md`
6. Write handshake.json with all eval files as artifacts
7. The merged test-plan.md is the primary input for the downstream test-execute node

### Handshake

```json
{
  "nodeId": "test-design",
  "nodeType": "review",
  "runId": "run_{RUN}",
  "status": "completed",
  "verdict": null,
  "summary": "N test cases designed by {roles}. P0: X, P1: Y, P2: Z.",
  "timestamp": "<ISO8601>",
  "artifacts": [
    { "type": "eval", "path": "run_{RUN}/eval-tester.md" },
    { "type": "eval", "path": "run_{RUN}/eval-new-user.md" },
    { "type": "test-plan", "path": "run_{RUN}/test-plan.md" }
  ]
}
```

## Downstream: test-execute

The test-execute node (execute type) reads the merged test-plan.md and:
1. Executes every P0 case — all must pass
2. Executes P1 cases — failures are warnings
3. P2 cases are optional (execute if time/tools permit)
4. Reports results with evidence (screenshots, CLI output, API responses)

The executor does NOT design new test cases. If it discovers untested scenarios during execution, it notes them as "discovered gaps" but does not add them to the current run's scope.
