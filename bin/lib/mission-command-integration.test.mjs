import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { currentMissionBindings, registerFindingBatch } from "./trajectory-gate.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const HARNESS = join(REPO_ROOT, "bin", "opc-harness.mjs");
const PROVENANCE_MODULE = join(REPO_ROOT, "bin", "lib", "provenance-ledger.mjs");
const MISSION_CONTRACT_MODULE = join(REPO_ROOT, "bin", "lib", "mission-contract.mjs");
const ACTIVE_CRITERIA = ["OUT-1", "OUT-2", "OUT-3", "FLOOR-1"];

function missionContract() {
  return {
    schemaVersion: 1,
    version: 1,
    owner: "Mission command integration owner",
    affectedParties: ["Users", "Maintainers"],
    mode: "explore",
    originalRequest: "Keep Mission Gate steering bounded and auditable.",
    outcomes: [
      { id: "OUT-1", statement: "Pending Mission Gates block protected standard-flow mutations." },
      { id: "OUT-2", statement: "A live end-to-end trigger binds standard execute evidence to the pinned scenario." },
      { id: "OUT-3", statement: "A sealed cold review authorizes one audited continuation decision." },
    ],
    retiredCriteria: [],
    protectedFloors: [
      { id: "FLOOR-1", statement: "Rejected commands leave active state bytes unchanged." },
    ],
    nonGoals: ["Exercise loop-mode commands."],
    appetite: {
      maxRepairCycles: 8,
      maxTokens: null,
      maxWallTimeHours: null,
      expiresAt: null,
    },
    endToEndScenario: {
      id: "SCENARIO-1",
      statement: "Run the public standard-flow commands and inspect their durable receipts.",
      validatorTypes: ["e2e", "acceptance"],
    },
    realitySignals: [
      { id: "SIG-1", required: true, observation: "The active state and decision receipt agree." },
    ],
    guardrails: [
      { id: "GUARD-1", metric: "State mutation", actionThreshold: "Pause before any unapproved mutation." },
    ],
    checkpoints: [{ type: "before_finalize" }],
    assumptions: [{ id: "ASM-1", statement: "The local filesystem is readable.", freshUntil: null }],
    exitAndSalvage: "Preserve the last valid state and all sealed decision artifacts.",
  };
}

function acceptanceCriteria(contract = missionContract()) {
  return [
    "## Outcomes",
    ...contract.outcomes.map(outcome => `- ${outcome.id}: ${outcome.statement}`),
    "",
    "## Verification",
    "- OUT-1: A CLI integration test invokes every protected standard-flow command while a Mission Gate is pending.",
    "- OUT-2: CLI integration tests assert integrated receipts and reject unbound or unknown criterion evidence.",
    "- OUT-3: A CLI integration test records an unsigned cold review and consumes the sealed result in mission-decision.",
    "",
    "## Quality Constraints",
    "- Rejected command checks compare the exact active state bytes before and after invocation.",
    "",
    "## Out of Scope",
    "- Loop-mode command coverage.",
    "",
    "## Quality Baseline (functional)",
    "- Deterministic CLI and state-file verification.",
    "",
  ].join("\n");
}

function makeWritable(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    chmodSync(path, 0o600);
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeWritable(join(path, name));
}

function cleanup(fixture) {
  makeWritable(fixture.root);
  rmSync(fixture.root, { recursive: true, force: true });
}

function parseLastJson(stdout, stderr, command) {
  for (const line of String(stdout || "").trim().split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Commands may emit non-JSON progress before their final result.
    }
  }
  assert.fail(`${command} did not emit JSON\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

function run(fixture, command, args = []) {
  const childEnv = { ...process.env };
  // A verifier launched by the harness is a new test process, not a nested
  // node:test file.  Do not leak the outer test runner's recursion marker.
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [HARNESS, command, ...args, "--dir", fixture.session], {
    // Init pins projectRoot from cwd. Use the isolated fixture root instead of
    // hand-editing the authoritative state after it has been sealed.
    cwd: command === "init" ? fixture.root : REPO_ROOT,
    encoding: "utf8",
    env: {
      ...childEnv,
      OPC_DISABLE_EXTENSIONS: "1",
      OPC_PROVENANCE_KEY_FILE: fixture.provenanceKey,
      OPC_QUIET_DEPRECATIONS: "1",
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(child.error, undefined, `${command} failed to launch: ${child.error?.message}`);
  return parseLastJson(child.stdout, child.stderr, command);
}

function runTransitionWithFault(fixture, args, phase) {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [HARNESS, "transition", ...args, "--dir", fixture.session], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...childEnv,
      OPC_DISABLE_EXTENSIONS: "1",
      OPC_PROVENANCE_KEY_FILE: fixture.provenanceKey,
      OPC_QUIET_DEPRECATIONS: "1",
      OPC_TEST_CHILD_TRANSITION_FAULT: phase,
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(child.error, undefined, `fault-injected transition failed to launch: ${child.error?.message}`);
  assert.notEqual(child.status, 0, `fault injection '${phase}' did not stop the transition`);
  assert.match(child.stderr, new RegExp(`injected child transition fault: ${phase}`));
  return child;
}

function persistMissionState(fixture, state, reason) {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const script = [
    'import { readFileSync } from "node:fs";',
    `const { sealMissionRuntimeState } = await import(${JSON.stringify(pathToFileURL(MISSION_CONTRACT_MODULE).href)});`,
    'const state = JSON.parse(readFileSync(0, "utf8"));',
    'const result = sealMissionRuntimeState({',
    '  sessionDir: process.env.OPC_TEST_SESSION,',
    '  state,',
    '  statePath: process.env.OPC_TEST_STATE_PATH,',
    '  reason: process.env.OPC_TEST_SEAL_REASON,',
    '});',
    'console.log(JSON.stringify({ ok: result.ok, error: result.error }));',
    'if (!result.ok) process.exitCode = 1;',
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: JSON.stringify(state),
    env: {
      ...childEnv,
      OPC_PROVENANCE_KEY_FILE: fixture.provenanceKey,
      OPC_TEST_SESSION: fixture.session,
      OPC_TEST_STATE_PATH: fixture.statePath,
      OPC_TEST_SEAL_REASON: reason,
    },
  });
  const result = parseLastJson(child.stdout, child.stderr, "test runtime seal");
  assert.equal(child.status, 0, result.error || child.stderr);
  assert.equal(result.ok, true, result.error);
  return JSON.parse(readFileSync(fixture.statePath, "utf8"));
}

function fixture(entry = "gate", mutateContract = null, flow = "build-verify") {
  const sessionsBase = join(homedir(), ".opc", "sessions");
  mkdirSync(sessionsBase, { recursive: true });
  const root = mkdtempSync(join(sessionsBase, "mission-command-integration-"));
  const session = join(root, "session");
  const source = join(root, "source");
  mkdirSync(session);
  mkdirSync(source);
  const contract = missionContract();
  mutateContract?.(contract);
  const missionPath = join(source, "mission-contract.json");
  const criteriaPath = join(source, "acceptance-criteria.md");
  writeFileSync(missionPath, `${JSON.stringify(contract, null, 2)}\n`);
  writeFileSync(criteriaPath, acceptanceCriteria(contract));
  const initializing = { root, session, provenanceKey: join(root, "provenance-key") };
  let result;
  try {
    result = run(initializing, "init", [
      "--flow", flow,
      "--entry", entry,
      "--mission", missionPath,
      "--criteria", criteriaPath,
      "--no-extensions",
    ]);
  } catch (error) {
    cleanup(initializing);
    throw error;
  }
  if (result.created !== true) cleanup(initializing);
  assert.equal(result.created, true, result.error || JSON.stringify(result));
  const initializedState = JSON.parse(readFileSync(join(session, "flow-state.json"), "utf8"));
  assert.equal(new Date(initializedState.flowStartedAt).toISOString(), initializedState.flowStartedAt);
  assert.equal(realpathSync(initializedState.projectRoot), realpathSync(root));
  return {
    root,
    session,
    source,
    contract,
    missionPath,
    criteriaPath,
    provenanceKey: join(root, "provenance-key"),
    statePath: join(session, "flow-state.json"),
  };
}

function childFixture(parent, entry = "test-design", flow = "build-verify", label = "child") {
  const session = join(parent.root, `${label}-session`);
  const source = join(parent.root, `${label}-source`);
  mkdirSync(session);
  mkdirSync(source);
  const child = {
    root: parent.root,
    session,
    source,
    contract: parent.contract,
    missionPath: parent.missionPath,
    criteriaPath: parent.criteriaPath,
    provenanceKey: parent.provenanceKey,
    statePath: join(session, "flow-state.json"),
  };
  const result = run(child, "init", [
    "--flow", flow,
    "--entry", entry,
    "--parent-session", parent.session,
    "--no-extensions",
  ]);
  assert.equal(result.created, true, result.error || JSON.stringify(result));
  const state = JSON.parse(readFileSync(child.statePath, "utf8"));
  assert.equal(realpathSync(state.mission.parentSession), realpathSync(parent.session));
  return child;
}

test("init --force cannot replace or downgrade existing Mission authority", () => {
  const fx = fixture("brief");
  try {
    const beforeState = readFileSync(fx.statePath);
    const ledgerPath = join(fx.session, ".opc-provenance.jsonl");
    const beforeLedger = readFileSync(ledgerPath);
    const result = run(fx, "init", [
      "--flow", "review",
      "--entry", "review",
      "--force",
      "--no-extensions",
    ]);
    assert.equal(result.created, false, JSON.stringify(result));
    assert.equal(result.status, "mission_authority_exists");
    assert.match(result.error, /cannot overwrite.*Mission/i);
    assert.deepEqual(readFileSync(fx.statePath), beforeState);
    assert.deepEqual(readFileSync(ledgerPath), beforeLedger);
  } finally {
    cleanup(fx);
  }
});

test("init cannot replace deleted Mission state while its ledger authority remains", () => {
  const fx = fixture("brief");
  try {
    const ledgerPath = join(fx.session, ".opc-provenance.jsonl");
    const beforeLedger = readFileSync(ledgerPath);
    rmSync(fx.statePath);
    const result = run(fx, "init", [
      "--flow", "review",
      "--entry", "review",
      "--no-extensions",
    ]);
    assert.equal(result.created, false, JSON.stringify(result));
    assert.equal(result.status, "mission_authority_exists");
    assert.match(result.error, /Mission runtime authority|newest committed seal/i);
    assert.equal(existsSync(fx.statePath), false);
    assert.deepEqual(readFileSync(ledgerPath), beforeLedger);
  } finally {
    cleanup(fx);
  }
});

test("standard finalization opens a non-retryable appetite gate before final review", () => {
  const fx = fixture("gate", contract => {
    contract.appetite.expiresAt = "2020-01-01T00:00:00.000Z";
  });
  try {
    const before = JSON.parse(readFileSync(fx.statePath, "utf8"));
    const result = run(fx, "finalize");
    assert.equal(result.finalized, false, JSON.stringify(result));
    assert.equal(result.rebet_required, true, JSON.stringify(result));
    assert.equal(result.trajectoryReason, "APPETITE_EXPIRED");
    const after = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(after.currentNode, before.currentNode);
    assert.equal(after.trajectory.pending, true);
    assert.equal(after.trajectory.pendingPacket.reason, "APPETITE_EXPIRED");
    assert.equal(after.trajectory.pendingPacket.retryable, false);
  } finally {
    cleanup(fx);
  }
});

test("Mission flows reject skip and goto before they can bypass trajectory accounting", () => {
  const fx = fixture("brief");
  try {
    for (const [command, args] of [["skip", []], ["goto", ["test-execute"]]]) {
      const before = readFileSync(fx.statePath);
      const result = run(fx, command, args);
      assert.equal(result.allowed, false, `${command}: ${JSON.stringify(result)}`);
      assert.match(String(result.error), /Mission mode forbids/);
      assert.deepEqual(readFileSync(fx.statePath), before, `${command} changed active state bytes`);
    }
  } finally {
    cleanup(fx);
  }
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeAuthoritativeHandshake(fx, nodeId, handshake) {
  const runId = handshake.runId;
  assert.match(runId, /^run_\d+$/);
  const nodeDir = join(fx.session, "nodes", nodeId);
  const runDir = join(nodeDir, runId);
  mkdirSync(runDir, { recursive: true });
  const exact = {
    ...handshake,
    artifacts: Array.isArray(handshake.artifacts)
      ? handshake.artifacts.map(artifact => ({
        ...artifact,
        path: typeof artifact.path === "string" && artifact.path.startsWith(`${runId}/`)
          ? artifact.path.slice(runId.length + 1)
          : artifact.path,
      }))
      : handshake.artifacts,
  };
  writeFileSync(join(runDir, "handshake.json"), `${JSON.stringify(exact, null, 2)}\n`);
  writeFileSync(join(nodeDir, "handshake.json"), `${JSON.stringify(handshake, null, 2)}\n`);
}

function rewriteAuthoritativeHandshake(fx, nodeId, mutate) {
  const canonicalPath = join(fx.session, "nodes", nodeId, "handshake.json");
  const handshake = JSON.parse(readFileSync(canonicalPath, "utf8"));
  mutate(handshake);
  writeAuthoritativeHandshake(fx, nodeId, handshake);
  return handshake;
}

function selectCurrentFixtureRun(fx, nodeId, runId) {
  const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
  if (state.currentNode !== nodeId) return;
  const tail = state.history?.at(-1);
  const selectedRunId = tail?.nodeId === nodeId
    ? tail.runId
    : state.totalSteps === 0 && state.history?.length === 0 && state.entryNode === nodeId
      ? "run_1"
      : null;
  if (selectedRunId === runId) return;
  state.history = [
    ...(Array.isArray(state.history) ? state.history : []),
    { nodeId, runId, timestamp: new Date().toISOString() },
  ];
  persistMissionState(fx, state, `test-select-${nodeId}-${runId}`);
}

function appendTestProvenance(fx, event) {
  const script = [
    `import { appendProvenanceEvent } from ${JSON.stringify(pathToFileURL(PROVENANCE_MODULE).href)};`,
    `console.log(JSON.stringify(appendProvenanceEvent(${JSON.stringify(fx.session)}, ${JSON.stringify(event)})));`,
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, OPC_PROVENANCE_KEY_FILE: fx.provenanceKey },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim());
}

function writeExecuteHandshake(fx, evidence, { weakCliOnly = false } = {}) {
  const nodeDir = join(fx.session, "nodes", "test-execute");
  const runDir = join(nodeDir, "run_1");
  mkdirSync(runDir, { recursive: true });
  let artifacts;
  let testEvidenceProvenance;
  if (weakCliOnly) {
    writeFileSync(join(runDir, "scenario.log"), "mission scenario passed\n");
    artifacts = [{ type: "cli-output", path: "run_1/scenario.log" }];
  } else {
    const sourceNode = "test-design";
    const sourceNodeDir = join(fx.session, "nodes", sourceNode);
    const sourceRunDir = join(sourceNodeDir, "run_1");
    mkdirSync(sourceRunDir, { recursive: true });
    const testPlan = [
      "# Mission scenario test plan",
      "",
      "Run the public scenario and require a non-vacuous PASS.",
      "scenario: SCENARIO-1",
      "validator-type: acceptance",
      `satisfies: ${ACTIVE_CRITERIA.join(",")}`,
      "",
    ].join("\n");
    writeFileSync(join(sourceRunDir, "test-plan.md"), testPlan);
    const testCommand = "node --test mission-command-integration";
    writeAuthoritativeHandshake(fx, sourceNode, {
      nodeId: sourceNode,
      nodeType: "review",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "Pinned mission scenario test plan.",
      timestamp: new Date().toISOString(),
      artifacts: [{ type: "test-plan", path: "run_1/test-plan.md" }],
      testCommand,
    });
    const commandHash = sha256(testCommand);
    const sourcePlanHash = sha256(testPlan);
    const result = {
      testCommand,
      provenance: {
        kind: "opc-test-command",
        sourceNode,
        sourceRunId: "run_1",
        commandHash,
        sourcePlanHash,
        executionActor: "opc-harness:test-command",
      },
      exitCode: 0,
      test_fail_count: 0,
      checks: [{ id: "mission-e2e", pass: true, total: 1 }],
    };
    const resultText = `${JSON.stringify(result, null, 2)}\n`;
    writeFileSync(join(runDir, "test-command-result.json"), resultText);
    const resultHash = sha256(resultText);
    const ledger = appendTestProvenance(fx, {
      eventType: "test-command-result",
      nodeId: "test-execute",
      runId: "run_1",
      sourceNode,
      sourceRunId: "run_1",
      commandHash,
      sourcePlanHash,
      resultHash,
      resultPath: "nodes/test-execute/run_1/test-command-result.json",
      exitCode: 0,
    });
    testEvidenceProvenance = {
      kind: "opc-test-command",
      sourceNode,
      sourceRunId: "run_1",
      commandHash,
      sourcePlanHash,
      resultHash,
      executionActor: "opc-harness:test-command",
      ledger,
    };
    artifacts = [{ type: "test-result", path: "run_1/test-command-result.json" }];
  }
  writeAuthoritativeHandshake(fx, "test-execute", {
    nodeId: "test-execute",
    nodeType: "execute",
    runId: "run_1",
    status: "completed",
    verdict: "PASS",
    summary: "The pinned mission scenario passed.",
    timestamp: new Date().toISOString(),
    artifacts,
    evidence,
    ...(testEvidenceProvenance ? { testEvidenceProvenance } : {}),
    ...(testEvidenceProvenance ? { testEvidencePolicy: { allowVacuousChecks: [] } } : {}),
  });
}

function runHarnessExecute(fx, evidence, { satisfies = ACTIVE_CRITERIA } = {}) {
  const sourceNode = "test-design";
  const sourceNodeDir = join(fx.session, "nodes", sourceNode);
  const sourceRunDir = join(sourceNodeDir, "run_1");
  mkdirSync(sourceRunDir, { recursive: true });
  const verifierPath = join(fx.source, "mission-verifier.test.mjs");
  writeFileSync(verifierPath, [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("mission scenario", () => assert.equal(2 + 2, 4));',
    "",
  ].join("\n"));
  const testPlan = [
    "# Mission scenario test plan",
    "",
    "coverage: unit smoke; contract validation; integration e2e flow; UI accessibility; tier baseline polish",
    "scenario: SCENARIO-1",
    "validator-type: acceptance",
    `satisfies: ${satisfies.join(",")}`,
    "",
  ].join("\n");
  writeFileSync(join(sourceRunDir, "test-plan.md"), testPlan);
  writeFileSync(join(sourceRunDir, "eval-skeptic-owner.md"), "# Skeptic\n**Verdict: APPROVE**\nThe frozen scenario mapping is complete.\n");
  writeFileSync(join(sourceRunDir, "eval-tester.md"), "# Tester\n**Verdict: APPROVE**\nThe pinned command is executable.\n");
  writeFileSync(join(sourceRunDir, "test-execution.json"), `${JSON.stringify({
    nodeId: sourceNode,
    runId: "run_1",
    testCommand: `node --test ${JSON.stringify(verifierPath)}`,
    cwd: fx.source,
    timeoutMs: 30_000,
  }, null, 2)}\n`);
  writeAuthoritativeHandshake(fx, sourceNode, {
    nodeId: sourceNode,
    nodeType: "review",
    runId: "run_1",
    status: "completed",
    verdict: "PASS",
    summary: "Frozen non-vacuous mission scenario plan.",
    timestamp: new Date().toISOString(),
    artifacts: [
      { type: "test-plan", path: "run_1/test-plan.md" },
      { type: "eval", path: "run_1/eval-skeptic-owner.md" },
      { type: "eval", path: "run_1/eval-tester.md" },
    ],
  });
  const entered = run(fx, "transition", [
    "--from", "test-design",
    "--to", "test-execute",
    "--verdict", "PASS",
    "--flow", "build-verify",
    "--no-extensions",
  ]);
  assert.equal(entered.allowed, true, entered.reason || JSON.stringify(entered));
  assert.equal(entered.testCommandExecution?.verdict, "PASS", JSON.stringify(entered));
  const handshakePath = join(fx.session, "nodes", "test-execute", "handshake.json");
  const handshake = JSON.parse(readFileSync(handshakePath, "utf8"));
  assert.deepEqual(handshake.evidence, {
    scenarioId: "SCENARIO-1",
    validatorType: "acceptance",
    satisfies,
  }, "harness execution must publish the frozen mapping before executor sealing");
  handshake.evidence = evidence;
  writeAuthoritativeHandshake(fx, "test-execute", handshake);
}

function writePlanReview(fx, role, reasoning) {
  const runDir = join(fx.session, "nodes", "code-review", "run_1");
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, `eval-${role}.md`);
  writeFileSync(path, [
    `# ${role} mission review`,
    "",
    "## Finding",
    "🔴 bin/lib/flow-transition.mjs:1 — the current decomposition cannot preserve the mission outcome",
    "class: PLAN",
    "criterion: OUT-1",
    "finding_ref: NEW",
    "fingerprint: mission-plan-decomposition",
    "invariant: The plan preserves every user-visible mission outcome.",
    `Reasoning: ${reasoning}`,
    "Fix: Re-evaluate the plan at the Mission Gate before another local repair.",
    "",
    "VERDICT: FAIL — FINDINGS[1]",
    "",
  ].join("\n"));
  return `run_1/eval-${role}.md`;
}

function writeMissionEval(fx, {
  nodeId,
  runId,
  verdict = "FAIL",
  finding,
  disposition = null,
}) {
  const runDir = join(fx.session, "nodes", nodeId, runId);
  mkdirSync(runDir, { recursive: true });
  const evalName = "eval-mission-auditor.md";
  const peerEvalName = "eval-peer.md";
  writeFileSync(join(runDir, evalName), [
    "# Mission auditor review",
    "",
    `🔴 ${finding.location || "bin/lib/flow-transition.mjs:1"} — ${finding.issue}`,
    ...(finding.class ? [`class: ${finding.class}`] : []),
    ...(finding.criterion ? [`criterion: ${finding.criterion}`] : []),
    ...(finding.findingRef ? [`finding_ref: ${finding.findingRef}`] : []),
    ...(finding.fingerprint ? [`fingerprint: ${finding.fingerprint}`] : []),
    ...(finding.invariant ? [`invariant: ${finding.invariant}`] : []),
    ...(finding.evidence ? [`evidence: ${finding.evidence}`] : []),
    `Reasoning: ${finding.reasoning}`,
    `Fix: ${finding.fix}`,
    "",
    "VERDICT: FAIL — FINDINGS[1]",
    "",
  ].join("\n"));
  writeFileSync(join(runDir, peerEvalName), [
    "# Independent peer review",
    "",
    "## Mission scope",
    "The peer independently checked the frozen contract and the proposed transition boundary.",
    "",
    "## Evidence",
    "No additional critical or warning finding was identified beyond the auditor's separately recorded claim.",
    "",
    "VERDICT: PASS — FINDINGS[0]",
    "",
  ].join("\n"));
  if (disposition) {
    writeFileSync(join(runDir, "review-claim-dispositions.json"), `${JSON.stringify({
      schemaVersion: 1,
      dispositions: [disposition],
    }, null, 2)}\n`);
  }
  writeAuthoritativeHandshake(fx, nodeId, {
    nodeId,
    nodeType: "review",
    runId,
    status: "completed",
    verdict,
    summary: "Mission-level review finding.",
    timestamp: new Date().toISOString(),
    artifacts: [
      { type: "eval", path: `${runId}/${evalName}` },
      { type: "eval", path: `${runId}/${peerEvalName}` },
    ],
  });
  selectCurrentFixtureRun(fx, nodeId, runId);
}

function putGateAfterReview(fx, reviewNode, gateNode) {
  let state = JSON.parse(readFileSync(fx.statePath, "utf8"));
  const now = new Date().toISOString();
  state.currentNode = gateNode;
  state.history = [
    { nodeId: reviewNode, runId: "run_1", timestamp: now },
    { nodeId: gateNode, runId: "run_1", timestamp: now },
  ];
  state.totalSteps = 1;
  state.edgeCounts = { [`${reviewNode}→${gateNode}`]: 1 };
  state._last_modified = now;
  state = persistMissionState(fx, state, "test-put-gate-after-review");
  return state;
}

function openPlanGate(fx) {
  const alpha = writePlanReview(fx, "alpha", "The proposed repair omits the protected standard-flow mutation boundary.");
  const beta = writePlanReview(fx, "beta", "The next local step cannot satisfy the frozen state-integrity outcome.");
  writeAuthoritativeHandshake(fx, "code-review", {
    nodeId: "code-review",
    nodeType: "review",
    runId: "run_1",
    status: "completed",
    verdict: "FAIL",
    summary: "The independent reviews found a mission-level plan problem.",
    timestamp: new Date().toISOString(),
    artifacts: [
      { type: "eval", path: alpha },
      { type: "eval", path: beta },
    ],
  });
  const opened = run(fx, "transition", [
    "--from", "code-review",
    "--to", "build",
    "--verdict", "FAIL",
    "--flow", "build-verify",
    "--no-extensions",
  ]);
  assert.equal(opened.allowed, false, JSON.stringify(opened));
  assert.equal(opened.rebet_required, true, JSON.stringify(opened));
  assert.equal(opened.trajectoryReason, "PLAN_FINDING", JSON.stringify(opened));
  const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
  assert.equal(state.trajectory.pending, true);
  return state;
}

test("a pending standard-flow Mission Gate blocks protected commands but preserves emergency stop", () => {
  const fx = fixture("gate");
  try {
    const opened = run(fx, "finalize");
    assert.equal(opened.finalized, false, JSON.stringify(opened));
    assert.equal(opened.rebet_required, true, JSON.stringify(opened));
    assert.equal(JSON.parse(readFileSync(fx.statePath, "utf8")).trajectory.pending, true);

    const blockedCommands = [
      ["transition", ["--from", "gate", "--to", "null", "--verdict", "PASS", "--flow", "build-verify"]],
      ["advance", []],
      ["finalize", []],
      ["skip", []],
      ["pass", []],
      ["goto", ["brief"]],
    ];
    for (const [command, args] of blockedCommands) {
      const before = readFileSync(fx.statePath);
      const result = run(fx, command, args);
      assert.equal(result.rebet_required, true, `${command}: ${JSON.stringify(result)}`);
      assert.match(
        String(result.reason || result.error),
        /pending Mission Gate/,
        `${command}: ${JSON.stringify(result)}`,
      );
      assert.deepEqual(readFileSync(fx.statePath), before, `${command} changed active state bytes`);
    }

    const stopped = run(fx, "stop");
    assert.equal(stopped.stopped, true, JSON.stringify(stopped));
    const stoppedState = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(stoppedState.status, "stopped");
    assert.notEqual(stoppedState.status, "completed");

  } finally {
    cleanup(fx);
  }
});

test("standard execute PASS records integrated mission evidence from handshake.evidence", () => {
  const fx = fixture("test-design");
  try {
    runHarnessExecute(fx, {
      scenarioId: "SCENARIO-1",
      validatorType: "acceptance",
      validator: "mission-command-integration",
      satisfies: ACTIVE_CRITERIA,
    });
    const resealed = run(fx, "seal", ["--node", "test-execute"]);
    assert.equal(resealed.sealed, true, resealed.error || JSON.stringify(resealed));
    const resealedHandshake = JSON.parse(readFileSync(
      join(fx.session, "nodes", "test-execute", "handshake.json"),
      "utf8",
    ));
    assert.deepEqual(resealedHandshake.evidence, {
      scenarioId: "SCENARIO-1",
      validatorType: "acceptance",
      validator: "mission-command-integration",
      satisfies: ACTIVE_CRITERIA,
    });
    const transitioned = run(fx, "transition", [
      "--from", "test-execute",
      "--to", "gate",
      "--verdict", "PASS",
      "--flow", "build-verify",
      "--no-extensions",
    ]);
    assert.equal(transitioned.allowed, true, transitioned.reason || JSON.stringify(transitioned));
    assert.equal(transitioned.evidenceReceipt.scope, "integrated");
    assert.equal(transitioned.evidenceReceipt.scenarioId, "SCENARIO-1");
    assert.equal(transitioned.evidenceReceipt.validatorType, "acceptance");
    assert.deepEqual(transitioned.evidenceReceipt.satisfies, ACTIVE_CRITERIA);
    assert.match(transitioned.evidenceReceipt.artifactHashes[0], /^sha256:[a-f0-9]{64}$/);

    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.deepEqual(state.evidenceReceipts.at(-1), transitioned.evidenceReceipt);
    assert.equal(state.artifacts.length, 2);
    assert.deepEqual(new Set(state.artifacts.map(path => realpathSync(path))), new Set([
      realpathSync(join(fx.session, "nodes", "test-execute", "run_1", "test-command-result.json")),
      realpathSync(join(fx.session, "nodes", "test-execute", "run_1", "test-command-output.txt")),
    ]));
  } finally {
    cleanup(fx);
  }
});

test("standard integrated receipt becomes stale when its signed PASS artifact changes or disappears", async t => {
  for (const mutation of ["fail", "delete"]) {
    await t.test(mutation, () => {
      const fx = fixture("test-design");
      try {
        runHarnessExecute(fx, {
          scenarioId: "SCENARIO-1",
          validatorType: "acceptance",
          satisfies: ACTIVE_CRITERIA,
        });
        const transitioned = run(fx, "transition", [
          "--from", "test-execute",
          "--to", "gate",
          "--verdict", "PASS",
          "--flow", "build-verify",
          "--no-extensions",
        ]);
        assert.equal(transitioned.allowed, true, transitioned.reason || JSON.stringify(transitioned));
        let completedState = JSON.parse(readFileSync(fx.statePath, "utf8"));
        completedState.checkpointReceipts = [{
          checkpointId: "before_finalize",
          ...currentMissionBindings(completedState),
          missionReviewSha256: "test-final-review",
          provenanceRecordHash: "test-final-review-provenance",
        }];
        completedState.status = "completed";
        completedState.completedAt = new Date().toISOString();
        persistMissionState(fx, completedState, "test-completed-state-evidence-mutation");
        const resultPath = join(fx.session, "nodes", "test-execute", "run_1", "test-command-result.json");
        if (mutation === "delete") {
          rmSync(resultPath);
        } else {
          const result = JSON.parse(readFileSync(resultPath, "utf8"));
          result.exitCode = 1;
          result.test_fail_count = 1;
          writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        }

        const finalized = run(fx, "finalize");
        assert.equal(finalized.finalized, false, JSON.stringify(finalized));
        assert.deepEqual(finalized.staleEvidenceReceiptIds, ["EV-1"]);
        const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
        assert.equal(state.evidenceReceipts[0].stale, true);
        assert.match(state.evidenceReceipts[0].staleReason, /changed|missing|unreadable/);
        const replayed = run(fx, "finalize");
        assert.equal(replayed.finalized, false, JSON.stringify(replayed));
        assert.match(replayed.error || replayed.reason, /checkpoint|invalidated|stale/i);
      } finally {
        cleanup(fx);
      }
    });
  }
});

test("a parent-linked child composes stale old evidence with a fresh receipt", () => {
  const parent = fixture("test-design");
  try {
    runHarnessExecute(parent, {
      scenarioId: "SCENARIO-1",
      validatorType: "acceptance",
      satisfies: ACTIVE_CRITERIA,
    });
    const parentRecorded = run(parent, "transition", [
      "--from", "test-execute",
      "--to", "gate",
      "--verdict", "PASS",
      "--flow", "build-verify",
      "--no-extensions",
    ]);
    assert.equal(parentRecorded.allowed, true, parentRecorded.reason || JSON.stringify(parentRecorded));
    assert.equal(parentRecorded.evidenceReceipt.id, "EV-1");

    const child = childFixture(parent);
    runHarnessExecute(child, {
      scenarioId: "SCENARIO-1",
      validatorType: "acceptance",
      satisfies: ACTIVE_CRITERIA,
    });

    const oldResultPath = join(
      parent.session,
      "nodes",
      "test-execute",
      "run_1",
      "test-command-result.json",
    );
    const failedOldResult = JSON.parse(readFileSync(oldResultPath, "utf8"));
    failedOldResult.exitCode = 1;
    failedOldResult.test_fail_count = 1;
    writeFileSync(oldResultPath, `${JSON.stringify(failedOldResult, null, 2)}\n`);

    const transitioned = run(child, "transition", [
      "--from", "test-execute",
      "--to", "gate",
      "--verdict", "PASS",
      "--flow", "build-verify",
      "--no-extensions",
    ]);
    assert.equal(transitioned.allowed, true, transitioned.reason || JSON.stringify(transitioned));
    assert.equal(transitioned.evidenceReceipt.id, "EV-2");

    const parentState = JSON.parse(readFileSync(parent.statePath, "utf8"));
    assert.equal(parentState.evidenceReceipts.length, 2);
    assert.equal(parentState.evidenceReceipts[0].id, "EV-1");
    assert.equal(parentState.evidenceReceipts[0].stale, true);
    assert.match(parentState.evidenceReceipts[0].staleReason, /changed/);
    assert.equal(parentState.evidenceReceipts[1].id, "EV-2");
    assert.notEqual(parentState.evidenceReceipts[1].stale, true);
    assert.equal(
      parentState.evidenceReceipts[1].sourceExecution.sessionSha256,
      sha256(resolve(child.session)),
    );
    assert.equal(JSON.parse(readFileSync(child.statePath, "utf8")).currentNode, "gate");
  } finally {
    cleanup(parent);
  }
});

test("a parent-linked child consumes its retry and dedupes a replayed receipt", () => {
  const parent = fixture("gate");
  try {
    const child = childFixture(parent);
    runHarnessExecute(child, {
      scenarioId: "SCENARIO-1",
      validatorType: "acceptance",
      satisfies: ACTIVE_CRITERIA,
    });

    let parentState = JSON.parse(readFileSync(parent.statePath, "utf8"));
    parentState.trajectory.retryAllowance = 1;
    parentState.trajectory.retryGrant = {
      triggerId: "TRIG-child-execute-retry",
      strategyEpoch: parentState.mission.strategyEpoch,
      scopeTokens: ["EDGE:test-execute→gate"],
      edgeKey: "test-execute→gate",
      command: "transition",
      sourceNode: "test-execute",
      nextUnit: null,
      sessionSha256: sha256(resolve(child.session)),
      remaining: 1,
    };
    persistMissionState(parent, parentState, "test-child-retry-grant");

    const transitionArgs = [
      "--from", "test-execute",
      "--to", "gate",
      "--verdict", "PASS",
      "--flow", "build-verify",
      "--no-extensions",
    ];
    const beforeChildCommit = readFileSync(child.statePath);
    runTransitionWithFault(child, transitionArgs, "after-parent-publish");
    assert.deepEqual(readFileSync(child.statePath), beforeChildCommit);

    parentState = JSON.parse(readFileSync(parent.statePath, "utf8"));
    assert.equal(parentState.trajectory.retryGrant, null);
    assert.equal(parentState.trajectory.retryAllowance, 0);
    assert.equal(parentState.evidenceReceipts.length, 1);
    assert.equal(parentState.trajectory.pendingChildTransition.origin.edgeKey, "test-execute→gate");

    const parentBeforeReplay = readFileSync(parent.statePath);
    const replayed = run(child, "transition", transitionArgs);
    assert.equal(replayed.allowed, true, replayed.reason || JSON.stringify(replayed));
    assert.equal(replayed.recovered, true);
    assert.equal(replayed.evidenceReceipt.id, "EV-1");
    assert.deepEqual(readFileSync(parent.statePath), parentBeforeReplay);
    assert.equal(JSON.parse(readFileSync(parent.statePath, "utf8")).evidenceReceipts.length, 1);
    assert.equal(JSON.parse(readFileSync(child.statePath, "utf8")).currentNode, "gate");
  } finally {
    cleanup(parent);
  }
});

test("an exact negative child replay recovers once while wrong origins stay blocked", () => {
  const parent = fixture("gate");
  try {
    const child = childFixture(parent, "code-review");
    const sibling = childFixture(parent, "code-review", "build-verify", "sibling");
    const findingInput = {
      class: "ARTIFACT",
      criterion: "OUT-1",
      finding_ref: "NEW",
      fingerprint: "parent-child-negative-crash",
      invariant: "A parent-published negative transition advances its child exactly once.",
    };
    let parentState = JSON.parse(readFileSync(parent.statePath, "utf8"));
    const registered = registerFindingBatch({
      registry: parentState.findingRegistry || [],
      findings: [findingInput],
      criterionHashes: parentState.mission.criterionHashes,
    });
    assert.equal(registered.ok, true, registered.errors?.join("; "));
    const finding = registered.findings[0];
    parentState.findingRegistry = registered.registry;
    parentState.trajectory.activeFindings = [finding];
    parentState.trajectory.findingFailureCounts ||= {};
    parentState.trajectory.findingFailureCounts[finding.gateKey] = 1;
    parentState.trajectory.retryAllowance = 1;
    parentState.trajectory.retryGrant = {
      triggerId: "TRIG-child-negative-finding",
      strategyEpoch: parentState.mission.strategyEpoch,
      scopeTokens: [finding.finding_ref],
      edgeKey: "code-review→build",
      command: "transition",
      sourceNode: "code-review",
      nextUnit: null,
      sessionSha256: sha256(resolve(child.session)),
      remaining: 1,
    };
    persistMissionState(parent, parentState, "test-negative-child-retry");

    for (const fx of [child, sibling]) {
      writeMissionEval(fx, {
        nodeId: "code-review",
        runId: "run_1",
        finding: {
          issue: "the child cursor can lag the already-published parent observation",
          class: finding.class,
          criterion: finding.criterion,
          findingRef: finding.finding_ref,
          fingerprint: finding.fingerprint,
          invariant: finding.invariant,
          reasoning: "A crash between parent and child durability must not repeat trajectory accounting.",
          fix: "Recover only the exact signed staged child transition.",
        },
      });
    }

    const exactArgs = [
      "--from", "code-review",
      "--to", "build",
      "--verdict", "FAIL",
      "--flow", "build-verify",
      "--no-extensions",
    ];
    const childBefore = readFileSync(child.statePath);
    runTransitionWithFault(child, exactArgs, "after-parent-publish");
    assert.deepEqual(readFileSync(child.statePath), childBefore);

    parentState = JSON.parse(readFileSync(parent.statePath, "utf8"));
    assert.equal(parentState.trajectory.retryGrant, null);
    assert.equal(parentState.trajectory.findingFailureCounts[finding.gateKey], 2);
    assert.equal(parentState.trajectory.repairEdgeFailures["code-review→build"], 1);
    assert.equal(parentState.trajectory.pendingChildTransition.origin.sourceRunId, "run_1");
    const parentPendingBytes = readFileSync(parent.statePath);

    const stopped = run(child, "stop");
    assert.match(stopped.reason || stopped.error, /pending parent-linked child transition|exact recovery/i);
    assert.deepEqual(readFileSync(child.statePath), childBefore);
    assert.deepEqual(readFileSync(parent.statePath), parentPendingBytes);

    const wrongEdge = run(child, "transition", [
      "--from", "code-review", "--to", "test-design", "--verdict", "PASS",
      "--flow", "build-verify", "--no-extensions",
    ]);
    assert.equal(wrongEdge.allowed, false, JSON.stringify(wrongEdge));
    assert.match(wrongEdge.reason, /bound to a different command, session, source, edge, verdict, or run/);
    assert.deepEqual(readFileSync(child.statePath), childBefore);
    assert.deepEqual(readFileSync(parent.statePath), parentPendingBytes);

    const wrongSource = run(child, "transition", [
      "--from", "build", "--to", "code-review", "--verdict", "PASS",
      "--flow", "build-verify", "--no-extensions",
    ]);
    assert.equal(wrongSource.allowed, false, JSON.stringify(wrongSource));
    assert.match(wrongSource.reason, /bound to a different command, session, source, edge, verdict, or run/);

    const siblingBefore = readFileSync(sibling.statePath);
    const wrongSession = run(sibling, "transition", exactArgs);
    assert.equal(wrongSession.allowed, false, JSON.stringify(wrongSession));
    assert.match(wrongSession.reason, /bound to a different command, session, source, edge, verdict, or run/);
    assert.deepEqual(readFileSync(sibling.statePath), siblingBefore);
    assert.deepEqual(readFileSync(parent.statePath), parentPendingBytes);

    const handshakePaths = [
      join(child.session, "nodes", "code-review", "handshake.json"),
      join(child.session, "nodes", "code-review", "run_1", "handshake.json"),
    ];
    const handshakeBytes = handshakePaths.map(path => readFileSync(path));
    for (const [index, path] of handshakePaths.entries()) {
      const wrongRunHandshake = JSON.parse(handshakeBytes[index].toString("utf8"));
      wrongRunHandshake.runId = "run_2";
      writeFileSync(path, `${JSON.stringify(wrongRunHandshake, null, 2)}\n`);
    }
    const wrongRun = run(child, "transition", exactArgs);
    assert.equal(wrongRun.allowed, false, JSON.stringify(wrongRun));
    assert.match(wrongRun.reason, /bound to a different command, session, source, edge, verdict, or run/);
    for (const [index, path] of handshakePaths.entries()) writeFileSync(path, handshakeBytes[index]);

    const evalPath = join(child.session, "nodes", "code-review", "run_1", "eval-mission-auditor.md");
    const evalBytes = readFileSync(evalPath);
    writeFileSync(evalPath, `${evalBytes.toString("utf8")}\nPost-journal mutation.\n`);
    const changedEval = run(child, "transition", exactArgs);
    assert.equal(changedEval.allowed, false, JSON.stringify(changedEval));
    assert.match(changedEval.reason, /bound to a different command, session, source, edge, verdict, or run/);
    assert.deepEqual(readFileSync(child.statePath), childBefore);
    assert.deepEqual(readFileSync(parent.statePath), parentPendingBytes);
    writeFileSync(evalPath, evalBytes);

    rmSync(child.statePath);
    const missingChild = run(parent, "finalize");
    assert.match(missingChild.reason || missingChild.error, /pending parent-linked child transition|child.*missing|recovery/i);
    assert.deepEqual(readFileSync(parent.statePath), parentPendingBytes);
    writeFileSync(child.statePath, childBefore);

    const replayed = run(child, "transition", exactArgs);
    assert.equal(replayed.allowed, true, replayed.reason || JSON.stringify(replayed));
    assert.equal(replayed.recovered, true);
    assert.equal(JSON.parse(readFileSync(child.statePath, "utf8")).currentNode, "build");
    assert.deepEqual(readFileSync(parent.statePath), parentPendingBytes);
    parentState = JSON.parse(readFileSync(parent.statePath, "utf8"));
    assert.equal(parentState.trajectory.findingFailureCounts[finding.gateKey], 2);
    assert.equal(parentState.trajectory.repairEdgeFailures["code-review→build"], 1);
  } finally {
    cleanup(parent);
  }
});

test("a repeated repair-edge retry recovers across both parent-child crash boundaries", async t => {
  for (const phase of ["after-parent-publish", "after-child-publish"]) {
    await t.test(phase, () => {
      const parent = fixture("gate");
      try {
        const child = childFixture(parent, "hotfix");
        writeAuthoritativeHandshake(child, "hotfix", {
          nodeId: "hotfix",
          nodeType: "hotfix",
          runId: "run_1",
          status: "completed",
          verdict: "ITERATE",
          summary: "The repeated repair edge needs its one bound retry.",
          timestamp: new Date().toISOString(),
          artifacts: [],
          hotfix: {
            scope: "trivial",
            allowedOperations: ["retry the exact bounded repair"],
            structuralChange: false,
            forbiddenOperations: [],
          },
        });
        let parentState = JSON.parse(readFileSync(parent.statePath, "utf8"));
        parentState.trajectory.repairEdgeFailures ||= {};
        parentState.trajectory.repairEvidenceCursor ||= {};
        parentState.trajectory.repairEvidenceSeenIds ||= {};
        parentState.trajectory.repairCycles = 1;
        parentState.trajectory.repairEdgeFailures["hotfix→build"] = 1;
        parentState.trajectory.repairEvidenceCursor["hotfix→build"] = 0;
        parentState.trajectory.repairEvidenceSeenIds["hotfix→build"] = [];
        parentState.trajectory.retryAllowance = 1;
        parentState.trajectory.retryGrant = {
          triggerId: `TRIG-repeated-edge-${phase}`,
          strategyEpoch: parentState.mission.strategyEpoch,
          scopeTokens: ["EDGE:hotfix→build"],
          edgeKey: "hotfix→build",
          command: "transition",
          sourceNode: "hotfix",
          nextUnit: null,
          sessionSha256: sha256(resolve(child.session)),
          remaining: 1,
        };
        persistMissionState(parent, parentState, `test-repeated-edge-${phase}`);

        const args = [
          "--from", "hotfix", "--to", "build", "--verdict", "ITERATE",
          "--flow", "build-verify", "--no-extensions",
        ];
        const targetRunDir = join(child.session, "nodes", "build", "run_1");
        const cumulativePath = join(child.session, "cumulative-findings.md");
        rmSync(cumulativePath, { force: true });
        const childBefore = readFileSync(child.statePath);
        runTransitionWithFault(child, args, phase);
        parentState = JSON.parse(readFileSync(parent.statePath, "utf8"));
        assert.equal(parentState.trajectory.retryGrant, null);
        assert.equal(parentState.trajectory.repairCycles, 2);
        assert.equal(parentState.trajectory.repairEdgeFailures["hotfix→build"], 2);
        const parentBytes = readFileSync(parent.statePath);
        const childAfterFault = readFileSync(child.statePath);
        if (phase === "after-parent-publish") assert.deepEqual(childAfterFault, childBefore);
        else assert.equal(JSON.parse(childAfterFault.toString("utf8")).currentNode, "build");
        assert.equal(existsSync(targetRunDir), true, "target run must be reserved before the injected fault");
        assert.deepEqual(readdirSync(targetRunDir), [], "a fault must leave only an empty target reservation");
        assert.equal(existsSync(cumulativePath), false, "fault must precede cumulative-findings setup");

        const replayed = run(child, "transition", args);
        assert.equal(replayed.allowed, true, replayed.reason || JSON.stringify(replayed));
        assert.equal(replayed.recovered, true);
        assert.deepEqual(readFileSync(parent.statePath), parentBytes);
        const childState = JSON.parse(readFileSync(child.statePath, "utf8"));
        assert.equal(childState.currentNode, "build");
        assert.equal(childState.history.filter(entry => entry.nodeId === "build").length, 1);
        assert.equal(existsSync(targetRunDir), true, "replay must retain the reserved target run");
        assert.match(readFileSync(cumulativePath, "utf8"), /Current node: build/);
        if (phase === "after-child-publish") {
          assert.deepEqual(readFileSync(child.statePath), childAfterFault);
        }
        parentState = JSON.parse(readFileSync(parent.statePath, "utf8"));
        assert.equal(parentState.trajectory.repairCycles, 2);
        assert.equal(parentState.trajectory.repairEdgeFailures["hotfix→build"], 2);
      } finally {
        cleanup(parent);
      }
    });
  }
});

test("a gate-origin after-child fault replays from its frozen signed input manifests", () => {
  const parent = fixture("gate");
  try {
    const child = childFixture(parent, "code-review");
    writeMissionEval(child, {
      nodeId: "code-review",
      runId: "run_1",
      finding: {
        issue: "gate recovery must not derive new evidence inputs from post-transition history",
        class: "ARTIFACT",
        criterion: "OUT-1",
        findingRef: "NEW",
        fingerprint: "gate-child-post-history-manifest",
        invariant: "A signed gate transition revalidates exactly its frozen source manifests.",
        reasoning: "The target node appears only after the parent effects and child cursor are durable.",
        fix: "Revalidate the node manifests named by the signed parent journal.",
      },
    });
    putGateAfterReview(child, "code-review", "gate");
    const exactArgs = [
      "--from", "gate", "--to", "brief", "--verdict", "FAIL",
      "--flow", "build-verify", "--no-extensions",
    ];
    const targetRunDir = join(child.session, "nodes", "brief", "run_1");
    const cumulativePath = join(child.session, "cumulative-findings.md");
    rmSync(cumulativePath, { force: true });
    runTransitionWithFault(child, exactArgs, "after-child-publish");

    let childState = JSON.parse(readFileSync(child.statePath, "utf8"));
    assert.equal(childState.currentNode, "brief");
    assert.equal(existsSync(targetRunDir), true, "target run must be reserved before the injected fault");
    assert.deepEqual(readdirSync(targetRunDir), [], "a fault must leave only an empty target reservation");
    assert.equal(existsSync(cumulativePath), false);
    let parentState = JSON.parse(readFileSync(parent.statePath, "utf8"));
    const journal = parentState.trajectory.pendingChildTransition;
    assert.deepEqual(journal.origin.inputManifests.map(item => item.nodeId), ["code-review", "gate"]);
    assert.equal(Object.values(parentState.trajectory.findingFailureCounts || {}).reduce((a, b) => a + b, 0), 1);
    assert.equal(parentState.trajectory.repairEdgeFailures["gate→brief"], 1);
    assert.equal(parentState.trajectory.repairCycles, 1);
    const parentBytes = readFileSync(parent.statePath);

    const stopped = run(child, "stop");
    assert.equal(stopped.stopped, true, JSON.stringify(stopped));
    childState = JSON.parse(readFileSync(child.statePath, "utf8"));
    assert.equal(childState._parentTransitionReceipt.transactionId, journal.transactionId);
    assert.ok(childState._missionRuntimeSeal.generation >= journal.child.preSealGeneration + 2);

    const wrongOrigin = run(child, "transition", [
      "--from", "gate", "--to", "brief", "--verdict", "ITERATE",
      "--flow", "build-verify", "--no-extensions",
    ]);
    assert.equal(wrongOrigin.allowed, false, JSON.stringify(wrongOrigin));
    assert.deepEqual(readFileSync(parent.statePath), parentBytes);

    const evalPath = join(child.session, "nodes", "code-review", "run_1", "eval-mission-auditor.md");
    const evalBytes = readFileSync(evalPath);
    writeFileSync(evalPath, `${evalBytes.toString("utf8")}\nPost-journal evidence mutation.\n`);
    const changedEvidence = run(child, "transition", exactArgs);
    assert.equal(changedEvidence.allowed, false, JSON.stringify(changedEvidence));
    assert.deepEqual(readFileSync(parent.statePath), parentBytes);
    writeFileSync(evalPath, evalBytes);

    const descendantBeforeReplay = readFileSync(child.statePath);
    const replayed = run(child, "transition", exactArgs);
    assert.equal(replayed.allowed, true, replayed.reason || JSON.stringify(replayed));
    assert.equal(replayed.recovered, true);
    assert.equal(replayed.duplicate, true);
    assert.deepEqual(readFileSync(parent.statePath), parentBytes);
    assert.deepEqual(readFileSync(child.statePath), descendantBeforeReplay);
    assert.equal(existsSync(targetRunDir), true);
    assert.match(readFileSync(cumulativePath, "utf8"), /Current node: brief/);
    parentState = JSON.parse(readFileSync(parent.statePath, "utf8"));
    assert.equal(Object.values(parentState.trajectory.findingFailureCounts || {}).reduce((a, b) => a + b, 0), 1);
    assert.equal(parentState.trajectory.repairEdgeFailures["gate→brief"], 1);
    assert.equal(parentState.trajectory.repairCycles, 1);
  } finally {
    cleanup(parent);
  }
});

test("a completed child journal rotates for a sibling without parent accounting changes", () => {
  const parent = fixture("gate");
  try {
    const first = childFixture(parent, "build", "build-verify", "journal-first");
    const sibling = childFixture(parent, "build", "build-verify", "journal-sibling");
    for (const child of [first, sibling]) {
      writeAuthoritativeHandshake(child, "build", {
        nodeId: "build",
        nodeType: "build",
        runId: "run_1",
        status: "completed",
        verdict: "PASS",
        summary: "A parent-linked child completed an ordinary build step.",
        timestamp: new Date().toISOString(),
        artifacts: [],
      });
    }
    const args = [
      "--from", "build", "--to", "code-review", "--verdict", "PASS",
      "--flow", "build-verify", "--no-extensions",
    ];
    const firstResult = run(first, "transition", args);
    assert.equal(firstResult.allowed, true, firstResult.reason || JSON.stringify(firstResult));
    const parentAfterFirst = JSON.parse(readFileSync(parent.statePath, "utf8"));
    const firstJournal = parentAfterFirst.trajectory.pendingChildTransition;
    assert.equal(firstJournal.origin.childSession, realpathSync(first.session));

    const beforeAccounting = {
      receipts: parentAfterFirst.evidenceReceipts || [],
      retryAllowance: parentAfterFirst.trajectory.retryAllowance,
      retryGrant: parentAfterFirst.trajectory.retryGrant,
      repairCycles: parentAfterFirst.trajectory.repairCycles,
      findingFailureCounts: parentAfterFirst.trajectory.findingFailureCounts,
      repairEdgeFailures: parentAfterFirst.trajectory.repairEdgeFailures,
    };
    const siblingResult = run(sibling, "transition", args);
    assert.equal(siblingResult.allowed, true, siblingResult.reason || JSON.stringify(siblingResult));
    const parentAfterSibling = JSON.parse(readFileSync(parent.statePath, "utf8"));
    assert.equal(parentAfterSibling.trajectory.lastCompletedChildTransition.transactionId, firstJournal.transactionId);
    assert.equal(parentAfterSibling.trajectory.pendingChildTransition.origin.childSession, realpathSync(sibling.session));
    assert.notEqual(parentAfterSibling.trajectory.pendingChildTransition.transactionId, firstJournal.transactionId);
    assert.deepEqual({
      receipts: parentAfterSibling.evidenceReceipts || [],
      retryAllowance: parentAfterSibling.trajectory.retryAllowance,
      retryGrant: parentAfterSibling.trajectory.retryGrant,
      repairCycles: parentAfterSibling.trajectory.repairCycles,
      findingFailureCounts: parentAfterSibling.trajectory.findingFailureCounts,
      repairEdgeFailures: parentAfterSibling.trajectory.repairEdgeFailures,
    }, beforeAccounting);
    assert.equal(JSON.parse(readFileSync(first.statePath, "utf8")).currentNode, "code-review");
    assert.equal(JSON.parse(readFileSync(sibling.statePath, "utf8")).currentNode, "code-review");
  } finally {
    cleanup(parent);
  }
});

test("receipt-bearing child descendants do not deadlock the parent journal", async t => {
  const setup = label => {
    const parent = fixture("gate");
    const child = childFixture(parent, "build", "build-verify", `${label}-child`);
    writeAuthoritativeHandshake(child, "build", {
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "Ordinary child transition used to establish a completed parent journal.",
      timestamp: new Date().toISOString(),
      artifacts: [],
    });
    const transitioned = run(child, "transition", [
      "--from", "build", "--to", "code-review", "--verdict", "PASS",
      "--flow", "build-verify", "--no-extensions",
    ]);
    assert.equal(transitioned.allowed, true, transitioned.reason || JSON.stringify(transitioned));
    return { parent, child };
  };

  await t.test("a public child stop preserves completion for parent finalization", () => {
    const { parent, child } = setup("stop-descendant");
    try {
      const beforeStop = JSON.parse(readFileSync(child.statePath, "utf8"));
      const receipt = structuredClone(beforeStop._parentTransitionReceipt);
      const stopped = run(child, "stop");
      assert.equal(stopped.stopped, true, JSON.stringify(stopped));
      const afterStop = JSON.parse(readFileSync(child.statePath, "utf8"));
      assert.deepEqual(afterStop._parentTransitionReceipt, receipt);
      assert.ok(afterStop._missionRuntimeSeal.generation > beforeStop._missionRuntimeSeal.generation);
      const finalized = run(parent, "finalize");
      assert.doesNotMatch(
        String(finalized.reason || finalized.error || ""),
        /pending parent-linked child transition|exact recovery|receipt-bearing child descendant/i,
        JSON.stringify(finalized),
      );
    } finally {
      cleanup(parent);
    }
  });

  for (const variant of ["missing", "tampered", "copied"]) {
    await t.test(`${variant} receipt fails closed`, () => {
      const { parent, child } = setup(`${variant}-receipt`);
      try {
        const parentState = JSON.parse(readFileSync(parent.statePath, "utf8"));
        const journal = parentState.trajectory.pendingChildTransition;
        const childState = JSON.parse(readFileSync(child.statePath, "utf8"));
        const originalReceipt = structuredClone(childState._parentTransitionReceipt);
        if (variant === "tampered") childState._parentTransitionReceipt.transactionId = `${journal.transactionId}-tampered`;
        else delete childState._parentTransitionReceipt;
        persistMissionState(child, childState, `test-${variant}-child-transition-receipt`);

        if (variant === "copied") {
          const sibling = childFixture(parent, "build", "build-verify", "copied-receipt-sibling");
          const siblingState = JSON.parse(readFileSync(sibling.statePath, "utf8"));
          siblingState._parentTransitionReceipt = originalReceipt;
          persistMissionState(sibling, siblingState, "test-copied-child-transition-receipt");
        }
        const parentBytes = readFileSync(parent.statePath);
        const blocked = run(parent, "finalize");
        assert.match(
          String(blocked.reason || blocked.error || ""),
          /pending parent-linked child transition|exact recovery|receipt/i,
          JSON.stringify(blocked),
        );
        assert.deepEqual(readFileSync(parent.statePath), parentBytes);
      } finally {
        cleanup(parent);
      }
    });
  }
});

test("invalid standard evidence fails before active state mutation", async t => {
  await t.test("integrated claims backed only by prose", () => {
    const fx = fixture("test-execute");
    try {
      writeExecuteHandshake(fx, {
        scenarioId: "SCENARIO-1",
        validatorType: "e2e",
        satisfies: ACTIVE_CRITERIA,
      }, { weakCliOnly: true });
      const before = readFileSync(fx.statePath);
      const result = run(fx, "transition", [
        "--from", "test-execute",
        "--to", "gate",
        "--verdict", "PASS",
        "--flow", "build-verify",
        "--no-extensions",
      ]);
      assert.equal(result.allowed, false, JSON.stringify(result));
      assert.match(result.reason, /OPC testCommand provenance|trusted harness execution boundary/);
      assert.deepEqual(readFileSync(fx.statePath), before);
    } finally {
      cleanup(fx);
    }
  });

  await t.test("unknown criterion id", () => {
    const fx = fixture("test-design");
    try {
      runHarnessExecute(fx, {
        scenarioId: "SCENARIO-1",
        validatorType: "acceptance",
        satisfies: [...ACTIVE_CRITERIA, "OUT-999"],
      });
      const before = readFileSync(fx.statePath);
      const result = run(fx, "transition", [
        "--from", "test-execute",
        "--to", "gate",
        "--verdict", "PASS",
        "--flow", "build-verify",
        "--no-extensions",
      ]);
      assert.equal(result.allowed, false, JSON.stringify(result));
      assert.match(result.reason, /unknown criteria: OUT-999/);
      assert.deepEqual(readFileSync(fx.statePath), before);
    } finally {
      cleanup(fx);
    }
  });

  await t.test("handshake cannot relabel a signed result to a different known criterion set", () => {
    const fx = fixture("test-design");
    try {
      runHarnessExecute(fx, {
        scenarioId: "SCENARIO-1",
        validatorType: "acceptance",
        satisfies: ACTIVE_CRITERIA.slice(0, 2),
      });
      const before = readFileSync(fx.statePath);
      const result = run(fx, "transition", [
        "--from", "test-execute",
        "--to", "gate",
        "--verdict", "PASS",
        "--flow", "build-verify",
        "--no-extensions",
      ]);
      assert.equal(result.allowed, false, JSON.stringify(result));
      assert.match(result.reason, /exactly match.*frozen mapping/);
      assert.deepEqual(readFileSync(fx.statePath), before);
    } finally {
      cleanup(fx);
    }
  });

  await t.test("handshake cannot relabel a signed result to another allowed validator type", () => {
    const fx = fixture("test-design");
    try {
      runHarnessExecute(fx, {
        scenarioId: "SCENARIO-1",
        validatorType: "e2e",
        satisfies: ACTIVE_CRITERIA,
      });
      const result = run(fx, "transition", [
        "--from", "test-execute",
        "--to", "gate",
        "--verdict", "PASS",
        "--flow", "build-verify",
        "--no-extensions",
      ]);
      assert.equal(result.allowed, false, JSON.stringify(result));
      assert.match(result.reason, /validator type must exactly match.*frozen mapping/);
    } finally {
      cleanup(fx);
    }
  });

  await t.test("caller-authored passing JSON without signed harness provenance", () => {
    const fx = fixture("test-execute");
    try {
      writeExecuteHandshake(fx, {
        scenarioId: "SCENARIO-1",
        validatorType: "acceptance",
        satisfies: ACTIVE_CRITERIA,
      }, { weakCliOnly: true });
      const nodeDir = join(fx.session, "nodes", "test-execute");
      writeFileSync(join(nodeDir, "run_1", "forged-pass.json"), `${JSON.stringify({
        command: "node --test forged", exitCode: 0, tests_run: 1, failures: 0,
      })}\n`);
      rewriteAuthoritativeHandshake(fx, "test-execute", handshake => {
        handshake.artifacts = [{ type: "test-result", path: "run_1/forged-pass.json" }];
      });
      const result = run(fx, "transition", [
        "--from", "test-execute",
        "--to", "gate",
        "--verdict", "PASS",
        "--flow", "build-verify",
        "--no-extensions",
      ]);
      assert.equal(result.allowed, false, JSON.stringify(result));
      assert.match(result.reason, /OPC testCommand provenance/);
    } finally {
      cleanup(fx);
    }
  });

  await t.test("caller cannot self-sign an unexecuted PASS with the provenance ledger", () => {
    const fx = fixture("test-execute");
    try {
      writeExecuteHandshake(fx, {
        scenarioId: "SCENARIO-1",
        validatorType: "acceptance",
        satisfies: ACTIVE_CRITERIA,
      });
      const result = run(fx, "transition", [
        "--from", "test-execute",
        "--to", "gate",
        "--verdict", "PASS",
        "--flow", "build-verify",
        "--no-extensions",
      ]);
      assert.equal(result.allowed, false, JSON.stringify(result));
      assert.match(result.reason, /trusted harness execution boundary/);
    } finally {
      cleanup(fx);
    }
  });

  await t.test("criterion claims without the pinned integrated scenario", () => {
    const fx = fixture("test-execute");
    try {
      writeExecuteHandshake(fx, {
        validatorType: "acceptance",
        satisfies: ACTIVE_CRITERIA,
      });
      const before = readFileSync(fx.statePath);
      const result = run(fx, "transition", [
        "--from", "test-execute",
        "--to", "gate",
        "--verdict", "PASS",
        "--flow", "build-verify",
        "--no-extensions",
      ]);
      assert.equal(result.allowed, false, JSON.stringify(result));
      assert.match(result.reason, /criterion evidence requires the pinned end-to-end scenario/);
      assert.deepEqual(readFileSync(fx.statePath), before);
    } finally {
      cleanup(fx);
    }
  });

  for (const scenario of ["parent traversal", "absolute path", "stale run", "unselected newer run", "symlink", "directory"]) {
    const ignoresUnselectedRun = scenario === "unselected newer run";
    await t.test(
      ignoresUnselectedRun
        ? "integrated claims ignore artifacts from an unselected newer run"
        : `integrated claims reject ${scenario} artifacts`,
      () => {
      const fx = fixture("test-design");
      try {
        runHarnessExecute(fx, {
          scenarioId: "SCENARIO-1",
          validatorType: "acceptance",
          satisfies: ACTIVE_CRITERIA,
        });
        const nodeDir = join(fx.session, "nodes", "test-execute");
        rewriteAuthoritativeHandshake(fx, "test-execute", handshake => {
          if (scenario === "parent traversal") {
            writeFileSync(join(fx.session, "nodes", "outside.json"), '{"pass":true}\n');
            handshake.artifacts = [{ type: "test-result", path: "../outside.json" }];
          } else if (scenario === "absolute path") {
            const absolute = join(fx.source, "outside.json");
            writeFileSync(absolute, '{"pass":true}\n');
            handshake.artifacts = [{ type: "test-result", path: absolute }];
          } else if (scenario === "stale run") {
            mkdirSync(join(nodeDir, "run_0"), { recursive: true });
            writeFileSync(join(nodeDir, "run_0", "stale.json"), '{"pass":true}\n');
            handshake.artifacts = [{ type: "test-result", path: "run_0/stale.json" }];
          } else if (ignoresUnselectedRun) {
            const unselectedRunDir = join(nodeDir, "run_2");
            mkdirSync(unselectedRunDir, { recursive: true });
            writeFileSync(join(unselectedRunDir, "newer.json"), '{"pass":true}\n');
            writeFileSync(join(unselectedRunDir, "handshake.json"), `${JSON.stringify({
              ...handshake,
              runId: "run_2",
              artifacts: [{ type: "test-result", path: "newer.json" }],
            }, null, 2)}\n`);
          } else if (scenario === "symlink") {
            const outside = join(fx.source, "outside.json");
            writeFileSync(outside, '{"pass":true}\n');
            symlinkSync(outside, join(nodeDir, "run_1", "linked.json"));
            handshake.artifacts = [{ type: "test-result", path: "run_1/linked.json" }];
          } else {
            mkdirSync(join(nodeDir, "run_1", "not-a-file.json"));
            handshake.artifacts = [{ type: "test-result", path: "run_1/not-a-file.json" }];
          }
        });
        const before = readFileSync(fx.statePath);
        const result = run(fx, "transition", [
          "--from", "test-execute",
          "--to", "gate",
          "--verdict", "PASS",
          "--flow", "build-verify",
          "--no-extensions",
        ]);
        if (ignoresUnselectedRun) {
          assert.equal(result.allowed, true, result.reason || JSON.stringify(result));
          assert.equal(result.evidenceReceipt?.sourceExecution?.runId, "run_1");
          assert.ok(result.evidenceReceipt?.artifactBindings?.every(binding => binding.path.includes("/run_1/")));
        } else {
          assert.equal(result.allowed, false, JSON.stringify(result));
          assert.match(
            result.reason,
            /evidence artifact|evidence run|evidence handshake|OPC testCommand provenance|artifact .* unreadable|artifact\[\d+\]: file not found|artifact .* invalid path/,
          );
          assert.deepEqual(readFileSync(fx.statePath), before);
        }
      } finally {
        cleanup(fx);
      }
    });
  }
});

test("gate-mediated built-in reviews classify mission findings before negative mutation", async t => {
  const cases = [
    { flow: "review", reviewNode: "review", gateNode: "gate", to: "review", verdict: "ITERATE", findingClass: "GOAL_SPEC", criterion: "UNLINKED", reason: "GOAL_SPEC_FINDING" },
    { flow: "full-stack", reviewNode: "acceptance", gateNode: "gate-acceptance", to: "brief", findingClass: "PLAN", criterion: "OUT-1", reason: "PLAN_FINDING" },
    { flow: "pre-release", reviewNode: "acceptance", gateNode: "gate-acceptance", to: "acceptance", findingClass: "PLAN", criterion: "OUT-1", reason: "PLAN_FINDING" },
  ];
  for (const item of cases) {
    await t.test(item.flow, () => {
      const fx = fixture(item.gateNode, null, item.flow);
      try {
        writeMissionEval(fx, {
          nodeId: item.reviewNode,
          runId: "run_1",
          verdict: "PASS",
          finding: {
            issue: "the synthesized review exposes a mission-level risk",
            class: item.findingClass,
            criterion: item.criterion,
            findingRef: "NEW",
            fingerprint: `${item.flow}-gate-risk`,
            invariant: "A synthesized review cannot bypass the Mission trajectory gate.",
            ...(item.criterion === "UNLINKED" ? { evidence: "acceptance-criteria.md:1 documents the newly exposed protected-floor risk." } : {}),
            reasoning: "The negative gate route would otherwise mutate the graph without classifying this risk.",
            fix: "Pause at the Mission Gate and select the allowed mission-level decision.",
          },
        });
        if (item.flow === "review") {
          rewriteAuthoritativeHandshake(fx, item.reviewNode, reviewHandshake => {
            reviewHandshake.findings = { critical: 0, warning: 1, suggestion: 0 };
          });
        }
        putGateAfterReview(fx, item.reviewNode, item.gateNode);
        const result = run(fx, "transition", [
          "--from", item.gateNode,
          "--to", item.to,
          "--verdict", item.verdict || "FAIL",
          "--flow", item.flow,
          "--no-extensions",
        ]);
        assert.equal(result.allowed, false, JSON.stringify(result));
        assert.equal(result.rebet_required, true, JSON.stringify(result));
        assert.equal(result.trajectoryReason, item.reason, JSON.stringify(result));
        const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
        assert.equal(state.currentNode, item.gateNode);
        assert.equal(state.trajectory.pending, true);
        assert.equal(state.findingRegistry.length, 1);
        assert.equal(state.findingRegistry[0].criterion, item.criterion);
      } finally {
        cleanup(fx);
      }
    });
  }
});

test("gate-mediated review-quality failure blocks the negative gate edge byte-for-byte", () => {
  const fx = fixture("gate", null, "review");
  try {
    writeMissionEval(fx, {
      nodeId: "review",
      runId: "run_1",
      verdict: "PASS",
      finding: {
        issue: "the synthesized finding is missing its mission criterion",
        class: "PLAN",
        findingRef: "NEW",
        fingerprint: "gate-missing-criterion",
        invariant: "Every synthesized finding is bound before a negative gate mutation.",
        reasoning: "Without criterion metadata the gate cannot distinguish local repair from mission drift.",
        fix: "Redispatch a fresh evaluator and disposition this non-routing claim.",
      },
    });
    putGateAfterReview(fx, "review", "gate");
    const before = readFileSync(fx.statePath);
    const result = run(fx, "transition", [
      "--from", "gate", "--to", "review", "--verdict", "FAIL",
      "--flow", "review", "--no-extensions",
    ]);
    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.equal(result.reevaluate_required, true, JSON.stringify(result));
    assert.deepEqual(readFileSync(fx.statePath), before);
    assert.equal(existsSync(join(fx.session, "nodes", "review", "run_1", "review-claims.json")), true);
  } finally {
    cleanup(fx);
  }
});

test("standard review reevaluation requires disposition of every persisted invalid claim", () => {
  const fx = fixture("code-review");
  try {
    writeMissionEval(fx, {
      nodeId: "code-review",
      runId: "run_1",
      finding: {
        issue: "the finding omits its mission criterion",
        class: "ARTIFACT",
        findingRef: "NEW",
        fingerprint: "missing-criterion",
        invariant: "Every routed finding is bound to a pinned criterion.",
        reasoning: "Without a criterion the finding cannot be safely routed into mission repair.",
        fix: "Redispatch a fresh evaluator to classify and disposition this claim.",
      },
    });
    const before = readFileSync(fx.statePath);
    const first = run(fx, "transition", [
      "--from", "code-review", "--to", "build", "--verdict", "FAIL",
      "--flow", "build-verify", "--no-extensions",
    ]);
    assert.equal(first.allowed, false, JSON.stringify(first));
    assert.equal(first.reevaluate_required, true, JSON.stringify(first));
    assert.deepEqual(readFileSync(fx.statePath), before);
    const claims = JSON.parse(readFileSync(join(fx.session, "nodes", "code-review", "run_1", "review-claims.json"), "utf8"));
    assert.equal(claims.routing, false);
    assert.equal(claims.claims.length, 1);

    writeMissionEval(fx, {
      nodeId: "code-review",
      runId: "run_2",
      finding: {
        issue: "the standard transition still lacks its protected mutation check",
        class: "ARTIFACT",
        criterion: "OUT-1",
        findingRef: "NEW",
        fingerprint: "protected-transition-check",
        invariant: "Every protected transition checks Mission state before mutation.",
        reasoning: "The current transition path can reach mutation without proving the pinned gate is clear.",
        fix: "Add the protected mutation check and rerun the same standard transition test.",
      },
      disposition: {
        claimHash: claims.claims[0].claim_hash,
        disposition: "SUPERSEDE",
        fingerprint: "protected-transition-check",
      },
    });
    const second = run(fx, "transition", [
      "--from", "code-review", "--to", "build", "--verdict", "FAIL",
      "--flow", "build-verify", "--no-extensions",
    ]);
    assert.equal(second.allowed, true, second.reason || JSON.stringify(second));
    const quality = JSON.parse(readFileSync(join(fx.session, "nodes", "code-review", "run_2", "review-quality.json"), "utf8"));
    assert.equal(quality.reviewQualityOk, true);
    assert.equal(quality.claimDispositionRequired, true);
    assert.equal(quality.claimDispositionOk, true);
  } finally {
    cleanup(fx);
  }
});

test("missing invalid-claim disposition counts as the second review-quality failure", () => {
  const fx = fixture("code-review");
  try {
    writeMissionEval(fx, {
      nodeId: "code-review",
      runId: "run_1",
      finding: {
        issue: "the finding omits its mission criterion",
        class: "ARTIFACT",
        findingRef: "NEW",
        fingerprint: "missing-criterion",
        invariant: "Every routed finding is bound to a pinned criterion.",
        reasoning: "Without a criterion the finding cannot be safely routed into mission repair.",
        fix: "Redispatch a fresh evaluator to classify and disposition this claim.",
      },
    });
    const first = run(fx, "transition", [
      "--from", "code-review", "--to", "build", "--verdict", "FAIL",
      "--flow", "build-verify", "--no-extensions",
    ]);
    assert.equal(first.reevaluate_required, true, JSON.stringify(first));
    writeMissionEval(fx, {
      nodeId: "code-review",
      runId: "run_2",
      finding: {
        issue: "the corrected finding still lacks claim disposition",
        class: "ARTIFACT",
        criterion: "OUT-1",
        findingRef: "NEW",
        fingerprint: "undispositioned-claim",
        invariant: "Fresh review must disposition every invalid predecessor claim.",
        reasoning: "Valid metadata alone does not resolve the durable non-routing claim from the first review.",
        fix: "Provide an explicit CONFIRM, REJECT, or SUPERSEDE disposition with the required evidence.",
      },
    });
    const second = run(fx, "transition", [
      "--from", "code-review", "--to", "build", "--verdict", "FAIL",
      "--flow", "build-verify", "--no-extensions",
    ]);
    assert.equal(second.allowed, false, JSON.stringify(second));
    assert.equal(second.rebet_required, true, JSON.stringify(second));
    assert.equal(JSON.parse(readFileSync(fx.statePath, "utf8")).trajectory.reason, "REVIEW_QUALITY_STALL");
  } finally {
    cleanup(fx);
  }
});

test("a scope-bound standard retry is consumed by the first transition from its bound source, including PASS", () => {
  const fx = fixture("build");
  try {
    writeAuthoritativeHandshake(fx, "build", {
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "The bound retry source now passes.",
      timestamp: new Date().toISOString(),
      artifacts: [],
    });
    let state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    state.trajectory.retryAllowance = 1;
    state.trajectory.retryGrant = {
      triggerId: "TRIG-retry-pass",
      strategyEpoch: state.mission.strategyEpoch,
      scopeTokens: ["EDGE:build→code-review"],
      edgeKey: "build→code-review",
      command: "transition",
      sourceNode: "build",
      nextUnit: null,
      remaining: 1,
    };
    state = persistMissionState(fx, state, "test-retry-grant");
    const result = run(fx, "transition", [
      "--from", "build", "--to", "code-review", "--verdict", "PASS",
      "--flow", "build-verify", "--no-extensions",
    ]);
    assert.equal(result.allowed, true, result.reason || JSON.stringify(result));
    const after = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(after.trajectory.retryGrant, null);
    assert.equal(after.trajectory.retryAllowance, 0);
  } finally {
    cleanup(fx);
  }
});

test("a standard retry grant cannot authorize a transition from another source", () => {
  const fx = fixture("build");
  try {
    writeAuthoritativeHandshake(fx, "build", {
      nodeId: "build",
      nodeType: "build",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "An unrelated source attempts to use the grant.",
      timestamp: new Date().toISOString(),
      artifacts: [],
    });
    let state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    state.trajectory.retryAllowance = 1;
    state.trajectory.retryGrant = {
      triggerId: "TRIG-retry-other-source",
      strategyEpoch: state.mission.strategyEpoch,
      scopeTokens: ["EDGE:brief→build"],
      edgeKey: "brief→build",
      command: "transition",
      sourceNode: "brief",
      nextUnit: null,
      remaining: 1,
    };
    state = persistMissionState(fx, state, "test-mismatched-retry-grant");
    const before = readFileSync(fx.statePath);
    const result = run(fx, "transition", [
      "--from", "build", "--to", "code-review", "--verdict", "PASS",
      "--flow", "build-verify", "--no-extensions",
    ]);
    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /retry grant is bound to a different transition source or scope/);
    assert.deepEqual(readFileSync(fx.statePath), before);
  } finally {
    cleanup(fx);
  }
});

test("a standard retry grant cannot authorize a different target from the same source", () => {
  const fx = fixture("hotfix");
  try {
    writeAuthoritativeHandshake(fx, "hotfix", {
      nodeId: "hotfix",
      nodeType: "hotfix",
      runId: "run_1",
      status: "completed",
      verdict: "PASS",
      summary: "The same source attempts a target outside its sealed retry edge.",
      timestamp: new Date().toISOString(),
      artifacts: [],
      hotfix: {
        scope: "trivial",
        allowedOperations: ["retry-origin regression fixture"],
        structuralChange: false,
        forbiddenOperations: [],
      },
    });
    const sourceNode = "test-design";
    const sourceRunId = "run_1";
    const sourceRunDir = join(fx.session, "nodes", sourceNode, sourceRunId);
    mkdirSync(sourceRunDir, { recursive: true });
    writeFileSync(join(sourceRunDir, "test-plan.md"), [
      "# Retry-origin test plan",
      "",
      "Run the exact test command bound to the historical test-design run.",
      "",
    ].join("\n"));
    writeFileSync(join(sourceRunDir, "test-execution.json"), `${JSON.stringify({
      nodeId: sourceNode,
      runId: sourceRunId,
      testCommand: "node --eval 'process.exit(0)'",
      cwd: fx.source,
      timeoutMs: 30_000,
    }, null, 2)}\n`);
    writeAuthoritativeHandshake(fx, sourceNode, {
      nodeId: sourceNode,
      nodeType: "review",
      runId: sourceRunId,
      status: "completed",
      verdict: "PASS",
      summary: "Historical test-design authority for the hotfix retest.",
      timestamp: new Date().toISOString(),
      artifacts: [{ type: "test-plan", path: `${sourceRunId}/test-plan.md` }],
    });
    let state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    const now = new Date().toISOString();
    state.history = [
      { nodeId: sourceNode, runId: sourceRunId, timestamp: now },
      { nodeId: "hotfix", runId: "run_1", timestamp: now },
    ];
    state.totalSteps = 1;
    state.trajectory.retryAllowance = 1;
    state.trajectory.retryGrant = {
      triggerId: "TRIG-retry-other-target",
      strategyEpoch: state.mission.strategyEpoch,
      scopeTokens: ["EDGE:hotfix→brief"],
      edgeKey: "hotfix→brief",
      command: "transition",
      sourceNode: "hotfix",
      nextUnit: null,
      remaining: 1,
    };
    state = persistMissionState(fx, state, "test-mismatched-retry-target");
    const before = readFileSync(fx.statePath);
    const result = run(fx, "transition", [
      "--from", "hotfix", "--to", "test-execute", "--verdict", "PASS",
      "--flow", "build-verify", "--no-extensions",
    ]);
    assert.equal(result.allowed, false, JSON.stringify(result));
    assert.match(result.reason, /retry grant is bound to a different transition source or scope/);
    assert.deepEqual(readFileSync(fx.statePath), before);
    const after = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(after.trajectory.retryGrant.remaining, 1);
    assert.equal(after.trajectory.retryGrant.edgeKey, "hotfix→brief");
  } finally {
    cleanup(fx);
  }
});

test("record-mission-review seals an unsigned cold review accepted by STOP_SALVAGE", () => {
  const fx = fixture("code-review");
  try {
    const pendingState = openPlanGate(fx);
    const unsignedPath = join(fx.source, "unsigned-cold-review.json");
    writeFileSync(unsignedPath, `${JSON.stringify({
      schemaVersion: 1,
      triggerId: pendingState.trajectory.triggerId,
      reviewer: {
        runId: pendingState.trajectory.pendingPacket.reviewRequest.runId,
        contextMode: "cold",
      },
      bindings: pendingState.trajectory.pendingPacket.bindings,
      classification: "PLAN",
      realitySignals: [{ id: "SIG-1", status: "INSUFFICIENT", evidenceReceiptIds: [] }],
      recommendation: "STOP_SALVAGE",
      rationale: "Stopping preserves the last valid state after independently checking the frozen mission and current decomposition.",
      localFixesIncluded: false,
      reviewedAt: new Date().toISOString(),
    }, null, 2)}\n`);

    const recorded = run(fx, "record-mission-review", ["--review", unsignedPath]);
    assert.equal(recorded.recorded, true, recorded.error || JSON.stringify(recorded));
    assert.equal(existsSync(recorded.review), true);
    const sealedReview = JSON.parse(readFileSync(recorded.review, "utf8"));
    assert.match(sealedReview.reviewer.provenanceRecordHash, /^[a-f0-9]{64}$/);
    assert.equal(sealedReview.reviewer.provenanceRecordHash, recorded.provenance_record_hash);

    const decided = run(fx, "mission-decision", [
      "--action", "STOP_SALVAGE",
      "--actor", "agent",
      "--review", recorded.review,
    ]);
    assert.equal(decided.decided, true, decided.error || JSON.stringify(decided));
    assert.equal(decided.pending, false);
    assert.equal(decided.retry_allowance, 0);
    const decidedState = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(decidedState.trajectory.pending, false);
    assert.equal(decidedState.trajectory.retryAllowance, 0);
    assert.equal(decidedState.trajectory.lastDecision.action, "STOP_SALVAGE");
  } finally {
    cleanup(fx);
  }
});
