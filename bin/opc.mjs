#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, rmSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_NAME = "opc";
const skillsDir = join(homedir(), ".claude", "skills", SKILL_NAME);
const srcDir = join(__dirname, "..");
const entries = ["skill.md", "roles"];

const pkg = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8"));
const command = process.argv[2];

switch (command) {
  case "install": {
    mkdirSync(skillsDir, { recursive: true });
    for (const entry of entries) {
      const src = join(srcDir, entry);
      if (!existsSync(src)) continue;
      cpSync(src, join(skillsDir, entry), { recursive: true, force: true });
    }
    console.log(`✓ OPC v${pkg.version} installed to ${skillsDir}`);
    console.log(`  Use /opc in Claude Code to get started.`);
    break;
  }

  case "uninstall": {
    if (existsSync(skillsDir)) {
      rmSync(skillsDir, { recursive: true });
      console.log(`✓ OPC removed from ${skillsDir}`);
    } else {
      console.log(`Nothing to remove — ${skillsDir} does not exist.`);
    }
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
    console.log("  opc uninstall   Remove skill files");
    console.log("  opc version     Show version");
    console.log();
    console.log("Once installed, use /opc in Claude Code.");
    break;
  }
}
