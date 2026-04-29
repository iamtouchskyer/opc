// loop-p1p3.test.mjs — Tests for P1 (projectDir) + P3 (structured stall errors)
// Run: node --test bin/lib/loop-p1p3.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

import { getGitHeadHash, detectPreCommitHooks, detectTestScript } from "./loop-helpers.mjs";

const HARNESS = join(import.meta.dirname, "..", "opc-harness.mjs");

function runHarness(args, { cwd } = {}) {
  try {
    const out = execFileSync("node", [HARNESS, ...args], {
      encoding: "utf8",
      timeout: 10000,
      cwd: cwd || undefined,
      env: { ...process.env, OPC_TICK_TIMEOUT_HOURS: "0.001" },
    });
    return JSON.parse(out.trim().split("\n").pop());
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "");
    const lines = output.trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch { /* continue */ }
    }
    throw new Error(`harness failed: ${output}`);
  }
}

// ── P1: loop-helpers accept projectDir ─────────────────────────

describe("P1: getGitHeadHash with projectDir", () => {
  test("returns hash when given valid git repo dir", () => {
    // Use the OPC skill dir itself (it's a git repo or inside one)
    const opcDir = join(import.meta.dirname, "..", "..");
    const hash = getGitHeadHash(opcDir);
    // May or may not be a git repo, but shouldn't throw
    if (hash) {
      assert.match(hash, /^[0-9a-f]{40}$/);
    }
  });

  test("returns null for non-git directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p1-test-"));
    try {
      const hash = getGitHeadHash(tmp);
      assert.equal(hash, null);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  test("returns null for non-existent directory", () => {
    const hash = getGitHeadHash("/tmp/definitely-does-not-exist-xyz");
    assert.equal(hash, null);
  });
});

describe("P1: detectPreCommitHooks with projectDir", () => {
  test("returns false for empty directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p1-hooks-"));
    try {
      assert.equal(detectPreCommitHooks(tmp), false);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  test("returns true when .husky/pre-commit exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p1-hooks-"));
    try {
      mkdirSync(join(tmp, ".husky"), { recursive: true });
      writeFileSync(join(tmp, ".husky", "pre-commit"), "#!/bin/sh\nexit 0\n");
      assert.equal(detectPreCommitHooks(tmp), true);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

describe("P1: detectTestScript with projectDir", () => {
  test("returns all false for dir without package.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p1-pkg-"));
    try {
      const result = detectTestScript(tmp);
      assert.deepEqual(result, { test: false, lint: false, typecheck: false });
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  test("detects test script from package.json in specified dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p1-pkg-"));
    try {
      writeFileSync(join(tmp, "package.json"), JSON.stringify({
        scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit" }
      }));
      const result = detectTestScript(tmp);
      assert.deepEqual(result, { test: "npm run test", lint: "npm run lint", typecheck: "npm run typecheck" });
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

// ── P1: init-loop --project-dir ────────────────────────────────

describe("P1: init-loop --project-dir", () => {
  test("stores projectDir in loop-state.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p1-init-"));
    const projDir = mkdtempSync(join(tmpdir(), "p1-proj-"));
    try {
      // Write minimal plan
      writeFileSync(join(tmp, "plan.md"), [
        "## Task Scope",
        "- SCOPE-1: test",
        "",
        "## Units",
        "- T1.1: implement — do stuff",
        "  - verify: echo ok",
        "- T1.2: review — check stuff",
        "  - eval: quality check",
      ].join("\n"));
      // Write acceptance criteria
      writeFileSync(join(tmp, "acceptance-criteria.md"), [
        "# Acceptance Criteria",
        "## Outcomes",
        "- OUT-1: thing works",
        "  - VERIFY: run test",
        "## Verification",
        "```bash",
        "echo ok",
        "```",
        "- OUT-1: verified by running test",
        "## Quality Constraints",
        "- backward compat",
        "## Out of Scope",
        "- nothing",
      ].join("\n"));

      const result = runHarness(["init-loop", "--dir", tmp, "--project-dir", projDir, "--skip-lint"], { cwd: tmp });
      assert.equal(result.initialized, true);

      // Read state and verify projectDir
      const state = JSON.parse(readFileSync(join(tmp, "loop-state.json"), "utf8"));
      assert.equal(state.projectDir, projDir);
    } finally {
      rmSync(tmp, { recursive: true });
      rmSync(projDir, { recursive: true });
    }
  });

  test("rejects non-existent --project-dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p1-init-bad-"));
    try {
      writeFileSync(join(tmp, "plan.md"), "## Task Scope\n- SCOPE-1: x\n\n- T1.1: implement — x\n- T1.2: review — x\n");
      const result = runHarness(["init-loop", "--dir", tmp, "--project-dir", "/tmp/no-such-dir-xyz123"], { cwd: tmp });
      assert.equal(result.initialized, false);
      assert.ok(result.errors.some(e => e.includes("does not exist")));
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

// ── P3: Structured stall errors ────────────────────────────────

describe("P3: complete-tick structured terminal error", () => {
  test("returns status/reason/detail/hint when loop is terminated", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p3-term-"));
    try {
      const state = {
        tick: 2,
        unit: "F1.1",
        status: "stalled",
        next_unit: "F1.2",
        _written_by: "opc-harness/1.0",
        _write_nonce: "abc123",
        _last_modified: new Date().toISOString(),
      };
      writeFileSync(join(tmp, "loop-state.json"), JSON.stringify(state));

      const result = runHarness(["complete-tick", "--dir", tmp, "--unit", "F1.2", "--artifacts", "", "--description", "test"], { cwd: tmp });
      assert.equal(result.completed, false);
      assert.equal(result.status, "terminal");
      assert.ok(result.reason);
      assert.ok(result.detail);
      assert.ok(result.hint);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

describe("P3: next-tick structured stall output", () => {
  test("in_progress timeout includes status/detail/hint", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p3-stall-"));
    try {
      const oldTime = new Date(Date.now() - 2 * 3600000).toISOString(); // 2h ago
      const state = {
        tick: 1,
        unit: "F1.1",
        status: "in_progress",
        next_unit: "F1.2",
        plan_file: join(tmp, "plan.md"),
        _written_by: "opc-harness/1.0",
        _write_nonce: "abc123",
        _in_progress_since: oldTime,
        _last_modified: oldTime,
        _tick_history: [],
      };
      writeFileSync(join(tmp, "loop-state.json"), JSON.stringify(state));
      writeFileSync(join(tmp, "plan.md"), "- F1.1: implement — x\n- F1.2: review — y\n");

      const result = runHarness(["next-tick", "--dir", tmp], { cwd: tmp });
      assert.equal(result.ready, false);
      assert.equal(result.terminate, true);
      assert.equal(result.status, "stalled");
      assert.ok(result.detail);
      assert.ok(result.hint);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

// ── P3: 3-tick stall detection ─────────────────────────────────

describe("P3: next-tick 3-tick stall detection", () => {
  test("terminates with structured output after 3 consecutive same-unit ticks", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p3-3tick-"));
    try {
      writeFileSync(join(tmp, "plan.md"), "- F1.1: implement — x\n- F1.2: review — y\n");
      const state = {
        tick: 3,
        unit: "F1.1",
        status: "completed",
        next_unit: "F1.1",
        plan_file: join(tmp, "plan.md"),
        _written_by: "opc-harness/1.0",
        _write_nonce: "abc123",
        _last_modified: new Date().toISOString(),
        _tick_history: [
          { unit: "F1.1", tick: 1, status: "blocked" },
          { unit: "F1.1", tick: 2, status: "blocked" },
          { unit: "F1.1", tick: 3, status: "failed" },
        ],
      };
      writeFileSync(join(tmp, "loop-state.json"), JSON.stringify(state));

      const result = runHarness(["next-tick", "--dir", tmp], { cwd: tmp });
      assert.equal(result.ready, false);
      assert.equal(result.terminate, true);
      assert.equal(result.status, "stalled");
      assert.ok(result.detail);
      assert.ok(result.hint);
      assert.ok(result.reason.includes("stalled"));
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

// ── P3: 6-tick oscillation detection ───────────────────────────

describe("P3: next-tick oscillation stall detection", () => {
  test("terminates with structured output after A-B-A-B-A-B pattern", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p3-osc-"));
    try {
      writeFileSync(join(tmp, "plan.md"), "- F1.1: implement — x\n- F1.2: review — y\n");
      const state = {
        tick: 6,
        unit: "F1.2",
        status: "completed",
        next_unit: "F1.1",
        plan_file: join(tmp, "plan.md"),
        _written_by: "opc-harness/1.0",
        _write_nonce: "abc123",
        _last_modified: new Date().toISOString(),
        _tick_history: [
          { unit: "F1.1", tick: 1, status: "completed" },
          { unit: "F1.2", tick: 2, status: "completed" },
          { unit: "F1.1", tick: 3, status: "completed" },
          { unit: "F1.2", tick: 4, status: "completed" },
          { unit: "F1.1", tick: 5, status: "completed" },
          { unit: "F1.2", tick: 6, status: "completed" },
        ],
      };
      writeFileSync(join(tmp, "loop-state.json"), JSON.stringify(state));

      const result = runHarness(["next-tick", "--dir", tmp], { cwd: tmp });
      assert.equal(result.ready, false);
      assert.equal(result.terminate, true);
      assert.equal(result.status, "stalled");
      assert.ok(result.detail);
      assert.ok(result.hint);
      assert.ok(result.reason.includes("oscillation"));
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

// ── P3: maxTotalTicks exhaustion ───────────────────────────────

describe("P3: next-tick maxTotalTicks exhaustion", () => {
  test("terminates with structured output when tick >= _max_total_ticks", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p3-max-"));
    try {
      writeFileSync(join(tmp, "plan.md"), "- F1.1: implement — x\n- F1.2: review — y\n");
      const state = {
        tick: 6,
        unit: "F1.1",
        status: "completed",
        next_unit: "F1.2",
        plan_file: join(tmp, "plan.md"),
        _written_by: "opc-harness/1.0",
        _write_nonce: "abc123",
        _last_modified: new Date().toISOString(),
        _tick_history: [{ unit: "F1.1", tick: 1, status: "completed" }],
        _max_total_ticks: 6,
      };
      writeFileSync(join(tmp, "loop-state.json"), JSON.stringify(state));

      const result = runHarness(["next-tick", "--dir", tmp], { cwd: tmp });
      assert.equal(result.ready, false);
      assert.equal(result.terminate, true);
      assert.equal(result.status, "terminated");
      assert.ok(result.detail);
      assert.ok(result.hint);
      assert.ok(result.reason.includes("maxTotalTicks"));
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

// ── P3: wall-clock deadline ────────────────────────────────────

describe("P3: next-tick wall-clock deadline", () => {
  test("terminates with structured output when duration exceeded", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p3-wall-"));
    try {
      writeFileSync(join(tmp, "plan.md"), "- F1.1: implement — x\n- F1.2: review — y\n");
      const state = {
        tick: 1,
        unit: "F1.1",
        status: "completed",
        next_unit: "F1.2",
        plan_file: join(tmp, "plan.md"),
        _written_by: "opc-harness/1.0",
        _write_nonce: "abc123",
        _last_modified: new Date().toISOString(),
        _tick_history: [{ unit: "F1.1", tick: 1, status: "completed" }],
        _started_at: new Date(Date.now() - 25 * 3600000).toISOString(),
        _max_duration_hours: 24,
      };
      writeFileSync(join(tmp, "loop-state.json"), JSON.stringify(state));

      const result = runHarness(["next-tick", "--dir", tmp], { cwd: tmp });
      assert.equal(result.ready, false);
      assert.equal(result.terminate, true);
      assert.equal(result.status, "terminated");
      assert.ok(result.detail);
      assert.ok(result.hint);
      assert.ok(result.reason.includes("wall-clock"));
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

// ── Fix #4: Stall detection false positive ────────────────────

describe("P3: stall detection does NOT fire when last tick succeeded", () => {
  test("3 same-unit ticks with last one completed = no stall", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p3-nostall-"));
    try {
      writeFileSync(join(tmp, "plan.md"), "- F1.1: implement — x\n- F1.2: review — y\n");
      const state = {
        tick: 3,
        unit: "F1.1",
        status: "completed",
        next_unit: "F1.1",
        plan_file: join(tmp, "plan.md"),
        _written_by: "opc-harness/1.0",
        _write_nonce: "abc123",
        _last_modified: new Date().toISOString(),
        _tick_history: [
          { unit: "F1.1", tick: 1, status: "blocked" },
          { unit: "F1.1", tick: 2, status: "blocked" },
          { unit: "F1.1", tick: 3, status: "completed" },
        ],
      };
      writeFileSync(join(tmp, "loop-state.json"), JSON.stringify(state));

      const result = runHarness(["next-tick", "--dir", tmp], { cwd: tmp });
      // Should NOT stall — last tick succeeded
      assert.equal(result.terminate, undefined || false);
      assert.equal(result.ready, true);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

// ── Fix #3: _runTestScript coverage ───────────────────────────

describe("_runTestScript: timeout vs real failure distinction", () => {
  test("passing test returns exitCode 0", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p3-run-"));
    try {
      // Create a fake project with passing test script
      writeFileSync(join(tmp, "package.json"), JSON.stringify({
        scripts: { test: "echo PASS" }
      }));
      writeFileSync(join(tmp, "plan.md"), "- F1.1: implement — x\n- F1.2: review — y\n");
      const state = {
        tick: 0,
        unit: null,
        status: "in_progress",
        next_unit: "F1.1",
        plan_file: join(tmp, "plan.md"),
        _written_by: "opc-harness/1.0",
        _write_nonce: "abc123",
        _last_modified: new Date().toISOString(),
        _git_head: null,
        _tick_history: [],
        _external_validators: { test_script: "echo PASS", pre_commit_hooks: false },
        projectDir: tmp,
      };
      writeFileSync(join(tmp, "loop-state.json"), JSON.stringify(state));
      // Create a dummy artifact
      writeFileSync(join(tmp, "result.json"), JSON.stringify({ tests_run: 1, passed: 1, _command: "echo PASS", exitCode: 0 }));

      const result = runHarness(["complete-tick", "--dir", tmp, "--unit", "F1.1", "--artifacts", join(tmp, "result.json"), "--description", "test"], { cwd: tmp });
      // Should not have timeout error
      const hasTimeout = (result.errors || []).some(e => e.includes("TIMED OUT"));
      assert.equal(hasTimeout, false);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  test("failing test returns exitCode != 0 with clear message", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p3-fail-"));
    try {
      writeFileSync(join(tmp, "package.json"), JSON.stringify({
        scripts: { test: "exit 1" }
      }));
      writeFileSync(join(tmp, "plan.md"), "- F1.1: implement — x\n- F1.2: review — y\n");
      const state = {
        tick: 0,
        unit: null,
        status: "in_progress",
        next_unit: "F1.1",
        plan_file: join(tmp, "plan.md"),
        _written_by: "opc-harness/1.0",
        _write_nonce: "abc123",
        _last_modified: new Date().toISOString(),
        _git_head: null,
        _tick_history: [],
        _external_validators: { test_script: "exit 1", pre_commit_hooks: false },
        projectDir: tmp,
      };
      writeFileSync(join(tmp, "loop-state.json"), JSON.stringify(state));
      writeFileSync(join(tmp, "result.json"), JSON.stringify({ tests_run: 1, passed: 0, _command: "exit 1", exitCode: 1 }));

      const result = runHarness(["complete-tick", "--dir", tmp, "--unit", "F1.1", "--artifacts", join(tmp, "result.json"), "--description", "test"], { cwd: tmp });
      assert.equal(result.completed, false);
      const hasTestFail = (result.errors || []).some(e => e.includes("exit 1") && !e.includes("TIMED OUT"));
      assert.equal(hasTestFail, true);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

// ── Full lifecycle integration test ──────────────────────────

describe("Full lifecycle: init → next-tick → complete-tick → terminate", () => {
  test("complete loop with implement + review units", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lifecycle-"));
    try {
      // Set up a git repo so commit checks work
      execFileSync("git", ["init"], { cwd: tmp });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmp });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: tmp });

      // Write plan with implement + review
      writeFileSync(join(tmp, "plan.md"), [
        "## Task Scope",
        "- SCOPE-1: add greeting feature",
        "",
        "## Units",
        "- T1.1: implement — add greeting module",
        "  - verify: node -e \"require('./greet')\"",
        "- T1.2: review — check greeting quality",
        "  - eval: code quality review",
      ].join("\n"));

      // Write acceptance criteria
      writeFileSync(join(tmp, "acceptance-criteria.md"), [
        "# Acceptance Criteria",
        "## Outcomes",
        "- OUT-1: greeting module exists",
        "  - VERIFY: node -e \"require('./greet')\"",
        "## Verification",
        "```bash",
        "node -e \"require('./greet')\"",
        "```",
        "- OUT-1: verified by requiring module",
        "## Quality Constraints",
        "- clean code",
        "## Out of Scope",
        "- nothing",
      ].join("\n"));

      // Initial commit
      writeFileSync(join(tmp, "README.md"), "# Test\n");
      execFileSync("git", ["add", "."], { cwd: tmp });
      execFileSync("git", ["commit", "-m", "init"], { cwd: tmp });

      // ── Step 1: init-loop ──
      const initResult = runHarness(["init-loop", "--dir", tmp, "--project-dir", tmp, "--skip-lint"], { cwd: tmp });
      assert.equal(initResult.initialized, true);
      assert.equal(initResult.first_unit, "T1.1");
      assert.equal(initResult.total_units, 2);

      // ── Step 2: next-tick → should give T1.1 ──
      const tick1 = runHarness(["next-tick", "--dir", tmp], { cwd: tmp });
      assert.equal(tick1.ready, true);
      assert.equal(tick1.next_unit, "T1.1");
      assert.equal(tick1.unit_type, "implement");
      assert.equal(tick1.tick, 1);

      // Simulate implement: create file + commit + artifact
      writeFileSync(join(tmp, "greet.js"), "module.exports = () => 'hello';\n");
      const artifactPath = join(tmp, "test-result.json");
      writeFileSync(artifactPath, JSON.stringify({ tests_run: 1, passed: 1, _command: "node -e \"require('./greet')\"", exitCode: 0 }));
      execFileSync("git", ["add", "."], { cwd: tmp });
      execFileSync("git", ["commit", "-m", "feat: add greeting"], { cwd: tmp });
      // Touch artifact after commit so it's fresh
      writeFileSync(artifactPath, JSON.stringify({ tests_run: 1, passed: 1, _command: "node -e \"require('./greet')\"", exitCode: 0 }));

      // ── Step 3: complete-tick T1.1 ──
      const complete1 = runHarness([
        "complete-tick", "--dir", tmp,
        "--unit", "T1.1",
        "--artifacts", artifactPath,
        "--description", "added greeting module covering SCOPE-1",
      ], { cwd: tmp });
      assert.equal(complete1.completed, true, `Expected completed=true, got errors: ${JSON.stringify(complete1.errors)}`);
      assert.equal(complete1.tick, 1);
      assert.equal(complete1.next_unit, "T1.2");
      assert.equal(complete1.terminate, false);

      // ── Step 4: next-tick → should give T1.2 ──
      const tick2 = runHarness(["next-tick", "--dir", tmp], { cwd: tmp });
      assert.equal(tick2.ready, true);
      assert.equal(tick2.next_unit, "T1.2");
      assert.equal(tick2.unit_type, "review");

      // Simulate review: write 2 eval files with LGTM
      const eval1 = join(tmp, "eval-frontend.md");
      const eval2 = join(tmp, "eval-backend.md");
      writeFileSync(eval1, "# Frontend Review\n\n🔵 Suggestion: add JSDoc\n\nOverall: LGTM\n");
      writeFileSync(eval2, "# Backend Review\n\n🔵 Suggestion: add types\n\nOverall: LGTM — clean implementation\n");

      // ── Step 5: complete-tick T1.2 ──
      const complete2 = runHarness([
        "complete-tick", "--dir", tmp,
        "--unit", "T1.2",
        "--artifacts", `${eval1},${eval2}`,
        "--description", "review passed with minor suggestions",
        "--skip-scope-check",
      ], { cwd: tmp });
      assert.equal(complete2.completed, true, `Expected completed=true, got errors: ${JSON.stringify(complete2.errors)}`);
      assert.equal(complete2.tick, 2);
      assert.equal(complete2.next_unit, null);
      assert.equal(complete2.terminate, true);
      assert.equal(complete2.verdict, "PASS");

      // ── Step 6: next-tick → should terminate (pipeline_complete) ──
      const tick3 = runHarness(["next-tick", "--dir", tmp], { cwd: tmp });
      assert.equal(tick3.ready, false);
      assert.equal(tick3.terminate, true);
      assert.ok(tick3.reason, `tick3 has no reason, full result: ${JSON.stringify(tick3)}`);
      assert.ok(tick3.reason.includes("pipeline_complete") || tick3.reason.includes("already") || tick3.reason.includes("null"), `unexpected reason: ${tick3.reason}`);

      // Verify final state
      const finalState = JSON.parse(readFileSync(join(tmp, "loop-state.json"), "utf8"));
      assert.equal(finalState.status, "pipeline_complete");
      assert.equal(finalState.tick, 2);

      // Verify progress.md was written
      assert.ok(existsSync(join(tmp, "progress.md")));
      const progress = readFileSync(join(tmp, "progress.md"), "utf8");
      assert.ok(progress.includes("Tick 1"));
      assert.ok(progress.includes("Tick 2"));

    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});
