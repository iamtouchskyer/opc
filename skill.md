---
name: opc
version: 0.5.0
description: "OPC — One Person Company. Digraph-based task pipeline with independent multi-role evaluation. Builds, reviews, analyzes, and brainstorms with specialist agents. Every path ends with evaluation. /opc <task>, /opc -i <task>, /opc <role> [role...]"
---

# OPC — One Person Company

One principle: **the agent that does the work never evaluates it.**

A full team in a single skill. The digraph engine handles any task — building code, reviewing code, analyzing problems, brainstorming designs. It infers which flow and entry point to use from the task itself, and every path ends with independent evaluation.

## Invocation

**Harness path:** The `opc-harness` binary lives at `bin/opc-harness.mjs` relative to this skill's install directory. Resolve it once at session start:
```bash
OPC_HARNESS="$HOME/.claude/skills/opc/bin/opc-harness.mjs"
```
All `opc-harness` references below mean `node "$OPC_HARNESS"`. Set this as a shell variable and reuse it throughout the session.

```
/opc <task>              # auto mode — infer flow and roles from the task
/opc -i <task>           # interactive mode — ask questions before dispatch
/opc <role> [role...]    # explicit roles — skip role selection, dispatch directly
/opc loop <task>         # autonomous loop — decompose, schedule cron, run 24h unattended
/opc skip                # skip current node, advance via PASS edge
/opc pass                # force-pass current gate
/opc stop                # terminate flow, preserve .harness/ state
/opc goto <nodeId>       # manual jump to a node (cycle limits still enforced)
```

## Task Inference + Flow Selection

The orchestrator reads the task, selects a flow template, and determines the entry point.

| Task says... | Flow template | Default entry |
|---|---|---|
| "review", "audit", "check", "before we merge", "找问题", "开源前看看" | quick-review | code-review |
| "analyze", "diagnose", "what's wrong with", "分析" | quick-review | code-review |
| "build", "implement", "create", "fix bug", "帮我实现", "重构成..." | build-verify | build |
| "brainstorm", "explore options", "what are the approaches", "有什么方案" | build-verify | build |
| "plan", "decompose", "break this down", "scope", "estimate", "拆一下" | build-verify | build |
| "verify", "test", "QA", "check before release", "发布前验收" | pre-release | acceptance |
| "post-release", "user test", "onboarding check", "用户验收" | pre-release | acceptance |
| Complex, vague, or multi-keyword request | full-stack | discuss |
| `/opc loop` or multi-unit feature backlog | **loop-protocol** | plan decomposition |

**Entry override** — user context can shift the entry point (only if target ∈ template nodes):

| User has... | Entry override |
|---|---|
| A vague idea or brief | First node in template |
| A spec or design doc | build (if ∈ template) |
| An implementation plan | build (if ∈ template) |
| Code that needs evaluation | code-review or test-verify (if ∈ template) |
| Everything done, needs acceptance | acceptance (if ∈ template) |

**Priority rules:**
- `/opc loop <task>` = enter autonomous loop mode. Follow `./pipeline/loop-protocol.md`: decompose task into units, initialize loop state, start cron, execute ticks. Each tick runs the appropriate OPC flow for that unit type.
- `/opc <role> [role...]` without a task = review of current codebase using quick-review flow with named roles.
- `/opc` with no arguments = prompt user to describe their task.
- If task matches multiple rows, prefer the flow that includes build — code changes must precede review.

Show triage result:
```
📌 Flow: {flow template name}
📍 Entry: {entry node}
⚡ Interaction: auto / interactive
Rationale: {1 sentence}
```

**Override:** If user explicitly names a task type, respect that. Users can adjust after seeing triage.

## Flow Templates

Flow graph structures (nodes, edges, limits) are defined in `opc-harness` code. The orchestrator uses `opc-harness route` to determine next nodes — **do not look up edges yourself**.

Each template below describes which agents to dispatch at each node and which protocol to use.

### legacy-linear

Equivalent to v0.4.x behavior. Used as internal fallback only.

| Node | Type | Agents | Protocol |
|------|------|--------|----------|
| design | discussion | [planner] | design exploration |
| plan | build | [planner] | task decomposition |
| build | build | [implementer] | implementer-prompt.md |
| evaluate | review | [selected roles] | role-evaluator-prompt.md |
| deliver | build | — | commit + report |

### quick-review

| Node | Type | Agents | Protocol |
|------|------|--------|----------|
| code-review | review | [selected roles] | role-evaluator-prompt.md |
| gate | gate | — | gate-protocol.md |

### build-verify

| Node | Type | Agents | Protocol |
|------|------|--------|----------|
| build | build | [implementer] | implementer-prompt.md |
| code-review | review | [selected roles] | role-evaluator-prompt.md |
| test-verify | execute | [tester] | executor-protocol.md |
| gate | gate | — | gate-protocol.md |

### full-stack

The complete flow with discussion, multi-stage gates, and E2E verification.

| Node | Type | Agents | Protocol |
|------|------|--------|----------|
| discuss | discussion | [architect, engineer, tester] | discussion-protocol.md |
| build | build | [implementer] | implementer-prompt.md |
| code-review | review | [frontend, backend] | role-evaluator-prompt.md |
| test-verify | execute | [tester] | executor-protocol.md |
| gate-test | gate | — | gate-protocol.md |
| acceptance | review | [pm, designer] | role-evaluator-prompt.md |
| gate-acceptance | gate | — | gate-protocol.md |
| audit | review | [security, compliance, a11y] | role-evaluator-prompt.md |
| gate-audit | gate | — | gate-protocol.md |
| e2e-user | execute | [new-user, active-user, churned-user] | executor-protocol.md |
| gate-e2e | gate | — | gate-protocol.md |
| post-launch-sim | execute | [user-simulator] | executor-protocol.md |
| gate-final | gate | — | gate-protocol.md |

### pre-release

| Node | Type | Agents | Protocol |
|------|------|--------|----------|
| acceptance | review | [pm, designer] | role-evaluator-prompt.md |
| gate-acceptance | gate | — | gate-protocol.md |
| audit | review | [security, compliance, a11y] | role-evaluator-prompt.md |
| gate-audit | gate | — | gate-protocol.md |
| e2e-user | execute | [new-user, active-user, churned-user] | executor-protocol.md |
| gate-e2e | gate | — | gate-protocol.md |

---

## Getting Started

**Before task inference**, check for existing state:
1. If `.harness/flow-state.json` exists → resume from recorded state. Run `opc-harness validate-chain --dir .harness` first. Show user what was saved and confirm before continuing.
2. If `.harness/` has `wave-*` files but no `flow-state.json` → **legacy v0.4.x format detected**. Print: "Detected v0.4.x .harness/ format. Please delete .harness/ and re-run, or manually migrate." Do not proceed.
3. Otherwise → fresh start.

After flow selection, initialize:

```bash
opc-harness init --flow {TEMPLATE} --entry {ENTRY_NODE} --dir .harness
```

**Show flow graph** — immediately after init, run `opc-harness viz --flow {TEMPLATE} --dir .harness` and display the ASCII output to the user. This gives them a visual map of the entire flow before execution begins.

Before starting, extract **acceptance criteria** — 3-7 concrete, testable bullet points. Evaluators grade against these.

### Definition of Done — Mandatory Pre-Flight (all modes)

Before dispatching ANY work, the orchestrator MUST establish a clear definition of done. This applies to **both auto and interactive modes** — the only difference is how the answers are obtained (inferred vs asked).

**Three questions that must have answers before the first node executes:**

1. **What does "done" look like?** — Concrete, observable outcomes. Not "implement auth" but "user can log in with email/password, session persists across refresh, logout clears session."

2. **How will we verify it?** — Map each outcome to a verification method:
   - Code change → which tests? (`npm test`, specific test file, new test to write?)
   - UI change → which page/component to screenshot? What should be visible?
   - API change → which endpoint to curl? What response shape?
   - Refactor → which existing tests must still pass?

3. **How will we evaluate quality?** — What should reviewers look for beyond "it works"?
   - Performance constraints? ("page load < 2s")
   - Security concerns? ("no PII in logs")
   - Compatibility? ("works in Safari")
   - Edge cases? ("handles empty input, 10k items, unicode")

**In auto mode**: infer answers from the task description + codebase context (package.json scripts, existing tests, CLAUDE.md rules). Show inferred answers to user for confirmation. If task is too vague to infer concrete verification methods → **ask, even in auto mode.** A vague task is worse than a 30-second clarification.

**In interactive mode (`-i`)**: ask directly, grouped with role-specific questions.

**In loop mode (`/opc loop`)**: these answers go into `plan.md` per unit, so every tick knows how to verify itself even after context compaction.

Write the finalized acceptance criteria to `.harness/acceptance-criteria.md` and include them in every subagent prompt.

### Interactive Mode Details (with `-i`)

Ask targeted questions derived from selected roles — what does each role need that can't be inferred from the codebase? Aim for 3-5 grouped questions, merged with the Definition of Done questions above.

- Engineering roles usually read code directly — no extra context needed.
- Product and user roles benefit most: "Who are your target users?", "What's the product stage?"
- Security and Compliance may need: "Do you handle PII?", "Target markets?"

**Persona construction** for user roles: In auto mode, infer from project context. In interactive mode, ask directly.

### Project Context

Subagents don't inherit CLAUDE.md or project instructions automatically. When dispatching any subagent, **forward relevant project context**: dev workflow rules, precommit checks, coding conventions, test commands. Include this in every subagent prompt.

### Superpowers Integration

If `superpowers` skills are available, use them: brainstorming for design, plan writing, subagent-driven development for build, and branch delivery.

---

## Built-in Roles

```
Product:     pm, designer
User Lens:   new-user, active-user, churned-user
Engineering: frontend, backend, devops, architect, engineer
Quality:     security, tester, compliance, a11y
Specialist:  planner, user-simulator, devil-advocate
```

Role definitions live in `roles/<name>.md`. Add a `.md` file to `roles/` to create a custom role.

### Role Selection

1. **Tag filter** — from the flow template, you know the node type. Map to stage tags:

| Node type | Stage tags |
|-----------|-----------|
| review | review |
| build | build |
| execute | execute, post-release |
| discussion | brainstorm, plan, discussion |
| gate | (no roles dispatched) |

   Read the `tags:` front matter from each `roles/<name>.md`. Keep only roles whose tags include at least one matching stage tag.

2. **Select from filtered pool** — pick 2-5 roles with distinct angles. Read each candidate's "When to Include" section to decide relevance.

- Each dispatched agent must have a DISTINCT angle. If two would produce 80%+ overlapping output, pick one.
- Not every task needs every role. A CSS fix doesn't need Security.
- **Devil's Advocate auto-inclusion:** When a discussion node reaches Round 2 with near-unanimous agreement (all agents converge on the same approach), the orchestrator SHOULD include devil-advocate in a subsequent review pass. Consensus is a signal to challenge, not to proceed. For irreversible decisions (data deletion, public API contracts, destructive migrations), devil-advocate is MANDATORY.
- If user specified roles explicitly, use those — skip tag filtering entirely.

**Dynamic Role Creation:** If the task requires expertise not covered by any candidate, create a role on-the-fly following the same format (Identity + Expertise + When to Include + Anti-Patterns). Write to `.harness/nodes/{nodeId}/dynamic-role-{name}.md`. Max 5 dynamic roles per flow run.

Show role selection:
```
📋 Agents:
- frontend — <specific scope>
- security — <specific scope>
...

Launching {N} agents...
```

---

## Node Execution

The orchestrator uses **cursor-based execution** — `flow-state.json.currentNode` is the single pointer. No topological sort.

### Execution Loop

```
1. Read flow-state.json → currentNode
2. Look up currentNode in the flow template table above → get type, agents, protocol
3. Execute based on node type (see below)
4. After execution:
   - opc-harness validate → check handshake.json
   - Update progress.md with narrative line
   - opc-harness route --node {current} --verdict PASS --flow {template} → get next
   - opc-harness transition --from {current} --to {next} --verdict PASS --flow {template} --dir .harness
   - **Show flow viz**: run `opc-harness viz --flow {template} --dir .harness` and display to user
   - Loop back to step 1
5. When route returns next=null → flow complete → Deliver → **Prompt replay** (see below)
```

### Node Type: discussion

Follow `./pipeline/discussion-protocol.md`.

1. Dispatch agents serially for 3 rounds (Round 1: independent, Round 2: diffs only, Round 3: facilitator convergence).
2. **Orchestrator writes handshake.json** after collecting all artifacts (agents don't write it).
3. Discussion nodes produce no verdict — the decision artifact feeds downstream.

### Node Type: build

Follow `./pipeline/implementer-prompt.md` in Build/Fix/Polish mode.

1. Dispatch implementer subagent.
2. **Single agent** → agent writes its own handshake.json.
3. **Multiple agents** (parallel, with `isolation: "worktree"`) → orchestrator merges artifacts and writes handshake.json.
4. With superpowers: invoke `superpowers:subagent-driven-development`.

### Node Type: review

Follow `./pipeline/role-evaluator-prompt.md`.

1. Select roles per Role Selection rules.
2. Dispatch evaluators — parallel if no dependencies, serial with context injection if dependencies exist.
3. Each agent writes `eval-{role}.md` to `.harness/nodes/{NODE_ID}/run_{RUN}/`.
4. **Orchestrator writes handshake.json** after all agents return, merging all eval files into artifacts[].
5. Before dispatching, build context brief using `./pipeline/context-brief.md` (for review/analysis tasks).

**Critical — Review Independence:**
- Review MUST use independent subagents (Agent tool), never the orchestrator reviewing its own build output.
- In loop mode, review MUST be a separate tick/unit from implementation. Never combine build + review in one tick.
- The orchestrator MUST NOT filter, downgrade, or dismiss findings before writing the handshake. All findings pass through to the gate.

### Node Type: execute

Follow `./pipeline/executor-protocol.md`.

**Executor nodes are executed by the orchestrator directly — not as a subagent.** This is because executors need full tool access (Bash, Playwright, Skills).

1. Smoke test tool availability.
2. Execute acceptance criteria scenarios.
3. Capture evidence (CLI output, screenshots).
4. **Orchestrator writes handshake.json** with evidence artifacts.
5. Handshake validation enforces: execute nodes must have evidence artifacts.

### Node Type: gate

Follow `./pipeline/gate-protocol.md`.

**Gate nodes are executed by the orchestrator directly — no subagent dispatch.**

1. `opc-harness synthesize .harness --node {upstream}` → get verdict.
2. Mechanical validation (severity emojis, file refs, fix suggestions).
3. `opc-harness route --node {gate} --verdict {V} --flow {template}` → get next node.
4. `opc-harness transition --from {gate} --to {next} --verdict {V} --flow {template} --dir .harness` → validates edge, writes gate handshake, updates state.
5. Notify user: pass/loopback/done/blocked.

---

## Verdict & Loopback

Gate nodes produce verdicts via `opc-harness synthesize` (code, not LLM judgment):
- Any 🔴 → FAIL
- Any 🟡 → ITERATE
- All 🔵/LGTM → PASS
- Any BLOCKED → BLOCKED

**Code enforces all limits:**
- `maxLoopsPerEdge` = 3 (same edge can't be traversed more than 3 times)
- `maxTotalSteps` = 20-30 (depending on flow template)
- `maxNodeReentry` = 5 (same node can't be entered more than 5 times)

**Oscillation detection:** After a loopback, run `opc-harness diff` on consecutive evaluations. If `oscillation: true`, surface to user.

**Escape hatches:**
- `/opc skip` — skip current node, advance via PASS edge
- `/opc pass` — force gate to PASS
- `/opc stop` — terminate flow, preserve state
- `/opc goto <nodeId>` — manual jump (cycle limits still enforced via `transition`)

When transition returns `allowed: false` → show the user why (which limit hit) and offer escape options. Never continue without user consent.

---

## File-Based State

```
.harness/
├── flow-state.json              # Current node, execution history, edge counts, limits
├── progress.md                  # Human-readable narrative log
└── nodes/
    └── {nodeId}/
        ├── handshake.json       # Machine-readable envelope (summary + verdict + artifact paths)
        └── run_{N}/
            ├── eval.md          # Single evaluator output (detailed findings)
            ├── eval-{role}.md   # Per-role evaluator output (multi-role)
            ├── round-1-{role}.md # Discussion round 1
            ├── round-2-{role}.md # Discussion round 2 (diffs only)
            ├── decision.md      # Discussion facilitator decision
            ├── screenshot-{N}.png  # Executor GUI evidence
            └── command-output-{N}.txt  # Executor CLI evidence
```

**Relationships:**
- `handshake.json` = envelope. Its `artifacts[]` points to detailed files (eval.md, screenshots, etc.)
- `flow-state.json` = sole source of truth for execution position and history
- `eval.md` / `eval-{role}.md` = human-readable findings (read by `synthesize` to compute verdict)
- `progress.md` = narrative projection of flow execution (for humans)

---

## Prompt Templates

All templates live in `./pipeline/`:

- `evaluator-prompt.md` — Single generic evaluator
- `role-evaluator-prompt.md` — Role-specific evaluator (review, analysis, brainstorm outputs)
- `implementer-prompt.md` — Implementer (Build / Fix / Polish modes)
- `discussion-protocol.md` — Multi-agent discussion (round-robin, 3 rounds, facilitator)
- `gate-protocol.md` — Verdict aggregation + code-based routing + transition + **findings disposition**
- `executor-protocol.md` — CLI/GUI execution with evidence requirements
- `loop-protocol.md` — **Autonomous multi-unit execution** (plan decomposition → cron loop → auto-terminate)
- `handoff-template.md` — Handshake.json specification
- `context-brief.md` — Design context brief procedure
- `report-format.md` — Presentation templates + JSON schema + replay

---

## Resilience

**Agent spawn failures:** Retry once. If it fails again, surface to user.

**Context running low:** Write current state to `.harness/flow-state.json` (already maintained by transition commands). The flow-state.json + handshake files carry all state needed to resume. Tell user to re-invoke — orchestrator will detect flow-state.json and resume.

**State recovery:** On resume, run `opc-harness validate-chain --dir .harness`. If inconsistent → surface to user, do not auto-repair.

**Legacy detection:** If `.harness/` has `wave-*` files but no `flow-state.json` → refuse to run. Print migration instructions.

**Fresh context per agent.** Always spawn new subagents. Files carry state; agents bring fresh capacity.

---

## Flow Completion & Replay

When the flow completes (route returns `next=null`):

1. Show final viz: `opc-harness viz --flow {template} --dir .harness`
2. Show summary: total steps, nodes visited, any loopbacks
3. **Prompt the user:**
   ```
   ✅ Flow complete! Want to see the replay?
   Run: /opc replay
   ```
   This opens the HTML Flow Replay viewer with animated playback of the entire execution.
