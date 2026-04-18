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

## Writing an OPC Extension

OPC extensions inject additional context into agent prompts and/or additional
findings into review output. An extension is a directory with two files:

```
my-ext/
├── ext.json       # manifest (optional, documents the extension)
└── hook.mjs       # the code
```

### Minimal extension

```js
// hook.mjs
export const meta = {
  name: "my-ext",
  version: "1.0.0",
  // Capability IDs this extension provides — see "Capability shape" below.
  provides: ["visual-check@1"],
  // Optional: widen matching across capability version bumps.
  compatibleCapabilities: [],
};

// Called once on load; throw to refuse to load.
export async function startupCheck(ctx) { return true; }

// Called during build/review nodes. Return a markdown string to append
// to the agent's prompt.
export async function promptAppend(ctx) {
  return `## From my-ext\nCheck that X is true.\n`;
}

// Called at review time. Return an array of findings.
export async function verdictAppend(ctx) {
  return [{ severity: "warning", category: "accessibility", message: "..." }];
}

// Called during executor nodes (execute-type). Side-effectful verification —
// crawl a URL, run Playwright, hit an API. Return value is IGNORED. Throwing
// is isolated: siblings still fire.
export async function executeRun(ctx) {
  // ctx.runDir — write artifacts here if you need them
  return;
}

// Called during executor nodes, after executeRun. Return an array of items
// to persist as files: `{ name: "<basename>", content: string | Buffer | Uint8Array }`.
// Files are written to `<runDir>/ext-<name>/<basename>` and auto-appended to
// handshake.artifacts[] as `{ type: "ext-artifact", ext, path }`.
// Names must be plain basenames — `../escape`, `/abs`, `sub/nested` are rejected.
export async function artifactEmit(ctx) {
  return [{ name: "screenshot.png", content: Buffer.from([/* ... */]) }];
}
```

### Hook surface summary

| Hook            | When it fires                          | Return            | Failure |
|-----------------|----------------------------------------|-------------------|---------|
| `startupCheck`  | Once on load                           | any (throw=refuse)| Load rejected |
| `promptAppend`  | build / review node prompt assembly    | string            | Isolated (siblings still fire) |
| `verdictAppend` | review-node evaluation                 | `Finding[]`       | Isolated |
| `executeRun`    | execute-node side-effectful phase      | ignored           | Isolated |
| `artifactEmit`  | execute-node file-emission phase       | `{name,content}[]`| Isolated, per-item |

Both kebab (`execute.run`) and camel (`executeRun`) export names are recognized.

### Capability shape

Capability identifiers follow `/^[a-z][a-z0-9-]*@[1-9]\d*$/` (lower-kebab name + `@` + positive integer, no leading zeros). Examples:

- ✅ `visual-check@1`, `a11y@2`, `foo-bar@10`
- ⚠️  `visual-check` (bare — works, auto-upgrades to `@1` with a stderr WARN)
- ❌ `Visual-Check@1`, `foo@0`, `foo@01`, `foo_bar@1`, `1foo@1`

Always prefer the versioned form. When you bump a capability from `@1` to `@2`,
declare `compatibleCapabilities: ["<name>@1"]` so nodes still requiring `@1`
keep firing during migration.

### Test your extension locally

```
opc-harness extension-test --ext ./my-ext --all-hooks
```

This loads your hook, runs it against an empty context, and prints per-hook
results. Capability-shape lint runs first as non-fatal `[lint] ⚠️` lines:

```
[lint] ⚠️  meta.provides entry "Visual-Check@1" failed capability-shape check: invalid-shape
[startup.check] ✅ passed (3ms)
```

Lint warnings do NOT change the exit code — they're guidance, not failures.
Fix them before publishing so users don't see the warning on every load.

### Enable the extension in a project

Add it to `.opc/config.json` (repo-layer) or `~/.opc/config.json` (user-layer):

```json
{
  "extensions": ["./ext/my-ext"]
}
```

Disable temporarily via `disabledExtensions: ["my-ext"]` at any layer.

## Improving skill.md

The coordinator logic lives in `skill.md`. Changes here affect all users, so please:
1. Open an issue first to discuss the change
2. Explain the problem with a concrete example
3. Keep it concise — every line in skill.md costs tokens

## Style

- Role files: ~20-30 lines. Concise expertise bullets, clear triggers.
- skill.md: Minimal viable instructions. The coordinator is an LLM — it can fill in gaps. Don't over-specify.
- README: Developer-facing. No marketing fluff.
