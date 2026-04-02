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

Present a single coherent analysis. Merge agent output with coordinator's own perspective. Conversational tone, no severity ceremony unless warranted.

### Build (with evaluation)

```
## OPC Build — {task summary}

### Implementation
Wave {N} — {what was built, 2-3 sentences}

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

Present the decomposed plan with acceptance criteria per wave/group. Include dependency analysis and risk areas.

---

## Save Report (JSON)

After presenting results, save a structured JSON report.

**Directory:** `~/.opc/reports/` (create if it doesn't exist)
**Filename:** `{YYYY-MM-DD}T{HH-mm-ss}_{task-type}_{sanitized-task-summary}.json`

### JSON Schema

```json
{
  "version": "1.0",
  "timestamp": "<ISO 8601>",
  "taskType": "<review|analysis|build|brainstorm|plan>",
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
  "build": {
    "wave": 1,
    "round": 1,
    "finalVerdict": "<PASS|ITERATE|FAIL>",
    "iterationHistory": [
      { "round": 1, "verdict": "<verdict>", "reason": "<summary>", "implementerMode": "<Build|Fix|Polish>" }
    ],
    "acceptanceCriteria": [
      { "criterion": "<description>", "status": "<pass|fail>", "evidence": "<how tested>" }
    ]
  },
  "timeline": [
    {
      "type": "<triage|roles|context|dispatch|agent-output|verification|deep-dive|deep-dive-response|synthesis|report|build|implementer-output|evaluation-synthesis|iteration>",
      "role": "<coordinator or agent role name>",
      "content": "<message content>"
    }
  ]
}
```

### Rules

- Sanitize task summary for filename: lowercase, hyphens for spaces, keep CJK characters, strip punctuation and control chars, max 50 chars
- Only include dispatched agents
- `summary` counts only `status: "accepted"` findings
- Analysis: findings without severity default to `"suggestion"`
- Build: include `build` object with wave/round/iterationHistory/acceptanceCriteria
- Brainstorm: approaches as findings with severity `"suggestion"`
- `build` object is `null` for non-build tasks

---

## Replay

Browse past reports with `/opc replay`. See `./replay.md` for the full replay skill.
