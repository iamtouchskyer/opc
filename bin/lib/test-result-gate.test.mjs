import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { collectTestResultReasons } from "./test-result-gate.mjs";

describe("test-result evidence", () => {
  test("optional counters are not required for non-test checks", () => {
    assert.deepEqual(collectTestResultReasons({ checks: [{ id: "api", pass: true }] }), []);
  });

  test("accepts non-negative integers and complete integer strings", () => {
    assert.deepEqual(collectTestResultReasons({
      test_fail_count: "0", dead_test_count: 0, p0_count: " 0 ",
      checks: [{ id: "api", pass: true, total: "1" }],
    }), []);
    assert.match(collectTestResultReasons({ test_fail_count: "3" }).join(), /3 test\(s\) failed/);
  });

  for (const field of ["test_fail_count", "dead_test_count", "p0_count"]) {
    for (const value of [null, -1, 0.5, "", "0garbage", true, {}, Number.MAX_SAFE_INTEGER + 1]) {
      test(`rejects invalid ${field}=${JSON.stringify(value)}`, () => {
        assert.match(collectTestResultReasons({ [field]: value }).join(), /invalid.*count/i);
      });
    }
  }

  test("rejects numeric-string zero totals, including JSON detail", () => {
    for (const fields of [{ total: "0" }, { detail: '{"total":"0"}' }]) {
      assert.match(collectTestResultReasons({
        checks: [{ id: "empty", pass: true, ...fields }],
      }).join(), /vacuous PASS/);
    }
  });

  test("invalid explicit totals cannot fall back to valid detail or an allowance", () => {
    for (const total of [null, -1, "", "0garbage"]) {
      assert.match(collectTestResultReasons({
        checks: [{ id: "empty", pass: true, total, detail: { total: 1 } }],
      }, { allowVacuousChecks: ["empty"] }).join(), /invalid.*total/i);
    }
  });

  test("preserves explicit vacuous-check allowances", () => {
    assert.deepEqual(collectTestResultReasons({
      checks: [{ id: "empty", pass: true, total: "0" }],
    }, { allowVacuousChecks: ["empty"] }), []);
  });

  test("OPC command evidence must report a valid exit code and timeout status", () => {
    const result = {
      provenance: { kind: "opc-test-command" },
      exitCode: 0, timedOut: false, test_fail_count: 0,
    };
    assert.deepEqual(collectTestResultReasons(result), []);
    assert.match(collectTestResultReasons({ ...result, exitCode: 7 }).join(), /exitCode=7/);
    assert.match(collectTestResultReasons({ ...result, timedOut: true }).join(), /timed out/);
    for (const field of ["exitCode", "timedOut"]) {
      const missing = { ...result };
      delete missing[field];
      assert.match(collectTestResultReasons(missing).join(), new RegExp(field));
    }
  });
});
