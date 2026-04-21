// Clean up .harness* directories from a target project directory.

import { readdirSync, rmSync, statSync } from "fs";
import { join, resolve } from "path";

const HARNESS_PATTERN = /^\.harness(-.*)?$/;

/**
 * Find all .harness* directories under targetDir (non-recursive, top-level only).
 */
export function findHarnessDirs(targetDir) {
  const resolved = resolve(targetDir);
  return readdirSync(resolved)
    .filter(name => HARNESS_PATTERN.test(name))
    .map(name => join(resolved, name))
    .filter(p => statSync(p).isDirectory());
}

/**
 * Remove all .harness* directories under targetDir.
 * Returns list of removed paths.
 */
export function cleanHarnessDirs(targetDir, { dryRun = false } = {}) {
  const dirs = findHarnessDirs(targetDir);
  if (!dryRun) {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  }
  return dirs;
}

/**
 * CLI: opc-harness clean [<target-dir>] [--dry-run]
 * Defaults to cwd if no target-dir given.
 */
export function cmdClean(args) {
  const dryRun = args.includes("--dry-run");
  // First positional arg (not a flag) is the target dir; default to cwd
  const positional = args.filter(a => !a.startsWith("--"));
  const targetDir = positional[0] || process.cwd();

  const removed = cleanHarnessDirs(targetDir, { dryRun });

  console.log(JSON.stringify({
    cleaned: !dryRun,
    dryRun,
    targetDir: resolve(targetDir),
    removed: removed.map(d => d),
    count: removed.length,
  }));
}
