# Token Budget and Native Model Routing Policy

This policy is mandatory. Its goal is to reduce total and frontier-model token use without replacing Codex's reliable native Agent control plane or weakening deterministic verification.

## Default Configuration

When `opc-harness config resolve` has no `dispatchPolicy`, behave as if it returned:

```json
{
  "dispatchPolicy": {
    "mode": "economy",
    "controlPlane": "codex-native",
    "modelRouting": "codex-recommended",
    "unknownModelPolicy": "host-auto",
    "nativeChildBudget": 40,
    "solChildBudget": 6,
    "rootSolReviewPasses": 1,
    "maxNativeAgentsPerNode": 5,
    "maxNativeAgentsPerFlow": 40,
    "discussionRounds": 3,
    "uxObservers": 3,
    "readHeavyRoute": "codex-terra",
    "semanticRoute": "codex-gpt-5.6",
    "externalBackend": null,
    "externalFallback": "deny"
  }
}
```

`nativeChildBudget` is a concurrency and fan-out ceiling, not a reason to consume all available calls. `solChildBudget` counts explicitly pinned GPT-5.6/Sol child calls; unpinned native calls are governed by Codex host routing and reported separately. Keep the root's final review to one bounded pass unless new evidence after REWORK or a high/critical unresolved risk justifies another.

## Economy Invariant

Economy is native-first:

1. Use Codex's native subagent lifecycle.
2. Match the role to Codex's documented model strengths.
3. If the host exposes no model selector, leave the model unpinned and let Codex balance intelligence, speed, and price.
4. Use external CLI Adapters only for an explicitly requested third-party platform. Never auto-fallback to Claude, MiniMax, OpenCode, or another external Harness.
5. Preserve the selected OPC flow and every verification gate.

An unpinned native child is accepted as `codex-auto`; it is not proof of a specific model and must not be used in model-specific cost or benchmark claims.

## Codex-Native Role Routing

Use an existing project/user custom agent profile when its description matches the work. Otherwise use built-in `explorer` or `worker` roles when available. If the current host surface does not expose agent-type or model selection, send the bounded role contract through the native Agent API and rely on Codex auto-routing.

Run `opc-harness agent-route --node <id> --node-type <type> --role <role> --task-shape <shape> --dir <project>` before dispatch. See `codex-native-routing.md` for the result contract and configuration surface.

| Work | Preferred native role/model | Reasoning effort | Escalation |
|---|---|---|---|
| repository reconnaissance, symbol search, large-file reading, documentation scan | `explorer` / GPT-5.6 Terra | low or medium | GPT-5.6 only when synthesis is ambiguous |
| bounded mechanical implementation, docs, tests with an explicit oracle | `worker` / GPT-5.6 Terra | medium | GPT-5.6 after a semantic miss or when boundaries are unclear |
| ordinary semantic implementation, integration, refactor | `worker` / GPT-5.6 | medium | high effort for cross-cutting ambiguity |
| style, test inventory, concrete checklist review | fresh evaluator / GPT-5.6 Terra | medium | GPT-5.6 for disputed semantics |
| architecture, security, concurrency, destructive migration, external side effects | fresh specialist / GPT-5.6 | high | user boundary for irreversible decisions |
| UX observers and read-only persona walkthroughs | `explorer` / GPT-5.6 Terra | medium | GPT-5.6 for product-strategy synthesis |
| final acceptance | current root / GPT-5.6 | high when risk warrants | one new pass only after new evidence |

Do not assign GPT-5.6 merely because a role is named architect, security, facilitator, designer, or skeptic. Inspect the actual task. Do not assign Terra to an ambiguous semantic change merely because it touches few files.

## Modes

| Mode | Native routing | External adapters | Root review | Intended use |
|---|---|---|---|---|
| economy (default) | role matrix or Codex auto-routing; Terra preferred for read-heavy/routine work | disabled | one bounded pass | normal work, stable and token-aware |
| balanced | same native control plane; GPT-5.6 used earlier for semantic risk | disabled | final review plus high/critical escalation | medium/high semantic risk |
| maximum | explicit high-effort native profiles allowed | still opt-in per third-party platform | deep review | critical/release investigations |

External routing is orthogonal to these modes. Selecting `maximum` does not authorize a third-party CLI.

## Per-Node Dispatch Plan

Before native dispatch, write a compact plan in the node directory:

```json
{
  "policy": "economy",
  "node": "build",
  "control_plane": "codex-native",
  "agent_role": "worker",
  "model_preference": "gpt-5.6-terra",
  "model_selection": "host-auto-if-unavailable",
  "native_agents": 1,
  "external_agents": 0,
  "root_review_passes": 1,
  "reason": "bounded implementation with an explicit validator"
}
```

Do not dispatch when:

- the plan exceeds configured fan-out;
- two Agents would receive substantially overlapping scopes;
- a mutating Agent has no explicit working directory or allowed paths;
- the Work Order has no approved validator;
- the only justification is role ceremony or consensus theater.

## Native Work Order Standard

Each child receives bounded context, not the raw conversation transcript:

- one primary semantic responsibility;
- explicit working directory and, for isolated edits, the assigned worktree;
- allowed and forbidden paths;
- current and desired behavior;
- non-goals and APIs that must not change;
- positive, negative, and boundary acceptance cases;
- deterministic validator command and expected result;
- output artifact/report contract;
- stop conditions for ambiguity, scope conflict, or unsafe side effects.

Use native follow-up and wait controls for lifecycle management. Do not add a file-mailbox scheduler or start nested `codex exec` processes to simulate native Agent management.

## Token Firewall Integration

Token Firewall is optional governance around native work, not the default scheduler. Use its contracts, isolated Git delivery, deterministic validators, failed-attempt accounting, and blind Review Packet when risk warrants. The Codex host still creates and manages native Agents directly.

External Token Firewall Runtime Adapters may be selected only after the user explicitly requests the corresponding third-party platform. Freeze that Harness and model for the attempt; never silently fall back between platforms.

## Context Firewall

The root final reviewer reads:

- mission invariants and acceptance criteria;
- changed-file manifest and bounded patch;
- deterministic validator evidence;
- compact findings from fresh evaluators;
- unresolved risks and narrow code slices requested for a concrete question.

It does not read full child transcripts, repeated repository summaries, heartbeat logs, or entire untouched files by default.

## Completion Accounting

Report:

- native child count by role and known model preference;
- which calls used host auto-routing;
- explicitly pinned GPT-5.6 child count;
- root final-review passes;
- external Sessions, if and only if the user explicitly authorized them;
- available token/usage data without inventing missing per-child attribution;
- retries, failed attempts, rework, and policy overrides.
