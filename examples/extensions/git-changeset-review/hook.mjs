// hook.mjs — git-changeset-review (OPC Run 3 U3.4)
//
// Declares `code-quality-check@1`. On verdict.append, walks up from
// ctx.flowDir / ctx.runDir / ctx.cwd to find a `.git/` directory, runs
// `git -C <repoRoot> diff --numstat HEAD~1 HEAD` with a 5s timeout, and
// applies 3 rules:
//   1. insertions + deletions > 500          → 🟡 warning
//   2. test/source change ratio < 0.3        → 🟡 warning (if src>0)
//   3. package.json modified, no lockfile    → 🔴 error
//
// Findings shape: { severity, category, message } matching core synth rules.
// Edge cases (no commits / shallow / git missing) return [] gracefully.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";

export const meta = {
  provides: ["code-quality-check@1"],
  compatibleCapabilities: ["verification@1", "design-review@1"],
};

const GIT_TIMEOUT_MS = 5000;
const LINE_THRESHOLD = 500;
const RATIO_THRESHOLD = 0.3;
const TEST_RE = /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|\.(?:test|spec)\.(?:m?[jt]sx?|py|rb|go)$/;
const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

let _gitAvailable = null;
function hasGit() {
  if (_gitAvailable !== null) return _gitAvailable;
  const r = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 2000 });
  _gitAvailable = r.status === 0;
  return _gitAvailable;
}

export function startupCheck() {
  if (!hasGit()) {
    process.stderr.write(
      `[git-changeset-review] WARN: git not in PATH — verdictAppend will no-op\n`
    );
    return { ok: true, available: false };
  }
  return { ok: true, available: true };
}

function findRepoRoot(start) {
  if (!start) return null;
  let cur;
  try { cur = resolve(start); } catch { return null; }
  const root = resolve("/");
  while (true) {
    if (existsSync(join(cur, ".git"))) return cur;
    if (cur === root) return null;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function parseNumstat(stdout) {
  const files = [];
  for (const line of (stdout || "").split("\n")) {
    if (!line.trim()) continue;
    // Format: "<ins>\t<del>\t<path>". With --no-renames we won't see
    // "old => new" syntax, but strip {a => b} defensively just in case.
    const m = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const ins = m[1] === "-" ? 0 : parseInt(m[1], 10) || 0;
    const del = m[2] === "-" ? 0 : parseInt(m[2], 10) || 0;
    const path = m[3].replace(/\{[^{}]* => ([^{}]*)\}/g, "$1");
    files.push({ path, ins, del });
  }
  return files;
}

function analyze(files) {
  const findings = [];
  let total = 0, src = 0, test = 0;
  let pkgJsonChanged = false, lockfileChanged = false;
  for (const f of files) {
    total += f.ins + f.del;
    const isTest = TEST_RE.test(f.path);
    if (isTest) test++;
    else src++;
    const base = basename(f.path);
    if (base === "package.json") pkgJsonChanged = true;
    if (LOCKFILES.includes(base)) lockfileChanged = true;
  }

  if (total > LINE_THRESHOLD) {
    findings.push({
      severity: "warning",
      category: "code-quality-check",
      message: `changeset exceeds ${LINE_THRESHOLD} lines (${total}), consider splitting`,
    });
  }
  if (src > 0) {
    const ratio = test / src;
    if (ratio < RATIO_THRESHOLD) {
      findings.push({
        severity: "warning",
        category: "code-quality-check",
        message: `test/source change ratio <${RATIO_THRESHOLD} (${test}/${src})`,
      });
    }
  }
  if (pkgJsonChanged && !lockfileChanged) {
    findings.push({
      severity: "error",
      category: "code-quality-check",
      message: "package.json changed without lockfile update",
    });
  }
  return findings;
}

export function verdictAppend(ctx) {
  try {
    if (!hasGit()) return [];
    const searchStart = ctx?.flowDir || ctx?.runDir || ctx?.cwd || process.cwd();
    const repoRoot = findRepoRoot(searchStart);
    if (!repoRoot) return [];

    const r = spawnSync(
      "git",
      ["-c", "core.quotepath=false", "-C", repoRoot, "diff", "--numstat", "--no-renames", "HEAD~1", "HEAD"],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS }
    );
    if (r.status !== 0) return []; // shallow / no prior commit / perms — graceful

    return analyze(parseNumstat(r.stdout));
  } catch (err) {
    process.stderr.write(
      `[git-changeset-review] WARN: verdictAppend failed: ${err?.message || err}\n`
    );
    return [];
  }
}

export { analyze as _analyze, parseNumstat as _parseNumstat, findRepoRoot as _findRepoRoot };
