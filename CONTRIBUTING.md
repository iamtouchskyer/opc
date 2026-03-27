# Contributing to OPC

## The easiest way to contribute: add a role

Create a `.md` file in `roles/` following this format:

```markdown
# Role Name

## Identity
One sentence: who you are and what you care about.

## Expertise
- **Area** — what you know about it
- ...

## When to Include
- Condition that triggers this role
- ...
```

That's it. The coordinator reads your role file automatically. No configuration, no code changes.

### Good role ideas we'd love to see

- **Data Engineer** — pipeline design, data quality, ETL patterns
- **Mobile** — iOS/Android patterns, responsive behavior, touch interactions
- **Performance** — Core Web Vitals, profiling, bottleneck analysis
- **Technical Writer** — documentation quality, API docs, changelog clarity
- **Localization** — i18n completeness, cultural adaptation, RTL support

## Improving existing roles

If a built-in role produces bad results for your use case, open an issue describing:
1. What task you ran
2. What the role produced
3. What you expected instead

Or submit a PR editing `roles/<name>.md` with better expertise descriptions or `When to Include` triggers.

## Improving skill.md

The coordinator logic lives in `skill.md`. Changes here affect all users, so please:
1. Open an issue first to discuss the change
2. Explain the problem with a concrete example
3. Keep it concise — every line in skill.md costs tokens

## Style

- Role files: ~20-30 lines. Concise expertise bullets, clear triggers.
- skill.md: Minimal viable instructions. The coordinator is an LLM — it can fill in gaps. Don't over-specify.
- README: Developer-facing. No marketing fluff.
