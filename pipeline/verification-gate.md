# Verification Gate

Verify agent outputs before reporting. Scale verification effort to the task.

## Tier 1: Mechanical Checks (always, all task types)

For every agent output, run the harness verifier:

```bash
opc-harness verify .harness/evaluation-wave-N-{role}.md
```

Check the JSON output:
1. **`verdict_present` = false** → re-dispatch with explicit reminder.
2. **`verdict_count_match` = false** → challenge the agent's finding count.
3. **`hedging_detected` non-empty** → review each line; reject findings without a concrete scenario.
4. **`has_file_refs` = false** → re-dispatch with explicit reminder to include file:line references.

Then manually **dedup** — multiple agents reporting same issue → keep best-articulated one.

## Tier 2: Spot-Check (review/analysis tasks, scale by severity)

**For 🔴 Critical findings — actively try to disprove:**
- Read the code the finding references. Does it actually say what the agent claims?
- Check if the issue is mitigated elsewhere (middleware, config, upstream validation).
- Ask: "If I were the author, why would I have written it this way?"
- If you can't disprove it after genuine effort, it's real.

**For 🟡 Warning findings — quick verify:**
- Binary fact checks: "does function X exist?", "is line 42 really `any` type?" → read the file, confirm.
- If the fact is wrong, reject the finding.

**For 🔵 Suggestion findings:** accept at face value unless obviously wrong.

**When two agents disagree on the same issue:** re-dispatch a focused agent to arbitrate.

## Tier 3: Effort Check (large reviews only)

Only for reviews with ≥5 agents or ≥10 files in scope:
- Count files each agent referenced vs assigned scope. If suspiciously thin, re-dispatch with explicit file list.

## Coordinator Actions

For questionable findings:
- **Dismiss** with one-line reason
- **Downgrade** severity with explanation
- **Re-dispatch** for defense (targeted prompt below)

Re-dispatch prompt:
```
A finding has been challenged. Review independently.

Original finding: {{finding with file:line}}
Challenge: {{concern + concrete evidence from code}}

Assess: DEFEND (with your own code references) / RETRACT / DOWNGRADE
```

**Re-dispatch ceiling: 2 rounds max** (initial dispatch = round 1, one re-dispatch round). If still unresolved, accept with ⚠️ and move on.

**Transparency:** If you dismiss >80% of findings, note it in the report.

## Verification Output

**Small reviews** (≤3 findings, no 🔴): inline verification notes with findings.

**Large reviews** (>3 findings or any 🔴): show verification log:
```
## Verification Log

| Agent | Checks | Spot-Checks | Action |
|-------|--------|-------------|--------|
| {role} | ✅/❌ | What you verified | N dismissed, M downgraded |
```

---

## Deep Dive

After verification, review each agent's **Threads** section. For threads worth pursuing:

Use the **Agent tool** with `to: agentId` (SendMessage) to resume the original agent — it keeps its full context. Do not re-spawn.

```
The coordinator reviewed your findings and threads.

Go deeper on: {{specific thread}}
Trace the root cause across files. Update your findings if this changes severity or adds new issues.
```

**When to deep-dive:** Thread describes a cross-file dependency, uncertain root cause, or a finding whose severity depends on tracing further.

**When to skip:** Agent returned LGTM with no threads, or threads are minor.

**Ceiling:** Follow up with at most 3 agents. Deep-dive is for depth on the most interesting threads, not completeness.

Deep-dive responses inherit the agent's original VERDICT format. Apply Tier 1 mechanical checks to updated output.

---

## Synthesis Round (conditional)

After deep dive (or after verification if no deep dive), check for cross-cutting signals:

- Agent A found X, which changes the context for Agent B's domain → dispatch B with A's finding as input
- Two agents produced contradictory recommendations → dispatch a focused arbitrator
- Round 1 revealed a domain not covered by any dispatched agent → dispatch new role

**Decision:** Run synthesis only when findings genuinely interact and the answer matters. Do not synthesize for completeness.

Synthesis agents receive: the specific finding from another agent + the targeted question. Not all findings.

**Synthesis outputs must pass Tier 1 mechanical checks** (VERDICT present, dedup, hedging). Skip Tier 2/3.
