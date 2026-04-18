# Changelog

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
