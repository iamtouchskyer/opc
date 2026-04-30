// audit.test.mjs — Tests for cmdAudit process conformance auditor
// Run: node --test bin/lib/audit.test.mjs

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

import { getProjectHash } from "./util.mjs";

// ── Helpers ─────────────────────────────────────────────────────

/** Run cmdAudit via node -e, returning { stdout, stderr, exitCode }. */
function runAudit(args) {
  const code = `
    import { cmdAudit } from "./bin/lib/audit.mjs";
    cmdAudit(${JSON.stringify(args)});
  `;
  const opcRoot = join(import.meta.dirname, "..", "..");
  try {
    const stdout = execFileSync("node", ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 10000,
      cwd: opcRoot,
      env: { ...process.env },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      exitCode: err.status ?? 1,
    };
  }
}

/** Create session dir structure under ~/.opc/sessions/{hash}/ and return { sessionsBase, sessionDir }. */
function createSessionDir(baseDir, sessionId) {
  const hash = getProjectHash(baseDir);
  const home = process.env.HOME || require("os").homedir();
  const sessionsBase = join(home, ".opc", "sessions", hash);
  const sessionDir = join(sessionsBase, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  return { sessionsBase, sessionDir };
}

/** Write a flow-state.json in sessionDir. */
function writeFlowState(sessionDir, overrides = {}) {
  const state = {
    status: "completed",
    flowTemplate: "standard",
    tier: "T2",
    totalSteps: 4,
    history: [],
    ...overrides,
  };
  writeFileSync(join(sessionDir, "flow-state.json"), JSON.stringify(state));
}

/** Create eval files under sessionDir/nodes/{nodeId}/run_{n}/eval-{role}.md */
function writeEvalFile(sessionDir, nodeId, runN, evalName, lines = 60) {
  const runDir = join(sessionDir, "nodes", nodeId, `run_${runN}`);
  mkdirSync(runDir, { recursive: true });
  const content = Array.from({ length: lines }, (_, i) => `Line ${i + 1}: eval content`).join("\n");
  writeFileSync(join(runDir, evalName), content);
}

// ── Tests ───────────────────────────────────────────────────────

describe("cmdAudit: no sessions", () => {
  let tmp;
  after(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  test("exits with code 1 and error message when no sessions exist", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-empty-"));
    const { stderr, exitCode } = runAudit(["--base", tmp]);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("No OPC sessions found"));
  });
});

describe("cmdAudit: single perfect session", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("all checks passing → conformance score = 1.0", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-perfect-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-perfect");
    sessionsBase = sb;

    writeFlowState(sessionDir, { status: "completed", history: [] });
    writeFileSync(join(sessionDir, "acceptance-criteria.md"), "# AC\n- criteria");

    // skeptic-owner eval + another role for diversity, both deep (>50 lines)
    writeEvalFile(sessionDir, "node1", 1, "eval-skeptic-owner.md", 60);
    writeEvalFile(sessionDir, "node1", 1, "eval-frontend.md", 60);

    const { stdout, exitCode } = runAudit(["--base", tmp, "--format", "json"]);
    assert.equal(exitCode, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions.length, 1);
    const s = out.sessions[0];
    assert.equal(s.checks.skeptic_owner_present, true);
    assert.equal(s.checks.role_diversity, 1);
    assert.equal(s.checks.eval_depth, 1);
    assert.equal(s.checks.no_manual_bypass, true);
    assert.equal(s.checks.acceptance_criteria_exists, true);
    assert.equal(s.checks.flow_completed, true);
    assert.equal(s.conformance_score, 1);
  });
});

describe("cmdAudit: manual bypass detection", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("history entry with skipped:true → no_manual_bypass = false", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-bypass-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-bypass");
    sessionsBase = sb;

    writeFlowState(sessionDir, {
      status: "completed",
      history: [{ step: "review", skipped: true }],
    });
    writeEvalFile(sessionDir, "node1", 1, "eval-skeptic-owner.md", 60);
    writeEvalFile(sessionDir, "node1", 1, "eval-frontend.md", 60);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions[0].checks.no_manual_bypass, false);
  });

  test("history entry with forcePassed:true → no_manual_bypass = false", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-force-"));
    const { sessionDir, sessionsBase: sb2 } = createSessionDir(tmp, "sess-force");
    // sessionsBase already points to the same hash dir
    sessionsBase = sb2;

    writeFlowState(sessionDir, {
      status: "completed",
      history: [{ step: "review", forcePassed: true }],
    });

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions[0].checks.no_manual_bypass, false);
  });
});

describe("cmdAudit: --format json", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("outputs valid JSON with sessions[] and aggregate{}", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-json-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-json");
    sessionsBase = sb;

    writeFlowState(sessionDir);
    writeEvalFile(sessionDir, "node1", 1, "eval.md", 60);

    const { stdout, exitCode } = runAudit(["--base", tmp, "--format", "json"]);
    assert.equal(exitCode, 0);
    const out = JSON.parse(stdout);
    assert.ok(Array.isArray(out.sessions));
    assert.ok(typeof out.aggregate === "object");
    assert.ok("total_sessions" in out.aggregate);
    assert.ok("avg_conformance" in out.aggregate);
    assert.ok("worst_check" in out.aggregate);
    assert.ok("trend" in out.aggregate);
  });
});

describe("cmdAudit: --format table (default)", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("outputs table with header and session rows", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-table-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-table");
    sessionsBase = sb;

    writeFlowState(sessionDir);

    const { stdout, exitCode } = runAudit(["--base", tmp]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("OPC Process Conformance Audit"));
    assert.ok(stdout.includes("Session"));
    assert.ok(stdout.includes("sess-table"));
    assert.ok(stdout.includes("Avg conformance"));
  });
});

describe("cmdAudit: --last N", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("only returns last N sessions", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-last-"));
    // Create 3 sessions
    for (const id of ["sess-a", "sess-b", "sess-c"]) {
      const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, id);
      sessionsBase = sb;
      writeFlowState(sessionDir);
    }

    const { stdout } = runAudit(["--base", tmp, "--format", "json", "--last", "2"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions.length, 2);
    assert.equal(out.aggregate.total_sessions, 2);
  });
});

describe("cmdAudit: thin evals", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("eval with < 50 lines → eval_depth ratio reflects thin count", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-thin-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-thin");
    sessionsBase = sb;

    writeFlowState(sessionDir);
    // 1 deep (60 lines), 1 thin (10 lines)
    writeEvalFile(sessionDir, "node1", 1, "eval-skeptic-owner.md", 60);
    writeEvalFile(sessionDir, "node1", 1, "eval-frontend.md", 10);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions[0].checks.eval_depth, 0.5);
  });

  test("all thin evals → eval_depth = 0", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-allthin-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-allthin");
    sessionsBase = sb;

    writeFlowState(sessionDir);
    writeEvalFile(sessionDir, "node1", 1, "eval.md", 10);
    writeEvalFile(sessionDir, "node1", 1, "eval-backend.md", 5);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions[0].checks.eval_depth, 0);
  });
});

describe("cmdAudit: missing skeptic-owner eval", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("no skeptic-owner or devil-advocate eval → skeptic_owner_present = false", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-noskeptic-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-noskeptic");
    sessionsBase = sb;

    writeFlowState(sessionDir);
    writeEvalFile(sessionDir, "node1", 1, "eval-frontend.md", 60);
    writeEvalFile(sessionDir, "node1", 1, "eval-backend.md", 60);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions[0].checks.skeptic_owner_present, false);
  });
});

describe("cmdAudit: corrupt flow-state.json", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("corrupt JSON → session is skipped gracefully", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-corrupt-"));
    const hash = getProjectHash(tmp);
    const home = process.env.HOME;
    sessionsBase = join(home, ".opc", "sessions", hash);

    // Create corrupt session
    const corruptDir = join(sessionsBase, "sess-corrupt");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "flow-state.json"), "NOT VALID JSON{{{");

    // Create valid session
    const validDir = join(sessionsBase, "sess-valid");
    mkdirSync(validDir, { recursive: true });
    writeFlowState(validDir);

    const { stdout, exitCode } = runAudit(["--base", tmp, "--format", "json"]);
    assert.equal(exitCode, 0);
    const out = JSON.parse(stdout);
    // Only valid session should appear
    assert.equal(out.sessions.length, 1);
    assert.equal(out.sessions[0].id, "sess-valid");
  });
});

describe("cmdAudit: multiple sessions aggregate", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("avg_conformance computed correctly across sessions", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-multi-"));

    // Session 1: perfect (conformance 1.0)
    const s1 = createSessionDir(tmp, "sess-perfect2");
    sessionsBase = s1.sessionsBase;
    writeFlowState(s1.sessionDir, { status: "completed", history: [] });
    writeFileSync(join(s1.sessionDir, "acceptance-criteria.md"), "# AC");
    writeEvalFile(s1.sessionDir, "node1", 1, "eval-skeptic-owner.md", 60);
    writeEvalFile(s1.sessionDir, "node1", 1, "eval-frontend.md", 60);

    // Session 2: some failures (no AC, no skeptic-owner, not completed)
    const s2 = createSessionDir(tmp, "sess-poor");
    writeFlowState(s2.sessionDir, { status: "in_progress", history: [] });
    writeEvalFile(s2.sessionDir, "node1", 1, "eval-frontend.md", 60);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.aggregate.total_sessions, 2);
    assert.ok(typeof out.aggregate.avg_conformance === "number");
    // Perfect session = 1.0, poor session has several failures, avg should be between 0 and 1
    assert.ok(out.aggregate.avg_conformance > 0);
    assert.ok(out.aggregate.avg_conformance < 1);
  });
});

describe("cmdAudit: 'latest' directory is skipped", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("directory named 'latest' is not scanned as a session", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-latest-"));
    const hash = getProjectHash(tmp);
    const home = process.env.HOME;
    sessionsBase = join(home, ".opc", "sessions", hash);

    // Create 'latest' dir with flow-state
    const latestDir = join(sessionsBase, "latest");
    mkdirSync(latestDir, { recursive: true });
    writeFlowState(latestDir);

    // Create one real session
    const realDir = join(sessionsBase, "sess-real");
    mkdirSync(realDir, { recursive: true });
    writeFlowState(realDir);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions.length, 1);
    assert.equal(out.sessions[0].id, "sess-real");
  });
});

describe("cmdAudit: extractRoleName logic", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("eval.md → evaluator role", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-role1-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-role1");
    sessionsBase = sb;

    writeFlowState(sessionDir);
    writeEvalFile(sessionDir, "node1", 1, "eval.md", 60);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    // eval.md → evaluator; only 1 role so diversity = 0 (0/1 nodes have ≥2)
    // But skeptic_owner_present should be false (evaluator is not skeptic-owner)
    assert.equal(out.sessions[0].checks.skeptic_owner_present, false);
  });

  test("eval-frontend.md → frontend, eval-skeptic-owner.md → skeptic-owner", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-role2-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-role2");
    sessionsBase = sb;

    writeFlowState(sessionDir);
    writeEvalFile(sessionDir, "node1", 1, "eval-frontend.md", 60);
    writeEvalFile(sessionDir, "node1", 1, "eval-skeptic-owner.md", 60);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions[0].checks.skeptic_owner_present, true);
    // 2 roles in same node → diversity = 1.0
    assert.equal(out.sessions[0].checks.role_diversity, 1);
  });
});

describe("cmdAudit: devil-advocate counts as skeptic-owner", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("eval-devil-advocate.md satisfies skeptic_owner_present", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-devil-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-devil");
    sessionsBase = sb;

    writeFlowState(sessionDir);
    writeEvalFile(sessionDir, "node1", 1, "eval-devil-advocate.md", 60);
    writeEvalFile(sessionDir, "node1", 1, "eval-frontend.md", 60);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions[0].checks.skeptic_owner_present, true);
  });
});

describe("cmdAudit: role diversity", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("single eval per node → diversity = 0", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-div0-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-div0");
    sessionsBase = sb;

    writeFlowState(sessionDir);
    writeEvalFile(sessionDir, "node1", 1, "eval.md", 60);
    writeEvalFile(sessionDir, "node2", 1, "eval-backend.md", 60);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    // Each node has only 1 role → 0 nodes with ≥2 → diversity = 0
    assert.equal(out.sessions[0].checks.role_diversity, 0);
  });

  test("mixed nodes: one diverse, one not → diversity = 0.5", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-div50-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-div50");
    sessionsBase = sb;

    writeFlowState(sessionDir);
    // node1: 2 roles
    writeEvalFile(sessionDir, "node1", 1, "eval-frontend.md", 60);
    writeEvalFile(sessionDir, "node1", 1, "eval-backend.md", 60);
    // node2: 1 role
    writeEvalFile(sessionDir, "node2", 1, "eval.md", 60);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions[0].checks.role_diversity, 0.5);
  });
});

describe("cmdAudit: no eval files", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("no evals → skeptic_owner_present=false, role_diversity=null, eval_depth=null", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-noeval-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-noeval");
    sessionsBase = sb;

    writeFlowState(sessionDir);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    const c = out.sessions[0].checks;
    assert.equal(c.skeptic_owner_present, false);
    assert.equal(c.role_diversity, null);
    assert.equal(c.eval_depth, null);
  });
});

describe("cmdAudit: flow_completed check", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("status 'finalized' counts as completed", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-finalized-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-fin");
    sessionsBase = sb;

    writeFlowState(sessionDir, { status: "finalized" });

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions[0].checks.flow_completed, true);
  });

  test("status 'in_progress' → flow_completed = false", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-inprog-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-inprog");
    sessionsBase = sb;

    writeFlowState(sessionDir, { status: "in_progress" });

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions[0].checks.flow_completed, false);
  });
});

describe("cmdAudit: missing acceptance-criteria.md", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("no acceptance-criteria.md → acceptance_criteria_exists = false", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-noac-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-noac");
    sessionsBase = sb;

    writeFlowState(sessionDir);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions[0].checks.acceptance_criteria_exists, false);
  });
});

describe("cmdAudit: worst_check identification", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("worst_check reflects the most frequently failing check", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-worst-"));

    // Session 1: missing AC only
    const s1 = createSessionDir(tmp, "sess-w1");
    sessionsBase = s1.sessionsBase;
    writeFlowState(s1.sessionDir, { status: "completed", history: [] });
    writeEvalFile(s1.sessionDir, "node1", 1, "eval-skeptic-owner.md", 60);
    writeEvalFile(s1.sessionDir, "node1", 1, "eval-frontend.md", 60);

    // Session 2: also missing AC
    const s2 = createSessionDir(tmp, "sess-w2");
    writeFlowState(s2.sessionDir, { status: "completed", history: [] });
    writeEvalFile(s2.sessionDir, "node1", 1, "eval-skeptic-owner.md", 60);
    writeEvalFile(s2.sessionDir, "node1", 1, "eval-frontend.md", 60);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.aggregate.worst_check, "acceptance_criteria_exists");
    assert.equal(out.aggregate.worst_check_fail_count, 2);
  });
});

describe("cmdAudit: scorecard fields", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("scorecard includes id, flow, tier, timestamp, totalSteps, evalFileCount", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-fields-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-fields");
    sessionsBase = sb;

    writeFlowState(sessionDir, {
      flowTemplate: "custom-flow",
      tier: "T3",
      totalSteps: 7,
    });
    writeEvalFile(sessionDir, "node1", 1, "eval.md", 60);

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    const s = out.sessions[0];
    assert.equal(s.id, "sess-fields");
    assert.equal(s.flow, "custom-flow");
    assert.equal(s.tier, "T3");
    assert.ok(s.timestamp);
    assert.equal(s.totalSteps, 7);
    assert.equal(s.evalFileCount, 1);
  });
});

describe("cmdAudit: no history array", () => {
  let tmp, sessionsBase;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (sessionsBase) rmSync(sessionsBase, { recursive: true, force: true });
  });

  test("missing history array → no_manual_bypass = true", () => {
    tmp = mkdtempSync(join(tmpdir(), "audit-nohist-"));
    const { sessionDir, sessionsBase: sb } = createSessionDir(tmp, "sess-nohist");
    sessionsBase = sb;

    // flow-state without history field
    const state = { status: "completed", flowTemplate: "standard" };
    writeFileSync(join(sessionDir, "flow-state.json"), JSON.stringify(state));

    const { stdout } = runAudit(["--base", tmp, "--format", "json"]);
    const out = JSON.parse(stdout);
    assert.equal(out.sessions[0].checks.no_manual_bypass, true);
  });
});
