# Report Format

## Presentation by Task Type

### Review

```
## OPC Review — {task summary}

### 🔴 Critical ({count})
{findings}

### 🟡 Warning ({count})
{findings}

### 🔵 Suggestion ({count})
{findings}

### Dismissed ({count})
{findings removed with brief reason}

---
Agents: {list}
Coordinator: {N challenged, M dismissed, K downgraded}
```

### Analysis

```
## OPC Analysis — {task summary}

### Current State
{What exists and how it works — 2-5 sentences with file:line references}

### Root Cause
{WHY is it this way? What constraints led here?}

### Findings
{Problems/gaps with file:line references. Use severity markers only if warranted — not required for analysis.}

### Recommendation
{Concrete steps with trade-offs acknowledged}

---
Agents: {list}
```

### Build (with evaluation)

```
## OPC Build — {task summary}

### Implementation
Node {NODE_ID} — {what was built, 2-3 sentences}

### Evaluation (Round {R})

#### Per-Role Results
| Role | Verdict | 🔴 | 🟡 | 🔵 |
|------|---------|-----|-----|-----|
| {role} | {verdict} | {count} | {count} | {count} |

#### Findings (by severity)
{severity-grouped findings, each tagged with [Role]}

### Iteration History
{Round 1 → FAIL (reason) → Round 2 → ITERATE (reason) → Round 3 → PASS}

---
Verdict: {PASS/ITERATE/FAIL}
Agents: implementer + {evaluator roles}
Rounds: {N}
Coordinator: {N challenged, M dismissed, K downgraded}
```

### Brainstorm

```
| Approach | Pros | Cons | Effort | Risk |
|----------|------|------|--------|------|
| A: ...   | ...  | ...  | ...    | ...  |
| B: ...   | ...  | ...  | ...    | ...  |

Recommendation: {coordinator's pick with rationale}
```

### Plan

```
## OPC Plan — {task summary}

### Overview
{1-2 sentences: what this plan covers and the approach}

### Task Decomposition

#### Wave 1: {wave theme}
| # | Task | Files | Depends on |
|---|------|-------|------------|
| 1 | {task description} | {key files} | — |
| 2 | {task description} | {key files} | 1 |

**Acceptance criteria:**
- [ ] {criterion 1}
- [ ] {criterion 2}

#### Wave 2: {wave theme} (if multi-wave)
...

### Dependencies & Risks
- {dependency or risk with mitigation}

### Evaluation
{Evaluator's assessment: completeness, feasibility, criteria quality}
Verdict: {PASS/ITERATE/FAIL}

---
Agents: {list}
```

---

## Save Report (JSON)

After presenting results, generate the JSON report using the harness tool:

```bash
mkdir -p ~/.opc/reports
opc-harness report . --mode {mode} --task "{task}" --challenged N --dismissed M --downgraded K > ~/.opc/reports/{filename}.json
```

The tool reads `.harness/nodes/*/run_*/eval*.md` files and outputs a complete JSON report to stdout. The orchestrator only needs to provide mode, task description, and coordinator action counts.

**Directory:** `~/.opc/reports/`
**Filename:** `{YYYY-MM-DD}T{HH-mm-ss}_{mode}_{sanitized-task-summary}.json`

### JSON Schema

```json
{
  "version": "1.0",
  "timestamp": "<ISO 8601>",
  "mode": "<review|analysis|execute|plan|brainstorm>",
  "task": "<original task description>",
  "agents": [
    {
      "role": "<role name>",
      "scope": ["<file paths>"],
      "verdict": "<VERDICT string>",
      "findings": [
        {
          "severity": "<critical|warning|suggestion>",
          "file": "<file path>",
          "line": null,
          "issue": "<issue description>",
          "fix": "<suggested fix>",
          "reasoning": "<why this matters>",
          "status": "<accepted|dismissed|downgraded>",
          "dismissReason": "<reason if dismissed/downgraded, null otherwise>"
        }
      ],
      "evidence": [
        {
          "type": "<screenshot|cli-output|test-result>",
          "path": "<path to evidence file>"
        }
      ]
    }
  ],
  "coordinator": {
    "challenged": 0,
    "dismissed": 0,
    "downgraded": 0
  },
  "summary": {
    "critical": 0,
    "warning": 0,
    "suggestion": 0
  },
  "timeline": [
    {
      "type": "<triage|roles|context|dispatch|agent-output|verification|deep-dive|deep-dive-response|synthesis|report|discussion|execution|gate-decision|loopback>",
      "role": "<coordinator or agent role name>",
      "content": "<message content>"
    }
  ],
  "flow": {
    "template": "<flow template name>",
    "nodesExecuted": ["<node IDs in execution order>"],
    "loopbacks": [
      {
        "from": "<source node ID>",
        "to": "<target node ID>",
        "reason": "<why the loopback occurred>"
      }
    ]
  }
}
```

### Mode Mapping

Map pipeline task types to `mode` for backward compatibility with OPC Viewer:
- review → `"review"`
- analysis → `"analysis"`
- build, full pipeline → `"execute"`
- plan → `"plan"`
- brainstorm → `"brainstorm"`
- verification → `"review"`
- post-release → `"review"`

### Rules

- Sanitize task summary for filename: lowercase, hyphens for spaces, keep CJK characters, strip punctuation and control chars, max 50 chars
- Only include dispatched agents
- `summary` counts only `status: "accepted"` findings
- Analysis: findings without severity default to `"suggestion"`. Root cause and recommendation go in the `report` timeline entry content.
- Build: iteration history goes in `timeline` as `verification` entries (content includes round, verdict, reason, implementer mode). Acceptance criteria go in the evaluator agent's `findings` array. Final verdict goes in the `report` timeline entry.
- Plan: task decomposition goes in the `report` timeline entry content. Evaluator's assessment of plan quality goes in the evaluator agent's `findings` array (severity `"suggestion"` for plan gaps, `"warning"` for missing dependencies or untestable criteria).
- Brainstorm: approaches as findings with severity `"suggestion"`

---

## Replay

Browse past reports with `/opc replay`. See `../replay.md` for the full replay skill.
