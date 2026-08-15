# OPC Mission/Re-bet Gate Design

**Date**: 2026-08-15
**Status**: Draft for review
**Scope**: Bounded outer control loop for long-range OPC and goal-oriented Codex development
**Rollout**: Phase 1 control loop, followed by Phase 2 evidence traceability

---

## 0. Decision Summary

Keep OPC's independent build/review/test loop intact. Add a side-band **Mission/Re-bet Gate** that detects when repeated local repair is no longer evidence of mission progress.

The gate does not add another adversarial code reviewer. It is a cold-context, outcome-level decision point. It preserves the original request, classifies why progress stalled, and selects one bounded route:

- `CONTINUE_CURRENT`
- `RESHAPE_SMALLER`
- `RESTORE`
- `RECON`
- `HUMAN_REBET`
- `STOP_SALVAGE`

Phase 1 adds the durable mission contract, stable finding identities, repeated-loop interception, a cold decision packet, and a recorded steering command. Phase 2 adds strict outcome-to-evidence mapping after the control behavior has been validated in real runs.

## 1. Problem

OPC is deliberately strict: builders do not review their own work, reviewers operate independently, and deterministic gates decide whether work advances. That protects local correctness, but a long-running flow can still optimize the wrong local target.

The recurring failure mode is:

1. A reviewer finds a defect.
2. The builder repairs the visible symptom.
3. A fresh review exposes the same invariant elsewhere, or a different symptom caused by the repair.
4. The pipeline treats each finding as a new artifact-level task.
5. Local checks improve while the integrated user outcome stalls or regresses.

Human intervention and perspective prompts help because they change altitude: they reconsider the bet, plan, environment, or success definition instead of proposing another patch. Today that escape is informal, non-durable, and easy to lose after compaction or replanning.

## 2. Goals

Phase 1 must:

1. Preserve the user's verbatim original request across compaction, resume, and replan.
2. Distinguish artifact defects from plan, goal-specification, and environment failures.
3. Stop the second repeated local failure before another automatic repair begins.
4. Produce a compact, cold-context packet for an outcome-level decision.
5. Make human steering durable, versioned, and auditable.
6. Permit at most one bounded retry after a Mission Gate decision.
7. Keep protected floors and deterministic failures non-waivable by an ordinary pass.
8. Preserve existing flow definitions and external-flow compatibility.

Phase 1 is successful when repeated local loops become explicit re-bet decisions without weakening OPC's independent review guarantees.

## 3. Non-goals

Phase 1 will not:

- add a Mission node to every built-in flow graph;
- let a perspective persona become a blocking oracle;
- silently rewrite the user's goal or acceptance criteria;
- automatically execute Git restore, broad replans, or environment mutations;
- replace deterministic validators with model judgment;
- require a mission contract for short legacy flows that do not opt in;
- implement the complete outcome-to-artifact evidence graph planned for Phase 2.

## 4. Approaches Considered

### A. Prompt/runbook guidance only

Add zoom-out language to reviewer prompts and document a two-strike rule.

This is cheap, but state is lost across compaction, counters reset after rewrites, and nothing prevents another local repair. It is useful as guidance but insufficient as a control mechanism.

### B. Private extension

Implement the gate as an OPC extension.

This is reversible, but extensions can add prompt and verdict context; they do not own all state transitions, loop advancement, finalization, or resume. Enforcing the same rule across standard flows and loop mode would duplicate logic and leave bypasses.

### C. Harness-native side-band controller — selected

Add two small core modules and intercept state transitions without changing flow topology.

This gives one durable rule across standard and loop modes, preserves the external graph ABI, and keeps rollback simple. Policy remains visible in files under the resolved OPC session directory; the controller only decides whether local iteration may continue.

## 5. Mission Contract

An opted-in run receives `--mission <path>` at `init` or `init-loop`. The source file is validated, copied to `$SESSION_DIR/mission-contract.json`, and pinned by SHA-256 in state.

```json
{
  "schemaVersion": 1,
  "version": 1,
  "owner": "Person accountable for the decision and consequences",
  "affectedParties": ["Users, operators, maintainers, or others bearing cost"],
  "mode": "explore",
  "originalRequest": "The user's verbatim request",
  "outcomes": [
    { "id": "OUT-1", "statement": "Primary observable user outcome" },
    { "id": "OUT-2", "statement": "Integrated behavior that must work" },
    { "id": "OUT-3", "statement": "Operational result that proves completion" }
  ],
  "retiredCriteria": [],
  "protectedFloors": [
    { "id": "FLOOR-1", "statement": "Property that must not regress" }
  ],
  "nonGoals": ["Explicitly excluded scope"],
  "appetite": { "maxRepairCycles": 8, "maxTokens": null, "maxWallTimeHours": null, "expiresAt": null },
  "endToEndScenario": {
    "id": "SCENARIO-1",
    "statement": "One runnable reality check",
    "validatorTypes": ["e2e", "acceptance", "ux-sim"]
  },
  "realitySignals": [
    { "id": "SIG-1", "required": true, "observation": "Evidence that would support or refute the bet" }
  ],
  "guardrails": [
    { "id": "GUARD-1", "metric": "Reliability, cost, trust, or harm signal", "actionThreshold": "Pause condition" }
  ],
  "checkpoints": [
    { "type": "loop_unit", "id": "F1.8" },
    { "type": "before_finalize" }
  ],
  "assumptions": [
    { "id": "ASM-1", "statement": "Relevant assumption", "freshUntil": null }
  ],
  "exitAndSalvage": "What to retain if the bet is stopped"
}
```

Rules:

- Required fields are `schemaVersion`, `version`, `owner`, `mode`, `originalRequest`, at least one affected party, protected floor, reality signal, and guardrail, three to ten outcomes, plus `appetite`, `endToEndScenario`, and `exitAndSalvage`.
- `mode` is one of `steady`, `explore`, `launch`, `incident`, or `regulated`; it changes review emphasis, never a protected-floor rule.
- `originalRequest` is immutable for the life of the run.
- Contract revisions increment `version` and preserve the original-request hash.
- Criterion IDs are semantic identities. A human-approved revision that changes an outcome or floor statement must allocate a never-before-used ID and move the old ID/hash to `retiredCriteria`; IDs cannot be reused with new meaning. Plan-only reshapes retain the existing criterion hashes and counters, while retired-criterion counters remain archived and inactive.
- A mission-enabled run requires `acceptance-criteria.md`. Its `OUT-*` IDs and text after each `OUT-N:` prefix must exactly match the contract outcomes, it must pass the existing criteria lint, and its hash is pinned beside the mission hash. The contract is the outcome source of truth; the Markdown file supplies the detailed verification mapping.
- Loop initialization pins the existing plan hash; standard flows pin a plan when one is supplied. A plan-only reshape updates that hash without editing the mission contract.
- Protected mutation paths verify the pinned mission, criteria, and plan hashes before changing state.
- Tampering blocks the command with a recovery message; it never silently re-pins.
- `strategyEpoch` begins at `1` and increments when the plan, contract, or measured environment baseline is deliberately changed.
- Mission appetite never weakens OPC's existing hard step/tick/time ceilings. `maxRepairCycles` counts only corrective work: in standard flows it increments when a negative artifact verdict commits a transition to build/hotfix; in loop mode it increments when a generated artifact-fix unit is claimed. Initial planned build units do not count. Token and wall-time caps are enforced when the harness has a measured value and otherwise reported as `unknown`, never guessed. Expiry always opens a non-retryable Mission Gate.
- Runs without `--mission` retain legacy behavior. OPC documentation will require it for `/opc loop` and recommend it for long-range flows.
- `before_finalize` is the only default scheduled checkpoint. Intermediate `loop_unit` checkpoints are explicit Bet Card boundaries; Phase 1 adds no periodic reviewer wake-up.

The mission summary and `strategyEpoch` are injected through the existing shared prompt-context path and into loop resume/checkpoint prompts. The full contract remains a file reference so prompts stay compact.

### Parent/child session authority

In loop mode, the loop session is the canonical mission owner. Any nested OPC flow is initialized with `--parent-session <loop-session-dir>` and stores the canonical parent path and pinned parent mission hash instead of creating an independent mission contract. Every protected child mutation validates the live parent integrity and pending state first; a pending or unreadable parent fails closed, including for a child flow created before the parent gate opened. Mission decisions invoked from a child redirect to the canonical parent session. Standalone flows remain their own canonical owner.

## 6. Finding Contract

Every red or yellow review finding gains three machine-readable fields:

```text
class: ARTIFACT
criterion: OUT-1
finding_ref: NEW
fingerprint: checkout-total-rounding
invariant: Displayed checkout total equals the persisted sum of line items, tax, and shipping.
```

Allowed classes:

| Class | Meaning | Route |
|---|---|---|
| `ARTIFACT` | Current artifact violates a frozen criterion and can be fixed without changing plan or oracle | One local repair |
| `PLAN` | Architecture, decomposition, sequence, or test strategy cannot satisfy the frozen mission | Mission Gate; propose affected-plan reshape |
| `GOAL_SPEC` | The desired outcome, floor, non-goal, appetite, or oracle must change | Human re-bet only |
| `ENVIRONMENT` | A repository, dependency, API, runtime, policy, or user assumption measurably changed | Recon, refresh baseline, then reclassify |

Validation rules:

- Red and yellow findings in mission-enabled runs require `class`, `criterion`, and `finding_ref`; `NEW` findings also require `fingerprint` and `invariant`.
- `criterion` must reference an existing `OUT-*` or `FLOOR-*` ID, or be `UNLINKED`.
- `finding_ref` is an existing harness-assigned `FIND-N` or `NEW`. A new finding also supplies `fingerprint`, a semantic invariant slug rather than prose position or issue-opening words, and one canonical `invariant` statement.
- Missing or ambiguous metadata is a review-quality failure. It causes evaluator redispatch, not builder mutation.
- An `UNLINKED` finding remains visible in the deferred backlog but cannot drive the current repair loop. If it exposes a new evidenced protected-floor risk, it is classified `GOAL_SPEC` and opens a human re-bet instead of being silently promoted into scope.
- Blue findings may omit the fields.
- Legacy runs continue to accept the existing format.

The harness maintains an append-only finding registry. First-seen entries receive a stable `FIND-N`, criterion-statement hash, fingerprint, and invariant hash; a later reuse of a committed criterion/fingerprint with a different invariant is a collision and fails review quality. Later evaluator prompts include the committed registry snapshot and require reviewers to reference an existing ID or explicitly choose `NEW`. Concurrent `NEW` submissions are registered as one deterministic batch: exact invariant-hash matches coalesce, while differing invariants receive separate IDs even if their fresh reviewers chose the same slug. Alias merging is deferred until pilot evidence shows it is needed. The gate key is `(criterion-statement hash, FIND-N)`, not reviewer prose, and replanning cannot reset the registry or a repeated-failure counter.

## 7. Trajectory Gate

`trajectory-gate.mjs` is a pure decision module. It consumes the mission state, transition/tick history, parsed findings, and evidence delta; it returns either `ALLOW_LOCAL` or a pending Mission Gate reason.

Phase 1 triggers:

1. The same canonical finding registry ID fails after one completed local repair.
2. A second negative traversal of the same repair edge occurs without a new current-epoch integrated PASS receipt. Different fingerprints accompanied by positive integrated evidence do not trigger this fallback.
3. A `PLAN`, `GOAL_SPEC`, or `ENVIRONMENT` finding would otherwise enter the artifact repair backlog.
4. Loop mode is about to drain backlog while any non-artifact finding remains.
5. A declared integrated-slice checkpoint is reached, even when local reviews pass.
6. A mission-enabled run is about to report final success without a fresh Mission review in the current strategy epoch.
7. The mission appetite or expiry is reached.
8. A human supplies explicit steering; this opens the gate immediately without waiting for a failure.

The gate runs before standard-flow state mutation and, in loop mode, before the next unit is claimed or returned, stall handling, completion reporting, or backlog drain. When triggered it:

- leaves the current node/cursor unchanged;
- writes `$SESSION_DIR/trajectory-review-request.json`;
- sets `state.trajectory.pending = true`;
- returns `rebet_required: true` and the reason;
- blocks finalize, `pass`, and further builder dispatch.

The first eligible artifact failure still receives one local repair. The second matching failure cannot start a third patch cycle.

### Minimal evidence receipts

Phase 1 records enough evidence identity to judge trajectory without claiming full criterion coverage. Receipts are emitted only by completed mechanically evidence-bearing standard-flow `execute` nodes and loop `e2e`/`accept`/`ux-sim` units.

```json
{
  "id": "EV-17",
  "sliceId": "F1.8",
  "scenarioId": "SCENARIO-1",
  "scope": "integrated",
  "validatorType": "e2e",
  "validator": "e2e checkout",
  "result": "PASS",
  "artifactHashes": ["sha256:..."],
  "strategyEpoch": 1,
  "observedAt": "2026-08-15T12:00:00Z"
}
```

The receipt is mechanical: it is derived from a completed validator and hashes only its evidence artifacts, not every artifact in the run. `scope: integrated` requires both a `scenarioId` matching the contract's end-to-end scenario or declared checkpoint and an allowed integration `validatorType`; node type or reviewer prose alone is insufficient. A narrow unit-only `test-execute` result receives `scope: local`. The **evidence delta** is the set of new receipt hashes since the previous Mission Gate. Only a current-epoch integrated PASS receipt counts as positive progress for the repair-edge fallback. Phase 2 adds the stronger claim that each receipt satisfies named outcomes.

### Central mutation guard

One shared guard is called by every command that can advance or redirect protected work: `transition`, `advance`, `finalize`, `pass`, `skip`, `goto`, `complete-tick`, `next-tick`, and `reinit-loop`. While `trajectory.pending` is true, only these operations are allowed:

- read-only validation, reporting, visualization, replay, and packet export;
- attach evidence to the pending Mission Gate;
- record `mission-decision`;
- `stop` or `STOP_SALVAGE`.

The guard also performs mission/criteria/plan integrity checks. This closes direct state-mutation bypasses without changing legacy behavior in mission-less sessions.

### Commit boundary

A trigger never discards work that has already been validly reviewed. Standard-flow interception happens before transition mutation; after `CONTINUE_CURRENT`, the orchestrator reruns the same sealed transition under a one-use allowance.

Loop `complete-tick` commits the reviewed tick normally, including finding history and the candidate next unit. Non-artifact findings are kept out of the artifact repair backlog. `next-tick` evaluates the trajectory before it claims or returns another unit; when triggered it sets `status: mission_pending` and leaves the already-committed next-unit cursor untouched. A decision resumes from that cursor, replaces it with an approved revised-plan cursor, or stops. No deferred cursor or duplicate completion path is introduced.

## 8. Cold-context Decision Packet

The packet contains only information needed to judge the bet:

- mission contract path, version, hash, and strategy epoch;
- original request and end-to-end scenario;
- current outcomes, floors, non-goals, appetite, and assumptions;
- owner, affected parties, current mode, and who bears maintenance or exit cost;
- integrated validator and reality-signal summary;
- affected criteria and grouped finding registry IDs;
- changed files/artifact manifest and plan summary;
- the evidence delta since the last Mission Gate;
- allowed decisions and their expected reversibility.

It excludes local review transcripts and proposed line-by-line fixes. The cold reviewer is asked to classify and route the failure, not to perform another code review.
Each reality signal is settled as `SUPPORTS`, `REFUTES`, or `INSUFFICIENT`. “We learned something” or “the code may be reusable” can improve salvage value, but cannot be reported as mission success.

A perspective such as “What would 37signals think?” may be included as an advisory lens:

> Would we place this bet today? What is core versus packaging? Has the appetite expired? Should we continue, shrink, reuse, or stop?

The lens never overrides deterministic evidence, protected floors, or the mission owner.
This is a bounded-bet synthesis inspired by public Shape Up practices, not a claim that OPC's gate is an official 37signals process. Its external calibration asks who gains refusal power, who loses voice or predictability, and who bears maintenance, support, or exit costs.

### Required cold-review artifact

The harness does not call a model. When it returns `rebet_required`, the OPC protocol dispatches exactly one fresh mission reviewer and requires a schema-validated `$SESSION_DIR/mission-review.json`:

```json
{
  "schemaVersion": 1,
  "triggerId": "TRJ-3",
  "reviewer": {
    "runId": "mission-review-3",
    "contextMode": "cold",
    "provenanceRecordHash": "..."
  },
  "bindings": {
    "missionSha256": "...",
    "acceptanceCriteriaSha256": "...",
    "planSha256": "...",
    "evidenceSetSha256": "...",
    "artifactManifestSha256": "...",
    "strategyEpoch": 1
  },
  "classification": "PLAN",
  "realitySignals": [
    { "id": "SIG-1", "status": "REFUTES", "evidenceReceiptIds": ["EV-17"] }
  ],
  "recommendation": "RESHAPE_SMALLER",
  "rationale": "The current decomposition cannot prove the integrated outcome.",
  "localFixesIncluded": false,
  "reviewedAt": "2026-08-15T12:10:00Z"
}
```

`classification` is one of the four finding classes or `NONE` for a green scheduled/final checkpoint. Packet generation records a signed provenance event for the trigger and cold-context digest. A review is valid only when its trigger and all bindings match current state, `localFixesIncluded` is false, and its signed review run ID differs from every recorded build/evaluation run ID in the current epoch. Fresh-agent dispatch remains an OPC protocol invariant because the harness has no trustworthy host-level agent identity source; run provenance is auditable, not cryptographic proof of the model process. A checkpoint receipt must reference the accepted review hash and provenance record; `CONTINUE_CURRENT` alone can never manufacture a Mission pass.

For `before_finalize`, validity is stricter: classification must be `NONE`, recommendation must be `CONTINUE_CURRENT`, no reality signal may be `REFUTES`, every required signal must be `SUPPORTS`, and each `SUPPORTS` entry must cite at least one current-epoch integrated PASS receipt bound to the declared scenario. A required `INSUFFICIENT` signal keeps the run paused. Human approval may revise the bet or stop it, but cannot convert unresolved or refuting evidence into mission success.

## 9. Mission Decision Command

Add:

```text
opc-harness mission-decision --action <ACTION> --actor <agent|human> [--phase <intent|resume>] [--intent <event-id>] [--note <text>] [--review <path>] [--mission <revised-file>] [--criteria <revised-file>] [--plan <revised-file>] [--evidence <path>] [--resume-unit <id>] [--approval <path>] [--dir <path>]
```

The command appends one canonical signed event to OPC's existing session provenance ledger with timestamp, actor, prior state hash, decision, rationale, affected criteria, old/new contract hash, old/new plan hash, evidence reference, and old/new strategy epoch. Any `steering-events.jsonl` view is derived from that ledger, not a second source of truth. A fresh mission reviewer may recommend a route; the root orchestrator records the decision. Human comments can invoke the command even when no gate is pending, in which case the command snapshots a manual Mission Gate before applying the decision.

An agent decision on a system-triggered gate requires `--review` and must match its recommendation. A human may override a recommendation only with `--approval`; the divergence is recorded. The final `CONTINUE_CURRENT` requires a bound cold review with `classification: NONE` and `recommendation: CONTINUE_CURRENT` regardless of actor.

Decision semantics:

- `CONTINUE_CURRENT`: clear pending and grant exactly one additional bounded local attempt. At a scheduled checkpoint with no failure, it instead records that the current epoch passed that checkpoint; at the final checkpoint it permits one finalization attempt.
- `RESHAPE_SMALLER`: accept an affected-plan revision, increment epoch, and mark prior-epoch evidence stale by default. One plan-only reshape is allowed from a fresh planner without human approval; any contract revision requires `--actor human` plus a matching revised criteria file. Loop resume uses the deterministic revised-plan rule below.
- `RESTORE`: record intent and remain pending. The external orchestrator performs the restore; a later decision attaches a checkpoint/Git-tree receipt before resuming.
- `RECON`: record intent and remain pending. External recon supplies a measured delta; the resume decision validates/copies that evidence, updates the baseline hash and epoch, and atomically replaces the current trigger with a new pending `ENVIRONMENT_RECLASSIFY` trigger. The cursor stays fixed until a fresh cold review reclassifies the finding.
- `HUMAN_REBET`: record intent and remain pending until a later decision supplies human approval and mutually consistent revised contract/criteria files.
- `STOP_SALVAGE`: terminate the bet without reporting success and surface the salvage instructions.

`GOAL_SPEC` findings can only resolve through a human-approved contract revision. Ordinary `pass`, `skip`, or a reviewer persona cannot change the mission contract or protected floors.

`--actor` is provenance metadata, not authentication: the current harness cannot cryptographically distinguish a user instruction from an agent process. A goal-specification change therefore also requires `--approval <path>` containing the verbatim user approval; the file is copied, hashed, and referenced in the steering event. This is an auditable protocol guarantee against accidental autonomous goal drift, not a security boundary against a malicious caller. If Codex later exposes host-signed approvals, the same field can become mechanically authenticated without changing the event model.

Decision authority is intentionally asymmetric:

| Finding/decision | Agent authority | Human authority |
|---|---|---|
| One more bounded artifact attempt | May choose once from cold evidence | May choose |
| Plan-only reshape | May choose once per canonical finding ID | May choose |
| Environment recon | May choose when a concrete delta can be measured | May choose |
| Change outcome, floor, non-goal, appetite, or oracle | Must pause | May approve a versioned contract revision |
| Stop and salvage | May recommend; may stop at hard expiry | May choose |

### Atomic decision commit

`mission-decision` uses one canonical-session lock and a recoverable prepare/commit sequence:

1. Validate the current state, pending trigger, review/approval, and every proposed mission, criteria, plan, or evidence file before writing.
2. Copy validated inputs to an immutable `$SESSION_DIR/decisions/<decision-id>/` directory and write a manifest containing old/new hashes and the intended state delta.
3. Append one signed `decision_prepared` provenance record for that manifest.
4. Atomically update the canonical flow/loop state to point at the versioned files and provenance record. This state write is the commit point.

If a crash occurs before step 4, the prepared record and staged files are harmless orphans and active hashes remain unchanged. If it occurs after step 4, the state contains every path and hash needed to resume. The next protected mutation validates the referenced manifest before proceeding. No in-place contract/criteria/plan overwrite or multi-file rollback is required.

`RESTORE`, `RECON`, and `HUMAN_REBET` are two-phase actions. `--phase intent` records a pending action and returns its event ID without clearing the gate. `--phase resume --intent <event-id>` must match the same trigger/action and be the next decision for that gate:

- `RESTORE` requires a schema-validated checkpoint/Git-tree receipt and explicit `--resume-unit`; the unit must exist in the active plan, and receipts/tick results at or after it are marked stale.
- `RECON` requires a measured environment-delta receipt, updates the baseline hash/epoch, preserves the already-committed cursor, and opens a new pending `ENVIRONMENT_RECLASSIFY` trigger. It does not clear the gate or permit dispatch. A fresh Mission review must classify the new baseline and a later decision chooses the route. If recon changes the plan, that later route is `RESHAPE_SMALLER` instead of hiding replan inside recon.
- `HUMAN_REBET` requires approval plus mutually consistent mission/criteria files. With no revised plan it resumes the committed cursor; with a revised plan it uses the rule below.

For any revised loop plan, each unit has a **lineage hash** over its ID, full definition, and ordered predecessor lineage. The harness compares the revised plan with completed tick history and selects the first unit after the longest identical completed prefix. Reordering, inserting, removing, or editing a unit changes lineage at the first affected position, so work resumes there. If the entire revised plan is an identical completed prefix, the run goes to the final Mission checkpoint rather than auto-terminating. The selected cursor is written in the same atomic decision commit and returned in command output.

## 10. Review-quality Separation

The central parser exposes one additive boolean, `review_quality_ok`. Existing emoji-count behavior remains the artifact gate when that boolean is true. If review quality fails, outward `verdict` becomes `BLOCKED` with `reevaluate_required: true`; no graph route or builder mutation is allowed. Parsed findings are written only as non-routing `$RUN_DIR/review-claims.json`, each with a stable claim hash; no provisional artifact verdict is persisted or merged.

For mission-enabled runs, existing signals are split as follows:

| Input | Artifact verdict | Review-quality verdict |
|---|---:|---:|
| Accepted red/yellow/blue domain finding | Yes | No |
| Explicit acceptance-criterion PASS/FAIL evidence | Yes | No |
| Deterministic extension finding | Yes | No |
| Missing/invalid verdict or count mismatch | No | Yes |
| Unstructured finding, missing reasoning/fix, or missing required mission metadata | No | Yes |
| Missing required evaluator output or evaluator blocked without reproducible evidence | No | Yes |

The fresh evaluator receives those claims—not the original local-review transcript—and must disposition each as `CONFIRM`, evidence-backed `REJECT`, or `SUPERSEDE`. `CONFIRM`/`SUPERSEDE` must produce a valid canonical finding; unresolved claims keep review quality blocked. Claims never enter finding counters or builder routes on their own. Standard `advance`/`transition` and loop `complete-tick` enforce the same `review_quality_ok` rule. One automatic reevaluation is allowed; a second invalid review opens a `REVIEW_QUALITY_STALL` Mission Gate instead of another evaluator loop. Mission-less sessions keep their current behavior during the Phase 1 rollout.

## 11. Termination and Loop Bounds

The outer gate is bounded as strictly as the inner loop:

- one local repair is allowed for a canonical artifact finding ID;
- one cold Mission review is allowed per trigger;
- one agent-authorized plan-only reshape is allowed per canonical finding ID;
- if the same invariant survives that reshape, the run pauses for `HUMAN_REBET` or `STOP_SALVAGE`;
- no second cold review runs without new integrated evidence, a measured environment delta, or explicit human steering;
- reaching appetite or expiry prevents another automatic retry;
- a pending Mission Gate is a pause, never a success state.

Phase 1 finalization still uses OPC's existing acceptance mechanics, but additionally requires a valid mission hash, no pending Mission Gate, and one fresh cold Mission pass in the current strategy epoch. Phase 2 strengthens success to require explicit, current evidence for every mission criterion.

## 12. State Additions

Flow and loop state gain an additive object:

```json
{
  "mission": {
    "path": "mission-contract.json",
    "parentSession": null,
    "sha256": "...",
    "originalRequestSha256": "...",
    "acceptanceCriteriaSha256": "...",
    "planSha256": "...",
    "criterionHashes": { "OUT-1": "...", "FLOOR-1": "..." },
    "version": 1,
    "strategyEpoch": 1
  },
  "trajectory": {
    "pending": false,
    "triggerId": null,
    "reason": null,
    "pendingAction": null,
    "pendingActionEventId": null,
    "lastDecision": null,
    "retryAllowance": 0
  },
  "findingRegistry": [],
  "evidenceReceipts": [],
  "checkpointReceipts": []
}
```

Finding history stores class, criterion, finding registry ID, strategy epoch, verdict, and evidence-delta marker. A passed checkpoint receipt binds `checkpointId`, `strategyEpoch`, mission/criteria/plan hashes, the evidence-set hash, accepted mission-review hash/provenance record, decision event ID, and timestamp. Finalization accepts only a `before_finalize` receipt whose bindings still match; new evidence, a baseline refresh, or any reshape makes the receipt stale instead of reopening the same gate forever. Fields are additive; no new graph node or required external-flow field is introduced.

## 13. Phase 2: Explicit Evidence Traceability

After Phase 1 proves that the gate triggers at useful times, add strict completion mapping:

```text
OUT-1 -> unit-03 -> artifact/test result -> fresh PASS evidence
FLOOR-1 -> deterministic validator -> fresh PASS evidence
```

Planned rules:

- `complete-tick --satisfies OUT-1,OUT-2` records explicit coverage.
- Finalization requires current-epoch integrated evidence for every outcome and floor.
- Keyword overlap or a scope description does not count as evidence.
- A reshape invalidates prior-epoch evidence unless the decision explicitly marks it reusable.
- Mission success requires a fresh cold Mission review after all mappings pass.

This is deferred so Phase 1 can measure gate precision without simultaneously replacing OPC's current scope-coverage model.

## 14. Implementation Seams

Phase 1 adds:

- `bin/lib/mission-contract.mjs`
- `bin/lib/trajectory-gate.mjs`

It integrates at these existing seams:

- flow and loop initialization for mission pinning;
- shared role prompt context and loop resume/checkpoint generation;
- central evaluator parsing;
- standard transition before state mutation;
- loop completion/history persistence;
- loop advancement before stall detection and backlog drain;
- escape and loop-reinit commands through the shared mutation guard;
- harness command dispatch for `mission-decision`;
- finalization guard while a Mission Gate is pending.

No built-in flow graph changes are required.

## 15. Deterministic Tests

Unit tests:

1. Unicode verbatim requests round-trip and hash correctly.
2. Mission init rejects acceptance-criteria outcome IDs or statements that differ from the contract.
3. Contract, criteria, or plan tampering blocks every protected mutation.
4. Red/yellow finding metadata parses and invalid references fail review quality.
5. Invalid-review claims cannot route to build and must receive `CONFIRM`, evidence-backed `REJECT`, or `SUPERSEDE` disposition on the one allowed reevaluation.
6. `UNLINKED` findings stay visible but cannot cause artifact repair; a new floor risk routes to human re-bet.
7. The first artifact failure is allowed; the second same canonical finding ID triggers re-bet.
8. Different finding IDs with a new integrated PASS receipt do not false-trigger.
9. Evidence receipts bind artifact hashes and strategy epoch; model prose alone cannot create one.
10. `PLAN`, `GOAL_SPEC`, and `ENVIRONMENT` cannot enter artifact backlog.
11. A pending gate blocks transition, advance, finalize, pass, skip, goto, complete/next tick, and reinit-loop while stop remains available.
12. A loop review commits once, then `next-tick` pauses before claiming or returning the already-selected next unit.
13. `--actor human` without a hashed approval artifact cannot revise the contract.
14. A decision preserves the original-request hash and grants at most one retry.
15. Reshape increments strategy epoch; replan cannot launder old counters.
16. A locally green run pauses at a declared checkpoint and before first finalization.
17. A bound final-checkpoint receipt permits finalization without reopening the gate.
18. A final Mission pass is invalidated by new evidence, reshape, or environment refresh.
19. A Mission review with stale bindings, missing provenance, warm-context mode, or a reused build/evaluation run ID cannot clear a gate.
20. A pending parent loop blocks mutation in an already-created nested child flow.
21. Finding registry assignment, exact batch coalescence, parallel-new separation, reuse, and committed-registry collision rejection are deterministic.
22. Changed criterion semantics require a new ID; plan-only reshape preserves active finding counts.
23. Injected crashes before and after the atomic decision commit recover without mixed hashes or partial active files.
24. `RESTORE` and `RECON` remain pending until a second decision attaches a valid external receipt.
25. A second consecutive invalid review opens `REVIEW_QUALITY_STALL` instead of redispatching again.
26. Final success rejects any `REFUTES`, any required `INSUFFICIENT`, or any `SUPPORTS` without a bound current-epoch integrated receipt.
27. Unit-only evidence from a standard `test-execute` node cannot mint an integrated receipt or suppress a trajectory trigger.
28. Revised-plan lineage selects the first changed unit when the old cursor is removed, edited, inserted around, or reordered, and an all-complete plan routes to final Mission review.
29. Two-phase resume rejects a missing, stale, mismatched-action, or superseded intent event.
30. Restore resume rejects a nonexistent unit and marks evidence at/after a valid selected unit stale.
31. Recon resume opens a new `ENVIRONMENT_RECLASSIFY` trigger and permits no builder dispatch before its fresh review and decision.

CLI integration tests:

1. Initialize a mission-enabled standard flow, repeat a failure, verify no node mutation and a cold packet.
2. Initialize loop mode, trigger before the existing three-tick stall threshold and before backlog drain.
3. Record a mission decision, resume once, and verify the next repeat pauses again.
4. Verify mission-less legacy flow behavior remains unchanged.

The complete existing test suite must remain green.

## 16. Rollout and Measurement

Start with mission-enabled long-range runs only. Record:

- repeated local cycles prevented;
- gate trigger class and human-selected route;
- false-positive gates;
- post-decision mission progress;
- stopped/salvaged bets;
- review-quality redispatches;
- duplicate finding registrations that would justify a future alias mechanism;
- added wall-clock and token overhead.

Pilot for ten representative runs or two weeks, whichever produces more evidence. Proceed to Phase 2 only if the gate reliably distinguishes local repair from plan/goal/environment failures. If it becomes another nitpicker, restrict its output to classification and routing and remove local-fix prose from the packet.

## 17. Acceptance Criteria

Phase 1 is complete when:

- a versioned, hash-pinned mission contract survives resume and compaction;
- mission and acceptance-criteria outcomes cannot diverge, and semantic criterion revisions cannot reuse stale IDs;
- repeated stable findings trigger before a third local patch cycle;
- locally green work receives a cold outcome-level check at declared slice boundaries and before final success;
- a final Mission pass requires a bound cold-review artifact attributable to a distinct signed review run;
- final success requires every required reality signal to be supported by current scenario-bound integration evidence, with no refuting signal;
- plan, goal-specification, and environment failures route outside artifact backlog;
- malformed review metadata redispatches review without mutating code state;
- human steering is durable and increments strategy epoch when appropriate;
- protected floors and pending Mission Gates cannot be bypassed by ordinary pass;
- a pending parent loop blocks already-created nested child flows;
- decision commits recover without mixed contract, plan, evidence, or state hashes;
- replan/restore/recon/re-bet resumes from a deterministic validated cursor and cannot auto-terminate because the old unit disappeared;
- mission-less flows remain backward compatible;
- all new deterministic tests and the full OPC suite pass;
- independent final review finds no critical correctness or compatibility issue.
