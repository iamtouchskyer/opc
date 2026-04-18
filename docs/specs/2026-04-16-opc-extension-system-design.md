# OPC Extension System Design

**Date**: 2026-04-16
**Status**: Draft
**Scope**: Private extension mechanism for OPC agent pipeline framework
**Horizon**: 3-year architectural target (2 → 20+ extensions)

---

## 0. Context & Motivation

OPC is a digraph-based agent pipeline where build and review are always independent subagents. The harness is a protocol layer — mechanism lives in the harness, policy lives outside.

Some "secret weapons" (design-system contracts, visual linting rules, proprietary style guides) must never enter the open-source core. They are user-specific, context-sensitive, and competitively sensitive. This spec defines a stable extension mechanism that:

1. Lives entirely outside OPC source
2. Plugs into the harness at well-defined call sites
3. Preserves all six OPC core principles without exception
4. Scales from 2 to 20+ extensions without architectural rework

### OPC Core Principles (Invariants)

Every section below is verified against these. Any design that violates them is rejected.

| # | Principle | Short Form |
|---|-----------|------------|
| P1 | The agent that does the work never evaluates it | **Build ≠ Review** |
| P2 | Verdict computed from emoji counts in eval files | **Mechanical Gate** |
| P3 | Review subagents have fresh context | **Independence** |
| P4 | Harness is a protocol layer (~100 lines) | **Lean Core** |
| P5 | All state in `.harness/`, replayable | **File-based State** |
| P6 | Recoverable on agent failure or context exhaustion | **Resilience** |

---

## 1. Directory Structure

Extensions live in the user's home directory, never in OPC source.

```
~/.opc/
├── config.json
└── extensions/
    ├── design-system/
    │   ├── hook.mjs
    │   └── prompt.md
    └── design-lint/
        ├── hook.mjs
        └── prompt.md
```

**Dotfiles pattern** (recommended): maintain `~/.dotfiles/opc/` in a private repo, symlink to `~/.opc/`. OPC source never sees these files. Private forever.

```bash
ln -s ~/.dotfiles/opc ~/.opc
```

### Path Override (CI & Multi-user)

The `~/.opc/` path must be overridable via (highest priority first):

1. `OPC_EXTENSIONS_DIR` environment variable
2. `--extensions-dir <path>` flag on any harness command
3. `"extensionsDir"` field in `config.json` (machine-level override without env vars)
4. Default: `~/.opc/`

In `lib/extensions.mjs`, `loadExtensions(config)` resolves the path as:

```js
const extensionsDir = process.env.OPC_EXTENSIONS_DIR
  || config.extensionsDir
  || path.join(os.homedir(), '.opc');
```

This enables CI pipelines to point at a repo-local fixture directory without touching the developer's home.

### Global Config: `~/.opc/config.json`

```json
{
  "extensionsDir": "/custom/path",
  "extensionOrder": ["design-system", "design-lint"],
  "requiredExtensions": ["design-system"],
  "extensions": {
    "design-system": { "enabled": true },
    "design-lint": { "enabled": true }
  }
}
```

**`requiredExtensions[]`**: If any listed extension is missing or fails `startup.check` at flow init, harness throws `FATAL` and aborts. Non-listed extensions are optional — missing = warn only, failure = warn only.

**Principle check**:
- P4 (Lean Core): config is a plain JSON file, zero runtime magic
- P5 (File-based State): config file is in user home, not in `.harness/` — this is intentional. Config is installation-time state, not flow-time state. Flow-time state (which extensions were applied) is recorded in `handshake.json` (see §3)

---

## 2. Hook Interface

Each `hook.mjs` exports a default object with `meta` and `hooks`:

```js
export default {
  meta: {
    name: 'design-system',    // must match directory name
    version: '1.0.0'
    // Required/optional status is declared in config.json only — single source of truth.
  },
  hooks: {
    /**
     * Returns a string appended to subagent prompt context.
     * Called before any subagent dispatch (build + review nodes).
     * Return empty string if nothing to add.
     *
     * Injecting context into a build agent is not a P1 violation — it gives the agent
     * more information to do its job correctly. P1 prohibits the same agent from both
     * doing work and evaluating it. Extension context injection serves the 'doing work'
     * side only.
     */
    'prompt.append': async (context) => string,

    /**
     * Returns finding[] written to ext-findings.md in runDir.
     * NEVER passed directly to synthesize — findings enter the
     * mechanical gate through the same emoji-count path as
     * eval-{role}.md files. Preserves P2 without exception.
     */
    'verdict.append': async (context) => finding[],

    /**
     * Startup health check. Throw = FATAL for required extensions.
     * Throw = warn-only for optional extensions.
     * Use to verify env vars, file presence, external deps.
     */
    'startup.check': async (context) => void
  }
}
```

### `context` Object

```js
{
  node: string,        // e.g. "build", "code-review"
  role: string,        // e.g. "frontend", "security"
  task: string,        // acceptance criteria summary (from flow spec)
  flowDir: string,     // absolute path to .harness/
  runDir: string       // absolute path to .harness/nodes/{node}/run_{N}/
}
```

### `finding` Type

```js
{
  severity: '🔴' | '🟡' | '🔵',   // maps directly to mechanical gate emoji counts
  category: string,                // e.g. "design-system", "color-contrast"
  message: string,                 // human-readable description
  file?: string                    // optional file path for precise attribution
}
```

### Critical Design Constraint: `ext-findings.md`

`verdict.append` findings MUST be serialized to `ext-findings.md` in the same `runDir` as `eval-{role}.md`. `synthesize` reads all `*.md` files in `runDir`. This is the mechanical gate path — no special handling for extension findings.

**Why this matters (P2 compliance)**:
If extension findings were passed directly to `synthesize` as structured data and counted separately, it would create two verdict paths: one mechanical (emoji count from files) and one programmatic (direct count from extensions). That violates P2. By writing to `ext-findings.md`, extensions are indistinguishable from role evaluations at the gate layer.

Example `ext-findings.md`:
```markdown
## Extension Findings: design-system v1.0.0

🔴 [color-token] Button uses hardcoded `#ff0000` instead of `--color-danger` (src/components/Button.tsx:42)
🟡 [spacing-token] Margin 16px should use `--space-4` token (src/components/Card.tsx:18)
🔵 [font-token] Font size matches design system token correctly
```

**Principle check**:
- P1 (Build ≠ Review): `verdict.append` is only called on review nodes, never build nodes
- P2 (Mechanical Gate): findings enter gate via file, not code path
- P5 (File-based State): `ext-findings.md` is in `.harness/`, replayable

---

## 3. Harness Changes

### New File: `lib/extensions.mjs` (~50 lines)

```js
/**
 * Scans the resolved extensions directory (OPC_EXTENSIONS_DIR || config.extensionsDir || ~/.opc/),
 * validates requiredExtensions from config,
 * runs startup.check on each loaded extension.
 * Throws FATAL if any required extension is missing or fails startup.check.
 * Warns (no throw) for optional extension failures.
 *
 * Returns an ExtensionRegistry object — pass this to all fire functions.
 * Avoids module-level singletons (bad for test isolation, bad for P6 resilience).
 */
export async function loadExtensions(config): Promise<ExtensionRegistry>

/**
 * Calls all enabled extensions' prompt.append hooks in extensionOrder (or alphabetical fallback).
 * Returns concatenated string (each extension's output separated by \n\n).
 * Individual extension failures: required = FATAL, optional = warn + skip.
 */
export async function firePromptAppend(registry, context)

/**
 * Calls all enabled extensions' verdict.append hooks.
 * Serializes findings[] to ext-findings.md in context.runDir.
 * Individual extension failures: required = FATAL, optional = warn + skip.
 */
export async function fireVerdictAppend(registry, context)
```

The orchestrator calls `loadExtensions` once at flow init and passes the registry through:

```js
const registry = await loadExtensions(config);
// ...later, per node dispatch:
await firePromptAppend(registry, context);
// ...later, after eval files written (review nodes only):
await fireVerdictAppend(registry, context);
```

**Why ~50 lines**: `loadExtensions` is file scanning + dynamic import. `firePromptAppend` and `fireVerdictAppend` are map + await + string/file ops. No plugin protocol, no version negotiation — YAGNI for 20 extensions.

### Three Call Sites in Harness

| Call Site | When | Function |
|-----------|------|----------|
| Flow init | After reading config, before any node dispatch | `const registry = await loadExtensions(config)` |
| Before subagent dispatch | Build nodes + review nodes | `await firePromptAppend(registry, context)` |
| After eval files written | Review nodes only | `await fireVerdictAppend(registry, context)` |

**Principle check**:
- P1: `fireVerdictAppend` call site is review nodes only — enforced at the call site, not by convention
- P4: Three call sites, one new file of ~50 lines. Core harness delta is minimal
- P6: Extension failures for optional extensions produce warnings and skip, not crash. Required extension failures are FATAL by design (user opted in)

### New Harness Command: `prompt-context`

```bash
opc-harness prompt-context --node <id> --role <role> --dir <harness-dir>
```

**Output** (JSON to stdout):
```json
{
  "append": "## Design System Context\n...\n\n## Design Lint Rules\n...",
  "applied": ["design-system", "design-lint"]
}
```

This command is the orchestrator's interface to extension prompt injection. It must be called before dispatching any subagent.

### New Field in `handshake.json`

```json
{
  "node": "code-review",
  "role": "frontend",
  "timestamp": "2026-04-16T10:00:00Z",
  "extensionsApplied": ["design-system", "design-lint"]
}
```

`validate-chain` checks: if `config.requiredExtensions` includes `X`, then every handshake in the chain must have `X` in `extensionsApplied`. A chain with a missing required extension is invalid — same severity as a missing eval file.

**Principle check**:
- P5 (File-based State): `extensionsApplied` is recorded in `handshake.json` in `.harness/`, not in memory
- P6 (Resilience): If an orchestrator crashes mid-flow and restarts, `validate-chain` can detect whether extensions were applied before the crash point

---

## 4. Orchestrator Convention

### Prompt Template Updates

`pipeline/implementer-prompt.md` and `pipeline/role-evaluator-prompt.md` MUST include:

```markdown
**Mandatory before dispatch**: Run:
  opc-harness prompt-context --node {node} --role {role} --dir .harness
Append the returned `append` string to this prompt verbatim.
Record `applied[]` in handshake field `extensionsApplied`.
```

This is the **soft enforcement layer** — the orchestrator sees the instruction in its prompt template and follows it.

### Two-Layer Enforcement

| Layer | Mechanism | Consequence of Failure |
|-------|-----------|----------------------|
| Soft | Orchestrator reads prompt template → sees mandatory step | Orchestrator skips extension context; likely produces non-compliant output |
| Hard | `validate-chain` rejects handshake chain missing required `extensionsApplied` | Flow marked INVALID; cannot proceed to merge/publish gate |

The two layers are complementary. The soft layer prevents the issue upstream. The hard layer catches it downstream if the soft layer fails (e.g., orchestrator prompt drift, model regression).

**Principle check**:
- P1: Prompt template updates are in role-evaluator-prompt, not implementer-prompt for verdict hooks — the evaluator that runs extension findings is not the one that built the artifact
- P3 (Independence): `prompt-context` command is called fresh per dispatch; no shared state between subagents

---

## 5. Extension Ordering & Conflict Handling

**Ordering**: Extensions fire in the order specified by `extensionOrder` in `config.json`. If `extensionOrder` is absent, extensions fire in alphabetical order (deterministic). Do not rely on JSON object key order — it is not guaranteed stable across serializers.

Example `config.json` with explicit order:
```json
"extensionOrder": ["design-system", "design-lint"]
```

**Conflicts**: Extensions are independent by design. They do not call each other, share state, or produce merged verdicts. If two extensions both flag the same file, both findings appear in `ext-findings.md`. `synthesize` counts emojis — duplicates increase severity signal, which is correct behavior.

**Versioning**: `meta.version` is recorded but not enforced. Semantic versioning is for human operators to track breaking changes in their private extensions. The harness does not validate version compatibility — YAGNI until there's a real cross-extension dependency.

**At 20+ extensions**: The architecture holds. `loadExtensions` is O(n) file scans. `firePromptAppend` and `fireVerdictAppend` are O(n) async calls. If prompt context becomes too large (e.g., 20 extensions each appending 500 tokens), that's a content problem, not an architecture problem — operators should curate `prompt.md` files.

---

## 6. Testing Extensions

### Harness Command: `extension-test`

```bash
# Test a single hook
opc-harness extension-test \
  --ext ~/.opc/extensions/design-system \
  --hook prompt.append \
  --context '{"node":"build","role":"frontend","task":"build login page","flowDir":"/tmp/test-harness","runDir":"/tmp/test-harness/nodes/build/run_1"}'

# Test all hooks in sequence
opc-harness extension-test \
  --ext ~/.opc/extensions/design-system \
  --all-hooks \
  --context '{"node":"code-review","role":"frontend","task":"review login page","flowDir":"/tmp/test-harness","runDir":"/tmp/test-harness/nodes/code-review/run_1"}'
```

**Output**:
```
[startup.check] ✅ passed (0ms)
[prompt.append] ✅ returned 342 chars
  --- output preview ---
  ## Design System Context
  Use design tokens from tokens.ts...
  ---------------------
[verdict.append] ✅ returned 3 findings
  🔴 [color-token] 1 finding
  🟡 [spacing-token] 2 findings
```

This enables TDD for extension authors: write `hook.mjs`, run `extension-test`, iterate without a full OPC flow.

**Principle check**:
- P6 (Resilience): Authors can verify extensions in isolation before deploying. Reduces runtime failures.

---

## 7. Installation

Zero magic. Three steps:

```bash
# Step 1: Place files
mkdir -p ~/.opc/extensions/design-system
cp hook.mjs prompt.md ~/.opc/extensions/design-system/

# Step 2: Declare as required (edit manually)
# ~/.opc/config.json → "requiredExtensions": ["design-system"]

# Step 3: Verify
opc-harness extension-test \
  --ext ~/.opc/extensions/design-system \
  --all-hooks \
  --context '{"node":"code-review","role":"frontend","task":"smoke test","flowDir":"/tmp/test-harness","runDir":"/tmp/test-harness/nodes/code-review/run_1"}'
```

**Dotfiles pattern** (recommended for private extensions):

```bash
# In ~/.dotfiles (private repo)
mkdir -p opc/extensions/design-system
cp hook.mjs prompt.md opc/extensions/design-system/

# Symlink
ln -s ~/.dotfiles/opc ~/.opc
```

New machine setup:
```bash
git clone git@github.com:you/dotfiles.git ~/.dotfiles
ln -s ~/.dotfiles/opc ~/.opc
# Done. OPC picks up extensions on next flow init.
```

---

## 8. 3-Year Architectural Assessment

### What Holds

| Concern | Assessment |
|---------|------------|
| 20+ extensions | O(n) scan + O(n) async call. No registry bottleneck. Holds. |
| Extension authoring | `hook.mjs` + `prompt.md` is the complete surface area. No SDK needed. |
| Harness evolution | Three call sites + one 50-line file. Easy to audit and modify. |
| Private forever | `~/.opc/` never touched by OPC updates. Symlink pattern is stable. |
| Replayability | `ext-findings.md` in `.harness/`, `extensionsApplied` in `handshake.json`. Full replay possible. |
| Cross-agent isolation | `prompt-context` is called per-dispatch. No shared extension state between subagents. |

### What Is Explicitly Out of Scope (YAGNI)

- **Extension-to-extension communication**: Not needed. Extensions are independent linters.
- **Hot reload**: Extensions load at flow init. Restarting the flow picks up changes.
- **Remote extension registries**: Private dotfiles is the distribution model.
- **Extension sandboxing**: `hook.mjs` runs in the harness process. Extensions are authored by the operator. Sandboxing is security theater for a single-user OPC deployment.
- **Version negotiation**: `meta.version` is informational. No semver enforcement needed until cross-extension dependencies exist (they don't).
- **Extension UI / management commands**: `opc-harness extension-test` + manual JSON editing is sufficient. A TUI is premature.

---

## 9. Blocker Resolution Summary

| # | Blocker | Solution | Location in Spec |
|---|---------|----------|-----------------|
| 1 | Hook interface undefined | `hook.mjs` default export contract with `meta`, `hooks`, `context`, `finding` types | §2 |
| 2 | No local test mechanism | `opc-harness extension-test --ext ... --hook ... --context` command | §6 |
| 3 | Installation undocumented | Three-step install + dotfiles symlink pattern | §7 |
| 4 | Harness unaware of `~/.opc/` | `lib/extensions.mjs` with `loadExtensions`, three explicit call sites | §3 |
| 5 | No orchestrator convention | Mandatory `prompt-context` step in `implementer-prompt.md` + `role-evaluator-prompt.md` | §4 |
| 6 | No injection verification | `extensionsApplied` in `handshake.json` + `validate-chain` enforcement | §3, §4 |
| 7 | No hook call sites defined | Three call sites: flow init, before subagent dispatch, after eval files written | §3 |

---

## Appendix: Principle Compliance Matrix

| Section | P1 Build≠Review | P2 Mechanical Gate | P3 Independence | P4 Lean Core | P5 File State | P6 Resilience |
|---------|:-:|:-:|:-:|:-:|:-:|:-:|
| §1 Structure | — | — | — | ✅ plain files | ✅ `~/.opc/` | ✅ symlink stable |
| §2 Hook Interface | ✅ `verdict.append` review-only | ✅ `ext-findings.md` via file | ✅ no shared state | ✅ minimal API | ✅ findings in runDir | ✅ throw semantics |
| §3 Harness Changes | ✅ call site enforcement | ✅ file path only | ✅ per-dispatch context | ✅ 50 lines | ✅ handshake.json | ✅ optional warns |
| §4 Orchestrator | ✅ template separation | — | ✅ fresh per dispatch | — | ✅ recorded in handshake | ✅ two-layer check |
| §5 Ordering | — | ✅ duplicates = more signal | ✅ independent | — | — | — |
| §6 Testing | — | — | — | ✅ no test infra needed | — | ✅ pre-deploy verify |
| §7 Installation | — | — | — | ✅ zero magic | — | ✅ new machine = 2 cmds |

---

## §8. Capability Versioning (U1.2, v0.5)

Capability identifiers are versioned to allow breaking schema/behavior changes
without silently breaking downstream nodes.

### §8.1 Identifier format

```
/^[a-z][a-z0-9-]*@\d+$/     # canonical:  visual-check@1, code-quality@2
/^[a-z][a-z0-9-]*$/         # bare:       visual-check  → auto-upgrades to @1
```

A **bare** identifier (no `@N`) is auto-upgraded to `@1` at match time. On
first encounter per process, a one-line stderr WARN fires:

```
[opc] WARN: capability 'visual-check' missing version suffix — auto-upgrading to 'visual-check@1'. Declare 'visual-check@1' explicitly to silence this.
```

Subsequent normalizations of the same bare name in the same process are silent.

Both sides of a match (the ext's `meta.provides` and the node's
`nodeCapabilities`) are normalized, so matching is symmetric:

| Ext provides   | Node requires  | Match |
|----------------|----------------|:-----:|
| `foo@1`        | `foo@1`        | ✅    |
| `foo`          | `foo@1`        | ✅    |
| `foo@1`        | `foo`          | ✅    |
| `foo@1`        | `foo@2`        | ❌    |

### §8.2 `meta.compatibleCapabilities`

An extension upgrading from `@1` to `@2` can keep firing for legacy-declared
nodes by widening its match surface:

```js
// hook.mjs (shipping visual-check v2)
export const meta = {
  name: "visual-check-v2",
  provides: ["visual-check@2"],
  compatibleCapabilities: ["visual-check@1"],   // still match old nodes
  description: "Visual consistency check, v2 schema"
};
```

`compatibleCapabilities` is treated identically to `provides` at match time —
both lists are unioned and normalized. Non-array values trigger a load-time
WARN and are coerced to `[]` (same policy as `provides`).

### §8.3 Migration guidance

1. New capability → declare as `name@1` from day one.
2. Breaking change (schema, contract, semantics) → bump to `@2`.
3. Ship ext with `provides: ["name@2"], compatibleCapabilities: ["name@1"]`.
4. Bump all node templates to `name@2` in a follow-up.
5. Remove `compatibleCapabilities` in a later release.

### §8.4 What isn't versioned

The **hook interface** (`promptAppend`, `verdictAppend`, `startupCheck`,
U1.6's `executeRun`, `artifactEmit`) is versioned by the OPC core itself, not
by capability tokens. Extensions opt into new hooks by implementing them; old
hooks continue to work without changes.
