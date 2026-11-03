# Mission Gate — optional single-flow controller

Mission changes neither flow topology nor model routing. Use the existing
`model-route` before dispatch; configure host-native model IDs there, not here.
The harness checks transition budgets; the host still owns actual dispatch and
user authorization. No claim of OS-level isolation or adversarial tamper resistance.

## Start and visible activation

`/opc build-verify --mission <task>` selects build-verify plus Mission. `-i` stays
independent. Derive a short contract from the actual user request; ask only when a
missing boundary materially changes the task. State inferred appetite to the user.
Keep the original request in the session's task/acceptance materials for reviewers.
Do not impose an arbitrary minimum number of outcomes beyond one.

Example contract (replace content and appetite with the actual task):

```json
{
  "schemaVersion": 1,
  "goal": "Fix the duplicate-submit bug without changing the public API",
  "outcomes": [{"id": "duplicate-submit", "description": "Repeated submit creates one record; regression test passes"}],
  "nonGoals": ["New job queue", "Cross-session recovery"],
  "appetite": {"maxRepairCycles": 3, "maxMinutes": 45}
}
```

Run normal `init --flow ... --mission /absolute/contract.json` (retain the usual
`--auto --claude-session-id ...` only when using the existing Claude hook mode).
Require `created:true` and `mission.enabled:true`. Show one receipt:
`Flow: build-verify | Mission: on / single-flow | Repairs: 3 | Minutes: 45`.
Use the returned session `dir` explicitly thereafter. No success receipt means no
dispatch. An existing Mission cannot be overwritten by `init --force`.

Supported: one serial controller, an ordinary flow in a Git repository with HEAD,
and a separate session directory. Unsupported: loop/shared parent state, submodule
freshness bindings, automatic migration of old Mission states. Ordinary child
workers return artifacts; they must not write flow-state or call Mission decisions.

## During work

- Before each new dispatch, run `mission status --dir SESSION`. A trigger pauses
  work. Status is read-only; a clock overrun is checked at boundaries, not a timer
  that interrupts an already running tool or model.
- Keep the normal synthesize → route → transition path. On a Mission refusal,
  run `mission status --verdict VERDICT --to TARGET --dir SESSION` using the exact
  attempted edge (`TARGET` may be `null`). Same-edge repeated repair is a signal to
  inspect progress, not proof that no progress occurred.
- When a key assumption or scope fails before a repair edge, call
  `mission pause --class PLAN|ENVIRONMENT|GOAL_SPEC|ARTIFACT --reason TEXT --dir SESSION`.
  Then obtain status for the intended edge. Never substitute PASS for a failed edge.
- A fresh Mission reviewer is added only on such an event. Pass this protocol,
  the original user request, the frozen contract and current status JSON, current
  findings and relevant artifact paths. Do not include the builder's reasoning
  transcript or previous reviewers' conclusions as instructions.
- No repeated broad checks after the relevant checks pass unless new code,
  a new failure or a concrete unresolved concern justifies them.

## Fresh review output and consumption

The host creates an actual independent Agent with no author history, assigns one
output path in the session root, waits for completion, then consumes that file.
Route it through the existing model resolver; do not invent model availability.
If no independent Agent capability is available, stop and report that limit.
Before dispatch, use `mission evidence --file PATH --dir SESSION` for each relevant
file and supply the returned `{path, sha256}` receipts along with the file paths.
The reviewer copies receipts for files it actually inspected; the consumer verifies
those pre-review hashes. Do not mint replacement hashes after receiving a review.

Reviewer: decide whether the current bet still serves the original outcomes and
non-goals. Distinguish a defect in promised functionality from a newly proposed
capability. Look for the smallest valid delivery, preserving security and evidence.
Use raw findings and actual evidence. Do not invent issues to force a re-bet, and
do not write code. The output is JSON:

```json
{
  "binding": "copy the exact binding from the supplied status",
  "reviewer": {"id": "actual host Agent ID supplied by the host", "contextMode": "cold"},
  "classification": "ARTIFACT",
  "action": "CONTINUE_CURRENT",
  "reason": "Specific explanation of new evidence and the bounded next action",
  "evidence": [{"path": "/absolute/session/nodes/code-review/run_2/eval.md", "sha256": "copy the receipt hash"}]
}
```

Classification/action pairs: ARTIFACT → CONTINUE_CURRENT; PLAN → RESHAPE_SMALLER;
ENVIRONMENT → RECON; GOAL_SPEC → HUMAN_REBET. HUMAN_REBET and STOP_SALVAGE are
available for any classification. Choose only actions in status.allowedActions.
RESHAPE_SMALLER changes the implementation plan, never the frozen goal, acceptance
criteria, safety floor or authorized scope. If those must change, choose HUMAN_REBET.
All relative evidence paths resolve from `status.sessionDir`, **not the project
root**; an absolute path inside the project/session is also valid. Do not prefix
`.harness/` when that is already the session directory. Confirm every referenced
file exists and is non-empty before returning either review shape.

Call `mission decide --review FILE` with the **same edge flags** used for status.
CONTINUE_CURRENT/RESHAPE_SMALLER require a real graph edge: do not use the default
CHECK status for a continuation decision. CHECK is sufficient for recon/re-bet/stop.
Require `ok:true`. Record the actual Agent ID from the host, not a fabricated receipt.
The ID check is structural; independent execution is a host responsibility.

CONTINUE_CURRENT and RESHAPE_SMALLER share one session-wide retry allowance, bound
to the current progress and edge. They never waive original flow limits or tests.
The existing Claude `--auto` repair ceiling still dominates: once it is reached,
Mission reports a non-retryable limit rather than advertising an unusable retry.
RECON is allowed once: the host may do bounded read-only diagnosis, not implementation
or a transition. The Mission remains paused; obtain new status and a new review
before deciding again. HUMAN_REBET keeps it paused; ask the user for a new bet and
start a new session only with that authority. STOP_SALVAGE stops without completion.
`stop` remains available independently; skip/pass/goto cannot bypass Mission.
When only HUMAN_REBET/STOP_SALVAGE remain, stop and report directly instead of
spawning another reviewer merely to restate exhaustion.

## Outcome acceptance

Reuse an existing independent final reviewer when it can inspect the terminal
evidence. Flows such as build-verify have test design before test execution: that
is not an outcome review. In that case Mission adds one final outcome-review call,
not a new graph node or a repeat of every specialist review. Finish the ordinary
evidence/handshake work first: run `seal --node NODE --dir SESSION`, including for
terminal gates. Mission accept requires both exact-run and canonical handshakes;
do not rely on finalize to create them after review. At the terminal node obtain
`mission status --verdict PASS --to null`.
Give its binding and current artifacts to the final reviewer. Save JSON in the
session root (not nodes, whose files participate in the evidence binding):

```json
{
  "binding": "copy the supplied terminal status binding",
  "reviewer": {"id": "actual host Agent ID", "contextMode": "cold"},
  "outcomes": [{"id": "duplicate-submit", "status": "PASS", "reason": "What was verified", "evidence": [{"path": "/absolute/session/nodes/test-execute/run_1/test-output.txt", "sha256": "copy the pre-review receipt hash"}]}]
}
```

Each frozen outcome needs one supported PASS. If not satisfied, do not submit a
fake PASS; return the gap and use the original failure path or stop. Run
`mission accept --verdict PASS --to null --review FILE --dir SESSION`, then normal
terminal transition/finalize. Both must succeed. Empty/missing/out-of-scope evidence,
changed source, changed node evidence, changed recorded commits or changed progress
invalidate acceptance. This binds evidence; it does not prove prose is true.
The existing structured-result, exact-run, test-command and strict chain checks
remain responsible for their established guarantees. Mission never executes or
replays test commands by itself, and it cannot turn a failed normal gate into PASS.

## Resume and limits

Resume uses the same explicit session path, `validate-chain`, and `mission status`.
Inspect artifacts and any interrupted tool's actual effects before further work.
Old reviews are rejected after their bindings change. Do not auto-replay a command,
roll back user files or repair JSON by hand. Unknown/corrupt state requires stopping
and reporting, not migration or a silent Mission-off run. Budget includes elapsed
wall time while interrupted. This is not cross-session transaction/crash safety.
