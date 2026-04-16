# OPC Contracts — Stable Interfaces for External Callers

> This document defines the stable mechanical interfaces that external skills (orchestrators, companions, tools) can depend on. Everything not listed here is internal and may change without notice.

## Version

OPC Harness version: read from `HARNESS_VERSION` in `bin/lib/flow-templates.mjs`.
Currently: `0.9.0`.

External consumers declare compatibility via `opc_compat: ">=0.8"` — see [Flow Templates](#4-custom-flow-templates) below.

---

## 1. Skill Invocation

External skills call OPC via Claude Code skill invocation:

```
/opc <flow-template> <task>          # Run a single flow
/opc loop <task>                     # Run autonomous loop (plan → tick → tick → ...)
/opc <role> [role...] <task>         # Explicit roles, skip role selection
```

**Return convention:** OPC writes results to `.harness/`. The calling skill reads `.harness/flow-state.json` and `.harness/nodes/*/handshake.json` to determine outcome.

**Flow state on completion:** `flow-state.json` will have `status: "completed"` and the terminal gate's `handshake.json` will have `verdict: "PASS"`.

---

## 2. CLI Interface (`opc-harness`)

All commands output JSON to stdout. Errors go to stderr. Exit code 0 on success, 1 on usage error.

### Flow Commands

```bash
OPC_HARNESS="$HOME/.claude/skills/opc/bin/opc-harness.mjs"

# Initialize a flow
node "$OPC_HARNESS" init --flow <template> [--flow-file <path>] [--entry <node>] [--tier <tier>] [--force] --dir <path>
# → { created: bool, flow: string, entry: string, tier: string|null }
# On error: { created: false, error: string }

# Get next node from graph (stateless — requires --flow or --flow-file)
node "$OPC_HARNESS" route --node <id> --verdict <PASS|FAIL|ITERATE> --flow <template> [--flow-file <path>]
# → { next: string|null, valid: bool }

# Execute state transition (auto-restores flow template from _flow_file in state)
node "$OPC_HARNESS" transition --from <n> --to <n> --verdict <V> --flow <template> [--flow-file <path>] --dir <path>
# → { allowed: bool, reason: string, next: string, runId: string, state: object }

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

### Loop Commands

```bash
# Initialize autonomous loop from plan.md
node "$OPC_HARNESS" init-loop [--plan <file>] [--flow-template <name>] [--flow-file <path>] [--handlers <json>] --dir <path>
# → { initialized: bool, units: string[], first_unit: string, total_units: number }

# Get next unit (or terminate)
node "$OPC_HARNESS" next-tick [--force-terminate] --dir <path>
# → { ready: bool, terminate: bool, next_unit: string, unit_type: string, handler?: object }
# → (drain gate) { ready: false, terminate: false, drain_required: true, backlog: object, actionable_items: string[] }

# Complete current tick with evidence
node "$OPC_HARNESS" complete-tick --unit <id> --artifacts <a,b> --description <text> [--status <completed|blocked|failed>] --dir <path>
# → { completed: bool, ... }
# ⚠ BREAKING (0.9.0): deferral language in --description on the final tick is a hard error (completed: false)
```

### Escape Hatches

```bash
node "$OPC_HARNESS" skip --dir <path>       # Skip current node via PASS edge
node "$OPC_HARNESS" pass --dir <path>       # Force-pass current gate
node "$OPC_HARNESS" stop --dir <path>       # Terminate flow, preserve state
node "$OPC_HARNESS" goto <nodeId> --dir <path>  # Jump to node (limits enforced)
node "$OPC_HARNESS" next-tick --force-terminate --dir <path>  # Bypass drain gate
```

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
  "tierCoverage": {                   // present on execute nodes with tier (optional)
    "covered": ["responsive-layout", "dark-mode"],
    "skipped": [{ "key": "loading-states", "reason": "not applicable" }]
  },
  "skipped": true                     // set by /opc skip (optional)
}
```

**Node type constraints:**
- `review` nodes require `≥2 eval artifacts` from independent agents
- `execute` nodes require `≥1 evidence artifact` (type: screenshot, test-result, or cli-output)
- `gate` nodes are auto-created by `transition` — external callers don't write them

### `.harness/loop-state.json`

```jsonc
{
  "tick": 3,
  "unit": "F1.3",                     // current unit ID
  "status": "initialized",            // initialized | in_progress | completed | blocked | failed | pipeline_complete | terminated | stalled
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
  "opc_compat": ">=0.7",             // REQUIRED: minimum harness version
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
| `review` | review → gate | review |
| `build-verify` | build → code-review → test-design → test-execute → gate | build |
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

## Stability Promise

- **Stable:** CLI command names, flag names, JSON output field names, file schema fields listed above
- **Unstable:** Internal module exports (`bin/lib/*.mjs`), `skill.md` wording, `pipeline/*.md` content, role `.md` content
- **Additive:** New fields may be added to JSON outputs and schemas. Consumers should ignore unknown fields.
- **Breaking changes:** Signaled by bumping the minor version in `HARNESS_VERSION`. External flows use `opc_compat` to declare minimum version.
