# OPC Integration Guide

How external skills (dw, ink-flow, or your own) call OPC as a quality/execution engine.

## Architecture

```
Your skill (orchestrator)
  │
  ├── owns the flow template JSON (lives in YOUR skill directory)
  ├── owns custom roles/ and protocols/ (optional, also YOUR directory)
  │
  └── calls opc-harness CLI ──→ OPC manages state in .harness/
                                  ├── flow-state.json
                                  ├── loop-state.json
                                  └── nodes/{id}/handshake.json
```

**Key principle:** OPC is a stateless execution engine. Your skill owns the workflow definition; OPC enforces the graph, limits, and quality gates.

---

## Quick Start: Single Flow

### 1. Create your flow template

```json
// my-skill/flows/my-flow.json
{
  "opc_compat": ">=0.8",
  "nodes": ["discover", "build", "code-review", "gate"],
  "edges": {
    "discover":    { "PASS": "build" },
    "build":       { "PASS": "code-review" },
    "code-review": { "PASS": "gate" },
    "gate":        { "PASS": null, "FAIL": "build", "ITERATE": "code-review" }
  },
  "limits": {
    "maxLoopsPerEdge": 3,
    "maxTotalSteps": 20,
    "maxNodeReentry": 5
  },
  "nodeTypes": {
    "discover": "execute",
    "build": "build",
    "code-review": "review",
    "gate": "gate"
  }
}
```

Custom flow definitions do not create a trusted Mission evidence boundary by
themselves. In the current implementation, only built-in, harness-run
`test-execute` can mint an integrated standard-flow receipt; custom execute
nodes, `e2e-user`, and `post-launch-sim` remain local until a comparable trusted
harness execution record exists. Caller-authored PASS JSON is never a fallback.

**Required fields:**
- `opc_compat` — MUST be present. Checked against harness version via semver.
- `nodes`, `edges`, `nodeTypes` — the flow graph.
- `limits` — loop/step bounds.

**Node types:** `discussion`, `build`, `review`, `execute`, `gate`

### 2. Initialize

```bash
OPC_HARNESS="$HOME/.codex/skills/opc/bin/opc-harness.mjs"
FLOW_FILE="$HOME/.codex/skills/my-skill/flows/my-flow.json"

node "$OPC_HARNESS" init \
  --flow-file "$FLOW_FILE" \
  --entry discover \
  --dir .harness

# Output: { "created": true, "flow": "my-flow", "entry": "discover", "tier": null }
# The absolute path to my-flow.json is persisted in flow-state.json._flow_file
# All subsequent commands auto-restore it — no need to pass --flow-file again.
```

### 3. Execute nodes + transition

```bash
# After your skill completes the "discover" node's work,
# write a handshake.json and transition:

node "$OPC_HARNESS" transition \
  --from discover --to build --verdict PASS \
  --flow my-flow \
  --dir .harness

# Output: { "allowed": true, "next": "build", "runId": "run_2", ... }
```

**Important:** `transition` auto-restores `--flow-file` from state. You only need `--flow <name>` (the template name, not path) after init.

### 4. Validate handshakes

```bash
node "$OPC_HARNESS" validate .harness/nodes/build/handshake.json
# Output: { "valid": true, "errors": [] }
```

### 5. Finalize

```bash
node "$OPC_HARNESS" finalize --dir .harness
# Output: { "finalized": true, "flow": "my-flow", "terminalNode": "gate", "totalSteps": 4 }
```

---

## Quick Start: Autonomous Loop

For multi-unit tasks (feature backlogs, content pipelines):

### 1. Write a plan.md

```markdown
# My Feature Plan

## Units

- F1.1 [discover]: Research existing solutions
- F1.2 [build]: Implement core feature
- F1.3 [build]: Add error handling
- F1.4 [review]: Code review
- F1.5 [build]: Address review findings
```

Unit format: `- ID [type]: description`

### 2. Initialize loop with your flow template

```bash
# With external flow file (recommended):
node "$OPC_HARNESS" init-loop \
  --plan plan.md \
  --flow-file "$FLOW_FILE" \
  --dir .harness

# Or with a built-in template:
node "$OPC_HARNESS" init-loop \
  --plan plan.md \
  --flow-template build-verify \
  --dir .harness

# Output: { "initialized": true, "units": ["F1.1","F1.2",...], "first_unit": "F1.1", "total_units": 5 }
```

You can also pass inline unit handlers via `--handlers '{"discover": {"skill": "/my-discover"}}'`.

### 3. Tick loop

```bash
# Get next unit
node "$OPC_HARNESS" next-tick --dir .harness
# Output: { "ready": true, "next_unit": "F1.1", "unit_type": "discover", ... }

# ... your skill does the work for F1.1 ...

# Complete tick with evidence
node "$OPC_HARNESS" complete-tick \
  --unit F1.1 \
  --artifacts path/to/evidence1.txt,path/to/evidence2.md \
  --description "Researched 3 approaches, selected option B" \
  --dir .harness

# Output: { "completed": true, "tick": 1, "next_unit": "F1.2", ... }
```

### 4. Loop until done

```bash
# next-tick returns terminate: true when all units are complete
node "$OPC_HARNESS" next-tick --dir .harness
# Output: { "ready": false, "terminate": true }
```

---

## Mission-aware Orchestration (Optional)

Use Mission mode when the caller needs a durable global objective above OPC's normal artifact gates. Existing integrations remain mission-less unless they explicitly pass `--mission` or `--parent-session`.

### 1. Initialize the canonical Mission session

Create a schema-v1 Mission Contract (see [CONTRACTS.md](CONTRACTS.md#mission-contract-and-additive-state)) and an `acceptance-criteria.md` whose `## Outcomes` bullets exactly match the contract's `OUT-N` IDs and statements.

```bash
# Standard flow
node "$OPC_HARNESS" init \
  --flow-file "$FLOW_FILE" --entry discover \
  --mission /absolute/path/mission.json \
  --criteria /absolute/path/acceptance-criteria.md \
  --plan /absolute/path/plan.md \
  --dir .harness

# Autonomous loop: criteria is read from .harness/acceptance-criteria.md
node "$OPC_HARNESS" init-loop \
  --plan .harness/plan.md \
  --mission /absolute/path/mission.json \
  --dir .harness
```

Initialization validates before it writes active state, copies the exact contract bytes to `.harness/mission-contract.json`, and pins the mission, criteria, and optional plan hashes. It then seals the complete active flow/loop state with a generation-linked signed prepare/commit protocol. Do not edit those files or runtime state in place after initialization; use harness commands and `mission-decision` for an approved revision.

Treat the init receipt as the authority boundary. A requested Mission run is
armed only when the successful response contains `mission_enabled: true`; the
same receipt includes `mission_version`, `strategy_epoch`, and
`mission_contract`. If `mission_enabled` is false or absent, stop before
dispatch and treat the session as mission-less even if the caller supplied a
Mission-themed prompt.

Each sealed state carries top-level `_missionRuntimeSeal` with schema version,
`sealId`, generation, previous seal ID, and the canonical SHA-256 of every state
field except the seal itself. The write protocol stages a full sibling
`<state>.mission-runtime-stage`, signs `mission_runtime_state_prepared`, atomically
publishes the state, signs `mission_runtime_state_committed`, then removes the
stage. Recovery either discards an unsigned stage, promotes/commits a prepared
candidate, commits an already-published candidate, or cleans an obsolete stage.
The HMAC key and provenance ledger are the trust root: this detects accidental
or direct edits and intact-ledger rollback, but is not a security boundary
against a process that can read the key and mint or delete the state and ledger.

After a standard-flow build creates a commit, call
`record-commit --sha <sha> --dir .harness`. The command takes the flow-state
lock and rereads state before append, so it cannot overwrite a concurrent gate
or decision with a stale snapshot. It also refuses pending or terminal Mission
state.

If a loop unit launches a nested flow, give the child canonical parent authority instead of a second contract:

```bash
node "$OPC_HARNESS" init \
  --flow build-verify --entry build \
  --parent-session /absolute/path/to/parent-loop-session \
  --dir /absolute/path/to/child-session
```

A child refuses initialization while the parent's Mission Gate is pending. Later protected child mutations acquire the canonical parent lock before live-parent validation and hold it through the child commit and parent receipt/retry update; a child-issued Mission decision is committed to the parent. Transitions carry their exact origin, and receipt merge/retry consumption are idempotent, so replay cannot double-count either one.

### 2. Bind executor evidence

For a custom standard-flow execute handshake that is not using OPC-owned test
execution, an `evidence` object may record the attempted mapping for audit:

```json
{
  "nodeId": "test-execute",
  "nodeType": "execute",
  "runId": "run_1",
  "status": "completed",
  "verdict": "PASS",
  "artifacts": [{ "type": "test-result", "path": "run_1/e2e.json" }],
  "evidence": {
    "sliceId": "test-execute",
    "scenarioId": "SCENARIO-1",
    "validatorType": "e2e",
    "validator": "checkout-e2e",
    "satisfies": ["OUT-1", "OUT-2", "FLOOR-1"]
  }
}
```

For `build-verify` and other flows with OPC-owned test execution, freeze the
mapping before execution in the source `test-plan.md` instead:

```markdown
## Mission Evidence Mapping
- scenario: SCENARIO-1
- validator-type: e2e
- satisfies: OUT-1, OUT-2, FLOOR-1
```

The full plan must contain exactly one line for each member of this tuple. The
harness hashes it before running `testCommand`; later handshake metadata cannot
relabel the result.

For a loop verification unit, pass the equivalent flags when completing it:

```bash
node "$OPC_HARNESS" complete-tick \
  --unit F1.8 --artifacts .harness/e2e-output.txt \
  --scenario SCENARIO-1 --validator-type e2e \
  --satisfies OUT-1,OUT-2,FLOOR-1 \
  --description "Integrated scenario passed" --dir .harness
```

The harness hashes eligible evidence artifacts and stores an `EV-N` receipt with
the scenario, validator, named criteria, and current `strategyEpoch`. For
built-in `test-execute`, it marks a receipt `scope: integrated` only when the
frozen scenario matches the Mission Contract and the validator type is allowed.
Other standard execute nodes remain local. Supplying `satisfies` with a
missing/mismatched scenario, disallowed validator, or unknown criterion is
rejected rather than downgraded.

Standard artifacts must use relative paths under the sealed latest execute
`run_N` and resolve to contained regular non-symlink files. Integrated scope
requires a current-run machine-readable passing JSON result. When the selected
flow requires OPC test execution, transition into `test-execute` runs the
test-design/hotfix `testCommand`; the gate verifies its command, source-plan,
result, node/run, and signed-ledger provenance and auto-populates the frozen
mapping into the harness-owned execute handshake. Do not substitute a self-authored
PASS result. The test command must also prove that work was non-vacuous—a
non-empty TAP reports at least one executed test and zero failures.
Exit zero alone does not create integrated coverage. A later `seal` merges
artifacts into the harness-owned execute handshake without replacing those
bindings.

Loop integrated evidence is bound to the current `next-tick` claim. Its plan
unit must already declare exactly one `scenario:`, `validator-type:`, and
`satisfies:` mapping plus a `verify:` command; the completion flags must match
them. The harness runs that command and requires a non-vacuous `OPC_ORACLE` or
non-empty, all-passing TAP summary. Its files
must be contained regular non-symlinks inside the session, newer than the claim,
and include a machine-readable PASS. At least one machine-result hash must be
new relative to all prior receipts. Accepted paths become declared artifacts,
so the cold packet covers ignored/non-Git evidence.

Immediately before a trajectory decision and finalization, the harness
re-hashes every current integrated receipt's path-bound artifacts and rechecks
the harness-owned PASS proof. Missing or changed evidence stays in history as
stale, but its coverage stops counting.

### 2.1 Handle invalid Mission review output

A Mission review needs a valid verdict/count, structured findings, and non-empty
reasoning, fix, and Mission metadata. The first invalid attempt produces
non-routing claim hashes. Reevaluate in a fresh run and put exactly one
`review-claim-dispositions.json` beside the fresh eval files:

```json
{
  "schemaVersion": 1,
  "dispositions": [
    { "claimHash": "<64-hex-sha256>", "disposition": "CONFIRM", "findingRef": "FIND-5" },
    { "claimHash": "<64-hex-sha256>", "disposition": "SUPERSEDE", "fingerprint": "replacement-invariant" },
    { "claimHash": "<64-hex-sha256>", "disposition": "REJECT", "evidence": "concrete non-empty evidence" }
  ]
}
```

Include exactly one entry for every pending hash. Unknown, duplicate, or missing
hashes are invalid. CONFIRM/SUPERSEDE must reference a routing finding in the
fresh eval by `findingRef` or `fingerprint`; CONFIRM preserves class, criterion,
and invariant. REJECT accepts only non-empty string/array/object evidence.
Standard flow claims bind to the immediately prior run and epoch. Loop claim
files additionally share one contained regular non-symlink fresh run directory,
postdate the invalid attempt, and bind to its unit/epoch. A second invalid review
opens non-retryable `REVIEW_QUALITY_STALL`.

Any fresh finding that names an existing `FIND-N` must repeat that registry
entry's canonical `fingerprint` and `invariant` exactly. Omission or drift is
review-quality failure; new identities use `finding_ref: NEW`.

Ordinary `UNLINKED` findings remain non-routing. A newly discovered protected
floor can route only as evidenced `GOAL_SPEC` + `UNLINKED`, and its gate permits
only `HUMAN_REBET` or `STOP_SALVAGE`.

### 3. Handle a Mission Gate

`transition`, `advance`, `finalize`, `complete-tick`, or `next-tick` can return `rebet_required: true`. Treat this as a side-band pause, not a graph verdict:

1. Stop dispatch. The graph node or loop cursor has not advanced past the trigger.
2. Read `trajectory-review-request.json` and give only that packet, the pinned Mission Contract it names, and current evidence to one fresh reviewer. The packet includes stable finding details, current validator receipts, bounded Git and declared/ignored artifact entries, receipt-hashed integrated evidence added since the previous gate, and the harness-issued `reviewRequest.runId`. Its complete hash/run/bindings are committed in a signed gate-opening record. Treat `allowedDecisions` as authoritative: retryable non-checkpoint triggers expose all six actions so the cold reviewer can correct the local classification; non-retryable triggers expose only human re-bet/stop, and the final checkpoint exposes only continue/stop.
3. Write its cold review JSON with the exact trigger/bindings, copy the packet-issued run ID, and set `localFixesIncluded: false`.
4. Seal it through the harness, then use the returned review path in `mission-decision`.

```bash
node "$OPC_HARNESS" record-mission-review \
  --review /tmp/mission-review.json --dir .harness
# Use the `review` path returned above; it is immutable under mission-reviews/.

SEALED_REVIEW=/path/returned/by/record-mission-review
node "$OPC_HARNESS" mission-decision \
  --action CONTINUE_CURRENT --actor agent \
  --review "$SEALED_REVIEW" --dir .harness
```

Only one cold review can be sealed for a trigger. A duplicate `record-mission-review` call returns `recorded: false` and includes the existing sealed `review` path; it does not replace the first review.

The available actions are:

| Action | Effect |
|---|---|
| `CONTINUE_CURRENT` | Clears the gate and grants one trigger/epoch/scope/command/source/unit-bound retry; its first matching transition or loop claim consumes it. At a checkpoint it records a bound checkpoint receipt instead. |
| `RESHAPE_SMALLER` | Validates and pins `--plan`, increments `strategyEpoch`, and resumes a loop at the first unit after its longest identical completed prefix. An agent gets one reshape for a canonical finding. |
| `RESTORE` | Two-phase; resume needs action/intent/trigger/mission/plan/epoch-bound evidence and `--resume-unit`. A live clean Git tree must differ from the signed intent baseline; otherwise name a current bound checkpoint. No-op restore is rejected. |
| `RECON` | Two-phase and once per bet; intent needs a bound reproducible environment-baseline probe, and resume must rerun the same command/cwd and prove an actual measured result delta before rebuilding the pending environment-classification packet. |
| `HUMAN_REBET` | Two-phase; resume needs human approval plus a versioned, matched mission/criteria revision. |
| `STOP_SALVAGE` | Terminates without Mission success and writes an absorbing terminal marker. |

The harness remembers these scope decisions across later gates. A second `CONTINUE_CURRENT` for the same canonical scope is rejected. If a canonical finding recurs after its one agent reshape, only `HUMAN_REBET` or `STOP_SALVAGE` is accepted. A successful human re-bet starts a new bet and resets the one-RECON allowance. `STOP_SALVAGE` may also supersede a pending two-phase intent and writes an absorbing terminal marker; no later mutation, resume, or Mission decision restarts that bet.

Mission mode rejects `skip` and `goto` at all times. While the gate is pending, the other protected mutators (`transition`, `advance`, `finalize`, `pass`, `complete-tick`, `next-tick`, and `reinit-loop`) fail closed. Read-only commands remain available. Standard flows can use emergency/manual `stop` while pending; `STOP_SALVAGE` is the audited absorbing termination action for either standard or loop sessions. Neither reports success.

For an agent-run `RESTORE` or `RECON`, supply the sealed cold review on the `intent` command. The matching `resume` carries that binding and rejects a second `--review`.

On a loop reshape, use the returned `resume_unit`. Edited, inserted, reordered, or removed units break the reusable prefix and stale later tick history. If `resume_at_final_checkpoint` is true, do not invent another unit; call `next-tick` so the final Mission checkpoint opens.

On the last Mission loop unit, `complete-tick` returns `terminate: false` and `final_review_pending: true`. The caller must invoke `next-tick`; only that command opens the bound `before_finalize` gate. Do not stop the driver from `next_unit: null` alone.

### 4. Finalization

A Mission-enabled run does not complete merely because its ordinary graph or plan ends. Before finalization, the harness requires:

- valid current mission/criteria/plan hashes;
- no pending Mission Gate;
- current-epoch non-stale integrated PASS receipts whose revalidated `satisfies` coverage includes every active outcome and protected floor;
- a fresh cold `before_finalize` review with classification `NONE`, recommendation `CONTINUE_CURRENT`, no `REFUTES` signal, and `SUPPORTS` evidence for every required reality signal.

The resulting checkpoint receipt is bound to the mission, criteria, plan, evidence-set hash, and strategy epoch. Any later evidence or strategy change makes it stale and requires a new final review. A pending run remains paused; `STOP_SALVAGE` terminates it. Neither state is successful.

---

## Custom Roles and Protocols

Your skill can provide domain-specific reviewer roles and execution protocols:

```
my-skill/
├── flows/my-flow.json      ← references rolesDir + protocolDir
├── roles/
│   ├── market-analyst.md    ← custom role for market analysis
│   └── brand-reviewer.md    ← custom role for brand consistency
└── protocols/
    └── discovery-protocol.md ← custom execution protocol
```

In your flow JSON:
```json
{
  "rolesDir": "./roles",
  "protocolDir": "./protocols"
}
```

**Path rules:**
- Must be relative paths (no `/absolute/path`)
- Must not escape the flow JSON's parent directory (no `../../../etc`)
- Resolved via `resolve(dirname(flowJson), rolesDir)`
- Custom roles with the same name as a built-in OPC role override the built-in for this flow

**Role file format** (same as OPC built-in roles):
```markdown
---
name: Market Analyst
tags: [review, execute]
---

# Identity
You are a market analyst specializing in...

# Expertise
- Competitive landscape analysis
- Market sizing and TAM estimation
...

# When to Include
Include when the task involves market research or competitive analysis.

# Anti-Patterns
- Don't speculate without data sources
```

---

## Unit Handlers (Loop Dispatch)

For loop mode, `unitHandlers` lets your skill intercept specific unit types:

```json
{
  "unitHandlers": {
    "discover": {
      "skill": "/dw-discover",
      "invocation": "/dw-discover {task}"
    },
    "pitch": {
      "skill": "/dw-pitch",
      "invocation": "/dw-pitch {id}"
    },
    "publish": {
      "command": "dw publish {id}"
    }
  }
}
```

When `next-tick` returns a unit whose `unit_type` matches a handler key, the handler info is included in the response:

```json
{
  "ready": true,
  "next_unit": "F1.1",
  "unit_type": "discover",
  "handler": {
    "skill": "/dw-discover",
    "invocation": "/dw-discover {task}"
  }
}
```

Your orchestrator then invokes the skill/command instead of OPC's default dispatch. Unit types without a handler fall back to OPC's built-in behavior.

---

## Concrete Example: dw (Product Discovery)

The `dw` skill uses OPC for quality-gated product discovery. See `examples/dw-integration/dw-flow.json` for the full flow template.

### Skill invocation flow:

```
User: /dw discover "AI code review tool"

dw SKILL.md (orchestrator):
  1. Reads task → selects dw-flow.json
  2. Calls: opc-harness init --flow-file ./flows/dw-flow.json --entry discover --dir .harness
  3. Dispatches /dw-discover subagent (via unitHandler)
  4. Agent writes evidence → .harness/nodes/discover/handshake.json
  5. Calls: opc-harness transition --from discover --to build --verdict PASS --dir .harness
  6. Dispatches build agent with OPC's implementer-prompt.md
  7. After build → code-review with custom market-analyst + brand-reviewer roles
  8. Gate synthesizes findings → PASS/ITERATE/FAIL
  9. On PASS → finalize. On ITERATE → loop back to code-review.
```

### Loop mode for multi-unit discovery:

```
User: /dw loop "Build AI code review product"

dw SKILL.md:
  1. Decomposes into units in plan.md
  2. Calls: opc-harness init-loop --plan plan.md --flow-file ./flows/dw-flow.json --dir .harness
  3. Each tick:
     - next-tick → gets unit + handler
     - If handler.skill exists → invoke that skill
     - Else → run OPC's default dispatch for that unit type
     - complete-tick with artifacts
  4. Loops until terminate: true
```

---

## Error Handling

All commands output JSON to stdout. Check the output for error indicators:

| Command | Success field | Error indicator |
|---------|--------------|-----------------|
| `init` | `created: true` | `created: false, error: "..."` |
| `transition` | `allowed: true` | `allowed: false, reason: "..."` |
| `validate` | `valid: true` | `valid: false, errors: [...]` |
| `finalize` | `finalized: true` | `finalized: false, error: "..."` |
| `init-loop` | `initialized: true` | `initialized: false, error: "..."` |
| `complete-tick` | `completed: true` | `completed: false, error: "..."` |
| `record-mission-review` | `recorded: true` | `recorded: false, error: "..."` |
| `mission-decision` | `decided: true` | `decided: false, error: "..."` |

**Exit codes:** Commands return exit 0 for both success and business-logic errors (the JSON tells you which). Exit 1 is reserved for usage errors (missing required flags). This is intentional — machine consumers parse JSON, not exit codes.

**Exception:** `resolveDir` (the `--dir` validator) calls `process.exit(1)` with stderr text if the directory is invalid. This is a hard pre-flight check, not a business error.

---

## Writing handshake.json

Every node (except gates) requires a `handshake.json` before transitioning. Here's a complete example:

```json
{
  "nodeId": "build",
  "nodeType": "build",
  "runId": "run_1",
  "status": "completed",
  "verdict": "PASS",
  "summary": "Implemented user authentication with email/password login",
  "timestamp": "2026-04-15T10:30:00.000Z",
  "artifacts": [
    { "type": "cli-output", "path": "run_1/build-log.txt" },
    { "type": "test-result", "path": "run_1/test-output.txt" }
  ]
}
```

**Required fields:** `nodeId`, `nodeType`, `runId`, `status`, `summary`, `timestamp`, `artifacts` (array)

**Artifact types:**
- `eval` — evaluation from a reviewer role (review nodes need ≥2)
- `screenshot` — visual evidence (PNG/JPG)
- `test-result` — test runner output
- `cli-output` — command output / logs

**Verdict values:** `PASS`, `ITERATE`, `FAIL`, `BLOCKED`, or `null`

**Where to write:** `.harness/nodes/{nodeId}/handshake.json`

**Review node example** (needs ≥2 eval artifacts):
```json
{
  "nodeId": "code-review",
  "nodeType": "review",
  "runId": "run_1",
  "status": "completed",
  "verdict": "PASS",
  "summary": "Code review passed with minor suggestions",
  "timestamp": "2026-04-15T11:00:00.000Z",
  "artifacts": [
    { "type": "eval", "role": "frontend", "path": "run_1/eval-frontend.md" },
    { "type": "eval", "role": "security", "path": "run_1/eval-security.md" }
  ],
  "findings": { "critical": 0, "warning": 1, "suggestion": 3 }
}
```

**Gate nodes** — don't write handshake.json for gates. The `transition` command auto-creates gate handshakes from `synthesize` output.

---

## Limit Behavior

OPC enforces three legacy graph limits. In a mission-less flow, exceeding one
returns `allowed: false`:

| Limit | Default | What happens |
|-------|---------|-------------|
| `maxLoopsPerEdge` | 3 | Same edge traversed N times → blocked. "Edge gate→build traversed 3 times" |
| `maxTotalSteps` | 20 | Total transitions across flow → blocked. "Total steps (20) reached limit" |
| `maxNodeReentry` | 5 | Same node entered N times → blocked. "Node build entered 5 times" |

**Response when blocked:**
```json
{
  "allowed": false,
  "reason": "edge 'gate→build' traversed 3 times (limit: 3)",
  "next": null
}
```

**Recovery options:**
- `/opc skip` — mission-less only; skip current node via PASS edge
- `/opc pass` — force-pass current gate
- `/opc stop` — terminate flow, preserve state
- `/opc goto <nodeId>` — mission-less only; manual jump (limits still enforced)

These escape hatches are slash commands, not `opc-harness` subcommands; invoke
them through the active Codex host (or an explicitly selected compatibility
host).
In Mission mode, reaching a legacy graph limit instead opens a non-retryable
`LEGACY_FLOW_LIMIT_REACHED` gate before mutation; retry grants cannot bypass it.
Only human re-bet or stop/salvage can route that gate. Mission mode also rejects
`skip` and `goto`; emergency `stop` remains a non-success exit.

---

## Validation Constraints

OPC enforces these at transition time:

| Node type | Requirement |
|-----------|------------|
| `review` | ≥2 eval artifacts from independent agents |
| `execute` | ≥1 evidence artifact (type: screenshot, test-result, or cli-output) |
| `build` | handshake.json with status + verdict |
| `gate` | Auto-created by transition — don't write manually |

**Tier-based requirements** (if flow uses `--tier`):
- `polished`: ≥1 screenshot + ≥1 cli-output/test-result
- `delightful`: ≥2 screenshots + ≥1 cli-output/test-result

**Review independence:** Eval artifacts must come from genuinely independent agents. OPC checks content distinctness — copy-pasted evals are rejected.

---

## Version Compatibility

```
HARNESS_VERSION: 0.10.0
```

Your flow JSON declares `"opc_compat": ">=0.8"`. OPC checks this at load time:
- Missing `opc_compat` → hard error (required since 0.8)
- Version mismatch → hard error with clear message
- Built-in template names (`review`, `build-verify`, `full-stack`, `pre-release`, `legacy-linear`) cannot be overridden via `--flow-file`

**Stability promise:** CLI command names, flag names, and JSON output field names are stable. New fields may be added (consumers should ignore unknown fields). Breaking changes bump the minor version.

---

## File Resolution (How --flow-file Persists)

```
1. --flow-file <path> on current command → loaded immediately
2. _flow_file in flow-state.json / loop-state.json → auto-restored
3. --flow <name> lookup in built-in templates → fallback
```

After `init` or `init-loop`, the absolute path is stored in state. All subsequent commands (`transition`, `finalize`, `next-tick`, `viz`, etc.) auto-restore it. You never need to pass `--flow-file` twice.
