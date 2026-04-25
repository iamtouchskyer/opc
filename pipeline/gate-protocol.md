# Gate Protocol

Gates aggregate upstream verdicts and route the flow. Gates do not dispatch subagents — the orchestrator executes gates directly using harness commands.

## Procedure

### Step 1 — Synthesize Upstream Verdicts

Run the harness to compute the aggregate verdict:

```bash
opc-harness synthesize $SESSION_DIR --node {UPSTREAM_NODE_ID}
```

Output: `{ verdict, totals: { critical, warning, suggestion }, roles[], evalQualityGate?, evaluatorGuidance? }`

**D2 Compound Eval Quality Gate (enforce by default):**
The synthesize command stacks 11 defense layers per role (thinEval, noCodeRefs, lowUniqueContent, singleHeading, findingDensityLow, missingReasoning, missingFix, lineLengthVarianceLow, aspirationalClaims, changeScopeCoverage, invalidRefCount×2). If ≥3 layers trip on any role → `verdict = FAIL`. Pass `--no-strict` to downgrade to shadow mode (output `evalQualityGate.triggered=true` without changing verdict).

**thinEval substance exemption:** Evals under 50 lines are exempt from thinEval if every finding has reasoning + fix + file ref.

**--base ref validation:** Pass `--base <project-root>` to validate file:line references against the filesystem. Fabricated refs count as 2 layers in the compound gate. When `--base` is provided and git history is available, the changeScopeCoverage layer checks that the eval mentions ≥30% of changed files. Note: `changeScopeCoverage` and `invalidRefCount` only activate when `--base` is provided and git is available — they are conditional layers.

**Evaluator guidance (feedback loop):** When D2 triggers, the output includes `evaluatorGuidance` — a per-role object with `triggeredLayers` (which checks failed) and `hints` (actionable fix instructions). On ITERATE, the orchestrator SHOULD inject this guidance into the R2 evaluator prompt so the evaluator knows exactly what to fix.

### Step 2 — Mechanical Validation

Before accepting the synthesized verdict, verify upstream quality:

- Every finding must have a severity emoji (🔴 🟡 🔵)
- Every 🔴 critical finding must have a `file:line` reference
- Every 🔴 critical finding must have a `→ Fix:` suggestion
- Flag hedging language (might, could, potentially) — challenge or downgrade

If mechanical checks fail, re-dispatch the upstream evaluator with a reminder. Max 2 re-dispatch attempts — after that, accept with ⚠️ annotation.

### Step 3 — Route Decision

Use the harness to determine the next node:

```bash
opc-harness route --node {GATE_ID} --verdict {VERDICT} --flow {FLOW_TEMPLATE}
```

Output: `{ next: "<nodeId>" | null, valid: true }`

- `next = null` means the flow is complete.
- `valid = false` means the gate or verdict is not in the flow template — surface error to user.

**Do not determine the next node yourself.** Always use the `route` command.

### Step 4 — Transition

Execute the transition (also writes this gate's handshake.json automatically):

```bash
opc-harness transition --from {GATE_ID} --to {NEXT_NODE} --verdict {VERDICT} --flow {FLOW_TEMPLATE} --dir $SESSION_DIR
```

Output: `{ allowed: true/false, reason, next, state }`

- `allowed = true` → proceed to next node
- `allowed = false` → cycle limit reached. Surface to user with escape options:
  - `/opc pass` — force PASS, advance to the PASS edge target
  - `/opc stop` — terminate flow, preserve state
  - `/opc goto <node>` — manual override (still checked against cycle limits)

The `transition` command automatically:
1. Validates the edge exists in the flow template
2. Checks cycle limits (maxLoopsPerEdge, maxTotalSteps, maxNodeReentry)
3. Writes this gate's `$SESSION_DIR/nodes/{GATE_ID}/handshake.json`
4. Updates `$SESSION_DIR/flow-state.json`

### Step 5 — Findings Disposition

After routing, handle unresolved findings. **Findings that are not fixed in the current cycle MUST be tracked — they cannot be "acknowledged" and forgotten.**

| Verdict | 🔴 Critical | 🟡 Warning | 🔵 Suggestion |
|---------|-------------|------------|---------------|
| FAIL | Must fix before re-gate | — | — |
| ITERATE | Must fix before re-gate | Append to `$SESSION_DIR/backlog.md` if not fixing now | Optional |
| PASS | N/A (no 🔴 if PASS) | Append to `$SESSION_DIR/backlog.md` | Drop or append |

**Backlog append format:**
```markdown
- [ ] {emoji} [{source node}] {finding summary} — {file:line if applicable}
```

**Devil's Advocate findings** receive special treatment:
- Product-level concerns (design validity, algorithm effectiveness, business assumptions) → always 🟡 minimum, always tracked in backlog
- These are explicitly NOT dismissible with "acknowledged but not code-blocking"
- If the orchestrator disagrees with a devil's advocate finding, it must write a **counter-argument** in the backlog entry, not simply omit it

Create `$SESSION_DIR/backlog.md` if it doesn't exist. Append, never overwrite.

### Step 6 — User Notification

Always inform the user of the gate outcome:

- **Loopback:** `🔄 Loop {N}/{MAX}: {reason}, returning to {target}`
- **Pass:** `✅ {gate} passed, proceeding to {next}`
- **Done:** `🎉 Flow complete.`
- **Blocked:** `⛔ Cycle limit reached at {gate}. Use /opc pass, /opc stop, or /opc goto <node>.`

## Anti-Patterns

- ❌ Overriding the synthesized verdict with your own judgment
- ❌ Determining the next node by reading skill.md tables — use `opc-harness route`
- ❌ Writing gate handshake.json manually — `transition` does this
- ❌ Continuing after `allowed: false` without user consent
- ❌ "Acknowledging" a 🟡 finding without writing it to backlog.md — this is how findings get lost
- ❌ Dismissing devil's advocate product concerns as "not code-blocking" without tracking them

## Conflict of Interest — Builder as Orchestrator

When the orchestrator also performed the build (same session, same agent):

1. **The orchestrator MUST NOT override gate verdicts.** Specifically:
   - ITERATE verdict → orchestrator cannot rationalize warnings as "pre-existing" or "acceptable"
   - FAIL verdict → orchestrator cannot downgrade to ITERATE
   - Only the USER can override verdicts when conflict-of-interest applies

2. **Detection**: If the current session's build node was executed by the orchestrator (not a subagent in a worktree), conflict-of-interest is assumed.

3. **Escalation**: When conflict-of-interest is detected and verdict is not PASS:
   - Show the user: verdict, all findings summary, and the specific warnings
   - Ask: "Gate verdict is {VERDICT}. As builder, I have a conflict of interest. Accept findings and iterate, or override? [iterate/override]"
   - Do NOT pre-fill the answer or suggest overriding

4. **Audit trail**: Any user override must be logged in progress.md: "⚠️ User override: {verdict} → PASS (conflict-of-interest acknowledged)"

## Skeptic-Owner Authority

When multiple reviewers disagree on verdict, **skeptic-owner's verdict takes precedence**. Skeptic-owner is the user's representative in the pipeline — its job is to verify the output matches what was actually asked for.

Concretely:
- If skeptic-owner says FAIL and others say PASS → treat as FAIL
- If skeptic-owner says ITERATE and others say PASS → treat as ITERATE
- If skeptic-owner says PASS and others say ITERATE → the orchestrator MAY escalate to user, but skeptic-owner's PASS carries more weight than other roles' ITERATE
- The orchestrator MUST NOT dismiss or downgrade skeptic-owner findings under any rationale
