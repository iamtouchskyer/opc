# OPC Contracts — Stable Interfaces for External Callers

> This document defines the stable mechanical interfaces that external skills (orchestrators, companions, tools) can depend on. Everything not listed here is internal and may change without notice.

## Version

OPC Harness version: read from `HARNESS_VERSION` in `bin/lib/flow-templates.mjs`.
Currently: `0.10.0`.

`HARNESS_VERSION` is the external-flow compatibility line, not the npm package patch version. For example, `@touchskyer/opc@0.10.2` can expose harness compatibility `0.10.0`; patch releases do not require external flow authors to change `opc_compat`.

External consumers declare compatibility via `opc_compat: ">=0.10"` — see [Flow Templates](#4-custom-flow-templates) below.

---

## 1. Skill Invocation

External skills call OPC through the active host's skill invocation:

```
/opc [<flow>] [--mission] [-i] <task> # Composable flow + Mission grammar
/opc build-verify <task>              # Explicit flow, Mission disabled
/opc build-verify --mission <task>    # Explicit flow + Mission
/opc --mission <task>                 # Inferred flow + Mission
/opc loop --mission <task>            # Mission-aware autonomous loop
/opc <role> [role...] <task>          # Explicit roles, skip role selection
```

Natural-language one-line aliases normalize before parsing: `用 Mission Gate
做：<task>` / `开启 Mission：<task>` map to `/opc --mission <task>`, `用 Mission
Gate 长跑：<task>` maps to `/opc loop --mission <task>`, and `重新下注：<note>`
maps to `/opc rebet <note>`. The legacy `/opc mission ...` spelling remains a
compatibility alias; `mission` is not a flow name.

**Return convention:** OPC writes results to `.harness/`. The calling skill reads `.harness/flow-state.json` and `.harness/nodes/*/handshake.json` to determine outcome.

**Flow state on completion:** `flow-state.json` will have `status: "completed"` and the terminal gate's `handshake.json` will have `verdict: "PASS"`.

---

## 2. CLI Interface (`opc-harness`)

All commands output JSON to stdout. Errors go to stderr. Exit code 0 on success, 1 on usage error.

### Flow Commands

```bash
OPC_HARNESS="$HOME/.codex/skills/opc/bin/opc-harness.mjs"

# Initialize a flow
node "$OPC_HARNESS" init --flow <template> [--flow-file <path>] [--entry <node>] [--tier <tier>] [--force] [--mission <json> | --parent-session <dir>] [--criteria <md>] [--plan <md>] --dir <path>
# → { created: bool, flow: string, entry: string, tier: string|null,
#     mission_enabled: bool, mission_version?: number,
#     strategy_epoch?: number, mission_contract?: string }
# On error: { created: false, error: string }

# Get next node from graph (stateless — requires --flow or --flow-file)
node "$OPC_HARNESS" route --node <id> --verdict <PASS|FAIL|ITERATE> --flow <template> [--flow-file <path>]
# → { next: string|null, valid: bool }

# Execute state transition (auto-restores flow template from _flow_file in state)
node "$OPC_HARNESS" transition --from <n> --to <n> --verdict <V> --flow <template> [--flow-file <path>] --dir <path>
# → { allowed: bool, reason: string, next: string, runId: string, state: object }

# Record one commit produced by this flow for terminal change-scope coverage
node "$OPC_HARNESS" record-commit [--sha <sha>] --dir <path>
# → { recorded: true, sha: string, already: bool, producedCommits: string[] }

# Validate a handshake file
node "$OPC_HARNESS" validate <handshake.json>
# → { valid: bool, errors: string[] }

# Validate full execution chain
node "$OPC_HARNESS" validate-chain --dir <path>
# → { valid: bool, errors: string[], executedPath: string[] }

# Validate flow-context.json against contextSchema
node "$OPC_HARNESS" validate-context --flow <template> [--flow-file <path>] --node <id> [--dir <path>]
# → { valid: bool, errors: string[] }

# Finalize a completed flow (auto-restores flow template from _flow_file in state)
node "$OPC_HARNESS" finalize --dir <path> [--strict]
# → { finalized: bool, flow: string, terminalNode: string, totalSteps: number }

# Visualize flow graph (ASCII) — auto-restores from state if --dir provided
node "$OPC_HARNESS" viz --flow <template> [--flow-file <path>] [--dir <path>] [--json]

# Merge evaluations into verdict
node "$OPC_HARNESS" synthesize <dir> --node <id> [--run N]
# → { verdict: string, findings: object, ... }
```

`record-commit` takes the flow-state lock, rereads current state under that lock,
checks Mission integrity/pending/terminal state, resolves a full commit SHA, then
atomically appends it. This prevents a stale commit recorder from overwriting a
concurrent Mission Gate or decision.

### Loop Commands

```bash
# Initialize autonomous loop from plan.md
node "$OPC_HARNESS" init-loop [--plan <file>] [--flow-template <name>] [--flow-file <path>] [--handlers <json>] [--mission <json> | --parent-session <dir>] --dir <path>
# → { initialized: bool, units: string[], first_unit: string, total_units: number,
#     mission_enabled: bool, mission_version?: number,
#     strategy_epoch?: number, mission_contract?: string }

# Get next unit (or terminate)
node "$OPC_HARNESS" next-tick [--force-terminate] --dir <path>
# → { ready: bool, terminate: bool, next_unit: string, unit_type: string, handler?: object }
# → (drain gate) { ready: false, terminate: false, drain_required: true, backlog: object, actionable_items: string[] }

# Complete current tick with evidence
node "$OPC_HARNESS" complete-tick --unit <id> --artifacts <a,b> --description <text> [--status <completed|blocked|failed>] [--scenario <id>] [--validator-type <e2e|acceptance|ux-sim>] [--satisfies <OUT-N,FLOOR-N,...>] --dir <path>
# → { completed: bool, ... }
# ⚠ BREAKING (0.9.0): deferral language in --description on the final tick is a hard error (completed: false)
```

The Mission flags are optional. `--mission` and `--parent-session` are mutually exclusive, and `--parent-session` must be absolute. A root Mission run requires `acceptance-criteria.md`; `init-loop` always reads it from `--dir`, while `init` accepts `--criteria` or defaults to that location. `--satisfies` is meaningful only for completed Mission verification units and must name pinned outcome/floor IDs.

### Mission Gate Commands

```bash
# Seal a fresh cold review against the current trajectory packet.
node "$OPC_HARNESS" record-mission-review --review <json> [--dir <path>]
# → { recorded: true, review: string, provenance_record_hash: string,
#     review_claims_sha256: string, canonical_dir: string,
#     redirected_from_child: bool }
# On rejection: { recorded: false, error: string, review?: string,
#                 rebet_required?: bool }

# Resolve an existing pending Mission Gate.
node "$OPC_HARNESS" mission-decision \
  --action <CONTINUE_CURRENT|RESHAPE_SMALLER|RESTORE|RECON|HUMAN_REBET|STOP_SALVAGE> \
  --actor <agent|human> \
  [--review <sealed-json>] [--approval <file>] [--note <text>] \
  [--phase <intent|resume>] [--intent <event-id>] \
  [--mission <json>] [--criteria <md>] [--plan <md>] \
  [--evidence <json>] [--resume-unit <id>] [--dir <path>]
# → { decided: true, action, actor, phase, decision_id, event_id,
#     canonical_dir, redirected_from_child, pending, retry_allowance,
#     strategy_epoch, intent_id?, resume_unit?, resume_at_final_checkpoint?, manifest }
# On rejection: { decided: false, error: string, rebet_required?: bool }
```

`record-mission-review` accepts only a pending gate and a review whose trigger, bindings, and reviewer run ID match the current packet. The harness issues that run ID in `reviewRequest`; callers cannot choose it. The packet hash, run ID, and mission/plan/epoch bindings are themselves tied to a signed gate-opening record. Exactly one cold review may be sealed for a trigger: a duplicate returns `recorded: false`, an error, and the existing sealed `review` path. Across later triggers, the same canonical finding/repair-edge scope cannot be cold-reviewed again without new integrated evidence, a measured environment delta, or explicit human steering. Agent decisions also require that pending gate. Explicit human steering may call any action except `CONTINUE_CURRENT` without a pending gate; the command first snapshots a `HUMAN_INTERVENTION` gate and then records the decision. Agent decisions require a sealed cold review and must match its recommendation. For an agent two-phase action, the intent binds that one review and the matching resume reuses the binding; do not pass a second review. `CONTINUE_CURRENT` requires a sealed review for either actor. A human override or contract revision requires `--approval`; a contract revision is accepted only by `HUMAN_REBET --phase resume` with mutually consistent `--mission` and `--criteria`.

`RESTORE`, `RECON`, and `HUMAN_REBET` are two-phase actions. Their default phase is `intent`; `resume` must supply the returned `intent_id`. `RESTORE` resume also needs `--evidence` plus `--resume-unit`; `RECON` resume needs measured environment-delta evidence; `HUMAN_REBET` resume needs the revised contract/criteria and approval. All accepted inputs are copied under `decisions/<decision-id>/`, hashed in an immutable manifest, recorded in the provenance ledger, and activated by one atomic canonical-state write.

RESTORE/RECON evidence uses schema v1 and must repeat `action`,
`intentEventId`, `triggerId`, `missionSha256`, `planSha256`, and
`strategyEpoch` from the pending intent. RESTORE supplies `type: "restore"` plus
either the current clean Git tree SHA, which must differ from the signed intent
baseline, or a current fully bound checkpoint ID and receipt hash, and names an
active `--resume-unit`; a no-op restore is rejected. RECON intent itself
requires bound `action: "RECON", type: "environment_baseline"` evidence. Both the baseline and
resume delta carry a reproducible read-only probe: allowlisted argv,
project-contained cwd, timeout 1-15000ms, exit code, and stdout/stderr SHA-256
values. Resume uses the same command/cwd, reruns it without a shell, and must
show an actual result-hash change from the signed baseline. One RECON is allowed
per bet; only a successful human re-bet resets the count.

`STOP_SALVAGE` sets an absorbing terminal marker and preserves the contract's
salvage instructions. No protected mutation, resume, or later Mission decision
can restart that bet. Standard `stop` remains available as an emergency/manual
non-success exit while a gate is pending, but it is not a Mission pass.

For a revised loop plan, the harness hashes each full unit definition together with its predecessor lineage. It preserves the longest identical completed prefix, marks later ticks stale, and returns the first changed/inserted unit as `resume_unit`. If the revised plan is already an identical completed prefix, it returns `resume_at_final_checkpoint: true` and leaves `next_unit` null so `next-tick` opens the final Mission checkpoint.

### Escape Hatches

```bash
node "$OPC_HARNESS" skip --dir <path>       # Skip current node via PASS edge
node "$OPC_HARNESS" pass --dir <path>       # Force-pass current gate
node "$OPC_HARNESS" stop --dir <path>       # Terminate flow, preserve state
node "$OPC_HARNESS" goto <nodeId> --dir <path>  # Jump to node (limits enforced)
node "$OPC_HARNESS" next-tick --force-terminate --dir <path>  # Bypass drain gate
```

`skip` and `goto` are legacy escape hatches only: Mission-enabled flows reject
them even when no Mission Gate is pending. Standard Mission flows may use
`stop` as an emergency non-success exit.

If a Mission flow reaches `maxTotalSteps`, `maxLoopsPerEdge`, or
`maxNodeReentry`, the attempted mutation opens a non-retryable
`LEGACY_FLOW_LIMIT_REACHED` gate instead of bypassing the legacy bound. Retry
grants do not override this gate; it routes only to human re-bet or stop/salvage.

---

## 3. File Schemas

### `.harness/flow-state.json`

```jsonc
{
  "version": "1.0",
  "flowTemplate": "build-verify",       // template name
  "currentNode": "code-review",         // where the flow is now
  "entryNode": "build",                 // where it started
  "tier": "polished",                   // quality tier (or null)
  "totalSteps": 3,
  "maxTotalSteps": 25,
  "maxLoopsPerEdge": 3,
  "maxNodeReentry": 5,
  "history": [                          // ordered execution log
    { "nodeId": "build", "runId": "run_1", "timestamp": "..." },
    { "nodeId": "code-review", "runId": "run_1", "timestamp": "..." }
  ],
  "edgeCounts": { "build→code-review": 1 },
  "status": "completed",               // "completed" (finalize), "stopped" (stop), or absent
  "completedAt": "2026-04-15T...",     // set by finalize
  "stoppedAt": "2026-04-15T...",       // set by stop
  "_flow_file": "/path/to/my-flow.json", // absolute path to external flow JSON (if loaded via --flow-file)
  "_written_by": "opc-harness",        // tamper detection
  "_write_nonce": "abc123...",          // tamper detection
  "_last_modified": "2026-04-15T..."
}
```

### `.harness/nodes/{nodeId}/handshake.json`

```jsonc
{
  "nodeId": "code-review",
  "nodeType": "review",                // discussion | build | review | execute | gate
  "runId": "run_1",
  "status": "completed",              // completed | failed | blocked
  "verdict": "PASS",                  // PASS | ITERATE | FAIL | BLOCKED | null
  "summary": "...",
  "timestamp": "2026-04-15T...",
  "artifacts": [
    { "type": "eval", "role": "frontend", "path": "run_1/eval-frontend.md" },
    { "type": "eval", "role": "security", "path": "run_1/eval-security.md" },
    { "type": "screenshot", "path": "run_1/screenshot-1.png", "description": "..." },
    { "type": "test-result", "path": "run_1/test-output.txt" },
    { "type": "cli-output", "path": "run_1/build-log.txt" }
  ],
  "findings": {                       // summary counts (optional)
    "critical": 0,
    "warning": 2,
    "suggestion": 1
  },
  "loopback": {                       // present on loopback iterations (optional)
    "from": "gate",
    "reason": "ITERATE",
    "iteration": 2
  },
  "tierCoverage": {                   // required on completed execute nodes with polished/delightful tier
    "covered": ["typography", "color-scheme", "navigation", "responsive"],
    "skipped": [{ "key": "code-blocks", "reason": "product has no code examples" }]
  },
  "skipped": true                     // set by /opc skip (optional)
}
```

**Node type constraints:**
- `review` nodes require `≥2 eval artifacts` from independent agents
- `execute` nodes require `≥1 evidence artifact` (type: screenshot, test-result, or cli-output)
- `execute` nodes in `polished` / `delightful` flows require `tierCoverage`; see [Tier Coverage Schema](pipeline/tier-coverage-schema.md)
- `gate` nodes are auto-created by `transition` — external callers don't write them

### `.harness/loop-state.json`

```jsonc
{
  "tick": 3,
  "unit": "F1.3",                     // current unit ID
  "status": "initialized",            // initialized | in_progress | mission_pending | completed | blocked | failed | pipeline_complete | terminated | stalled
  "next_unit": "F1.4",
  "description": "...",
  "plan_file": ".harness/plan.md",
  "units_total": 8,
  "unit_ids": ["F1.1", "F1.2", ...],
  "artifacts": [],
  "blockers": [],
  "_plan_hash": "abc123...",          // integrity check
  "_git_head": "def456...",
  "_max_total_ticks": 24,
  "_max_duration_hours": 24,
  "_started_at": "2026-04-15T...",
  "_flow_template": "pitch-ready",    // optional: flow template name (for unitHandler lookup)
  "_flow_file": "/abs/path/to/flow.json", // optional: absolute path to external flow JSON (from --flow-file)
  "_unit_handlers": {                  // optional: inline unit type → dispatch (from --handlers)
    "discover": { "skill": "/dw-discover" }
  },
  "_tick_history": [
    { "unit": "F1.1", "tick": 1, "status": "completed", "timestamp": "..." }
  ],
  "_written_by": "opc-harness",
  "_write_nonce": "abc123...",
  "_last_modified": "2026-04-15T...",
  "_external_validators": {            // auto-detected from project
    "pre_commit_hooks": false,
    "test_script": "npm test",
    "lint_script": null,
    "typecheck_script": null
  }
}
```

### Mission Contract and Additive State

Mission mode is enabled only when root initialization supplies `--mission`, or a child supplies `--parent-session`. The root contract is UTF-8 JSON with this schema:

```jsonc
{
  "schemaVersion": 1,
  "version": 1,
  "owner": "Accountable mission owner",
  "affectedParties": ["users", "operators"],
  "mode": "steady", // steady | explore | launch | incident | regulated
  "originalRequest": "Verbatim user request",
  "outcomes": [
    { "id": "OUT-1", "statement": "Observable outcome" },
    { "id": "OUT-2", "statement": "Integrated outcome" },
    { "id": "OUT-3", "statement": "Operational outcome" }
  ],
  "protectedFloors": [
    { "id": "FLOOR-1", "statement": "Property that must not regress" }
  ],
  "appetite": {
    "maxRepairCycles": 8,
    "maxTokens": null,
    "maxWallTimeHours": null,
    "expiresAt": null
  },
  "endToEndScenario": {
    "id": "SCENARIO-1",
    "statement": "Runnable reality check",
    "validatorTypes": ["e2e", "acceptance", "ux-sim"]
  },
  "realitySignals": [
    { "id": "SIG-1", "required": true, "observation": "Observable support/refutation" }
  ],
  "guardrails": [
    { "id": "GUARD-1", "metric": "Trust or reliability signal", "actionThreshold": "Pause condition" }
  ],
  "exitAndSalvage": "What remains useful if the bet stops",
  "nonGoals": [],
  "retiredCriteria": [],
  "assumptions": [
    { "id": "ASM-1", "statement": "The integration baseline is current", "freshUntil": "2026-09-01T00:00:00.000Z" }
  ],
  "checkpoints": [
    { "type": "loop_unit", "id": "F1.8" },
    { "type": "before_finalize" }
  ]
}
```

There must be 3-10 `OUT-N` outcomes and at least one affected party, `FLOOR-N`, `SIG-N`, and `GUARD-N`. The `## Outcomes` bullets in `acceptance-criteria.md` must exactly match the active outcome IDs and statements. Contract revisions preserve `originalRequest`, increment `version` by exactly one, and cannot reuse a criterion ID with different meaning. Every later version must carry the complete prior `retiredCriteria` history with the same statement hashes; a retired ID can never become active again.

The current harness mechanically gates both standard flows and loops on `maxRepairCycles`, `maxWallTimeHours`, and `expiresAt`. Wall time is measured from the persisted loop `_started_at` or standard-flow `flowStartedAt` and opens a non-retryable `WALL_TIME_APPETITE_REACHED` gate at the limit. `maxTokens` opens non-retryable `TOKEN_APPETITE_REACHED` only if an embedding runtime supplies finite `trajectory.measuredTokens`; no production OPC token meter currently writes that field, so normal packets report `measuredTokens: "unknown"` and the field otherwise remains pinned budgeting metadata. Existing OPC tick, step, and wall-clock ceilings still apply independently.

Mission-enabled `flow-state.json` and `loop-state.json` add:

```jsonc
{
  "_missionRuntimeSeal": {
    "schemaVersion": 1,
    "sealId": "MRS-<32-hex>",
    "generation": 7,
    "previousSealId": "MRS-<32-hex-or-null>",
    "authoritativeStateSha256": "<64-hex>"
  },
  "mission": {
    "path": "mission-contract.json",
    "parentSession": null,
    "sha256": "...",
    "originalRequestSha256": "...",
    "acceptanceCriteriaPath": "acceptance-criteria.md",
    "acceptanceCriteriaSha256": "...",
    "planPath": "plan.md",
    "planSha256": "...",
    "criterionHashes": { "OUT-1": "...", "FLOOR-1": "..." },
    "version": 1,
    "strategyEpoch": 1
  },
  "trajectory": {
    "pending": false,
    "triggerId": null,
    "reason": null,
    "pendingPacketSha256": null,
    "pendingPacketProvenanceRecordHash": null,
    "pendingAction": null,
    "pendingActionEventId": null,
    "pendingActionActor": null,
    "pendingActionReviewSha256": null,
    "pendingActionReviewProvenanceRecordHash": null,
    "lastDecision": null,
    "retryAllowance": 0, // compatibility mirror; not authorization by itself
    "retryGrant": null,  // one-use trigger/epoch/scope/command/source/unit + origin binding
    "reconCount": 0,
    "terminal": false,
    "terminalAction": null,
    "evidenceGateCursor": 0,
    "evidenceGateReceiptIds": [],
    "continuedFindingRefs": [],
    "agentReshapedFindingRefs": [],
    "repairEvidenceSeenIds": {}
  },
  "findingRegistry": [],
  "evidenceReceipts": [],
  "checkpointReceipts": []
}
```

`authoritativeStateSha256` covers the entire JSON state except
`_missionRuntimeSeal` itself. Thus contract policy, trajectory, finding
registry, evidence/checkpoints, status, cursors, history, limits, and ownership
are one integrity unit. A Mission write stages the complete candidate in sibling
`<state>.mission-runtime-stage`, appends signed
`mission_runtime_state_prepared`, atomically replaces the active state, appends
signed `mission_runtime_state_committed`, and removes the stage. Both events bind
the state filename, generation, previous seal, canonical digest, exact serialized
state hash, reason, and prepare record.

Integrity verification runs recovery before it trusts even the presence of
`state.mission`. An unsigned stage is discarded; a signed prepared candidate is
promoted or recognized as already active and committed; a committed active
state with leftover stage is cleaned. Removing Mission mode, editing any bound
field, or rolling back to an older seal while the ledger is intact fails closed.
Unsealed bootstrap is initialization-only: `init --force`, `init-loop`, and
`reinit-loop` cannot reuse/reset a session that already has Mission authority.
Init preflight checks both state filenames, so deleting the authoritative active
file or switching flow/loop mode in the same signed session also fails closed.
The HMAC key and append-only ledger remain the trust root: this contract detects
direct editing and intact-ledger rollback, but cannot stop a hostile process with
key/code access from minting state, or guarantee recovery if both state and
ledger are deleted/truncated.

Child state sets `mission.parentSession` to the canonical root and carries its pins; it does not copy a second contract. Protected child commands acquire the canonical parent lock before validating the live parent, hold it through the child write and parent receipt/retry update, and redirect `mission-decision` to the parent. A protected child transition records its exact origin. Replaying the same child operation is idempotent: it cannot mint a duplicate receipt or consume the same retry twice.

The `pendingActionActor` and `pendingActionReview*` bindings are populated only while a two-phase action is awaiting resume, then cleared. They prevent an unreviewed human intent from being resumed as an agent-reviewed decision.

At gate opening, `evidenceGateCursor` advances to the current integrated PASS receipt count while `evidenceGateReceiptIds` records stable IDs across strategy epochs. The packet contains owner/affected-party/mode and contract guard fields; up to 50 finding summaries and 100 current integrated receipt summaries; up to 200 changed Git entries and 200 declared-artifact entries bound to the same manifest hash as the review; appetite status; exact trigger-specific `allowedDecisions`; reversibility guidance; the integrated receipt delta since the prior gate; a harness-issued cold `reviewRequest.runId`; and exact `origin` `{command, sessionSha256, fromNode, nextUnit, edgeKey}`. Each delta entry binds its receipt hash, scenario, validator type, `satisfies` IDs, and artifact hashes. Before publication, the complete packet hash and issued run ID are committed in a signed `mission_gate_opened` event; state, public packet, and event must continue to agree. Retryable non-checkpoint packets expose all six actions so the cold reviewer can replace the local classification; its fresh classification is then checked against the route matrix. Non-retryable packets expose only human re-bet/stop, while final packets expose only continue/stop. `repairEvidenceSeenIds` prevents an epoch-local count reset from masquerading as repair progress. `continuedFindingRefs` and `agentReshapedFindingRefs` durably enforce the per-scope decision bounds. The scalar `retryAllowance` remains an output compatibility field; only `retryGrant` can authorize work, copies the packet origin, and is consumed by the first exact matching transition or loop claim. A child transition grant therefore cannot be consumed by a parent `next-tick`.

After a loop plan revision, `mission.planResume` records `completedPrefixLength`, `resumeUnit`, and `allComplete` for the deterministic cursor decision.

An evidence receipt is emitted only from a completed, evidence-bearing execute node or loop `e2e`/`accept`/`ux-sim` unit:

```jsonc
{
  "id": "EV-1",
  "sliceId": "F1.8",
  "scenarioId": "SCENARIO-1",
  "scope": "integrated", // integrated only for a matching scenario + allowed validator type
  "validatorType": "e2e",
  "validator": "F1.8",
  "result": "PASS",
  "satisfies": ["OUT-1", "FLOOR-1"],
  "artifactHashes": ["sha256:..."],
  "sourceExecution": {
    "sessionSha256": "...",
    "nodeId": "test-execute",
    "runId": "run_1",
    "resultSha256": "..."
  },
  "strategyEpoch": 1,
  "observedAt": "2026-08-15T12:00:00.000Z"
}
```

Only current-epoch, integrated PASS receipts count as global progress or final criterion coverage. A new strategy epoch makes earlier receipts stale for those decisions without deleting their audit history. Before trajectory evaluation and finalization, every current receipt's path bindings, hashes, and harness-owned PASS proof are revalidated. Missing, edited, symlinked, or no-longer-passing evidence is marked stale and immediately loses coverage.

For standard flows, only built-in, harness-run `test-execute` currently mints an
integrated Mission receipt. Custom execute nodes, `e2e-user`, and
`post-launch-sim` remain local until a comparable trusted harness execution
record exists; caller-authored PASS is never a fallback. Every receipt artifact must be a relative path under the
sealed latest execute `run_N`, resolve to a contained regular non-symlink file,
and remain inside that run after canonicalization. Integrated scope additionally
requires a current-run JSON test result that mechanically passes. When a flow
requires OPC-owned test execution, the result and handshake must carry matching
`testCommand`, source test-plan, result, node/run, and signed provenance-ledger
bindings. A self-authored PASS JSON or old/absolute artifact cannot create a
receipt.

For required OPC test execution, the source test plan must contain exactly one
pre-execution `scenario:`/`validator-type:`/`satisfies:` tuple. The receipt takes
that mapping from the hashed plan, not post-result handshake prose, and the
harness-owned handshake merge preserves the command/plan/result/node/run/ledger
bindings. Exit zero is not enough: non-empty TAP must prove a positive executed
test count with zero failures.

For loop `e2e`/`accept`/`ux-sim` units, the unit must be the current
`in_progress` claim from `next-tick`. Integrated artifacts must be contained
regular non-symlink files under the loop session, have mtime at or after the
claim, and include a machine-readable passing result. At least one passing
machine-result hash must be absent from all prior receipts. Accepted canonical
paths are added to `declaredArtifacts`, so ignored/non-Git deliverables are
included in later packet bindings.
The loop plan unit likewise freezes exactly one scenario/validator/satisfies
tuple and a `verify:` command. Runtime flags must match it exactly. The harness
runs that command and requires a non-vacuous `OPC_ORACLE` or non-empty,
all-passing TAP summary; caller-authored evidence cannot establish the PASS by
itself.

`sourceExecution` is the receipt's idempotency key. If a parent update committed
before a child crash, replaying the same session/node/run/result returns that
same receipt; conflicting relabeling or replay of a now-stale receipt is
rejected. This prevents crash recovery from manufacturing progress.

### Mission Review Quality and Claim Dispositions

Mission review quality is true only when the verdict is valid, `FINDINGS [N]`
matches every parsed finding when findings exist, findings are structured, every
finding has non-empty `reasoning:` and `fix:`, and every red/yellow finding has
valid Mission metadata. Invalid findings are persisted as non-routing claims and
cannot increment trajectory counters or route builders.

An existing `FIND-N` must repeat the registry's canonical `fingerprint` and
`invariant` exactly. Naming the ID without both values, or changing either one,
is review-quality failure; a genuinely new identity uses `NEW`.

The one allowed fresh reevaluation writes
`review-claim-dispositions.json` beside its eval artifacts in the new run:

```json
{
  "schemaVersion": 1,
  "dispositions": [
    { "claimHash": "<64-hex-sha256>", "disposition": "CONFIRM", "findingRef": "FIND-2" },
    { "claimHash": "<64-hex-sha256>", "disposition": "SUPERSEDE", "fingerprint": "replacement-invariant" },
    { "claimHash": "<64-hex-sha256>", "disposition": "REJECT", "evidence": "non-empty string, array, or object" }
  ]
}
```

There must be exactly one disposition for every pending claim; unknown,
duplicate, or missing hashes are invalid. `CONFIRM`/`SUPERSEDE` must reference a
valid routing finding in the fresh review by `findingRef` or `fingerprint`, and
`CONFIRM` cannot change the claim's class, criterion, or invariant. `REJECT`
requires concrete non-empty evidence. Standard claims are bound to the
immediately prior consecutive run and strategy epoch. Loop claims are also bound
to unit/epoch and require the fresh evals plus disposition file to share one
contained, non-symlink run directory and be newer than the invalid attempt. A
second invalid review opens non-retryable `REVIEW_QUALITY_STALL`.

An ordinary `UNLINKED` finding stays visible but is non-routing. The sole
exception is a `GOAL_SPEC` + `UNLINKED` protected-floor risk with a non-empty
`evidence:` field; it opens a non-retryable gate and can resolve only through
`HUMAN_REBET` or `STOP_SALVAGE`.

---

## 4. Custom Flow Templates

**Preferred:** Pass `--flow-file <path>` to load a flow template from any location. Each external skill keeps its flow JSON in its own directory.

**Deprecated:** `~/.claude/flows/*.json` is still loaded at startup for backward compatibility, but emits a deprecation warning. Will be removed in a future version. Migrate to `--flow-file`.

### Flow File Resolution Order

1. `--flow-file <path>` flag on the current command → loaded immediately
2. `_flow_file` field persisted in `flow-state.json` / `loop-state.json` → auto-restored on subsequent commands
3. `--flow <name>` lookup in built-in `FLOW_TEMPLATES` → fallback

The absolute path is stored in state at `init` / `init-loop` time, so subsequent commands (`transition`, `finalize`, `next-tick`, `viz`, etc.) auto-restore the template without re-specifying `--flow-file`.

### Schema

```jsonc
{
  "opc_compat": ">=0.10",            // REQUIRED: minimum harness compatibility version
  "nodes": ["discover", "build", "review", "gate"],
  "edges": {
    "discover": { "PASS": "build" },
    "build":    { "PASS": "review" },
    "review":   { "PASS": "gate" },
    "gate":     { "PASS": null, "FAIL": "build", "ITERATE": "review" }
  },
  "limits": {
    "maxLoopsPerEdge": 3,
    "maxTotalSteps": 20,
    "maxNodeReentry": 5
  },
  "nodeTypes": {                      // maps node → type
    "discover": "execute",
    "build": "build",
    "review": "review",
    "gate": "gate"
  },
  "softEvidence": false,              // if true, execute nodes warn instead of error on missing evidence
  "contextSchema": {                  // optional: validate flow-context.json per node
    "build": {
      "required": ["projectDir", "techStack"],
      "rules": { "projectDir": "non-empty-string" }
      // Valid rules: non-empty-string, non-empty-array, non-empty-object, positive-integer
    }
  },
  "rolesDir": "./roles",             // optional: directory with custom .md role files (relative to flow JSON)
  "protocolDir": "./protocols",       // optional: directory with custom .md protocol files
  "unitHandlers": {                   // optional: custom unit type → skill dispatch for loops
    "discover": { "skill": "/dw-discover", "invocation": "/dw-discover {task}" },
    "pitch": { "skill": "/dw-pitch", "invocation": "/dw-pitch {id}" },
    "publish": { "command": "dw publish {id}" }
  }
}
```

**Validation rules:**
- `opc_compat` is checked against `HARNESS_VERSION` via semver `>=X.Y`
- All `edges` sources and targets must exist in `nodes` (target `null` = terminal)
- `nodeTypes` values must be one of: `discussion`, `build`, `review`, `execute`, `gate`
- Built-in template names cannot be overridden
- Names `__proto__`, `constructor`, `prototype` are rejected

**Path safety** (for `rolesDir` / `protocolDir`):
- Must be relative paths — absolute paths are rejected
- Must not escape the flow JSON's parent directory (no `../` traversal)
- Resolved via `resolve(dirname(flowJson), rolesDir)`, then checked with `relative()` to confirm it stays within bounds
- Violation → load fails with error (not silently skipped)

**Custom roles and protocols** (via `rolesDir` / `protocolDir`):
- Role files are `.md` files following the same format as `roles/*.md`
- Protocol files are `.md` files following the same format as `pipeline/*.md`
- Paths are resolved relative to the flow JSON file location
- Custom roles/protocols supplement (not replace) built-in ones
- If a custom role has the same name as a built-in one, the custom version takes precedence for that flow

**Unit handlers** (via `unitHandlers`):
- When `next-tick` returns a unit whose `unit_type` matches a key in `unitHandlers`, the handler info is included in the response
- `skill`: the skill invocation pattern (e.g., `/dw-discover`)
- `invocation`: the full invocation string with `{task}`, `{id}` placeholders
- `command`: a CLI command alternative (mutually exclusive with `skill`)
- Unit types without a handler fall back to OPC's built-in dispatch (see `loop-protocol.md`)

---

## 5. Built-in Flow Templates

| Template | Nodes | Entry options |
|----------|-------|--------------|
| `quick` | build → review → gate | build |
| `review` | review → gate | review |
| `build-verify` | brief → build → code-review → test-design → test-execute → gate | brief, build |
| `full-stack` | discuss → build → code-review → test-design → test-execute → gate-test → acceptance → gate-acceptance → audit → gate-audit → e2e-user → gate-e2e → post-launch-sim → gate-final | discuss, build |
| `pre-release` | acceptance → gate-acceptance → audit → gate-audit → e2e-user → gate-e2e | acceptance |
| `legacy-linear` | design → plan → build → evaluate → deliver | design |

---

## 6. Constants

```
Node types:    discussion, build, review, execute, gate
Verdicts:      PASS, ITERATE, FAIL, BLOCKED
Statuses:      completed, failed, blocked
Evidence types: test-result, screenshot, cli-output
Quality tiers:  functional, polished, delightful
Mission finding classes: ARTIFACT, PLAN, GOAL_SPEC, ENVIRONMENT
Mission actions: CONTINUE_CURRENT, RESHAPE_SMALLER, RESTORE, RECON, HUMAN_REBET, STOP_SALVAGE
Mission validator types: e2e, acceptance, ux-sim
```

---

## 7. Mechanical Enforcement (Loop)

Three enforcement mechanisms operate at the harness level — no LLM judgment, pure code.

### Summary Lint (hard error)

`complete-tick` rejects (`completed: false`) the final tick if `--description` contains deferral language: `deferred`, `next loop`, `future work`, `follow-up loop`, `punted`, `later loop`, `TODO: next`.

**Negation allowlist:** phrases like `not deferred`, `no deferral`, `nothing deferred` bypass the check.

**Scope:** Only fires on the final tick (`next_unit === null`). Mid-pipeline ticks are unaffected.

### Drain Gate (hard block)

`next-tick` blocks termination (`terminate: false, drain_required: true`) when `backlog.md` has open items (`- [ ]`). Returns actionable items (those with 🔴 or 🟡) in the response.

**Escape hatches:**
- `--force-terminate` flag bypasses the drain gate
- `_drain_completed: true` in loop-state.json bypasses it (set by orchestrator after drain cycle)

### Plan Lint (warnings)

`init-loop` warns (does not block) when:
- Plan has implement/build units but **zero** test/e2e/accept units
- Plan has test units but the **implement:test ratio ≥ 3:1** (e.g., 6 implements, 1 e2e)
- Implement/build units lack `verify:` sub-lines
- Review/accept units lack `eval:` sub-lines

---

## 8. Mechanical Enforcement (Mission)

These rules apply only when state contains `mission`:

- The harness verifies the pinned mission, acceptance criteria, plan, and active decision manifest before protected mutation. Hash/parity failure is fail-closed; it never silently re-pins.
- `PLAN`, `GOAL_SPEC`, and `ENVIRONMENT` findings open a gate immediately. An `ARTIFACT` finding receives one local repair; the same canonical `FIND-N` failing again opens a gate.
- A second negative traversal of the semantic loop edge `review→fix` opens a gate unless a new current-epoch integrated PASS receipt ID proves progress; changing fingerprints does not reset it. The edge observation does not charge twice. Claiming a loop `fix` unit charges one repair cycle, so failed or abandoned corrective attempts still consume `maxRepairCycles`. Repair appetite, measured wall-time appetite, conditional runtime-supplied token appetite, expiry, a frozen assumption reaching `freshUntil` (`ASSUMPTION_EXPIRED`), and declared checkpoints also open gates.
- Review quality requires a valid verdict/count, structured findings, reasoning, fix, and Mission metadata. An existing `FIND-N` must repeat its canonical fingerprint/invariant. One invalid result requests a fresh run with an exact disposition for every retained claim. A second consecutive invalid attempt opens `REVIEW_QUALITY_STALL`; invalid claims never route to builders or increment finding-failure counters. A valid review resets the consecutive-invalid count. Ordinary `UNLINKED` stays non-routing; evidenced `GOAL_SPEC` + `UNLINKED` routes only to human re-bet/stop.
- Mission mode always forbids `skip` and `goto`. While `trajectory.pending` is true, `transition`, `advance`, `finalize`, `pass`, `complete-tick`, `next-tick`, and `reinit-loop` are blocked. Read-only commands, review recording, and `mission-decision` remain allowed. Standard flows may also use emergency `stop`; `STOP_SALVAGE` is the universal audited termination action.
- `CONTINUE_CURRENT` grants one retry bound to the trigger, epoch, canonical `FIND-N`/edge, command, source, loop unit, and exact packet origin; the first matching transition/claim consumes it even if the attempt fails. That scope can never receive a second continue grant, and using the retry does not reset finding history. An agent may `RESHAPE_SMALLER` once for a canonical finding. If that invariant recurs after the agent reshape, only `HUMAN_REBET` or `STOP_SALVAGE` is accepted. `RESTORE`, `RECON`, and `HUMAN_REBET` use bound two-phase intent/resume; RECON is reproducibly measured and limited to once per bet.
- A non-retryable `GOAL_SPEC`, repair/wall-time/runtime-measured-token appetite, expiry, or review-quality trigger exposes only `HUMAN_REBET` and `STOP_SALVAGE`. `before_finalize` exposes only strict green `CONTINUE_CURRENT` and `STOP_SALVAGE`. Other retryable triggers expose all six actions so a cold reviewer can escape the local classification; its fresh classification then constrains the action through the review route matrix.
- `STOP_SALVAGE` is absorbing. Standard emergency `stop` remains allowed while pending, but no pending, stopped, terminal, or salvaged state is successful.
- Final success requires current hash integrity, current-epoch non-stale integrated PASS `satisfies` coverage for every active outcome and floor, and a current `before_finalize` checkpoint receipt created by a strict cold review. The harness revalidates every bound evidence file and PASS proof before this decision. Pending, stopped, expired, or salvaged runs are never success states.

---

## Stability Promise

- **Stable:** CLI command names, flag names, JSON output field names, file schema fields listed above
- **Unstable:** Internal module exports (`bin/lib/*.mjs`), `SKILL.md` wording, `pipeline/*.md` content, role `.md` content
- **Additive:** New fields may be added to JSON outputs and schemas. Consumers should ignore unknown fields.
- **Breaking changes:** Signaled by bumping the minor version in `HARNESS_VERSION`. External flows use `opc_compat` to declare minimum version.
