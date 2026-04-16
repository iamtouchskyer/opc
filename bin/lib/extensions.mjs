// extensions.mjs — OPC Extension System
// Loads user extensions from ~/.opc/extensions/, fires hooks at call sites.
// No module-level singletons — loadExtensions returns a registry object.

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

    // Load hook
    let hook = null;
    try {
      const mod = await import(hookPath);
      hook = mod.default || mod;
    } catch (err) {
      if (isRequired) {
        throw new Error(`FATAL: required extension '${name}' missing or failed startup.check`);
      }
      console.error(`WARN: optional extension ${name} startup.check failed:`, err.message);
      continue;
    }

    // Read prompt.md (optional)
    let promptMd = "";
    if (existsSync(promptPath)) {
      try { promptMd = readFileSync(promptPath, "utf8"); } catch { /* best effort */ }
    }

    // Run startup.check
    if (hook.hooks && typeof hook.hooks["startup.check"] === "function") {
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

    extensions.push({ name, promptMd, hook, enabled: true });
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
 * @returns {Promise<string>} concatenated append strings
 */
export async function firePromptAppend(registry, context) {
  const parts = [];
  for (const ext of registry.extensions) {
    if (!ext.enabled) continue;
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
 * Write findings to {context.runDir}/eval-extensions.md
 */
export async function fireVerdictAppend(registry, context) {
  const allFindings = [];

  for (const ext of registry.extensions) {
    if (!ext.enabled) continue;
    const fn = ext.hook?.hooks?.["verdict.append"];
    if (typeof fn !== "function") continue;
    try {
      const findings = await fn(context);
      if (Array.isArray(findings)) {
        for (const f of findings) {
          allFindings.push({ ...f, _ext: ext.name });
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
    const filePart = f.file ? ` in ${f.file}` : "";
    lines.push(`${f.severity} ${f.category}: ${f.message}${filePart}`);
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
