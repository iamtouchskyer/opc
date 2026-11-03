import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createMission, validateContract, missionTrigger, applyMissionDecision, allowedMissionActions } from "../bin/lib/mission-gate.mjs";
import { missionFinalizationError } from "../bin/lib/mission-evidence.mjs";
import { evaluateFlowBudget } from "../bin/lib/flow-budget.mjs";

const harness = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/opc-harness.mjs");
const contract = () => ({ schemaVersion: 1, goal: "Deliver an observable result", outcomes: [{ id: "O1", description: "Result is supported by evidence" }], nonGoals: ["No deployment"], appetite: { maxRepairCycles: 8, maxMinutes: 60 } });
const template = { opc_compat: ">=0.10.0", nodes: ["work", "finish", "repair"], nodeTypes: { work: "build", finish: "build", repair: "build" }, edges: { work: { PASS: "finish" }, finish: { PASS: null, FAIL: "repair", ITERATE: "repair" }, repair: { PASS: "finish" } }, limits: { maxTotalSteps: 30, maxLoopsPerEdge: 6, maxNodeReentry: 10 } };
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const read = path => JSON.parse(readFileSync(path, "utf8"));

// Each CLI test owns a real Git repository, isolated HOME, config and identity.
// No inherited OPC options, extension registry, credentials, or Git settings.
function fixture(t, options = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "opc-mission-lite-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "project");
  const home = join(base, "home");
  const dir = join(root, ".harness");
  for (const path of [root, home, dir]) mkdirSync(path);
  const env = { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Mission Test", GIT_AUTHOR_EMAIL: "mission-test@example.invalid", GIT_COMMITTER_NAME: "Mission Test", GIT_COMMITTER_EMAIL: "mission-test@example.invalid" };
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  writeFileSync(join(root, "app.js"), "export const result = 1;\n");
  git("add", "app.js");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const flow = join(base, "mission-test-flow.json");
  const contractPath = join(base, "contract.json");
  json(flow, options.template ?? template);
  json(contractPath, options.contract ?? contract());
  const f = { base, root, dir, env, git, flow, contractPath, statePath: join(dir, "flow-state.json") };
  f.cli = (args, nodeArgs = []) => {
    const result = spawnSync(process.execPath, [...nodeArgs, harness, ...args, "--dir", dir], { cwd: root, env, encoding: "utf8", timeout: 20000 });
    assert.ifError(result.error);
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    assert.ok(lines.length, `${args.join(" ")}: missing JSON output: ${result.stderr}`);
    let data;
    try { data = JSON.parse(lines.at(-1)); } catch { assert.fail(`Invalid CLI JSON: ${result.stdout}\n${result.stderr}`); }
    return { ...result, data };
  };
  f.call = (...args) => f.cli(args).data;
  f.state = () => read(f.statePath);
  f.bytes = () => readFileSync(f.statePath, "utf8");
  // Explicit state fixture, not an end-to-end traversal. Used only for exact boundaries.
  f.progress = change => { const state = f.state(); change(state); json(f.statePath, state); };
  f.init = (extra = []) => f.call("init", ...(options.builtin ? ["--flow", options.builtin] : ["--flow-file", flow]), ...(options.mission === false ? [] : ["--mission", contractPath]), ...extra);
  if (options.init !== false) assert.equal(f.init().created, true);
  f.status = (verdict = "CHECK") => f.call("mission", "status", "--verdict", verdict);
  f.review = (packet, fields = {}) => ({ binding: packet.binding, reviewer: { id: "fixture-cold-reviewer", contextMode: "cold" }, ...fields });
  f.submit = (action, review, verdict = "CHECK", nodeArgs = []) => {
    const reviewPath = join(dir, "review-input.json");
    json(reviewPath, review);
    return f.cli(["mission", action, "--verdict", verdict, "--review", reviewPath], nodeArgs);
  };
  f.evidence = join(dir, "outcome.txt");
  writeFileSync(f.evidence, "Fixture evidence: observed output is 1.\n");
  f.receipts = () => {
    const before = f.bytes();
    const result = f.call("mission", "evidence", "--file", f.evidence);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].path, f.evidence);
    assert.match(result.evidence[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(f.bytes(), before, "evidence receipts are read-only");
    return result.evidence;
  };
  f.accept = () => f.submit("accept", f.review(f.status("PASS"), { outcomes: [{ id: "O1", status: "PASS", reason: "Observed fixture output", evidence: f.receipts() }] }), "PASS").data;
  return f;
}

// Agent artifacts are fixtures; init, seal, route, transition and finalize are real CLI calls.
function sealCurrent(f) {
  const state = f.state();
  const runId = state.history.filter(entry => entry.nodeId === state.currentNode).at(-1)?.runId ?? "run_1";
  const path = join(f.dir, "nodes", state.currentNode, runId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "result.js"), "export const result = 1;\n");
  const result = f.call("seal", "--node", state.currentNode);
  assert.equal(result.sealed, true, JSON.stringify(result));
}

function transition(f, from, to, verdict) {
  return f.call("transition", "--from", from, "--to", String(to), "--verdict", verdict);
}

function atFinish(t, options = {}) {
  const f = fixture(t, options);
  sealCurrent(f);
  const result = transition(f, "work", "finish", "PASS");
  assert.equal(result.allowed, true, JSON.stringify(result));
  sealCurrent(f);
  return f;
}

function rejectedUnchanged(f, action, pattern) {
  const before = f.bytes();
  const data = action();
  assert.ok(data.ok === false || data.created === false || data.initialized === false || data.valid === false || data.allowed === false || data.finalized === false || data.error, JSON.stringify(data));
  if (pattern) assert.match(JSON.stringify(data), pattern);
  assert.equal(f.bytes(), before, "rejection must preserve persisted state bytes");
  return data;
}

test("A01/A02: ordinary and Mission CLI flows initialize, route, transition and finalize", async t => {
  for (const mission of [false, true]) await t.test(`mission=${mission}`, t => {
    const f = fixture(t, { mission });
    assert.equal(Object.hasOwn(f.state(), "mission"), mission);
    assert.equal(f.status().enabled, mission);
    assert.deepEqual(f.call("route", "--node", "work", "--verdict", "PASS"), { next: "finish", valid: true });
    sealCurrent(f);
    assert.equal(transition(f, "work", "finish", "PASS").allowed, true);
    sealCurrent(f);
    if (mission) {
      rejectedUnchanged(f, () => f.call("finalize"), /outcome review is missing/);
      assert.equal(f.accept().ok, true);
    }
    assert.equal(f.call("finalize").finalized, true);
    assert.equal(f.state().status, "completed");
    const repeated = f.call("finalize");
    assert.equal(repeated.finalized, true);
    assert.equal(repeated.note, "already finalized");
  });
  await t.test("build-verify composes with Mission and returns budgets", t => {
    const f = fixture(t, { init: false, builtin: "build-verify" });
    const result = f.init();
    assert.equal(result.created, true);
    assert.equal(result.flow, "build-verify");
    assert.deepEqual(result.mission, { enabled: true, mode: "single-flow", appetite: contract().appetite });
    assert.equal(f.state().currentNode, "brief");
  });
});

test("A03: malformed contracts and missing flag values cannot create or overwrite a session", t => {
  const f = fixture(t, { init: false });
  const invalid = [null, {}, { ...contract(), schemaVersion: 2 }, { ...contract(), goal: " " }, { ...contract(), outcomes: [] }, { ...contract(), outcomes: [{ id: "O1", description: " " }] }, { ...contract(), outcomes: [contract().outcomes[0], contract().outcomes[0]] }, { ...contract(), nonGoals: [""] }, { ...contract(), legacy: true }, ...[0, -1, 1.5].map(maxRepairCycles => ({ ...contract(), appetite: { maxRepairCycles, maxMinutes: 1 } })), ...[0, -1, "10"].map(maxMinutes => ({ ...contract(), appetite: { maxRepairCycles: 1, maxMinutes } }))];
  for (const value of invalid) {
    assert.throws(() => validateContract(value));
    json(f.contractPath, value);
    assert.equal(f.init().created, false);
    assert.equal(existsSync(f.statePath), false);
  }
  writeFileSync(f.contractPath, "{broken");
  assert.equal(f.init().created, false);
  assert.equal(f.call("init", "--flow", "build-verify", "--mission").created, false);
  json(f.contractPath, contract());
  assert.equal(f.init().created, true);
  rejectedUnchanged(f, () => f.init(["--force"]), /cannot be overwritten/);
  rejectedUnchanged(f, () => f.call("init", "--flow", "build-verify", "--force"), /cannot be overwritten/);
});

test("A04/A07: real CLI first repair succeeds; repeated edge pauses and gets only one exact retry", t => {
  const f = atFinish(t);
  assert.equal(transition(f, "finish", "repair", "FAIL").allowed, true);
  sealCurrent(f);
  assert.equal(transition(f, "repair", "finish", "PASS").allowed, true);
  sealCurrent(f);
  const before = f.bytes();
  rejectedUnchanged(f, () => f.call("mission", "status", "--from", "work", "--verdict", "PASS"), /current node/);
  rejectedUnchanged(f, () => f.call("mission", "status", "--verdict", "FAIL", "--to", "work"), /edge/);
  const packet = f.status("FAIL");
  assert.equal(packet.trigger.code, "MISSION_REPEATED_REPAIR");
  assert.equal(f.status("FAIL").binding, packet.binding);
  assert.equal(f.bytes(), before);
  rejectedUnchanged(f, () => transition(f, "finish", "repair", "FAIL"), /MISSION_REPEATED_REPAIR/);
  const review = f.review(packet, { action: "CONTINUE_CURRENT", classification: "ARTIFACT", reason: "New fixture evidence supports one repair", evidence: f.receipts() });
  assert.equal(f.submit("decide", review, "FAIL").data.ok, true);
  assert.equal(f.call("route", "--node", "finish", "--verdict", "FAIL").valid, true);
  assert.equal(f.state().repairEdgeCounts["finish→repair"], 1);
  rejectedUnchanged(f, () => transition(f, "finish", "repair", "ITERATE"), /MISSION_EDGE_MISMATCH/);
  assert.equal(transition(f, "finish", "repair", "FAIL").allowed, true);
  assert.equal(f.state().repairEdgeCounts["finish→repair"], 2);
  sealCurrent(f);
  assert.equal(transition(f, "repair", "finish", "PASS").allowed, true);
  sealCurrent(f);
  rejectedUnchanged(f, () => f.submit("decide", review, "FAIL").data, /stale/);
  assert.ok(!f.status("FAIL").allowedActions.includes("CONTINUE_CURRENT"));
  assert.ok(!f.status("FAIL").allowedActions.includes("RESHAPE_SMALLER"));
  rejectedUnchanged(f, () => transition(f, "finish", "repair", "FAIL"), /MISSION_REPEATED_REPAIR/);
});

test("A05/A07: pure policy binds grants to edge/step; both Mission and original budgets win", () => {
  const state = { ...template.limits, totalSteps: 1, currentNode: "finish", history: [{ nodeId: "finish", runId: "run_1" }], edgeCounts: {}, repairEdgeCounts: {}, mission: createMission(contract()) };
  state.repairEdgeCounts["finish→repair"] = 1;
  const edge = { from: "finish", to: "repair", verdict: "FAIL" };
  const packet = { edge, trigger: missionTrigger({ state, ...edge }), binding: "pure-fixture" };
  applyMissionDecision(state, packet, { action: "CONTINUE_CURRENT", classification: "ARTIFACT", reason: "One bounded attempt", evidence: [], reviewer: { id: "pure" } });
  assert.equal(missionTrigger({ state, ...edge }), null);
  assert.equal(missionTrigger({ state, ...edge, verdict: "ITERATE" }).code, "MISSION_EDGE_MISMATCH");
  assert.equal(missionTrigger({ state, from: "finish", to: null, verdict: "PASS" }).code, "MISSION_EDGE_MISMATCH", "an approved repair cannot be swapped for a terminal PASS");
  state.totalSteps++;
  assert.equal(missionTrigger({ state, ...edge }).code, "MISSION_REPEATED_REPAIR");
  state.totalSteps--;
  state.maxLoopsPerEdge = 1;
  assert.match(evaluateFlowBudget({ state, template, ...edge }).reason, /maxLoopsPerEdge/);
  state.maxLoopsPerEdge = 6;
  state.maxNodeReentry = 1;
  state.history.push({ nodeId: "repair", runId: "run_1" });
  assert.match(evaluateFlowBudget({ state, template, ...edge }).reason, /maxNodeReentry/);
  state.maxNodeReentry = 10;
  state.maxTotalSteps = state.totalSteps;
  assert.match(evaluateFlowBudget({ state, template, ...edge }).reason, /maxTotalSteps/);
  state.maxTotalSteps = 30;
  state.mission.contract.appetite.maxRepairCycles = 1;
  for (const verdict of ["FAIL", "ITERATE"]) assert.equal(missionTrigger({ state, ...edge, verdict }).code, "MISSION_REPAIR_LIMIT", verdict);
  state.totalSteps++; // The allowed repair has completed; its one-shot grant no longer applies.
  for (const verdict of ["PASS", "CHECK"]) assert.equal(missionTrigger({ state, ...edge, verdict }), null, "the last permitted repair may still succeed");
  assert.deepEqual(allowedMissionActions(state, { hard: true }), ["HUMAN_REBET", "STOP_SALVAGE"]);
  state.mission.contract.appetite.maxRepairCycles = 8;
  const start = state.mission.startedAt;
  assert.equal(missionTrigger({ state, ...edge, now: start - 1 }).code, "MISSION_TIME_LIMIT");
  assert.equal(missionTrigger({ state, ...edge, now: start + 3600000 }).code, "MISSION_TIME_LIMIT");
});

test("A05: existing Claude auto repair ceiling never advertises a Mission retry", () => {
  const state = { totalSteps: 4, currentNode: "finish", repairEdgeCounts: { "finish→repair": 1 },
    autoMode: true, autoRepairCounts: { "finish→repair": 1 }, mission: createMission(contract()) };
  const trigger = missionTrigger({ state, from: "finish", to: "repair", verdict: "FAIL" });
  assert.equal(trigger.code, "LEGACY_AUTO_REPAIR_LIMIT");
  assert.deepEqual(allowedMissionActions(state, trigger), ["HUMAN_REBET", "STOP_SALVAGE"]);
});

test("A05: repair budget blocks another repair; time budget also blocks successful completion", async t => {
  for (const budget of ["repairs", "time"]) await t.test(budget, t => {
    const limited = contract();
    limited.appetite.maxRepairCycles = 2;
    const f = atFinish(t, { contract: limited });
    assert.equal(f.accept().ok, true);
    if (budget === "repairs") f.progress(state => { state.repairEdgeCounts["finish→repair"] = 2; });
    else {
      // Advance the child process clock after valid acceptance without invalidating its binding.
      const clock = join(f.base, "expired-clock.cjs");
      writeFileSync(clock, `Date.now = () => ${f.state().mission.startedAt + 3600001};\n`);
      const cli = f.cli;
      f.cli = (args, nodeArgs = []) => cli(args, ["--require", clock, ...nodeArgs]);
    }
    const code = budget === "repairs" ? /MISSION_REPAIR_LIMIT/ : /MISSION_TIME_LIMIT/;
    if (budget === "time") {
      rejectedUnchanged(f, () => f.call("route", "--node", "finish", "--verdict", "PASS"), code);
      rejectedUnchanged(f, () => transition(f, "finish", null, "PASS"), code);
    } else assert.equal(f.call("route", "--node", "finish", "--verdict", "PASS").valid, true);
    rejectedUnchanged(f, () => transition(f, "finish", "repair", "FAIL"), /LIMIT/);
    for (const action of ["pass", "skip", "goto"]) rejectedUnchanged(f, () => f.call(action, "work", "--reason", "fixture"), /Mission does not allow/);
    const packet = f.status("FAIL");
    assert.equal(packet.trigger.hard, true);
    rejectedUnchanged(f, () => f.submit("decide", f.review(packet, { action: "CONTINUE_CURRENT", classification: "ARTIFACT", reason: "Cannot expand budget", evidence: f.receipts() }), "FAIL").data, /not allowed|exhausted/);
    if (budget === "time") {
      rejectedUnchanged(f, () => f.accept(), /unblocked/);
      rejectedUnchanged(f, () => f.call("finalize"), /Mission/);
      assert.notEqual(f.state().status, "completed");
    } else {
      assert.equal(f.accept().ok, true);
      assert.equal(f.call("finalize").finalized, true, "the last permitted repair may complete with valid evidence");
    }
  });
});

test("A06/A07: explicit signals validate reviews; RECON is diagnostic and available once", async t => {
  for (const classification of ["PLAN", "ENVIRONMENT", "GOAL_SPEC"]) await t.test(classification, t => {
    const f = fixture(t);
    rejectedUnchanged(f, () => f.call("mission", "pause", "--class", "UNKNOWN", "--reason", "fixture"), /pause requires/);
    rejectedUnchanged(f, () => f.call("mission", "pause", "--class", classification), /pause requires/);
    assert.equal(f.call("mission", "pause", "--class", classification, "--reason", "Changed assumption").ok, true);
    assert.equal(f.status().trigger.classification, classification);
    rejectedUnchanged(f, () => f.call("route", "--node", "work", "--verdict", "PASS"), /MISSION_SIGNAL/);
    const packet = f.status();
    const review = f.review(packet, { action: "STOP_SALVAGE", classification, reason: "Preserve evidence", evidence: f.receipts() });
    for (const change of [{ classification: "UNKNOWN" }, { reason: " " }, { evidence: [] }, { evidence: [f.evidence] }, { reviewer: { id: "same-context", contextMode: "warm" } }, { binding: "old" }]) rejectedUnchanged(f, () => f.submit("decide", { ...review, ...change }).data);
    if (classification === "GOAL_SPEC") assert.deepEqual(packet.allowedActions, ["HUMAN_REBET", "STOP_SALVAGE"]);
    else {
      const recon = f.review(packet, { action: "RECON", classification: "ENVIRONMENT", reason: "Read environment evidence", evidence: f.receipts() });
      assert.equal(f.submit("decide", recon).data.ok, true);
      assert.equal(f.state().totalSteps, 0);
      assert.equal(f.status().trigger.code, "MISSION_SIGNAL");
      rejectedUnchanged(f, () => f.call("route", "--node", "work", "--verdict", "PASS"), /MISSION_SIGNAL/);
      rejectedUnchanged(f, () => f.submit("decide", { ...recon, binding: f.status().binding }).data, /not allowed|exhausted/);
    }
  });
});

test("A06/A07: continuation requires an actual edge; RESHAPE_SMALLER consumes the shared one-shot", t => {
  const f = fixture(t);
  sealCurrent(f);
  assert.equal(f.call("mission", "pause", "--class", "PLAN", "--reason", "Reassess the plan").ok, true);
  for (const [action, classification] of [["CONTINUE_CURRENT", "ARTIFACT"], ["RESHAPE_SMALLER", "PLAN"]]) {
    rejectedUnchanged(f, () => f.submit("decide", f.review(f.status(), { action, classification, reason: "Needs an exact edge", evidence: f.receipts() })).data, /edge|CHECK/);
  }
  const packet = f.status("PASS");
  const review = f.review(packet, { action: "RESHAPE_SMALLER", classification: "PLAN", reason: "Use a smaller plan on this edge", evidence: f.receipts() });
  rejectedUnchanged(f, () => f.submit("decide", { ...review, classification: "ARTIFACT" }, "PASS").data, /classification/);
  assert.equal(f.submit("decide", review, "PASS").data.ok, true);
  assert.equal(transition(f, "work", "finish", "PASS").allowed, true);
  assert.equal(f.call("mission", "pause", "--class", "PLAN", "--reason", "Another plan change").ok, true);
  assert.ok(!f.status("FAIL").allowedActions.includes("CONTINUE_CURRENT"));
  rejectedUnchanged(f, () => f.submit("decide", { ...review, binding: f.status("FAIL").binding }, "FAIL").data, /not allowed|exhausted/);
});

test("A08: HUMAN_REBET remains paused and STOP preserves work without changing contract", async t => {
  for (const action of ["HUMAN_REBET", "STOP_SALVAGE"]) await t.test(action, t => {
    const f = fixture(t);
    const frozen = JSON.stringify(f.state().mission.contract);
    const evidence = readFileSync(f.evidence, "utf8");
    assert.equal(f.call("mission", "pause", "--class", "PLAN", "--reason", "Scope needs a decision").ok, true);
    const review = f.review(f.status(), { action, classification: "PLAN", reason: "Preserve current work", evidence: f.receipts() });
    assert.equal(f.submit("decide", review).data.ok, true);
    assert.equal(JSON.stringify(f.state().mission.contract), frozen);
    assert.equal(readFileSync(f.evidence, "utf8"), evidence);
    assert.notEqual(f.state().status, "completed");
    if (action === "STOP_SALVAGE") {
      assert.equal(f.state().status, "stopped");
      rejectedUnchanged(f, () => f.call("mission", "pause", "--class", "PLAN", "--reason", "resume"), /terminal/);
    } else assert.equal(f.status().trigger.code, "MISSION_HUMAN_REBET");
    rejectedUnchanged(f, () => transition(f, "work", "finish", "PASS"), /stopped|MISSION_HUMAN_REBET/);
    rejectedUnchanged(f, () => f.call("finalize"), /stopped|Mission/);
  });
});

test("A09: terminal outcome requires each PASS, a cold reviewer, and nonempty in-scope evidence", t => {
  const f = atFinish(t);
  const packet = f.status("PASS");
  const outcome = { id: "O1", status: "PASS", reason: "Observed output", evidence: f.receipts() };
  writeFileSync(join(f.dir, "empty.txt"), "");
  writeFileSync(join(f.base, "outside.txt"), "outside");
  symlinkSync(join(f.base, "outside.txt"), join(f.dir, "escape.txt"));
  for (const path of ["missing.txt", "empty.txt", "escape.txt", "flow-state.json", f.dir]) rejectedUnchanged(f, () => f.call("mission", "evidence", "--file", path));
  for (const outcomes of [[], [{ ...outcome, id: "O2" }], [outcome, outcome], [{ ...outcome, status: "FAIL" }], [{ ...outcome, reason: "" }], ...[[], [f.evidence], [{ path: f.evidence }], [{ path: f.evidence, sha256: "0".repeat(64) }], ...["missing.txt", "empty.txt", "escape.txt", "flow-state.json", f.dir].map(path => [{ path, sha256: "0".repeat(64) }])].map(evidence => [{ ...outcome, evidence }])]) {
    rejectedUnchanged(f, () => f.submit("accept", f.review(packet, { outcomes }), "PASS").data);
  }
  rejectedUnchanged(f, () => f.call("mission", "accept", "--verdict", "PASS"), /review file/);
  assert.equal(f.accept().ok, true);
  assert.equal(missionFinalizationError(f.state(), f.dir), null);
});

test("A09: old review or acceptance becomes stale after Git, evidence or progress changes", async t => {
  for (const kind of ["tracked file", "untracked file", "HEAD", "node evidence", "outcome evidence", "progress"]) await t.test(kind, t => {
    const f = atFinish(t);
    const old = f.review(f.status("PASS"), { outcomes: [{ id: "O1", status: "PASS", reason: "Old observation", evidence: f.receipts() }] });
    assert.equal(f.accept().ok, true);
    if (kind === "tracked file") writeFileSync(join(f.root, "app.js"), "changed\n");
    if (kind === "untracked file") writeFileSync(join(f.root, "new.js"), "new\n");
    if (kind === "HEAD") f.git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "new head");
    if (kind === "node evidence") writeFileSync(join(f.dir, "nodes", "finish", "run_1", "result.js"), "changed\n");
    if (kind === "outcome evidence") writeFileSync(f.evidence, "changed observation\n");
    if (kind === "progress") f.progress(state => { state.totalSteps++; });
    assert.match(missionFinalizationError(f.state(), f.dir), /stale|changed/);
    rejectedUnchanged(f, () => f.call("finalize"), /stale|changed/);
    rejectedUnchanged(f, () => f.submit("accept", old, "PASS").data, /stale|changed|hash/i);
  });
});

test("A09: root-session evidence cannot change between fresh review and decide/accept", async t => {
  for (const action of ["decide", "accept"]) await t.test(action, t => {
    const f = atFinish(t);
    if (action === "decide") assert.equal(f.call("mission", "pause", "--class", "PLAN", "--reason", "Need evidence").ok, true);
    const verdict = action === "decide" ? "CHECK" : "PASS";
    const packet = f.status(verdict);
    const receipt = f.receipts();
    const review = f.review(packet, action === "decide"
      ? { action: "STOP_SALVAGE", classification: "PLAN", reason: "Observed original evidence", evidence: receipt }
      : { outcomes: [{ id: "O1", status: "PASS", reason: "Observed original evidence", evidence: receipt }] });
    writeFileSync(f.evidence, "Changed after review, before CLI consumption.\n");
    rejectedUnchanged(f, () => f.submit(action, review, verdict).data, /changed|hash|stale/i);
    assert.equal(f.state().mission.acceptance, null);
    assert.notEqual(f.state().status, "stopped");
  });
});

test("A10: accepted Mission cannot bypass invalid terminal handshake or original gate tests", async t => {
  await t.test("invalid handshake", t => {
    const f = atFinish(t);
    for (const path of [join(f.dir, "nodes", "finish", "handshake.json"), join(f.dir, "nodes", "finish", "run_1", "handshake.json")]) {
      const hs = read(path);
      hs.status = "not-a-status";
      json(path, hs);
    }
    assert.equal(f.accept().ok, true);
    rejectedUnchanged(f, () => f.call("finalize"), /handshake|status/);
  });
  await t.test("original test gate", t => {
    const f = fixture(t, { builtin: "quick", init: false });
    assert.equal(f.init(["--entry", "gate"]).created, true);
    // Boundary fixture: exact upstream failed test result, not a successful full quick flow.
    f.progress(state => { state.history = [{ nodeId: "test-execute", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" }, { nodeId: "gate", runId: "run_1", timestamp: "2026-01-01T00:00:01.000Z" }]; state.totalSteps = 2; });
    const run = join(f.dir, "nodes", "test-execute", "run_1");
    mkdirSync(run, { recursive: true });
    json(join(run, "test-result.json"), { status: "failed", exitCode: 1, failures: ["fixture failure"] });
    json(join(run, "handshake.json"), { nodeId: "test-execute", nodeType: "execute", runId: "run_1", status: "completed", verdict: "FAIL", summary: "Tests failed", timestamp: "2026-01-01T00:00:00.000Z", artifacts: [{ type: "test-result", path: "test-result.json" }] });
    sealCurrent(f);
    assert.equal(f.accept().ok, true);
    rejectedUnchanged(f, () => f.call("finalize"), /test|gate verdict|structural/i);
    rejectedUnchanged(f, () => transition(f, "gate", null, "PASS"), /test|gate|structural/i);
  });
});

test("A10/A12: terminal gate advance reports refusal, then completion stays verifiable", t => {
  const f = fixture(t, { template: {
    ...template, nodes: ["start", "work", "gate"], nodeTypes: { start: "build", work: "build", gate: "gate" },
    edges: { start: { PASS: "work" }, work: { PASS: "gate" }, gate: { PASS: null, FAIL: "work" } },
  } });
  sealCurrent(f);
  assert.equal(transition(f, "start", "work", "PASS").allowed, true);
  // Explicit plumbing fixture for the original synthesize parser, not an actual model review.
  const lines = ["# Native audit plumbing fixture", "Verdict: PASS"];
  for (let i = 0; i < 60; i++) lines.push(i % 15 === 0 ? `## Fixture section ${i}` : `Observation ${i}: ${"Evidence ".repeat(i % 12 + 1)}at app.js:1; fixture marker ${i * i}.`);
  writeFileSync(join(f.dir, "nodes", "work", "run_1", "eval-skeptic-owner.md"), lines.join("\n") + "\n");
  sealCurrent(f);
  assert.equal(transition(f, "work", "gate", "PASS").allowed, true);
  const denied = f.call("advance");
  assert.equal(denied.advanced, false);
  assert.equal(denied.transition.finalized, false);
  assert.match(denied.reason, /Mission outcome review is missing/);
  assert.notEqual(f.state().status, "completed");
  rejectedUnchanged(f, () => f.accept(), /seal the terminal node/);
  sealCurrent(f);
  assert.equal(f.accept().ok, true);
  const completed = f.call("advance");
  assert.equal(completed.advanced, true, JSON.stringify(completed));
  assert.equal(completed.transition.finalized, true);
  assert.equal(f.call("finalize").note, "already finalized");
  writeFileSync(f.evidence, "Evidence changed after completion.\n");
  rejectedUnchanged(f, () => f.call("finalize"), /changed|stale/);
});

test("A11: loop, parent and legacy Mission entry points explicitly reject without side effects", t => {
  const f = fixture(t);
  const child = join(f.root, "child");
  rejectedUnchanged(f, () => f.call("init", "--flow", "build-verify", "--parent-session", f.dir, "--mission", f.contractPath, "--dir", child), /parent|unsupported/);
  assert.equal(existsSync(child), false);
  for (const args of [["--mission", f.contractPath], ["--parent-session", f.dir], []]) rejectedUnchanged(f, () => f.call("init-loop", ...args), /Mission|unsupported/);
  assert.equal(existsSync(join(f.dir, "loop-state.json")), false);
  json(join(f.dir, "loop-state.json"), { fixture: true });
  rejectedUnchanged(f, () => f.call("mission", "pause", "--class", "PLAN", "--reason", "fixture"), /loop|shared/);
  rmSync(join(f.dir, "loop-state.json"));
  f.progress(state => { state.mission = { schema: "opc.mission/v1", contract: contract() }; });
  rejectedUnchanged(f, () => f.status(), /unsupported Mission/);
  rejectedUnchanged(f, () => f.call("route", "--node", "work", "--verdict", "PASS"), /MISSION_INVALID/);
  rejectedUnchanged(f, () => f.call("finalize"), /unsupported Mission/);
});

test("A12: corrupt JSON, live lock and failed atomic rename never report success or replace state", async t => {
  await t.test("corrupt review/state JSON", t => {
    const f = fixture(t);
    assert.equal(f.call("mission", "pause", "--class", "PLAN", "--reason", "fixture").ok, true);
    const review = join(f.dir, "broken.json");
    writeFileSync(review, "{broken");
    rejectedUnchanged(f, () => f.call("mission", "decide", "--review", review));
    writeFileSync(f.statePath, "{broken");
    rejectedUnchanged(f, () => f.status());
    assert.equal(existsSync(f.statePath + ".lock"), false);
  });
  await t.test("live lock", t => {
    const f = fixture(t);
    const lock = f.statePath + ".lock";
    const holder = { pid: process.pid, nonce: "test-owned", command: "fixture", timestamp: new Date().toISOString() };
    json(lock, holder);
    rejectedUnchanged(f, () => f.call("mission", "pause", "--class", "PLAN", "--reason", "fixture"), /lock/);
    assert.deepEqual(read(lock), holder);
  });
  await t.test("atomic rename failure", t => {
    const f = fixture(t);
    const preload = join(f.base, "fail-rename.cjs");
    // Deterministic I/O failure injected at the existing atomic-write boundary, including under root.
    writeFileSync(preload, "const fs = require('node:fs'); const original = fs.renameSync; fs.renameSync = (from, to) => { if (to.endsWith('/flow-state.json')) throw Object.assign(new Error('fixture atomic rename failed'), { code: 'EIO' }); return original(from, to); }; require('node:module').syncBuiltinESMExports();\n");
    const result = rejectedUnchanged(f, () => f.cli(["mission", "pause", "--class", "PLAN", "--reason", "fixture"], ["--require", preload]).data, /fixture atomic rename failed/);
    assert.equal(result.ok, false);
    assert.equal(existsSync(f.statePath + ".lock"), false);
    assert.equal(f.state().mission.signal, null);
  });
});
