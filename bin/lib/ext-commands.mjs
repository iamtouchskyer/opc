// ext-commands.mjs — CLI commands for extension system
// prompt-context, extension-test, and extension-verdict commands

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";
import os from "os";
import { loadExtensions, firePromptAppend, fireVerdictAppend, saveRegistryCache } from "./extensions.mjs";
import { getFlag } from "./util.mjs";

// ─── prompt-context ──────────────────────────────────────────────

export async function cmdPromptContext(args) {
  if (args.includes("--help")) {
    console.error("Usage: opc-harness prompt-context --node <id> --role <role> --dir <harness-dir>");
    console.error("Output: JSON { append: string, applied: string[] }");
    return;
  }

  const node = getFlag(args, "node");
  const role = getFlag(args, "role");
  const dir = getFlag(args, "dir", ".harness");

  if (!node || !role) {
    console.error("Usage: opc-harness prompt-context --node <id> --role <role> --dir <harness-dir>");
    process.exit(1);
  }

  // Load config from ~/.opc/config.json
  let config = {};
  const configPath = join(os.homedir(), ".opc", "config.json");
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, "utf8")); } catch { /* best effort */ }
  }

  // Read task from acceptance-criteria.md first line
  let task = "";
  const acPath = resolve(dir, "acceptance-criteria.md");
  if (existsSync(acPath)) {
    try {
      const firstLine = readFileSync(acPath, "utf8").split("\n")[0];
      task = firstLine.replace(/^#+\s*/, "").trim();
    } catch { /* best effort */ }
  }

  let registry;
  try {
    registry = await loadExtensions(config);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const devServerUrl = getFlag(args, "dev-server") || process.env.DEV_SERVER_URL || config.devServerUrl || "";

  const context = {
    node,
    role,
    task,
    flowDir: resolve(dir),
    runDir: resolve(dir),
    devServerUrl,
  };

  const append = await firePromptAppend(registry, context);

  // Stamp extensionsApplied into this node's latest run handshake (if run dir exists)
  const nodeDir = resolve(dir, "nodes", node);
  if (existsSync(nodeDir)) {
    try {
      const entries = readdirSync(nodeDir, { withFileTypes: true });
      const runDirs = entries
        .filter(e => e.isDirectory() && /^run_\d+$/.test(e.name))
        .map(e => e.name)
        .sort((a, b) => parseInt(b.replace("run_", ""), 10) - parseInt(a.replace("run_", ""), 10));
      if (runDirs.length > 0) {
        const latestRunDir = join(nodeDir, runDirs[0]);
        const handshakePath = join(latestRunDir, 'handshake.json');
        let handshake = {};
        try { handshake = JSON.parse(readFileSync(handshakePath, 'utf8')); } catch { /* no handshake yet */ }
        handshake.extensionsApplied = registry.applied;
        writeFileSync(handshakePath, JSON.stringify(handshake, null, 2));
      }
    } catch { /* best effort */ }
  }

  // Persist registry cache so validate-chain and debug can read applied extensions
  saveRegistryCache(resolve(dir), registry);

  console.log(JSON.stringify({ append, applied: registry.applied }));
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

  // Normalize hook interface — support old-style named exports and new-style hooks object
  const raw = mod.default || mod;
  let hook;
  if (raw && raw.hooks && typeof raw.hooks === "object") {
    hook = raw;
  } else {
    const src = mod;
    const normalizedHooks = {};
    if (typeof src.promptAppend === "function")   normalizedHooks["prompt.append"]   = src.promptAppend;
    if (typeof src.verdictAppend === "function")  normalizedHooks["verdict.append"]  = src.verdictAppend;
    if (typeof src.startupCheck === "function")   normalizedHooks["startup.check"]   = src.startupCheck;
    hook = { hooks: normalizedHooks };
  }
  const hooks = hook.hooks || {};

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

  // Load config from ~/.opc/config.json
  let config = {};
  const configPath = join(os.homedir(), ".opc", "config.json");
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, "utf8")); } catch { /* best effort */ }
  }

  // Read task from acceptance-criteria.md
  let task = "";
  const acPath = resolve(dir, "acceptance-criteria.md");
  if (existsSync(acPath)) {
    try {
      const firstLine = readFileSync(acPath, "utf8").split("\n")[0];
      task = firstLine.replace(/^#+\s*/, "").trim();
    } catch { /* best effort */ }
  }

  let registry;
  try {
    registry = await loadExtensions(config);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // Find the latest run dir for this node
  const nodeDir = resolve(dir, "nodes", node);
  let runDir = null;
  if (existsSync(nodeDir)) {
    try {
      const entries = readdirSync(nodeDir, { withFileTypes: true });
      const runDirs = entries
        .filter(e => e.isDirectory() && /^run_\d+$/.test(e.name))
        .map(e => e.name)
        .sort((a, b) => {
          const na = parseInt(a.replace("run_", ""), 10);
          const nb = parseInt(b.replace("run_", ""), 10);
          return nb - na; // descending — latest first
        });
      if (runDirs.length > 0) {
        runDir = join(nodeDir, runDirs[0]);
      }
    } catch { /* best effort */ }
  }

  if (!runDir) {
    console.error(`No run directories found for node '${node}' in ${nodeDir}`);
    process.exit(1);
  }

  const devServerUrl = getFlag(args, "dev-server") || process.env.DEV_SERVER_URL || config.devServerUrl || "";

  const context = {
    node,
    role: "evaluator",
    task,
    flowDir: resolve(dir),
    runDir,
    devServerUrl,
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

  console.log(JSON.stringify({ ok: true, node, runDir, extensionsApplied: registry.applied }));
}
