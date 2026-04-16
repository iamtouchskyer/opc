// ext-commands.mjs — CLI commands for extension system
// prompt-context, extension-test, and extension-verdict commands

import { readFileSync, existsSync, readdirSync } from "fs";
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

  const context = {
    node,
    role,
    task,
    flowDir: resolve(dir),
    runDir: resolve(dir),
  };

  const append = await firePromptAppend(registry, context);

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

  const hook = mod.default || mod;
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

  const context = {
    node,
    role: "evaluator",
    task,
    flowDir: resolve(dir),
    runDir,
  };

  await fireVerdictAppend(registry, context);
  console.log(JSON.stringify({ ok: true, node, runDir, extensionsApplied: registry.applied }));
}
