// ext-commands.mjs — CLI commands for extension system
// prompt-context, extension-test, and extension-verdict commands

import { readFileSync, writeFileSync, existsSync, readdirSync, cpSync, mkdtempSync, rmSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { loadExtensions, firePromptAppend, fireVerdictAppend, fireExecuteRun, fireArtifactEmit, writeFailureReport, saveRegistryCache, normalizeHook, lintCapability, enforceStrictMode, survivingExtensions } from "./extensions.mjs";
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
      handshake.extensionsApplied = survivingExtensions(registry);
      writeFileSync(handshakePath, JSON.stringify(handshake, null, 2));
    } catch { /* best effort */ }

    // G2 fix: persist prompt-phase failures (e.g. slow-ext timeout) so
    // operators see them in extension-failures.md instead of just stderr.
    // writeFailureReport now read-merges, so this won't clobber prior phases.
    writeFailureReport(registry, latestRunDir);
  }

  saveRegistryCache(resolve(dir), registry);

  console.log(JSON.stringify({ append, applied: registry.applied, nodeCapabilities }));

  // Strict mode: after isolation work is done, exit non-zero if any failures.
  enforceStrictMode(registry);
}

// ─── extension-test ──────────────────────────────────────────────

export async function cmdExtensionTest(args) {
  if (args.includes("--help")) {
    console.error("Usage: opc-harness extension-test --ext <path> [--hook <hookname>] [--context <json>] [--all-hooks] [--fixture-dir <path>] [--lint]");
    console.error("  --fixture-dir <path>  Copy fixture dir to a fresh tmpdir and set ctx.flowDir/ctx.runDir to it.");
    console.error("                        The tmpdir is cleaned up on exit (success or failure).");
    console.error("  --lint                Lint authoring metadata (capability shape + hook/provides mismatch).");
    console.error("                        Emits [lint] WARN lines to stderr; exits 0 even on lint issues.");
    return;
  }

  const extPath = getFlag(args, "ext");
  const hookName = getFlag(args, "hook");
  const contextJson = getFlag(args, "context", "{}");
  const allHooks = args.includes("--all-hooks");
  const fixtureDir = getFlag(args, "fixture-dir");
  const lintOnly = args.includes("--lint");

  if (!extPath) {
    console.error("Usage: opc-harness extension-test --ext <path> [--hook <hookname>] [--context <json>] [--all-hooks] [--fixture-dir <path>] [--lint]");
    process.exit(1);
  }

  let context = {};
  try { context = JSON.parse(contextJson); } catch (err) {
    console.error(`Invalid --context JSON: ${err.message}`);
    process.exit(1);
  }

  // F3: --fixture-dir copies the given dir into a fresh tmpdir and rewrites
  // ctx.flowDir + ctx.runDir. The tmp dir is torn down in a finally at the
  // end of the function so extension code can't leak state or files across
  // runs. If the user passed flowDir/runDir in --context, we override —
  // fixture-dir is strictly more specific.
  let fixtureTmpDir = null;
  if (fixtureDir) {
    const srcAbs = resolve(fixtureDir);
    if (!existsSync(srcAbs)) {
      console.error(`--fixture-dir not found: ${srcAbs}`);
      process.exit(1);
    }
    try {
      fixtureTmpDir = mkdtempSync(join(tmpdir(), "opc-fixture-"));
      cpSync(srcAbs, fixtureTmpDir, { recursive: true });
    } catch (err) {
      console.error(`Failed to materialize --fixture-dir: ${err.message}`);
      if (fixtureTmpDir) { try { rmSync(fixtureTmpDir, { recursive: true, force: true }); } catch {} }
      process.exit(1);
    }
    context.flowDir = fixtureTmpDir;
    context.runDir = fixtureTmpDir;
  }

  const hookPath = join(resolve(extPath), "hook.mjs");
  if (!existsSync(hookPath)) {
    console.error(`hook.mjs not found at: ${hookPath}`);
    if (fixtureTmpDir) { try { rmSync(fixtureTmpDir, { recursive: true, force: true }); } catch {} }
    process.exit(1);
  }

  let mod;
  try {
    mod = await import(hookPath);
  } catch (err) {
    console.error(`Failed to load ${hookPath}: ${err.message}`);
    if (fixtureTmpDir) { try { rmSync(fixtureTmpDir, { recursive: true, force: true }); } catch {} }
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

  // F6: hook/provides mismatch lint. Two mismatch shapes — both are authoring
  // smells the loader won't reject but that mean the extension will never
  // fire. Emit "hook mismatch" on stderr so `2>&1 | grep -q "hook mismatch"`
  // works. Soft overlap between provides and compatibleCapabilities is legal
  // (intentional versioning) — we only flag the hard shapes.
  const hookNames = Object.keys(hooks);
  const provides = Array.isArray(meta.provides) ? meta.provides : [];
  if (provides.length > 0 && hookNames.length === 0) {
    console.error(
      `[lint] ⚠️  hook mismatch: meta.provides declares [${provides.join(", ")}] ` +
      `but no hooks are implemented — this extension will load but never fire.`
    );
  }
  if (provides.length === 0 && hookNames.some(h => h === "prompt.append" || h === "verdict.append" || h === "execute.run" || h === "artifact.emit")) {
    console.error(
      `[lint] ⚠️  hook mismatch: hooks [${hookNames.join(", ")}] are implemented ` +
      `but meta.provides is empty — extensionMatches() will skip this extension on every node.`
    );
  }

  // --lint: run all lint checks above (capability shape + hook mismatch) and
  // return without invoking hooks. Exit 0 per OUT-1 contract.
  if (lintOnly) {
    if (fixtureTmpDir) { try { rmSync(fixtureTmpDir, { recursive: true, force: true }); } catch {} }
    process.exit(0);
  }

  const hooksToRun = allHooks
    ? ["startup.check", "prompt.append", "verdict.append"]
    : [hookName].filter(Boolean);

  if (hooksToRun.length === 0) {
    console.error("Specify --hook <name> or --all-hooks (or --lint for lint-only mode)");
    if (fixtureTmpDir) { try { rmSync(fixtureTmpDir, { recursive: true, force: true }); } catch {} }
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

  // Per Run 2 acceptance criteria OUT-1 and CONTRACTS: extension-test is a
  // LINT command — it runs every requested hook, reports per-hook pass/fail
  // in stdout with ✅/❌ markers, and exits 0 even when individual hooks
  // fail. Non-zero exit is reserved for load-time errors (no --ext, missing
  // hook.mjs, bad --context JSON, or no hooks requested). Callers that need
  // a machine-readable pass/fail should grep stdout for the ❌ marker.
  void hadError;
  // F3: always clean up the fixture tmp dir — success path.
  if (fixtureTmpDir) { try { rmSync(fixtureTmpDir, { recursive: true, force: true }); } catch {} }
  process.exit(0);
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
  handshake.extensionsApplied = survivingExtensions(registry);
  await writeFile(handshakePath, JSON.stringify(handshake, null, 2));

  console.log(JSON.stringify({ ok: true, node, runDir, extensionsApplied: survivingExtensions(registry), nodeCapabilities }));

  // Strict mode: after eval-extensions.md and writeFailureReport have run
  // (inside fireVerdictAppend), exit non-zero if any failures recorded.
  enforceStrictMode(registry);
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
  handshake.extensionsApplied = survivingExtensions(registry);
  await writeFile(handshakePath, JSON.stringify(handshake, null, 2));

  console.log(JSON.stringify({
    ok: true,
    node,
    runDir,
    extensionsApplied: survivingExtensions(registry),
    nodeCapabilities,
    executeRunCount: executeResults.length,
    emitted,
  }));

  // Strict mode: after writeFailureReport + handshake merge, exit non-zero
  // if any failures recorded (preserves isolation, signals to CI).
  enforceStrictMode(registry);
}
