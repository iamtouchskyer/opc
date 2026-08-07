import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawnSync } from "node:child_process";
import {
  claimToolSlot,
  createStopMarker,
  readSessionRegistry,
  registryPath,
  writeSessionRegistry,
} from "./runaway-guard.mjs";
import { evaluatePreToolUse } from "../hooks/opc-pre-tool-budget.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const harness = join(repoRoot, "bin", "opc-harness.mjs");
const opcCli = join(repoRoot, "bin", "opc.mjs");
const skillFile = join(repoRoot, "SKILL.md");
const roots = [];

function tempFixture(name, { hookInstalled = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `opc-runaway-integration-${name}-`)));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  if (hookInstalled) installHookFixture(home);
  return { root, home, project };
}

function installHookFixture(home) {
  const hook = join(home, ".claude", "skills", "opc", "bin", "hooks", "opc-pre-tool-budget.mjs");
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, "#!/usr/bin/env node\n");
  const settings = {
    hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: `node "${hook}"`, timeout: 10 }] }],
    },
  };
  const settingsPath = join(home, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return hook;
}

function parseLastJson(stdout) {
  const line = String(stdout || "").trim().split("\n").pop();
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function run(script, args, { home, cwd, project, path } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: cwd || project,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(home ? { HOME: home } : {}),
      ...(path ? { PATH: path } : {}),
    },
  });
  return { ...result, json: parseLastJson(result.stdout) };
}

function runAsync(script, args, { home, cwd, project, path, env } = {}) {
  return new Promise(resolveRun => {
    execFile(process.execPath, [script, ...args], {
      cwd: cwd || project,
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        ...(home ? { HOME: home } : {}),
        ...(path ? { PATH: path } : {}),
      },
    }, (error, stdout, stderr) => {
      resolveRun({
        status: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
        json: parseLastJson(stdout),
      });
    });
  });
}

async function waitForFile(path, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}

async function runWithRegistryPublicationFailure(fixture, args, extraEnv = {}) {
  const runtime = join(fixture.home, ".opc", "runtime");
  mkdirSync(runtime, { recursive: true });
  const bin = join(fixture.root, "blocking-bin");
  mkdirSync(bin, { recursive: true });
  const signal = join(fixture.root, "git-started");
  const release = join(fixture.root, "git-release");
  const git = join(bin, "git");
  writeFileSync(git, `#!/bin/sh\n: > "$OPC_TEST_GIT_SIGNAL"\nwhile [ ! -f "$OPC_TEST_GIT_RELEASE" ]; do /bin/sleep 0.01; done\nif [ "$2" = "--show-toplevel" ]; then printf '%s\\n' "$OPC_TEST_PROJECT_ROOT"; else printf '%040d\\n' 0; fi\n`);
  chmodSync(git, 0o755);

  const pending = runAsync(harness, args, {
    ...fixture,
    path: `${bin}:${process.env.PATH}`,
    env: {
      OPC_TEST_GIT_SIGNAL: signal,
      OPC_TEST_GIT_RELEASE: release,
      OPC_TEST_PROJECT_ROOT: fixture.project,
      ...extraEnv,
    },
  });

  await waitForFile(signal);
  chmodSync(runtime, 0o500);
  writeFileSync(release, "go");
  try {
    return await pending;
  } finally {
    chmodSync(runtime, 0o700);
  }
}

function runInit(fixture, dir, extra = []) {
  return run(harness, [
    "init",
    "--flow", "review",
    "--entry", "review",
    "--dir", dir,
    "--no-extensions",
    ...extra,
  ], fixture);
}

function hookInput(fixture, sessionId, toolUseId = "tool-1") {
  return {
    session_id: sessionId,
    cwd: fixture.project,
    tool_use_id: toolUseId,
    tool_name: "Bash",
  };
}

function assertHookDenied(result) {
  assert.equal(result.allowed, false);
  assert.equal(result.output.hookSpecificOutput.permissionDecision, "deny");
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("auto init registry contract", () => {
  test("auto init binds state and registry to the Claude session", () => {
    const fixture = tempFixture("auto-init");
    const dir = join(fixture.project, "session");
    const sessionId = "claude-session-a";

    const result = runInit(fixture, dir, ["--auto", "--claude-session-id", sessionId]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.created, true, JSON.stringify(result.json));
    const state = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
    assert.equal(state.autoMode, true);
    assert.equal(state._claudeSessionId, sessionId);
    assert.deepEqual(state.autoRepairCounts, {});
    assert.equal(new Date(state.flowStartedAt).toISOString(), state.flowStartedAt);
    assert.deepEqual(readSessionRegistry(sessionId, fixture.home), {
      sessionId,
      sessionDir: dir,
      projectRoot: fixture.project,
      registeredAt: state.flowStartedAt,
    });
    assert.deepEqual(evaluatePreToolUse(hookInput(fixture, sessionId), { home: fixture.home }), { allowed: true });
  });

  test("interactive init needs neither hook nor registry", () => {
    const fixture = tempFixture("interactive-init", { hookInstalled: false });
    const dir = join(fixture.project, "session");

    const result = runInit(fixture, dir);

    assert.equal(result.json.created, true, JSON.stringify(result.json));
    const state = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
    assert.equal(state.autoMode, undefined);
    assert.equal(state._claudeSessionId, undefined);
    assert.equal(state.autoRepairCounts, undefined);
    assert.equal(readSessionRegistry("unused", fixture.home), null);
  });

  test("auto init refuses missing hook or session identity before creating state", () => {
    const missingHook = tempFixture("missing-hook", { hookInstalled: false });
    const missingHookDir = join(missingHook.root, "session");
    const hookResult = runInit(missingHook, missingHookDir, [
      "--auto", "--claude-session-id", "session-hook",
    ]);
    assert.equal(hookResult.json.created, false);
    assert.match(hookResult.json.error, /PreToolUse hook/i);
    assert.equal(existsSync(missingHookDir), false);

    const missingId = tempFixture("missing-id");
    const missingIdDir = join(missingId.root, "session");
    const idResult = runInit(missingId, missingIdDir, ["--auto"]);
    assert.equal(idResult.json.created, false);
    assert.match(idResult.json.error, /claude-session-id/);
    assert.equal(existsSync(missingIdDir), false);
  });

  test("auto init fails closed when hook settings cannot be parsed", () => {
    const fixture = tempFixture("malformed-hook-settings");
    writeFileSync(join(fixture.home, ".claude", "settings.json"), "{");
    const dir = join(fixture.project, "session");

    const result = runInit(fixture, dir, [
      "--auto", "--claude-session-id", "session-malformed-settings",
    ]);

    assert.equal(result.json.created, false);
    assert.match(result.json.error, /cannot read.*settings\.json/i);
    assert.equal(existsSync(dir), false);
  });

  test("auto init rejects a PreToolUse hook scoped to one tool", () => {
    const fixture = tempFixture("scoped-hook");
    const settingsPath = join(fixture.home, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.hooks.PreToolUse[0].matcher = "Bash";
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const dir = join(fixture.project, "session");

    const result = runInit(fixture, dir, [
      "--auto", "--claude-session-id", "session-scoped-hook",
    ]);

    assert.equal(result.json.created, false);
    assert.match(result.json.error, /PreToolUse hook is not installed/);
    assert.equal(existsSync(dir), false);
  });

  test("auto init rejects an asynchronous PreToolUse hook", () => {
    const fixture = tempFixture("async-hook");
    const settingsPath = join(fixture.home, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.hooks.PreToolUse[0].hooks[0].async = true;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const dir = join(fixture.project, "session");

    const result = runInit(fixture, dir, [
      "--auto", "--claude-session-id", "session-async-hook",
    ]);

    assert.equal(result.json.created, false);
    assert.match(result.json.error, /PreToolUse hook is not installed/);
    assert.equal(existsSync(dir), false);
  });

  test("one Claude session cannot bind two active auto flows but may replace a stopped flow", () => {
    const fixture = tempFixture("registry-conflict");
    const sessionId = "claude-session-conflict";
    const firstDir = join(fixture.project, "first");
    const secondDir = join(fixture.project, "second");

    assert.equal(runInit(fixture, firstDir, ["--auto", "--claude-session-id", sessionId]).json.created, true);
    const conflict = runInit(fixture, secondDir, ["--auto", "--claude-session-id", sessionId]);
    assert.equal(conflict.json.created, false);
    assert.match(conflict.json.error, /already bound to an active auto flow/);
    assert.equal(existsSync(secondDir), false);

    const firstStatePath = join(firstDir, "flow-state.json");
    const firstState = JSON.parse(readFileSync(firstStatePath, "utf8"));
    firstState.status = "stopped";
    writeFileSync(firstStatePath, JSON.stringify(firstState, null, 2));

    const replacement = runInit(fixture, secondDir, ["--auto", "--claude-session-id", sessionId]);
    assert.equal(replacement.json.created, true, JSON.stringify(replacement.json));
    assert.equal(readSessionRegistry(sessionId, fixture.home).sessionDir, secondDir);
  });

  test("auto init fails closed for corrupt, missing-state, or unsafe existing registries", () => {
    const corrupt = tempFixture("registry-corrupt-existing");
    const corruptId = "claude-session-corrupt-existing";
    const corruptPath = registryPath(corruptId, corrupt.home);
    mkdirSync(dirname(corruptPath), { recursive: true });
    writeFileSync(corruptPath, "{");
    const corruptResult = runInit(corrupt, join(corrupt.project, "session"), [
      "--auto", "--claude-session-id", corruptId,
    ]);
    assert.equal(corruptResult.json.created, false);
    assert.match(corruptResult.json.error, /cannot verify existing session registry/i);

    const missing = tempFixture("registry-missing-state");
    const missingId = "claude-session-missing-state";
    writeSessionRegistry({
      sessionId: missingId,
      sessionDir: join(missing.project, "missing-session"),
      projectRoot: missing.project,
      registeredAt: new Date().toISOString(),
    }, missing.home);
    const missingResult = runInit(missing, join(missing.project, "new-session"), [
      "--auto", "--claude-session-id", missingId,
    ]);
    assert.equal(missingResult.json.created, false);
    assert.match(missingResult.json.error, /cannot verify existing registered flow/i);

    const unsafe = tempFixture("registry-unsafe-existing");
    const unsafeId = "claude-session-unsafe-existing";
    const interactiveDir = join(unsafe.project, "interactive");
    assert.equal(runInit(unsafe, interactiveDir).json.created, true);
    writeSessionRegistry({
      sessionId: unsafeId,
      sessionDir: interactiveDir,
      projectRoot: unsafe.project,
      registeredAt: new Date().toISOString(),
    }, unsafe.home);
    const unsafeResult = runInit(unsafe, join(unsafe.project, "new-session"), [
      "--auto", "--claude-session-id", unsafeId,
    ]);
    assert.equal(unsafeResult.json.created, false);
    assert.match(unsafeResult.json.error, /not safely replaceable/i);
  });

  test("auto init releases its registry lock when an existing state needs --force", () => {
    const fixture = tempFixture("auto-existing-state");
    const sessionId = "claude-session-existing-state";
    const dir = join(fixture.project, "session");
    assert.equal(runInit(fixture, dir).json.created, true);

    const result = runInit(fixture, dir, ["--auto", "--claude-session-id", sessionId]);

    assert.equal(result.json.created, false);
    assert.match(result.json.error, /already exists.*--force/i);
    assert.equal(existsSync(`${registryPath(sessionId, fixture.home)}.lock`), false);
    assert.equal(readSessionRegistry(sessionId, fixture.home), null);
  });

  test("registry write failure rolls back a newly created session", () => {
    const fixture = tempFixture("registry-failure");
    mkdirSync(join(fixture.home, ".opc"), { recursive: true });
    writeFileSync(join(fixture.home, ".opc", "runtime"), "not-a-directory");
    const dir = join(fixture.project, "session");

    const result = runInit(fixture, dir, [
      "--auto", "--claude-session-id", "claude-session-registry-failure",
    ]);

    assert.equal(result.json.created, false);
    assert.match(result.json.error, /session registry/i);
    assert.equal(existsSync(dir), false);
  });

  test("registry publication failure restores the previous latest implicit session", async () => {
    const fixture = tempFixture("registry-latest-rollback");
    const prior = run(harness, [
      "init",
      "--flow", "review",
      "--entry", "review",
      "--no-extensions",
    ], fixture);
    assert.equal(prior.json.created, true, JSON.stringify(prior.json));
    const sessionsDir = dirname(prior.json.dir);
    const latest = join(sessionsDir, "latest");
    assert.equal(realpathSync(latest), prior.json.dir);

    const failed = await runWithRegistryPublicationFailure(fixture, [
      "init",
      "--flow", "review",
      "--entry", "review",
      "--no-extensions",
      "--auto",
      "--claude-session-id", "claude-session-latest-rollback",
    ]);

    assert.equal(failed.json.created, false, JSON.stringify(failed.json));
    assert.match(failed.json.error, /cannot write session registry/i);
    assert.equal(realpathSync(latest), prior.json.dir);
    const sessions = readdirSync(sessionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory());
    assert.equal(sessions.length, 1);
  });

  test("latest rollback failure preserves the primary registry error", async () => {
    const fixture = tempFixture("registry-latest-rollback-failure");
    const prior = run(harness, [
      "init",
      "--flow", "review",
      "--entry", "review",
      "--no-extensions",
    ], fixture);
    assert.equal(prior.json.created, true, JSON.stringify(prior.json));
    const latest = join(dirname(prior.json.dir), "latest");
    const preload = join(fixture.root, "fail-latest-rollback.cjs");
    writeFileSync(preload, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalReadlinkSync = fs.readlinkSync;
let matchingReads = 0;
fs.readlinkSync = function(path, ...args) {
  if (String(path) === process.env.OPC_TEST_LATEST_LINK) {
    matchingReads += 1;
    if (matchingReads === 2) {
      const error = new Error("rollback read denied");
      error.code = "EACCES";
      throw error;
    }
  }
  return originalReadlinkSync.call(this, path, ...args);
};
syncBuiltinESMExports();
`);

    const nodeOptions = [
      process.env.NODE_OPTIONS,
      `--require=${preload}`,
    ].filter(Boolean).join(" ");
    const failed = await runWithRegistryPublicationFailure(fixture, [
      "init",
      "--flow", "review",
      "--entry", "review",
      "--no-extensions",
      "--auto",
      "--claude-session-id", "claude-session-latest-rollback-failure",
    ], {
      NODE_OPTIONS: nodeOptions,
      OPC_TEST_LATEST_LINK: latest,
    });

    assert.equal(failed.status, 0, failed.stderr);
    assert.equal(failed.json.created, false, JSON.stringify(failed.json));
    assert.match(failed.json.error, /cannot write session registry/i);
    assert.equal(existsSync(prior.json.dir), true);
  });

  test("registry publication failure removes latest when no prior session exists", async () => {
    const fixture = tempFixture("registry-latest-remove");
    const failed = await runWithRegistryPublicationFailure(fixture, [
      "init",
      "--flow", "review",
      "--entry", "review",
      "--no-extensions",
      "--auto",
      "--claude-session-id", "claude-session-latest-remove",
    ]);

    assert.equal(failed.json.created, false, JSON.stringify(failed.json));
    assert.match(failed.json.error, /cannot write session registry/i);
    const sessionsBase = join(fixture.home, ".opc", "sessions");
    const latestLinks = existsSync(sessionsBase)
      ? readdirSync(sessionsBase).flatMap(projectHash =>
        readdirSync(join(sessionsBase, projectHash))
          .filter(name => name === "latest")
      )
      : [];
    assert.deepEqual(latestLinks, []);
  });

  test("registry publication failure restores an existing explicit session", async () => {
    const fixture = tempFixture("registry-explicit-rollback");
    const dir = join(fixture.project, "session");
    const prior = runInit(fixture, dir);
    assert.equal(prior.json.created, true, JSON.stringify(prior.json));
    const statePath = join(dir, "flow-state.json");
    const priorState = readFileSync(statePath, "utf8");
    const sentinel = join(dir, "nodes", "sentinel.txt");
    writeFileSync(sentinel, "keep");

    const failed = await runWithRegistryPublicationFailure(fixture, [
      "init",
      "--flow", "review",
      "--entry", "review",
      "--dir", dir,
      "--force",
      "--no-extensions",
      "--auto",
      "--claude-session-id", "claude-session-explicit-rollback",
    ]);

    assert.equal(failed.json.created, false, JSON.stringify(failed.json));
    assert.match(failed.json.error, /cannot write session registry/i);
    assert.equal(readFileSync(statePath, "utf8"), priorState);
    assert.equal(readFileSync(sentinel, "utf8"), "keep");
  });

  test("auto init reports registry lock contention", () => {
    const fixture = tempFixture("registry-lock-contention");
    const sessionId = "claude-session-lock-contention";
    const lockPath = `${registryPath(sessionId, fixture.home)}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      nonce: "held-by-test",
      timestamp: new Date().toISOString(),
      command: "test",
    }));
    const dir = join(fixture.project, "session");

    const result = runInit(fixture, dir, [
      "--auto", "--claude-session-id", sessionId,
    ]);

    assert.equal(result.json.created, false);
    assert.match(result.json.error, /cannot acquire session registry lock/);
    assert.equal(existsSync(dir), false);
  });

  test("concurrent auto init binds exactly one flow to a Claude session", async () => {
    const fixture = tempFixture("registry-concurrent");
    const sessionId = "claude-session-concurrent";
    const firstDir = join(fixture.project, "first");
    const secondDir = join(fixture.project, "second");
    const args = dir => [
      "init",
      "--flow", "review",
      "--entry", "review",
      "--dir", dir,
      "--no-extensions",
      "--auto",
      "--claude-session-id", sessionId,
    ];

    const results = await Promise.all([
      runAsync(harness, args(firstDir), fixture),
      runAsync(harness, args(secondDir), fixture),
    ]);
    const winners = results.filter(result => result.json?.created === true);
    const losers = results.filter(result => result.json?.created === false);

    assert.equal(winners.length, 1, JSON.stringify(results.map(result => result.json)));
    assert.equal(losers.length, 1, JSON.stringify(results.map(result => result.json)));
    assert.match(losers[0].json.error, /already bound to an active auto flow/);
    const registry = readSessionRegistry(sessionId, fixture.home);
    assert.equal(registry.sessionDir, winners[0].json.dir);
    assert.equal(existsSync(winners[0].json.dir), true);
    assert.equal(existsSync(winners[0].json.dir === firstDir ? secondDir : firstDir), false);
  });
});

describe("session GC registry consistency", () => {
  function createImplicitAutoFlow(fixture, sessionId) {
    const result = run(harness, [
      "init",
      "--flow", "review",
      "--entry", "review",
      "--no-extensions",
      "--auto",
      "--claude-session-id", sessionId,
    ], fixture);
    assert.equal(result.json?.created, true, JSON.stringify(result.json));
    return result.json.dir;
  }

  function backdateState(sessionDir) {
    const old = new Date("2026-07-01T00:00:00.000Z");
    utimesSync(join(sessionDir, "flow-state.json"), old, old);
  }

  test("GC removes an expired interactive session without a registry", () => {
    const fixture = tempFixture("gc-interactive");
    const created = run(harness, [
      "init",
      "--flow", "review",
      "--entry", "review",
      "--no-extensions",
    ], fixture);
    assert.equal(created.json?.created, true, JSON.stringify(created.json));
    backdateState(created.json.dir);

    const result = run(harness, ["gc", "--max-age", "7"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(created.json.dir), false);
    assert.match(JSON.stringify(result.json?.deleted || []), new RegExp(basename(created.json.dir)));
  });

  test("GC preserves an active auto flow with a matching registry", () => {
    const fixture = tempFixture("gc-active-auto");
    const sessionId = "claude-session-gc-active";
    const sessionDir = createImplicitAutoFlow(fixture, sessionId);
    backdateState(sessionDir);

    const result = run(harness, ["gc", "--max-age", "7"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(sessionDir), true);
    assert.equal(readSessionRegistry(sessionId, fixture.home).sessionDir, sessionDir);
    assert.doesNotMatch(JSON.stringify(result.json?.deleted || []), new RegExp(basename(sessionDir)));
  });

  test("GC removes a terminal auto flow and its matching registry together", () => {
    const fixture = tempFixture("gc-terminal-auto");
    const sessionId = "claude-session-gc-terminal";
    const sessionDir = createImplicitAutoFlow(fixture, sessionId);
    const statePath = join(sessionDir, "flow-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.status = "stopped";
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    backdateState(sessionDir);

    const result = run(harness, ["gc", "--max-age", "7"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(sessionDir), false);
    assert.equal(readSessionRegistry(sessionId, fixture.home), null);
    assert.match(JSON.stringify(result.json?.deleted || []), new RegExp(basename(sessionDir)));
  });

  test("GC cannot delete a same-dir auto flow reinitialized after its stale read", async () => {
    const fixture = tempFixture("gc-reinit-race");
    const sessionId = "claude-session-gc-reinit-race";
    const sessionDir = createImplicitAutoFlow(fixture, sessionId);
    const statePath = join(sessionDir, "flow-state.json");
    const terminal = JSON.parse(readFileSync(statePath, "utf8"));
    terminal.status = "stopped";
    writeFileSync(statePath, JSON.stringify(terminal, null, 2) + "\n");
    backdateState(sessionDir);

    const signal = join(fixture.root, "gc-read-stale-state");
    const release = join(fixture.root, "gc-resume");
    const preload = join(fixture.root, "pause-first-state-read.cjs");
    writeFileSync(preload, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalReadFileSync = fs.readFileSync;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
let paused = false;
fs.readFileSync = function(path, ...args) {
  const result = originalReadFileSync.call(this, path, ...args);
  if (!paused && String(path) === process.env.OPC_TEST_PAUSE_PATH) {
    paused = true;
    fs.writeFileSync(process.env.OPC_TEST_PAUSE_SIGNAL, "ready");
    while (!fs.existsSync(process.env.OPC_TEST_PAUSE_RELEASE)) {
      Atomics.wait(sleepBuffer, 0, 0, 10);
    }
  }
  return result;
};
syncBuiltinESMExports();
`);

    const pendingGc = runAsync(harness, ["gc", "--max-age", "7"], {
      ...fixture,
      env: {
        NODE_OPTIONS: `--require=${preload}`,
        OPC_TEST_PAUSE_PATH: statePath,
        OPC_TEST_PAUSE_SIGNAL: signal,
        OPC_TEST_PAUSE_RELEASE: release,
      },
    });
    await waitForFile(signal);

    const replacement = runInit(fixture, sessionDir, [
      "--force", "--auto", "--claude-session-id", sessionId,
    ]);
    assert.equal(replacement.json?.created, true, JSON.stringify(replacement.json));
    writeFileSync(release, "resume");
    const gc = await pendingGc;

    assert.equal(gc.status, 0, gc.stderr);
    assert.equal(existsSync(sessionDir), true);
    assert.equal(readSessionRegistry(sessionId, fixture.home).sessionDir, sessionDir);
    const active = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(active.status, undefined);
    assert.equal(active.autoMode, true);
    assert.doesNotMatch(JSON.stringify(gc.json?.deleted || []), new RegExp(basename(sessionDir)));
  });

  test("GC preserves an auto flow when the registry identity is corrupt", () => {
    const fixture = tempFixture("gc-registry-identity");
    const sessionId = "claude-session-gc-identity";
    const sessionDir = createImplicitAutoFlow(fixture, sessionId);
    const path = registryPath(sessionId, fixture.home);
    const registry = JSON.parse(readFileSync(path, "utf8"));
    registry.sessionId = "different-session";
    writeFileSync(path, JSON.stringify(registry, null, 2) + "\n");
    backdateState(sessionDir);

    const result = run(harness, ["gc", "--max-age", "7"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(sessionDir), true);
    assert.equal(existsSync(path), true);
    assert.match(JSON.stringify(result.json?.errors || []), /registry identity/i);
  });

  test("GC deletes an orphan after the same session registry moves to a new dir", () => {
    const fixture = tempFixture("gc-registry-moved");
    const sessionId = "claude-session-gc-moved";
    const sessionDir = createImplicitAutoFlow(fixture, sessionId);
    const replacementDir = join(fixture.project, "replacement");
    mkdirSync(replacementDir);
    const path = registryPath(sessionId, fixture.home);
    const registry = JSON.parse(readFileSync(path, "utf8"));
    registry.sessionDir = replacementDir;
    writeFileSync(path, JSON.stringify(registry, null, 2) + "\n");
    backdateState(sessionDir);

    const result = run(harness, ["gc", "--max-age", "7"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(sessionDir), false);
    assert.equal(readSessionRegistry(sessionId, fixture.home).sessionDir, replacementDir);
  });

  test("GC keeps the terminal session when registry cleanup cannot acquire its lock", () => {
    const fixture = tempFixture("gc-registry-lock");
    const sessionId = "claude-session-gc-lock";
    const sessionDir = createImplicitAutoFlow(fixture, sessionId);
    const statePath = join(sessionDir, "flow-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.status = "completed";
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    backdateState(sessionDir);

    const lockPath = `${registryPath(sessionId, fixture.home)}.lock`;
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      nonce: "held-by-test",
      timestamp: new Date().toISOString(),
      command: "test",
    }));

    const result = run(harness, ["gc", "--max-age", "7"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(sessionDir), true);
    assert.equal(readSessionRegistry(sessionId, fixture.home).sessionDir, sessionDir);
    assert.match(JSON.stringify(result.json?.errors || []), /registry lock/i);
  });

  test("GC preserves an auto flow whose state has no Claude session ID", () => {
    const fixture = tempFixture("gc-missing-session-id");
    const sessionId = "claude-session-gc-missing-id";
    const sessionDir = createImplicitAutoFlow(fixture, sessionId);
    const statePath = join(sessionDir, "flow-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    delete state._claudeSessionId;
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    backdateState(sessionDir);

    const result = run(harness, ["gc", "--max-age", "7"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(sessionDir), true);
    assert.match(JSON.stringify(result.json?.errors || []), /missing Claude session ID/i);
  });

  test("GC preserves an auto flow when its registry JSON is malformed", () => {
    const fixture = tempFixture("gc-malformed-registry");
    const sessionId = "claude-session-gc-malformed-registry";
    const sessionDir = createImplicitAutoFlow(fixture, sessionId);
    writeFileSync(registryPath(sessionId, fixture.home), "{");
    backdateState(sessionDir);

    const result = run(harness, ["gc", "--max-age", "7"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(sessionDir), true);
    assert.match(JSON.stringify(result.json?.errors || []), /registry.*JSON|JSON.*registry/i);
  });

  test("GC deletes an expired auto flow when its registry is absent", () => {
    const fixture = tempFixture("gc-absent-registry");
    const sessionId = "claude-session-gc-absent-registry";
    const sessionDir = createImplicitAutoFlow(fixture, sessionId);
    unlinkSync(registryPath(sessionId, fixture.home));
    backdateState(sessionDir);

    const result = run(harness, ["gc", "--max-age", "7"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(sessionDir), false);
    assert.match(JSON.stringify(result.json?.deleted || []), new RegExp(basename(sessionDir)));
  });

  test("GC preserves an expired session whose flow state is malformed", () => {
    const fixture = tempFixture("gc-malformed-state");
    const sessionId = "claude-session-gc-malformed-state";
    const sessionDir = createImplicitAutoFlow(fixture, sessionId);
    const statePath = join(sessionDir, "flow-state.json");
    writeFileSync(statePath, "{");
    backdateState(sessionDir);

    const result = run(harness, ["gc", "--max-age", "7"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(sessionDir), true);
    assert.match(JSON.stringify(result.json?.errors || []), /cannot read expired session/i);
  });
});

describe("external recovery", () => {
  for (const recovery of [
    { name: "goto", flow: "review", entry: "review", args: ["goto", "gate"] },
    { name: "skip", flow: "review", entry: "review", args: ["skip"] },
    { name: "pass", flow: "pre-release", entry: "gate-acceptance", args: ["pass"] },
    { name: "stop", flow: "review", entry: "review", args: ["stop"] },
  ]) {
    test(`${recovery.name} restores hook allowance without deleting old evidence`, () => {
      const fixture = tempFixture(`recovery-${recovery.name}`);
      const dir = join(fixture.project, "session");
      const sessionId = `claude-session-recovery-${recovery.name}`;
      const init = run(harness, [
        "init",
        "--flow", recovery.flow,
        "--entry", recovery.entry,
        "--dir", dir,
        "--no-extensions",
        "--auto",
        "--claude-session-id", sessionId,
      ], fixture);
      assert.equal(init.json.created, true, JSON.stringify(init.json));

      const state = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
      const stopped = createStopMarker(dir, state, { reason: "tool-call-budget" });
      assert.equal(claimToolSlot(stopped.paths, { toolUseId: "before-recovery" }), 1);
      assertHookDenied(evaluatePreToolUse(hookInput(fixture, sessionId), { home: fixture.home }));

      const recovered = run(harness, [...recovery.args, "--dir", dir], fixture);
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(recovered.json?.error, undefined, JSON.stringify(recovered.json));
      assert.deepEqual(
        evaluatePreToolUse(hookInput(fixture, sessionId, "after-recovery"), { home: fixture.home }),
        { allowed: true },
      );
      assert.equal(existsSync(stopped.path), true);
      assert.equal(readdirSync(stopped.paths.slots).length, 1);
    });
  }
});

function installFakeJq(root) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const jq = join(bin, "jq");
  writeFileSync(jq, "#!/bin/sh\nexit 0\n");
  chmodSync(jq, 0o755);
  return `${bin}:${process.env.PATH}`;
}

describe("hook installation", () => {
  test("install-hooks registers PreToolUse without jq after a normal install", () => {
    const fixture = tempFixture("install-hooks-no-jq", { hookInstalled: false });
    const noJqPath = join(fixture.root, "no-jq-bin");
    mkdirSync(noJqPath);

    const installed = run(opcCli, ["install"], fixture);
    const hooks = run(opcCli, ["install-hooks"], { ...fixture, path: noJqPath });

    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /auto-flow guards/);
    assert.equal(hooks.status, 0, hooks.stderr);
    assert.match(hooks.stdout, /jq not found/);
    const settings = JSON.parse(readFileSync(join(fixture.home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.equal(settings.hooks.PreCompact, undefined);
    assert.equal(settings.hooks.PostCompact, undefined);
  });

  test("install-hooks preserves existing hooks and adds PreToolUse idempotently", () => {
    const fixture = tempFixture("install-hooks", { hookInstalled: false });
    const skillsParent = join(fixture.home, ".claude", "skills");
    mkdirSync(skillsParent, { recursive: true });
    symlinkSync(repoRoot, join(skillsParent, "opc"));
    const settingsPath = join(fixture.home, ".claude", "settings.json");
    const custom = { type: "command", command: "custom-hook" };
    const scopedOpc = {
      type: "command",
      command: `node "${join(skillsParent, "opc", "bin", "hooks", "opc-pre-tool-budget.mjs")}"`,
      async: true,
    };
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [custom, scopedOpc] }],
        Notification: [{ hooks: [custom] }],
      },
    }, null, 2));
    const path = installFakeJq(fixture.root);

    const first = run(opcCli, ["install-hooks"], { ...fixture, path });
    const second = run(opcCli, ["install-hooks"], { ...fixture, path });

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(settings.hooks.Notification.length, 1);
    assert.equal(settings.hooks.PreCompact.length, 1);
    assert.equal(settings.hooks.PostCompact.length, 1);
    assert.equal(settings.hooks.PreToolUse.length, 2);
    const opcHooks = settings.hooks.PreToolUse.flatMap(entry => entry.hooks || [])
      .filter(hook => hook.command?.includes("opc-pre-tool-budget.mjs"));
    assert.equal(opcHooks.length, 2);
    const globalOpcHooks = settings.hooks.PreToolUse
      .filter(entry => entry.matcher == null || entry.matcher === "")
      .flatMap(entry => entry.hooks || [])
      .filter(hook => hook.command === scopedOpc.command);
    assert.equal(globalOpcHooks.length, 1);
    assert.equal(globalOpcHooks[0].type, "command");
  });

  test("uninstall removes only OPC-owned hooks before deleting the skill", () => {
    const fixture = tempFixture("uninstall-hooks", { hookInstalled: false });
    const skill = join(fixture.home, ".claude", "skills", "opc");
    mkdirSync(dirname(skill), { recursive: true });
    symlinkSync(repoRoot, skill);
    const settingsPath = join(fixture.home, ".claude", "settings.json");
    const custom = { type: "command", command: "custom-hook" };
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [{ hooks: [
          { type: "command", command: `bash "${join(skill, "bin", "hooks", "opc-pre-compact.sh")}"` },
          custom,
        ] }],
        PostCompact: [{ hooks: [
          { type: "command", command: `bash "${join(skill, "bin", "hooks", "opc-post-compact.sh")}"` },
        ] }],
        PreToolUse: [{ hooks: [
          { type: "command", command: `node "${join(skill, "bin", "hooks", "opc-pre-tool-budget.mjs")}"` },
          custom,
        ] }],
        Notification: [{ hooks: [custom] }],
      },
    }, null, 2));

    const result = run(opcCli, ["uninstall"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(skill), false);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(settings.hooks.PreCompact, [{ hooks: [custom] }]);
    assert.equal(settings.hooks.PostCompact, undefined);
    assert.deepEqual(settings.hooks.PreToolUse, [{ hooks: [custom] }]);
    assert.deepEqual(settings.hooks.Notification, [{ hooks: [custom] }]);
  });

  test("uninstall aborts before deletion when settings are malformed", () => {
    const fixture = tempFixture("uninstall-malformed-settings", { hookInstalled: false });
    const skill = join(fixture.home, ".claude", "skills", "opc");
    mkdirSync(dirname(skill), { recursive: true });
    symlinkSync(repoRoot, skill);
    const settingsPath = join(fixture.home, ".claude", "settings.json");
    writeFileSync(settingsPath, "{");

    const result = run(opcCli, ["uninstall"], fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot safely uninstall OPC/);
    assert.equal(existsSync(skill), true);
    assert.equal(readFileSync(settingsPath, "utf8"), "{");
  });

  test("uninstall preserves unrelated settings when the skill is already absent", () => {
    const fixture = tempFixture("uninstall-absent-skill", { hookInstalled: false });
    const settingsPath = join(fixture.home, ".claude", "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    const settings = {
      hooks: {
        PreCompact: "custom-shape",
        PostCompact: [{}],
        PreToolUse: [{ hooks: [{ type: "command", command: "custom-hook" }] }],
      },
    };
    const original = JSON.stringify(settings, null, 2);
    writeFileSync(settingsPath, original);

    const result = run(opcCli, ["uninstall"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Nothing else to remove/);
    assert.equal(readFileSync(settingsPath, "utf8"), original);
  });

  test("uninstall succeeds when both settings and skill are absent", () => {
    const fixture = tempFixture("uninstall-fully-absent", { hookInstalled: false });

    const result = run(opcCli, ["uninstall"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Nothing else to remove/);
  });

  test("missing PreToolUse script fails without modifying settings", () => {
    const fixture = tempFixture("install-hooks-missing", { hookInstalled: false });
    const hooks = join(fixture.home, ".claude", "skills", "opc", "bin", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "opc-pre-compact.sh"), "#!/bin/sh\n");
    writeFileSync(join(hooks, "opc-post-compact.sh"), "#!/bin/sh\n");
    const settingsPath = join(fixture.home, ".claude", "settings.json");
    const original = JSON.stringify({ hooks: { Notification: [] } }, null, 2);
    writeFileSync(settingsPath, original);

    const result = run(opcCli, ["install-hooks"], {
      ...fixture,
      path: installFakeJq(fixture.root),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /opc-pre-tool-budget\.mjs/);
    assert.equal(readFileSync(settingsPath, "utf8"), original);
  });
});

describe("bounded auto instructions", () => {
  test("skill and runtime remove unconditional continuation", () => {
    const skill = readFileSync(skillFile, "utf8");
    const loopAdvance = readFileSync(join(repoRoot, "bin", "lib", "loop-advance.mjs"), "utf8");
    assert.match(skill, /opc-harness init --auto --claude-session-id "\$\{CLAUDE_SESSION_ID\}"/);
    assert.match(skill, /opc-harness init --flow \{TEMPLATE\} --entry \{ENTRY_NODE\} # interactive/);
    assert.doesNotMatch(`${skill}\n${loopAdvance}`, /do not pause, do not ask user, keep executing|Anything else = keep executing/);
    assert.match(skill, /when the circuit breaker trips, stop and report immediately/i);
  });
});
