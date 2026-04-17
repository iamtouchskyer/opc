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

// ─── Path resolution ─────────────────────────────────────────────

function resolveExtensionsDir(config = {}) {
  return (
    process.env.OPC_EXTENSIONS_DIR ||
    config.extensionsDir ||
    join(os.homedir(), ".opc", "extensions")
  );
}

// ─── Hook normalization (exported — single source of truth) ──────

/**
 * Normalize any hook format to { hooks: { "prompt.append"?, "verdict.append"?, "startup.check"? } }.
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
  if (typeof src["prompt.append"] === "function")   hooks["prompt.append"]   = src["prompt.append"];
  if (typeof src["verdict.append"] === "function")  hooks["verdict.append"]  = src["verdict.append"];
  if (typeof src["startup.check"] === "function")   hooks["startup.check"]   = src["startup.check"];

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
    timer = setTimeout(() => reject(new Error(onTimeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─── Capability matching ─────────────────────────────────────────

/**
 * Return true if the extension should fire for the given node's capability requirements.
 * - `requires` undefined/null/[] → NO extensions fire (node doesn't want any specialist)
 * - ext.provides is empty ([]) → never fires (pure startup-check extension)
 * - otherwise: fire if any ext.provides ∈ requires
 */
function extensionMatches(requires, provides) {
  if (!Array.isArray(requires) || requires.length === 0) return false;
  if (!Array.isArray(provides) || provides.length === 0) return false;
  return provides.some(cap => requires.includes(cap));
}

// ─── loadExtensions ──────────────────────────────────────────────

/**
 * Load all extensions from extensionsDir.
 * Scans for subdirs that contain hook.mjs. Skips dotfiles silently.
 */
export async function loadExtensions(config = {}) {
  const extensionsDir = resolveExtensionsDir(config);
  const required = new Set(Array.isArray(config.requiredExtensions) ? config.requiredExtensions : []);
  const orderOverride = Array.isArray(config.extensionOrder) ? config.extensionOrder : null;

  if (!existsSync(extensionsDir)) {
    if (required.size > 0) {
      const missing = [...required][0];
      throw new Error(`FATAL: required extension '${missing}' missing or failed startup.check`);
    }
    return { extensions: [], applied: [] };
  }

  let entries;
  try {
    entries = await readdir(extensionsDir, { withFileTypes: true });
  } catch {
    if (required.size > 0) {
      const missing = [...required][0];
      throw new Error(`FATAL: required extension '${missing}' missing or failed startup.check`);
    }
    return { extensions: [], applied: [] };
  }

  // Only consider subdirs that:
  //   1. Are not dotfiles (filter .git, .DS_Store, etc. — not extensions)
  //   2. Contain a hook.mjs file (anything else is not an extension)
  const found = entries
    .filter(e => e.isDirectory() && !e.name.startsWith("."))
    .filter(e => existsSync(join(extensionsDir, e.name, "hook.mjs")))
    .map(e => e.name);

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

  return { extensions, applied };
}

// ─── firePromptAppend ────────────────────────────────────────────

/**
 * Call prompt.append on extensions whose `provides` matches context.nodeCapabilities.
 */
export async function firePromptAppend(registry, context) {
  const parts = [];
  const requires = context.nodeCapabilities || [];

  for (const ext of registry.extensions) {
    if (!ext.enabled) continue;
    if (!extensionMatches(requires, ext.meta.provides)) continue;

    const fn = ext.hook?.hooks?.["prompt.append"];
    if (typeof fn !== "function") continue;

    try {
      const result = await withTimeout(
        Promise.resolve(fn(context)),
        HOOK_TIMEOUT_MS,
        `prompt.append timed out after ${HOOK_TIMEOUT_MS}ms`
      );
      if (result === undefined || result === null || result === "") continue;
      if (typeof result !== "string") {
        console.error(`WARN: extension ${ext.name} prompt.append returned ${typeof result}, expected string — ignoring`);
        continue;
      }
      parts.push(result);
    } catch (err) {
      console.error(`WARN: extension ${ext.name} prompt.append failed:`, err.message);
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
  const requires = context.nodeCapabilities || [];

  for (const ext of registry.extensions) {
    if (!ext.enabled) continue;
    if (!extensionMatches(requires, ext.meta.provides)) continue;

    const fn = ext.hook?.hooks?.["verdict.append"];
    if (typeof fn !== "function") continue;

    try {
      const findings = await withTimeout(
        Promise.resolve(fn(context)),
        HOOK_TIMEOUT_MS,
        `verdict.append timed out after ${HOOK_TIMEOUT_MS}ms`
      );
      if (findings === undefined || findings === null) continue;
      if (!Array.isArray(findings)) {
        console.error(`WARN: extension ${ext.name} verdict.append returned ${typeof findings}, expected array — ignoring`);
        continue;
      }
      for (const raw of findings) {
        const normalized = normalizeFinding(raw);
        if (normalized) allFindings.push({ ...normalized, _ext: ext.name });
      }
    } catch (err) {
      console.error(`WARN: extension ${ext.name} verdict.append failed:`, err.message);
    }
  }

  if (!context.runDir) return;

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
  atomicWriteSync(join(context.runDir, "eval-extensions.md"), lines.join("\n"));
}

// ─── Registry cache helpers ──────────────────────────────────────

export function saveRegistryCache(dir, registry) {
  const cachePath = join(dir, ".ext-registry.json");
  const data = { applied: registry.applied, timestamp: new Date().toISOString() };
  atomicWriteSync(cachePath, JSON.stringify(data, null, 2) + "\n");
}

export function readRegistryApplied(dir) {
  const cachePath = join(dir, ".ext-registry.json");
  if (!existsSync(cachePath)) return [];
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")).applied || [];
  } catch { return []; }
}
