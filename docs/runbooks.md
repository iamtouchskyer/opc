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
| `id`           | string        | matches `/^[a-z0-9]+(-[a-z0-9]+)*$/` (slug) |
| `title`        | string        | non-empty                                   |
| `units`        | string[]      | non-empty, each entry non-empty string      |
| `tags`         | string[]      | optional, array of strings                  |
| `match`        | string[]      | optional; regex literals must be parseable; empty regex `//` rejected |
| `flow`         | string        | optional                                    |
| `tier`         | string        | optional; must be `functional`, `polished`, or `delightful` |
| `protocolRefs` | string[]      | optional                                    |
| `createdAt`    | string        | optional; must start with `YYYY-MM-DD`      |
| `updatedAt`    | string        | optional; must start with `YYYY-MM-DD`      |

Unknown frontmatter keys are preserved on the parsed object but are not
validated. v2 can add fields without breaking v1 readers.

### Match patterns

Two forms are supported:

- **Whole-word keyword** — plain string like `"add feature"`. Matched
  case-insensitively with word-boundary enforcement, so `"add"` will
  NOT match inside `"address"`. Internal whitespace is flexible —
  `"add feature"` matches `"add  feature"` (two spaces), `"add\tfeature"`
  (tab), or split across lines. Multi-word phrases score higher: a
  3-word phrase is 3× the weight of a single word.
- **Regex literal** — a string shaped exactly `/PATTERN/FLAGS`, e.g.
  `"/^implement /i"`. Parse errors are caught at load time via
  `validateRunbook` — a runbook with a broken regex is rejected with a
  stderr WARN and skipped.

> **YAML escaping footgun:** always wrap regex literals in **double
> quotes** in the frontmatter. Backslashes inside double-quoted YAML
> strings pass through to the OPC loader as a single backslash (which
> RegExp then interprets as an escape — e.g. `"/\bword/"` correctly
> compiles to a word-boundary). Single-quoted or unquoted forms have
> different escape rules and have caused silently-broken patterns in
> practice. If `runbook match` doesn't fire on a phrase you expect,
> first check that your regex line is double-quoted.

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

**Reserved flags.** `--dir` and `--help` are consumed by the command.
Any other `--foo` token is rejected loudly (prevents silent typos like
`--dri` producing empty results). If the literal task text contains
`--flag`-looking tokens, separate with `--`:

```
opc-harness runbook match -- "please use --dir /opt for install"
```

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
7. **Recognized unit IDs.** The schema validator only checks `units`
   is `string[]` non-empty — any string passes. The loop-protocol's
   default mapping (see `pipeline/loop-protocol.md` §"Standard unit
   sequence") recognizes: `spec`, `design`, `plan`, `build`,
   `implement`, `review`, `code-review`, `fix`, `test-design`,
   `test-execute`, `e2e-verify`, `accept`, `acceptance`, `e2e`,
   `audit`. Unrecognized IDs fall through to the build-verify default
   silently — pick from this set unless you have a reason not to.

### Try the reference runbook

To use the canonical `add-feature` runbook shipped under
`examples/runbooks/`, symlink it into your user runbooks dir:

```bash
mkdir -p ~/.opc/runbooks
ln -s ~/.claude/skills/opc/examples/runbooks/add-feature.md \
      ~/.opc/runbooks/add-feature.md
opc-harness runbook match "add a dark-mode toggle"   # exit 0 + matched: true
```

---

## Loop-protocol integration

Shipped in U5.11 (v0.8). The loop-protocol's Step 0 invokes
`opc-harness runbook match "<task>"` before plan decomposition. On
exit `0` + `matched: true`, the orchestrator adopts the runbook's
`flow` / `tier` / `units` as the loop plan. On exit `3` it falls
through to fresh decomposition. See `pipeline/loop-protocol.md` §"Step 0
— Runbook Lookup" for the full procedure.

`runbook match` also remains a standalone diagnostic — invoke it
directly to confirm your patterns fire before kicking off a real loop.

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

**Q: Can I disable runbooks entirely?** Yes — set
`OPC_DISABLE_RUNBOOKS=1` before the harness call. The CLI returns
exit `3` with `disabled: true` in the payload, without scanning
disk. (`/opc loop --no-runbook` is planned CLI sugar that would set
this env var for one invocation, but is not yet wired into arg
parsing as of v0.8 — set the env var directly until then.)

**Q: What happens if a runbook has a typo?** The loader skips it with a
stderr WARN naming the file and the validation error. Other runbooks
in the same directory load normally.
