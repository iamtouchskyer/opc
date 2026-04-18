// config-layering.mjs — U1.4: layered OPC config resolution
//
// Merge order (low → high priority):
//   1. user   — ~/.opc/config.json
//   2. repo   — <nearest-ancestor-of-harnessDir>/.opc/config.json
//   3. cli    — { ...parseBypassArgs(args), ... } passed in by caller
//
// Merge rules:
//   • scalar keys       — high-wins (cli > repo > user)
//   • object keys       — deep-merge (recursive per-key)
//   • extensions        — set-union across all three layers (order preserved: user, then repo-extras, then cli-extras)
//   • disabledExtensions — set-union; any layer's "disabled" overrides any other
//                          layer's "enabled" (disabled wins, per plan)
//   • arrays (other than extensions*) — high-wins (cli replaces repo replaces user)
//
// Source tagging:
//   loadLayeredOpcConfig returns { ...merged, _source: { key: "user"|"repo"|"cli"|"layered" } }
//   _source is per-top-level-key only (keeping it terse — deep source tracking is
//   not worth the complexity for v0.5). "layered" is emitted for extensions /
//   disabledExtensions when ≥2 layers contributed a non-empty list.
//
// Reserved / filtered top-level keys:
//   • `_`-prefixed keys in user/repo/cli config are dropped during merge
//     (reserved for OPC provenance output: `_source`, `_paths`, future `_*`).
//   • `__proto__`, `constructor`, `prototype` are dropped at every merge level
//     to prevent prototype-chain pollution of the returned merged object.
//
// Input validation:
//   • Non-object JSON (array, string, number, null) at any layer is rejected
//     with a one-line stderr warning; layer is treated as absent.
//   • Malformed JSON is reported to stderr once per load, then treated as absent.

import { existsSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import os from "os";

const USER_CONFIG_PATH = () => join(os.homedir(), ".opc", "config.json");

// Keys that must never flow into the merged output — either reserved for OPC
// provenance (`_*`) or dangerous to the prototype chain.
const DANGEROUS_PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function isReservedKey(k) {
  return typeof k !== "string" || k.startsWith("_") || DANGEROUS_PROTO_KEYS.has(k);
}

/** Assign a value to an object without invoking the `__proto__` / accessor setter. */
function safeAssign(target, key, value) {
  Object.defineProperty(target, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

/**
 * Walk up from `start` to find the nearest ancestor dir containing `.opc/config.json`.
 * Stops when the candidate path would equal the user-layer config path (home dir
 * collision) — that collapse would double-count the user's global config as a
 * repo-layer override and corrupt provenance.
 */
export function findRepoConfigPath(start) {
  let dir = resolve(start);
  const root = resolve("/");
  const userPath = USER_CONFIG_PATH();
  while (true) {
    const candidate = join(dir, ".opc", "config.json");
    // Skip home-dir collision: do not return user-layer path as the repo layer.
    if (candidate !== userPath && existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function safeReadJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(parsed)) {
      console.error(`opc: warning: ${path} is not a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed}), ignoring`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.error(`opc: warning: ${path} is not valid JSON (${err.message}), ignoring`);
    return null;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Deep-merge two plain objects. high wins on scalar conflict. Arrays replaced unless key is handled upstream. */
function deepMerge(low, high) {
  const out = {};
  // Copy low's safe keys (drop dangerous proto keys; allow _*-prefix at nested
  // levels since only top-level _source/_paths are reserved for OPC output).
  for (const k of Object.keys(low || {})) {
    if (DANGEROUS_PROTO_KEYS.has(k)) continue;
    safeAssign(out, k, low[k]);
  }
  for (const k of Object.keys(high || {})) {
    if (DANGEROUS_PROTO_KEYS.has(k)) continue;
    const hv = high[k];
    const lv = out[k];
    if (isPlainObject(hv) && isPlainObject(lv)) safeAssign(out, k, deepMerge(lv, hv));
    else safeAssign(out, k, hv);
  }
  return out;
}

function unionList(...lists) {
  const seen = new Set();
  const out = [];
  for (const l of lists) {
    if (!Array.isArray(l)) continue;
    for (const item of l) {
      if (typeof item !== "string") continue;
      if (!seen.has(item)) { seen.add(item); out.push(item); }
    }
  }
  return out;
}

/**
 * Merge layered configs with OPC-specific semantics.
 * Returns { merged, source } where source is { topLevelKey: "user"|"repo"|"cli" }.
 */
function mergeLayers(layers) {
  // layers = [{name, config}, ...] low-to-high priority
  const source = {};
  let merged = {};

  // Pass 1: deep-merge everything, recording last writer per top-level key
  for (const { name, config } of layers) {
    if (!isPlainObject(config)) continue; // reject non-object configs (array/string/number/null)
    for (const k of Object.keys(config)) {
      // Skip extensions* for this pass — handled specially below
      if (k === "extensions" || k === "disabledExtensions") continue;
      // Skip reserved/dangerous top-level keys (`_*`, __proto__, constructor, prototype)
      if (isReservedKey(k)) continue;
      const existing = merged[k];
      const incoming = config[k];
      if (isPlainObject(existing) && isPlainObject(incoming)) {
        safeAssign(merged, k, deepMerge(existing, incoming));
      } else {
        safeAssign(merged, k, incoming);
      }
      source[k] = name;
    }
  }

  // Pass 2: extensions — union across all layers, preserving first-seen order
  const extLayers = layers.map(l => (l.config && Array.isArray(l.config.extensions)) ? l.config.extensions : []);
  const union = unionList(...extLayers);
  if (union.length > 0) {
    merged.extensions = union;
    // _source for extensions: "layered" if more than one layer contributed, else that layer
    const contributors = layers.filter(l => Array.isArray(l.config?.extensions) && l.config.extensions.length > 0).map(l => l.name);
    source.extensions = contributors.length > 1 ? "layered" : (contributors[0] || "default");
  }

  // Pass 3: disabledExtensions — union (disabled wins over any enable elsewhere)
  const disabledUnion = unionList(
    ...layers.map(l => (l.config && Array.isArray(l.config.disabledExtensions)) ? l.config.disabledExtensions : [])
  );
  if (disabledUnion.length > 0) {
    merged.disabledExtensions = disabledUnion;
    const contributors = layers.filter(l => Array.isArray(l.config?.disabledExtensions) && l.config.disabledExtensions.length > 0).map(l => l.name);
    source.disabledExtensions = contributors.length > 1 ? "layered" : (contributors[0] || "default");
  }

  // Pass 4: apply disabled to extensions (final enabled list = extensions \ disabled)
  if (Array.isArray(merged.extensions) && Array.isArray(merged.disabledExtensions)) {
    const disabledSet = new Set(merged.disabledExtensions);
    merged.extensions = merged.extensions.filter(n => !disabledSet.has(n));
  }

  return { merged, source };
}

/**
 * Load and merge layered OPC config for a given harness dir.
 * @param {string} [harnessDir=process.cwd()] — directory to anchor repo-config lookup.
 * @param {object} [cliOverrides={}] — values from CLI flags (highest precedence).
 * @returns {object} merged config + `_source` map for provenance.
 */
export function loadLayeredOpcConfig(harnessDir = process.cwd(), cliOverrides = {}) {
  const userPath = USER_CONFIG_PATH();
  const repoPath = findRepoConfigPath(harnessDir);

  const layers = [
    { name: "user",  config: safeReadJson(userPath) || {} },
    { name: "repo",  config: safeReadJson(repoPath) || {} },
    { name: "cli",   config: cliOverrides || {} },
  ];

  const { merged, source } = mergeLayers(layers);
  safeAssign(merged, "_source", source);
  safeAssign(merged, "_paths", {
    user: existsSync(userPath) ? userPath : null,
    repo: repoPath,
  });
  return merged;
}

/**
 * Strip OPC-internal provenance metadata (`_source`, `_paths`, and any other
 * `_`-prefixed keys) from a merged config object. Returns a shallow copy safe to
 * hand to downstream consumers (e.g. `loadExtensions`) that iterate Object.keys.
 */
export function stripProvenance(cfg) {
  if (!isPlainObject(cfg)) return cfg;
  const out = {};
  for (const k of Object.keys(cfg)) {
    if (typeof k === "string" && k.startsWith("_")) continue;
    safeAssign(out, k, cfg[k]);
  }
  return out;
}

// ─── CLI: opc-harness config resolve [--dir <p>] ────────────────────

export async function cmdConfigResolve(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.error("Usage: opc-harness config resolve [--dir <harness-dir>]");
    console.error("Prints merged OPC config as JSON, including _source map per top-level key.");
    return;
  }

  // Subcommand dispatch: we only support `resolve` for now
  const sub = args[0];
  if (sub !== "resolve") {
    console.error(`Unknown config subcommand: ${sub || "(none)"}. Expected: resolve`);
    process.exit(1);
  }

  const rest = args.slice(1);
  const dirIdx = rest.indexOf("--dir");
  let dir = process.cwd();
  if (dirIdx !== -1) {
    const val = rest[dirIdx + 1];
    if (!val || val.startsWith("--")) {
      console.error("Error: --dir requires a directory path");
      process.exit(1);
    }
    dir = val;
  }

  const merged = loadLayeredOpcConfig(dir, {});
  console.log(JSON.stringify(merged, null, 2));
}
