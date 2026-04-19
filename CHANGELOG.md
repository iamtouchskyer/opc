# Changelog

## v0.8 — Run 5: F-items closeout + Runbook mechanism (2026-04-20)

Two-track release. **Track A** clears the seven friction items (F1–F7)
surfaced in Run 3 by real extension authors. **Track B** ships the
Runbook mechanism end-to-end: schema + loader + matcher + CLI
(U5.9–U5.10r) + reference runbook + loop-protocol Step 0 integration
+ wired escape hatch (U5.11–U5.12r). Hard constraint enforced
throughout: every patch shipped with a unit test, full suite stayed
green at every checkpoint (final: 27 files, 258 tests).

### Added — Track A (F-items)

- **F1 — `fireVerdictAppend` returns `{findings, filePath}`** instead of
  `undefined` (commit `152ed3e`). Markdown side-effect preserved for
  back-compat; integration drivers no longer have to grep the markdown.
- **F2 — `nodeCapabilities`-missing WARN-once** to stderr from
  `extensionMatches` (commit `152ed3e`). Silent-match-nothing is still
  the default; users now get an observability hint.
- **F3 — `extension-test --fixture-dir <path>`** flag copies a fixture
  tree into a tmp dir and exposes it as `ctx.flowDir` (commit `0fb3a24`).
- **F4 — `eval-extensions.json` sidecar** written alongside the markdown
  on every `fireVerdictAppend` call (commit `23cbeca`). Integration
  tests now assert against JSON; users still read markdown.
- **F5 — Persistent circuit-breaker state** survives CLI invocations via
  atomic `write→rename` to `<flowDir>/extension-breakers.json` (commit
  `aac291f`). Cleared on `init`; honors all bypass paths.
- **F6 — `extension-test --lint`** detects `compatibleCapabilities` /
  `provides` / hook-name typos and exits non-zero (commit `0fb3a24`).
- **F7 — `opc-harness --help` extension section** added with the four
  `extension-test` subcommands (commit `23cbeca`). Closes Run 4 dx litmus
  finding that fresh installs hid the test command.

### Added — Track B (Runbook mechanism)

- **`bin/lib/runbooks.mjs`** — schema v1 with YAML-lite frontmatter,
  whole-word case-insensitive keyword matching with whitespace-flexible
  joining (`add  feature` → `add feature`), regex-literal patterns
  (`/PATTERN/FLAGS`), tag bonus, scoring with multi-word multiplier and
  tie-breakers (commit `cdc07a5`, hardened in `e3f22e5`).
- **`bin/lib/runbook-commands.mjs`** — three sub-commands: `runbook list`,
  `runbook show <id>`, `runbook match <task...>`. JSON-to-stdout,
  stderr-for-warnings discipline. Resolution: `--dir` flag → `OPC_RUNBOOKS_DIR`
  env var → `~/.opc/runbooks/` default. Unknown-flag guard, `--`
  end-of-options, exit codes 0/1/2/3.
- **`OPC_DISABLE_RUNBOOKS=1`** wired escape hatch — `runbook match`
  short-circuits to exit 3 with `disabled: true` payload, no disk read
  (commit `0eba8fa`). The `/opc loop --no-runbook` flag is planned but
  not yet wired into CLI parsing — set the env var directly until then.
- **`docs/runbooks.md`** — full schema reference + authoring guide +
  CLI reference + scoring table + YAML escaping warning + recognized
  unit IDs + try-the-reference-runbook quickstart.
- **`examples/runbooks/add-feature.md`** — canonical reference runbook
  (flow=build-verify, tier=polished, 9 units: spec/plan/build/review/
  fix/test-design/test-execute/acceptance/e2e). Proven to fire on
  `add a dark-mode toggle` via the `/\badd\s+(a|an|the)\s+\w+/i` regex.
- **`examples/runbooks/add-feature-replay.md`** — mental-replay artifact
  walking through `/opc loop add a dark-mode toggle` end-to-end with
  live-verified Step 0 output.
- **`pipeline/loop-protocol.md`** — Step 0 inserted before Step 1
  decomposition. Runbook Discovery section rewritten with 3-tier
  resolution order matching CLI behavior (no project-local
  auto-discovery, no auto-generate — those are out of v0.8 scope).
- **`README.md`** — Autonomous Loop section now lists Runbook lookup
  as step 1 with links to docs/runbooks.md and the reference runbook.

### Hardened during fix-pairs

- 16 schema/loader fixes from U5.10r (commit `e3f22e5`): tier enum,
  ISO-date enforcement on `createdAt`/`updatedAt`, dotfile skip, symlink
  resolution, >512KB skip, missing-explicit-dir WARN, slug regex.
- All `runbook` CLI subcommands check `--help`/`-h` and reject unknown
  flags loudly (mirrors U5.6r KNOWN_FLAGS pattern from extension-test).
- Five-tier "discovery order" claim in loop-protocol.md downgraded to
  what the CLI actually does (3 tiers) after U5.12r reviewers caught
  the doc/code drift (commit `0eba8fa`).

### Tests

258 total across 27 files. Runbook unit + CLI tests: 55 in
`bin/lib/runbooks.test.mjs` (52 schema/loader/matcher + 3 CLI
spawn-tests for `OPC_DISABLE_RUNBOOKS`).

### Findings closure

All seven Run 3 friction items resolved; see
`examples/extensions/run3-findings-for-run5.md` for per-F# commit refs.

---

## v0.7 — Run 4: third-party extension authoring validated (2026-04-19)

First third-party authored extension lands, proving the v0.5.1 extension surface
is authorable from the outside with no core modifications. The shipping kit now
includes a zero-OPC-context authoring guide, a starter template, and one
outsider-built reference extension — assembled under the "the agent that wrote
the docs never tested them" principle (outsider agent was forbidden from reading
`bin/lib/extensions.mjs` or any Run 3 example source during the DX litmus).

### Added

- **`docs/extension-authoring.md`** (7800+ words, self-contained, zero
  `see internal` / `see spec` pointers). Covers all 4 hooks, ctx shape, capability
  matching semantics (exact-equality, not semver), hook-name mapping
  (camelCase ↔ kebab), graceful-degrade pattern, timeout budgets, failure
  sidecar architecture, `extension-test` CLI, and a complete public-export
  reference in Appendix B. Quickstart + reference structure; every code sample
  is copy-pasteable.
- **`examples/extensions/_starter/`** — `ext.json` + `hook.mjs` (121 lines, all
  5 hook stubs with JSDoc + graceful-empty returns) + `README.md` (30-minute
  junior-dev walkthrough). `cp -r` to a tmp dir → `extension-test --all-hooks`
  exits 0 without further edits.
- **`examples/extensions/lint-prompt-length/`** — sixth example extension,
  built by an outsider agent reading only `docs/extension-authoring.md` +
  `_starter/`. Capability `prompt-size-check@1`, via `verdictAppend`:
  `ctx.task.length > 16000` → 🔴, `> 8000` → 🟡, else `[]`. 70 lines.
  `compatibleCapabilities: ["verification@1","design-review@1","execute@1"]`.
- **`## Lessons from Run 4 outsider-build`** section in the authoring doc —
  one-line before/after for every gap the outsider logged in `doc-gaps.md` +
  every reviewer-caught friction item. Turns the DX litmus into a permanent
  doc-quality artifact.

### Doc patches from the outsider build (U4.4)

The outsider hit 5 real gaps (G1-G5) + 2 reviewer-caught blockers (MG1, MG2) +
3 unlogged-but-smelled-out decisions. All 10 patched in-place:

- Severity→emoji table moved up front (was only implicit in code samples).
- `extension-test` routing-rule contradiction corrected: CLI invokes hooks
  unconditionally, matching rules only apply at pipeline call sites.
- `ctx.task` ≠ assembled prompt clarified; added `typeof` guard for unknown
  shapes.
- `meta.name` is not read by the loader (directory name is canonical) — starter
  template updated accordingly.
- Capability catalog added so `compatibleCapabilities` authors stop guessing.
- `startupCheck` return-value semantics: omitting the hook == returning
  `undefined`; `✅ passed` emoji is unconditional.

### Extensions test suite

- Core test suite unchanged — 27 files pass, 0 fail. Extensions live outside
  core; Run 4 touched zero lines under `bin/lib/` or `bin/opc-harness.mjs`.
- `find examples/extensions -name '*.mjs' | xargs -n1 node --check` — clean.
- Starter + lint-prompt-length both pass `extension-test --all-hooks`.

### Known gaps carried to Run 5

One new item added to `examples/extensions/run3-findings-for-run5.md`:

- **F7** — `opc-harness --help` omits the extension subcommands
  (`prompt-context`, `extension-test`, `extension-verdict`,
  `extension-artifact`, `config resolve`). Discoverability gap, not a
  correctness issue.

F1–F6 from Run 3 remain deferred.

### Architectural lesson

Documentation for an extension surface cannot be validated by its own author.
Run 4's value was not in writing the doc — it was in sending an outsider agent
to build against it and logging every peek and every unanswered question as a
finding. Five real gaps + two reviewer-caught self-contradictions would not
have surfaced via insider review, no matter how careful. DX is a property you
verify experimentally, not a property you assert.

---

## v0.6 — Run 3: 5 real extensions mounted (2026-04-19)

First production payload for the v0.5 extension surface. Five independently-
scoped extensions built under `~/.opc/extensions/`, each paired with a
2-reviewer gate and, where findings ≥ 🟡, a fix-pair commit. No OPC core
modifications — any core bugs surfaced during build went to
`.harness-run3/findings-for-run5.md`.

Mirrored to `examples/extensions/<name>/` so the shipping skill repo contains
the full set as reference implementations.

### Extensions added

- **design-lint** (`design-spec-conformance@1`, verdict.append) — walks up
  from `ctx.flowDir` looking for `design-tokens.json`; if found + live
  `ctx.devServerUrl` available, shells out to `opc-extend-design/bin/design-lint.mjs`
  with 30s timeout and converts diffs to findings. Graceful `[]` otherwise.
- **visual-eval** (`visual-consistency-check@1`, execute.run) — wraps
  `opc-extend-visual-eval` Python via subprocess. On `ctx.runDir/artifacts/*.png`
  presence, runs VLM evaluation with 60s bounded timeout; writes
  `ext-visual-eval/visual-eval-marker.json` with `{status,exitCode,stderrTail}`.
  Missing `DASHSCOPE_API_KEY` → `status=error` without throw (no registry
  failure).
- **memex-recall** (`context-enrichment@1`, prompt.append) — extracts
  non-stopword keywords from `ctx.task` (CJK-segmented), probes `memex search`
  with 3s timeout, formats top-3 results as `## 相关历史笔记`. CLI absent /
  timeout → empty string (graceful no-op).
- **git-changeset-review** (`code-quality-check@1`, verdict.append) — walks
  up for `.git`, runs `git -c core.quotepath=false diff --numstat --no-renames
  HEAD~1 HEAD` with 5s timeout, applies 3 rules: >500 lines 🟡, test/source
  ratio <0.3 🟡, package.json without lockfile 🔴. `basename` match for lockfile
  detection (not endsWith) to avoid false positives on `fake-package.json`.
- **session-logex** (`post-flow-digest@1`, verdict.append) — soft nudge hook.
  Walks up from `ctx.flowDir` for `flow-state.json` (direct + `.harness*/`
  prefix-match), bounded by `.git` / `package.json` / `.opc` sentinels. On
  `status ∈ DONE_STATUSES && steps >= 5 && /logex skill present`, emits info
  finding with session.jsonl path hint. Dedup via sibling `.logex-nudged`
  marker — same flow never re-nudges.

### Integration surface verified (U3.6r)

Driver at `examples/extensions/u36-integration-driver.mjs`. 9 assertions
across 2 passes (in-repo + `/tmp/run3-u36-nongit`):

- All 5 loaded; zero 🔴 registry failures.
- `verdict.append` fires only for matching capabilities (`verification@1` /
  `design-review@1`); `prompt.append` for memex-recall only; `execute.run`
  for visual-eval only.
- Isolation: only `ext-visual-eval/` writes files under `runDir`.
- visual-eval marker written with valid status even when API key absent.
- Non-git pass produces "No extension findings" — proves graceful degrade
  isn't an artifact of the in-repo happy path.

### Known gaps carried to Run 5

See `.harness-run3/findings-for-run5.md` (if non-empty).

### Test suite

- Core test suite unchanged — 27 files pass, 0 fail (extensions live outside
  core and don't touch `bin/opc-harness.mjs`).

## v0.5.1 — Extension system, Run 2 verification (2026-04-18)

Hardens Run 1's extension surface against the gaps surfaced by independent
adversarial review. No new features — purely closes the remaining seams in
isolation, strict mode, bypass, and cross-command failure persistence.

### Fixed

- **Cross-command failure merge (G3, U2.8a → U2.8c → U2.8e).** Each CLI
  invocation creates a fresh `registry.failures = []`, so the second
  invocation in a node was overwriting `extension-failures.md` written by
  the first. Switched `writeFailureReport` to a JSON sidecar architecture:
  `extension-failures.json` is the canonical machine-readable record;
  `extension-failures.md` is a derived view re-rendered each call from
  the sidecar. Dedup uses `JSON.stringify([ext,hook,kind,message])` (no
  collision when a field contains `|`). `droppedTotal` accumulates across
  CLI invocations so cap-overflow signal is preserved. (Reviewer B caught
  the original regex-based attempt — missing `/u` flag — silently degraded
  to overwrite. Now backed by direct unit test
  `test-run2-failure-merge.sh`, 11/11 pass.)

- **`extensionsApplied` snapshots survivors, not loaders (G1).**
  `cmdPromptContext` / `cmdExtensionVerdict` / `cmdExtensionArtifact` now
  stamp `handshake.extensionsApplied = survivingExtensions(registry)` —
  filtered by `e.enabled !== false`, so breaker-tripped extensions don't
  appear as "applied" in downstream gates. The load-time snapshot still
  lives at `registry.applied` for diagnostics.

- **`cmdPromptContext` writes failure report (G2).** Previously only
  verdict/artifact phases persisted to `extension-failures.md`; prompt-phase
  failures (timeouts, throws in `promptAppend`) appeared only as stderr
  CIRCUIT-BREAKER lines. Now `writeFailureReport` is invoked from all
  three commands, and the JSON sidecar merges across phases.

- **`ok-ext.executeRun` hook actually does something (G4).** Was a silent
  no-op, so `executeRun` regressions would go undetected. Now writes
  `runDir/ok-ext-execute-marker.txt` and the e2e suite asserts presence.

- **Strict mode covers prompt + artifact phases (G5).** `OPC_STRICT_EXTENSIONS=1`
  previously only escalated `cmdExtensionVerdict` failures to exit code 2.
  `cmdPromptContext` and `cmdExtensionArtifact` now `enforceStrictMode` after
  writing the failure report, preserving isolation while signaling CI failure.
  Test sections 6.1 + 7.1 cover both.

- **e2e cleanup race (G6).** `test-run2-e2e.sh` used `trap "rm -rf $TMP" EXIT`
  which wiped `$TMP` even when the test failed (no diagnosis material) and
  didn't catch SIGINT/TERM/HUP. Aligned with strict.sh + bypass.sh:
  keep-on-fail + signal traps.

- **Bypass coverage (G7).** Added section 7.1 (`--extensions does-not-exist`
  → graceful empty `applied[]`, `bypass.mode=whitelist`, no init crash) and
  8.1 (env + `--no-extensions` co-presence → deterministic `source=env`
  attribution per documented priority).

### Test suite

- **27 test files pass, 0 fail** (was 26 in v0.5; +1 from
  `test-run2-failure-merge.sh`).
- Per-file Run 2 totals: strict 10, bypass 16, e2e 16 (was 13), failure-merge 11.

### Architectural lesson

Parsing your own emitted markdown via regex is fragile by construction.
When persistence + display share a format, the format must be canonical
(JSON sidecar) and human-readable views derived from it — not the other
way around. Eliminates parser/writer skew, makes round-trip schema-safe,
and means dedup keys aren't trying to round-trip emoji surrogate pairs
through `\S`.

---

## v0.5 — Extension system, Run 1 (2026-04-18)

First of four planned extension-system hardening runs. Adds a capability-routed,
failure-isolated plugin surface to OPC so external hooks (visual checks,
design-system audits, a11y scans) can participate in build, review, and execute
nodes without forking the skill.

### Added

- **Extension loader** with env / CLI / config layering.
  `OPC_DISABLE_EXTENSIONS=1` > `--no-extensions` > `--extensions foo,bar` >
  `.opc/config.json` (repo) > `~/.opc/config.json` (user). (U1.1)
- **Capability matching** (`name@N` identifiers, lower-kebab regex).
  `meta.provides` + `meta.compatibleCapabilities` route extensions to nodes
  that declare matching `nodeCapabilities`. Bare names auto-upgrade to `@1`
  with a one-shot stderr WARN. (U1.2)
- **Hook failure isolation** with circuit-breaker.
  Per-extension `_failStreak` counter; after `HOOK_FAILURE_THRESHOLD`
  consecutive timeouts/throws on any hook, the extension is disabled for the
  rest of the process and a 🔴 entry lands in `extension-failures.md`. Sibling
  extensions keep firing. (U1.3)
- **Config layering** via `loadLayeredOpcConfig(harnessDir)` — walks up for
  repo-layer `.opc/config.json`, merges user-layer, records `_source` /
  `_paths` provenance. `opc-harness config resolve` prints the merged view.
  (U1.4)
- **Capability-shape lint** in `opc-harness extension-test`.
  `meta.provides` / `meta.compatibleCapabilities` entries that don't match
  `/^[a-z][a-z0-9-]*@[1-9]\d*$/` print a `[lint] ⚠️` WARN to stderr without
  changing exit code. (U1.5)
- **Execute-node hooks**: `execute.run` / `executeRun` (side-effectful,
  return ignored) and `artifact.emit` / `artifactEmit` (returns
  `{ name, content }[]`, files written to `<runDir>/ext-<name>/<basename>`
  and merged into `handshake.artifacts[]` as `{ type: "ext-artifact", ext,
  path }`). `artifact.emit` accepts string, Buffer, or any
  `ArrayBuffer.isView` content (Uint8Array, DataView). Basename
  sanitization rejects `../escape`, `/abs`, `sub/nested`. (U1.6)
- **CLI surface**: `opc-harness prompt-context`, `extension-test`,
  `extension-verdict`, `extension-artifact`, `config resolve`. All emit JSON
  to stdout.
- **Docs**: `docs/specs/2026-04-16-opc-extension-system-design.md` (full
  design, capability versioning, hook failure isolation, extension hook
  surface), `CONTRIBUTING.md` with "Writing an OPC Extension" section and
  hook-surface summary table.
- **Tests**: `bin/lib/extensions.test.mjs` (118 tests), `bin/lib/config-layering.test.mjs`,
  `bin/lib/bypass-args.test.mjs`. Wired into `test/run-all.sh` via
  `test/test-extensions.sh`.

### Fixed

- `fireArtifactEmit` circuit-breaker: per-item write failure no longer reset
  by `recordSuccess` in the same iteration. Streak now accumulates across
  persistent per-item failures as intended. (U1.6r semantics F1 / contract #2)

### Security

- Extension hooks run in-process with full Node privileges — they are trusted
  code declared in config, not sandboxed plugins. See spec §5 (Extension
  Ordering & Conflict Handling) and §9 (Hook Failure Isolation) for the
  operator-side security model.
