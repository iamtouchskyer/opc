import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvaluation, validateReviewClaimDispositions } from "./eval-parser.mjs";
import { buildCumulativeFindingsMarkdown } from "./cumulative-findings.mjs";

const mission = {
  outcomes: [{ id: "OUT-1" }, { id: "OUT-2" }],
  protectedFloors: [{ id: "FLOOR-1" }],
  findingRegistry: [{
    id: "FIND-7",
    fingerprint: "existing-floor-risk",
    invariant: "The protected floor remains intact.",
  }],
};

function finding(metadata, severity = "🔴") {
  return [
    `${severity} src/cart.mjs:42 — checkout total diverges from persisted value`,
    "reasoning: users see a value that cannot be reconciled with the order record",
    "fix: compute both values from the persisted line-item sum",
    ...metadata,
    "VERDICT: FINDINGS [1]",
  ].join("\n");
}

describe("parseEvaluation mission metadata", () => {
  test("accepts a fully specified NEW mission finding", () => {
    const parsed = parseEvaluation(finding([
      "class: ARTIFACT",
      "criterion: OUT-1",
      "finding_ref: NEW",
      "fingerprint: checkout-total-rounding",
      "invariant: Displayed total equals the persisted line-item sum.",
    ]), { mission });

    assert.equal(parsed.mission_enabled, true);
    assert.equal(parsed.review_quality_ok, true);
    assert.equal(parsed.reevaluate_required, false);
    assert.deepEqual(parsed.review_claims, []);
    assert.equal(parsed.findings[0].routing_eligible, true);
    assert.deepEqual(
      {
        class: parsed.findings[0].class,
        criterion: parsed.findings[0].criterion,
        finding_ref: parsed.findings[0].finding_ref,
        fingerprint: parsed.findings[0].fingerprint,
        invariant: parsed.findings[0].invariant,
      },
      {
        class: "ARTIFACT",
        criterion: "OUT-1",
        finding_ref: "NEW",
        fingerprint: "checkout-total-rounding",
        invariant: "Displayed total equals the persisted line-item sum.",
      },
    );
  });

  test("missing required metadata blocks review quality and exposes non-routing claims", () => {
    const parsed = parseEvaluation(finding([]), { mission });

    assert.equal(parsed.review_quality_ok, false);
    assert.equal(parsed.reevaluate_required, true);
    assert.deepEqual(parsed.review_quality_errors[0].errors, [
      "missing class",
      "missing criterion",
      "missing finding_ref",
    ]);
    assert.equal(parsed.review_claims.length, 1);
    assert.equal(parsed.review_claims[0].routing, false);
    assert.match(parsed.review_claims[0].claim_hash, /^[0-9a-f]{64}$/);
  });

  test("rejects invalid class, criterion, finding reference, and NEW fingerprint", () => {
    const parsed = parseEvaluation(finding([
      "class: PRODUCT",
      "criterion: OUT-X",
      "finding_ref: NEW",
      "fingerprint: Not A Slug",
      "invariant: Totals must match.",
    ]), { mission });
    const errors = parsed.review_quality_errors[0].errors;

    assert.ok(errors.includes("invalid class 'PRODUCT'"));
    assert.ok(errors.includes("invalid criterion 'OUT-X'"));
    assert.ok(errors.includes("invalid fingerprint 'Not A Slug'"));
  });

  test("rejects a syntactically valid criterion absent from the mission", () => {
    const parsed = parseEvaluation(finding([
      "class: PLAN",
      "criterion: OUT-99",
      "finding_ref: FIND-7",
      "fingerprint: existing-floor-risk",
      "invariant: The protected floor remains intact.",
    ]), { mission });

    assert.deepEqual(parsed.review_quality_errors[0].errors, ["unknown criterion 'OUT-99'"]);
  });

  test("accepts UNLINKED while preserving it as explicit metadata", () => {
    const parsed = parseEvaluation(finding([
      "class: ENVIRONMENT",
      "criterion: UNLINKED",
      "finding_ref: NEW",
      "fingerprint: runtime-policy-drift",
      "invariant: The measured runtime policy matches the pinned environment baseline.",
    ], "🟡"), { mission });

    assert.equal(parsed.review_quality_ok, true);
    assert.equal(parsed.findings[0].criterion, "UNLINKED");
    assert.equal(parsed.findings[0].routing_eligible, false);
  });

  test("routes only an evidenced GOAL_SPEC UNLINKED protected-floor risk", () => {
    const metadata = [
      "class: GOAL_SPEC",
      "criterion: UNLINKED",
      "finding_ref: NEW",
      "fingerprint: missing-data-loss-floor",
      "invariant: A successful run never discards recoverable user state.",
    ];
    const missing = parseEvaluation(finding(metadata), { mission });
    assert.equal(missing.review_quality_ok, false);
    assert.match(missing.review_quality_errors[0].errors.join("; "), /requires evidence/);

    const evidenced = parseEvaluation(finding([
      ...metadata,
      "evidence: test-results/recovery.json records data loss after the accepted end-to-end path.",
    ]), { mission });
    assert.equal(evidenced.review_quality_ok, true);
    assert.equal(evidenced.findings[0].routing_eligible, true);
  });

  test("requires an existing registry reference to repeat its canonical identity", () => {
    const omitted = parseEvaluation(finding([
      "class: ARTIFACT",
      "criterion: FLOOR-1",
      "finding_ref: FIND-7",
    ]), { mission });
    assert.equal(omitted.review_quality_ok, false);
    assert.match(omitted.review_quality_errors[0].errors.join("; "), /missing fingerprint.*missing invariant/);

    const parsed = parseEvaluation(finding([
      "class: ARTIFACT",
      "criterion: FLOOR-1",
      "finding_ref: FIND-7",
      "fingerprint: existing-floor-risk",
      "invariant: The protected floor remains intact.",
    ]), { mission });

    assert.equal(parsed.review_quality_ok, true);
    assert.equal(parsed.findings[0].finding_ref, "FIND-7");
    assert.equal(parsed.findings[0].routing_eligible, true);
    assert.equal(parsed.findings[0].fingerprint, "existing-floor-risk");
    assert.equal(parsed.findings[0].invariant, "The protected floor remains intact.");
  });

  test("rejects an existing reference absent from a supplied registry", () => {
    const parsed = parseEvaluation(finding([
      "class: ARTIFACT",
      "criterion: OUT-1",
      "finding_ref: FIND-99",
      "fingerprint: unknown-finding-risk",
      "invariant: The unknown finding would need a registered canonical identity.",
    ]), { mission });

    assert.deepEqual(parsed.review_quality_errors[0].errors, ["unknown finding_ref 'FIND-99'"]);
  });

  test("rejects an existing reference when the supplied registry is empty", () => {
    const parsed = parseEvaluation(finding([
      "class: ARTIFACT",
      "criterion: OUT-1",
      "finding_ref: FIND-1",
      "fingerprint: empty-registry-risk",
      "invariant: An empty registry cannot authorize an existing finding reference.",
    ]), { mission: { ...mission, findingRegistry: [] } });

    assert.deepEqual(parsed.review_quality_errors[0].errors, ["unknown finding_ref 'FIND-1'"]);
  });

  test("requires fingerprint and invariant for NEW", () => {
    const parsed = parseEvaluation(finding([
      "class: GOAL_SPEC",
      "criterion: OUT-2",
      "finding_ref: NEW",
    ]), { mission });

    assert.deepEqual(parsed.review_quality_errors[0].errors, [
      "NEW finding missing fingerprint",
      "NEW finding missing invariant",
    ]);
  });

  test("blue suggestions may omit mission metadata", () => {
    const parsed = parseEvaluation(finding([], "🔵"), { mission });

    assert.equal(parsed.review_quality_ok, true);
    assert.equal(parsed.reevaluate_required, false);
  });

  test("invalid verdicts and incomplete finding structure fail Mission review quality", () => {
    const valid = finding([
      "class: ARTIFACT",
      "criterion: OUT-1",
      "finding_ref: NEW",
      "fingerprint: checkout-total-rounding",
      "invariant: Displayed total equals the persisted line-item sum.",
    ]);
    const noVerdict = parseEvaluation(valid.replace(/VERDICT:.+/, ""), { mission });
    assert.equal(noVerdict.review_quality_ok, false);
    assert.match(noVerdict.review_quality_global_errors.join("; "), /missing VERDICT/);

    const wrongCount = parseEvaluation(valid.replace("FINDINGS [1]", "FINDINGS [2]"), { mission });
    assert.equal(wrongCount.review_quality_ok, false);
    assert.match(wrongCount.review_quality_global_errors.join("; "), /count does not match/);

    const incomplete = parseEvaluation(valid.replace(/^reasoning:.+\nfix:.+\n/m, ""), { mission });
    assert.equal(incomplete.review_quality_ok, false);
    assert.match(incomplete.review_quality_global_errors.join("; "), /missing reasoning/);
    assert.match(incomplete.review_quality_global_errors.join("; "), /missing fix/);
  });

  test("pending invalid-review claims require exactly one evidence-bound disposition", () => {
    const parsed = parseEvaluation(finding([
      "class: ARTIFACT",
      "criterion: OUT-1",
      "finding_ref: NEW",
      "fingerprint: checkout-total-rounding",
      "invariant: Displayed total equals the persisted line-item sum.",
    ]), { mission });
    const claim = {
      claim_hash: "a".repeat(64),
      class: "ARTIFACT",
      criterion: "OUT-1",
      invariant: "Displayed total equals the persisted line-item sum.",
    };

    const confirmed = validateReviewClaimDispositions({
      pendingClaims: [claim],
      dispositions: [{ claimHash: claim.claim_hash, disposition: "CONFIRM", fingerprint: "checkout-total-rounding" }],
      findings: parsed.findings,
    });
    assert.equal(confirmed.ok, true);

    const unsupportedReject = validateReviewClaimDispositions({
      pendingClaims: [claim],
      dispositions: [{ claimHash: claim.claim_hash, disposition: "REJECT" }],
      findings: parsed.findings,
    });
    assert.equal(unsupportedReject.ok, false);
    assert.match(unsupportedReject.errors.join("; "), /requires evidence/);

    const missing = validateReviewClaimDispositions({ pendingClaims: [claim], dispositions: [], findings: parsed.findings });
    assert.equal(missing.ok, false);
    assert.match(missing.errors.join("; "), /has no disposition/);
  });

  test("mission-less parsing keeps legacy routing quality even when metadata is absent", () => {
    const text = finding([]);
    const legacy = parseEvaluation(text);
    const explicitLegacy = parseEvaluation(text, {});

    assert.deepEqual(legacy, explicitLegacy);
    assert.equal(legacy.mission_enabled, false);
    assert.equal(legacy.review_quality_ok, true);
    assert.equal(legacy.reevaluate_required, false);
    assert.deepEqual(legacy.review_claims, []);
  });

  test("cumulative recovery context retains mission identity fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "opc-mission-eval-"));
    try {
      const runDir = join(dir, "nodes", "review", "run_1");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "eval-owner.md"), finding([
        "class: ARTIFACT",
        "criterion: OUT-1",
        "finding_ref: NEW",
        "fingerprint: checkout-total-rounding",
        "invariant: Displayed total equals the persisted line-item sum.",
      ]));

      const cumulative = buildCumulativeFindingsMarkdown(dir, {
        entryNode: "review",
        currentNode: "review",
        history: [],
      });
      assert.match(cumulative, /class=ARTIFACT/);
      assert.match(cumulative, /criterion=OUT-1/);
      assert.match(cumulative, /finding_ref=NEW/);
      assert.match(cumulative, /fingerprint=checkout-total-rounding/);
      assert.match(cumulative, /invariant: Displayed total equals the persisted line-item sum\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
