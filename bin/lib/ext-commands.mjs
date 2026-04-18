// ext-commands.mjs — CLI commands for extension system
// prompt-context, extension-test, and extension-verdict commands

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { loadExtensions, firePromptAppend, fireVerdictAppend, fireExecuteRun, fireArtifactEmit, writeFailureReport, saveRegistryCache, normalizeHook, lintCapability } from "./extensions.mjs";
import { getFlag } from "./util.mjs";
import { resolveFlowTemplate } from "./flow-templates.mjs";
import { parseBypassArgs } from "./bypass-args.mjs";
import { loadLayeredOpcConfig, stripProvenance } from "./config-layering.mjs";

// ─── Shared helpers ──────────────────────────────────────────────
//
// U1.4: loadOpcConfig is a thin wrapper around loadLayeredOpcConfig. It strips
// `_source`/`_paths` provenance metadata via stripProvenance before handing the
// object downstream so extension code iterating Object.keys does not see OPC
// internals as if they were user config.

function loadOpcConfig(harnessDir) {
  return stripProvenance(loadLayeredOpcConfig(harnessDir || process.cwd(), {}));
}

function readTaskFromAC(dir) {
  const acPath = resolve(dir, "acceptance-criteria.md");
  if (!existsSync(acPath)) return "";
  try {
    const firstLine = readFileSync(acPath, "utf8").split("\n")[0];
    return firstLine.replace(/^#+\s*/, "").trim();
  } catch { return ""; }
}

function findLatestRunDir(nodeDir) {
  if (!existsSync(nodeDir)) return null;
  try {
    const entries = readdirSync(nodeDir, { withFileTypes: true });
    const runDirs = entries
      .filter(e => e.isDirectory() && /^run_\d+$/.test(e.name))
      .map(e => e.name)
      .sort((a, b) => parseInt(b.replace("run_", ""), 10) - parseInt(a.replace("run_", ""), 10));
    return runDirs.length > 0 ? join(nodeDir, runDirs[0]) : null;
  } catch { return null; }
}

/**
 * Read flow-state.json + resolved flow template, return the current node's
 * required capabilities. Missing state or missing nodeCapabilities → [].
 */
function readNodeCapabilities(dir, node, args) {
  try {
    const statePath = resolve(dir, "flow-state.json");
    let state = null;
    if (existsSync(statePath)) {
      try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* state corrupt — treat as absent */ }
    }
    const { template } = resolveFlowTemplate(args, state);
    if (!template || !template.nodeCapabilities) return [];
    const caps = template.nodeCapabilities[node];
    return Array.isArray(caps) ? caps : [];
  } catch {
    return [];
  }
}

// ─── prompt-context ──────────────────────────────────────────────

export async function cmdPromptContext(args) {
  if (args.includes("--help")) {
    console.error("Usage: opc-harness prompt-context --node <id> --role <role> --dir <harness-dir>");
    console.error("Output: JSON { append: string, applied: string[], nodeCapabilities: string[] }");
    return;
  }

  const node = getFlag(args, "node");
  const role = getFlag(args, "role");
  const dir = getFlag(args, "dir", ".harness");

  if (!node || !role) {
    console.error("Usage: opc-harness prompt-context --node <id> --role <role> --dir <harness-dir>");
    process.exit(1);
  }

  const config = loadOpcConfig(dir);
  Object.assign(config, parseBypassArgs(args));
  const task = readTaskFromAC(dir);

  let registry;
  try {
    registry = await loadExtensions(config);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const devServerUrl = getFlag(args, "dev-server") || process.env.DEV_SERVER_URL || config.devServerUrl || "";
  const nodeCapabilities = readNodeCapabilities(dir, node, args);

  const context = {
    node,
    role,
    task,
    flowDir: resolve(dir),
    runDir: resolve(dir),
    devServerUrl,
    nodeCapabilities,
  };

  const append = await firePromptAppend(registry, context);

  // Stamp extensionsApplied into this node's latest run handshake (if run dir exists)
  const nodeDir = resolve(dir, "nodes", node);
  const latestRunDir = findLatestRunDir(nodeDir);
  if (latestRunDir) {
    try {
      const handshakePath = join(latestRunDir, 'handshake.json');
      let handshake = {};
      try { handshake = JSON.parse(readFileSync(handshakePath, 'utf8')); } catch { /* no handshake yet */ }
      handshake.extensionsApplied = registry.applied;
      writeFileSync(handshakePath, JSON.stringify(handshake, null, 2));
    } catch { /* best effort */ }
  }

  saveRegistryCache(resolve(dir), registry);

  console.log(JSON.stringify({ append, applied: registry.applied, nodeCapabilities }));
}

// ─── extension-test ──────────────────────────────────────────────

export async function cmdExtensionTest(args) {
  if (args.includes("--help")) {
    console.error("Usage: opc-harness extension-test --ext <path> [--hook <hookname>] [--context <json>] [--all-hooks]");
    return;
  }

  const extPath = getFlag(args, "ext");
  const hookName = getFlag(args, "hook");
  const contextJson = getFlag(args, "context", "{}");
  const allHooks = args.includes("--all-hooks");

  if (!extPath) {
    console.error("Usage: opc-harness extension-test --ext <path> [--hook <hookname>] [--context <json>] [--all-hooks]");
    process.exit(1);
  }

  let context = {};
  try { context = JSON.parse(contextJson); } catch (err) {
    console.error(`Invalid --context JSON: ${err.message}`);
    process.exit(1);
  }

  const hookPath = join(resolve(extPath), "hook.mjs");
  if (!existsSync(hookPath)) {
    console.error(`hook.mjs not found at: ${hookPath}`);
    process.exit(1);
  }

  let mod;
  try {
    mod = await import(hookPath);
  } catch (err) {
    console.error(`Failed to load ${hookPath}: ${err.message}`);
    process.exit(1);
  }

  // Use the canonical normalizer from extensions.mjs
  const raw = mod.default || mod;
  const hook = normalizeHook(raw, mod);
  const hooks = hook.hooks || {};

  // U1.5: Lint meta.provides and meta.compatibleCapabilities. Warn (not fail)
  // on entries that don't match the capability shape `/^[a-z][a-z0-9-]*@[1-9]\d*$/`.
  // Bare tokens (`foo` without `@N`) pass lint but trigger auto-upgrade WARN
  // at load time; only malformed / wrong-type / empty values are reported here.
  // Routed through console.error so it shares stderr with the bare-token
  // auto-upgrade WARN emitted by normalizeCapability — one grep catches both.
  const meta = (raw && typeof raw === "object" && raw.meta) || {};
  function lintList(listName, list) {
    if (list == null) return;
    if (!Array.isArray(list)) {
      console.error(`[lint] ⚠️  meta.${listName} is not an array (got ${typeof list})`);
      return;
    }
    for (const cap of list) {
      const res = lintCapability(cap);
      if (!res.ok) {
        const shown = typeof cap === "string" ? JSON.stringify(cap) : String(cap);
        console.error(`[lint] ⚠️  meta.${listName} entry ${shown} failed capability-shape check: ${res.reason}`);
      }
    }
  }
  lintList("provides", meta.provides);
  lintList("compatibleCapabilities", meta.compatibleCapabilities);

  const hooksToRun = allHooks
    ? ["startup.check", "prompt.append", "verdict.append"]
    : [hookName].filter(Boolean);

  if (hooksToRun.length === 0) {
    console.error("Specify --hook <name> or --all-hooks");
    process.exit(1);
  }

  let hadError = false;
  for (const hName of hooksToRun) {
    const fn = hooks[hName];
    if (typeof fn !== "function") {
      console.log(`[${hName}] ⚠️  not implemented`);
      continue;
    }
    const t0 = Date.now();
    try {
      const result = await fn(context);
      const elapsed = Date.now() - t0;
      if (hName === "startup.check") {
        console.log(`[${hName}] ✅ passed (${elapsed}ms)`);
      } else if (hName === "prompt.append") {
        const str = typeof result === "string" ? result : "";
        console.log(`[${hName}] ✅ returned ${str.length} chars (${elapsed}ms)`);
        if (str.length > 0) {
          const preview = str.slice(0, 200);
          console.log(`  --- output preview ---`);
          console.log(`  ${preview.replace(/\n/g, "\n  ")}`);
          console.log(`  ---------------------`);
        }
      } else if (hName === "verdict.append") {
        const findings = Array.isArray(result) ? result : [];
        console.log(`[${hName}] ✅ returned ${findings.length} findings (${elapsed}ms)`);
        for (const f of findings) {
          console.log(`  ${f.severity} [${f.category}] ${f.message}`);
        }
      } else {
        console.log(`[${hName}] ✅ result: ${JSON.stringify(result)}`);
      }
    } catch (err) {
      console.log(`[${hName}] ❌ error: ${err.message}`);
      hadError = true;
    }
  }

  process.exit(hadError ? 1 : 0);
}

// ─── extension-verdict ───────────────────────────────────────────

export async function cmdExtensionVerdict(args) {
  if (args.includes("--help")) {
    console.error("Usage: opc-harness extension-verdict --node <id> --dir <harness-dir>");
    console.error("Loads extensions, fires verdict.append, writes eval-extensions.md to latest run dir.");
    return;
  }

  const node = getFlag(args, "node");
  const dir = getFlag(args, "dir", ".harness");

  if (!node) {
    console.error("Usage: opc-harness extension-verdict --node <id> --dir <harness-dir>");
    process.exit(1);
  }

  const config = loadOpcConfig(dir);
  Object.assign(config, parseBypassArgs(args));
  const task = readTaskFromAC(dir);

  let registry;
  try {
    registry = await loadExtensions(config);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const runDir = findLatestRunDir(resolve(dir, "nodes", node));
  if (!runDir) {
    console.error(`No run directories found for node '${node}' in ${resolve(dir, "nodes", node)}`);
    process.exit(1);
  }

  const devServerUrl = getFlag(args, "dev-server") || process.env.DEV_SERVER_URL || config.devServerUrl || "";
  const nodeCapabilities = readNodeCapabilities(dir, node, args);

  const context = {
    node,
    role: "evaluator",
    task,
    flowDir: resolve(dir),
    runDir,
    devServerUrl,
    nodeCapabilities,
  };

  await fireVerdictAppend(registry, context);

  // Stamp extensionsApplied into the run dir's handshake.json
  const handshakePath = join(runDir, 'handshake.json');
  let handshake = {};
  try {
    handshake = JSON.parse(await readFile(handshakePath, 'utf8'));
  } catch { /* no handshake yet, start fresh */ }
  handshake.extensionsApplied = registry.applied;
  await writeFile(handshakePath, JSON.stringify(handshake, null, 2));

  console.log(JSON.stringify({ ok: true, node, runDir, extensionsApplied: registry.applied, nodeCapabilities }));
}

// ─── extension-artifact ──────────────────────────────────────────
//
// U1.6: Fires `execute.run` and `artifact.emit` hooks for executor nodes.
// - execute.run: side-effectful verification (ignored return value)
// - artifact.emit: returns files written to <runDir>/ext-<name>/<basename> and
//   appended to handshake.artifacts[] as `{ type: "ext-artifact", ext, path }`
// Also calls writeFailureReport so failures from these hooks surface in the
// same `extension-failures.md` as prompt/verdict failures — single file, one
// grep for any hook crash.

export async function cmdExtensionArtifact(args) {
  if (args.includes("--help")) {
    console.error("Usage: opc-harness extension-artifact --node <id> --dir <harness-dir>");
    console.error("Fires execute.run + artifact.emit hooks. Emitted files go to <runDir>/ext-<name>/, paths merged into handshake.artifacts[].");
    return;
  }

  const node = getFlag(args, "node");
  const dir = getFlag(args, "dir", ".harness");

  if (!node) {
    console.error("Usage: opc-harness extension-artifact --node <id> --dir <harness-dir>");
    process.exit(1);
  }

  const config = loadOpcConfig(dir);
  Object.assign(config, parseBypassArgs(args));
  const task = readTaskFromAC(dir);

  let registry;
  try {
    registry = await loadExtensions(config);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const runDir = findLatestRunDir(resolve(dir, "nodes", node));
  if (!runDir) {
    console.error(`No run directories found for node '${node}' in ${resolve(dir, "nodes", node)}`);
    process.exit(1);
  }

  const devServerUrl = getFlag(args, "dev-server") || process.env.DEV_SERVER_URL || config.devServerUrl || "";
  const nodeCapabilities = readNodeCapabilities(dir, node, args);

  const context = {
    node,
    role: "executor",
    task,
    flowDir: resolve(dir),
    runDir,
    devServerUrl,
    nodeCapabilities,
  };

  const executeResults = await fireExecuteRun(registry, context);
  const emitted = await fireArtifactEmit(registry, context);

  // Always write failure report — U1.6 wires this into the orchestrator hook
  // path so that execute/artifact-hook crashes are observable even without a
  // subsequent verdict phase.
  writeFailureReport(registry, runDir);

  // Merge ext-artifact entries into handshake.artifacts[] (dedup by path)
  const handshakePath = join(runDir, 'handshake.json');
  let handshake = {};
  try {
    handshake = JSON.parse(await readFile(handshakePath, 'utf8'));
  } catch { /* no handshake yet */ }
  if (!Array.isArray(handshake.artifacts)) handshake.artifacts = [];
  const seen = new Set(handshake.artifacts.map(a => (a && a.path) || null).filter(Boolean));
  for (const a of emitted) {
    if (!seen.has(a.path)) { handshake.artifacts.push(a); seen.add(a.path); }
  }
  handshake.extensionsApplied = registry.applied;
  await writeFile(handshakePath, JSON.stringify(handshake, null, 2));

  console.log(JSON.stringify({
    ok: true,
    node,
    runDir,
    extensionsApplied: registry.applied,
    executeRunCount: executeResults.length,
    emitted,
  }));
}
