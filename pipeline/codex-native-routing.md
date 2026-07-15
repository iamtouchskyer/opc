# Codex Native Agent Routing

OPC keeps model routing separate from flow and role selection. Resolve a recommendation before every native Agent dispatch:

The defaults follow the official [Codex subagents guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents): Terra for fast, read-heavy exploration; GPT-5.6 for demanding reasoning, tool use, and validation; unpinned model selection when Codex should balance intelligence, speed, and price.

```bash
opc-harness agent-route \
  --node "$NODE_ID" \
  --node-type "$NODE_TYPE" \
  --role "$ROLE" \
  --task-shape "$TASK_SHAPE" \
  --dir "$PROJECT_ROOT"
```

`TASK_SHAPE` is one of `read-heavy`, `routine`, `semantic`, `high-risk`, or `tool-only`. Classify the actual work, not the prestige of the role name.

Example native result:

```json
{
  "dispatch": true,
  "controlPlane": "codex-native",
  "tier": "economy",
  "modelPreference": "gpt-5.6-terra",
  "reasoningEffort": "medium",
  "selection": "prefer-if-host-selectable-else-auto"
}
```

- `dispatch: false` means the node is orchestrator/tool-only.
- `modelPreference` is a preference, not a claim that every host API can pin a model.
- When the host exposes agent profiles or a selector, use the returned preference.
- When it does not, omit the model and let Codex auto-route. Do not start `codex exec` or an external CLI to simulate selection.
- Built-in `explorer` is preferred for read-only scans; `worker` is preferred for implementation when the host exposes those agent types.

External routing requires two explicit inputs:

```bash
opc-harness agent-route \
  --node build --node-type build \
  --external-platform claude \
  --explicit-third-party
```

The explicit flag records that the user asked for Claude, MiniMax, OpenCode, or another configured third-party platform. It is never inferred from Economy mode, a missing native selector, token pressure, or a failed native attempt.

Layer overrides live under `agentRouting` in `~/.opc/config.json` or project `.opc/config.json`. Repository configuration wins through OPC's existing deep merge. Useful fields are `models`, `reasoning`, `taskShapes`, `nodeTypes`, `nodes`, `roles`, `unknownModelPolicy`, and `externalPlatforms`.
