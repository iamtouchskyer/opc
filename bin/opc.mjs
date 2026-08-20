#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync, writeFileSync, lstatSync, readlinkSync, realpathSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { atomicWriteSync } from "./lib/util.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_NAME = "opc";
const hostIndex = process.argv.indexOf("--host");
const requestedHost = hostIndex >= 0 ? process.argv[hostIndex + 1] : process.env.OPC_HOST;
const host = (requestedHost || "codex").toLowerCase();
const HOSTS = {
  codex: { directory: ".codex", label: "Codex" },
  claude: { directory: ".claude", label: "Claude Code" },
};
if (!Object.hasOwn(HOSTS, host)) {
  console.error(`✗ Unsupported host '${host}'. Use --host codex or --host claude.`);
  process.exit(2);
}
const hostConfig = HOSTS[host];
const skillsDir = join(homedir(), hostConfig.directory, "skills", SKILL_NAME);

const srcDir = join(__dirname, "..");

// Only these files/dirs are managed by OPC — custom roles are left alone
const MANAGED_ENTRIES = ["SKILL.md", "replay.md", "roles", "pipeline", "bin", "package.json"];

// Files removed in newer versions — clean up from target on install
const STALE_FILES = [
  "pipeline/verification-gate.md",
];

const pkg = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8"));
const command = process.argv[2];

function validateHookScripts(hooksDir) {
  for (const file of ["opc-pre-compact.sh", "opc-post-compact.sh", "opc-pre-tool-budget.mjs"]) {
    if (!existsSync(join(hooksDir, file))) {
      return `missing hook script: ${join(hooksDir, file)}. Run 'opc install' first.`;
    }
  }
  return null;
}

function hasJq() {
  const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
  return !jq.error && jq.status === 0;
}

function removeInstalledHooks(settingsPath) {
  if (!existsSync(settingsPath)) return 0;

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot parse ${settingsPath}: ${error.message}`);
  }
  if (!settings.hooks || typeof settings.hooks !== "object") return 0;

  const hooksDir = join(skillsDir, "bin", "hooks");
  const owned = {
    PreCompact: `bash "${join(hooksDir, "opc-pre-compact.sh")}"`,
    PostCompact: `bash "${join(hooksDir, "opc-post-compact.sh")}"`,
    PreToolUse: `node "${join(hooksDir, "opc-pre-tool-budget.mjs")}"`,
  };
  let removed = 0;

  for (const [event, ownedCommand] of Object.entries(owned)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const keptEntries = [];
    for (const entry of entries) {
      if (!Array.isArray(entry?.hooks)) {
        keptEntries.push(entry);
        continue;
      }
      const hooks = entry.hooks.filter(hook => {
        const isOwned = hook?.type === "command" && hook.command === ownedCommand;
        if (isOwned) removed++;
        return !isOwned;
      });
      if (hooks.length > 0) keptEntries.push({ ...entry, hooks });
    }
    if (keptEntries.length > 0) settings.hooks[event] = keptEntries;
    else delete settings.hooks[event];
  }

  if (removed > 0) {
    atomicWriteSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  return removed;
}

switch (command) {
  case "install": {
    // If skillsDir is a symlink pointing to srcDir, it's already installed via symlink
    if (existsSync(skillsDir) && lstatSync(skillsDir).isSymbolicLink()) {
      const target = realpathSync(skillsDir);
      const src = realpathSync(srcDir);
      if (target === src) {
        console.log(`✓ OPC v${pkg.version} already linked at ${skillsDir}`);
        console.log(`  Use /opc in ${hostConfig.label} to get started.`);
        break;
      }
    }
    mkdirSync(skillsDir, { recursive: true });
    // Clean up files removed in this version
    for (const stale of STALE_FILES) {
      const target = join(skillsDir, stale);
      if (existsSync(target)) {
        rmSync(target);
        console.log(`  Removed stale file: ${stale}`);
      }
    }
    for (const entry of MANAGED_ENTRIES) {
      const src = join(srcDir, entry);
      if (!existsSync(src)) continue;
      cpSync(src, join(skillsDir, entry), { recursive: true, force: true });
    }
    console.log(`✓ OPC v${pkg.version} installed to ${skillsDir}`);
    console.log(`  Use /opc in ${hostConfig.label} to get started.`);
    if (host === "claude") {
      console.log(`  Run 'opc install-hooks --host claude' to enable the Claude auto-flow guard and optional compression resilience.`);
    }
    break;
  }

  case "install-hooks": {
    if (host !== "claude") {
      console.error("✗ install-hooks is a Claude Code compatibility command. Codex owns its native context lifecycle; use --host claude only for a Claude installation.");
      process.exit(2);
    }
    const settingsPath = join(homedir(), ".claude", "settings.json");
    let settings = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      } catch (err) {
        console.error(`✗ Cannot parse ${settingsPath}: ${err.message}`);
        process.exit(1);
      }
    }

    if (!settings.hooks) settings.hooks = {};

    const hooksDir = join(skillsDir, "bin", "hooks");
    const scriptError = validateHookScripts(hooksDir);
    if (scriptError) {
      console.error(`✗ ${scriptError}`);
      process.exit(1);
    }
    const jqAvailable = hasJq();
    const preCmd = `bash "${join(hooksDir, "opc-pre-compact.sh")}"`;
    const postCmd = `bash "${join(hooksDir, "opc-post-compact.sh")}"`;
    const preToolCmd = `node "${join(hooksDir, "opc-pre-tool-budget.mjs")}"`;

    if (jqAvailable) {
      // Merge PreCompact — preserve existing hooks
      if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];
      const hasPreCompact = settings.hooks.PreCompact.some(
        entry => entry.hooks?.some(h => h.command?.includes("opc-pre-compact"))
      );
      if (!hasPreCompact) {
        settings.hooks.PreCompact.push({
          hooks: [{ type: "command", command: preCmd, timeout: 10 }]
        });
      }

      // Merge PostCompact — preserve existing hooks
      if (!settings.hooks.PostCompact) settings.hooks.PostCompact = [];
      const hasPostCompact = settings.hooks.PostCompact.some(
        entry => entry.hooks?.some(h => h.command?.includes("opc-post-compact"))
      );
      if (!hasPostCompact) {
        settings.hooks.PostCompact.push({
          hooks: [{ type: "command", command: postCmd, timeout: 10 }]
        });
      }
    }

    // Merge PreToolUse — preserve existing hooks and use a synchronous command decision.
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
    const hasPreToolUse = settings.hooks.PreToolUse.some(
      entry => (entry.matcher == null || entry.matcher === "") &&
        entry.hooks?.some(h => h.type === "command" && h.async !== true && h.command === preToolCmd)
    );
    if (!hasPreToolUse) {
      settings.hooks.PreToolUse.push({
        hooks: [{ type: "command", command: preToolCmd, timeout: 10 }]
      });
    }

    mkdirSync(dirname(settingsPath), { recursive: true });
    atomicWriteSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log(`✓ OPC hooks registered in ${settingsPath}`);
    console.log(`  PreToolUse:  enforces active auto-flow node budgets`);
    if (jqAvailable) {
      console.log(`  PreCompact:  snapshots active flow state before compaction`);
      console.log(`  PostCompact: injects resume context after compaction`);
    } else {
      console.log(`  WARN: jq not found; skipped optional PreCompact/PostCompact hooks.`);
    }
    break;
  }

  case "uninstall": {
    if (host === "claude") {
      const settingsPath = join(homedir(), ".claude", "settings.json");
      let removedHooks;
      try {
        removedHooks = removeInstalledHooks(settingsPath);
      } catch (error) {
        console.error(`✗ Cannot safely uninstall OPC: ${error.message}`);
        process.exit(1);
      }
      if (removedHooks > 0) {
        console.log(`  Removed ${removedHooks} OPC hook(s) from ${settingsPath}`);
      }
    }

    if (!existsSync(skillsDir)) {
      console.log(`Nothing else to remove — ${skillsDir} does not exist.`);
      break;
    }

    // If skillsDir is a symlink, just remove the link itself — don't follow it
    if (lstatSync(skillsDir).isSymbolicLink()) {
      rmSync(skillsDir);
      console.log(`✓ OPC symlink removed: ${skillsDir}`);
      break;
    }

    // Only remove OPC-managed entries, preserve custom roles
    for (const entry of MANAGED_ENTRIES) {
      const targetPath = join(skillsDir, entry);
      if (!existsSync(targetPath)) continue;

      if (entry === "roles") {
        // Selective deletion — preserve custom roles
        let managedRoles;
        try {
          managedRoles = readdirSync(join(srcDir, "roles"));
        } catch (err) {
          console.warn(`  ⚠ Could not read source roles dir: ${err.message}. Removing entire roles dir.`);
          rmSync(targetPath, { recursive: true });
          continue;
        }
        for (const role of managedRoles) {
          const rolePath = join(targetPath, role);
          if (existsSync(rolePath)) rmSync(rolePath);
        }
        try {
          const remaining = readdirSync(targetPath);
          if (remaining.length === 0) rmSync(targetPath);
          else console.log(`  Kept ${remaining.length} custom role(s) in ${targetPath}`);
        } catch (err) {
          console.warn(`  ⚠ Could not clean roles dir: ${err.message}`);
        }
      } else if (lstatSync(targetPath).isDirectory()) {
        rmSync(targetPath, { recursive: true });
      } else {
        rmSync(targetPath);
      }
    }

    // Remove dir only if empty
    try {
      const remaining = readdirSync(skillsDir);
      if (remaining.length === 0) rmSync(skillsDir);
    } catch (err) {
      console.warn(`  ⚠ Could not remove skill dir: ${err.message}`);
    }

    console.log(`✓ OPC removed from ${skillsDir}`);
    break;
  }

  case "version":
  case "-v":
  case "--version": {
    console.log(pkg.version);
    break;
  }

  default: {
    console.log(`OPC v${pkg.version} — One Person Company`);
    console.log();
    console.log("Usage:");
    console.log("  opc install [--host codex|claude]       Install skill files (default: Codex)");
    console.log("  opc install-hooks --host claude         Register Claude PreToolUse and optional compact hooks");
    console.log("  opc uninstall [--host codex|claude]     Remove skill files (preserves custom roles)");
    console.log("  opc version         Show version");
    console.log();
    console.log("Once installed, use /opc in Codex (or the selected compatibility host).");
    break;
  }
}
