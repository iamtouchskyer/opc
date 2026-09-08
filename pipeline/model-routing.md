# Model Routing Protocol

Model routing is independent from flow selection and role selection. Keep OPC's nodes, rounds, and reviewers unchanged; choose the least expensive model tier that can reliably perform each role.

Claude Code uses the parent model when a subagent model is omitted. OPC therefore resolves a model before **every** Agent call and passes it explicitly. See the [Claude Code subagent model precedence](https://code.claude.com/docs/en/sub-agents#choose-a-model).

## Resolve Before Dispatch

```bash
opc-harness model-route \
  --node "$NODE_ID" \
  --node-type "$NODE_TYPE" \
  --role "$ROLE" \
  --dir "$PROJECT_ROOT"
```

The command returns JSON:

```json
{
  "ok": true,
  "dispatch": true,
  "tier": "economy",
  "model": "haiku",
  "source": "role:tester",
  "premium": false
}
```

- `dispatch: false` means the node is orchestrator/tool-only; do not spawn an Agent.
- Pass `model` as the Claude Code Agent tool's per-invocation model parameter.
- On another host, treat `model` as a host-native identifier and use that host's explicit model selector.
- If the host cannot honor an explicit model, stop instead of silently inheriting the root model.
- `PREMIUM_APPROVAL_REQUIRED` requires explicit user approval, then re-run with `--allow-premium`.
- `CLAUDE_CODE_SUBAGENT_MODEL` has runtime precedence and is surfaced as `envOverride: true`.

## Defaults

| Work | Tier | Claude Code default |
|---|---|---|
| Test design and user/UX observer roles | economy | `haiku` |
| Discussion, briefs, implementation, semantic review, hotfix | standard | `sonnet` |
| Explicit premium escalation only | premium | `inherit` |
| Execute and gate nodes | none | no Agent |

These defaults prevent a premium root session from automatically turning every `general-purpose` child into the same premium model.

## Layered Configuration

Set `agentRouting` in `~/.opc/config.json` or repository `.opc/config.json`. Repository config overrides user config through OPC's existing deep-merge rules.

```json
{
  "agentRouting": {
    "defaultTier": "standard",
    "unknownModelPolicy": "deny",
    "allowPremiumByDefault": false,
    "models": {
      "economy": "haiku",
      "standard": "sonnet",
      "premium": "inherit"
    },
    "nodeTypes": {
      "discussion": "standard",
      "brief": "standard",
      "build": "standard",
      "review": "standard",
      "execute": "none",
      "gate": "none"
    },
    "nodes": {
      "test-design": "economy",
      "ux-simulation": "economy"
    },
    "roles": {
      "tester": "economy",
      "new-user": "economy",
      "security": "standard"
    },
    "premiumModels": ["inherit", "opus"]
  }
}
```

Values in `models` are host-native identifiers. A Codex or other host adapter can replace them with its own available high-value and premium model IDs without changing OPC's flow definitions.

Resolution precedence is:

1. Host-wide runtime override (`CLAUDE_CODE_SUBAGENT_MODEL` on Claude Code)
2. Role tier
3. Node tier
4. Node-type tier
5. `defaultTier`

Do not choose a tier from role prestige. `security`, `architect`, or `devil-advocate` are scopes, not automatic premium-model approvals. Escalate only for concrete risk or repeated failure of a lower tier.
