// flow-core-consistency.test.mjs — consistency, validators, routing

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateHandshakeData, RULE_VALIDATORS, cmdRoute } from "./flow-core.mjs";
import { validHandshake } from "./flow-core.test-helpers.mjs";

describe("validateHandshakeData — consistency and loopback", () => {
  test("findings.critical > 0 with PASS verdict → error", () => {
    const { errors } = validateHandshakeData(validHandshake({
      verdict: "PASS",
      findings: { critical: 1, warning: 0, suggestion: 0 },
    }));
    assert.ok(errors.some((e) => e.includes("findings.critical > 0")));
  });

  test("findings.critical > 0 with FAIL verdict → no consistency error", () => {
    const { errors } = validateHandshakeData(validHandshake({
      verdict: "FAIL",
      findings: { critical: 1, warning: 0, suggestion: 0 },
    }));
    assert.ok(!errors.some((e) => e.includes("critical findings")));
  });

  test("findings.critical = 0 with PASS → no consistency error", () => {
    const { errors } = validateHandshakeData(validHandshake({
      verdict: "PASS",
      findings: { critical: 0, warning: 0, suggestion: 1 },
    }));
    assert.ok(!errors.some((e) => e.includes("critical findings")));
  });

  test("no findings object → no consistency error", () => {
    const { errors } = validateHandshakeData(validHandshake({ verdict: "PASS" }));
    assert.ok(!errors.some((e) => e.includes("critical findings")));
  });

  test("loopback not an object → error", () => {
    const { errors } = validateHandshakeData(validHandshake({ loopback: "bad" }));
    assert.ok(errors.some((e) => e.includes("loopback must be an object")));
  });

  test("loopback missing from → error", () => {
    const { errors } = validateHandshakeData(validHandshake({
      loopback: { reason: "retry", iteration: 1 },
    }));
    assert.ok(errors.some((e) => e.includes("loopback.from")));
  });

  test("loopback missing reason → error", () => {
    const { errors } = validateHandshakeData(validHandshake({
      loopback: { from: "gate", iteration: 1 },
    }));
    assert.ok(errors.some((e) => e.includes("loopback.reason")));
  });

  test("loopback.iteration not a number → error", () => {
    const { errors } = validateHandshakeData(validHandshake({
      loopback: { from: "gate", reason: "retry", iteration: "one" },
    }));
    assert.ok(errors.some((e) => e.includes("loopback.iteration")));
  });

  test("valid loopback → no errors", () => {
    const { errors } = validateHandshakeData(validHandshake({
      loopback: { from: "gate", reason: "retry", iteration: 1 },
    }));
    assert.ok(!errors.some((e) => e.includes("loopback")));
  });

  test("loopback null → no errors", () => {
    const { errors } = validateHandshakeData(validHandshake({ loopback: null }));
    assert.ok(!errors.some((e) => e.includes("loopback")));
  });
});

describe("validateHandshakeData — tier coverage", () => {
  test("execute node with tier but no tierCoverage → error", () => {
    const { errors } = validateHandshakeData(validHandshake({
      nodeType: "execute",
      artifacts: [{ type: "test-result", path: "test.log" }],
    }), {
      tier: "polished",
      tierBaselineKeys: ["TC-1"],
    });
    assert.ok(errors.some((e) => e.includes("tierCoverage object")));
    assert.ok(errors.some((e) => e.includes("pipeline/tier-coverage-schema.md")));
    assert.ok(errors.some((e) => e.includes("typography")));
  });

  test("execute node with tier and tierCoverage.covered not array → error", () => {
    const { errors } = validateHandshakeData(validHandshake({
      nodeType: "execute",
      artifacts: [{ type: "test-result", path: "test.log" }],
      tierCoverage: { covered: "bad", skipped: [] },
    }), {
      tier: "polished",
      tierBaselineKeys: ["TC-1"],
    });
    assert.ok(errors.some((e) => e.includes("tierCoverage.covered must be an array")));
    assert.ok(errors.some((e) => e.includes("Expected tierCoverage")));
  });

  test("execute node with tier and skipped entry missing reason → error", () => {
    const { errors } = validateHandshakeData(validHandshake({
      nodeType: "execute",
      artifacts: [{ type: "test-result", path: "test.log" }],
      tierCoverage: { covered: ["TC-1"], skipped: [{ key: "TC-2" }] },
    }), {
      tier: "polished",
      tierBaselineKeys: ["TC-1", "TC-2"],
    });
    assert.ok(errors.some((e) => e.includes("missing 'reason'")));
  });

  test("execute node with tier and skipped entry with short reason → error", () => {
    const { errors } = validateHandshakeData(validHandshake({
      nodeType: "execute",
      artifacts: [{ type: "test-result", path: "test.log" }],
      tierCoverage: { covered: ["TC-1"], skipped: [{ key: "TC-2", reason: "n/a" }] },
    }), {
      tier: "polished",
      tierBaselineKeys: ["TC-1", "TC-2"],
    });
    assert.ok(errors.some((e) => e.includes("missing 'reason'")));
  });

  test("unknown tierCoverage key error includes valid key list", () => {
    const { errors } = validateHandshakeData(validHandshake({
      nodeType: "execute",
      artifacts: [{ type: "test-result", path: "test.log" }],
      tierCoverage: { covered: ["banana"], skipped: [] },
    }), {
      tier: "delightful",
    });
    assert.ok(errors.some((e) => e.includes("unknown baseline key: 'banana'")));
    assert.ok(errors.some((e) => e.includes("Valid keys for delightful")));
    assert.ok(errors.some((e) => e.includes("micro-interactions")));
    assert.ok(!errors.some((e) => e.includes("dark-mode")));
  });

  test("functional tier (no required keys) → no tierCoverage needed", () => {
    const { errors } = validateHandshakeData(validHandshake({
      nodeType: "execute",
      artifacts: [{ type: "test-result", path: "test.log" }],
    }), {
      tier: "functional",
      tierBaselineKeys: [],
    });
    assert.ok(!errors.some((e) => e.includes("tierCoverage")));
  });
});

describe("RULE_VALIDATORS", () => {
  test("non-empty-array: valid", () => {
    assert.equal(RULE_VALIDATORS["non-empty-array"]([1]), true);
  });
  test("non-empty-array: empty → false", () => {
    assert.equal(RULE_VALIDATORS["non-empty-array"]([]), false);
  });
  test("non-empty-array: non-array → false", () => {
    assert.equal(RULE_VALIDATORS["non-empty-array"]("hi"), false);
  });

  test("non-empty-object: valid", () => {
    assert.equal(RULE_VALIDATORS["non-empty-object"]({ a: 1 }), true);
  });
  test("non-empty-object: empty → false", () => {
    assert.equal(RULE_VALIDATORS["non-empty-object"]({}), false);
  });
  test("non-empty-object: array → false", () => {
    assert.equal(RULE_VALIDATORS["non-empty-object"]([1]), false);
  });
  test("non-empty-object: null → falsy", () => {
    assert.ok(!RULE_VALIDATORS["non-empty-object"](null));
  });

  test("non-empty-string: valid", () => {
    assert.equal(RULE_VALIDATORS["non-empty-string"]("hi"), true);
  });
  test("non-empty-string: empty → false", () => {
    assert.equal(RULE_VALIDATORS["non-empty-string"](""), false);
  });
  test("non-empty-string: non-string → false", () => {
    assert.equal(RULE_VALIDATORS["non-empty-string"](42), false);
  });

  test("positive-integer: valid", () => {
    assert.equal(RULE_VALIDATORS["positive-integer"](5), true);
  });
  test("positive-integer: zero → false", () => {
    assert.equal(RULE_VALIDATORS["positive-integer"](0), false);
  });
  test("positive-integer: negative → false", () => {
    assert.equal(RULE_VALIDATORS["positive-integer"](-1), false);
  });
  test("positive-integer: float → false", () => {
    assert.equal(RULE_VALIDATORS["positive-integer"](1.5), false);
  });
});

describe("cmdRoute", () => {
  let logOutput, errOutput, exitCode, routeDir;
  let origLog, origErr, origExit;

  beforeEach(() => {
    logOutput = [];
    errOutput = [];
    exitCode = null;
    const base = join(homedir(), ".opc", "sessions");
    mkdirSync(base, { recursive: true });
    routeDir = mkdtempSync(join(base, "opc-route-empty-"));
    origLog = console.log;
    origErr = console.error;
    origExit = process.exit;
    console.log = (...a) => logOutput.push(a.join(" "));
    console.error = (...a) => errOutput.push(a.join(" "));
    process.exit = (code) => { exitCode = code; throw new Error("EXIT"); };
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
    rmSync(routeDir, { recursive: true, force: true });
  });

  test("missing --node → exits 1", () => {
    assert.throws(() => cmdRoute(["--verdict", "PASS", "--flow", "linear"]), /EXIT/);
    assert.equal(exitCode, 1);
  });

  test("missing --verdict → exits 1", () => {
    assert.throws(() => cmdRoute(["--node", "gate-1", "--flow", "linear"]), /EXIT/);
    assert.equal(exitCode, 1);
  });

  test("node not in flow → valid=false", () => {
    cmdRoute(["--node", "nonexistent", "--verdict", "PASS", "--flow", "review", "--dir", routeDir]);
    const out = JSON.parse(logOutput[0]);
    assert.equal(out.valid, false);
    assert.ok(out.error.includes("not in flow"));
  });

  test("valid route → valid=true with next node", () => {
    cmdRoute(["--node", "review", "--verdict", "PASS", "--flow", "review", "--dir", routeDir]);
    const out = JSON.parse(logOutput[0]);
    assert.equal(out.valid, true);
    assert.equal(out.next, "gate");
  });

  test("existing falsey non-object flow state fails closed", () => {
    const base = join(homedir(), ".opc", "sessions");
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, "opc-route-state-"));
    try {
      writeFileSync(join(dir, "flow-state.json"), "0");
      cmdRoute(["--node", "review", "--verdict", "PASS", "--flow", "review", "--dir", dir]);
      const out = JSON.parse(logOutput[0]);
      assert.equal(out.valid, false);
      assert.match(out.error, /flow-state\.json.*object/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no edge for verdict → valid=false", () => {
    cmdRoute(["--node", "review", "--verdict", "BLOCKED", "--flow", "review", "--dir", routeDir]);
    const out = JSON.parse(logOutput[0]);
    assert.equal(out.valid, false);
    assert.ok(out.error.includes("no edge for verdict"));
  });
});
