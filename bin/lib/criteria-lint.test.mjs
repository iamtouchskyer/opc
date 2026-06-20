// criteria-lint.test.mjs — structural checks

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runLint } from "./criteria-lint.mjs";
import { failChecks, validDoc } from "./criteria-lint.test-helpers.mjs";

describe("runLint — structural checks", () => {
  test("valid doc passes all checks", () => {
    const r = runLint(validDoc());
    assert.equal(r.failures.length, 0);
    assert.equal(r.checksRun, 12);
    assert.equal(r.passed, 12);
  });

  test("outcomes-exist fails when no Outcomes section", () => {
    const text = "## Verification\nstuff\n## Quality Constraints\nq\n## Out of Scope\n- x";
    const r = runLint(text);
    assert.ok(failChecks(r).includes("outcomes-exist"));
  });

  test("outcomes-exist passes with Outcomes section", () => {
    const r = runLint(validDoc());
    assert.ok(!failChecks(r).includes("outcomes-exist"));
  });

  test("outcomes-count fails with 2 outcomes", () => {
    const r = runLint(validDoc({
      outcomes: [
        "- OUT-1: Returns 200",
        "- OUT-2: Returns error details on failure",
      ],
      verification: "- OUT-1: assert status\n- OUT-2: assert error",
    }));
    assert.ok(failChecks(r).includes("outcomes-count"));
    assert.ok(r.failures.find((f) => f.check === "outcomes-count").message.includes("2"));
  });

  test("outcomes-count fails with 11 outcomes", () => {
    const outs = Array.from({ length: 11 }, (_, i) =>
      `- OUT-${i + 1}: Outcome number ${i + 1} returns status code ${200 + i}`
    );
    const ver = outs.map((o) => {
      const id = o.match(/OUT-\d+/)[0];
      return `- ${id}: assert result`;
    }).join("\n");
    const r = runLint(validDoc({ outcomes: outs, verification: ver }));
    assert.ok(failChecks(r).includes("outcomes-count"));
    assert.ok(r.failures.find((f) => f.check === "outcomes-count").message.includes("3-10"));
  });

  test("outcomes-count passes with 3-10 outcomes", () => {
    const r = runLint(validDoc());
    assert.ok(!failChecks(r).includes("outcomes-count"));
  });

  test("structural failures include expected format hint", () => {
    const text = "## Outcomes\n- OUT-1: a\n- OUT-2: b\n- OUT-3: c\n## Verification\nOUT-1 OUT-2 OUT-3\n## Out of Scope\n- x";
    const r = runLint(text);
    const f = r.failures.find((failure) => failure.check === "quality-section");
    assert.ok(f.message.includes("## Quality Constraints"));
    assert.ok(f.message.includes("Expected sections"));
  });

  test("verification-exists fails when missing", () => {
    const text = "## Outcomes\n- OUT-1: a\n- OUT-2: b\n- OUT-3: c\n## Quality Constraints\nq\n## Out of Scope\n- x";
    const r = runLint(text);
    assert.ok(failChecks(r).includes("verification-exists"));
  });

  test("verification-mapped fails when OUT-N missing from verification", () => {
    const r = runLint(validDoc({
      verification: "- OUT-1: check\n- OUT-2: check",
    }));
    assert.ok(failChecks(r).includes("verification-mapped"));
    assert.ok(r.failures.find((f) => f.check === "verification-mapped").message.includes("OUT-3"));
  });

  test("verification-mapped passes when all outcomes mapped", () => {
    const r = runLint(validDoc());
    assert.ok(!failChecks(r).includes("verification-mapped"));
  });

  test("quality-section fails when missing", () => {
    const text = "## Outcomes\n- OUT-1: a\n- OUT-2: b\n- OUT-3: c\n## Verification\nOUT-1 OUT-2 OUT-3\n## Out of Scope\n- x";
    const r = runLint(text);
    assert.ok(failChecks(r).includes("quality-section"));
  });

  test("scope-section fails when missing", () => {
    const text = "## Outcomes\n- OUT-1: a\n- OUT-2: b\n- OUT-3: c\n## Verification\nOUT-1 OUT-2 OUT-3\n## Quality Constraints\nq";
    const r = runLint(text);
    assert.ok(failChecks(r).includes("scope-section"));
  });

  test("tier-section fails when tier given but no Quality Baseline section", () => {
    const r = runLint(validDoc(), "functional");
    assert.ok(failChecks(r).includes("tier-section"));
    assert.ok(r.failures.find((f) => f.check === "tier-section").message.includes("functional"));
  });

  test("tier-section passes when Quality Baseline section exists", () => {
    const doc = validDoc({ extra: "\n## Quality Baseline\n- baseline stuff" });
    const r = runLint(doc, "polished");
    assert.ok(!failChecks(r).includes("tier-section"));
  });

  test("tier-section skipped when tier is undefined", () => {
    const r = runLint(validDoc());
    assert.ok(!failChecks(r).includes("tier-section"));
  });

  test("tier-section skipped when tier is invalid", () => {
    const r = runLint(validDoc(), "bogus");
    assert.ok(!failChecks(r).includes("tier-section"));
  });
});
