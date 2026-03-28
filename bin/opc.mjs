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
const MANAGED_ENTRIES = ["skill.md", "replay.md", "roles"];

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

    // Only remove OPC-managed files, preserve custom roles
    const rolesDir = join(skillsDir, "roles");
    const managedRoles = readdirSync(join(srcDir, "roles"));

    // Remove managed role files
    if (existsSync(rolesDir)) {
      for (const role of managedRoles) {
        const rolePath = join(rolesDir, role);
        if (existsSync(rolePath)) rmSync(rolePath);
      }
      try {
        const remaining = readdirSync(rolesDir);
        if (remaining.length === 0) rmSync(rolesDir);
        else console.log(`  Kept ${remaining.length} custom role(s) in ${rolesDir}`);
      } catch (err) {
        console.warn(`  ⚠ Could not clean roles dir: ${err.message}`);
      }
    }

    // Remove skill.md
    const skillFile = join(skillsDir, "skill.md");
    if (existsSync(skillFile)) rmSync(skillFile);

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
