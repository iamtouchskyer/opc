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

**Required fields:**
- `opc_compat` — MUST be present. Checked against harness version via semver.
- `nodes`, `edges`, `nodeTypes` — the flow graph.
- `limits` — loop/step bounds.

**Node types:** `discussion`, `build`, `review`, `execute`, `gate`

### 2. Initialize

```bash
OPC_HARNESS="$HOME/.claude/skills/opc/bin/opc-harness.mjs"
FLOW_FILE="$HOME/.claude/skills/my-skill/flows/my-flow.json"

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
node "$OPC_HARNESS" init-loop \
  --plan plan.md \
  --flow-file "$FLOW_FILE" \
  --dir .harness

# Output: { "initialized": true, "units": ["F1.1","F1.2",...], "first_unit": "F1.1", "total_units": 5 }
```

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

dw skill.md (orchestrator):
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

dw skill.md:
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

**Exit codes:** Commands return exit 0 for both success and business-logic errors (the JSON tells you which). Exit 1 is reserved for usage errors (missing required flags). This is intentional — machine consumers parse JSON, not exit codes.

**Exception:** `resolveDir` (the `--dir` validator) calls `process.exit(1)` with stderr text if the directory is invalid. This is a hard pre-flight check, not a business error.

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
HARNESS_VERSION: 0.8.0
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
