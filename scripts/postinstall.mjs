#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const SKILL_NAME = "opc";
const skillsDir = join(homedir(), ".claude", "skills", SKILL_NAME);
const srcDir = join(import.meta.dirname, "..");

// Files to copy
const entries = ["skill.md", "roles"];

try {
  mkdirSync(skillsDir, { recursive: true });

  for (const entry of entries) {
    const src = join(srcDir, entry);
    if (!existsSync(src)) continue;
    cpSync(src, join(skillsDir, entry), { recursive: true, force: true });
  }

  const pkg = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8"));
  console.log(`✓ OPC v${pkg.version} installed to ${skillsDir}`);
  console.log(`  Use /opc in Claude Code to get started.`);
} catch (err) {
  // Don't fail the install if copy fails (e.g., permissions)
  console.warn(`⚠ Could not install OPC skill files to ${skillsDir}`);
  console.warn(`  Run 'opc install' manually to retry.`);
  console.warn(`  Error: ${err.message}`);
}
