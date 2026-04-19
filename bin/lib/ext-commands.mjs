// ext-commands.mjs — CLI commands for extension system
// prompt-context, extension-test, and extension-verdict commands

import { readFileSync, writeFileSync, existsSync, readdirSync, cpSync, mkdtempSync, rmSync, lstatSync, statSync, realpathSync, mkdirSync, copyFileSync } from "fs";
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
    console.error("Usage: opc-harness extension-test --ext <path> [--hook <hookname>] [--context <json>] [--all-hooks] [--fixture-dir <path>] [--lint] [--lint-strict]");
    console.error("  --fixture-dir <path>  Copy fixture dir to a fresh tmpdir and set ctx.flowDir/ctx.runDir to it.");
    console.error("                        Symlinks are dereferenced to prevent sandbox escape. The tmpdir is");
    console.error("                        cleaned up on every exit path (success, error, lint-only).");
    console.error("                        Overrides any flowDir/runDir passed via --context.");
    console.error("  --lint                Lint authoring metadata (capability shape + hook/provides mismatch).");
    console.error("                        Emits [lint] WARN lines to stderr; exits 0 even on lint issues.");
    console.error("                        When combined with --hook or --all-hooks, --lint wins (hooks skipped).");
    console.error("  --lint-strict         Like --lint, but exits 1 if any [lint] line was emitted. Use in CI.");
    return;
  }

  // U5.6r fix-pair: typo guard. Any flag starting with `--` that we don't
  // recognize is almost certainly a typo (e.g. `--fixturedir` instead of
  // `--fixture-dir`). Previously getFlag silently ignored these, causing
  // fixture-dir typos to write into the user's repo. Fail loudly instead.
  const KNOWN_FLAGS = new Set([
    "--ext", "--hook", "--context", "--all-hooks", "--fixture-dir",
    "--lint", "--lint-strict", "--help",
  ]);
  for (const a of args) {
    if (!a.startsWith("--")) continue;
    // Strip =VALUE form before checking
    const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (!KNOWN_FLAGS.has(flag)) {
      console.error(`Unknown flag: ${flag}. Known flags: ${[...KNOWN_FLAGS].sort().join(", ")}`);
      process.exit(1);
    }
  }

  const extPath = getFlag(args, "ext");
  const hookName = getFlag(args, "hook");
  const contextJson = getFlag(args, "context", "{}");
  const allHooks = args.includes("--all-hooks");
  const fixtureDir = getFlag(args, "fixture-dir");
  const lintOnly = args.includes("--lint") || args.includes("--lint-strict");
  const lintStrict = args.includes("--lint-strict");

  if (!extPath) {
    console.error("Usage: opc-harness extension-test --ext <path> [--hook <hookname>] [--context <json>] [--all-hooks] [--fixture-dir <path>] [--lint|--lint-strict]");
    process.exit(1);
  }

  // U5.6r fix-pair: capture lint WARNs to count them for --lint-strict. We
  // tap console.error with a passthrough filter so stderr output is unchanged.
  let lintWarnCount = 0;
  const origStderr = console.error;
  console.error = (...a) => {
    const msg = a.map(String).join(" ");
    if (msg.startsWith("[lint]")) lintWarnCount++;
    origStderr(...a);
  };

  // U5.6r fix-pair: single try/finally covers every exit path. All the
  // previous inline `if (fixtureTmpDir) rmSync(...)` calls are replaced by
  // one cleanup block so a future contributor can't accidentally leak.
  let fixtureTmpDir = null;
  let exitCode = 0;
  try {
    let context = {};
    try { context = JSON.parse(contextJson); } catch (err) {
      console.error(`Invalid --context JSON: ${err.message}`);
      exitCode = 1;
      return;
    }

    // F3: --fixture-dir copies the given dir into a fresh mkdtemp() dir and
    // rewrites ctx.flowDir + ctx.runDir. Override precedence: fixture-dir
    // wins over any flowDir/runDir in --context — fixture-dir is strictly
    // more specific. Symlinks in the source are dereferenced to prevent a
    // symlink-pointing-at-/etc sandbox-escape (U5.6r 🟡 reviewer A).
    if (fixtureDir) {
      const srcAbs = resolve(fixtureDir);
      if (!existsSync(srcAbs)) {
        console.error(`--fixture-dir not found: ${srcAbs}`);
        exitCode = 1;
        return;
      }
      try {
        fixtureTmpDir = mkdtempSync(join(tmpdir(), "opc-fixture-"));
        // Manual dereferencing walker — Node's cpSync({dereference:true})
        // still produces symlinks in the output on some platforms (Node 25).
        // Writing our own walker guarantees every entry in the sandbox is a
        // plain file or dir, so a malicious fixture with a symlink to
        // /etc/passwd cannot escape the tmp sandbox.
        const copyDeref = (s, d) => {
          const st = lstatSync(s);
          if (st.isSymbolicLink()) {
            const target = realpathSync(s);
            const tst = statSync(target);
            if (tst.isDirectory()) {
              mkdirSync(d, { recursive: true });
              for (const e of readdirSync(target)) copyDeref(join(target, e), join(d, e));
            } else {
              copyFileSync(target, d);
            }
          } else if (st.isDirectory()) {
            mkdirSync(d, { recursive: true });
            for (const e of readdirSync(s)) copyDeref(join(s, e), join(d, e));
          } else {
            copyFileSync(s, d);
          }
        };
        copyDeref(srcAbs, fixtureTmpDir);
      } catch (err) {
        console.error(`Failed to materialize --fixture-dir: ${err.message}`);
        exitCode = 1;
        return;
      }
      context.flowDir = fixtureTmpDir;
      context.runDir = fixtureTmpDir;
    }

    const hookPath = join(resolve(extPath), "hook.mjs");
    if (!existsSync(hookPath)) {
      console.error(`hook.mjs not found at: ${hookPath}`);
      exitCode = 1;
      return;
    }

    let mod;
    try {
      mod = await import(hookPath);
    } catch (err) {
      console.error(`Failed to load ${hookPath}: ${err.message}`);
      exitCode = 1;
      return;
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
    // (intentional versioning) — we only flag the hard shapes. `startup.check`
    // alone with empty provides is legit (pure preflight ext) → NOT flagged;
    // we only check the four firing hooks.
    const hookNames = Object.keys(hooks);
    const provides = Array.isArray(meta.provides) ? meta.provides : [];
    const firingHookPresent = hookNames.some(h => h === "prompt.append" || h === "verdict.append" || h === "execute.run" || h === "artifact.emit");
    if (provides.length > 0 && hookNames.length === 0) {
      console.error(
        `[lint] ⚠️  hook mismatch: meta.provides declares [${provides.join(", ")}] ` +
        `but no hooks are implemented — this extension will load but never fire.`
      );
    }
    if (provides.length === 0 && firingHookPresent) {
      console.error(
        `[lint] ⚠️  hook mismatch: hooks [${hookNames.join(", ")}] are implemented ` +
        `but meta.provides is empty — extensionMatches() will skip this extension on every node.`
      );
    }

    // --lint / --lint-strict: run all lint checks above and return without
    // invoking hooks. Exit 0 per OUT-1 contract, unless --lint-strict and any
    // [lint] WARN was emitted (captured via the console.error tap above).
    if (lintOnly) {
      exitCode = (lintStrict && lintWarnCount > 0) ? 1 : 0;
      return;
    }

    const hooksToRun = allHooks
      ? ["startup.check", "prompt.append", "verdict.append"]
      : [hookName].filter(Boolean);

    if (hooksToRun.length === 0) {
      // Restore pre-U5.5 stderr text verbatim so scripts grepping for this
      // message are unaffected (U5.6r DX 🟡).
      console.error("Specify --hook <name> or --all-hooks");
      exitCode = 1;
      return;
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
    // fail. Non-zero exit is reserved for load-time errors.
    void hadError;
    exitCode = 0;
  } finally {
    // Single cleanup site for the fixture tmp dir — covers all return paths.
    if (fixtureTmpDir) { try { rmSync(fixtureTmpDir, { recursive: true, force: true }); } catch {} }
    // Restore the unpatched console.error for downstream callers in-process.
    console.error = origStderr;
    process.exit(exitCode);
  }
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
