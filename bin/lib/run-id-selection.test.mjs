import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cmdSynthesize } from "./eval-commands.mjs";
import { buildCumulativeFindingsMarkdown } from "./cumulative-findings.mjs";
import { loadTestCommandSpec } from "./test-command-execution.mjs";
import { collectTestDesignPlanReasons } from "./test-plan-gate.mjs";
import { compareRunIds, parseRunOrdinal } from "./run-id.mjs";
import { cmdUxVerdict } from "./ux-verdict.mjs";

const TMPBASE = mkdtempSync(join(tmpdir(), "opc-run-id-selection-"));
const UXBASE = mkdtempSync(join(homedir(), ".opc", "sessions", "opc-run-id-selection-"));
after(() => {
  rmSync(TMPBASE, { recursive: true, force: true });
  rmSync(UXBASE, { recursive: true, force: true });
});

function runDir(session, node, runId) {
  const dir = join(session, "nodes", node, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function captureJson(fn) {
  const output = [];
  const original = console.log;
  console.log = (...args) => output.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return JSON.parse(output.at(-1));
}

function completeTestPlan() {
  return [
    "# Test Plan",
    "## Unit / Smoke",
    "node unit.mjs",
    "unit assertion one",
    "unit assertion two",
    "## Contract / Edge Case",
    "node contract.mjs",
    "boundary assertion one",
    "boundary assertion two",
    "## Integration / E2E Flow",
    "node integration.mjs",
    "workflow assertion one",
    "workflow assertion two",
    "## UI / Visual / A11y",
    "node visual.mjs",
    "accessibility assertion one",
    "accessibility assertion two",
    "## Tier Baseline / Polish",
    "node tier.mjs",
    "baseline assertion one",
    "baseline assertion two",
    "",
  ].join("\n");
}

describe("exact run_N selection", () => {
  test("run ordinals parse and compare without Number coercion", () => {
    assert.equal(parseRunOrdinal("run_9007199254740993"), 9007199254740993n);
    assert.equal(parseRunOrdinal("9007199254740992"), 9007199254740992n);
    assert.equal(parseRunOrdinal("run_bad"), null);
    assert.equal(compareRunIds("run_9007199254740992", "run_9007199254740993"), -1);
    assert.ok(compareRunIds("invalid-a", "invalid-b") < 0);
  });

  test("synthesize selects the exact latest run beyond MAX_SAFE_INTEGER", () => {
    const session = join(TMPBASE, "synthesize");
    const oldRun = runDir(session, "review", "run_9007199254740992");
    const newRun = runDir(session, "review", "run_9007199254740993");
    writeFileSync(join(oldRun, "eval-owner.md"), "# Review\n\nNo findings.\n");
    writeFileSync(join(newRun, "eval-owner.md"), "# Review\n\n[CRITICAL] src/new.mjs:1 — newest run finding\n");

    const result = captureJson(() => cmdSynthesize([session, "--node", "review"]));
    assert.equal(result.totals.critical, 1, JSON.stringify(result));
  });

  test("test command loading selects the exact latest run", () => {
    const session = join(TMPBASE, "test-command");
    const oldRun = runDir(session, "test-design", "run_9007199254740992");
    const newRun = runDir(session, "test-design", "run_9007199254740993");
    writeFileSync(join(oldRun, "handshake.json"), JSON.stringify({ testCommand: "node old.mjs" }));
    writeFileSync(join(newRun, "handshake.json"), JSON.stringify({ testCommand: "node new.mjs" }));

    assert.equal(loadTestCommandSpec(session, "test-design")?.testCommand, "node new.mjs");
  });

  test("test plan gate selects the exact latest run", () => {
    const session = join(TMPBASE, "test-plan");
    const oldRun = runDir(session, "test-design", "run_9007199254740992");
    const newRun = runDir(session, "test-design", "run_9007199254740993");
    writeFileSync(join(oldRun, "test-plan.md"), completeTestPlan());
    writeFileSync(join(newRun, "test-plan.md"), "# Test Plan\n\nNo executable cases yet.\n");

    const reasons = collectTestDesignPlanReasons(session, "test-design");
    assert.ok(reasons.some((reason) => reason.includes("missing layers")), reasons.join("\n"));
  });

  test("cumulative findings preserve exact numeric run order", () => {
    const session = join(TMPBASE, "cumulative");
    runDir(session, "review", "run_9007199254740993");
    runDir(session, "review", "run_9007199254740992");

    const markdown = buildCumulativeFindingsMarkdown(session, {
      entryNode: "review",
      currentNode: "review",
      history: [],
    });
    assert.ok(
      markdown.indexOf("run_9007199254740992") < markdown.indexOf("run_9007199254740993"),
      markdown,
    );
  });

  test("UX verdict reads the exact preceding run", () => {
    const session = join(UXBASE, "ux-verdict");
    const priorRunId = "run_9007199254740992";
    const currentRunId = "run_9007199254740993";
    const prior = runDir(session, "ux-simulation", priorRunId);
    const current = runDir(session, "ux-simulation", currentRunId);
    writeFileSync(join(session, "flow-state.json"), JSON.stringify({ tier: "polished" }));
    writeFileSync(join(prior, "ux-verdict.json"), JSON.stringify({
      verdict: "PASS",
      uxResult: { flagDetails: [], redFlags: { critical: 0, warning: 0, suggestion: 0 } },
    }));
    writeFileSync(join(current, "observer-new-user.md"), [
      "# Observer Report",
      "",
      "```json",
      JSON.stringify({
        persona: "new-user",
        tier: "polished",
        red_flags: [],
        trust_signals: { present: [], absent: [] },
        friction_points: [],
        tier_fit: "at-tier",
        reasoning: "I found the experience detailed, coherent, and trustworthy throughout the complete workflow.",
      }, null, 2),
      "```",
      "",
    ].join("\n"));

    const result = captureJson(() => cmdUxVerdict([
      "--dir", session,
      "--run", currentRunId.slice("run_".length),
    ]));
    assert.equal(result.uxResult.delta?.vs_run, priorRunId, JSON.stringify(result));
  });

  test("rubric convergence reads the two exact preceding runs", () => {
    const session = join(TMPBASE, "convergence");
    const node = "review";
    const current = runDir(session, node, "run_9007199254740993");
    const prior = runDir(session, node, "run_9007199254740992");
    const prior2 = runDir(session, node, "run_9007199254740991");
    const wrongPrior = runDir(session, node, "run_9007199254740990");
    for (const dir of [current, prior, prior2, wrongPrior]) {
      mkdirSync(join(dir, "ext-design-intelligence"), { recursive: true });
      writeFileSync(join(dir, "eval-owner.md"), "# Review\n\nNo findings.\n");
    }
    writeFileSync(join(current, "ext-design-intelligence", "rubric-verdict.json"), JSON.stringify({ final: 4.1, verdict: "PASS" }));
    writeFileSync(join(prior, "ext-design-intelligence", "rubric-verdict.json"), JSON.stringify({ final: 1.0, verdict: "FAIL" }));
    writeFileSync(join(prior2, "ext-design-intelligence", "rubric-verdict.json"), JSON.stringify({ final: 4.2, verdict: "PASS" }));
    writeFileSync(join(wrongPrior, "ext-design-intelligence", "rubric-verdict.json"), JSON.stringify({ final: 4.3, verdict: "PASS" }));

    const result = captureJson(() => cmdSynthesize([
      session,
      "--node", node,
      "--run", "9007199254740993",
    ]));
    assert.equal(result.convergenceWarning, undefined, JSON.stringify(result));
  });
});
