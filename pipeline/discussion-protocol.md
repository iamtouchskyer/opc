# Discussion Protocol

You are participating in a multi-agent discussion. Your goal is to reach a well-reasoned decision through structured dialogue.

## Context

- **Participants:** {AGENTS}
- **Task:** {TASK_DESCRIPTION}
- **Upstream context:** {UPSTREAM_HANDSHAKE_SUMMARY}
- **Working directory:** {WORKING_DIR}

## Protocol

Round-robin discussion, maximum 3 rounds. Each round builds on the previous.

### Round 1 — Independent Analysis

Each agent is dispatched serially (not parallel). Each agent reads the original task and upstream context, then outputs their independent analysis and proposed approach.

**Your output must include:**
1. **Key observations** — what you see from your specialist angle
2. **Proposed approach** — your recommended direction with rationale
3. **Risks & concerns** — what could go wrong
4. **Questions for other agents** — what you need from other perspectives

Write to: `.harness/nodes/{NODE_ID}/run_{RUN}/round-1-{ROLE}.md`

### Round 2 — Respond to Divergence Only

Each agent reads all Round 1 outputs, then responds. **Write only your differences** — do not restate points of agreement.

**Your output must include:**
1. **Agreements** — brief list of points you endorse (one line each)
2. **Disagreements** — where you differ and why (detailed)
3. **New insights** — anything triggered by reading other perspectives
4. **Revised position** — your updated recommendation (if changed)

Write to: `.harness/nodes/{NODE_ID}/run_{RUN}/round-2-{ROLE}.md`

### Round 3 — Facilitator Convergence

The first agent acts as facilitator. Read all Round 1 outputs + Round 2 diffs.

**Your output must include:**
1. **Consensus points** — what everyone agrees on
2. **Resolved disagreements** — how conflicts were settled (with rationale)
3. **Unresolved disagreements** — what remains open (with recommendation)
4. **Final decision** — the concrete plan going forward
5. **Acceptance criteria** — 3-7 testable bullet points for downstream nodes

Write to: `.harness/nodes/{NODE_ID}/run_{RUN}/decision.md`

## Handshake

After Round 3, the orchestrator writes `handshake.json`:

```json
{
  "nodeId": "{NODE_ID}",
  "nodeType": "discussion",
  "runId": "run_{RUN}",
  "status": "completed",
  "verdict": null,
  "summary": "<facilitator's final decision, 2-3 sentences>",
  "timestamp": "<ISO8601>",
  "artifacts": [
    { "type": "transcript", "path": ".harness/nodes/{NODE_ID}/run_{RUN}/round-1-{ROLE}.md" },
    { "type": "transcript", "path": ".harness/nodes/{NODE_ID}/run_{RUN}/round-2-{ROLE}.md" },
    { "type": "decision", "path": ".harness/nodes/{NODE_ID}/run_{RUN}/decision.md" }
  ]
}
```

Discussion nodes do not produce a verdict. The decision artifact feeds into downstream build/review nodes.

## Anti-Patterns

- ❌ Restating agreement in full paragraphs — one line per consensus point
- ❌ Deferring to others without reasoning — "I agree with X" must say why
- ❌ Introducing scope creep in Round 3 — facilitator synthesizes, does not add
- ❌ Round 2 longer than Round 1 — diffs should be shorter than initial analysis
