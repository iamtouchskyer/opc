import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentRoutingError,
  normalizeAgentRouting,
  resolveAgentRoute,
} from "./agent-routing.mjs";

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "..", "opc-harness.mjs");

function route(overrides = {}) {
  return resolveAgentRoute({
    node: "code-review",
    nodeType: "review",
    config: {},
    ...overrides,
  });
}

describe("native-first model routing", () => {
  test("unspecified work stays native and lets Codex auto-route", () => {
    const out = route();
    assert.equal(out.controlPlane, "codex-native");
    assert.equal(out.externalPlatform, null);
    assert.equal(out.modelPreference, null);
    assert.equal(out.selection, "host-auto");
  });

  test("read-heavy and routine work prefer Terra", () => {
    for (const taskShape of ["read-heavy", "routine"]) {
      const out = route({ taskShape });
      assert.equal(out.controlPlane, "codex-native");
      assert.equal(out.tier, "economy");
      assert.equal(out.modelPreference, "gpt-5.6-terra");
      assert.equal(out.reasoningEffort, "medium");
    }
  });

  test("semantic and high-risk work prefer GPT-5.6 at different effort", () => {
    const semantic = route({ taskShape: "semantic" });
    assert.equal(semantic.modelPreference, "gpt-5.6");
    assert.equal(semantic.reasoningEffort, "medium");

    const highRisk = route({ taskShape: "high-risk" });
    assert.equal(highRisk.modelPreference, "gpt-5.6");
    assert.equal(highRisk.reasoningEffort, "high");
  });

  test("role names do not automatically select the strongest tier", () => {
    const out = route({ role: "security" });
    assert.equal(out.tier, "auto");
    assert.equal(out.modelPreference, null);
  });

  test("tool-only, execute, and gate work do not spawn Agents", () => {
    assert.equal(route({ taskShape: "tool-only" }).dispatch, false);
    assert.equal(route({ node: "execute", nodeType: "execute" }).dispatch, false);
    assert.equal(route({ node: "gate", nodeType: "gate" }).dispatch, false);
  });

  test("unknown task shape fails instead of silently using a different tier", () => {
    assert.throws(
      () => route({ taskShape: "mystery" }),
      error => error instanceof AgentRoutingError && error.code === "TASK_SHAPE_UNSUPPORTED",
    );
  });

  test("known read-heavy roles prefer Terra without external dispatch", () => {
    const out = route({ role: "tester" });
    assert.equal(out.modelPreference, "gpt-5.6-terra");
    assert.equal(out.controlPlane, "codex-native");
  });
});

describe("external Adapter boundary", () => {
  test("external platform is denied without an explicit third-party request", () => {
    assert.throws(
      () => route({ requestedPlatform: "minimax" }),
      error => error instanceof AgentRoutingError && error.code === "EXPLICIT_THIRD_PARTY_REQUIRED",
    );
  });

  test("explicit configured third-party platform is allowed", () => {
    const out = route({ requestedPlatform: "claude", explicitThirdParty: true });
    assert.equal(out.controlPlane, "external-cli");
    assert.equal(out.externalPlatform, "claude");
    assert.equal(out.explicitThirdParty, true);
  });

  test("unknown external platform fails closed", () => {
    assert.throws(
      () => route({ requestedPlatform: "mystery", explicitThirdParty: true }),
      error => error instanceof AgentRoutingError && error.code === "EXTERNAL_PLATFORM_UNSUPPORTED",
    );
  });
});

describe("layered routing configuration", () => {
  test("normalization preserves defaults under partial overrides", () => {
    const config = normalizeAgentRouting({ models: { economy: "terra-custom" } });
    assert.equal(config.models.economy, "terra-custom");
    assert.equal(config.models.standard, "gpt-5.6");
    assert.equal(config.nodeTypes.gate, "none");
  });

  test("unknown configured tier uses host auto when allowed", () => {
    const out = route({
      role: "security",
      config: { agentRouting: { roles: { security: "custom-unmapped" } } },
    });
    assert.equal(out.tier, "auto");
    assert.equal(out.selection, "host-auto");
  });

  test("unknown configured tier can fail closed by policy", () => {
    assert.throws(
      () => route({
        role: "security",
        config: {
          agentRouting: {
            roles: { security: "custom-unmapped" },
            unknownModelPolicy: "deny",
          },
        },
      }),
      error => error instanceof AgentRoutingError && error.code === "MODEL_TIER_UNRESOLVED",
    );
  });
});

describe("agent-route CLI", () => {
  test("loads repository config and prints native preference", () => {
    const root = mkdtempSync(join(tmpdir(), "opc-agent-route-"));
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(join(project, ".opc"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(project, ".opc", "config.json"), JSON.stringify({
      agentRouting: { models: { economy: "terra-project" } },
    }));

    try {
      const result = spawnSync(process.execPath, [
        HARNESS,
        "agent-route",
        "--node", "test-design",
        "--node-type", "review",
        "--task-shape", "read-heavy",
        "--dir", project,
      ], { cwd: project, encoding: "utf8", env: { ...process.env, HOME: home } });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.controlPlane, "codex-native");
      assert.equal(output.modelPreference, "terra-project");
      assert.equal(output.configSource, "repo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CLI rejects implicit external dispatch", () => {
    const root = mkdtempSync(join(tmpdir(), "opc-agent-route-"));
    try {
      const result = spawnSync(process.execPath, [
        HARNESS,
        "agent-route",
        "--node", "build",
        "--node-type", "build",
        "--external-platform", "minimax",
        "--dir", root,
      ], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: root } });
      assert.equal(result.status, 2);
      const output = JSON.parse(result.stdout);
      assert.equal(output.error.code, "EXPLICIT_THIRD_PARTY_REQUIRED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
