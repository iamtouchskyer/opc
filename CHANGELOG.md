# Changelog

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
