// extensions.mjs — OPC Extension System
// Loads user extensions from ~/.opc/extensions/, fires hooks at call sites.
// No module-level singletons — loadExtensions returns a registry object.
//
// ── Activation model (capability contract) ──
// Extensions declare what they provide:
//   export const meta = { name, provides: ["visual-consistency-check"], description };
// OPC nodes declare what they need via flow template's `nodeCapabilities`:
//   nodeCapabilities: { "code-review": ["visual-consistency-check", "code-quality-check"] }
// OPC core (firePromptAppend/fireVerdictAppend) matches: fire if ANY of ext.provides
// is in the current node's required capability set. Otherwise silent skip.
// An extension with provides: [] is legal — startup.check runs, hooks never fire.
//
// ── Hook interface ──
// New-style (recommended):
//   export const meta = { name: "my-ext", provides: ["..."], description: "..." };
//   export async function promptAppend(ctx) { return "## Section\n..."; }
//   export async function verdictAppend(ctx) { return [{ severity, category, message }]; }
//   export async function startupCheck(ctx) { /* throw to abort load */ }
//
// Legacy new-style (hooks object):
//   export default { hooks: { "prompt.append": fn, "verdict.append": fn } }
//
// Finding shape: { severity: "error"|"warning"|"info", category: string, message: string, file?: string }

import { readFileSync, existsSync, mkdirSync } from "fs";
import { readdir } from "fs/promises";
import { join } from "path";
import os from "os";
import { atomicWriteSync } from "./util.mjs";

// ─── Constants ───────────────────────────────────────────────────

const HOOK_TIMEOUT_MS = Number(process.env.OPC_HOOK_TIMEOUT_MS) || 60_000;

// Circuit-breaker: after N consecutive failures, the extension is auto-disabled
// for the remainder of the process. Override via OPC_HOOK_FAILURE_THRESHOLD.
// Set to 0 to disable the breaker (still records failures, never trips).
const HOOK_FAILURE_THRESHOLD = (() => {
  const raw = process.env.OPC_HOOK_FAILURE_THRESHOLD;
  if (raw === undefined || raw === "") return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
})();

// Cap on registry.failures[] to keep memory + report file bounded in long-lived
// processes. Oldest entries are dropped FIFO once the cap is reached, and a
// running drop counter is exposed via registry.failuresDropped.
const FAILURE_LOG_CAP = (() => {
  const raw = process.env.OPC_HOOK_FAILURE_LOG_CAP;
  if (raw === undefined || raw === "") return 200;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
})();

// Tagged sentinel — survives across module boundaries via name check (instanceof
// is fragile under dynamic re-import). Used by withTimeout + recordFailure to
// classify timeouts deterministically instead of regex-sniffing err.message.
export class HookTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "HookTimeoutError";
  }
}

function isHookTimeoutError(err) {
  return err && (err instanceof HookTimeoutError || err.name === "HookTimeoutError");
}

// ─── Failure record helpers ──────────────────────────────────────
//
// Every prompt.append / verdict.append failure (throw, timeout, bad-return-shape)
// is appended to registry.failures[]. The orchestrator/gate persists these to
// eval-extension-failures.md so a flaky or crashing extension is observable
// instead of silently degrading the run.

function appendFailure(registry, entry) {
  if (!Array.isArray(registry.failures)) registry.failures = [];
  registry.failures.push(entry);
  while (registry.failures.length > FAILURE_LOG_CAP) {
    registry.failures.shift();
    registry.failuresDropped = (registry.failuresDropped || 0) + 1;
  }
}

function recordFailure(registry, ext, hook, kind, message) {
  const entry = {
    ext: ext.name,
    hook,
    kind,                              // "throw" | "timeout" | "bad-return"
    message: String(message).slice(0, 500),
    at: new Date().toISOString(),
  };
  appendFailure(registry, entry);
  ext._failStreak = (ext._failStreak || 0) + 1;
  if (HOOK_FAILURE_THRESHOLD > 0 && ext._failStreak >= HOOK_FAILURE_THRESHOLD && ext.enabled) {
    ext.enabled = false;
    ext.disabledReason = `circuit-breaker tripped after ${ext._failStreak} consecutive failures`;
    console.error(`[opc] CIRCUIT-BREAKER: extension '${ext.name}' disabled after ${ext._failStreak} consecutive failures (last: ${kind} in ${hook})`);
    appendFailure(registry, {
      ext: ext.name,
      hook: "_circuit_breaker",
      kind: "disabled",
      message: ext.disabledReason,
      at: entry.at,
    });
  }
}

function recordSuccess(ext) {
  // Any successful invocation resets the consecutive-failure streak.
  // The breaker only trips on N-in-a-row, not N-total.
  if (ext._failStreak) ext._failStreak = 0;
}

/**
 * Manually re-enable a disabled extension and clear its failure streak so it
 * isn't immediately re-tripped by the next single failure. Call this from an
 * orchestrator only after fixing the root cause.
 */
export function resetExtension(ext) {
  if (!ext) return;
  ext.enabled = true;
  ext._failStreak = 0;
  delete ext.disabledReason;
}

// ─── Path resolution ─────────────────────────────────────────────

function resolveExtensionsDir(config = {}) {
  return (
    process.env.OPC_EXTENSIONS_DIR ||
    config.extensionsDir ||
    join(os.homedir(), ".opc", "extensions")
  );
}

// ─── Bypass resolution (benchmark mode) ──────────────────────────
//
// Priority (highest wins):
//   1. OPC_DISABLE_EXTENSIONS=1 env  → disable-all
//   2. config.noExtensions === true (from CLI `--no-extensions`) → disable-all
//   3. Array.isArray(config.extensionWhitelist) (from CLI `--extensions a,b`) → whitelist
//   4. default → load all found extensions
//
// Returns one of:
//   { mode: "disable-all", source: "env"|"flag" }
//   { mode: "whitelist",   source: "flag", names: string[] }
//   { mode: "default" }
//
// When mode !== "default", a one-line status is written to stderr unless
// config.quietBypass === true (useful for tests).
export function resolveBypass(config = {}) {
  let decision;
  if (process.env.OPC_DISABLE_EXTENSIONS === "1") {
    decision = { mode: "disable-all", source: "env" };
  } else if (config.noExtensions === true) {
    decision = { mode: "disable-all", source: "flag" };
  } else if (Array.isArray(config.extensionWhitelist)) {
    decision = {
      mode: "whitelist",
      source: "flag",
      names: config.extensionWhitelist.filter(n => typeof n === "string" && n.length > 0),
    };
  } else {
    return { mode: "default" };
  }
  if (!config.quietBypass) {
    if (decision.mode === "disable-all") {
      console.error(`[opc] extensions disabled via ${decision.source === "env" ? "OPC_DISABLE_EXTENSIONS" : "--no-extensions"}`);
    } else if (decision.mode === "whitelist") {
      console.error(`[opc] extensions whitelisted via --extensions: ${decision.names.join(", ") || "(empty)"}`);
    }
  }
  return decision;
}

// ─── Hook normalization (exported — single source of truth) ──────

/**
 * Normalize any hook format to { hooks: { "prompt.append"?, "verdict.append"?, "startup.check"?, "execute.run"?, "artifact.emit"? } }.
 * Accepts both kebab (`prompt.append`, `execute.run`) and camel (`promptAppend`,
 * `executeRun`) named exports, plus the legacy `{ hooks: { ... } }` default-export form.
 */
export function normalizeHook(raw, mod) {
  if (raw && raw.hooks && typeof raw.hooks === "object") {
    return raw;
  }

  const hooks = {};
  const src = mod || raw;
  if (typeof src.promptAppend === "function")   hooks["prompt.append"]   = src.promptAppend;
  if (typeof src.verdictAppend === "function")  hooks["verdict.append"]  = src.verdictAppend;
  if (typeof src.startupCheck === "function")   hooks["startup.check"]   = src.startupCheck;
  if (typeof src.executeRun === "function")     hooks["execute.run"]     = src.executeRun;
  if (typeof src.artifactEmit === "function")   hooks["artifact.emit"]   = src.artifactEmit;
  if (typeof src["prompt.append"] === "function")   hooks["prompt.append"]   = src["prompt.append"];
  if (typeof src["verdict.append"] === "function")  hooks["verdict.append"]  = src["verdict.append"];
  if (typeof src["startup.check"] === "function")   hooks["startup.check"]   = src["startup.check"];
  if (typeof src["execute.run"] === "function")     hooks["execute.run"]     = src["execute.run"];
  if (typeof src["artifact.emit"] === "function")   hooks["artifact.emit"]   = src["artifact.emit"];

  return { hooks };
}

/**
 * Normalize a finding to canonical shape { severity, category, message, file? }.
 */
function normalizeFinding(f) {
  if (!f || typeof f !== "object") return null;
  if (typeof f.severity === "string" && typeof f.category === "string" && typeof f.message === "string") {
    return f;
  }
  if (typeof f.text === "string") {
    let severity = "info";
    if (f.emoji === "🔴") severity = "error";
    else if (f.emoji === "🟡") severity = "warning";
    const textContent = f.text.replace(/^\[.*?\]\s*/, "");
    const colonIdx = textContent.indexOf(":");
    const category = colonIdx > 0 ? textContent.slice(0, colonIdx).trim() : "unknown";
    const message  = colonIdx > 0 ? textContent.slice(colonIdx + 1).trim() : textContent;
    return { severity, category, message, ...(f.file ? { file: f.file } : {}) };
  }
  return null;
}

// ─── Hook invocation with timeout ────────────────────────────────

function withTimeout(promise, ms, onTimeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HookTimeoutError(onTimeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─── Capability matching ─────────────────────────────────────────

// ─── Capability versioning ───────────────────────────────────────
//
// Capability identifiers are strings of form `name@N` where name matches
// /^[a-z][a-z0-9-]*$/ and N is a positive integer (1, 2, …; no leading zeros,
// no @0). A bare `name` (no @N) is auto-upgraded to `name@1` with a one-time
// stderr WARN per bare token
// (so a project using 10 extensions with bare capabilities only prints each
// warning once per process).
//
// Use normalizeCapability() on both sides (provides AND requires) so the
// match is symmetric: a node requiring "foo" matches an ext providing "foo"
// OR "foo@1", and vice versa.
//
// `meta.compatibleCapabilities: string[]` widens what an extension matches
// without changing its canonical provides. Example: an extension upgrading
// visual-check from @1 to @2 can declare compatibleCapabilities: ["visual-check@1"]
// to keep firing for @1-declared nodes during migration.

const CAPABILITY_VERSIONED_RE = /^[a-z][a-z0-9-]*@[1-9]\d*$/;
const CAPABILITY_BARE_RE = /^[a-z][a-z0-9-]*$/;

// Module-level set so warnings fire once per process per bare name.
const _bareCapabilityWarnings = new Set();

/** Test helper — clear warning cache so tests can assert each fire. */
export function _resetBareCapabilityWarnings() {
  _bareCapabilityWarnings.clear();
}

/**
 * Normalize a capability string. Returns canonical `name@N` form.
 * - `foo@2` → `foo@2` (unchanged)
 * - `foo`   → `foo@1` (with one-time stderr WARN per bare name per process)
 * - invalid → returned as-is (caller decides how to handle; matcher will simply not match)
 */
export function normalizeCapability(cap) {
  if (typeof cap !== "string" || cap.length === 0) return cap;
  if (CAPABILITY_VERSIONED_RE.test(cap)) return cap;
  if (CAPABILITY_BARE_RE.test(cap)) {
    if (!_bareCapabilityWarnings.has(cap)) {
      _bareCapabilityWarnings.add(cap);
      console.error(`[opc] WARN: capability '${cap}' missing version suffix — auto-upgrading to '${cap}@1'. Declare '${cap}@1' explicitly to silence this.`);
    }
    return `${cap}@1`;
  }
  return cap;
}

/**
 * Lint a single capability string. Returns { ok, reason } describing whether
 * the string matches the canonical `name@N` form or the bare `name` form.
 * - ok=true, reason="versioned" → `foo@2`
 * - ok=true, reason="bare" → `foo` (still valid, auto-upgrades to @1 with WARN)
 * - ok=false, reason="not-a-string" | "empty" | "invalid-shape" → lint failure
 *
 * Used by `opc-harness extension-test` to surface authoring mistakes as WARN
 * (not FAIL) before the extension is ever loaded by the harness.
 */
export function lintCapability(cap) {
  if (typeof cap !== "string") return { ok: false, reason: "not-a-string" };
  if (cap.length === 0) return { ok: false, reason: "empty" };
  if (CAPABILITY_VERSIONED_RE.test(cap)) return { ok: true, reason: "versioned" };
  if (CAPABILITY_BARE_RE.test(cap)) return { ok: true, reason: "bare" };
  return { ok: false, reason: "invalid-shape" };
}

/**
 * Return true if the extension should fire for the given node's capability requirements.
 * - `requires` undefined/null/[] → NO extensions fire (node doesn't want any specialist)
 * - ext.provides is empty ([]) → never fires (pure startup-check extension)
 * - otherwise: fire if any (normalized) ext.provides OR ext.compatibleCapabilities ∈ (normalized) requires
 */
function extensionMatches(requires, provides, compatible) {
  if (!Array.isArray(requires) || requires.length === 0) return false;
  if (!Array.isArray(provides) || provides.length === 0) return false;
  const reqSet = new Set(requires.map(normalizeCapability));
  const provAll = [
    ...provides,
    ...(Array.isArray(compatible) ? compatible : []),
  ].map(normalizeCapability);
  return provAll.some(cap => reqSet.has(cap));
}

/**
 * F2: WARN once per registry when ctx.nodeCapabilities is unset/empty.
 * Mutates registry._warnedMissingCaps = true on first fire. Silent thereafter.
 */
function warnMissingNodeCapsOnce(registry, context) {
  if (!registry || typeof registry !== "object") return;
  if (registry._warnedMissingCaps) return;
  const caps = context?.nodeCapabilities;
  if (Array.isArray(caps) && caps.length > 0) return;
  console.error("[extensions] WARN: ctx.nodeCapabilities not set — no hooks will match");
  registry._warnedMissingCaps = true;
}

// ─── loadExtensions ──────────────────────────────────────────────

/**
 * Load all extensions from extensionsDir.
 * Scans for subdirs that contain hook.mjs. Skips dotfiles silently.
 */
export async function loadExtensions(config = {}) {
  // Benchmark bypass: short-circuit BEFORE scanning disk or evaluating required set.
  // Required extensions are explicitly waived under bypass — this is by design: a
  // benchmark run must be reproducible without any private extension installed.
  const bypass = resolveBypass(config);
  if (bypass.mode === "disable-all") {
    return { extensions: [], applied: [], failures: [] };
  }

  const extensionsDir = resolveExtensionsDir(config);
  const required = new Set(Array.isArray(config.requiredExtensions) ? config.requiredExtensions : []);
  const orderOverride = Array.isArray(config.extensionOrder) ? config.extensionOrder : null;
  const whitelist = bypass.mode === "whitelist" ? new Set(bypass.names) : null;

  if (!existsSync(extensionsDir)) {
    if (required.size > 0) {
      const missing = [...required][0];
      throw new Error(`FATAL: required extension '${missing}' missing or failed startup.check`);
    }
    return { extensions: [], applied: [], failures: [] };
  }

  let entries;
  try {
    entries = await readdir(extensionsDir, { withFileTypes: true });
  } catch {
    if (required.size > 0) {
      const missing = [...required][0];
      throw new Error(`FATAL: required extension '${missing}' missing or failed startup.check`);
    }
    return { extensions: [], applied: [], failures: [] };
  }

  // Only consider subdirs that:
  //   1. Are not dotfiles (filter .git, .DS_Store, etc. — not extensions)
  //   2. Contain a hook.mjs file (anything else is not an extension)
  //   3. Are in the whitelist (if --extensions was given)
  let found = entries
    .filter(e => e.isDirectory() && !e.name.startsWith("."))
    .filter(e => existsSync(join(extensionsDir, e.name, "hook.mjs")))
    .map(e => e.name);

  if (whitelist) {
    found = found.filter(n => whitelist.has(n));
  }

  for (const name of required) {
    if (!found.includes(name)) {
      throw new Error(`FATAL: required extension '${name}' missing or failed startup.check`);
    }
  }

  let ordered;
  if (orderOverride) {
    const extras = found.filter(n => !orderOverride.includes(n)).sort();
    ordered = [...orderOverride.filter(n => found.includes(n)), ...extras];
  } else {
    ordered = found.slice().sort();
  }

  const extensions = [];
  const applied = [];

  for (const name of ordered) {
    const extDir = join(extensionsDir, name);
    const hookPath = join(extDir, "hook.mjs");
    const promptPath = join(extDir, "prompt.md");
    const isRequired = required.has(name);

    let mod = null;
    try {
      mod = await import(hookPath);
    } catch (err) {
      if (isRequired) {
        throw new Error(`FATAL: required extension '${name}' missing or failed startup.check`);
      }
      console.error(`WARN: optional extension ${name} failed to load:`, err.message);
      continue;
    }

    const raw = mod.default || mod;
    const hook = normalizeHook(raw, mod);

    // Read meta — supports named `export const meta` or `default.meta`
    const meta = mod.meta || (mod.default && mod.default.meta) || {};

    // Validate meta.provides shape (capability contract)
    let provides = meta.provides;
    if (provides === undefined) provides = [];
    if (!Array.isArray(provides)) {
      console.error(`WARN: extension ${name} meta.provides is not an array — treating as []`);
      provides = [];
    }
    meta.provides = provides;

    // Validate optional meta.compatibleCapabilities (U1.2 — capability versioning)
    let compatible = meta.compatibleCapabilities;
    if (compatible === undefined) compatible = [];
    if (!Array.isArray(compatible)) {
      console.error(`WARN: extension ${name} meta.compatibleCapabilities is not an array — treating as []`);
      compatible = [];
    }
    meta.compatibleCapabilities = compatible;

    let promptMd = "";
    if (existsSync(promptPath)) {
      try { promptMd = readFileSync(promptPath, "utf8"); } catch { /* best effort */ }
    }

    if (typeof hook.hooks["startup.check"] === "function") {
      try {
        await withTimeout(
          Promise.resolve(hook.hooks["startup.check"]({})),
          HOOK_TIMEOUT_MS,
          `startup.check timed out after ${HOOK_TIMEOUT_MS}ms`
        );
      } catch (err) {
        if (isRequired) {
          throw new Error(`FATAL: required extension '${name}' missing or failed startup.check`);
        }
        console.error(`WARN: optional extension ${name} startup.check failed:`, err.message);
        continue;
      }
    }

    extensions.push({ name, promptMd, hook, meta, enabled: true });
    applied.push(name);
  }

  for (const name of required) {
    if (!applied.includes(name)) {
      throw new Error(`FATAL: required extension '${name}' missing or failed startup.check`);
    }
  }

  return { extensions, applied, failures: [] };
}

// ─── firePromptAppend ────────────────────────────────────────────

/**
 * Call prompt.append on extensions whose `provides` matches context.nodeCapabilities.
 */
export async function firePromptAppend(registry, context) {
  const parts = [];
  warnMissingNodeCapsOnce(registry, context);
  const requires = context.nodeCapabilities || [];

  for (const ext of registry.extensions) {
    if (!ext.enabled) continue;
    if (!extensionMatches(requires, ext.meta.provides, ext.meta.compatibleCapabilities)) continue;

    const fn = ext.hook?.hooks?.["prompt.append"];
    if (typeof fn !== "function") continue;

    try {
      const result = await withTimeout(
        Promise.resolve(fn(context)),
        HOOK_TIMEOUT_MS,
        `prompt.append timed out after ${HOOK_TIMEOUT_MS}ms`
      );
      if (result === undefined || result === null || result === "") {
        recordSuccess(ext);
        continue;
      }
      if (typeof result !== "string") {
        console.error(`WARN: extension ${ext.name} prompt.append returned ${typeof result}, expected string — ignoring`);
        recordFailure(registry, ext, "prompt.append", "bad-return", `returned ${typeof result}, expected string`);
        continue;
      }
      parts.push(result);
      recordSuccess(ext);
    } catch (err) {
      console.error(`WARN: extension ${ext.name} prompt.append failed:`, err.message);
      const kind = isHookTimeoutError(err) ? "timeout" : "throw";
      recordFailure(registry, ext, "prompt.append", kind, err.message);
    }
  }
  return parts.join("\n\n");
}

// ─── fireVerdictAppend ───────────────────────────────────────────

/**
 * Call verdict.append on extensions whose `provides` matches context.nodeCapabilities.
 * Writes findings to {context.runDir}/eval-extensions.md.
 */
export async function fireVerdictAppend(registry, context) {
  const allFindings = [];
  warnMissingNodeCapsOnce(registry, context);
  const requires = context.nodeCapabilities || [];

  for (const ext of registry.extensions) {
    if (!ext.enabled) continue;
    if (!extensionMatches(requires, ext.meta.provides, ext.meta.compatibleCapabilities)) continue;

    const fn = ext.hook?.hooks?.["verdict.append"];
    if (typeof fn !== "function") continue;

    try {
      const findings = await withTimeout(
        Promise.resolve(fn(context)),
        HOOK_TIMEOUT_MS,
        `verdict.append timed out after ${HOOK_TIMEOUT_MS}ms`
      );
      if (findings === undefined || findings === null) {
        recordSuccess(ext);
        continue;
      }
      if (!Array.isArray(findings)) {
        console.error(`WARN: extension ${ext.name} verdict.append returned ${typeof findings}, expected array — ignoring`);
        recordFailure(registry, ext, "verdict.append", "bad-return", `returned ${typeof findings}, expected array`);
        continue;
      }
      for (const raw of findings) {
        const normalized = normalizeFinding(raw);
        if (normalized) allFindings.push({ ...normalized, _ext: ext.name });
      }
      recordSuccess(ext);
    } catch (err) {
      console.error(`WARN: extension ${ext.name} verdict.append failed:`, err.message);
      const kind = isHookTimeoutError(err) ? "timeout" : "throw";
      recordFailure(registry, ext, "verdict.append", kind, err.message);
    }
  }

  if (!context.runDir) return { findings: allFindings, filePath: null };

  const lines = ["# Extension Findings", ""];
  for (const f of allFindings) {
    const emoji = f.severity === "error" ? "🔴" : f.severity === "warning" ? "🟡" : "🔵";
    const filePart = f.file ? ` in ${f.file}` : "";
    lines.push(`${emoji} ${f.category}: ${f.message}${filePart}`);
  }
  if (allFindings.length === 0) {
    lines.push("🔵 extensions: No extension findings");
  }
  lines.push("");

  mkdirSync(context.runDir, { recursive: true });
  const filePath = join(context.runDir, "eval-extensions.md");
  atomicWriteSync(filePath, lines.join("\n"));

  // Sibling failure report — observable signal for the gate.
  // Always written when runDir is set (empty file means "no failures this run").
  // Filename intentionally lacks the `eval-` prefix so synthesize's `eval*.md`
  // ingestion does NOT pick it up — the failure report is infrastructure
  // signal, not a role evaluation, and should not trip thin-eval guards.
  writeFailureReport(registry, context.runDir);

  return { findings: allFindings, filePath };
}

// ─── fireExecuteRun ──────────────────────────────────────────────

/**
 * Call `execute.run` on extensions whose `provides` matches context.nodeCapabilities.
 *
 * Execute hooks are fire-and-forget: they can return any value (ignored) and
 * exist to let extensions run side-effectful verification during executor
 * nodes (e.g. crawl a URL, run Playwright, hit an API). Failures are isolated
 * exactly like prompt/verdict: recorded in registry.failures[], throwing
 * extension does not block siblings, circuit-breaker still trips after N in a
 * row. Return value shape is not enforced — extensions may return strings /
 * objects / undefined.
 */
export async function fireExecuteRun(registry, context) {
  const results = [];
  warnMissingNodeCapsOnce(registry, context);
  const requires = context.nodeCapabilities || [];

  for (const ext of registry.extensions) {
    if (!ext.enabled) continue;
    if (!extensionMatches(requires, ext.meta.provides, ext.meta.compatibleCapabilities)) continue;

    const fn = ext.hook?.hooks?.["execute.run"];
    if (typeof fn !== "function") continue;

    try {
      const result = await withTimeout(
        Promise.resolve(fn(context)),
        HOOK_TIMEOUT_MS,
        `execute.run timed out after ${HOOK_TIMEOUT_MS}ms`
      );
      results.push({ ext: ext.name, result });
      recordSuccess(ext);
    } catch (err) {
      console.error(`WARN: extension ${ext.name} execute.run failed:`, err.message);
      const kind = isHookTimeoutError(err) ? "timeout" : "throw";
      recordFailure(registry, ext, "execute.run", kind, err.message);
    }
  }
  return results;
}

// ─── fireArtifactEmit ────────────────────────────────────────────

/**
 * Call `artifact.emit` on matching extensions. Each extension may return an
 * array of `{ name: string, content: string|Buffer }`. Files are written to
 * `<runDir>/ext-<extName>/<name>`; a summary array of
 * `{ type: "ext-artifact", ext, path }` entries is returned and can be
 * merged into `handshake.artifacts[]` by the caller.
 *
 * Safety: `name` is basename()'d before joining. Any `name` that contains a
 * path separator, `..`, or is empty after normalization is skipped with a WARN
 * — extensions never write outside their per-ext subdir.
 */
export async function fireArtifactEmit(registry, context) {
  const emitted = [];
  warnMissingNodeCapsOnce(registry, context);
  const requires = context.nodeCapabilities || [];
  if (!context.runDir) return emitted;

  const { basename } = await import("path");

  for (const ext of registry.extensions) {
    if (!ext.enabled) continue;
    if (!extensionMatches(requires, ext.meta.provides, ext.meta.compatibleCapabilities)) continue;

    const fn = ext.hook?.hooks?.["artifact.emit"];
    if (typeof fn !== "function") continue;

    let items;
    try {
      items = await withTimeout(
        Promise.resolve(fn(context)),
        HOOK_TIMEOUT_MS,
        `artifact.emit timed out after ${HOOK_TIMEOUT_MS}ms`
      );
      if (items === undefined || items === null) { recordSuccess(ext); continue; }
      if (!Array.isArray(items)) {
        console.error(`WARN: extension ${ext.name} artifact.emit returned ${typeof items}, expected array — ignoring`);
        recordFailure(registry, ext, "artifact.emit", "bad-return", `returned ${typeof items}, expected array`);
        continue;
      }
    } catch (err) {
      console.error(`WARN: extension ${ext.name} artifact.emit failed:`, err.message);
      const kind = isHookTimeoutError(err) ? "timeout" : "throw";
      recordFailure(registry, ext, "artifact.emit", kind, err.message);
      continue;
    }

    const extDir = join(context.runDir, `ext-${ext.name}`);
    mkdirSync(extDir, { recursive: true });
    let anyItemFailed = false;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const rawName = item.name;
      if (typeof rawName !== "string" || rawName.length === 0) {
        console.error(`WARN: extension ${ext.name} artifact.emit item missing string 'name' — skipping`);
        continue;
      }
      const safeName = basename(rawName);
      if (safeName !== rawName || safeName === "" || safeName === "." || safeName === "..") {
        console.error(`WARN: extension ${ext.name} artifact.emit name '${rawName}' is not a plain basename — skipping`);
        continue;
      }
      const content = item.content;
      // Accept string, Buffer, or any ArrayBufferView (Uint8Array, DataView, etc.)
      // Modern APIs (crypto.subtle, TextEncoder, Playwright screenshots) commonly
      // return Uint8Array — tight Buffer check would silently drop those.
      const isBinaryView = ArrayBuffer.isView(content);
      if (typeof content !== "string" && !isBinaryView) {
        console.error(`WARN: extension ${ext.name} artifact.emit '${rawName}' content is not string/Buffer/ArrayBufferView — skipping`);
        continue;
      }
      const payload = typeof content === "string" || Buffer.isBuffer(content)
        ? content
        : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
      const outPath = join(extDir, safeName);
      try {
        atomicWriteSync(outPath, payload);
        emitted.push({ type: "ext-artifact", ext: ext.name, path: outPath });
      } catch (err) {
        console.error(`WARN: extension ${ext.name} artifact.emit write failed for '${safeName}': ${err.message}`);
        recordFailure(registry, ext, "artifact.emit", "throw", `write ${safeName}: ${err.message}`);
        anyItemFailed = true;
      }
    }
    // Only reset _failStreak if every item in this call succeeded. Otherwise
    // a per-item write failure would be undone by recordSuccess on the same
    // iteration and the circuit-breaker would never trip on persistent
    // write failures (U1.6r semantics F1 fix-forward).
    if (!anyItemFailed) recordSuccess(ext);
  }
  return emitted;
}

// ─── Failure report ──────────────────────────────────────────────

/**
 * Write registry.failures[] to {runDir}/extension-failures.md.
 * Filename has NO `eval-` prefix on purpose: the synthesize command ingests
 * `eval*.md` as role evaluations, which would trip thin-eval / no-code-refs
 * guards on every failure-bearing run. The orchestrator surfaces this file
 * through a separate path (gate hook), not via synthesize.
 */
export function writeFailureReport(registry, runDir) {
  if (!runDir) return;
  const failures = Array.isArray(registry.failures) ? registry.failures : [];
  const dropped = registry.failuresDropped || 0;
  const reportPath = join(runDir, "extension-failures.md");
  const sidecarPath = join(runDir, "extension-failures.json");

  // U2.8c: Cross-command merge (G3) via JSON sidecar.
  //
  // Previous attempt parsed the markdown via regex; that was fragile (missing
  // /u flag for emoji, ambiguous ext.hook split on dots) and silently
  // degenerated to overwrite. The structurally correct fix is to keep the
  // canonical record in a machine-readable JSON sidecar and render the
  // markdown view from JSON. Parser/writer skew becomes impossible.
  //
  // Each CLI invocation reads the sidecar, unions with this run's
  // registry.failures (dedup on ext|hook|kind|message), then writes BOTH
  // sidecar + markdown atomically.
  let priorEntries = [];
  let priorDropped = 0;
  if (existsSync(sidecarPath)) {
    try {
      const data = JSON.parse(readFileSync(sidecarPath, "utf8"));
      if (Array.isArray(data.failures)) priorEntries = data.failures;
      if (typeof data.droppedTotal === "number") priorDropped = data.droppedTotal;
    } catch { /* corrupt sidecar = treat as empty, will be overwritten */ }
  }

  // U2.8e (#2): use JSON.stringify on a tuple instead of `|`-joined string —
  // dedup key is unambiguous even if any field contains `|`.
  const seen = new Set();
  const merged = [];
  for (const e of [...priorEntries, ...failures]) {
    if (!e || typeof e !== "object") continue;
    const key = JSON.stringify([e.ext, e.hook, e.kind, e.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }

  // U2.8e (#5): droppedTotal accumulates across CLI invocations (cap-overflow
  // is a monotonically growing signal — overwriting with the current call's
  // dropped count silently loses prior drops).
  const droppedTotal = priorDropped + dropped;

  // Sidecar = source of truth.
  const sidecar = { failures: merged, droppedTotal };
  mkdirSync(runDir, { recursive: true });
  atomicWriteSync(sidecarPath, JSON.stringify(sidecar, null, 2));

  // Markdown = derived view for human/grep consumption.
  const lines = ["# Extension Hook Failures", ""];
  if (merged.length === 0) {
    lines.push("🔵 extension-failures: No hook failures recorded");
  } else {
    if (droppedTotal > 0) {
      lines.push(`> Note: ${droppedTotal} earlier failure record(s) dropped (cap=${FAILURE_LOG_CAP}).`);
      lines.push("");
    }
    for (const f of merged) {
      const emoji = f.kind === "disabled" ? "🔴" : "🟡";
      lines.push(`${emoji} ${f.ext}.${f.hook} [${f.kind}] ${f.message} @ ${f.at}`);
    }
  }
  lines.push("");
  atomicWriteSync(reportPath, lines.join("\n"));
}

// ─── Survivors (post-breaker filter for handshake stamping) ──────
//
// `registry.applied` is the LOAD-TIME snapshot — every extension that
// successfully loaded, regardless of subsequent breaker trips. For
// `handshake.extensionsApplied` we want SURVIVORS (still-enabled at the
// moment of stamping) so a downstream gate / human review sees who
// actually contributed, not who tried to.
export function survivingExtensions(registry) {
  if (!registry || !Array.isArray(registry.extensions)) return [];
  return registry.extensions
    .filter((e) => e && e.enabled !== false)
    .map((e) => e.name);
}

// ─── Strict mode (CI enforcement) ────────────────────────────────
// OPC_STRICT_EXTENSIONS=1 turns recorded extension hook failures into a
// non-zero process exit. Default mode isolates failures (per-extension
// breaker) and returns 0 — strict mode preserves the same isolation +
// breaker behavior but signals failure to the caller (CI build).
//
// Contract:
//   - Called AFTER hooks fire and AFTER writeFailureReport / eval-extensions.md
//     are written. Isolation invariant: healthy siblings' outputs are already
//     recorded by the time strict checks failures.
//   - No-op when env != "1" (zero overhead in default mode).
//   - No-op when registry.failures is empty (no false positives on clean runs).
//   - Emits one stderr line per recorded failure naming STRICT mode + the
//     extension + the hook so operators can diagnose CI breakage at a glance.
//   - Exits with code 2 (distinguishes strict-trip from generic CLI errors
//     which use exit 1).
export function strictModeEnabled() {
  return process.env.OPC_STRICT_EXTENSIONS === "1";
}

export function enforceStrictMode(registry) {
  if (!strictModeEnabled()) return;
  const failures = Array.isArray(registry?.failures) ? registry.failures : [];
  if (failures.length === 0) return;
  for (const f of failures) {
    console.error(`[opc] STRICT: ${f.ext} failed ${f.hook} — exiting non-zero`);
  }
  process.exit(2);
}

// ─── Registry cache helpers ──────────────────────────────────────

export function saveRegistryCache(dir, registry) {
  const cachePath = join(dir, ".ext-registry.json");
  const data = {
    applied: registry.applied,
    timestamp: new Date().toISOString(),
    bypass: registry.bypass || null,
  };
  atomicWriteSync(cachePath, JSON.stringify(data, null, 2) + "\n");
}

export function readRegistryApplied(dir) {
  const cachePath = join(dir, ".ext-registry.json");
  if (!existsSync(cachePath)) return [];
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")).applied || [];
  } catch { return []; }
}
