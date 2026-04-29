#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync, writeFileSync, lstatSync, readlinkSync, realpathSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_NAME = "opc";
const skillsDir = join(homedir(), ".claude", "skills", SKILL_NAME);
const extensionsDir = join(homedir(), ".opc", "extensions");
const srcDir = join(__dirname, "..");

// Only these files/dirs are managed by OPC — custom roles are left alone
const MANAGED_ENTRIES = ["skill.md", "replay.md", "roles", "pipeline", "bin", "package.json"];

// Files removed in newer versions — clean up from target on install
const STALE_FILES = [
  "pipeline/verification-gate.md",
];

const pkg = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8"));
const command = process.argv[2];

switch (command) {
  case "install": {
    // If skillsDir is a symlink pointing to srcDir, it's already installed via symlink
    if (existsSync(skillsDir) && lstatSync(skillsDir).isSymbolicLink()) {
      const target = realpathSync(skillsDir);
      const src = realpathSync(srcDir);
      if (target === src) {
        console.log(`✓ OPC v${pkg.version} already linked at ${skillsDir}`);
        console.log(`  Use /opc in Claude Code to get started.`);
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

    // Install bundled extensions to ~/.opc/extensions/ (additive, never overwrite)
    const srcExtDir = join(srcDir, "extensions");
    if (existsSync(srcExtDir)) {
      mkdirSync(extensionsDir, { recursive: true });
      let installed = 0, skipped = 0;
      for (const ext of readdirSync(srcExtDir)) {
        const srcExt = join(srcExtDir, ext);
        const destExt = join(extensionsDir, ext);
        if (!lstatSync(srcExt).isDirectory()) continue;
        if (existsSync(destExt)) {
          skipped++;
          continue;
        }
        cpSync(srcExt, destExt, { recursive: true });
        installed++;
      }
      if (installed > 0) console.log(`  ${installed} extension(s) installed to ${extensionsDir}`);
      if (skipped > 0) console.log(`  ${skipped} extension(s) already exist, skipped`);
    }

    console.log(`  Use /opc in Claude Code to get started.`);
    console.log(`  Run 'opc install-hooks' to enable compression resilience.`);
    break;
  }

  case "install-hooks": {
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
    const preCmd = `bash "${join(hooksDir, "opc-pre-compact.sh")}" 2>/dev/null || true`;
    const postCmd = `bash "${join(hooksDir, "opc-post-compact.sh")}" 2>/dev/null || true`;

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

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log(`✓ OPC compact hooks registered in ${settingsPath}`);
    console.log(`  PreCompact:  snapshots active flow state before compaction`);
    console.log(`  PostCompact: injects resume context after compaction`);
    break;
  }

  case "uninstall": {
    if (!existsSync(skillsDir)) {
      console.log(`Nothing to remove — ${skillsDir} does not exist.`);
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
    console.log("  opc install         Install skill files to ~/.claude/skills/opc/");
    console.log("  opc install-hooks   Register PreCompact/PostCompact hooks for compression resilience");
    console.log("  opc uninstall       Remove skill files (preserves custom roles)");
    console.log("  opc version         Show version");
    console.log();
    console.log("Once installed, use /opc in Claude Code.");
    break;
  }
}
