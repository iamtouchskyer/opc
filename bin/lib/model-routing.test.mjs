import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ModelRoutingError,
  normalizeAgentRouting,
  resolveModelRoute,
} from "./model-routing.mjs";

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "..", "opc-harness.mjs");

function route(overrides = {}) {
  return resolveModelRoute({
    node: "code-review",
    nodeType: "review",
    config: {},
    env: {},
    ...overrides,
  });
}

describe("model routing defaults", () => {
  test("standard nodes use sonnet instead of inheriting the parent", () => {
    const out = route();
    assert.equal(out.dispatch, true);
    assert.equal(out.tier, "standard");
    assert.equal(out.model, "sonnet");
    assert.equal(out.source, "nodeType:review");
    assert.equal(out.premium, false);
  });

  test("economy nodes use haiku", () => {
    const out = route({ node: "test-design", role: null });
    assert.equal(out.tier, "economy");
    assert.equal(out.model, "haiku");
    assert.equal(out.source, "node:test-design");
  });

  test("economy role override wins over a standard node", () => {
    const out = route({ role: "tester" });
    assert.equal(out.tier, "economy");
    assert.equal(out.model, "haiku");
    assert.equal(out.source, "role:tester");
  });

  test("execute and gate nodes do not dispatch a model", () => {
    const out = route({ node: "gate", nodeType: "gate" });
    assert.equal(out.dispatch, false);
    assert.equal(out.tier, "none");
    assert.equal(out.model, null);
  });
});

describe("model routing configuration", () => {
  test("host-native model IDs can replace tier defaults", () => {
    const out = route({
      config: {
        agentRouting: {
          models: { economy: "host-fast", standard: "host-value" },
          roles: { security: "standard" },
        },
        _source: { agentRouting: "repo" },
      },
      role: "security",
    });
    assert.equal(out.model, "host-value");
    assert.equal(out.configSource, "repo");
  });

  test("node override wins over node type", () => {
    const out = route({
      config: { agentRouting: { nodes: { "code-review": "economy" } } },
    });
    assert.equal(out.tier, "economy");
    assert.equal(out.source, "node:code-review");
  });

  test("normalization does not discard unspecified defaults", () => {
    const cfg = normalizeAgentRouting({ models: { economy: "fast-v2" } });
    assert.equal(cfg.models.economy, "fast-v2");
    assert.equal(cfg.models.standard, "sonnet");
    assert.equal(cfg.nodeTypes.review, "standard");
  });

  test("missing configured tier fails closed", () => {
    assert.throws(
      () => route({ config: { agentRouting: { roles: { security: "unmapped" } } }, role: "security" }),
      err => err instanceof ModelRoutingError && err.code === "MODEL_UNRESOLVED",
    );
  });
});

describe("premium and runtime overrides", () => {
  test("inherit requires explicit premium approval", () => {
    assert.throws(
      () => route({ config: { agentRouting: { nodeTypes: { review: "premium" } } } }),
      err => err instanceof ModelRoutingError && err.code === "PREMIUM_APPROVAL_REQUIRED",
    );
  });

  test("premium route succeeds after explicit approval", () => {
    const out = route({
      config: { agentRouting: { nodeTypes: { review: "premium" } } },
      allowPremium: true,
    });
    assert.equal(out.model, "inherit");
    assert.equal(out.premium, true);
    assert.equal(out.premiumApproved, true);
  });

  test("a string value does not accidentally approve premium use", () => {
    assert.throws(
      () => route({
        config: {
          agentRouting: {
            nodeTypes: { review: "premium" },
            allowPremiumByDefault: "false",
          },
        },
      }),
      err => err instanceof ModelRoutingError && err.code === "PREMIUM_APPROVAL_REQUIRED",
    );
  });

  test("Claude Code environment override is reported and honored", () => {
    const out = route({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "custom-value-model" } });
    assert.equal(out.model, "custom-value-model");
    assert.equal(out.envOverride, true);
    assert.equal(out.source, "env:CLAUDE_CODE_SUBAGENT_MODEL");
    assert.equal(out.warnings.length, 1);
  });

  test("an explicit premium environment override is treated as user approval", () => {
    const out = route({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "opus" } });
    assert.equal(out.model, "opus");
    assert.equal(out.premium, true);
    assert.equal(out.premiumApproved, true);
  });
});

describe("model-route CLI", () => {
  test("loads repository config and prints the chosen host-native model", () => {
    const root = mkdtempSync(join(tmpdir(), "opc-model-route-"));
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(join(project, ".opc"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(project, ".opc", "config.json"), JSON.stringify({
      agentRouting: { models: { economy: "host-fast-model" } },
    }));
    const { CLAUDE_CODE_SUBAGENT_MODEL: _ignored, ...cleanEnv } = process.env;

    try {
      const result = spawnSync(process.execPath, [
        HARNESS,
        "model-route",
        "--node", "test-design",
        "--node-type", "review",
        "--dir", project,
      ], {
        cwd: project,
        encoding: "utf8",
        env: { ...cleanEnv, HOME: home },
      });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.model, "host-fast-model");
      assert.equal(output.configSource, "repo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns structured JSON and exit code 2 for denied premium routing", () => {
    const root = mkdtempSync(join(tmpdir(), "opc-model-route-"));
    const { CLAUDE_CODE_SUBAGENT_MODEL: _ignored, ...cleanEnv } = process.env;

    try {
      const result = spawnSync(process.execPath, [
        HARNESS,
        "model-route",
        "--node", "architecture-review",
        "--node-type", "review",
        "--role", "architect",
        "--dir", root,
      ], {
        cwd: root,
        encoding: "utf8",
        env: { ...cleanEnv, HOME: root },
      });
      assert.equal(result.status, 0, result.stderr);

      mkdirSync(join(root, ".opc"), { recursive: true });
      writeFileSync(join(root, ".opc", "config.json"), JSON.stringify({
        agentRouting: { nodeTypes: { review: "premium" } },
      }));
      const denied = spawnSync(process.execPath, [
        HARNESS,
        "model-route",
        "--node", "architecture-review",
        "--node-type", "review",
        "--dir", root,
      ], {
        cwd: root,
        encoding: "utf8",
        env: { ...cleanEnv, HOME: root },
      });
      assert.equal(denied.status, 2);
      const output = JSON.parse(denied.stdout);
      assert.equal(output.ok, false);
      assert.equal(output.error.code, "PREMIUM_APPROVAL_REQUIRED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
