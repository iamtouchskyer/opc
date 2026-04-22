---
name: opc
version: 0.10.0
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
/opc stop                # terminate flow, preserve session state
/opc goto <nodeId>       # manual jump to a node (cycle limits still enforced)
```

## Task Inference + Flow Selection

The orchestrator reads the task, selects a flow template, and determines the entry point.

| Task says... | Flow template | Default entry |
|---|---|---|
| "review", "audit", "check", "before we merge", "找问题", "开源前看看" | review | review |
| "analyze", "diagnose", "what's wrong with", "分析" | review | review |
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
| Code/artifact that needs evaluation | review, code-review, or test-design (if ∈ template) |
| Everything done, needs acceptance | acceptance (if ∈ template) |

**Priority rules:**
- `/opc loop <task>` = enter autonomous loop mode. Follow `./pipeline/loop-protocol.md`: first check `.opc/runbooks/` for a matching runbook, otherwise decompose task into units. Initialize loop state, start cron, execute ticks. Each tick runs the appropriate OPC flow for that unit type.
- `/opc <role> [role...]` without a task = review of current codebase using review flow with named roles.
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

### review

| Node | Type | Agents | Protocol |
|------|------|--------|----------|
| review | review | [selected roles] | role-evaluator-prompt.md |
| gate | gate | — | gate-protocol.md |

Gate loopback: FAIL/ITERATE → review (multi-round with prior findings as context). Review is not limited to code — it evaluates any artifact: architecture proposals, documents, strategies, products.

### build-verify

| Node | Type | Agents | Protocol |
|------|------|--------|----------|
| build | build | [implementer] | implementer-prompt.md |
| code-review | review | [selected roles] | role-evaluator-prompt.md |
| test-design | review | [tester, + user/domain roles] | test-design-protocol.md |
| test-execute | execute | [orchestrator] | executor-protocol.md |
| gate | gate | — | gate-protocol.md |

**test-design** is a review node where multiple roles design test cases (API tests, E2E UI tests, edge cases) without executing them. **test-execute** runs the designed test plan and captures evidence. Principle: *the person who decides what to test must not be the person who runs the tests.*

### full-stack

The complete flow with discussion, multi-stage gates, and E2E verification.

| Node | Type | Agents | Protocol |
|------|------|--------|----------|
| discuss | discussion | [architect, engineer, tester] | discussion-protocol.md |
| build | build | [implementer] | implementer-prompt.md |
| code-review | review | [frontend, backend] | role-evaluator-prompt.md |
| test-design | review | [tester, + user/domain roles] | test-design-protocol.md |
| test-execute | execute | [orchestrator] | executor-protocol.md |
| gate-test | gate | — | gate-protocol.md |
| acceptance | review | [pm, designer] | role-evaluator-prompt.md |
| gate-acceptance | gate | — | gate-protocol.md |
| audit | review | [security, compliance, a11y] | role-evaluator-prompt.md |
| gate-audit | gate | — | gate-protocol.md |
| e2e-user | execute | [new-user, active-user, churned-user] | executor-protocol.md |
| gate-e2e | gate | — | gate-protocol.md |
| ux-simulation | execute | [new-user, active-user, churned-user] | ux-simulation-protocol.md + ux-observer-protocol.md |
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
1. Run `opc-harness ls` to discover active flows. If any exist for the current project, show them and ask whether to resume or start fresh.
2. If `.harness/` has `wave-*` files but no `flow-state.json` → **legacy v0.4.x format detected**. Print: "Detected v0.4.x .harness/ format. Please delete .harness/ and re-run, or manually migrate." Do not proceed.
3. Otherwise → fresh start.

After flow selection, initialize:

```bash
opc-harness init --flow {TEMPLATE} --entry {ENTRY_NODE}
```

Init auto-creates `~/.opc/sessions/{project-hash}/{session-id}/` and updates the `latest` symlink. **All subsequent harness commands automatically resolve to the latest session dir** — you do NOT need to pass `--dir` or capture the output. Just run commands normally:

```bash
opc-harness route --node review --verdict PASS --flow {TEMPLATE}
opc-harness transition --from review --to gate --verdict PASS --flow {TEMPLATE}
opc-harness viz --flow {TEMPLATE}
```

**Multi-window safety:** Each `init` creates a new session dir. If multiple OPC windows run on the same project, the last one to `init` becomes `latest`. To pin a specific session, pass `--dir <path>` explicitly.

**Backward compat:** Pass `--dir .harness` to init for a project-local harness dir.

**Show flow graph** — immediately after init, run `opc-harness viz --flow {TEMPLATE}` and display the ASCII output to the user. This gives them a visual map of the entire flow before execution begins.

Before starting, extract **acceptance criteria** — 3-7 concrete, testable bullet points. Evaluators grade against these.

### Quality Tier Selection — Mandatory Pre-Flight

Before the Definition of Done questions, the orchestrator MUST select a **quality tier**. See `./pipeline/quality-tiers.md` for full definitions.

| Tier | When | Baseline |
|------|------|----------|
| `functional` | CLI, API, backend, library, infra | No UI craft requirements |
| `polished` | UI, frontend, website, dashboard, docs | Dark/light, responsive, loading/error/empty states, favicon, focus styles |
| `delightful` | Showcase, demo, pitch, consumer product | All of polished + transitions, animations, micro-interactions, onboarding |

**Selection rules:**
1. User explicitly specifies tier → use it
2. Task involves UI/frontend → default `polished`
3. Task is CLI/API/backend → default `functional`
4. Task includes "showcase", "demo", "pitch", "delightful", "beautiful" → `delightful`
5. Interactive mode → ask the user

Show tier selection:
```
🎯 Quality Tier: {tier}
   Baseline: {N items from tier checklist}
```

The tier's baseline checklist items are **automatically appended** to acceptance criteria under a "## Quality Baseline ({tier})" section in `acceptance-criteria.md` (in the session dir). The implementer and evaluator both receive the tier as context.

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

Write the finalized acceptance criteria to `acceptance-criteria.md` (in the session dir) and include them in every subagent prompt.

**Criteria Lint — Mandatory Gate:** After writing `acceptance-criteria.md`, run `opc-harness criteria-lint acceptance-criteria.md` (use the session dir path). If it fails, revise and re-run (max 3 auto-fix attempts in auto mode, user-driven in interactive mode). See `./pipeline/criteria-lint.md` for the mechanical checks. Init is gated — `opc-harness init` refuses to start if criteria-lint hasn't passed.

### Task Scope — Mandatory for Loop Mode

In loop mode, every `plan.md` MUST include a `## Task Scope` section listing the user's original requirements:

```markdown
## Task Scope
- SCOPE-1: Backend API for user auth
- SCOPE-2: Frontend login page with form validation
- SCOPE-3: Browser E2E tests covering login flow
- SCOPE-4: Unit tests with 100% coverage on new code
```

The harness enforces this mechanically:
- **init-loop** refuses to start if `## Task Scope` is missing (bypass: `--skip-scope`)
- **complete-tick** on the final tick checks that every SCOPE-N item was covered by at least one completed unit (keyword overlap or explicit reference). Uncovered items = hard error, pipeline cannot complete (bypass: `--skip-scope-check`)
- **next-tick** termination output includes `uncovered_scope` if any items lack coverage

This prevents the #1 failure mode: LLM decomposition misses part of the original task, pipeline declares "complete" while major scope items are untouched.

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

### Role Discovery

The orchestrator searches for role definitions in this order (later sources override earlier ones with the same filename):

1. **Built-in roles** — `roles/<name>.md` in OPC's install directory
2. **Flow template roles** — if the active flow template specifies `rolesDir`, scan `_resolvedRolesDir/<name>.md`. Custom roles with the same name as a built-in one take precedence for this flow.
3. **Dynamic roles** — created on-the-fly during execution (see below)

**How to check for custom roles:** After `opc-harness init`, if the flow template was loaded from `~/.claude/flows/`, check `FLOW_TEMPLATES[template]._resolvedRolesDir`. If it exists and is a directory, scan it for `.md` files and merge into the role pool.

**Protocol discovery** works the same way: if the flow template specifies `protocolDir`, protocols in `_resolvedProtocolDir/<name>.md` supplement or override built-in protocols in `pipeline/`.

### Role Selection

1. **Tag filter** — from the flow template, you know the node type. Map to stage tags:

| Node type | Stage tags |
|-----------|-----------|
| review | review |
| build | build |
| execute | execute, post-release, verification |
| discussion | brainstorm, plan, discussion |
| gate | (no roles dispatched) |

   Read the `tags:` front matter from each `roles/<name>.md`. Keep only roles whose tags include at least one matching stage tag.

2. **Select from filtered pool** — pick 2-5 roles with distinct angles. Read each candidate's "When to Include" section to decide relevance.

- Each dispatched agent must have a DISTINCT angle. If two would produce 80%+ overlapping output, pick one.
- Not every task needs every role. A CSS fix doesn't need Security.
- **Devil's Advocate auto-inclusion:** When a discussion node reaches Round 2 with near-unanimous agreement (all agents converge on the same approach), the orchestrator SHOULD include devil-advocate in a subsequent review pass. Consensus is a signal to challenge, not to proceed. For irreversible decisions (data deletion, public API contracts, destructive migrations), devil-advocate is MANDATORY.
- If user specified roles explicitly, use those — skip tag filtering entirely.

**Dynamic Role Creation:** If the task requires expertise not covered by any candidate, create a role on-the-fly following the same format (Identity + Expertise + When to Include + Anti-Patterns). Write to `$SESSION_DIR/nodes/{nodeId}/dynamic-role-{name}.md`. Max 5 dynamic roles per flow run.

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

**Auto mode = no pause.** In auto mode, the orchestrator MUST NOT pause to ask "should I continue?", "this will take a while", or "want to stop here?". The only acceptable reasons to stop are:
- Escape hatch triggered (cycle limit hit, stall detected, blocked transition)
- Tool failure after retry
- Context critically low (write state to disk, tell user to re-invoke)

Anything else = keep executing. The user chose auto mode precisely because they don't want interruptions. If the pipeline has 14 nodes, run all 14 nodes. Do not ask permission at node 4.

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
   - opc-harness transition --from {current} --to {next} --verdict PASS --flow {template}
   - **Show flow viz**: run `opc-harness viz --flow {template}` and display to user
   - Loop back to step 1
5. When route returns next=null → flow complete → Deliver → **Prompt replay** (see below)
```

### Node Type: discussion

Follow `./pipeline/discussion-protocol.md`.

1. Dispatch agents for 3 rounds. **Round 1: parallel** (agents are independent — no reason to serialize). Round 2: serial with context injection (each agent sees Round 1 outputs, writes diffs only). Round 3: facilitator convergence.
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
3. Each agent writes `eval-{role}.md` to `$SESSION_DIR/nodes/{NODE_ID}/run_{RUN}/`.
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

1. `opc-harness synthesize --node {upstream}` → get verdict.
2. Mechanical validation (severity emojis, file refs, fix suggestions).
3. `opc-harness route --node {gate} --verdict {V} --flow {template}` → get next node.
4. `opc-harness transition --from {gate} --to {next} --verdict {V} --flow {template}` → validates edge, writes gate handshake, updates state.
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
$SESSION_DIR/                    # ~/.opc/sessions/{hash}/{id}/ or .harness/ if --dir used
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
- `test-design-protocol.md` — **Test case design** (review node, multi-role test planning before execution)
- `loop-protocol.md` — **Autonomous multi-unit execution** (plan decomposition → cron loop → auto-terminate)
- `handoff-template.md` — Handshake.json specification
- `context-brief.md` — Design context brief procedure
- `report-format.md` — Presentation templates + JSON schema + replay
- `quality-tiers.md` — Tier definitions + baseline checklists + severity calibration
- `ux-simulation-protocol.md` — **UX simulation gate** (red flag detection, delta comparison, ordinal tier fit)
- `ux-observer-protocol.md` — **UX observer dispatch** (persona-based pattern observation, closed enum red flags)
- `criteria-lint.md` — **DoD mechanical lint** (single-pass structure + content checks, pre-init gate)

---

## External Flow Templates

Custom flows can be defined as JSON files in `~/.claude/flows/`. The harness loads them at startup and merges them into the template registry. Built-in templates take precedence (external cannot override).

**JSON schema:**
```json
{
  "nodes": ["discover", "build", "review", "gate"],
  "edges": {
    "discover": { "PASS": "build" },
    "build":    { "PASS": "review" },
    "review":   { "PASS": "gate" },
    "gate":     { "PASS": null, "FAIL": "build", "ITERATE": "build" }
  },
  "limits": { "maxLoopsPerEdge": 3, "maxTotalSteps": 20, "maxNodeReentry": 5 },
  "nodeTypes": {
    "discover": "discussion", "build": "build",
    "review": "review", "gate": "gate"
  },
  "softEvidence": true,
  "opc_compat": ">=0.5",
  "contextSchema": {
    "build": {
      "required": ["task"],
      "rules": { "task": "non-empty-string" }
    }
  }
}
```

**Validation rules:**
- `nodes`, `edges`, `limits` are required
- All edge sources and targets must be in `nodes`
- `nodeTypes` values must be: `discussion`, `build`, `review`, `execute`, `gate`
- `opc_compat` uses `>=X.Y` semver range (current harness: 0.9.0)
- Prototype pollution names (`__proto__`, `constructor`, `prototype`) are rejected

**Optional fields:**
- `softEvidence: true` — downgrades missing-evidence errors to warnings for execute nodes
- `contextSchema` — per-node validation rules for `flow-context.json`
- `opc_compat` — minimum harness version required

**contextSchema rules:**
- `non-empty-string` — must be a non-empty string
- `non-empty-array` — must be a non-empty array
- `non-empty-object` — must be a non-empty plain object (not array)
- `positive-integer` — must be a positive integer > 0

---

## Harness Command Reference

All commands output JSON to stdout. Errors go to stderr. All output is machine-parseable.

### Flow Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `init` | `--flow <tpl> [--entry <node>] [--dir <p>]` | Initialize flow state. Creates `flow-state.json` and node directories. |
| `route` | `--node <id> --verdict <V> --flow <tpl>` | Get next node from graph edges. Returns `{next, allowed}`. |
| `transition` | `--from <n> --to <n> --verdict <V> --flow <tpl> --dir <p>` | Execute state transition. Validates edge, checks limits, writes gate handshake, enforces backlog. |
| `validate` | `<handshake.json>` | Validate handshake schema (required fields, evidence check for execute nodes). |
| `validate-chain` | `[--dir <p>]` | Validate entire execution path — checks all handshakes match history. |
| `validate-context` | `--flow <tpl> --node <id> [--dir <p>]` | Validate `flow-context.json` against contextSchema rules. |
| `finalize` | `[--dir <p>] [--strict]` | Finalize terminal node. Marks flow as completed. |
| `viz` | `--flow <tpl> [--dir <p>] [--json]` | Visualize flow graph (ASCII or JSON). Shows ▶ current, ✅ visited, ○ pending. |
| `replay` | `[--dir <p>]` | Export full replay data as JSON (flow state + handshakes + run artifacts). |

### Escape Hatches

| Command | Usage | Description |
|---------|-------|-------------|
| `skip` | `[--dir <p>] [--flow <tpl>]` | Skip current node, advance via PASS edge. Writes skip handshake. |
| `pass` | `[--dir <p>]` | Force-pass current gate node. Only works on gate-type nodes. |
| `stop` | `[--dir <p>]` | Terminate flow, preserve state. Sets status to "stopped". |
| `goto` | `<nodeId> [--dir <p>]` | Manual jump to any node. Cycle limits still enforced. |
| `ls` | `[--base <p>]` | List all active flows (scans `~/.opc/sessions/` and project-local `.harness*` directories). |

### Eval Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `verify` | `<file>` | Parse evaluation markdown → JSON (severity counts, verdict, findings). |
| `synthesize` | `<dir> --node <id> [--run N] [--base <dir>] [--no-strict] [--iteration N]` | Merge all evaluations for a node → aggregate verdict. D2 compound gate enforced by default (≥3 layers → FAIL); `--no-strict` for shadow mode. `--base` validates file:line refs. |
| `report` | `<dir> --mode <m> --task <t>` | Generate full report JSON with presentation data. |
| `diff` | `<file1> <file2>` | Compare two evaluation rounds. Detects oscillation. |

### Loop Commands (Layer 2 — Zero Trust)

| Command | Usage | Description |
|---------|-------|-------------|
| `init-loop` | `[--plan <file>] [--dir <p>]` | Initialize loop state from plan.md. Validates plan structure, detects test/lint scripts. |
| `complete-tick` | `--unit <id> --artifacts <a,b> [--description <text>] [--dir <p>]` | Complete tick with evidence. Validates artifacts per unit type, checks plan hash, overlap detection. |
| `next-tick` | `[--dir <p>]` | Get next unit. Checks stall/oscillation, returns `{ready, unit, terminate}`. |

### Transition Details

The `transition` command enforces:
- **Edge validation** — only declared edges are allowed
- **Cycle limits** — `maxLoopsPerEdge`, `maxTotalSteps`, `maxNodeReentry`
- **Idempotency** — repeated identical transitions are silently accepted
- **Gate detection** — uses `nodeTypes[from] === "gate"` (not name prefix)
- **Pre-transition validation** — upstream handshake must exist and be valid
- **Backlog enforcement** — if upstream has warnings, `backlog.md` must exist for FAIL/ITERATE transitions

---

## Resilience

**Agent spawn failures:** Retry once. If it fails again, surface to user.

**Context running low:** Write current state to `$SESSION_DIR/flow-state.json` (already maintained by transition commands). The flow-state.json + handshake files carry all state needed to resume. Tell user to re-invoke — orchestrator will detect flow-state.json and resume.

**State recovery:** On resume, run `opc-harness validate-chain`. If inconsistent → surface to user, do not auto-repair.

**Legacy detection:** If `.harness/` in project root has `wave-*` files but no `flow-state.json` → refuse to run. Print migration instructions.

**Fresh context per agent.** Always spawn new subagents. Files carry state; agents bring fresh capacity.

---

## Flow Completion & Replay

When the flow completes (route returns `next=null`):

1. Show final viz: `opc-harness viz --flow {template}`
2. Show summary: total steps, nodes visited, any loopbacks
3. **Generate HTML report** (use the session dir from init output, or find it via `opc-harness ls`):
   ```bash
   node "$OPC_HARNESS/../opc-report.mjs" --dir <session-dir> --output <session-dir>/report.html --title "{task summary}"
   ```
   This produces a self-contained dark-theme HTML report with mechanically parsed stats, pipeline visualization, findings tables, and R2 fix tracking. Open it for the user.
4. **Prompt the user:**
   ```
   ✅ Flow complete! Report: $SESSION_DIR/report.html
   Want to see the replay? Run: /opc replay
   ```
