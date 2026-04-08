# Handshake Specification

Every node writes a `handshake.json` file to `.harness/nodes/{NODE_ID}/handshake.json`. This is the contract between nodes.

## Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| nodeId | string | yes | Unique node identifier |
| nodeType | string | yes | One of: discussion, build, review, execute, gate |
| runId | string | yes | Execution run (e.g., run_1, run_2 for loopbacks) |
| status | string | yes | One of: completed, failed, blocked |
| verdict | string\|null | no | PASS, ITERATE, FAIL, BLOCKED, or null |
| summary | string | yes | Brief description of what was done (2-3 sentences) |
| timestamp | string | yes | ISO 8601 timestamp |
| artifacts | array | yes | List of { type, path } pointing to output files |
| findings | object\|null | no | { critical, warning, suggestion } counts |
| loopback | object\|null | no | { from, reason, iteration } if this is a loopback run |

## Artifact Types

| Type | Used by | Description |
|------|---------|-------------|
| code | build nodes | Modified source files |
| evaluation | review nodes | eval.md or eval-{role}.md files |
| transcript | discussion nodes | Round transcripts |
| decision | discussion nodes | Facilitator's convergence decision |
| test-result | execute nodes | Test output files |
| screenshot | execute nodes | GUI screenshots |
| cli-output | execute nodes | CLI command outputs |

## Validation

Run `opc-harness validate <handshake.json>` to check schema compliance. Key rules:
- Execute nodes must have at least one evidence artifact (test-result, screenshot, or cli-output)
- If findings.critical > 0, verdict cannot be PASS
- All artifact paths must point to existing files
