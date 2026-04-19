# Runbooks

Runbooks are **reusable task recipes** for `/opc loop`. Instead of
decomposing every new task from scratch, the loop-protocol looks for a
runbook whose `match:` patterns cover the incoming task and uses its
`units:` list as the decomposition. Think of them as project-level muscle
memory: "when someone asks to *add a feature*, this is how we do it."

This page is the schema reference and operator guide. Loop-protocol
integration (how runbooks are actually consumed at tick 0) is covered
in `pipeline/loop-protocol.md` — the runbook file here is purely a
specification of the schema and CLI.

---

## Location

Runbooks live in one of the following, checked in order:

1. `--dir <path>` explicit flag to the `runbook` CLI commands
2. `OPC_RUNBOOKS_DIR` environment variable
3. `~/.opc/runbooks/` (default)

Each runbook is a single `.md` file with YAML-lite frontmatter. Non-`.md`
files in the directory are ignored. Loading is non-recursive — flat
directory only.

---

## Schema v1

```yaml
---
version: 1                          # REQUIRED — schema version (must be 1)
id: add-feature                     # REQUIRED — kebab-case slug, unique across dir
title: Add a Feature                # REQUIRED — human-readable one-line title
tags:                               # optional — used for scoring + filtering
  - build
  - frontend
match:                              # optional — patterns used by `runbook match`
  - add feature                     #   whole-word keyword (case-insensitive)
  - "/^implement /i"                #   /.../FLAGS regex literal
flow: build-verify                  # optional — which OPC flow template to use
tier: polished                      # optional — quality tier (functional|polished|delightful)
units:                              # REQUIRED — non-empty list of unit IDs
  - plan
  - build
  - review
  - test-design
  - test-execute
protocolRefs:                       # optional — pipeline protocol filenames
  - implementer-prompt.md
createdAt: 2026-04-19               # optional — ISO date (string)
updatedAt: 2026-04-19               # optional — ISO date (string)
---
# Body (markdown)

Everything after the closing `---` is the runbook body. The body is
surfaced by `runbook show <id>` and is available to the orchestrator
as human guidance ("why these units, what to watch out for").
```

### Field rules

| Field          | Type          | Validation                                  |
|----------------|---------------|---------------------------------------------|
| `version`      | number        | must be `1`                                 |
| `id`           | string        | matches `/^[a-z0-9][a-z0-9-]*$/` (slug)     |
| `title`        | string        | non-empty                                   |
| `units`        | string[]      | non-empty, each entry non-empty string      |
| `tags`         | string[]      | optional, array of strings                  |
| `match`        | string[]      | optional; regex literals must be parseable  |
| `flow`         | string        | optional                                    |
| `tier`         | string        | optional                                    |
| `protocolRefs` | string[]      | optional                                    |

Unknown frontmatter keys are preserved on the parsed object but are not
validated. v2 can add fields without breaking v1 readers.

### Match patterns

Two forms are supported:

- **Whole-word keyword** — plain string like `"add feature"`. Matched
  case-insensitively with word-boundary enforcement, so `"add"` will
  NOT match inside `"address"`. Multi-word phrases score higher: a
  3-word phrase is 3× the weight of a single word.
- **Regex literal** — a string shaped exactly `/PATTERN/FLAGS`, e.g.
  `"/^implement /i"`. Parse errors are caught at load time via
  `validateRunbook` — a runbook with a broken regex is rejected with a
  stderr WARN and skipped.

Tags that appear as whole words in the task also contribute score.

### Scoring

| Signal                  | Score                        |
|-------------------------|------------------------------|
| keyword match           | 10 × word count              |
| regex match             | 5                            |
| tag whole-word match    | 3                            |

Tie-breakers (in order): higher total score → more patterns matched →
alphabetical by `id`.

---

## CLI

All output is JSON to stdout. Stderr is reserved for WARN / errors.
Exit codes: `0` success, `1` usage error, `2` not found (show), `3` no
match (match).

### `opc-harness runbook list [--dir <path>]`

Lists all runbooks in the directory, summarized (body omitted).

```json
{
  "dir": "/Users/you/.opc/runbooks",
  "count": 1,
  "runbooks": [
    {
      "id": "add-feature",
      "title": "Add a Feature",
      "tags": ["build"],
      "match": ["add feature"],
      "flow": "build-verify",
      "tier": "polished",
      "units": ["plan", "build", "review"],
      "path": "/Users/you/.opc/runbooks/add-feature.md"
    }
  ]
}
```

### `opc-harness runbook show <id> [--dir <path>]`

Prints the runbook with its body. Exit code `2` if no runbook has that
`id`.

### `opc-harness runbook match <task...> [--dir <path>]`

Scores every runbook against `<task>` and prints the winner. Exit code
`3` if nothing matches.

```json
{
  "task": "please add feature for login",
  "dir": "/Users/you/.opc/runbooks",
  "matched": true,
  "score": 20,
  "patterns": ["add feature"],
  "runbook": { "id": "add-feature", "...": "..." }
}
```

---

## Authoring guide

1. **Start small.** A runbook with just `{version, id, title, units, match}`
   is valid and useful.
2. **Prefer whole-word keywords over regex** where possible — they are
   easier to read, higher-scored, and don't bite you with escape issues.
3. **Multi-word phrases** beat single words. `"add feature"` is more
   specific than `"add"` and will outrank it.
4. **Use `tags:`** for cross-cutting signals (`frontend`, `refactor`,
   `security`) that may not appear in the task's verb. They contribute
   a small boost and document the runbook's domain.
5. **Keep `id` short and stable.** It's the public handle for
   `runbook show` and (eventually) for referencing from state files.
6. **The body is human documentation.** The orchestrator may surface it
   to the operator or inject it into subagent prompts as context. Write
   it for the next person (likely future-you) to read.

---

## Loop-protocol integration (preview)

Currently only the schema + CLI ship (unit U5.9). The loop-protocol
wiring — "before decomposing, check `~/.opc/runbooks/` for a match" —
lands in U5.11 and will look like:

```
0. [tick 0] If matchRunbook(task, loadRunbooks(runbookDir)) returns a
   runbook, use its flow / tier / units as the loop plan. User can
   override with --no-runbook. Otherwise fall through to decompose.
```

Until then, `runbook match` is a standalone diagnostic command: you can
seed `~/.opc/runbooks/`, confirm your patterns are well-tuned, and
then the upcoming loop-protocol change will start consuming them
automatically.

---

## Example: a complete runbook

```markdown
---
version: 1
id: add-feature
title: Add a Feature
tags: [build, frontend]
match:
  - add feature
  - new feature
  - "/^implement /i"
flow: build-verify
tier: polished
units:
  - plan
  - build
  - review
  - test-design
  - test-execute
  - acceptance
protocolRefs:
  - implementer-prompt.md
  - role-evaluator-prompt.md
createdAt: 2026-04-19
updatedAt: 2026-04-19
---
# Add Feature Runbook

Use when the user asks to add a new feature to an existing codebase.
The flow is build-verify because we need explicit test-design +
test-execute separation — the person writing the feature cannot also
be the person verifying it ships.

## Unit rationale

- **plan** — decompose the feature into concrete DoD bullets
- **build** — implementer subagent writes the code
- **review** — 2 independent reviewers (backend + frontend)
- **test-design** — a different subagent designs test cases
- **test-execute** — orchestrator runs them and captures evidence
- **acceptance** — PM/designer final sign-off
```

---

## FAQ

**Q: What happens if two runbooks match?** The higher-scoring one wins;
see the tie-breaker order above. You can always inspect scores with
`runbook match <task>` to see why.

**Q: What happens if no runbook matches?** `runbook match` exits `3`
and the loop-protocol (post-U5.11) falls through to fresh task
decomposition.

**Q: Can I disable runbooks entirely?** Yes — either unset
`OPC_RUNBOOKS_DIR` and remove `~/.opc/runbooks/`, or once U5.11 ships,
pass `--no-runbook` to `/opc loop`.

**Q: What happens if a runbook has a typo?** The loader skips it with a
stderr WARN naming the file and the validation error. Other runbooks
in the same directory load normally.
