# Loop Protocol — Autonomous Multi-Unit Execution

OPC flows handle single build→review→gate cycles. This protocol sits **above** flows, orchestrating multi-unit feature delivery across sessions.

## When to Use

Use the loop protocol when:
- A task requires multiple independent units of work (e.g., a feature with spec, backend, frontend, tests)
- The user says "build this feature", "implement F1-F4", or gives a multi-step backlog
- The task will take more than one flow cycle to complete
- The user explicitly requests autonomous/loop/24-hour execution

Do NOT use for single-cycle tasks (a code review, a single bug fix, a brainstorm).

## State Machine

```
┌─────────────────────────────────────────────────────┐
│                    LOOP STATE                        │
│                                                      │
│  plan.md ──→ decompose ──→ loop-state.json          │
│                               │                      │
│              ┌────────────────┤                      │
│              ▼                │                      │
│         ┌─────────┐    ┌─────┴─────┐                │
│         │  TICK N  │───▶│  TICK N+1 │───▶ ...       │
│         └─────────┘    └───────────┘                │
│              │                                       │
│         Each tick runs one OPC flow                  │
│         (build-verify, quick-review, etc.)           │
│                                                      │
│              ▼                                       │
│         next_unit = null ──→ AUTO-TERMINATE          │
└─────────────────────────────────────────────────────┘
```

## Procedure

### Step 1 — Plan Decomposition

Given a task or feature backlog, decompose into **atomic units**. Each unit is one OPC flow invocation.

Rules for decomposition:
- **Implement and review are SEPARATE units.** Never combine build + review in one tick. The builder's context pollutes the reviewer's judgment.
- **Each unit has verifiable output.** Tests pass, screenshots captured, API responds correctly.
- **Each unit has one commit.** Atomic commits enable git bisect.

Standard unit sequence for a feature:

```
{F}.1  spec          — acceptance criteria, API contract, data model
{F}.2  implement-a   — backend / core logic
{F}.3  review-a      — independent subagent review of {F}.2
{F}.4  fix-a         — address 🔴 and 🟡 findings from review
{F}.5  implement-b   — frontend / UI
{F}.6  review-b      — independent subagent review of {F}.5
{F}.7  fix-b         — address findings
{F}.8  e2e-verify    — end-to-end user path verification
{F}.9  accept        — final acceptance against spec criteria
```

Adjust based on feature complexity:
- Simple feature (single-file fix): skip spec, merge implement+review into 2-3 units
- Complex feature (new subsystem): add design unit between spec and implement
- Pure backend: skip implement-b/review-b/fix-b

Write the plan to `.harness/plan.md` with unit numbers, descriptions, and acceptance criteria per unit.

### Step 2 — Initialize Loop State

Write `.harness/loop-state.json`:

```json
{
  "tick": 0,
  "unit": null,
  "description": "Loop initialized",
  "status": "initialized",
  "artifacts": [],
  "next_unit": "{first unit id}",
  "blockers": [],
  "review_of_previous": "",
  "plan_file": ".harness/plan.md"
}
```

### Step 3 — Start Loop

Use CronCreate to schedule the tick prompt:

```
cron: "*/10 * * * *"   (every 10 minutes, or user-specified interval)
prompt: <the tick execution prompt — see Tick Prompt below>
recurring: true
durable: true          (MANDATORY for autonomous runs — survives process restart)
```

Then immediately execute the first tick (don't wait for cron).

### Step 4 — Tick Execution

Each tick follows this sequence:

```
1. Read loop-state.json → get next_unit
2. Read plan.md → get unit details and acceptance criteria
3. Review previous tick's output (review_of_previous)
4. If previous tick has unfixed issues → fix first, then proceed
5. Determine unit type → select OPC flow template:
   - spec/design units      → discussion protocol (no flow, direct execution)
   - implement units        → build-verify flow OR direct implementation
   - review units           → quick-review flow with independent subagents
   - fix units              → direct implementation targeting review findings
   - e2e-verify units       → executor-protocol (orchestrator runs directly)
   - accept units           → pre-release flow
6. Execute the flow
7. Verify output:
   - Tests pass (pytest, vitest, etc.)
   - Build succeeds (vite build, cargo build, etc.)
   - UI changes → screenshot verification (MANDATORY, not optional)
   - API changes → curl/httpie verification
8. Git commit (atomic, one per unit)
9. Write updated loop-state.json (see format below)
```

### Step 5 — Verification Gate (per tick)

**Every tick MUST produce verification evidence.** This is not optional.

| Unit type | Required evidence |
|-----------|------------------|
| implement | Tests pass + build clean |
| implement (with UI) | Tests pass + build clean + screenshot |
| review | eval-{role}.md files with 🔴/🟡/🔵 severity |
| fix | Tests still pass + specific findings addressed |
| e2e-verify | Playwright/curl output showing user path works |
| accept | All acceptance criteria checked off with evidence |

If evidence cannot be produced (tool unavailable, test infra broken):
- Write `status: "blocked"` in loop-state.json
- Write `blockers: ["description of what's missing"]`
- Skip to next unblocked unit (if any)
- Do NOT mark as completed without evidence

### Step 6 — Loop State Update

After each tick, write:

```json
{
  "tick": N,
  "unit": "{completed unit id}",
  "description": "{what was done, concisely}",
  "status": "completed",
  "artifacts": ["{file paths or test output references}"],
  "next_unit": "{next unit id, or null if done}",
  "blockers": [],
  "review_of_previous": "{assessment of previous tick's quality}"
}
```

### Step 7 — Auto-Termination

When `next_unit` is not found in `plan.md`:

1. Set `next_unit: null` and `status: "pipeline_complete"`
2. Cancel the cron job (CronDelete)
3. Write a summary to `.harness/progress.md`:
   - Total ticks
   - Units completed
   - Any skipped/blocked units
   - Outstanding items from `.harness/backlog.md`
4. Notify user: `✅ Pipeline complete. {N} units delivered in {M} ticks.`

**Do NOT** let the cron continue firing with `next_unit: null`. Auto-terminate.

### Step 8 — Stall Detection

If the same unit appears in 2 consecutive ticks with status "completed" but next_unit unchanged:

1. Decompose the stalled unit into smaller sub-units
2. Update plan.md with the sub-units
3. Reset next_unit to the first sub-unit

If the same unit appears in 3 consecutive ticks → stop the loop, surface to user:
```
⛔ Stalled on unit {X} for 3 ticks. Needs human input.
```

### Step 9 — Context Resilience

Each tick prompt MUST be self-contained. After context compaction, the orchestrator loses:
- skill.md procedural instructions
- CLAUDE.md project conventions  
- Review independence requirements
- Backlog management rules

**Mitigations:**
1. The tick prompt explicitly lists critical rules (see Tick Prompt Template above)
2. Use `durable: true` on CronCreate so the tick prompt survives process restart
3. Each tick should re-read protocol files, not rely on in-context memory
4. Keep individual ticks small (one flow, not full-stack) to reduce context pressure

**What cannot be recovered after compaction:**
- Project-specific conventions from CLAUDE.md (mitigate: include key rules in plan.md)
- Nuanced understanding of acceptance criteria (mitigate: write detailed criteria in plan.md per unit)
- Previous tick's detailed reasoning (mitigate: write key decisions to progress.md)

## Tick Prompt Template

The cron job should schedule this prompt (adapt paths to project):

```
Read .harness/loop-state.json and .harness/plan.md.
Re-read the full loop-protocol.md and skill.md protocols — do NOT rely on memory from previous ticks.
Key rules to re-verify each tick:
  - Review units MUST dispatch ≥2 independent subagents via Agent tool (never self-review)
  - Implement/fix units MUST produce a git commit
  - UI units MUST include a screenshot artifact
  - Use opc-harness complete-tick with actual artifact paths (never skip)
  - On blocked/failed, include --description explaining why
Execute the current next_unit. After completion, call opc-harness complete-tick, then opc-harness next-tick.
If next-tick returns terminate:true, call CronDelete to stop the loop.
```

## Review Units — Mandatory Independence

Review units MUST use independent subagents (Agent tool). The orchestrator:

1. Dispatches 2-5 reviewer agents in parallel via Agent tool
2. Each agent gets: file list, acceptance criteria, project context
3. Each agent produces eval-{role}.md with 🔴/🟡/🔵 findings
4. Orchestrator collects evals and writes handshake
5. Orchestrator does NOT modify or filter findings

**Anti-patterns:**
- ❌ Orchestrator doing the review itself ("let me check the code...")
- ❌ Switching personas in the same context ("now I'll be the security reviewer...")
- ❌ Filtering findings before writing them ("this 🟡 isn't important, skip it")

## Backlog Management

During execution, unaddressed findings accumulate. The loop maintains `.harness/backlog.md`:

- Gate 🟡 findings not fixed in the current cycle → append to backlog
- Devil's advocate product concerns → append to backlog
- Skipped units due to blockers → append to backlog
- Nice-to-have improvements discovered during implementation → append to backlog

Format:
```markdown
## Backlog

- [ ] 🟡 [F4 review] Staircase algorithm only produces 8 outputs per topic — consider IRT or 5-question variant
- [ ] 🟡 [F4 review] No frontend component tests — parseChoices() and state machine untested
- [ ] ⏭️ [F4 skip] CoachDashboard diagnostic panel — needs backend API change
```

At pipeline completion, the backlog is surfaced in the summary. It becomes input for the next planning cycle.

## File Layout

```
.harness/
├── plan.md              # Unit decomposition + acceptance criteria
├── loop-state.json      # Current tick state (the cursor)
├── backlog.md           # Accumulated unaddressed items
├── progress.md          # Human-readable narrative log
└── nodes/               # Per-node artifacts (same as standard OPC)
```
