// extensions.mjs — OPC Extension System
// Loads user extensions from ~/.opc/extensions/, fires hooks at call sites.
// No module-level singletons — loadExtensions returns a registry object.
//
// Hook interface (hook.mjs can use either format):
//
//   New-style (recommended):
//     export const meta = { nodes: ["code-review", "review"], name: "my-ext" };
//     export async function promptAppend(ctx) { return "## Section\n..."; }
//     export async function verdictAppend(ctx) { return [{ severity, category, message }]; }
//     export async function startupCheck(ctx) { /* throw to abort load */ }
//
//   Legacy new-style (hooks object):
//     export default { hooks: { "prompt.append": fn, "verdict.append": fn } }
//
//   Legacy named exports (still supported, auto-normalized):
//     export async function promptAppend(ctx) { ... }
//     export async function verdictAppend(ctx) { ... }
//
// Finding shape: { severity: "error"|"warning"|"info", category: string, message: string, file?: string }
// Old-style findings { emoji, text, file } are auto-normalized.

import { readFileSync, existsSync, mkdirSync } from "fs";
import { readdir } from "fs/promises";
import { join } from "path";
import os from "os";
import { atomicWriteSync } from "./util.mjs";

// ─── Path resolution ─────────────────────────────────────────────

function resolveExtensionsDir(config = {}) {
  return (
    process.env.OPC_EXTENSIONS_DIR ||
    config.extensionsDir ||
    join(os.homedir(), ".opc", "extensions")
  );
}

// ─── Hook normalization ──────────────────────────────────────────

/**
 * Normalize any hook format to { hooks: { "prompt.append"?, "verdict.append"?, "startup.check"? } }.
 * Supports:
 *   1. New named exports: export async function promptAppend(ctx)
 *   2. Legacy hooks object: export default { hooks: { "prompt.append": fn } }
 *   3. CamelCase startup: export async function startupCheck(ctx)
 */
function normalizeHook(raw, mod) {
  // Format 2: hooks object on default export
  if (raw && raw.hooks && typeof raw.hooks === "object") {
    return raw;
  }

  // Format 1 / 3: named exports on module namespace
  const hooks = {};
  // Check both the raw object and the original module namespace
  const src = mod || raw;
  if (typeof src.promptAppend === "function")   hooks["prompt.append"]   = src.promptAppend;
  if (typeof src.verdictAppend === "function")  hooks["verdict.append"]  = src.verdictAppend;
  if (typeof src.startupCheck === "function")   hooks["startup.check"]   = src.startupCheck;
  // Also accept dot-notation keys directly on named exports
  if (typeof src["prompt.append"] === "function")   hooks["prompt.append"]   = src["prompt.append"];
  if (typeof src["verdict.append"] === "function")  hooks["verdict.append"]  = src["verdict.append"];
  if (typeof src["startup.check"] === "function")   hooks["startup.check"]   = src["startup.check"];

  return { hooks };
}

/**
 * Normalize a finding to canonical shape { severity, category, message, file? }.
 * Handles old-style { emoji, text, file } automatically.
 */
function normalizeFinding(f) {
  if (!f || typeof f !== "object") return null;

  // Already canonical
  if (typeof f.severity === "string" && typeof f.category === "string" && typeof f.message === "string") {
    return f;
  }

  // Old-style: { emoji, text, file }
  if (typeof f.text === "string") {
    let severity = "info";
    if (f.emoji === "🔴") severity = "error";
    else if (f.emoji === "🟡") severity = "warning";
    // text format: "[ext-name] category: message"
    const textContent = f.text.replace(/^\[.*?\]\s*/, ""); // strip [ext-name] prefix
    const colonIdx = textContent.indexOf(":");
    const category = colonIdx > 0 ? textContent.slice(0, colonIdx).trim() : "unknown";
    const message  = colonIdx > 0 ? textContent.slice(colonIdx + 1).trim() : textContent;
    return { severity, category, message, ...(f.file ? { file: f.file } : {}) };
  }

  return null;
}

// ─── loadExtensions ──────────────────────────────────────────────

/**
 * Load all extensions from extensionsDir.
 * Runs startup.check for each. Required extensions that fail → throw FATAL.
 * Optional extensions that fail → console.error, continue.
 * @returns {Promise<ExtensionRegistry>}
 */
export async function loadExtensions(config = {}) {
  const extensionsDir = resolveExtensionsDir(config);
  const required = new Set(Array.isArray(config.requiredExtensions) ? config.requiredExtensions : []);
  const orderOverride = Array.isArray(config.extensionOrder) ? config.extensionOrder : null;

  // Check required extensions exist even before scanning
  if (!existsSync(extensionsDir)) {
    if (required.size > 0) {
      const missing = [...required][0];
      throw new Error(`FATAL: required extension '${missing}' missing or failed startup.check`);
    }
    return { extensions: [], applied: [] };
  }

  // Scan directory for extension subdirectories
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

  const found = entries
    .filter(e => e.isDirectory())
    .map(e => e.name);

  // Verify all required extensions are present in directory
  for (const name of required) {
    if (!found.includes(name)) {
      throw new Error(`FATAL: required extension '${name}' missing or failed startup.check`);
    }
  }

  // Determine ordering
  let ordered;
  if (orderOverride) {
    // Use explicit order; append any extras not listed
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

    // Load hook module
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

    // Normalize hook interface (supports all formats)
    const raw = mod.default || mod;
    const hook = normalizeHook(raw, mod);

    // Read meta (nodes, name, etc.)
    const meta = mod.meta || (mod.default && mod.default.meta) || {};

    // Read prompt.md (optional)
    let promptMd = "";
    if (existsSync(promptPath)) {
      try { promptMd = readFileSync(promptPath, "utf8"); } catch { /* best effort */ }
    }

    // Run startup.check
    if (typeof hook.hooks["startup.check"] === "function") {
      try {
        await hook.hooks["startup.check"]({});
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

  // Verify all required extensions made it to applied
  for (const name of required) {
    if (!applied.includes(name)) {
      throw new Error(`FATAL: required extension '${name}' missing or failed startup.check`);
    }
  }

  return { extensions, applied };
}

// ─── firePromptAppend ────────────────────────────────────────────

/**
 * Call prompt.append on all enabled extensions in order.
 * Skips extensions whose meta.nodes does not include context.node (if meta.nodes is set).
 * @returns {Promise<string>} concatenated append strings
 */
export async function firePromptAppend(registry, context) {
  const parts = [];
  for (const ext of registry.extensions) {
    if (!ext.enabled) continue;
    // meta.nodes routing: skip if current node not in declared node list
    if (ext.meta.nodes && context.node && !ext.meta.nodes.includes(context.node)) continue;
    const fn = ext.hook?.hooks?.["prompt.append"];
    if (typeof fn !== "function") continue;
    try {
      const result = await fn(context);
      if (result && typeof result === "string" && result.length > 0) {
        parts.push(result);
      }
    } catch (err) {
      console.error(`WARN: extension ${ext.name} prompt.append failed:`, err.message);
    }
  }
  return parts.join("\n\n");
}

// ─── fireVerdictAppend ───────────────────────────────────────────

/**
 * Call verdict.append on all enabled extensions in order.
 * Skips extensions whose meta.nodes does not include context.node (if meta.nodes is set).
 * Write findings to {context.runDir}/eval-extensions.md
 */
export async function fireVerdictAppend(registry, context) {
  const allFindings = [];

  for (const ext of registry.extensions) {
    if (!ext.enabled) continue;
    // meta.nodes routing: skip if current node not in declared node list
    if (ext.meta.nodes && context.node && !ext.meta.nodes.includes(context.node)) continue;
    const fn = ext.hook?.hooks?.["verdict.append"];
    if (typeof fn !== "function") continue;
    try {
      const findings = await fn(context);
      if (Array.isArray(findings)) {
        for (const raw of findings) {
          const normalized = normalizeFinding(raw);
          if (normalized) allFindings.push({ ...normalized, _ext: ext.name });
        }
      }
    } catch (err) {
      console.error(`WARN: extension ${ext.name} verdict.append failed:`, err.message);
    }
  }

  if (!context.runDir) return;

  // Serialize to eval-extensions.md regardless of count (even if 0, create empty-ish file)
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

/**
 * Write registry to {dir}/.ext-registry.json for cross-call-site access.
 */
export function saveRegistryCache(dir, registry) {
  const cachePath = join(dir, ".ext-registry.json");
  const data = { applied: registry.applied, timestamp: new Date().toISOString() };
  atomicWriteSync(cachePath, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Read applied[] from {dir}/.ext-registry.json; returns [] if missing.
 */
export function readRegistryApplied(dir) {
  const cachePath = join(dir, ".ext-registry.json");
  if (!existsSync(cachePath)) return [];
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")).applied || [];
  } catch { return []; }
}
