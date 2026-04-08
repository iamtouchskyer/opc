#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync, lstatSync, readlinkSync, realpathSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_NAME = "opc";
const skillsDir = join(homedir(), ".claude", "skills", SKILL_NAME);
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
    console.log(`  Use /opc in Claude Code to get started.`);
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
    console.log("  opc install     Install skill files to ~/.claude/skills/opc/");
    console.log("  opc uninstall   Remove skill files (preserves custom roles)");
    console.log("  opc version     Show version");
    console.log();
    console.log("Once installed, use /opc in Claude Code.");
    break;
  }
}
