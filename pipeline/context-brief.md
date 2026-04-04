# Context Brief

Build a Design Context Brief before dispatching role evaluators for review or analysis tasks. This prevents false positives by giving evaluators the author's intent and project constraints.

## When to Build

- **Full brief:** Review/analysis tasks with >3 files or security/compliance roles dispatched.
- **Light brief:** Review/analysis with ≤3 files and no security/compliance roles — just read the key files for context. Skip the formal brief.
- **Skip entirely:** Build, brainstorm, and plan tasks — evaluators get context from the handoff file instead.

## Checklist

1. **Spec/design docs** — check for design docs in the project. Key decisions should be respected, not flagged.
2. **Git history** — recent commit messages explaining intent (`git log --oneline -20`).
3. **CLAUDE.md** — project conventions, coding standards, workflow rules.
4. **TODOs/FIXMEs** — known limitations the author is already aware of.
5. **Conversation context** — anything the user mentioned about intent or constraints.
6. **Content safety scan** — if public repo, grep for real names, internal URLs, API keys, PII in all files (not just code). Flag real identifiers.

## Brief Template

Write 5-15 lines:

```
## Design Context Brief
1. Key design decisions (respect these, do not flag): ...
2. Known limitations: ...
3. Project conventions: ...
4. Content safety: public repo? Any PII/real names found?
```

Inject this brief into each role evaluator's prompt so they review against intent, not assumptions.
