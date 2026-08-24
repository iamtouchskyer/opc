# Gate Protocol

Gates aggregate upstream verdicts and route the flow. Gates do not dispatch subagents — the orchestrator executes gates directly using harness commands.

## Procedure

### Step 1 — Synthesize Upstream Verdicts

Run the harness to compute the aggregate verdict:

```bash
opc-harness synthesize $SESSION_DIR --node {UPSTREAM_NODE_ID}
```

Output: `{ verdict, totals: { critical, warning, suggestion }, roles[], evalQualityGate?, evaluatorGuidance? }`

**D2 Compound Eval Quality Gate (enforce by default):**
The synthesize command stacks 11 defense layers per role (thinEval, noCodeRefs, lowUniqueContent, singleHeading, findingDensityLow, missingReasoning, missingFix, lineLengthVarianceLow, aspirationalClaims, changeScopeCoverage, invalidRefCount×2). If ≥3 layers trip on any role → `verdict = FAIL`. Pass `--no-strict` to downgrade to shadow mode (output `evalQualityGate.triggered=true` without changing verdict).

**thinEval substance exemption:** Evals under 50 lines are exempt from thinEval if every finding has reasoning + fix + file ref.

**--base ref validation:** Pass `--base <project-root>` to validate file:line references against the filesystem. Fabricated refs count as 2 layers in the compound gate. When `--base` is provided and git history is available, the changeScopeCoverage layer checks that the eval mentions ≥30% of the changed files. Note: `changeScopeCoverage` and `invalidRefCount` only activate when `--base` is provided and git is available — they are conditional layers.

**changeScopeCoverage scope (`--change-commits`):** The set of "changed files" is scoped to the commits the flow actually **produced**, not a blind `git diff HEAD~1`. `finalize`/`advance` pass `--change-commits <csv>` from `flow-state.producedCommits` (recorded via `opc-harness record-commit`, see below). Behavior:
- **Empty set** (`--change-commits` present but empty, i.e. the flow committed nothing yet — e.g. it reviewed a session-local artifact): changeScopeCoverage **skips cleanly**. This removes the structural false-positive where a blind `HEAD~1` diff mis-attributed unrelated parallel commits or could not see an uncommitted artifact.
- **Non-empty set**: the layer diffs exactly those commits' files and still enforces the ≥30% coverage rule — the gate keeps biting on a genuine coverage gap.
- **Flag absent** (`--change-commits` not passed at all): legacy `git diff HEAD~1` fallback is preserved for direct manual `synthesize --base` calls.

**Recording produced commits:** After the orchestrator commits delivered code, it MUST record the commit so the gate can scope coverage to it:
```bash
opc-harness record-commit [--sha <sha>]   # defaults to HEAD of the project root
```

`record-commit` acquires the same flow-state lock used by Mission decisions,
then rereads and validates the current state before appending the resolved full
commit SHA. It never writes a pre-lock snapshot, so a concurrent gate or
decision cannot be erased by a stale commit-record update.
This appends the (dedup'd, full-length) sha to `flow-state.producedCommits`. Fail-closed: an invalid sha or missing `flow-state.json` is a hard error, not a silent skip.

**Evaluator guidance (feedback loop):** When D2 triggers, the output includes `evaluatorGuidance` — a per-role object with `triggeredLayers` (which checks failed) and `hints` (actionable fix instructions). On ITERATE, the orchestrator SHOULD inject this guidance into the R2 evaluator prompt so the evaluator knows exactly what to fix.

### Step 1.5 — Structured Result Check

Before mechanical validation, the gate reads structured data from upstream artifacts. This catches failures that the verdict alone cannot express (e.g., a node can PASS at the orchestration level while its report contains test failures).

**Artifact schema:** Upstream nodes (especially execute and build nodes) MAY write structured result files as part of their artifacts. These files are JSON objects containing any subset of the fields below. The artifact's `type` in the handshake must be `"report"` or `"test-result"` for this check to read it. The path in `artifacts[].path` is relative to the node directory.

**Procedure:**

1. Scan `$SESSION_DIR/nodes/*/handshake.json` for all upstream nodes in this gate's path
2. For each handshake, inspect the `artifacts[]` array. For artifacts with type `report` or `test-result`, read the referenced file
3. **Error handling:** If an artifact file is missing, unreadable, or contains malformed JSON → treat as **FAIL** with reason `"artifact {path} unreadable — fail-closed"`. Structured checks are fail-closed: broken data = gate FAIL, not silent pass.
4. Parse these structured fields (if present in the artifact JSON). **Type coercion:** numeric fields may appear as strings (e.g., `"3"` vs `3`); coerce to integer before comparison. If coercion fails (non-numeric string) → treat as 0 and log a warning.
   - `test_fail_count` — number of failed tests
   - `dead_test_count` — number of dead/unreachable tests
   - `p0_count` — number of unresolved P0 issues
   - `sync_check_status` — sync verification result (`"PASS"` or `"FAIL"`)
5. Apply hard FAIL rules — any single violation triggers gate FAIL:

| Field | Condition | Gate action | Reason string |
|-------|-----------|-------------|---------------|
| `test_fail_count` | `> 0` | **FAIL** | `"{N} test(s) failed"` |
| `dead_test_count` | `> 0` | **FAIL** | `"{N} dead test(s) detected"` |
| `p0_count` | `> 0` | **FAIL** | `"{N} P0 issue(s) unresolved"` |
| `sync_check_status` | `== "FAIL"` | **FAIL** | `"sync-check failed"` |

6. If multiple fields trigger, concatenate all reasons (semicolon-separated) into one FAIL verdict
7. If no artifacts with type `report` or `test-result` exist in any upstream handshake, this step is a no-op (backward compatible — older sessions without structured data pass through)

**This check applies to ALL gate nodes** (gate-test, gate-acceptance, gate-audit, gate-e2e, gate-final), not just gate-final. The principle: if any upstream node produced structured evidence of failure, the gate must catch it regardless of the node-level verdict.

**Override:** The orchestrator MUST NOT skip or relax these rules. If structured data says tests failed, the gate FAILs — even if the upstream node verdict was PASS. `/opc pass` (explicit user override) also runs Step 1.5 — it is NOT a bypass. If Step 1.5 detects failing artifacts, `/opc pass` is rejected.

### Step 2 — Mechanical Validation

Before accepting the synthesized verdict, verify upstream quality:

- Every finding must have a severity emoji (🔴 🟡 🔵)
- Every 🔴 critical finding must have a `file:line` reference
- Every 🔴 critical finding must have a `→ Fix:` suggestion
- Flag hedging language (might, could, potentially) — challenge or downgrade

If mechanical checks fail, re-dispatch the upstream evaluator with a reminder. Max 2 re-dispatch attempts — after that, accept with ⚠️ annotation.

### Step 3 — Route Decision

Use the harness to determine the next node:

```bash
opc-harness route --node {GATE_ID} --verdict {VERDICT} --flow {FLOW_TEMPLATE}
```

Output: `{ next: "<nodeId>" | null, valid: true }`

- `next = null` means the flow is complete.
- `valid = false` means the gate or verdict is not in the flow template — surface error to user.

**Do not determine the next node yourself.** Always use the `route` command.

### Step 4 — Transition

Execute the transition (also writes this gate's handshake.json automatically):

```bash
opc-harness transition --from {GATE_ID} --to {NEXT_NODE} --verdict {VERDICT} --flow {FLOW_TEMPLATE} --dir $SESSION_DIR
```

Output: `{ allowed: true/false, reason, next, state }`

- `allowed = true` → proceed to next node
- `allowed = false, rebet_required = true` → a Mission Gate opened. Follow
  [Mission Gate (side-band)](#mission-gate-side-band) below; ordinary escape
  hatches cannot bypass it.
- `allowed = false` without `rebet_required` → a mission-less cycle limit was
  reached. Surface to user with escape options:
  - `/opc pass` — force PASS, advance to the PASS edge target
  - `/opc stop` — terminate flow, preserve state
  - `/opc goto <node>` — manual override (still checked against cycle limits)

The `transition` command automatically:
1. Validates the edge exists in the flow template
2. Checks cycle limits (maxLoopsPerEdge, maxTotalSteps, maxNodeReentry)
3. Writes this gate's `$SESSION_DIR/nodes/{GATE_ID}/handshake.json`
4. Updates `$SESSION_DIR/flow-state.json`

### Mission Gate (side-band)

Mission mode is opt-in at `init`/`init-loop`. It does not add a graph node or a
new verdict. Instead, the harness intercepts protected mutation and returns
`rebet_required: true` while leaving the graph node or committed loop cursor in
place.

Before trusting or mutating a Mission session, the harness recovers and verifies
the whole runtime-state seal. Each generation is written as full staged state,
signed PREPARE, atomic active-state replacement, signed COMMIT, then stage
cleanup. The digest covers trajectory, findings, evidence/checkpoints, cursor,
history, limits, status, ownership, and policy; stripping `mission` or rolling
back an older state cannot downgrade the run while the ledger remains intact.
This is crash-recoverable session integrity, not hostile-key security: the HMAC
key and ledger are the trust root.
Unsealed bootstrap cannot overwrite signed authority: `init --force`,
`init-loop`, and `reinit-loop` refuse reuse/reset of an existing Mission
session. Preflight checks both flow/loop state filenames, so active-state
deletion or cross-mode initialization cannot hide intact-ledger authority.

The gate opens when any of these deterministic conditions is observed:

- a `PLAN`, `GOAL_SPEC`, or `ENVIRONMENT` review finding;
- the same canonical `ARTIFACT` finding fails after its first local repair;
- the same negative repair edge repeats without new current-epoch integrated
  PASS evidence;
- `appetite.maxRepairCycles` is reached, measured `appetite.maxWallTimeHours`
  elapses, or `appetite.expiresAt` passes (for either a standard flow or loop);
- runtime-supplied finite `trajectory.measuredTokens` reaches
  `appetite.maxTokens` (no production OPC token meter currently writes it, so
  normal runs report token use as unknown);
- a frozen assumption reaches `freshUntil` (`ASSUMPTION_EXPIRED`, retryable);
- an explicit `loop_unit` checkpoint or the mandatory final checkpoint is due;
- review metadata is invalid twice consecutively (`REVIEW_QUALITY_STALL`);
- a standard flow reaches `maxTotalSteps`, `maxLoopsPerEdge`, or
  `maxNodeReentry` (`LEGACY_FLOW_LIMIT_REACHED`, non-retryable; retry grants do
  not bypass it);
- the run is about to finalize without a current bound Mission pass;
- explicit human steering snapshots a `HUMAN_INTERVENTION` gate before applying
  its audited decision.

Finding classes are routing facts, not severities:

| Class | Meaning | Normal Mission route |
|---|---|---|
| `ARTIFACT` | The implementation violates a frozen criterion | One local repair; repeat opens the gate |
| `PLAN` | Decomposition/architecture/test strategy cannot satisfy the frozen mission | `RESHAPE_SMALLER` or human decision |
| `GOAL_SPEC` | Outcome, floor, appetite, non-goal, or oracle must change | `HUMAN_REBET` or `STOP_SALVAGE` |
| `ENVIRONMENT` | Measured repository/runtime/policy assumptions changed | `RECON`, then fresh classification |

An ordinary `criterion: UNLINKED` finding is audit/backlog data and cannot steer
artifact repair. The single routing exception is a new protected-floor risk
declared as `class: GOAL_SPEC`, `criterion: UNLINKED`, with a non-empty
`evidence:` field. That exception opens a non-retryable gate whose only routes
are `HUMAN_REBET` and `STOP_SALVAGE`.

`ASSUMPTION_EXPIRED` is an environment-level trigger: it identifies the expired
`ASM-N` entries in the packet and remains retryable so `RECON` can measure the
new environment before fresh classification.

The trajectory packet binds the mission, criteria, plan, evidence set, current
artifact manifest, and strategy epoch. Its compact Mission view includes the owner,
affected parties, mode, original request, outcomes, floors, non-goals, appetite,
scenario, reality signals, guardrails, assumptions, and exit/salvage instructions.
It also carries a bounded `findingSummary` (stable ID, class, criterion/hash,
  fingerprint, and invariant/hash; at most 50 entries), `validatorSummary` (at
  most 100 current integrated PASS
receipts and required signal IDs), and an `artifactSummary` bound to the same
manifest hash as the review bindings. That artifact summary names the canonical
project root and Git HEAD, at most 200 changed Git entries, and at most 200
declared artifact entries, including ignored/non-Git deliverables. The packet includes
only current-epoch integrated PASS receipts added since the prior gate. Each
evidence-delta entry includes a hash of the full receipt and its scenario,
validator type, `satisfies` IDs, and artifact hashes; opening the gate advances
stable seen-receipt IDs as well as the compatibility count cursor.
The harness also records an exact `origin`
`{command,sessionSha256,fromNode,nextUnit,edgeKey}`, assigns
`reviewRequest.runId` and `contextMode: "cold"`, hashes
the complete packet, records a signed `mission_gate_opened` event with the
trigger/run/mission/plan/epoch bindings, and then publishes
`trajectory-review-request.json`. Any later mismatch among state, public packet,
or signed opening record fails closed. The HMAC record provides crash-recoverable
session integrity and attribution; it does not prove safety against a hostile
process that can read the session key and rewrite every session file.
`appetiteStatus` reports charged repair cycles, measured wall time, and token use
(`unknown` without a runtime writer), while `allowedDecisions` is the executable
action set for this exact trigger and `decisionGuidance` states reversibility.

For a retryable non-checkpoint trigger, that set contains all six actions: the
local trigger classification is a hypothesis, and the cold reviewer may
reclassify ARTIFACT, PLAN, ENVIRONMENT, or discover GOAL_SPEC to escape the
local optimum. The review classification matrix then constrains its selected
action. Non-retryable packets expose only `HUMAN_REBET`/`STOP_SALVAGE`; the final
checkpoint exposes only `CONTINUE_CURRENT`/`STOP_SALVAGE`.

Only built-in, harness-run `test-execute` currently mints standard-flow
integrated receipts; custom execute nodes, `e2e-user`, and `post-launch-sim`
remain local until a comparable trusted execution record exists. Eligible
artifacts come only from the sealed latest `run_N`: relative, contained regular
non-symlink files plus non-empty TAP with positive tests and zero failures. The
harness verifies `testCommand`, source-plan, result, node/run, and signed-ledger
provenance. Loop integrated receipts require a
currently claimed unit, contained regular non-symlink artifacts newer than the
claim, and at least one machine PASS hash not used by an earlier receipt.

#### Review-quality reevaluation

Mission review quality covers the verdict itself as well as finding metadata: a
valid/matching `VERDICT` count, structured findings, and non-empty `reasoning:`,
`fix:`, class, criterion, and finding identity. The first invalid review writes
non-routing, hash-addressed claims and requests a fresh evaluation. It does not
increment finding counters or route a builder.

An existing `FIND-N` is not shorthand: the evaluator must repeat its canonical
registry `fingerprint` and `invariant` exactly. Omission or drift is an invalid,
non-routing review. A genuinely new invariant uses `finding_ref: NEW` and
supplies both identity fields.

The fresh run must place this exact file beside its eval artifacts:

```json
{
  "schemaVersion": 1,
  "dispositions": [
    { "claimHash": "<64-hex-sha256>", "disposition": "CONFIRM", "findingRef": "FIND-4" },
    { "claimHash": "<64-hex-sha256>", "disposition": "SUPERSEDE", "fingerprint": "replacement-invariant" },
    { "claimHash": "<64-hex-sha256>", "disposition": "REJECT", "evidence": "current evidence that disproves the claim" }
  ]
}
```

The file is named only `review-claim-dispositions.json`. Include exactly one
entry per pending claim; unknown, duplicate, or missing hashes are invalid.
`CONFIRM` and `SUPERSEDE` must reference a valid routing finding from the fresh
review by `findingRef` or `fingerprint`; `CONFIRM` cannot change class,
criterion, or invariant. `REJECT` needs non-empty string/array/object evidence.
Standard flows bind claims to the immediately prior run and strategy epoch.
Loops additionally require all fresh evals and the disposition file to be
contained regular files in one run directory, newer than the invalid attempt,
and bound to the same unit/epoch. A second invalid attempt opens non-retryable
`REVIEW_QUALITY_STALL`.

#### Cold Mission review

When the gate opens:

1. Stop normal routing and read `$SESSION_DIR/trajectory-review-request.json`.
2. Dispatch exactly one fresh mission reviewer. Give it the packet, the pinned
   Mission Contract named by that packet, and current evidence only—never the
   local patch transcript or proposed line fix.
   A user-supplied advisory lens such as “What would 37signals think?” may be
   added to this cold prompt to challenge the bet, scope, appetite, and salvage
   value. Applied as a framework rather than an impersonation, that lens asks
   whether the bet caps loss, produces the smallest complete reality-tested
   slice, preserves the ability to stop, and makes visible who bears maintenance
   or exit cost and who loses voice. It cannot override evidence, protected
   floors, affected-party safeguards, or owner authority.
3. Write a schema-v1 review whose trigger, harness-issued
   `reviewRequest.runId`, and all bindings exactly match the packet. Do not
   choose or reuse a run ID:

```json
{
  "schemaVersion": 1,
  "triggerId": "TRJ-3",
  "reviewer": { "runId": "<copy packet.reviewRequest.runId>", "contextMode": "cold" },
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
    { "id": "SIG-1", "status": "REFUTES", "evidenceReceiptIds": ["EV-4"] }
  ],
  "recommendation": "RESHAPE_SMALLER",
  "rationale": "The current decomposition cannot prove the integrated outcome.",
  "localFixesIncluded": false,
  "reviewedAt": "2026-08-15T12:10:00.000Z"
}
```

4. Seal and sign the review through the harness:

```bash
opc-harness record-mission-review --review /path/to/cold-review.json --dir "$SESSION_DIR"
```

The command rejects stale bindings, a run ID other than the packet-issued cold
review run, reused build/evaluation run IDs, non-cold
context, and reviews containing local fixes. Use only the sealed path it returns
for `mission-decision`; do not fabricate a provenance hash. Exactly one cold
review may be sealed for a trigger. A duplicate returns `recorded: false` plus
the existing sealed `review` path and does not overwrite it. A later trigger for
the same canonical finding/repair-edge scope cannot seal another cold review
unless its packet contains new integrated evidence, a measured environment
delta, or explicit human steering.

Every declared reality signal must appear exactly once with status `SUPPORTS`,
`REFUTES`, or `INSUFFICIENT`. `SUPPORTS` and `REFUTES` must cite current, non-stale
receipt IDs. The recommendation must be present in the packet's
`allowedDecisions`. The normal classification matrix below explains those
choices; a human can override a recommendation only through the separately
approved decision path and cannot choose an action the packet marks
non-executable:

| Classification | Valid review recommendations |
|---|---|
| `ARTIFACT` | `CONTINUE_CURRENT`, `RESTORE`, `HUMAN_REBET`, `STOP_SALVAGE` |
| `PLAN` | `RESHAPE_SMALLER`, `HUMAN_REBET`, `STOP_SALVAGE` |
| `GOAL_SPEC` | `HUMAN_REBET`, `STOP_SALVAGE` |
| `ENVIRONMENT` | `RECON`, `RESTORE`, `HUMAN_REBET`, `STOP_SALVAGE` |
| `NONE` | `CONTINUE_CURRENT`, `STOP_SALVAGE`; checkpoints only |

At `before_finalize`, the review is stricter: classification must be `NONE`, the
recommendation must be `CONTINUE_CURRENT`, every required reality signal must be
`SUPPORTS`, each supporting signal must cite current-epoch integrated PASS
evidence for the contract scenario, and no signal may be `REFUTES`. Integrated
receipt `satisfies` coverage must include every active `OUT-N` and `FLOOR-N`.

#### Record the decision

```bash
opc-harness mission-decision \
  --action <ACTION> --actor <agent|human> \
  [--review <sealed-review.json>] [--approval <file>] [--note <text>] \
  [--phase <intent|resume>] [--intent <event-id>] \
  [--mission <json>] [--criteria <md>] [--plan <md>] \
  [--evidence <json>] [--resume-unit <id>] --dir "$SESSION_DIR"
```

Decision semantics:

- `CONTINUE_CURRENT` requires a valid sealed review and grants exactly one retry
  bound to the trigger, strategy epoch, canonical `FIND-N`/edge, command, source
  node, and (for loops) next unit. A standard grant is consumed on the first
  matching transition, including a green transition; a loop grant is consumed
  when `next-tick` claims the matching unit. Failure or abandonment cannot
  preserve it, and it cannot authorize an unrelated mutation. The harness
  copies the packet origin into the grant and requires an exact origin match; a
  child transition grant therefore cannot authorize parent `next-tick`. The
  harness remembers the scope, so a later gate cannot grant it another continue. At a
  scheduled/final checkpoint it records a checkpoint receipt instead of a retry
  grant.
- `RESHAPE_SMALLER` validates and pins `--plan`, increments `strategyEpoch`, and
  clears the current gate. In loop mode, full unit-definition/predecessor
  lineages preserve only the longest identical completed prefix; the command
  returns the first changed unit as `resume_unit`, or
  `resume_at_final_checkpoint: true` when the revised plan is already complete.
  An agent may reshape a canonical finding only once. If that invariant recurs,
  every action except `HUMAN_REBET` and `STOP_SALVAGE` is rejected.
- `RESTORE`, `RECON`, and `HUMAN_REBET` are two-phase. First record `--phase
  intent`; then resume with its `intent_id`. Restore needs bound restore evidence
  plus `--resume-unit`; it must match action, intent event, trigger, mission,
  plan, and epoch, and its Git tree must equal the live tree or its checkpoint
  ID/hash must name a current fully bound checkpoint. Recon evidence has the
  same intent/trigger/mission/plan/epoch binding and includes a reproducible
  read-only probe (allowlisted argv, project-contained cwd, timeout at most 15s,
  exit code, and stdout/stderr hashes). Recon rebuilds a fresh live-bound
  environment-classification packet; human re-bet needs approval and
  mutually consistent revised mission/criteria files. For an agent-run restore
  or recon, the intent binds the one sealed cold review; its matching resume
  carries that binding and rejects a second review.
- `RESTORE` resume rejects a no-op. A live `gitTreeSha` must name the current
  clean tree and differ from the tree recorded by the signed intent; otherwise
  evidence must name a still-current fully bound checkpoint receipt.
- `RECON` intent requires `--evidence` with `action: RECON`,
  `type: environment_baseline`, and a
  reproducible allowlisted read-only probe. Resume must use the same command and
  cwd, reproduce the supplied result, and demonstrate an actual exit/stdout/
  stderr hash change from that signed baseline. A prose observation without a
  measured delta is rejected.
- `RECON` is allowed once per bet. Its resume increments the strategy epoch and
  leaves the new `ENVIRONMENT_RECLASSIFY` gate pending; only a fresh cold review
  and later decision may dispatch work. A human-approved `HUMAN_REBET` starts a
  new bet and resets the one-RECON allowance.
- `STOP_SALVAGE` terminates the bet without success and may supersede a pending
  restore/recon/re-bet intent. It writes an absorbing terminal marker: protected
  mutation, resume, and later Mission decisions cannot restart that bet.

For a non-retryable `GOAL_SPEC`, repair/wall-time/runtime-measured-token appetite,
expiry, or review-quality trigger, only `HUMAN_REBET`
or `STOP_SALVAGE` is accepted. The `before_finalize` checkpoint is the sole
non-retryable exception: its strict green cold review resolves through
`CONTINUE_CURRENT` to record the final checkpoint receipt.

Agent decisions require a sealed cold review and must match its recommendation.
A human may override a recommendation only with a verbatim `--approval`
artifact. Contract changes always require `actor=human`, approval, an exact
one-version increment, a preserved original request, and non-reused criterion
IDs. The complete retired-criterion ID/hash history must carry forward unchanged,
and a retired ID cannot be reactivated.

Explicit human steering may invoke any action except `CONTINUE_CURRENT` when no
gate is pending. The command first snapshots a `HUMAN_INTERVENTION` gate, then
applies the same audited decision path. This is how a human can deliberately
interrupt local optimization without directly editing state.

The command stages inputs under `decisions/<decision-id>/`, writes an immutable
manifest, records one provenance event, then atomically updates the canonical
state. A decision invoked from a child session redirects to its parent Mission
authority.

Mission mode forbids `skip` and `goto` whether or not a gate is currently
pending, because both bypass evidence and retry accounting. While
`trajectory.pending` is true, `transition`, `advance`, `finalize`, `pass`,
`complete-tick`, `next-tick`, and `reinit-loop` also fail closed.
Read-only validation/reporting remains allowed. Standard flows may also use
`stop` as an emergency/manual non-success exit even while a gate is pending;
`STOP_SALVAGE` is the audited, absorbing termination action for either standard
or loop sessions. Never report a pending, stopped, or salvaged Mission as passed.

### Step 5 — Findings Disposition

After routing, handle unresolved findings. **Findings that are not fixed in the current cycle MUST be tracked — they cannot be "acknowledged" and forgotten.**

| Verdict | 🔴 Critical | 🟡 Warning | 🔵 Suggestion |
|---------|-------------|------------|---------------|
| FAIL | Must fix before re-gate | — | — |
| ITERATE | Must fix before re-gate | Append to `$SESSION_DIR/backlog.md` if not fixing now | Optional |
| PASS | N/A (no 🔴 if PASS) | Append to `$SESSION_DIR/backlog.md` | Drop or append |

**Backlog append format:**
```markdown
- [ ] {emoji} [{source node}] {finding summary} — {file:line if applicable}
```

**Devil's Advocate findings** receive special treatment:
- Product-level concerns (design validity, algorithm effectiveness, business assumptions) → always 🟡 minimum, always tracked in backlog
- These are explicitly NOT dismissible with "acknowledged but not code-blocking"
- If the orchestrator disagrees with a devil's advocate finding, it must write a **counter-argument** in the backlog entry, not simply omit it

Create `$SESSION_DIR/backlog.md` if it doesn't exist. Append, never overwrite.

### Step 6 — User Notification

Always inform the user of the gate outcome:

- **Loopback:** `🔄 Loop {N}/{MAX}: {reason}, returning to {target}`
- **Pass:** `✅ {gate} passed, proceeding to {next}`
- **Done:** `🎉 Flow complete.`
- **Blocked:** `⛔ Cycle limit reached at {gate}. Use /opc pass, /opc stop, or /opc goto <node>.`
- **Mission pause:** `⏸ Mission Gate {triggerId}: {reason}. Cold review and mission-decision required before routing continues.`

## Anti-Patterns

- ❌ Overriding the synthesized verdict with your own judgment
- ❌ Determining the next node by reading SKILL.md tables — use `opc-harness route`
- ❌ Writing gate handshake.json manually — `transition` does this
- ❌ Continuing after `allowed: false` without user consent
- ❌ Treating `rebet_required: true` as an ordinary FAIL/ITERATE loopback
- ❌ Feeding local fix transcripts to the cold Mission reviewer
- ❌ Using `pass` to bypass a pending Mission Gate, or using Mission-forbidden
  `skip`/`goto` at any time
- ❌ "Acknowledging" a 🟡 finding without writing it to backlog.md — this is how findings get lost
- ❌ Dismissing devil's advocate product concerns as "not code-blocking" without tracking them

## Conflict of Interest — Builder as Orchestrator

When the orchestrator also performed the build (same session, same agent):

1. **The orchestrator MUST NOT override gate verdicts.** Specifically:
   - ITERATE verdict → orchestrator cannot rationalize warnings as "pre-existing" or "acceptable"
   - FAIL verdict → orchestrator cannot downgrade to ITERATE
   - Only the USER can override verdicts when conflict-of-interest applies

2. **Detection**: If the current session's build node was executed by the orchestrator (not a subagent in a worktree), conflict-of-interest is assumed.

3. **Escalation**: When conflict-of-interest is detected and verdict is not PASS:
   - Show the user: verdict, all findings summary, and the specific warnings
   - Ask: "Gate verdict is {VERDICT}. As builder, I have a conflict of interest. Accept findings and iterate, or override? [iterate/override]"
   - Do NOT pre-fill the answer or suggest overriding

4. **Audit trail**: Any user override must be logged in progress.md: "⚠️ User override: {verdict} → PASS (conflict-of-interest acknowledged)"

## Skeptic-Owner Authority

When multiple reviewers disagree on verdict, **skeptic-owner's verdict takes precedence**. Skeptic-owner is the user's representative in the pipeline — its job is to verify the output matches what was actually asked for.

Concretely:
- If skeptic-owner says FAIL and others say PASS → treat as FAIL
- If skeptic-owner says ITERATE and others say PASS → treat as ITERATE
- If skeptic-owner says PASS and others say ITERATE → the orchestrator MAY escalate to user, but skeptic-owner's PASS carries more weight than other roles' ITERATE
- The orchestrator MUST NOT dismiss or downgrade skeptic-owner findings under any rationale
