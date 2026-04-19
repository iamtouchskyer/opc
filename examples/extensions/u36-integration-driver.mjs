#!/usr/bin/env node
// integration-driver.mjs — U3.6 Integration Test (rev 2, post-U3.6r)
//
// Drives all 5 Run 3 extensions via the real harness extension loader +
// fire* dispatchers. Verifies with real assertions (no hardcoded true).

import {
  mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadExtensions,
  firePromptAppend,
  fireVerdictAppend,
  fireExecuteRun,
  fireArtifactEmit,
} from "../bin/lib/extensions.mjs";

const EXT_DIR = process.env.OPC_EXTENSIONS_DIR ||
  join(process.env.HOME, ".opc/extensions");
const OUT_DIR = resolve(process.argv[2] || ".harness-run3/nodes/U3.6/run_1");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(OUT_DIR, "artifacts"), { recursive: true });

// ── Fixtures ─────────────────────────────────────────────────────
// (1) tiny PNG for visual-eval artifact scan
const pngStub = Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C6300000000020001E221BC330000000049454E44AE426082",
  "hex"
);
writeFileSync(join(OUT_DIR, "artifacts/tiny.png"), pngStub);

// (2) design-tokens.json so design-lint has something to lint against
writeFileSync(join(OUT_DIR, "design-tokens.json"), JSON.stringify({
  color: { primary: "#4A90E2", secondary: "#50E3C2" },
  spacing: { sm: 8, md: 16, lg: 24 },
}));

// (3) synthetic flow-state.json for session-logex
mkdirSync(join(OUT_DIR, ".harness-run3-integration"), { recursive: true });
writeFileSync(
  join(OUT_DIR, ".harness-run3-integration/flow-state.json"),
  JSON.stringify({ status: "pipeline_complete", step_count: 10 })
);

// ── Pass 1: in-repo context (git-changeset-review happy path) ────
const ctxInRepo = {
  task: "重构 OPC extension loader 改进错误处理 fix auth bug",
  flowDir: OUT_DIR,
  runDir: OUT_DIR,
  cwd: process.cwd(),
  nodeId: "U3.6-integration",
  nodeCapabilities: ["verification@1", "design-review@1", "execute@1"],
};

const registry = await loadExtensions({});
const names = registry.extensions.map((e) => e.name).sort();
const expected = ["design-lint", "git-changeset-review", "memex-recall",
                  "session-logex", "visual-eval"];

const prompt = await firePromptAppend(registry, ctxInRepo);
await fireVerdictAppend(registry, ctxInRepo);
await fireExecuteRun(registry, ctxInRepo);
await fireArtifactEmit(registry, ctxInRepo);

// ── Pass 2: non-git tmpdir (prove graceful degrade) ──────────────
const NONGIT = "/tmp/run3-u36-nongit";
spawnSync("rm", ["-rf", NONGIT]);
mkdirSync(NONGIT, { recursive: true });
mkdirSync(join(NONGIT, "artifacts"), { recursive: true });
const nonGitCtx = {
  task: "quick fix",
  flowDir: NONGIT, runDir: NONGIT, cwd: NONGIT,
  nodeCapabilities: ["verification@1"],
};
await fireVerdictAppend(registry, nonGitCtx);
const nonGitEval = readFileSync(join(NONGIT, "eval-extensions.md"), "utf8");

// ── Assertions ───────────────────────────────────────────────────
const evalPath = join(OUT_DIR, "eval-extensions.md");
const evalBody = readFileSync(evalPath, "utf8");
const markerPath = join(OUT_DIR, "ext-visual-eval/visual-eval-marker.json");
const marker = existsSync(markerPath)
  ? JSON.parse(readFileSync(markerPath, "utf8")) : null;

// Isolation: every ext-*/ directory must contain only files, and the
// only extension that writes artifacts in this run is visual-eval.
// No other ext-*/ directory should exist.
const extDirs = readdirSync(OUT_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("ext-"))
  .map((d) => d.name);

const isolationOK = extDirs.length === 1 && extDirs[0] === "ext-visual-eval";

const assertions = {
  a_all_5_loaded: JSON.stringify(names) === JSON.stringify(expected),
  b_prompt_is_string: typeof prompt === "string",
  c_verdict_file_written: existsSync(evalPath) &&
    evalBody.includes("# Extension Findings"),
  d_no_red_failures: (registry.failures || []).length === 0,
  e_ext_dir_isolation: isolationOK,
  f_visual_eval_marker_written: marker !== null &&
    typeof marker.status === "string" &&
    ["ok", "error", "timeout"].includes(marker.status),
  g_nongit_graceful: !nonGitEval.includes("package.json changed") &&
    !nonGitEval.includes("exceeds 500 lines") &&
    nonGitEval.includes("No extension findings"),
  h_git_changeset_fires_in_repo: evalBody.includes("code-quality-check"),
  i_session_logex_fires: evalBody.includes("post-flow-digest"),
};

const allPass = Object.values(assertions).every(Boolean);

const report = {
  assertions, extensions: names, prompt_length: prompt.length,
  failures: registry.failures || [], ext_dirs_found: extDirs,
  visual_eval_marker: marker, nongit_eval_body: nonGitEval,
  eval_extensions_body: evalBody,
};
writeFileSync(join(OUT_DIR, "integration-report.json"),
  JSON.stringify(report, null, 2));

console.log(`\n=== U3.6 Integration Assertions (rev 2) ===`);
for (const [k, v] of Object.entries(assertions)) {
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(`\n--- eval-extensions.md (in-repo) ---\n${evalBody}`);
console.log(`--- eval-extensions.md (non-git) ---\n${nonGitEval}`);
console.log(`--- visual-eval marker ---\n${JSON.stringify(marker, null, 2)}`);
console.log(`ext dirs: ${JSON.stringify(extDirs)}`);
process.exit(allPass ? 0 : 1);
