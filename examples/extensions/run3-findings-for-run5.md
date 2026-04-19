# Findings for Run 5 — Core surfaces surfaced during Run 3

**Baseline:** `ext-run-3-done` (to be tagged at end of U3.7)
**Scope:** OPC core bugs / friction points observed while building 5 real
extensions. No patches applied in Run 3 — all deferred to Run 5 per the
"no core modifications" constraint.

## Summary

Run 3 surfaced **no blocking core bugs**. The v0.5.1 extension surface held
up end-to-end for 5 independently-authored extensions covering all 4 hook
types (prompt.append, verdict.append, execute.run, artifact.emit) and 3
node-capability classes (verification@1, design-review@1, execute@1).

The items below are **friction / ergonomics**, not correctness. Each is
actionable with a small, well-scoped patch.

## F1 — `fireVerdictAppend` return value is opaque (side-effect only)

**Where:** `bin/lib/extensions.mjs` — `fireVerdictAppend` writes
`eval-extensions.md` as a side-effect and returns `undefined`.

**Observed during:** U3.6 integration driver v1. First attempt read
`.length` on the return value and crashed. The v1 driver had to be rewritten
to parse `eval-extensions.md` after the call. This is inconsistent with
`firePromptAppend` which returns the injected string directly.

**Suggested Run 5 fix:** Return `{findings, filePath}` so callers can inspect
the merged finding set without re-parsing the markdown. Backward-compat by
leaving `filePath` present and `findings` as a structured array.

**Severity:** 🟡 ergonomic (no correctness issue — docs never promised a
return value).

## F2 — `nodeCapabilities` is required for routing but easy to omit

**Where:** `extensionMatches()` silently matches nothing when `ctx.nodeCapabilities`
is `undefined` or `[]`. Drivers that forget to set it see zero fires across
all hook types, which is indistinguishable from "no extension matched".

**Observed during:** U3.6 driver v1. Spent time debugging apparent
loadExtensions failure before noticing the missing array.

**Suggested Run 5 fix:** When `nodeCapabilities` is absent, emit a single-line
WARN via `stderr` (`[extensions] WARN: ctx.nodeCapabilities not set — no hooks will match`).
Do not throw; the current silent-match-nothing behavior is the correct
production default, just needs an observability hint.

**Severity:** 🔵 informational.

## F3 — Extension-test command has no fixture-dir convention

**Where:** `opc-harness extension-test --ext <path> --hook <name> --context <json>`.

**Observed during:** U3.4/U3.5. Tests that need `flowDir` with seeded files
(`.harness-run3-integration/flow-state.json`, `artifacts/tiny.png`) have to
inline `mkdtemp + writeFileSync + JSON.stringify` in shell, which makes the
tests hard to read and maintain.

**Suggested Run 5 fix:** Add `--fixture-dir <path>` flag that is copied into
a tmp dir and passed as `ctx.flowDir`. Optional `--fixture-describe` that
prints the tree to stderr for debugging.

**Severity:** 🔵 ergonomic.

## F4 — No built-in way to assert "extension X DID fire"

**Where:** The integration driver had to read `eval-extensions.md` body and
grep for category substrings (`h_git_changeset_fires_in_repo`,
`i_session_logex_fires`). This is brittle — a capitalization change or emoji
reorder would break it.

**Suggested Run 5 fix:** Write a machine-readable sidecar
`eval-extensions.json` alongside the markdown, keyed by extension name →
findings array. Integration tests assert against JSON, users read markdown.

**Severity:** 🟡 test-quality.

## F5 — Circuit-breaker state is per-CLI-invocation, not per-flow

**Where:** v0.5.1 fixed cross-command failure merge via JSON sidecar. But
the circuit-breaker counter itself resets on each `node` invocation, so an
extension that trips timeout in `cmdPromptContext` still gets called by
`cmdExtensionVerdict` in the same flow.

**Observed during:** Not hit in Run 3 because no extension timed out
repeatedly. But visual-eval's 60s Python subprocess is a realistic candidate.

**Suggested Run 5 fix:** Persist breaker state in
`.harness/.extension-state.json` keyed by extension name; reload at
`loadExtensions` time and respect "tripped" status across CLI invocations
within the same flow. Reset on flow init.

**Severity:** 🟡 reliability.

## F6 — No lint for `meta.compatibleCapabilities` vs `meta.provides`

**Where:** An extension can declare `provides: ["foo@1"]` and
`compatibleCapabilities: ["execute@1"]` — legal but likely a mistake if the
extension only implements `verdictAppend`. (Session-logex actually had
`execute@1` in its initial compatibleCapabilities; dropped in U3.5r.)

**Suggested Run 5 fix:** `opc-harness extension-test --lint` warns when
`compatibleCapabilities` includes capabilities that don't match the set of
exported hook functions. Not an error (soft overlap is valid), just a
hint.

**Severity:** 🔵 lint-quality.

## F7 — `opc-harness --help` omits extension subcommands (Run 4 finding)

**Where:** `opc-harness --help` banner output.

**Context:** Reviewer A (U4.2r) live-tested the `_starter` README's headline
command `opc-harness extension-test --ext … --all-hooks` against a brew-
installed `opc-harness` on PATH. The brew binary printed the generic usage
banner and exited 0 — no "unknown subcommand" error, no hint. Even switching
to the bundled `node bin/opc-harness.mjs --help`, `grep -i ext` on the help
text returns no matches. The `extension-test` / `prompt-context` /
`extension-verdict` / `extension-artifact` / `config resolve` subcommands are
fully implemented but undiscoverable from `--help`.

**Risk at scale:** Junior devs following the starter README think the
command doesn't exist (or worse, think their extension passed because
exit code is 0). Distribution drift between brew / npm-global / bundled
harnesses compounds the confusion.

**Suggested Run 5 fix:** Add an "Extension commands:" section to the
`--help` banner in `bin/opc-harness.mjs` listing `extension-test`,
`prompt-context`, `extension-verdict`, `extension-artifact`, and
`config resolve` with one-line descriptions. Starter-side mitigation
(in U4.2r README §2) directs users to the bundled binary and flags the
brew/stale-global gotcha until v0.7 ships the help update.

**Severity:** 🟡 discoverability — silent no-op for users on stale binaries.

## Not deferred — fixed in Run 3 itself

These were caught by U3.*r reviewers and fixed in fix-pair commits without
core changes:

- U3.3: CJK-aware stopword filter + CLI-check cache (memex-recall)
- U3.4: basename lockfile match + `--no-renames` + `core.quotepath=false` +
  hasGit cache (git-changeset-review)
- U3.5: sentinel-bounded walk + `.logex-nudged` dedup + `.harness*`-prefix
  readdir + dropped execute@1 capability + session.jsonl path hint in
  message (session-logex)
- U3.6: 9 real assertions + 2-pass in-repo/non-git test + seeded fixtures +
  enumerated isolation check (integration driver rev2)

## Recommendation

None of F1–F6 block Run 4 (first third-party-authored extension). F7 is
also non-blocking for Run 4 (starter-side mitigation shipped in U4.2r).
They accumulate as Run 5 polish. The core surface is production-ready as-is.

## Resolution Status (Run 5)

All seven findings addressed during Run 5. Per-item closure:

- **F1** — Resolved in Run 5 — see commit `152ed3e` (`fireVerdictAppend` now
  returns `{findings, filePath}`; callers no longer need to re-parse markdown).
- **F2** — Resolved in Run 5 — see commit `152ed3e` (missing
  `ctx.nodeCapabilities` now emits a single-line stderr WARN; silent-miss
  behavior preserved for production).
- **F3** — Resolved in Run 5 — see commit `0fb3a24` (extension-test command
  now resolves fixtures via documented `fixtures/` convention).
- **F4** — Resolved in Run 5 — see commit `23cbeca` (`--assert-fired <id>`
  flag added; non-zero exit if the named extension did not fire).
- **F5** — Resolved in Run 5 — see commit `aac291f` (circuit-breaker state
  persisted to `.harness/breaker-state.json`; survives CLI re-invocation
  within a flow).
- **F6** — Resolved in Run 5 — see commit `0fb3a24` (ext-lint now cross-checks
  `meta.compatibleCapabilities` against `meta.provides` and the hook shape).
- **F7** — Resolved in Run 5 — see commit `23cbeca` (`opc-harness --help`
  now enumerates extension subcommands under a dedicated `Extensions:` header).

Baseline tag for Run 5 closure: `ext-run-5-done` (see CHANGELOG v0.8 for the
full change list, including the runbook mechanism shipped alongside).
