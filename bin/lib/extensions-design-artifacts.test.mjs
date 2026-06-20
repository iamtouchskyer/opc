// extensions-design-artifacts.test.mjs — design artifact writer regressions

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeDesignArtifacts } from "./extensions.mjs";

let tmp;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

test("no-task design preflight writes only di-state", () => {
  tmp = mkdtempSync(join(tmpdir(), "opc-design-artifacts-"));
  writeDesignArtifacts({
    type: "design",
    confidence: 0.1,
    reason: "no task description provided",
    diState: {
      version: 1,
      preflight: {
        status: "no-task",
        confidence: 0.1,
        reason: "no task description provided",
      },
    },
  }, tmp);

  assert.equal(existsSync(join(tmp, "di-state.json")), true);
  assert.equal(existsSync(join(tmp, "design-mode.json")), false);
  assert.equal(existsSync(join(tmp, "design-brief.md")), false);
  const state = JSON.parse(readFileSync(join(tmp, "di-state.json"), "utf8"));
  assert.equal(state.preflight.status, "no-task");
});

test("normal design preflight still writes design artifacts", () => {
  tmp = mkdtempSync(join(tmpdir(), "opc-design-artifacts-"));
  writeDesignArtifacts({
    type: "design",
    confidence: 0.8,
    reason: "dashboard matched via keyword",
    selection: { industry: "dashboard", matchScore: 0.8 },
    brief: "# Design Brief\nUse compact dashboard tokens.\n",
    tokens: { colors: { accent: "#1677ff" } },
    diState: {
      version: 1,
      preflight: { status: "ok", confidence: 0.8, reason: "dashboard matched via keyword" },
    },
  }, tmp);

  assert.equal(existsSync(join(tmp, "di-state.json")), true);
  assert.equal(existsSync(join(tmp, "design-mode.json")), true);
  assert.equal(existsSync(join(tmp, "design-selection.json")), true);
  assert.equal(existsSync(join(tmp, "design-brief.md")), true);
  assert.equal(existsSync(join(tmp, "design-tokens.json")), true);

  const state = JSON.parse(readFileSync(join(tmp, "di-state.json"), "utf8"));
  assert.equal(state.preflight.status, "ok");
  const mode = JSON.parse(readFileSync(join(tmp, "design-mode.json"), "utf8"));
  assert.equal(mode.mode, "auto");
  assert.equal(mode.confidence, 0.8);
});
