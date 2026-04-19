# OPC Extension Authoring Guide

> Canonical guide for writing third-party OPC extensions. Self-contained — if
> you can read JS and have `opc-harness` on your `PATH`, this page is all you
> need to ship your first extension.

---

## 0. Prerequisites — how to get `opc-harness`

This guide uses `opc-harness` as if it were on your `PATH`. Two ways to make
that true:

1. **npm install** (preferred, same package the README teaches):

   ```bash
   npm i -g @touchskyer/opc           # or: pnpm add -g / yarn global add
   opc-harness --help                  # sanity check — prints usage to stderr
   ```

   The npm package ships the `opc-harness` binary alongside the `/opc` slash
   commands. Both invoke the same Node script — they are not two products.

2. **Run from a repo checkout** (no global install — handy for hacking on
   the harness itself):

   ```bash
   node /path/to/opc/bin/opc-harness.mjs --help
   alias opc-harness='node /path/to/opc/bin/opc-harness.mjs'  # optional
   ```

   Any command in this guide that starts with `opc-harness …` can be
   rewritten as `node bin/opc-harness.mjs …`.

Sanity check: `opc-harness` with no arguments (or `--help`) prints the full
command list to stderr and exits 0. If you see `command not found`, you
either skipped the install step or your shell's `PATH` doesn't include the
global npm bin dir (`npm bin -g`).

### `~/.opc/` bootstrap

Extensions live under `~/.opc/extensions/<ext-name>/`. Rules:

- `~/.opc/` itself does **not** need to exist ahead of time. If the
  extensions dir is missing, the loader treats it as "zero extensions
  installed" and moves on (unless a required extension was declared — then
  it FATALs).
- Nothing else in `~/.opc/` is required for extensions. The optional
  per-user `~/.opc/config.json` (documented in the README) is read by
  `opc-harness config resolve` for global defaults, but is not part of the
  extension-discovery contract.
- To relocate the scan root, set `OPC_EXTENSIONS_DIR=/custom/path`.
- To bypass the scan entirely during development, point
  `opc-harness extension-test --ext <abs-path>` at a single directory —
  that command loads your extension directly without touching
  `~/.opc/extensions/`.

---

## 1. What is an OPC extension?

An OPC extension is a **directory on disk** containing a `hook.mjs` ES module
and a small `ext.json` manifest. When OPC runs a task pipeline, it scans
`~/.opc/extensions/` (or whatever `OPC_EXTENSIONS_DIR` points at), dynamically
imports each `hook.mjs`, and invokes named hooks at well-defined call sites
inside the orchestrator — appending text to role prompts, adding findings to
evaluator verdicts, running side-effectful checks during executor nodes, and
emitting artifact files into the current run directory.

Extensions are **capability-gated**: an extension declares what it provides
(e.g. `visual-consistency-check@1`), each node in the flow template declares
what capabilities it requires, and the core only fires your hooks when your
`provides` overlap the node's requirements. An extension with no capability
match is silently skipped — not an error, just not this node's concern.

Failures are **isolated and observable**. Any hook that throws, times out, or
returns the wrong shape is recorded to a failure sidecar (`extension-failures.json`
+ a rendered `extension-failures.md`). After N consecutive failures a per-process
circuit breaker disables the extension for the remainder of the run. Healthy
siblings keep executing. This is the core contract: **your extension cannot
take down the pipeline.**

### 1.1 Execution model

This section is **SemVer-stable contract** — extensions may rely on it.

- **In-process dynamic `import()`.** Each `hook.mjs` is loaded into the same
  Node process as the harness. There is no worker, no fork, no sandbox. Your
  hook runs with full Node privileges — `fs`, `child_process`, `process.env`,
  the module cache, all of it. `process.exit()` in your hook **will** kill
  the harness; don't do that.
- **Sequential per call site.** Inside a single call site
  (`firePromptAppend`, `fireVerdictAppend`, `fireExecuteRun`,
  `fireArtifactEmit`), extensions are invoked one at a time with `await`.
  Extension B does not start until extension A has resolved, thrown, or
  timed out. One extension's throw does **not** abort siblings — the core
  catches, records, and moves to the next.
- **Deterministic ordering = alphabetical by directory name.** The loader
  sorts discovered extensions alphabetically before loading. Outputs from
  `promptAppend` are concatenated in that order with `\n\n` separators;
  findings from `verdictAppend` are merged in that order; artifacts from
  `artifactEmit` are written in that order into per-extension subdirs so
  there is no name collision across extensions (see §5.5). You can override
  the front of the order via `config.extensionOrder: ["a", "b", …]`; any
  extensions not named there fall to alphabetical tail order.
- **No cross-call-site ordering guarantee.** `promptAppend` vs
  `verdictAppend` vs `artifactEmit` run at different pipeline phases in
  different CLI invocations — never assume one finished before another
  started unless they are the same phase.
- **`ctx` is a shared mutable reference — do not mutate it.** The core
  passes the same object to every matched extension without freezing or
  cloning it. If extension A does `ctx.task = ctx.task.toUpperCase()`,
  extension B (which runs after A) will see the upper-cased value. Treat
  `ctx` as read-only; mutating it is undefined behavior and a future
  minor-version change may `Object.freeze` it to enforce this.
- **Cooperative timeouts.** The `HOOK_TIMEOUT_MS` guard races your
  hook's promise against a `setTimeout` (see §7.1). If your hook times
  out, the core rejects the awaited promise and continues — but any
  in-flight subprocesses, network requests, or unresolved promises **you**
  started keep running in the background. Always pipe an
  `AbortController` / `AbortSignal.timeout` into `spawn` / `fetch` /
  Playwright calls so they clean themselves up.

### 1.2 Hook name mapping (camelCase ↔ kebab+dot)

The same five hooks go by two names:

| camelCase export (§5)  | Kebab+dot canonical name (§8, §9, logs) |
|------------------------|------------------------------------------|
| `promptAppend`         | `prompt.append`                          |
| `verdictAppend`        | `verdict.append`                         |
| `executeRun`           | `execute.run`                            |
| `artifactEmit`         | `artifact.emit`                          |
| `startupCheck`         | `startup.check`                          |

Rules:

- Export your hook under **either** the camelCase name (recommended) **or**
  the kebab+dot name via `export { fn as "prompt.append" }`. Both are
  normalized to the same internal `hooks["prompt.append"]` slot.
- If you export **both** forms, the **kebab+dot form wins** (it is assigned
  after the camelCase form in the normalizer).
- **Unknown exports are silently ignored.** Exporting a function named
  `prommptAppend` (typo) or `onPrompt` will not error, will not warn — the
  hook just never fires. If your hello-world's hook never runs, grep
  your export name against the table above first.
- Failure sidecar, stderr logs, and `--hook` CLI flag all use the
  **kebab+dot** form. Grep `prompt.append`, not `promptAppend`, when
  chasing issues in logs.

---

## 2. Quickstart (5 minutes)

```bash
mkdir -p ~/.opc/extensions/hello-world
cd ~/.opc/extensions/hello-world
```

**`ext.json`**

```json
{
  "name": "hello-world",
  "version": "0.1.0",
  "description": "Minimal promptAppend extension — injects a greeting.",
  "meta": {
    "provides": ["context-enrichment@1"]
  }
}
```

**`hook.mjs`**

```js
export const meta = {
  name: "hello-world",
  provides: ["context-enrichment@1"],
  description: "Injects a greeting section into prompts."
};

export async function promptAppend(ctx) {
  if (!ctx || !ctx.task) return "";
  return `## Hello\n\nWorking on: ${ctx.task.slice(0, 80)}\n`;
}
```

**Test it without running a full pipeline:**

```bash
opc-harness extension-test \
  --ext ~/.opc/extensions/hello-world \
  --all-hooks \
  --context '{"task":"build a login page","nodeCapabilities":["context-enrichment@1"]}'
```

You should see a `✅ prompt.append` line in stdout with the rendered section.
That's it — you've written, installed, and validated an extension.

---

## 3. Anatomy of an extension

### 3.1 Directory layout

```
~/.opc/extensions/
  my-ext/
    ext.json         # manifest (name, version, description, meta)
    hook.mjs         # ES module exporting hooks + meta (REQUIRED)
    prompt.md        # optional static markdown (read into ext.promptMd at load)
    …                # anything else (package.json, node_modules, tests) is yours
```

Only two rules the loader enforces:

1. The subdirectory name **must not** start with `.` (dotfiles are filtered —
   `.git`, `.DS_Store`, etc.).
2. The subdirectory **must** contain a file literally named `hook.mjs`.
   Anything else is ignored as "not an extension."

The directory name is the canonical extension name (`ext.name` in logs,
failure records, and artifact subdir `ext-<name>/`).

### 3.2 `ext.json` fields

```json
{
  "name": "memex-recall",
  "version": "0.1.0",
  "description": "One-line summary of what this extension does.",
  "meta": {
    "provides": ["context-enrichment@1"],
    "compatibleCapabilities": ["verification@1", "execute@1"]
  }
}
```

`ext.json` is **descriptive only** — the loader reads `meta` from your
`hook.mjs` exports, not from JSON. `ext.json` exists so humans (and package
indexes) can see what the extension does without eval'ing JS. Keep `meta`
here in sync with `hook.mjs` as a matter of discipline.

In particular, `name` in `ext.json` is **purely cosmetic** — the directory
name always wins (§3.1). The `_starter/` template omits `name` deliberately
(no field is better than a stale field); the `memex-recall` example includes
it for human skim-readability. Either style is legal. If you include it,
keep it in sync with the directory name.

### 3.3 `hook.mjs` export shapes

Three shapes are accepted. Pick the first one (named exports) unless you have
a reason not to.

**A. Named exports (recommended):**

```js
export const meta = { name: "my-ext", provides: ["foo@1"], description: "…" };
export async function promptAppend(ctx) { /* … */ }
export async function verdictAppend(ctx) { /* … */ }
export async function executeRun(ctx)    { /* … */ }
export async function artifactEmit(ctx)  { /* … */ }
export async function startupCheck(ctx)  { /* … */ }
```

> `meta.name` is **not read** by the loader — the canonical extension name
> comes from the directory basename (§3.1). Omit it; the `_starter/`
> template at `examples/extensions/_starter/hook.mjs` does. The quickstart
> and §3.3 examples still include `name:` for historical reasons; both
> styles load identically.

**B. Kebab-case named exports:**

```js
export const meta = { /* … */ };
export { promptAppendFn as "prompt.append", verdictAppendFn as "verdict.append" };
```

**C. Legacy default-export (still supported):**

```js
export default {
  meta: { name: "my-ext", provides: ["foo@1"] },
  hooks: {
    "prompt.append":  async (ctx) => "…",
    "verdict.append": async (ctx) => [/* findings */],
    "startup.check":  async (ctx) => { /* throw to abort load */ },
    "execute.run":    async (ctx) => { /* side effect */ },
    "artifact.emit":  async (ctx) => [{ name: "foo.txt", content: "…" }],
  },
};
```

All three shapes normalize to the same internal `{ hooks: { ... } }` object
via `normalizeHook()`.

---

## 4. Capabilities & routing

### 4.1 Versioning format

Capability identifiers are strings matching `/^[a-z][a-z0-9-]*@[1-9]\d*$/`:

- Lowercase ASCII letter start (`a-z`)
- Then lowercase letters, digits, or hyphens
- Literal `@`
- Positive integer version (1, 2, …). No leading zeros. No `@0`.

Valid: `visual-check@1`, `a11y-audit@2`, `perf-check@10`.
Invalid: `VisualCheck@1` (uppercase), `foo@0` (zero), `foo@01` (leading zero),
`foo` (missing version — see auto-upgrade below).

**No semver.** Versions are **integer generations**, not semver ranges.
`foo@1` matches `foo@1` only; `foo@1` does **not** match `foo@2` under any
rule. There is no `^1`, no `>=1`, no `1.x` — writing `"foo@^1"` or
`"foo@1.0"` in `provides` / `compatibleCapabilities` is lint-FAIL
`invalid-shape` (§4.6). To support multiple generations, list them
individually:

```js
provides: ["visual-check@2"],
compatibleCapabilities: ["visual-check@1"],  // widen to the older gen
```

### 4.2 Bare-name auto-upgrade

A bare name like `foo` (matching `/^[a-z][a-z0-9-]*$/`) is **auto-upgraded** to
`foo@1` at normalization time. The first time each bare token is seen in a
process, a WARN is written to stderr:

```
[opc] WARN: capability 'foo' missing version suffix — auto-upgrading to 'foo@1'.
Declare 'foo@1' explicitly to silence this.
```

The warning fires **once per bare token per process**. If you see it, add the
`@1` suffix in your `meta.provides` and your flow template's `nodeCapabilities`.

### 4.3 `meta.provides`

Array of capability strings this extension provides. Examples:

```js
export const meta = {
  provides: ["visual-consistency-check@1"],            // one capability
  provides: ["a11y@1", "color-contrast@1"],            // multiple
  provides: [],                                        // none — startupCheck runs, hooks never fire
};
```

`meta.provides = []` is **legal and useful** for extensions whose entire
purpose is `startupCheck` (e.g. asserting an env var is set at load time).

### 4.4 `meta.compatibleCapabilities`

Array of additional capability strings this extension **also matches** without
claiming them as its canonical output. Useful during capability-version
migrations:

```js
export const meta = {
  provides: ["visual-check@2"],                // canonical
  compatibleCapabilities: ["visual-check@1"],  // still fire for @1 nodes
};
```

A node requiring `visual-check@1` will match this extension; so will a node
requiring `visual-check@2`.

### 4.5 Routing rule

When a hook call site runs, the core computes "should I fire this extension?"
as follows:

1. Read `ctx.nodeCapabilities` (array of strings the current node requires).
2. Normalize both `ext.meta.provides ∪ ext.meta.compatibleCapabilities` and
   `nodeCapabilities` via the `name@N` rule.
3. Fire if the sets intersect. Skip otherwise.

Edge cases:

- `nodeCapabilities` is missing / empty / not an array → **no** extensions
  fire for that node.
- `ext.meta.provides` is empty AND `compatibleCapabilities` is empty → the
  extension never fires from any node.
- Node requires a capability that **no installed extension provides** →
  **silent no-op**. There is no "unmet capability" error. The node
  proceeds with whatever the built-in roles produce. Debug by running
  `opc-harness config resolve` (confirms the loaded extensions and their
  provides) plus `opc-harness extension-test --ext <path>` (confirms your
  extension lints clean and exports the expected provides).
- Matching is **case-sensitive exact string equality** after normalization.
  A capability that fails `lintCapability` (e.g. `Foo@1`) never matches
  anything — the lint WARN in §4.6 is your only signal.

### 4.6 Lint

`opc-harness extension-test` runs `lintCapability` on every entry of
`meta.provides` and `meta.compatibleCapabilities` before invoking hooks.
Possible outcomes per entry:

| Result                    | Meaning                                               |
|---------------------------|-------------------------------------------------------|
| `ok: true, versioned`     | Canonical `name@N` form — no warning.                 |
| `ok: true, bare`          | Bare `name` — valid, but will WARN at runtime.        |
| `ok: false, not-a-string` | Entry is not a string — lint FAIL.                    |
| `ok: false, empty`        | Entry is `""` — lint FAIL.                            |
| `ok: false, invalid-shape`| Doesn't match either regex — lint FAIL.               |

Lint failures print a `[lint] ⚠️` line to stderr but **do not block** hook
execution — the harness continues and reports per-hook pass/fail separately.

### 4.7 Canonical core capabilities

The built-in flow templates (`flow-templates.mjs`) stamp a fixed set of
capability strings onto their nodes. Declare `compatibleCapabilities` with
these strings if you want your extension to auto-fire on stock OPC flows —
don't cargo-cult from other examples.

| Capability string               | Emitted by (built-in node)                        | Phase        |
|---------------------------------|---------------------------------------------------|--------------|
| `code-quality-check@1`          | `build-verify.code-review`, `full-stack.code-review` | review    |
| `visual-consistency-check@1`    | `code-review`, `acceptance` nodes                 | review       |
| `user-simulation@1`             | `acceptance`, `e2e-user`, `post-launch-sim`       | review/execute |
| `security-check@1`              | `audit`                                           | review       |
| `a11y-check@1`                  | `audit`                                           | review       |
| `verification@1`                | generic verification slot (widely used by examples) | review     |
| `design-review@1`               | generic design-review slot                        | review       |
| `execute@1`                     | generic executor slot                             | execute      |
| `context-enrichment@1`          | any node the flow stamps with it                  | prompt       |

Also widely used by the `examples/extensions/*` set as a "match all three
generic review/execute nodes" triple: `["verification@1",
"design-review@1", "execute@1"]` (see `memex-recall` §10.1,
`session-logex`, `lint-prompt-length`). User-defined flows can stamp
arbitrary capability strings — these are just the ones shipped.

If you target a node that stamps a capability **not** in this table,
your `compatibleCapabilities` must list it explicitly. The silent-no-op
rule (§4.5) means a capability typo produces no runtime signal.

---

## 5. The hooks

All hooks receive a single `ctx` argument and are called with `await`.
Synchronous hooks are fine (the core wraps with `Promise.resolve`).

There are **five** hooks in total: the four that fire per-node during a
pipeline (`promptAppend`, `verdictAppend`, `executeRun`, `artifactEmit`)
plus `startupCheck` which runs once at load time (§5.6). See the name
mapping table in §1.2 for the camelCase ↔ kebab+dot correspondence used
across logs and CLI flags.

### 5.1 `ctx` shape

The exact fields passed depend on which CLI command / call site invokes the
hook, but the stable subset all hooks can rely on is:

```js
{
  node: "build-login",                       // current node id (string)
  role: "builder" | "evaluator" | "executor",// current role
  task: "Build a login page with email+password",  // task description
  flowDir: "/abs/path/to/.harness",          // root of the harness dir
  runDir:  "/abs/path/to/.harness/nodes/build-login/run-2026-04-19T…",
  devServerUrl: "http://localhost:5173",     // may be "" if none configured
  nodeCapabilities: ["visual-check@1"],      // the node's required capabilities
}
```

Additional fields may be present depending on the call site (e.g. `artifacts`,
`handshake` may be populated by the orchestrator when stamping). **Always
defensively destructure** — treat any field as potentially missing:

```js
export async function promptAppend(ctx) {
  const task = ctx?.task ?? "";
  const runDir = ctx?.runDir;
  if (!runDir) return "";   // not safe to write files without runDir
  // …
}
```

**`ctx.task` is the task description, not the assembled prompt.** It is the
first line of the node's `acceptance-criteria.md` (e.g. `"Build a login page
with email+password"`), set by `readTaskFromAC` in `ext-commands.mjs`. There
is **no** `ctx.assembledPrompt` — a hook cannot see the concatenation of
every extension's `promptAppend` output. To bound prompt growth, either
measure the inputs (`ctx.task`) or emit the finding from inside
`promptAppend` itself as a side-channel `process.stderr.write` line.

**`ctx.task` type guarantee holds in the pipeline only.** In production
pipeline commands (`prompt-context`, `extension-verdict`, `extension-artifact`)
`ctx.task` is always a string — `""` when `acceptance-criteria.md` is absent.
Under `extension-test --context <json>`, the JSON is passed through verbatim,
so your hook may receive `task: undefined`, `task: 42`, `task: [...]`, etc.
For any schema-typed field you read, guard with a `typeof` check, not just
`??`:

```js
const task = typeof ctx?.task === "string" ? ctx.task : "";
```

### 5.2 `promptAppend(ctx)` — prompt augmentation

**Fires when:** the orchestrator is building the role prompt for a node that
requires at least one of your capabilities.

**Signature:** `async (ctx) => string | null | undefined`

**Expected return:** a markdown string. It is concatenated (with `\n\n`
separators) to the other extensions' outputs and appended to the role prompt.

**Graceful-empty value:** return `""`, `null`, or `undefined`. Any of these
causes the core to skip your contribution silently (no failure recorded).

**Wrong-shape penalty:** returning anything other than `string | null |
undefined | ""` records a `bad-return` failure and ignores the value.

**Example:**

```js
export async function promptAppend(ctx) {
  const notes = await fetchRelevantNotes(ctx?.task).catch(() => []);
  if (notes.length === 0) return "";
  const items = notes.map(n => `- ${n.title}`).join("\n");
  return `## Relevant prior notes\n\n${items}\n`;
}
```

**CLI:** `opc-harness prompt-context --node <id> --role <role> --dir <harness-dir>`
fires `promptAppend` and prints `{ append, applied, nodeCapabilities }` as JSON.

### 5.3 `verdictAppend(ctx)` — evaluator findings

**Fires when:** the evaluator role runs `opc-harness extension-verdict` (or
the equivalent orchestrator hook) for a node requiring your capabilities.

**Signature:** `async (ctx) => Finding[] | null | undefined`

**Finding shape:**

```js
{
  severity: "error" | "warning" | "info",   // required
  category: "a11y" | "contrast" | "…",      // required string
  message:  "Button contrast ratio 3.1:1 below WCAG AA 4.5:1",  // required string
  file:     "src/Login.tsx",                // optional
}
```

**Legacy shape** also normalized: `{ text: "[tag] category: message", emoji: "🔴"|"🟡"|"🔵", file? }`.

**Expected return:** an array of findings. An empty array is fine. Each
finding is rendered into `<runDir>/eval-extensions.md`:

```
🔴 a11y: Missing alt text on hero image in src/Home.tsx
🟡 contrast: Link color 4.2:1 (target 4.5:1)
🔵 extensions: No extension findings
```

The renderer maps `severity` → emoji with this exact table (see
`extensions.mjs` `fireVerdictAppend` around line 556):

| `severity` string | Rendered emoji |
|-------------------|----------------|
| `"error"`         | 🔴             |
| `"warning"`       | 🟡             |
| `"info"`          | 🔵             |
| anything else     | 🔵 (fallback)  |

The emoji is applied **only** by the pipeline renderer when it writes
`<runDir>/eval-extensions.md`. The `extension-test` CLI prints the literal
severity word instead (`warning`, `error`, `info`) with no emoji — see §9.
The same table drives the `extension-failures.md` sidecar (§8.2).

**Graceful-empty value:** `null`, `undefined`, or `[]`. All skipped silently.

**Wrong-shape penalty:** a non-array return records `bad-return` and is
ignored. Individual findings that don't match either shape are **silently
dropped with no failure record** — no `extension-failures.md` entry, no
stderr line. The finding simply never appears in `eval-extensions.md`. If
your finding vanishes, grep your payload against this checklist first:

- `severity` must be exactly one of the strings `"error"`, `"warning"`,
  `"info"` (lowercase, full word — `"warn"`, `"ERROR"`, `"err"` all drop).
- `category` must be a non-empty string (free-form lowercase identifier;
  any unknown category renders identically to known ones).
- `message` must be a string (empty string technically passes the shape
  check but renders as a blank line — don't).
- `file` is optional, must be a string when present. A wrong-typed `file`
  (e.g. number) causes the whole finding to drop, not just the field.
- `null` / `undefined` entries in the array drop.
- Extra fields are preserved on the object but only `severity`, `category`,
  `message`, `file` are rendered.

The dropped-finding trail is **visible only through what's missing**. When
in doubt, add a `process.stderr.write('[my-ext] emitting finding:', f)`
just before the return to confirm the shape.

**Example:**

```js
export async function verdictAppend(ctx) {
  if (!ctx?.runDir) return [];
  const findings = [];
  try {
    const report = await runAxeAudit(ctx.devServerUrl);
    for (const v of report.violations) {
      findings.push({
        severity: v.impact === "critical" ? "error" : "warning",
        category: "a11y",
        message: `${v.id}: ${v.description}`,
      });
    }
  } catch {
    return [];  // graceful degrade — see §6
  }
  return findings;
}
```

### 5.4 `executeRun(ctx)` — side-effectful verification

**Fires when:** the executor role runs `opc-harness extension-artifact` for a
node requiring your capabilities. Runs **before** `artifactEmit`.

**Signature:** `async (ctx) => any`

**Return value:** accepted but not enforced. Typical uses:
- Run Playwright to exercise the built UI
- Hit a local API endpoint
- Crawl the dev server and collect screenshots (save them yourself, or return
  them from `artifactEmit` — see §5.5)

**Graceful-empty value:** any value (or nothing). Unlike prompt/verdict, there
is no "empty" signal here — the return is not consumed.

**Wrong-shape penalty:** none. The only way `executeRun` gets a failure
record is by throwing or timing out.

**Example:**

```js
export async function executeRun(ctx) {
  if (!ctx?.devServerUrl) return;
  const res = await fetch(`${ctx.devServerUrl}/health`, { signal: AbortSignal.timeout(5000) })
    .catch(() => null);
  if (!res || !res.ok) {
    // Side effect only: log. No return value needed.
    process.stderr.write(`[my-ext] dev server not healthy, skipping\n`);
  }
}
```

### 5.5 `artifactEmit(ctx)` — write files to the run dir

**Fires when:** the executor role runs `opc-harness extension-artifact`.
Runs **after** `executeRun` in the same command.

**Signature:** `async (ctx) => Array<{ name: string, content: string | Buffer | ArrayBufferView }> | null | undefined`

**Each item:**
- `name` — a **plain basename** (no `/`, no `..`, not empty, not `.`).
  Anything that fails `path.basename()` equality or lands on these
  sentinels is skipped with a stderr WARN and no file is written.
  Note: on POSIX, backslash `\` is treated as a literal filename
  character — `foo\bar.png` becomes a single weirdly-named file, not a
  subdir. Sanitize upstream if you generate names from page titles /
  URLs / user input.
- `content` — accepted types (anything else is skipped with WARN, no
  failure record):
  - `string` (written as UTF-8)
  - `Buffer`
  - Any `ArrayBufferView` — `Uint8Array`, `Int8Array`, `DataView`, other
    TypedArrays. Modern APIs (`crypto.subtle.digest`, `TextEncoder`,
    Playwright `page.screenshot()`, `sharp(x).toBuffer()`) all return
    types that satisfy this.
  - **Not** supported: raw `ArrayBuffer` (wrap it: `new Uint8Array(buf)`),
    `Blob`, `ReadableStream`, `AsyncIterable<Uint8Array>`, `Promise<Buffer>`
    (await it first — `content: await page.screenshot()`, not
    `content: page.screenshot()`).
- Name collisions within a single `artifactEmit` return array
  (`[{name:"a.png", …}, {name:"a.png", …}]`) result in **last-write-wins**
  silently, since each item is written in turn to the same path. Ensure
  unique names yourself.

**Where files land:** `<runDir>/ext-<extname>/<name>`. Each emitted path is
appended to `handshake.artifacts[]` as `{ type: "ext-artifact", ext, path }`.

**Graceful-empty value:** return `null`, `undefined`, or `[]`. All skipped
silently.

**Wrong-shape penalty:** a non-array return records `bad-return`. Individual
items with invalid names / content types are skipped with stderr WARN but do
not record a failure record (they're logged, not tripped).

**Requires `ctx.runDir`:** if missing, the hook does not fire.

**Example:**

```js
import { chromium } from "playwright";

export async function artifactEmit(ctx) {
  if (!ctx?.devServerUrl || !ctx?.runDir) return [];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(ctx.devServerUrl, { timeout: 10_000 });
    const png = await page.screenshot();
    return [{ name: "homepage.png", content: png }];
  } catch {
    return [];  // degrade gracefully — see §6
  } finally {
    await browser.close();
  }
}
```

### 5.6 `startupCheck(ctx)` — load-time guard

Optional fifth hook. Fires **once at load time** from `loadExtensions()`, before
any capability matching. Throw to refuse to load. `ctx` is an empty object `{}`
at this call site.

```js
export async function startupCheck() {
  if (!process.env.API_KEY) {
    throw new Error("my-ext requires API_KEY env var");
  }
}
```

An optional extension whose `startupCheck` throws logs a WARN and is skipped
for the rest of the run. A **required** extension (listed in
`config.requiredExtensions`) whose `startupCheck` throws aborts the pipeline
with a FATAL error.

> Omitting `startupCheck` entirely is identical to exporting one that
> returns `undefined` — both succeed; the `✅ passed` line that
> `extension-test --all-hooks` prints for `startup.check` is
> **unconditional** (the return value is ignored by both the core and the
> CLI, §9). Export it only when you actually need the load-time guard.

---

## 6. Graceful degradation pattern

The golden rule: **never throw an uncaught error out of a hook**. The core
isolates you, but an empty-return skip is cleaner signal than a failure record.

Every well-behaved hook should handle three classes of environmental failure
by returning the hook's graceful-empty value (`""` for prompt, `[]` for
verdict/artifact, `undefined` for execute):

1. **External tool missing** — binary not on `PATH`, service not running.
2. **Unexpected file contents** — JSON parse failure, wrong shape.
3. **Slow / unavailable upstream** — network timeout.

**Copy-pasteable template:**

```js
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

// Cache CLI availability probe for the process lifetime.
let _cliCache = null;
function cliAvailable(bin) {
  if (_cliCache !== null) return _cliCache;
  const r = spawnSync("which", [bin], { encoding: "utf8", timeout: 1500 });
  _cliCache = r.status === 0;
  return _cliCache;
}

export async function promptAppend(ctx) {
  try {
    // (1) External tool missing → empty.
    if (!cliAvailable("my-tool")) return "";

    // (2) Input file missing / wrong shape → empty.
    const cfgPath = ctx?.flowDir ? `${ctx.flowDir}/my-ext.json` : null;
    if (!cfgPath || !existsSync(cfgPath)) return "";
    let cfg;
    try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { return ""; }
    if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.rules)) return "";

    // (3) Slow upstream → own timeout beats the core's 60s default.
    const r = spawnSync("my-tool", ["scan"], { encoding: "utf8", timeout: 3000 });
    if (r.status !== 0 || !r.stdout) return "";

    return `## my-ext\n\n${r.stdout.trim()}\n`;
  } catch (err) {
    // Last-resort catch — log, don't throw.
    process.stderr.write(`[my-ext] promptAppend degraded: ${err?.message || err}\n`);
    return "";
  }
}
```

**Why not throw and let the core handle it?** Because throwing increments the
failure streak toward the circuit breaker (§7.2) and writes a record to
`extension-failures.md`. That's the right behavior for bugs. For **expected**
environmental gaps (CLI not installed, offline mode) you want quiet no-op —
the user didn't ask you to fix their environment.

---

## 7. Timeout budgets & circuit breaker

### 7.1 Core-enforced timeout

Every hook invocation is wrapped with `withTimeout(fn, HOOK_TIMEOUT_MS)`. The
default is **60 seconds**, configurable via `OPC_HOOK_TIMEOUT_MS`. If your
hook hasn't resolved in time, the core throws a tagged `HookTimeoutError`,
records a `timeout` failure, logs a stderr WARN, and moves on to the next
extension. The circuit breaker (§7.2) counts timeouts exactly like throws.

### 7.2 Circuit breaker

After **`HOOK_FAILURE_THRESHOLD`** consecutive failures (default **3**,
configurable via `OPC_HOOK_FAILURE_THRESHOLD`), the core sets
`ext.enabled = false` for the remainder of the process. A `_circuit_breaker`
disabled record is written to the failure sidecar and a CIRCUIT-BREAKER line
is logged to stderr:

```
[opc] CIRCUIT-BREAKER: extension 'my-ext' disabled after 3 consecutive failures (last: timeout in prompt.append)
```

Once disabled, the extension's hooks are skipped until the process exits (or
an orchestrator calls `resetExtension(ext)` after fixing the root cause).

Set `OPC_HOOK_FAILURE_THRESHOLD=0` to disable the breaker (failures are still
recorded, but the extension never auto-disables).

**Key semantics:**
- **Consecutive**, not cumulative — any successful invocation resets
  `_failStreak` to 0.
- For `artifactEmit`, the streak only resets if **every** emitted item's
  write succeeded. A per-item write failure prevents the reset.

### 7.3 Your responsibility

The core timeout is a **safety net**, not a budget. For extensions that call
external tools (`memex`, `curl`, `playwright`, etc.), **set your own timeout
inside the hook** and return the graceful-empty value if it trips. Common
budgets:

| External call         | Your timeout    | Reason                                    |
|-----------------------|-----------------|-------------------------------------------|
| `which <bin>` probe   | 1.5 s           | Local — should be instant.                |
| Local CLI (e.g. grep) | 3 s             | Fast local work.                          |
| Headless browser nav  | 10 s            | Page load + one interaction.              |
| Total hook budget     | 20 s            | Leaves 3× slack under the 60 s core cap.  |

Own-timeout examples:

```js
// spawnSync timeout
spawnSync("memex", ["search", kw], { encoding: "utf8", timeout: 3000 });

// fetch timeout
await fetch(url, { signal: AbortSignal.timeout(5000) });

// Playwright
await page.goto(url, { timeout: 10_000 });
```

---

## 8. Failure sidecar — how your crashes surface

Every `prompt.append`, `verdict.append`, `execute.run`, `artifact.emit` failure
is recorded to `registry.failures[]` with this shape:

```js
{
  ext:     "my-ext",
  hook:    "prompt.append",
  kind:    "throw" | "timeout" | "bad-return" | "disabled",
  message: "…" /* first 500 chars of err.message */,
  at:      "2026-04-19T12:34:56.789Z",
}
```

When `runDir` is known (verdict/artifact phases, or promptContext on a node
with a latest run dir), the core writes two files:

### 8.1 `<runDir>/extension-failures.json` — source of truth

Machine-readable, cross-phase merged. Each CLI invocation in the same run dir
reads this file, unions its current failures (dedup on
`JSON.stringify([ext, hook, kind, message])`), and atomically rewrites it.

```json
{
  "failures": [
    { "ext": "my-ext", "hook": "prompt.append", "kind": "timeout",
      "message": "prompt.append timed out after 60000ms",
      "at": "2026-04-19T12:34:56.789Z" }
  ],
  "droppedTotal": 0
}
```

### 8.2 `<runDir>/extension-failures.md` — rendered view

Derived from the JSON sidecar, human/grep-readable:

```
# Extension Hook Failures

🟡 my-ext.prompt.append [timeout] prompt.append timed out after 60000ms @ 2026-04-19T12:34:56.789Z
🔴 other-ext._circuit_breaker [disabled] circuit-breaker tripped after 3 consecutive failures @ …
```

- 🔴 = `disabled` (circuit breaker tripped)
- 🟡 = `throw` | `timeout` | `bad-return`

The filename intentionally lacks the `eval-` prefix so evaluator-markdown
ingestion does not mistake infrastructure failures for role findings.

### 8.3 Cap & drops

`registry.failures[]` is capped at **200 entries** (overridable via
`OPC_HOOK_FAILURE_LOG_CAP`). Oldest entries are dropped FIFO; a running
`droppedTotal` is surfaced in both the JSON sidecar and the rendered
`> Note: N earlier failure record(s) dropped (cap=200).` line.

### 8.4 Strict mode

Setting `OPC_STRICT_EXTENSIONS=1` turns any recorded failure into a non-zero
process exit (code `2`) **after** the current phase has finished writing its
reports. Isolation is preserved — healthy siblings still produce output — but
CI builds fail loud instead of quiet.

---

## 9. `extension-test` CLI reference

```
opc-harness extension-test --ext <path> [--hook <hookname>] [--all-hooks] [--context <json>]
```

| Flag            | Type     | Default | Meaning                                                       |
|-----------------|----------|---------|---------------------------------------------------------------|
| `--ext <path>`  | required | —       | Path to the extension directory (containing `hook.mjs`).      |
| `--hook <name>` | optional | —       | Run a single hook by its kebab name: `prompt.append`, `verdict.append`, `execute.run`, `artifact.emit`, `startup.check`. |
| `--all-hooks`   | flag     | false   | Run every hook exported by the extension.                     |
| `--context <json>` | optional | `{}` | JSON string passed as `ctx` to each hook.                     |
| `--help`        | flag     | —       | Print usage to stderr and exit 0.                             |

**Behavior:**

1. Imports `hook.mjs`.
2. Runs `lintCapability` over `meta.provides` and `meta.compatibleCapabilities`,
   printing `[lint] ⚠️` lines for any failures.
3. Invokes each requested hook with the parsed `--context` object and prints
   a `✅ <hook>` / `❌ <hook>` line per hook.
4. Exits **0** even if individual hooks fail — `extension-test` is a lint
   command, not a pass-fail gate.
5. Non-zero exit is reserved for **load-time errors**: missing `--ext`, no
   `hook.mjs`, bad `--context` JSON, or neither `--hook` nor `--all-hooks`
   specified.

**What `extension-test` does and does NOT do:**

- `--all-hooks` runs exactly **three** hooks: `startup.check`,
  `prompt.append`, `verdict.append`. It does **not** run `execute.run` or
  `artifact.emit` — those need a live `runDir` and are exercised by the
  pipeline commands `extension-artifact` / `extension-verdict` against a
  real `.harness/` tree.
- To test `artifact.emit` via `extension-test`, pass `--hook artifact.emit`
  explicitly and put a writable `runDir` into `--context`. The command
  does **not** auto-create a tmpdir; if `runDir` is missing the hook
  short-circuits inside the core (see §5.5) and you'll see `✅` with no
  files written.
- `extension-test` calls your hook function **directly** (no `fire*Append`
  wrapper). The core timeout, circuit breaker, and failure sidecar are
  **not** exercised — a throw in your hook is reported as `❌` but no
  `extension-failures.md` is written. For end-to-end integration with
  those guards, use the pipeline commands below.
- Return values from `startupCheck` are ignored by the core (only throw vs
  not-throw matters); `extension-test` prints a generic `✅ passed` for
  `startup.check` regardless of what you return. Use the return value for
  your own diagnostic output if useful.
- `extension-test` does **not** run capability routing. `nodeCapabilities`
  in `--context` is passed through to your hook verbatim, but the CLI
  invokes every requested hook **unconditionally** once it's exported
  (see `ext-commands.mjs:213-222`). It does **not** evaluate
  `ctx.nodeCapabilities ∩ (provides ∪ compatibleCapabilities)`. To
  observe the routing rule (§4.5) in action, use the pipeline commands
  (`prompt-context`, `extension-verdict`, `extension-artifact`) — they
  go through `firePromptAppend` / `fireVerdictAppend` / `fireArtifactEmit`
  which do enforce the intersection check.

**Output format per hook** (stdout — grep-friendly):

- `startup.check` → `[startup.check] ✅ passed (Nms)`
- `prompt.append` → `[prompt.append] ✅ returned N chars (Nms)`, followed
  by a preview block (first 200 chars) when the return is non-empty:
  ```
    --- output preview ---
    <first 200 chars, newlines re-indented by two spaces>
    ---------------------
  ```
- `verdict.append` → `[verdict.append] ✅ returned N findings (Nms)`,
  followed by one indented line per finding:
  ```
    <severity> [<category>] <message>
  ```
  **`severity` is the literal lowercase word (`error` / `warning` /
  `info`) — NOT the 🔴/🟡/🔵 emoji. The `file` field is not echoed.**
  Emoji appear only in `eval-extensions.md`, which is written by
  `fireVerdictAppend` inside the pipeline commands (see §5.3 table).
  To see emoji output, run `opc-harness extension-verdict …` against a
  real `.harness/` tree and read `<runDir>/eval-extensions.md`.
- `execute.run` / `artifact.emit` / any other hook →
  `[<hook>] ✅ result: <JSON.stringify(result)>`
- A thrown hook → `[<hook>] ❌ error: <err.message>` (the CLI still
  exits 0; only load-time errors cause non-zero exit).

> **Noise note (G5).** If you see `⚠️  ~/.claude/flows/ is deprecated —
> use --flow-file instead. Found: <files>` on stderr during
> `extension-test`, that banner is unrelated to your extension. It comes
> from the global flow-template bootstrap in `flow-templates.mjs` and
> fires once per process whenever `~/.claude/flows/*.json` exists.
> Silence it with `OPC_QUIET_DEPRECATIONS=1`, or migrate those JSONs to
> explicit `--flow-file` invocations.

**Examples:**

```bash
# Lint + run all hooks with an empty context.
opc-harness extension-test --ext ./my-ext --all-hooks

# Run only promptAppend with a realistic context.
opc-harness extension-test \
  --ext ./my-ext \
  --hook prompt.append \
  --context '{"task":"build signup page","nodeCapabilities":["context-enrichment@1"],"role":"builder"}'

# Verify startup check only.
opc-harness extension-test --ext ./my-ext --hook startup.check
```

**Related pipeline commands** (these run your extensions inside a real flow):

```
opc-harness prompt-context     --node <id> --role <role> --dir <harness-dir>
opc-harness extension-verdict  --node <id>               --dir <harness-dir>
opc-harness extension-artifact --node <id>               --dir <harness-dir>
opc-harness config resolve     [--dir <p>]
```

All three pipeline commands accept the bypass flags `--no-extensions` (disable
every extension for this invocation) and `--extensions a,b` (whitelist only
the named extensions). `config resolve` prints the merged OPC config with
its `_source` map so you can debug why a given option won.

---

## 10. Full minimal example — memex-recall

The reference "smallest real extension" ships at
`~/.claude/skills/opc/examples/extensions/memex-recall/`. Reading it end-to-end
is the fastest way to internalize every pattern this guide teaches.

### 10.1 `ext.json`

```json
{
  "name": "memex-recall",
  "version": "0.1.0",
  "description": "promptAppend hook that enriches review/build prompts with 1-3 relevant Zettelkasten notes via `memex search`. Graceful no-op when memex CLI is absent.",
  "meta": {
    "provides": ["context-enrichment@1"],
    "compatibleCapabilities": ["verification@1", "execute@1", "design-review@1"]
  }
}
```

### 10.2 `hook.mjs` — structure walkthrough

```js
import { spawnSync } from "node:child_process";

export const meta = {
  provides: ["context-enrichment@1"],
  compatibleCapabilities: ["verification@1", "execute@1", "design-review@1"],
};

const MEMEX_TIMEOUT_MS = 3000;    // single search budget
const TOTAL_BUDGET_MS  = 6000;    // hard cap across all searches
const MAX_KEYWORDS     = 5;
const MAX_RESULTS      = 3;

// Cache the `which memex` result for the process lifetime — avoid
// re-probing on every promptAppend call.
let _cliAvailableCache = null;
function cliAvailable() {
  if (_cliAvailableCache !== null) return _cliAvailableCache;
  const r = spawnSync("which", ["memex"], { encoding: "utf8", timeout: 1500 });
  _cliAvailableCache = r.status === 0;
  return _cliAvailableCache;
}

// Load-time guard: log whether memex is reachable, but do not throw.
// Missing CLI is a degraded state, not a load failure.
export function startupCheck() {
  if (!cliAvailable()) {
    process.stderr.write(`[memex-recall] WARN: memex CLI not in PATH — promptAppend will no-op\n`);
    return { ok: true, available: false };
  }
  return { ok: true, available: true };
}

function extractKeywords(text) {
  // (Tokenize, lowercase, filter stopwords, cap at MAX_KEYWORDS.)
  // Elided for brevity — see the reference file.
  return [];
}

function memexSearch(keyword) {
  try {
    const r = spawnSync("memex", ["search", keyword], {
      encoding: "utf8",
      timeout: MEMEX_TIMEOUT_MS,
    });
    if (r.status !== 0) return [];
    return (r.stdout || "").split("\n").filter(Boolean).slice(0, MAX_RESULTS);
  } catch {
    return [];
  }
}

export function promptAppend(ctx) {
  try {
    // (1) Environmental guard.
    if (!cliAvailable()) return "";

    // (2) Pull the task, fall back through a few ctx field names.
    const task = ctx?.task || ctx?.taskDescription || ctx?.acceptanceCriteria || "";
    const keywords = extractKeywords(task);
    if (keywords.length === 0) return "";

    // (3) Time-boxed fan-out with a global deadline.
    const hits = new Set();
    const deadline = Date.now() + TOTAL_BUDGET_MS;
    for (const kw of keywords) {
      if (Date.now() >= deadline) break;
      for (const hit of memexSearch(kw)) {
        if (hits.size >= MAX_RESULTS) break;
        hits.add(hit);
      }
      if (hits.size >= MAX_RESULTS) break;
    }
    if (hits.size === 0) return "";

    // (4) Render the markdown section.
    const items = [...hits].map((h) => `- ${h}`).join("\n");
    return `\n## 相关历史笔记\n\n${items}\n`;
  } catch (err) {
    // (5) Last-resort catch — degrade to empty, log to stderr.
    process.stderr.write(`[memex-recall] WARN: promptAppend failed: ${err?.message || err}\n`);
    return "";
  }
}
```

### 10.3 What to notice

- **No throws.** Every failure path returns `""`.
- **Own timeouts.** `spawnSync` gets `timeout: 3000`; the outer loop has a
  `TOTAL_BUDGET_MS` deadline; the core's 60 s safety net is never hit.
- **Versioned capabilities.** `context-enrichment@1` — no bare-name warning.
- **Compatible capabilities.** Still matches older `verification@1`,
  `execute@1`, `design-review@1` nodes during migration.
- **Defensive ctx access.** `ctx?.task || ctx?.taskDescription || …` — no
  crash when a caller omits a field.
- **Cheap reload.** `cliAvailable()` caches its probe; module re-import
  during dev doesn't hammer `which`.

Copy this structure. Rename. Ship.

---

## Change log

U4.1r → U4.1 fix-pair. Entries tagged with originating reviewer + finding ID.

- **[A1]** Added §0 Prerequisites: `npm i -g @touchskyer/opc` install vs
  `node bin/opc-harness.mjs` fallback, sanity-check command.
- **[A2]** Added §0 `~/.opc/` bootstrap paragraph: directory is not required
  to pre-exist, `OPC_EXTENSIONS_DIR` override, no other scaffolding needed.
- **[A3 + friction-§5-mapping]** Added §1.2 hook name mapping table
  (camelCase ↔ kebab+dot), explicit duplicate-export precedence (kebab
  wins), unknown-export silent-ignore rule.
- **[B1]** Added §1.1 Execution model: sequential per call site,
  alphabetical ordering (with `config.extensionOrder` override), sibling
  isolation on throw, no cross-call-site ordering guarantee.
- **[B2]** Added §1.1 `ctx` mutability paragraph: shared reference, do not
  mutate, treat as read-only.
- **[B3]** Added §4.1 "No semver" paragraph: integer generations only,
  explicit examples of what fails lint.
- **[B4]** Rewrote §5.3 wrong-shape paragraph: explicit checklist of what
  passes the validation predicate, "dropped with no failure record"
  stated, debug guidance.
- **[A-friction §5 title]** Retitled §5 from "The 4 hooks" to "The hooks",
  stated 4-per-node + 1-load-time.
- **[A-friction execution model]** Covered by §1.1 (in-process, full Node
  privileges, `process.exit` kills harness).
- **[A-friction timeout cooperative]** §1.1 now states cooperative-timeout
  semantics explicitly: in-flight subprocesses/promises keep running.
- **[A-friction no matching ext]** §4.5 now documents silent no-op when no
  extension matches + debugging commands.
- **[A-friction case sensitivity]** §4.5 now states case-sensitive exact
  equality + lint failure = never-matches.
- **[A-friction extension-test artifactEmit]** §9 now has a "does and does
  NOT do" block: `--all-hooks` only covers 3 hooks; `artifact.emit` needs
  explicit `--hook` + `runDir`; no auto-tmpdir; timeouts/breaker not
  exercised.
- **[A-friction startupCheck return]** §9 block states return value is
  ignored; `extension-test` prints generic pass regardless.
- **[A-friction multi-ext ordering]** Covered by §1.1 (alphabetical) +
  §5.5 note on intra-emit collisions.
- **[B-friction binary types]** §5.5 content list expanded: explicit
  supported types, explicit unsupported types (ArrayBuffer, Blob,
  ReadableStream, unawaited Promise), name-collision last-write-wins
  rule.
- **[B-friction backslash]** §5.5 notes POSIX basename treats `\` as
  literal character.

Deliberately deferred (need speculation beyond current source):

- **[B-friction error-vs-empty decision rule]** A categorical throw-vs-return
  rule is editorial advice that the source cannot confirm; §6 already
  enumerates three environmental classes. Future Run 4 lesson-learned pass
  may formalize.
- **[B-friction unit-test story]** No `makeTestRegistry` / `makeTestCtx`
  helper exists in source; documenting an imagined API would be invention.
  Authors can build their own with the Appendix B exports.
- **[B-friction sidecar schema version]** The code does not emit a
  `schemaVersion` field today; promising one would misrepresent current
  behavior. Future-proofing left to a real schema-evolution change.
- **[B-friction breaking-change policy]** SemVer commitments for the public
  surface require coordination with the packaging story; out of scope for
  a docs patch.
- **[B-friction breaker per-item trail]** Current source records per-item
  WARNs but not sidecar entries — existing behavior documented, policy
  change deferred.
- **[A-nit circuit-breaker-reset / Appendix B import path / timeout-table
  advisory]** Left unchanged — editorial nits that don't block newcomer
  first-hour success.

---

## Lessons from Run 4 outsider-build

Run 4 validated this guide by having an outsider agent (read: the doc + the
starter template, nothing else) build `lint-prompt-length`. The following
gaps were caught by the outsider or the two reviewers and patched in this
revision.

### G1 — severity → emoji mapping
- **Before:** §5.3 showed rendered emojis in an example block but never stated the mapping.
- **After:** explicit table in §5.3 (`error→🔴`, `warning→🟡`, `info→🔵`, else→🔵) with a source pointer to `extensions.mjs` `fireVerdictAppend`.

### G2 — `extension-test` stdout format
- **Before:** §9 said "prints a ✅ `<hook>` / ❌ `<hook>` line per hook" and stopped there.
- **After:** §9 now has an "Output format per hook" subsection documenting each hook's exact stdout: `startup.check` fixed `✅ passed`, `prompt.append` with preview block, `verdict.append` findings as literal `  <severity> [<category>] <message>` — no emoji, no `file`.

### G3 — `ext.json.name` field
- **Before:** §3.2 example had `"name": "memex-recall"` and prose only said "descriptive only".
- **After:** §3.2 explicitly states `name` is cosmetic; directory name always wins; starter omits it deliberately; both styles are legal.

### G4 — `meta.name` on `hook.mjs` exports
- **Before:** every example meta had `name: "…"`; no statement on whether it was required.
- **After:** §3.3 has a callout: `meta.name` is not read by the loader; omit it; example `name:` fields remain for historical reasons only.

### G5 — `~/.claude/flows/` deprecation banner on `extension-test` stderr
- **Before:** undocumented harness-wide noise; newcomers assumed it was their fault.
- **After:** §9 has a "Noise note" explaining the banner comes from `flow-templates.mjs`, is unrelated to extensions, and can be silenced with `OPC_QUIET_DEPRECATIONS=1`. Appendix A now lists that env var.

### MG1 — §9 self-contradiction on capability routing
- **Before:** one bullet said `extension-test` calls hooks directly (no `fire*Append` wrapper); another invited you to remove `nodeCapabilities` from `--context` to "feel the routing rule". The second was false — `ext-commands.mjs:213-222` invokes hooks unconditionally.
- **After:** replaced the misleading bullet with an explicit statement that `extension-test` does **not** run routing; use the pipeline commands (`prompt-context` / `extension-verdict` / `extension-artifact`) to exercise §4.5.

### MG2 — `ctx.task` type contract under `extension-test --context`
- **Before:** §5.1 documented `ctx.task` as string; §9 didn't warn that `--context <json>` is passed through verbatim.
- **After:** §5.1 now warns: pipeline commands guarantee a string (possibly `""`), but `extension-test --context` can send `undefined` / `42` / arrays / objects. Prefer a `typeof task === "string"` guard over `?? ""` for any schema-typed field.

### Reviewer A unlogged (A) — no catalog of canonical core capabilities
- **Before:** §4.4 used an abstract `visual-check@1/@2` example; §10.1 showed the `verification@1 / design-review@1 / execute@1` triple without labelling it. Authors cargo-culted.
- **After:** new §4.7 "Canonical core capabilities" tabulates the capability strings stamped by `flow-templates.mjs` built-ins plus the widely-reused generic triple.

### Reviewer A unlogged (B) — `ctx.task` ≠ assembled prompt
- **Before:** §5.1 typed `task` as "task description" without contrasting it with the assembled prompt. Outsider building a "lint prompt length" hook silently equated the two.
- **After:** §5.1 states there is no `ctx.assembledPrompt`; a hook cannot observe downstream concatenation of `promptAppend` outputs. Measure the inputs, or emit the finding from inside `promptAppend` via a stderr side-channel.

### Reviewer A unlogged (C) — `startupCheck` return-value wording
- **Before:** §5.6 was silent on whether omitting `startupCheck` differed from returning `undefined`; §9 said return is ignored.
- **After:** §5.6 adds a callout that omitting the hook is identical to returning `undefined`; the `✅ passed` emoji is unconditional.

---



| Variable                          | Default                        | Effect                                                                  |
|-----------------------------------|--------------------------------|-------------------------------------------------------------------------|
| `OPC_EXTENSIONS_DIR`              | `~/.opc/extensions`            | Directory scanned for extension subdirs.                                |
| `OPC_HOOK_TIMEOUT_MS`             | `60000`                        | Core safety-net timeout per hook invocation.                            |
| `OPC_HOOK_FAILURE_THRESHOLD`      | `3`                            | Consecutive failures before circuit breaker trips (`0` disables).       |
| `OPC_HOOK_FAILURE_LOG_CAP`        | `200`                          | Max entries in `registry.failures[]` before FIFO drops.                 |
| `OPC_DISABLE_EXTENSIONS`          | unset                          | `1` → load zero extensions (benchmark mode).                            |
| `OPC_STRICT_EXTENSIONS`           | unset                          | `1` → exit code `2` if any failure was recorded this process.           |
| `OPC_QUIET_DEPRECATIONS`          | unset                          | `1` → silence the once-per-process `⚠️  ~/.claude/flows/ is deprecated …` banner emitted by `flow-templates.mjs`. |

## Appendix B — Public exports from `extensions.mjs`

Useful for authoring tests or orchestrator glue code:

| Export                         | Purpose                                                       |
|--------------------------------|---------------------------------------------------------------|
| `loadExtensions(config)`       | Scan, load, run `startupCheck`, return `{ extensions, applied, failures }`. |
| `firePromptAppend(reg, ctx)`   | Run all matching `prompt.append` hooks; return concatenated string. |
| `fireVerdictAppend(reg, ctx)`  | Run all matching `verdict.append` hooks; write `eval-extensions.md` + failure sidecar. |
| `fireExecuteRun(reg, ctx)`     | Run all matching `execute.run` hooks; return `[{ ext, result }]`. |
| `fireArtifactEmit(reg, ctx)`   | Run all matching `artifact.emit` hooks; write files; return ext-artifact entries. |
| `normalizeHook(raw, mod)`      | Canonicalize any export shape to `{ hooks: { ... } }`.        |
| `normalizeCapability(cap)`     | `foo` → `foo@1` (with WARN); pass-through if already versioned. |
| `lintCapability(cap)`          | `{ ok, reason }` shape — used by `extension-test`.            |
| `resetExtension(ext)`          | Clear breaker state after fixing root cause.                  |
| `resolveBypass(config)`        | Resolve `--no-extensions` / `--extensions` / env precedence.  |
| `writeFailureReport(reg, dir)` | Merge & write `extension-failures.{json,md}`.                 |
| `survivingExtensions(reg)`     | Names of still-enabled extensions at stamp time.              |
| `strictModeEnabled()`          | Read `OPC_STRICT_EXTENSIONS`.                                 |
| `enforceStrictMode(reg)`       | Exit `2` if strict mode is on and failures exist.             |
| `saveRegistryCache(dir, reg)`  | Persist `.ext-registry.json` in `dir`.                        |
| `readRegistryApplied(dir)`     | Read `applied[]` back from that cache.                        |
| `HookTimeoutError`             | Tagged `Error` subclass for timeout classification.           |

That's the full public surface. Anything not listed here is internal — don't
depend on it.
