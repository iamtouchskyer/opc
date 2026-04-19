# `_starter` — drop-in OPC extension template

> Copy this directory, change one field, run one command, ship.

---

## 1. What this is (30-second pitch)

`_starter/` is the canonical, **zero-dependency**, copy-paste skeleton for a
new OPC extension. It contains:

- `ext.json` — the manifest
- `hook.mjs` — all five hooks (`startupCheck`, `promptAppend`,
  `verdictAppend`, `executeRun`, `artifactEmit`) stubbed to their
  graceful-empty return values, with `// TODO(starter):` markers at every
  decision point
- `README.md` — this file

Every hook is wired to **return cleanly** the moment you copy it, so
`opc-harness extension-test --all-hooks` exits 0 before you've written a
line of business logic. You can iterate one hook at a time without
breaking the rest of the pipeline.

If you're new to OPC extensions, read
[`docs/extension-authoring.md`](../../../docs/extension-authoring.md) first
— that doc is the reference; this template is the on-ramp.

---

## 2. Copy + rename recipe

Pick a name in `kebab-case`. **The directory name IS the canonical extension
name** — it's what the loader reads (`bin/lib/extensions.mjs:366-368,453`),
and what shows up in logs, failure sidecars, and artifact subdirs as
`ext-<name>/`. `ext.json.name` is NOT read by the loader; just name the
directory what you want the extension called.

Locate the starter (pick whichever path exists on your box):

```bash
# If you installed the skill globally:
STARTER=~/.claude/skills/opc/examples/extensions/_starter
# Or from a repo checkout:
# STARTER=/path/to/opc-checkout/examples/extensions/_starter
# Or via npm global install:
# STARTER="$(npm root -g)/@touchskyer/opc/examples/extensions/_starter"
[ -d "$STARTER" ] || { echo "can't find _starter — clone the opc repo first"; exit 1; }

# Copy into the OPC extensions dir (OPC_EXTENSIONS_DIR overrides ~/.opc/extensions).
cp -r "$STARTER" "${OPC_EXTENSIONS_DIR:-$HOME/.opc/extensions}/my-ext"
cd "${OPC_EXTENSIONS_DIR:-$HOME/.opc/extensions}/my-ext"
```

That's it. The extension is now discoverable as `my-ext`.

> **Pre-flight:** the headline `opc-harness extension-test` command in §4
> is available on the bundled harness (`node <opc-repo>/bin/opc-harness.mjs`).
> Globally-installed binaries from brew or older npm tags may predate the
> extension loader and will silently print a usage banner + exit 0 instead
> of running the subcommand. If `opc-harness extension-test --help` prints
> the generic banner, use the bundled path explicitly:
> `node ~/.claude/skills/opc/bin/opc-harness.mjs extension-test …`.

---

## 3. Edit checklist

Open the two files in this order. Touch only what you need; the defaults
are safe.

### 3.1 `ext.json`

`ext.json` is **descriptive only** — the loader never parses it (only `hook.mjs`
is imported). Package indexes and `opc-harness config resolve` may read it for
human-visible fields.

| Field                          | What to set                                                              |
|--------------------------------|--------------------------------------------------------------------------|
| `version`                      | Your extension's version. Informational only.                            |
| `description`                  | One-line human summary. Shown by tooling; keep `meta.description` in `hook.mjs` in sync. |
| `meta.provides`                | The capability you provide, in `name@N` format. **Required in `hook.mjs`.** |
| `meta.compatibleCapabilities`  | Older capability generations you also respond to. Optional.              |

> The loader reads `meta` from `hook.mjs`, not `ext.json`. The table above is
> for human readers + tooling only; only the values inside `hook.mjs` affect
> routing. Keep them in sync for hygiene.

`name@N` rules (lifted from `extension-authoring.md` §4.1):

- Lowercase ASCII letter start, then `[a-z0-9-]*`
- Literal `@`
- Positive integer (no `@0`, no leading zeros, no semver ranges)

Examples: `visual-check@1`, `a11y-audit@2`. Bare `foo` is auto-upgraded to
`foo@1` with a one-time stderr WARN — declare `foo@1` explicitly to silence
it.

> **Why both `provides` and `compatibleCapabilities`?** During capability
> migrations (say, `visual-check@1` → `visual-check@2`), put the new
> generation in `provides` and the old one in `compatibleCapabilities` so
> nodes on either side keep matching.

### 3.2 `hook.mjs`

The file is organised so you can implement hooks one at a time:

1. **`startupCheck`** — fastest win. If your extension needs an env var or
   an external CLI, probe it here. **Never throw** unless you genuinely
   want the extension disabled for the whole process.
2. **`promptAppend`** — most common first hook. Returns markdown to append
   to the role prompt.
3. **`verdictAppend`** — evaluator-phase findings. Returns an array.
4. **`executeRun`** — executor-phase side effects (Playwright, curl, etc.).
   Return value is ignored.
5. **`artifactEmit`** — executor-phase file emission. Returns
   `[{ name, content }]`; each lands at `<runDir>/ext-<name>/<name>`.

**You can delete any hook you don't need.** The loader treats missing
exports as "not implemented" — there is no runtime cost. Deleting unused
hooks is the recommended way to trim the file once you know what you're
shipping.

Search the file for `TODO(starter):` — every marker is a decision point.
Replace each one with your logic, or delete the surrounding hook.

---

## 4. Test it

From the OPC repo root (or wherever `opc-harness` is on your `PATH`):

```bash
# Lint manifest + run the three hooks `--all-hooks` covers
# (startup.check, prompt.append, verdict.append).
opc-harness extension-test \
  --ext "${OPC_EXTENSIONS_DIR:-$HOME/.opc/extensions}/my-ext" \
  --all-hooks
```

Expected output: a `✅` line per hook. **Exit code must be 0.** `[lint]`
lines only appear when capability strings fail validation. A non-zero exit
means the extension failed to load (missing `hook.mjs`, bad JSON in
`--context`, etc.) — fix that before touching hook bodies.

To exercise `executeRun` or `artifactEmit`, name the hook explicitly and
provide a writable `runDir`:

```bash
opc-harness extension-test \
  --ext "${OPC_EXTENSIONS_DIR:-$HOME/.opc/extensions}/my-ext" \
  --hook artifact.emit \
  --context '{"runDir":"/tmp/opc-smoke","nodeCapabilities":["my-capability@1"]}'
```

(`--all-hooks` deliberately skips `execute.run` / `artifact.emit` because
they need a real `runDir`. See `docs/extension-authoring.md` §9.)

---

## 5. Common pitfalls — "why isn't my hook firing?"

The four scenarios that account for ~all "silently no-op" reports:

1. **Capability mismatch.** The node's `nodeCapabilities` does not
   intersect `meta.provides ∪ meta.compatibleCapabilities`. Routing is
   case-sensitive exact-string after normalization. Verify with
   `opc-harness config resolve` (lists loaded extensions and their
   provides) and double-check the node's required capabilities in the
   flow template.

2. **Wrong export name.** Unknown exports are silently ignored. A typo
   like `prommptAppend` will load fine and never fire. Cross-check exports
   against the §1.2 mapping table — the canonical names are
   `promptAppend`, `verdictAppend`, `executeRun`, `artifactEmit`,
   `startupCheck`.

3. **Empty / missing `nodeCapabilities` in `ctx`.** When
   `ctx.nodeCapabilities` is missing, empty, or not an array, **no**
   extensions fire for that call site. When testing via
   `extension-test --context '...'`, include
   `"nodeCapabilities": ["my-capability@1"]`.

4. **Circuit breaker tripped.** Three consecutive failures (throw /
   timeout / wrong-shape return) in a single process disable the
   extension for the rest of the run. Look for a `CIRCUIT-BREAKER` line
   on stderr and an `extension-failures.md` next to the run dir. Fix the
   root cause; the breaker resets the next time the harness boots.

---

## 6. Next steps

- **Read** [`docs/extension-authoring.md`](../../../docs/extension-authoring.md)
  end-to-end. It is the source of truth for hook contracts, timeouts,
  the failure sidecar, and the circuit breaker.
- **Study** [`examples/extensions/memex-recall/`](../memex-recall/) — the
  canonical "smallest real extension" with caching, own-timeouts, and
  graceful degradation.
- **Borrow** the graceful-degradation template in
  `extension-authoring.md` §6 the moment you start calling external CLIs
  or hitting the network.

Ship it.
