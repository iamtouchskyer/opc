// Tests for the changeScope fix: scope the review-coverage gate to the commits
// the flow actually PRODUCED (--change-commits / flow-state.producedCommits),
// instead of a blind `git diff HEAD~1` that mis-attributes unrelated parallel
// commits and cannot see session-local artifacts the flow never committed.
//
// Two levels:
//   1. Unit — changeScopeDiffFiles(baseDir, changeCommits) in a real temp repo.
//   2. Litmus pair — synthesize CLI verdict flips PASS↔ITERATE on --change-commits
//      alone, proving the fix DISABLES the false-positive without disabling the
//      gate (a non-empty produced set still bites).
// Plus record-commit (default HEAD, dedup, fail-closed) and init field seeding.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";
import { changeScopeDiffFiles } from "./eval-commands.mjs";

const TMPBASE = join(os.homedir(), ".opc", "sessions", `changescope-test-${Date.now()}`);
const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "..", "opc-harness.mjs");

// ── git repo builder ────────────────────────────────────────────
// Commit 1 (init): real.ts — the file the review actually inspects.
// Commit 2 (feature): feature-a.ts + feature-b.ts — the "produced" change.
// The eval below references real.ts (exists) but NOT the feature files, so a
// scope of {feature-a, feature-b} is 0/2 covered → the gate must bite.
function makeGitRepo(name) {
  const dir = join(TMPBASE, name);
  mkdirSync(dir, { recursive: true });
  const git = (cmd) => execSync(cmd, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
  git("git init -q .");
  git("git config user.email t@t.t");
  git("git config user.name t");
  writeFileSync(join(dir, "real.ts"), "export function realThing() { return 1; }\n");
  git("git add .");
  git("git commit -q -m init");
  const initSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
  writeFileSync(join(dir, "feature-a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "feature-b.ts"), "export const b = 2;\n");
  git("git add .");
  git("git commit -q -m feature");
  const featureSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
  return { dir, initSha, featureSha };
}

// A clean, otherwise-passing eval: mandatory skeptic-owner role, suggestion-only
// (🔵), substantive (reasoning + fix + real file:line). Its ONLY possible warning
// source is changeScope — so verdict is a pure litmus for the fix.
const CLEAN_EVAL = `# Skeptic Owner Review

🔵 real.ts:1 — realThing could expose a named constant

**Reasoning:** a named constant would read better than a literal return value.

**Fix:** extract the magic number to a named const.
`;

function makeSession(name, evalText = CLEAN_EVAL) {
  const dir = join(TMPBASE, name);
  const runDir = join(dir, "nodes", "code-review", "run_1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "eval-skeptic-owner.md"), evalText);
  return dir;
}

// Parse harness JSON output. synthesize pretty-prints (multi-line) while most
// commands emit a single compact line, so try the whole stdout first and fall
// back to the last line. Deprecation notices go to stderr, keeping stdout pure.
function parseJson(text) {
  const t = String(text || "").trim();
  try { return JSON.parse(t); }
  catch { return JSON.parse(t.split("\n").at(-1)); }
}

function runHarness(cmd, args) {
  try {
    const out = execFileSync("node", [HARNESS, cmd, ...args], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    return parseJson(out);
  } catch (err) {
    try { return parseJson(err.stdout); }
    catch { return { error: err.message, stderr: String(err.stderr || "") }; }
  }
}

function synthesize(sessionDir, base, changeCommits) {
  const args = ["--node", "code-review", "--dir", sessionDir, "--base", base];
  if (changeCommits !== undefined) args.push("--change-commits", changeCommits);
  return runHarness("synthesize", args);
}

after(() => { try { rmSync(TMPBASE, { recursive: true, force: true }); } catch {} });

// ── Unit: changeScopeDiffFiles ──────────────────────────────────
describe("changeScopeDiffFiles", () => {
  let repo;
  before(() => { repo = makeGitRepo("unit-repo"); });

  test("non-git base → skip with an explicit reason", () => {
    const nonGit = join(TMPBASE, "not-a-repo");
    mkdirSync(nonGit, { recursive: true });
    const r = changeScopeDiffFiles(nonGit, []);
    assert.equal(r.skip, true);
    assert.match(r.reason, /not a git repository/);
    assert.deepEqual(r.files, []);
  });

  test("empty produced set → skip cleanly, no reason, no files (the fix)", () => {
    const r = changeScopeDiffFiles(repo.dir, []);
    assert.equal(r.skip, true);
    assert.equal(r.reason, null);
    assert.deepEqual(r.files, []);
  });

  test("explicit commit → exactly that commit's files (gate still bites)", () => {
    const r = changeScopeDiffFiles(repo.dir, [repo.featureSha]);
    assert.equal(r.skip, false);
    assert.deepEqual([...r.files].sort(), ["feature-a.ts", "feature-b.ts"]);
  });

  test("multiple commits → union of their files", () => {
    const r = changeScopeDiffFiles(repo.dir, [repo.initSha, repo.featureSha]);
    assert.deepEqual([...r.files].sort(), ["feature-a.ts", "feature-b.ts", "real.ts"]);
  });

  test("unknown sha is skipped, valid siblings retained", () => {
    const r = changeScopeDiffFiles(repo.dir, ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", repo.featureSha]);
    assert.deepEqual([...r.files].sort(), ["feature-a.ts", "feature-b.ts"]);
  });

  test("null (flag absent) → legacy HEAD~1 diff", () => {
    const r = changeScopeDiffFiles(repo.dir, null);
    assert.equal(r.skip, false);
    // HEAD~1..HEAD is the feature commit.
    assert.deepEqual([...r.files].sort(), ["feature-a.ts", "feature-b.ts"]);
  });
});

// ── Litmus pair: --change-commits flips the verdict, nothing else does ──
describe("changeScope litmus (synthesize verdict)", () => {
  let repo;
  before(() => { repo = makeGitRepo("litmus-repo"); });

  test("empty --change-commits → PASS (false-positive is gone)", () => {
    const s = makeSession("litmus-empty");
    const out = synthesize(s, repo.dir, "");
    assert.equal(out.verdict, "PASS", JSON.stringify(out));
  });

  test("--change-commits <featureSha> → ITERATE (gate still enforces scope)", () => {
    const s = makeSession("litmus-scoped");
    const out = synthesize(s, repo.dir, repo.featureSha);
    assert.equal(out.verdict, "ITERATE", JSON.stringify(out));
    const joined = JSON.stringify(out);
    assert.match(joined, /changed files/);
  });

  test("legacy: no --change-commits → ITERATE (HEAD~1 fallback preserved)", () => {
    const s = makeSession("litmus-legacy");
    const out = synthesize(s, repo.dir); // omit the flag entirely
    assert.equal(out.verdict, "ITERATE", JSON.stringify(out));
  });

  test("scoped to a commit the eval DOES cover → PASS", () => {
    const s = makeSession("litmus-covered");
    // initSha touches real.ts, which the eval references → 1/1 covered.
    const out = synthesize(s, repo.dir, repo.initSha);
    assert.equal(out.verdict, "PASS", JSON.stringify(out));
  });
});

// ── record-commit ───────────────────────────────────────────────
describe("record-commit", () => {
  let repo;
  before(() => { repo = makeGitRepo("record-repo"); });

  function seedState(name, extra = {}) {
    const dir = join(TMPBASE, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify({
      version: "1.0", flowTemplate: "build-verify", currentNode: "build",
      projectRoot: repo.dir, producedCommits: [], history: [],
      _written_by: "opc-harness", ...extra,
    }, null, 2));
    return dir;
  }

  test("records explicit --sha, expanded to full sha", () => {
    const dir = seedState("rec-explicit");
    const out = runHarness("record-commit", ["--dir", dir, "--sha", repo.featureSha.slice(0, 10)]);
    assert.equal(out.recorded, true);
    assert.equal(out.sha, repo.featureSha);
    const state = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
    assert.deepEqual(state.producedCommits, [repo.featureSha]);
  });

  test("defaults to HEAD when --sha omitted", () => {
    const dir = seedState("rec-head");
    const out = runHarness("record-commit", ["--dir", dir]);
    assert.equal(out.recorded, true);
    assert.equal(out.sha, repo.featureSha); // HEAD of the repo
  });

  test("dedups a repeated commit", () => {
    const dir = seedState("rec-dedup");
    runHarness("record-commit", ["--dir", dir, "--sha", repo.featureSha]);
    const out = runHarness("record-commit", ["--dir", dir, "--sha", repo.featureSha]);
    assert.equal(out.already, true);
    const state = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
    assert.deepEqual(state.producedCommits, [repo.featureSha]);
  });

  test("accumulates distinct commits in order", () => {
    const dir = seedState("rec-many");
    runHarness("record-commit", ["--dir", dir, "--sha", repo.initSha]);
    runHarness("record-commit", ["--dir", dir, "--sha", repo.featureSha]);
    const state = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
    assert.deepEqual(state.producedCommits, [repo.initSha, repo.featureSha]);
  });

  test("fail-closed on an invalid sha", () => {
    const dir = seedState("rec-bad-sha");
    const out = runHarness("record-commit", ["--dir", dir, "--sha", "notacommit"]);
    assert.equal(out.recorded, false);
    assert.match(out.error, /not a valid commit/);
    const state = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
    assert.deepEqual(state.producedCommits, []);
  });

  test("fail-closed when flow-state.json is missing", () => {
    const dir = join(TMPBASE, "rec-nostate");
    mkdirSync(dir, { recursive: true });
    const out = runHarness("record-commit", ["--dir", dir]);
    assert.equal(out.recorded, false);
    assert.match(out.error, /flow-state\.json not found/);
  });
});

// ── init seeds the changeScope fields ───────────────────────────
describe("init flow-state fields", () => {
  test("init writes baseSha (git floor) and empty producedCommits", () => {
    const dir = join(TMPBASE, "init-fields");
    const out = runHarness("init", ["--flow", "build-verify", "--dir", dir, "--no-extensions"]);
    assert.equal(out.created ?? true, true, JSON.stringify(out));
    const state = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
    assert.ok(Object.prototype.hasOwnProperty.call(state, "baseSha"));
    // OPC's own repo is git, so baseSha resolves to a 40-char sha here.
    assert.match(state.baseSha, /^[0-9a-f]{40}$/);
    assert.deepEqual(state.producedCommits, []);
  });
});
