import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sealMissionRuntimeState } from "./mission-contract.mjs";

const HARNESS = resolve("bin/opc-harness.mjs");

function mission() {
  return {
    schemaVersion: 1,
    version: 1,
    owner: "Loop mission owner",
    affectedParties: ["Users", "Maintainers"],
    mode: "explore",
    originalRequest: "Stop repeated local repairs before the loop loses the global outcome.",
    outcomes: [
      { id: "OUT-1", statement: "The first artifact failure may proceed to one bounded local repair." },
      { id: "OUT-2", statement: "The second canonical failure opens a Mission Gate before another unit claim." },
      { id: "OUT-3", statement: "An end-to-end trigger preserves the committed loop cursor while paused." },
    ],
    retiredCriteria: [],
    protectedFloors: [{ id: "FLOOR-1", statement: "Mission-less loop behavior remains unchanged." }],
    nonGoals: ["Automatic evidence-graph construction"],
    appetite: { maxRepairCycles: 8, maxTokens: null, maxWallTimeHours: null, expiresAt: null },
    endToEndScenario: {
      id: "SCENARIO-1",
      statement: "Run two reviews of one invariant and observe the second trajectory gate.",
      validatorTypes: ["e2e", "acceptance"],
    },
    realitySignals: [{ id: "SIG-1", required: true, observation: "The cursor is unchanged when the gate opens." }],
    guardrails: [{ id: "GUARD-1", metric: "Retry count", actionThreshold: "Pause before a third patch." }],
    checkpoints: [{ type: "before_finalize" }],
    assumptions: [{ id: "ASM-1", statement: "Review artifacts are readable.", freshUntil: null }],
    exitAndSalvage: "Keep the finding registry and reviewed artifacts.",
  };
}

function criteria(contract = mission()) {
  return [
    "## Outcomes",
    ...contract.outcomes.map(outcome => `- ${outcome.id}: ${outcome.statement}`),
    "",
    "## Verification",
    "- OUT-1: A CLI test completes one review and claims the next unit.",
    "- OUT-2: A CLI test repeats FIND-1 and asserts rebet_required before another claim.",
    "- OUT-3: An end-to-end trigger compares the cursor before and after the gate.",
    "",
    "## Quality Constraints",
    "- State mutation is atomic and deterministic.",
    "",
    "## Out of Scope",
    "- Automatic evidence-graph construction.",
    "",
    "## Quality Baseline (functional)",
    "- Deterministic CLI verification.",
    "",
  ].join("\n");
}

function plan() {
  return [
    "## Task Scope",
    "- SCOPE-1: stop repeated local repair loops",
    "",
    "## Units",
    "- F1.1: review — inspect the first local repair invariant",
    "  - eval: classify the invariant against OUT-2",
    "- F1.2: review — inspect the repeated local repair invariant",
    "  - eval: classify the invariant against OUT-2",
    "- F1.3: e2e — verify the paused cursor",
    "  - verify: node -e \"console.log('OPC_ORACLE '+JSON.stringify({checks:[{id:'scenario',pass:true,total:1}]}))\"",
    "  - scenario: SCENARIO-1",
    "  - validator-type: e2e",
    "  - satisfies: OUT-1,OUT-2,OUT-3,FLOOR-1",
    "",
  ].join("\n");
}

function fixture(prefix = "mission-loop-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const source = join(dir, "source");
  mkdirSync(source);
  const missionPath = join(source, "mission.json");
  writeFileSync(missionPath, `${JSON.stringify(mission(), null, 2)}\n`);
  writeFileSync(join(dir, "acceptance-criteria.md"), criteria());
  writeFileSync(join(dir, "plan.md"), plan());
  return { dir, missionPath };
}

function cleanup(root) {
  if (!existsSync(root)) return;
  const makeWritable = path => {
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      chmodSync(path, 0o600);
      return;
    }
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  };
  makeWritable(root);
  rmSync(root, { recursive: true, force: true });
}

function run(dir, args, { cwd = dir } = {}) {
  const childEnv = { ...process.env, OPC_DISABLE_EXTENSIONS: "1" };
  // The harness verifier is an independent process.  Keeping this marker
  // makes `node --test` think it is recursively invoking the current file.
  delete childEnv.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, [HARNESS, ...args, "--dir", dir], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
  return JSON.parse(output.trim().split("\n").at(-1));
}

function persistMissionState(dir, state, reason) {
  const statePath = join(dir, "loop-state.json");
  const sealed = sealMissionRuntimeState({ sessionDir: dir, state, statePath, reason });
  assert.equal(sealed.ok, true, sealed.error);
  return sealed.state;
}

function writeReview(dir, prefix, findingClass = "ARTIFACT", criterion = "OUT-2") {
  const paths = [];
  for (const role of ["owner", "engineer"]) {
    const path = join(dir, `${prefix}-${role}.md`);
    writeFileSync(path, [
      `# ${role} trajectory review`,
      `Role: ${role}-${prefix}`,
      "",
      `## ${role} evidence`,
      `The ${role} independently reproduced the persisted checkout invariant.`,
      "",
      "🔴 src/cart.mjs:42 — checkout total diverges from the persisted order",
      "Reasoning: the same observable invariant fails after the prior reviewed attempt",
      "→ Fix: route at the mission level before authorizing another local mutation",
      `class: ${findingClass}`,
      `criterion: ${criterion}`,
      "finding_ref: NEW",
      "fingerprint: checkout-total-persistence",
      "invariant: Displayed checkout total equals the persisted order total.",
      "evidence: A clean persisted-order replay reproduces the displayed-total mismatch.",
      "",
      "VERDICT: FAIL FINDINGS[1]",
      "",
    ].join("\n"));
    paths.push(path);
  }
  return paths;
}

function writeMalformedReview(dir, prefix) {
  const owner = join(dir, `${prefix}-owner.md`);
  const engineer = join(dir, `${prefix}-engineer.md`);
  writeFileSync(owner, [
    "# Owner outcome review",
    "Role: outcome-owner",
    "",
    "🔴 src/cart.mjs:42 — persisted checkout total diverges from the displayed order",
    "Reasoning: the observable total is wrong, but this review intentionally omits mission routing metadata",
    "→ Fix: obtain a fresh independently structured review",
    "",
    "VERDICT: FAIL FINDINGS[1]",
    "",
  ].join("\n"));
  writeFileSync(engineer, [
    "# Runtime reproduction",
    "Role: independent-runtime-engineer",
    "",
    "🔴 src/checkout.mjs:87 — replaying the stored order produces a different displayed amount",
    "Reasoning: a clean replay reproduces the mismatch; required criterion and finding identity fields are absent",
    "→ Fix: rerun the evaluator with the Mission Context schema",
    "",
    "VERDICT: FAIL FINDINGS[1]",
    "",
  ].join("\n"));
  return [owner, engineer];
}

function writeClaimDispositions(
  dir,
  claims,
  disposition,
  { extra = [], duplicate = false, schemaVersion = 1 } = {},
) {
  const dispositions = claims.map(claim => ({
    claimHash: claim.claim_hash,
    disposition,
    ...(disposition === "REJECT"
      ? { evidence: `independent replay rejects claim ${claim.claim_hash}` }
      : { fingerprint: "checkout-total-persistence" }),
  }));
  if (duplicate && dispositions[0]) dispositions.push({ ...dispositions[0] });
  dispositions.push(...extra);
  const path = join(dir, "review-claim-dispositions.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion, dispositions }, null, 2)}\n`);
  return path;
}

test("loop opens the Mission Gate on the second canonical finding before claim or stall handling", () => {
  const fx = fixture();
  try {
    const initialized = run(fx.dir, ["init-loop", "--mission", fx.missionPath]);
    assert.equal(initialized.initialized, true, initialized.errors?.join("\n"));
    assert.equal(initialized.mission_enabled, true);
    assert.equal(initialized.mission_version, 1);
    assert.equal(initialized.strategy_epoch, 1);
    assert.equal(realpathSync(initialized.mission_contract), realpathSync(join(fx.dir, "mission-contract.json")));

    const firstClaim = run(fx.dir, ["next-tick"]);
    assert.equal(firstClaim.ready, true);
    assert.equal(firstClaim.next_unit, "F1.1");
    const firstReview = writeReview(fx.dir, "first");
    const firstComplete = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", firstReview.join(","),
      "--description", "first canonical failure reviewed",
    ]);
    assert.equal(firstComplete.completed, true, firstComplete.errors?.join("\n"));

    const secondClaim = run(fx.dir, ["next-tick"]);
    assert.equal(secondClaim.ready, true);
    assert.equal(secondClaim.next_unit, "F1.2");
    const secondReview = writeReview(fx.dir, "second");
    const secondComplete = run(fx.dir, [
      "complete-tick", "--unit", "F1.2", "--artifacts", secondReview.join(","),
      "--description", "same invariant failed after one bounded attempt",
    ]);
    assert.equal(secondComplete.completed, true, secondComplete.errors?.join("\n"));

    const before = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(before.tick, 2);
    assert.equal(before.next_unit, "F1.3");
    const gated = run(fx.dir, ["next-tick"]);
    assert.equal(gated.rebet_required, true);
    assert.match(gated.reason, /REPEATED_CANONICAL_FINDING/);

    const after = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(after.tick, 2);
    assert.equal(after.next_unit, "F1.3");
    assert.equal(after.status, "mission_pending");
    assert.equal(after.trajectory.pending, true);
    assert.equal(existsSync(join(fx.dir, "trajectory-review-request.json")), true);

    const blocked = run(fx.dir, ["next-tick"]);
    assert.equal(blocked.rebet_required, true);
    assert.match(blocked.reason, /pending Mission Gate/);
  } finally {
    cleanup(fx.dir);
  }
});

test("PLAN findings gate immediately and never enter the artifact backlog", () => {
  const fx = fixture("mission-loop-plan-");
  try {
    assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
    assert.equal(run(fx.dir, ["next-tick"]).ready, true);
    const reviews = writeReview(fx.dir, "plan", "PLAN");
    const completed = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", reviews.join(","),
      "--description", "the decomposition cannot satisfy the frozen outcome",
    ]);
    assert.equal(completed.completed, true, completed.errors?.join("\n"));
    const gated = run(fx.dir, ["next-tick"]);
    assert.equal(gated.rebet_required, true);
    assert.match(gated.reason, /PLAN_FINDING/);
    const backlog = existsSync(join(fx.dir, "backlog.md"))
      ? readFileSync(join(fx.dir, "backlog.md"), "utf8")
      : "";
    assert.doesNotMatch(backlog, /PLAN/);
    assert.match(readFileSync(join(fx.dir, "mission-deferred-findings.md"), "utf8"), /PLAN\/OUT-2/);
  } finally {
    cleanup(fx.dir);
  }
});

test("an evidenced GOAL_SPEC UNLINKED floor risk opens a human-only gate", () => {
  const fx = fixture("mission-loop-unlinked-floor-");
  try {
    assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
    assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.1");
    const reviews = writeReview(fx.dir, "unlinked-floor", "GOAL_SPEC", "UNLINKED");
    const completed = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", reviews.join(","),
      "--description", "evidence exposes a protected-floor risk absent from the frozen criteria",
    ]);
    assert.equal(completed.completed, true, completed.errors?.join("\n"));
    const gated = run(fx.dir, ["next-tick"]);
    assert.equal(gated.rebet_required, true);
    assert.match(gated.reason, /GOAL_SPEC_FINDING/);
    const state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(state.trajectory.pendingPacket.retryable, false);
    assert.match(
      readFileSync(join(fx.dir, "mission-deferred-findings.md"), "utf8"),
      /GOAL_SPEC\/UNLINKED/,
    );
  } finally {
    cleanup(fx.dir);
  }
});

test("two malformed loop review batches open REVIEW_QUALITY_STALL without advancing", () => {
  const fx = fixture("mission-loop-quality-");
  try {
    assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
    assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.1");
    const first = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", writeMalformedReview(fx.dir, "bad-1").join(","),
      "--description", "first malformed review batch",
    ]);
    assert.equal(first.completed, false);
    assert.equal(first.review_quality_ok, false);
    assert.equal(first.reevaluate_required, true);
    assert.equal(existsSync(first.claims), true);
    let state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(state.tick, 0);
    assert.equal(state.next_unit, "F1.1");
    assert.equal(state.trajectory.reviewQualityFailures, 1);

    const second = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", writeMalformedReview(fx.dir, "bad-2").join(","),
      "--description", "second malformed review batch",
    ]);
    assert.equal(second.completed, false);
    assert.equal(second.rebet_required, true);
    assert.equal(second.reason, "REVIEW_QUALITY_STALL");
    assert.equal(existsSync(second.claims), true);
    assert.notEqual(second.claims, first.claims);
    state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(state.tick, 0);
    assert.equal(state.next_unit, "F1.1");
    assert.equal(state.status, "mission_pending");
    assert.equal(state.trajectory.pending, true);
    assert.equal(state.trajectory.reviewQualityClaimArtifacts.length, 2);
    assert.equal(existsSync(join(fx.dir, "trajectory-review-request.json")), true);
    const packet = JSON.parse(readFileSync(join(fx.dir, "trajectory-review-request.json"), "utf8"));
    assert.equal(packet.mission.owner, mission().owner);
    assert.deepEqual(packet.mission.affectedParties, mission().affectedParties);
    assert.deepEqual(packet.mission.guardrails, mission().guardrails);
    assert.equal(packet.mission.exitAndSalvage, mission().exitAndSalvage);
    assert.deepEqual(packet.mission.assumptions, mission().assumptions);
    const declaredPaths = packet.artifactSummary.declaredEntries.map(entry => entry.path);
    assert.equal(declaredPaths.includes(first.claims), true);
    assert.equal(declaredPaths.includes(second.claims), true);
  } finally {
    cleanup(fx.dir);
  }
});

test("an unrelated artifact error cannot clear the invalid-review reevaluation bound", () => {
  const fx = fixture("mission-loop-quality-reset-");
  try {
    assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
    assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.1");
    const first = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", writeMalformedReview(fx.dir, "bad-a").join(","),
      "--description", "first malformed review batch",
    ]);
    assert.equal(first.reevaluate_required, true);

    const oneOtherwiseValidReview = writeReview(fx.dir, "one-file")[0];
    const structuralError = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", oneOtherwiseValidReview,
      "--description", "incomplete review batch",
    ]);
    assert.equal(structuralError.completed, false);
    assert.match(structuralError.errors.join("; "), /need ≥2/);
    assert.equal(
      JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8")).trajectory.reviewQualityFailures,
      1,
    );

    const second = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", writeMalformedReview(fx.dir, "bad-b").join(","),
      "--description", "second malformed review batch",
    ]);
    assert.equal(second.rebet_required, true);
    assert.equal(second.reason, "REVIEW_QUALITY_STALL");
  } finally {
    cleanup(fx.dir);
  }
});

test("a fresh loop review without dispositions cannot discard retained invalid-review claims", () => {
  const fx = fixture("mission-loop-quality-disposition-missing-");
  try {
    assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
    assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.1");
    const first = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", writeMalformedReview(fx.dir, "bad-first").join(","),
      "--description", "retain malformed review claims for one bounded reevaluation",
    ]);
    assert.equal(first.reevaluate_required, true);
    const retainedClaims = JSON.parse(readFileSync(first.claims, "utf8")).claims;
    assert.ok(retainedClaims.length > 0);

    const retried = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", writeReview(fx.dir, "fresh-without-dispositions").join(","),
      "--description", "fresh review omitted mandatory treatment of prior claims",
    ]);
    assert.equal(retried.completed, false);
    assert.equal(retried.rebet_required, true);
    assert.equal(retried.reason, "REVIEW_QUALITY_STALL");
    assert.match(retried.errors.join("; "), /must provide review-claim-dispositions\.json/);
    const state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(state.trajectory.reviewQualityDisposition.required, true);
    assert.equal(state.trajectory.reviewQualityDisposition.ok, false);
    assert.equal(state.trajectory.reviewQualityClaims.length, retainedClaims.length);
  } finally {
    cleanup(fx.dir);
  }
});

for (const disposition of ["CONFIRM", "SUPERSEDE", "REJECT"]) {
  test(`a fresh loop review may ${disposition} every retained invalid-review claim`, () => {
    const fx = fixture(`mission-loop-quality-disposition-${disposition.toLowerCase()}-`);
    try {
      assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
      assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.1");
      const first = run(fx.dir, [
        "complete-tick", "--unit", "F1.1", "--artifacts", writeMalformedReview(fx.dir, "bad-first").join(","),
        "--description", "retain malformed review claims for one bounded reevaluation",
      ]);
      assert.equal(first.reevaluate_required, true);
      const retainedClaims = JSON.parse(readFileSync(first.claims, "utf8")).claims;
      assert.ok(retainedClaims.length > 0);

      const freshReviews = writeReview(fx.dir, `fresh-${disposition.toLowerCase()}`);
      const dispositionPath = writeClaimDispositions(fx.dir, retainedClaims, disposition);
      const retried = run(fx.dir, [
        "complete-tick", "--unit", "F1.1", "--artifacts", freshReviews.join(","),
        "--description", `${disposition} every retained invalid-review claim against fresh evidence`,
      ]);
      assert.equal(retried.completed, true, retried.errors?.join("\n"));
      const state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
      assert.equal(state.trajectory.reviewQualityDisposition.required, true);
      assert.equal(state.trajectory.reviewQualityDisposition.ok, true);
      assert.equal(state.trajectory.reviewQualityDisposition.dispositionedClaimHashes.length, retainedClaims.length);
      assert.equal(state.trajectory.reviewQualityFailures, 0);
      assert.deepEqual(state.trajectory.reviewQualityClaims, []);
      assert.equal(state.declaredArtifacts.includes(realpathSync(dispositionPath)), true);
    } finally {
      cleanup(fx.dir);
    }
  });
}

for (const variant of ["unknown", "duplicate", "schema version"]) {
  test(`loop claim dispositions reject ${variant} claim entries`, () => {
    const fx = fixture(`mission-loop-quality-disposition-${variant}-`);
    try {
      assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
      assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.1");
      const first = run(fx.dir, [
        "complete-tick", "--unit", "F1.1", "--artifacts", writeMalformedReview(fx.dir, "bad-first").join(","),
        "--description", "retain malformed review claims for one bounded reevaluation",
      ]);
      const retainedClaims = JSON.parse(readFileSync(first.claims, "utf8")).claims;
      const freshReviews = writeReview(fx.dir, `fresh-${variant}`);
      writeClaimDispositions(fx.dir, retainedClaims, "REJECT", variant === "duplicate"
        ? { duplicate: true }
        : variant === "schema version"
          ? { schemaVersion: 2 }
          : {
            extra: [{
              claimHash: "f".repeat(64),
              disposition: "REJECT",
              evidence: "this entry does not correspond to a retained claim",
            }],
          });
      const retried = run(fx.dir, [
        "complete-tick", "--unit", "F1.1", "--artifacts", freshReviews.join(","),
        "--description", `reject a ${variant} claim disposition entry`,
      ]);
      assert.equal(retried.completed, false);
      assert.equal(retried.rebet_required, true);
      assert.equal(retried.reason, "REVIEW_QUALITY_STALL");
      assert.match(
        retried.errors.join("; "),
        variant === "duplicate"
          ? /more than one disposition/
          : variant === "schema version"
            ? /schemaVersion must equal 1/
            : /unknown claim hash/,
      );
      const state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
      assert.equal(state.trajectory.reviewQualityDisposition.required, true);
      assert.equal(state.trajectory.reviewQualityDisposition.ok, false);
    } finally {
      cleanup(fx.dir);
    }
  });
}

test("a stale loop claim-disposition artifact cannot clear retained invalid-review claims", () => {
  const fx = fixture("mission-loop-quality-disposition-stale-");
  try {
    assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
    assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.1");
    const first = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", writeMalformedReview(fx.dir, "bad-first").join(","),
      "--description", "retain malformed review claims for one bounded reevaluation",
    ]);
    const retainedClaims = JSON.parse(readFileSync(first.claims, "utf8")).claims;
    const freshReviews = writeReview(fx.dir, "fresh-with-stale-dispositions");
    const dispositionPath = writeClaimDispositions(fx.dir, retainedClaims, "REJECT");
    const old = new Date(Date.now() - 60_000);
    utimesSync(dispositionPath, old, old);

    const retried = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", freshReviews.join(","),
      "--description", "reject stale claim-disposition evidence",
    ]);
    assert.equal(retried.completed, false);
    assert.equal(retried.rebet_required, true);
    assert.match(retried.errors.join("; "), /claim-dispositions\.json is stale/);
    const state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(state.trajectory.reviewQualityDisposition.ok, false);
  } finally {
    cleanup(fx.dir);
  }
});

test("loop integrated evidence records explicit mission criteria", () => {
  const fx = fixture("mission-loop-evidence-");
  const outside = mkdtempSync(join(tmpdir(), "mission-loop-outside-evidence-"));
  try {
    writeFileSync(join(fx.dir, "plan.md"), [
      "## Task Scope",
      "- SCOPE-1: verify explicit mission criterion coverage",
      "",
      "## Units",
      "- F1.3: e2e — verify the paused cursor and frozen criteria",
      "  - verify: node -e \"const pass=require('fs').existsSync('.mission-harness-pass');console.log('OPC_ORACLE '+JSON.stringify({checks:[{id:'scenario',pass,total:1}]}));process.exit(pass?0:1)\"",
      "  - scenario: SCENARIO-1",
      "  - validator-type: e2e",
      "  - satisfies: OUT-1,OUT-2,OUT-3,FLOOR-1",
      "",
    ].join("\n"));
    assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
    const statePath = join(fx.dir, "loop-state.json");
    const unclaimedEvidence = join(fx.dir, "unclaimed-evidence.json");
    writeFileSync(unclaimedEvidence, `${JSON.stringify({
      _command: "node --test unclaimed.mjs", exitCode: 0, tests_run: 1, failures: 0,
    })}\n`);
    const unclaimed = run(fx.dir, [
      "complete-tick", "--unit", "F1.3", "--artifacts", unclaimedEvidence,
      "--description", "attempt integrated coverage before claiming the unit",
      "--scenario", "SCENARIO-1", "--validator-type", "e2e",
      "--satisfies", "OUT-1,OUT-2,OUT-3,FLOOR-1", "--skip-scope-check",
    ]);
    assert.equal(unclaimed.completed, false);
    assert.match(unclaimed.errors.join("; "), /requires the current unit to be claimed/);

    assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.3");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const deliverable = join(fx.dir, "declared-deliverable.txt");
    writeFileSync(deliverable, "reviewed deliverable\n");
    state.artifacts = [deliverable];
    persistMissionState(fx.dir, state, "test-declared-deliverable");
    const missing = run(fx.dir, [
      "complete-tick", "--unit", "F1.3", "--artifacts", join(fx.dir, "missing-evidence.json"),
      "--description", "attempt integrated coverage without an evidence file",
      "--scenario", "SCENARIO-1", "--validator-type", "e2e",
      "--satisfies", "OUT-1,OUT-2,OUT-3,FLOOR-1", "--skip-scope-check",
    ]);
    assert.equal(missing.completed, false);
    assert.match(missing.errors.join("; "), /artifact not found/);

    const proseOnly = join(fx.dir, "prose-only-evidence.txt");
    writeFileSync(proseOnly, "scenario passed\n");
    const unverified = run(fx.dir, [
      "complete-tick", "--unit", "F1.3", "--artifacts", proseOnly,
      "--description", "attempt integrated coverage from prose alone",
      "--scenario", "SCENARIO-1", "--validator-type", "e2e",
      "--satisfies", "OUT-1,OUT-2,OUT-3,FLOOR-1", "--skip-scope-check",
    ]);
    assert.equal(unverified.completed, false);
    assert.match(unverified.errors.join("; "), /verify command.*failed/);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).evidenceReceipts.length, 0);

    const forged = join(fx.dir, "forged-pass.json");
    writeFileSync(forged, `${JSON.stringify({ pass: true })}\n`);
    const forgedResult = run(fx.dir, [
      "complete-tick", "--unit", "F1.3", "--artifacts", forged,
      "--description", "attempt integrated coverage from an unproven pass assertion",
      "--scenario", "SCENARIO-1", "--validator-type", "e2e",
      "--satisfies", "OUT-1,OUT-2,OUT-3,FLOOR-1", "--skip-scope-check",
    ]);
    assert.equal(forgedResult.completed, false);
    assert.match(forgedResult.errors.join("; "), /verify command.*failed/);

    const outsideEvidence = join(outside, "outside-pass.json");
    writeFileSync(outsideEvidence, `${JSON.stringify({
      _command: "node --test outside.mjs", exitCode: 0, tests_run: 1, failures: 0,
    })}\n`);
    const escaped = run(fx.dir, [
      "complete-tick", "--unit", "F1.3", "--artifacts", outsideEvidence,
      "--description", "attempt integrated coverage from another session",
      "--scenario", "SCENARIO-1", "--validator-type", "e2e",
      "--satisfies", "OUT-1,OUT-2,OUT-3,FLOOR-1", "--skip-scope-check",
    ]);
    assert.equal(escaped.completed, false);
    assert.match(escaped.errors.join("; "), /escapes the loop session/);

    const stale = join(fx.dir, "stale-pass.json");
    writeFileSync(stale, `${JSON.stringify({
      _command: "node --test stale.mjs", exitCode: 0, tests_run: 1, failures: 0,
    })}\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(stale, old, old);
    const staleResult = run(fx.dir, [
      "complete-tick", "--unit", "F1.3", "--artifacts", stale,
      "--description", "attempt integrated coverage from a prior tick",
      "--scenario", "SCENARIO-1", "--validator-type", "e2e",
      "--satisfies", "OUT-1,OUT-2,OUT-3,FLOOR-1", "--skip-scope-check",
    ]);
    assert.equal(staleResult.completed, false);
    assert.match(staleResult.errors.join("; "), /is stale/);

    const symlinked = join(fx.dir, "symlink-pass.json");
    symlinkSync(outsideEvidence, symlinked);
    const symlinkResult = run(fx.dir, [
      "complete-tick", "--unit", "F1.3", "--artifacts", symlinked,
      "--description", "attempt integrated coverage through a symlink",
      "--scenario", "SCENARIO-1", "--validator-type", "e2e",
      "--satisfies", "OUT-1,OUT-2,OUT-3,FLOOR-1", "--skip-scope-check",
    ]);
    assert.equal(symlinkResult.completed, false);
    assert.match(symlinkResult.errors.join("; "), /symbolic link/);

    const relabeled = run(fx.dir, [
      "complete-tick", "--unit", "F1.3", "--artifacts", proseOnly,
      "--description", "attempt to relabel the pinned verifier to a criterion subset",
      "--scenario", "SCENARIO-1", "--validator-type", "e2e",
      "--satisfies", "OUT-1,OUT-2", "--skip-scope-check",
    ]);
    assert.equal(relabeled.completed, false);
    assert.match(relabeled.errors.join("; "), /exactly match.*frozen mapping/);

    const evidence = join(fx.dir, "integrated-evidence.json");
    writeFileSync(evidence, `${JSON.stringify({
      _command: "node --test bin/lib/mission-loop-integration.test.mjs",
      exitCode: 0,
      tests_run: 1,
      passed: 1,
      failures: 0,
      durationMs: 1,
    }, null, 2)}\n`);
    writeFileSync(join(fx.dir, ".mission-harness-pass"), "allow pinned verifier to pass\n");

    const completed = run(fx.dir, [
      "complete-tick", "--unit", "F1.3", "--artifacts", evidence,
      "--description", "integrated mission scenario passed with full criterion coverage",
      "--scenario", "SCENARIO-1", "--validator-type", "e2e",
      "--satisfies", "OUT-1,OUT-2,OUT-3,FLOOR-1", "--skip-scope-check",
    ]);
    assert.equal(completed.completed, true, completed.errors?.join("\n"));
    assert.equal(completed.terminate, false);
    assert.equal(completed.final_review_pending, true);
    assert.equal(completed.evidence_receipt.scope, "integrated");
    assert.deepEqual(completed.evidence_receipt.satisfies, ["OUT-1", "OUT-2", "OUT-3", "FLOOR-1"]);
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(after.evidenceReceipts.at(-1).satisfies, completed.evidence_receipt.satisfies);
    assert.equal(after.currentArtifacts.includes(realpathSync(evidence)), true);
    assert.equal(after.currentArtifacts.some(path => /integrated-F1-3\.log$/.test(path)), true);
    assert.equal(after.artifacts.includes(deliverable), true);
    assert.equal(after.artifacts.includes(realpathSync(evidence)), true);
    const harnessLog = after.evidenceReceipts.at(-1).artifactBindings
      .find(binding => binding.proof === "opc-loop-verify").path;
    writeFileSync(harnessLog, readFileSync(harnessLog, "utf8").replace("# Exit code: 0", "# Exit code: 1"));
    const finalGate = run(fx.dir, ["next-tick"]);
    assert.equal(finalGate.rebet_required, true);
    assert.match(finalGate.reason, /final cold Mission review/);
    assert.equal(
      JSON.parse(readFileSync(statePath, "utf8")).trajectory.pendingPacket.reason,
      "FINAL_REVIEW_REQUIRED",
    );
    const gatedState = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(gatedState.evidenceReceipts.at(-1).stale, true);
    assert.equal(gatedState.trajectory.pendingPacket.validatorSummary.currentIntegratedPassCount, 0);
  } finally {
    cleanup(fx.dir);
    cleanup(outside);
  }
});

test("loop copied caller JSON cannot replace the fresh harness-owned verifier result", () => {
  const fx = fixture("mission-loop-reused-evidence-");
  try {
    writeFileSync(join(fx.dir, "plan.md"), [
      "## Task Scope",
      "- SCOPE-1: verify fresh integrated evidence",
      "",
      "## Units",
      "- F1.1: e2e — verify the first integrated slice",
      "  - verify: node -e \"console.log('OPC_ORACLE '+JSON.stringify({checks:[{id:'first',pass:true,total:1}]}))\"",
      "  - scenario: SCENARIO-1",
      "  - validator-type: e2e",
      "  - satisfies: OUT-1,OUT-2,OUT-3,FLOOR-1",
      "- F1.2: e2e — verify the second integrated slice",
      "  - verify: node -e \"console.log('OPC_ORACLE '+JSON.stringify({checks:[{id:'second',pass:true,total:1}]}))\"",
      "  - scenario: SCENARIO-1",
      "  - validator-type: e2e",
      "  - satisfies: OUT-1,OUT-2,OUT-3,FLOOR-1",
      "",
    ].join("\n"));
    assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
    assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.1");
    const resultBody = `${JSON.stringify({
      _command: "node --test scenario.mjs",
      exitCode: 0,
      tests_run: 1,
      passed: 1,
      failures: 0,
      durationMs: 1,
    }, null, 2)}\n`;
    const firstEvidence = join(fx.dir, "first-result.json");
    writeFileSync(firstEvidence, resultBody);
    assert.equal(run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", firstEvidence,
      "--description", "first fresh scenario execution",
      "--scenario", "SCENARIO-1", "--validator-type", "e2e",
      "--satisfies", "OUT-1,OUT-2,OUT-3,FLOOR-1",
    ]).completed, true);

    assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.2");
    const reusedEvidence = join(fx.dir, "reused-result.json");
    writeFileSync(reusedEvidence, resultBody);
    const reused = run(fx.dir, [
      "complete-tick", "--unit", "F1.2", "--artifacts", reusedEvidence,
      "--description", "copied prior result masquerading as a new run",
      "--scenario", "SCENARIO-1", "--validator-type", "e2e",
      "--satisfies", "OUT-1,OUT-2,OUT-3,FLOOR-1", "--skip-scope-check",
    ]);
    assert.equal(reused.completed, true, reused.errors?.join("; "));
    const receipts = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8")).evidenceReceipts;
    assert.equal(receipts.length, 2);
    const proofHashes = receipts.map(receipt => receipt.artifactBindings.find(binding => binding.proof === "opc-loop-verify")?.sha256);
    assert.equal(proofHashes.every(Boolean), true);
    assert.notEqual(proofHashes[0], proofHashes[1]);
  } finally {
    cleanup(fx.dir);
  }
});

test("loop integrated verifier accepts non-empty TAP but rejects vacuous exit zero", async t => {
  for (const mode of ["tap", "vacuous"]) {
    await t.test(mode, () => {
      const fx = fixture(`mission-loop-oracle-${mode}-`);
      try {
        const verifier = join(fx.dir, "scenario.test.mjs");
        writeFileSync(verifier, [
          'import test from "node:test";',
          'import assert from "node:assert/strict";',
          'test("observable scenario", () => assert.equal("persisted", "persisted"));',
          "",
        ].join("\n"));
        const command = mode === "tap" ? `node --test ${JSON.stringify(verifier)}` : "true";
        writeFileSync(join(fx.dir, "plan.md"), [
          "## Task Scope",
          "- SCOPE-1: require a non-vacuous integrated oracle",
          "",
          "## Units",
          "- F1.1: e2e — execute the pinned scenario oracle",
          `  - verify: ${command}`,
          "  - scenario: SCENARIO-1",
          "  - validator-type: e2e",
          "  - satisfies: OUT-1,OUT-2,OUT-3,FLOOR-1",
          "",
        ].join("\n"));
        assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
        assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.1");
        const completed = run(fx.dir, [
          "complete-tick", "--unit", "F1.1",
          "--description", "execute the pinned non-vacuous scenario",
          "--scenario", "SCENARIO-1", "--validator-type", "e2e",
          "--satisfies", "OUT-1,OUT-2,OUT-3,FLOOR-1", "--skip-scope-check",
        ]);
        assert.equal(completed.completed, mode === "tap", JSON.stringify(completed));
        if (mode === "vacuous") assert.match(completed.errors.join("; "), /non-vacuous/);
      } finally {
        cleanup(fx.dir);
      }
    });
  }
});

test("init-loop persists the canonical Git project root when --project-dir is omitted", () => {
  const repo = mkdtempSync(join(tmpdir(), "mission-loop-project-root-"));
  try {
    execFileSync("git", ["init", "-q", repo]);
    const nested = join(repo, "packages", "feature");
    const dir = join(nested, ".harness");
    const source = join(dir, "source");
    mkdirSync(source, { recursive: true });
    const missionPath = join(source, "mission.json");
    writeFileSync(missionPath, `${JSON.stringify(mission(), null, 2)}\n`);
    writeFileSync(join(dir, "acceptance-criteria.md"), criteria());
    writeFileSync(join(dir, "plan.md"), plan());

    const initialized = run(dir, ["init-loop", "--mission", missionPath], { cwd: nested });
    assert.equal(initialized.initialized, true, initialized.errors?.join("\n"));
    const state = JSON.parse(readFileSync(join(dir, "loop-state.json"), "utf8"));
    assert.equal(state.projectDir, realpathSync(repo));
    assert.equal(state.projectRoot, realpathSync(repo));
  } finally {
    cleanup(repo);
  }
});

test("missionless init-loop creates a brand-new explicit session directory", () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "mission-loop-fresh-dir-")));
  try {
    const sessionDir = join(project, ".harness");
    const planPath = join(project, "plan.md");
    writeFileSync(planPath, [
      "- T1.1: implement — build the feature",
      "  - verify: npm test",
      "- T1.2: review — review the feature",
      "  - eval: inspect correctness",
      "",
    ].join("\n"));

    assert.equal(existsSync(sessionDir), false);
    const initialized = run(sessionDir, [
      "init-loop", "--skip-scope", "--plan", planPath,
    ], { cwd: project });
    assert.equal(initialized.initialized, true, initialized.errors?.join("\n"));
    assert.equal(initialized.mission_enabled, false);
    assert.equal(initialized.total_units, 2);
    assert.equal(existsSync(join(sessionDir, "loop-state.json")), true);
  } finally {
    cleanup(project);
  }
});

test("init-loop cannot replace completed Mission authority in the same session", () => {
  const fx = fixture("mission-loop-authority-reset-");
  try {
    assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
    const statePath = join(fx.dir, "loop-state.json");
    const ledgerPath = join(fx.dir, ".opc-provenance.jsonl");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.status = "pipeline_complete";
    persistMissionState(fx.dir, state, "test-completed-loop-authority");
    const beforeState = readFileSync(statePath);
    const beforeLedger = readFileSync(ledgerPath);

    const replacement = run(fx.dir, ["init-loop"]);
    assert.equal(replacement.initialized, false, JSON.stringify(replacement));
    assert.equal(replacement.status, "mission_authority_exists");
    assert.match(replacement.errors.join("; "), /authoritative Mission state cannot be replaced/);
    assert.deepEqual(readFileSync(statePath), beforeState);
    assert.deepEqual(readFileSync(ledgerPath), beforeLedger);

    const crossMode = run(fx.dir, ["init", "--flow", "review", "--no-extensions"]);
    assert.equal(crossMode.created, false, JSON.stringify(crossMode));
    assert.equal(crossMode.status, "mission_authority_exists");
    assert.equal(existsSync(join(fx.dir, "flow-state.json")), false);
    assert.deepEqual(readFileSync(statePath), beforeState);
    assert.deepEqual(readFileSync(ledgerPath), beforeLedger);
  } finally {
    cleanup(fx.dir);
  }
});

test("a sealed loop retry cannot be claimed by an unrelated unit", () => {
  const fx = fixture("mission-loop-retry-scope-");
  try {
    assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
    const statePath = join(fx.dir, "loop-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.trajectory.retryAllowance = 1;
    state.trajectory.activeFindings = [{ finding_ref: "FIND-1" }];
    state.trajectory.retryGrant = {
      triggerId: "TRJ-test",
      strategyEpoch: state.mission.strategyEpoch,
      scopeTokens: ["FIND-1"],
      edgeKey: null,
      command: "next-tick",
      sourceNode: null,
      nextUnit: "F9.9",
      remaining: 1,
    };
    persistMissionState(fx.dir, state, "test-mismatched-loop-retry");

    const blocked = run(fx.dir, ["next-tick"]);
    assert.equal(blocked.ready, false);
    assert.equal(blocked.rebet_required, true);
    assert.match(blocked.reason, /does not authorize unit 'F1\.1'/);
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(after.next_unit, "F1.1");
    assert.equal(after.trajectory.retryGrant.remaining, 1);
  } finally {
    cleanup(fx.dir);
  }
});

test("loop repair appetite counts completed fix cycles and gates before more work", () => {
  const fx = fixture("mission-loop-appetite-");
  try {
    const contract = JSON.parse(readFileSync(fx.missionPath, "utf8"));
    contract.appetite.maxRepairCycles = 1;
    writeFileSync(fx.missionPath, `${JSON.stringify(contract, null, 2)}\n`);
    writeFileSync(join(fx.dir, "plan.md"), [
      "## Task Scope",
      "- SCOPE-1: bound corrective work",
      "",
      "## Units",
      "- F1.1: fix — apply one bounded correction",
      "  - verify: inspect the correction",
      "- F1.2: review — reassess the corrected outcome",
      "  - eval: compare against OUT-2",
      "- F1.3: e2e — validate the mission",
      "  - verify: run the integrated scenario",
      "",
    ].join("\n"));
    assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);
    assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.1");
    assert.equal(
      JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8")).trajectory.repairCycles,
      1,
    );
    const fixEvidence = join(fx.dir, "fix-evidence.txt");
    writeFileSync(fixEvidence, "src/cart.mjs:42 corrected under FIND-1\n");
    const completed = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", fixEvidence,
      "--description", "completed the one allowed repair cycle",
    ]);
    assert.equal(completed.completed, true, completed.errors?.join("\n"));
    let state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(state.trajectory.repairCycles, 1);
    assert.equal(state.next_unit, "F1.2");

    const gated = run(fx.dir, ["next-tick"]);
    assert.equal(gated.rebet_required, true);
    assert.match(gated.reason, /REPAIR_APPETITE_REACHED/);
    state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(state.next_unit, "F1.2");
    assert.equal(state.status, "mission_pending");
    assert.equal(state.trajectory.pendingPacket.retryable, false);
  } finally {
    cleanup(fx.dir);
  }
});

test("a second different artifact finding on review→fix gates before the next fix claim", () => {
  const fx = fixture("mission-loop-repair-edge-rotation-");
  try {
    writeFileSync(join(fx.dir, "plan.md"), [
      "## Task Scope",
      "- SCOPE-1: bound whack-a-mole repair attempts",
      "",
      "## Units",
      "- F1.1: review — inspect the first artifact invariant",
      "  - eval: classify against OUT-2",
      "- F1.2: fix — apply the first bounded correction",
      "  - verify: inspect the correction",
      "- F1.3: review — inspect a different artifact invariant",
      "  - eval: classify against OUT-2",
      "- F1.4: fix — attempt another correction",
      "  - verify: inspect the next correction",
      "",
    ].join("\n"));
    assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);

    assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.1");
    const first = run(fx.dir, [
      "complete-tick", "--unit", "F1.1", "--artifacts", writeReview(fx.dir, "edge-first").join(","),
      "--description", "first artifact invariant routes to one local correction",
    ]);
    assert.equal(first.completed, true, first.errors?.join("\n"));
    assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.2");
    const fixEvidence = join(fx.dir, "first-fix.txt");
    writeFileSync(fixEvidence, "src/cart.mjs:42 addressed under the first review\n");
    assert.equal(run(fx.dir, [
      "complete-tick", "--unit", "F1.2", "--artifacts", fixEvidence,
      "--description", "completed the first correction",
    ]).completed, true);

    assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.3");
    const rotatedReviews = writeReview(fx.dir, "edge-rotated");
    for (const path of rotatedReviews) {
      const rotated = readFileSync(path, "utf8")
        .replace("checkout total diverges from the persisted order", "shipping tax diverges from the persisted invoice")
        .replace("checkout-total-persistence", "shipping-tax-persistence")
        .replace("Displayed checkout total equals the persisted order total.", "Displayed shipping tax equals the persisted invoice tax.");
      writeFileSync(path, rotated);
    }
    const second = run(fx.dir, [
      "complete-tick", "--unit", "F1.3", "--artifacts", rotatedReviews.join(","),
      "--description", "a different artifact invariant fails on the same semantic repair edge",
    ]);
    assert.equal(second.completed, true, second.errors?.join("\n"));
    let state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(state.trajectory.repairEdgeFailures["review→fix"], 2);
    assert.equal(state.trajectory.repairCycles, 1);
    assert.equal(state.next_unit, "F1.4");

    const gated = run(fx.dir, ["next-tick"]);
    assert.equal(gated.rebet_required, true, JSON.stringify(gated));
    assert.match(gated.reason, /REPEATED_REPAIR_EDGE_WITHOUT_PROGRESS/);
    state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(state.status, "mission_pending");
    assert.equal(state.next_unit, "F1.4");
    assert.equal(state.trajectory.repairCycles, 1);
  } finally {
    cleanup(fx.dir);
  }
});

test("a sealed loop retry is consumed once before the canonical finding gates again", () => {
  const fx = fixture("mission-loop-retry-");
  try {
    writeFileSync(join(fx.dir, "plan.md"), [
      "## Task Scope",
      "- SCOPE-1: prove a retry is bounded",
      "",
      "## Units",
      "- F1.1: review — observe the first invariant failure",
      "  - eval: classify against OUT-2",
      "- F1.2: review — observe the repeated invariant failure",
      "  - eval: classify against OUT-2",
      "- F1.3: review — spend the sealed retry",
      "  - eval: classify against OUT-2",
      "- F1.4: review — verify the next repeat gates again",
      "  - eval: classify against OUT-2",
      "- F1.5: e2e — validate the final mission state",
      "  - verify: inspect the trajectory packet",
      "",
    ].join("\n"));
    assert.equal(run(fx.dir, ["init-loop", "--mission", fx.missionPath]).initialized, true);

    for (const [unit, prefix] of [["F1.1", "initial"], ["F1.2", "repeated"]]) {
      assert.equal(run(fx.dir, ["next-tick"]).next_unit, unit);
      const completed = run(fx.dir, [
        "complete-tick", "--unit", unit, "--artifacts", writeReview(fx.dir, prefix).join(","),
        "--description", `${prefix} canonical invariant failure`,
      ]);
      assert.equal(completed.completed, true, completed.errors?.join("\n"));
    }
    const opened = run(fx.dir, ["next-tick"]);
    assert.equal(opened.rebet_required, true);

    let state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    const coldReviewPath = join(fx.dir, "cold-mission-review.json");
    writeFileSync(coldReviewPath, `${JSON.stringify({
      schemaVersion: 1,
      triggerId: state.trajectory.pendingPacket.triggerId,
      reviewer: { runId: state.trajectory.pendingPacket.reviewRequest.runId, contextMode: "cold" },
      bindings: state.trajectory.pendingPacket.bindings,
      classification: "ARTIFACT",
      realitySignals: [{ id: "SIG-1", status: "INSUFFICIENT", evidenceReceiptIds: [] }],
      recommendation: "CONTINUE_CURRENT",
      rationale: "One bounded retry is proportionate and preserves the frozen mission.",
      localFixesIncluded: false,
      reviewedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    const recorded = run(fx.dir, ["record-mission-review", "--review", coldReviewPath]);
    assert.equal(recorded.recorded, true, recorded.error);
    const decided = run(fx.dir, [
      "mission-decision", "--action", "CONTINUE_CURRENT", "--actor", "agent", "--review", recorded.review,
    ]);
    assert.equal(decided.decided, true, decided.error);
    state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(state.trajectory.retryAllowance, 1);
    assert.equal(state.trajectory.pendingDecision, undefined);

    const bypass = run(fx.dir, [
      "complete-tick", "--unit", "F1.3", "--artifacts", writeReview(fx.dir, "unclaimed-retry").join(","),
      "--description", "attempt to spend the retry without claiming its unit",
    ]);
    assert.equal(bypass.completed, false);
    assert.match(bypass.errors.join("; "), /must be claimed by next-tick/);
    assert.equal(
      JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8")).trajectory.retryGrant.remaining,
      1,
    );

    assert.equal(run(fx.dir, ["next-tick"]).next_unit, "F1.3");
    state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(state.trajectory.retryAllowance, 0);
    assert.equal(state.trajectory.retryGrant, null);
    assert.equal(run(fx.dir, [
      "complete-tick", "--unit", "F1.3", "--artifacts", writeReview(fx.dir, "sealed-retry").join(","),
      "--description", "the one sealed retry still reproduces the invariant",
    ]).completed, true);
    state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    assert.equal(state.trajectory.retryAllowance, 0);
    assert.equal(state.trajectory.pendingDecision.action, "OPEN_MISSION_GATE");
    const reopened = run(fx.dir, ["next-tick"]);
    assert.equal(reopened.rebet_required, true);
    assert.match(reopened.reason, /REPEATED_CANONICAL_FINDING/);
    state = JSON.parse(readFileSync(join(fx.dir, "loop-state.json"), "utf8"));
    const secondColdReviewPath = join(fx.dir, "second-cold-mission-review.json");
    writeFileSync(secondColdReviewPath, `${JSON.stringify({
      schemaVersion: 1,
      triggerId: state.trajectory.pendingPacket.triggerId,
      reviewer: { runId: "cold-loop-retry-review-2", contextMode: "cold" },
      bindings: state.trajectory.pendingPacket.bindings,
      classification: "PLAN",
      realitySignals: [{ id: "SIG-1", status: "INSUFFICIENT", evidenceReceiptIds: [] }],
      recommendation: "RESHAPE_SMALLER",
      rationale: "The invariant persisted, so reconsider the plan.",
      localFixesIncluded: false,
      reviewedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    const secondReview = run(fx.dir, ["record-mission-review", "--review", secondColdReviewPath]);
    assert.equal(secondReview.recorded, false);
    assert.match(secondReview.error, /already received a cold review/);
  } finally {
    cleanup(fx.dir);
  }
});
