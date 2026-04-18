// config-layering.test.mjs — U1.4: layered OPC config resolution
//
// Covers: user-only, repo-only, cli-only, three-way merge, extensions union,
// disabledExtensions overrides enable, scalars high-wins, deep-merge on objects,
// _source tagging per top-level key, findRepoConfigPath ancestor walk, and
// the `config resolve` CLI.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import os from "os";
import { execFileSync } from "child_process";

import {
  loadLayeredOpcConfig,
  findRepoConfigPath,
} from "./config-layering.mjs";

// ─── helpers ─────────────────────────────────────────────────────

function tmp() {
  const p = join(os.tmpdir(), `opc-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(p, { recursive: true });
  return p;
}
function writeRepoCfg(dir, cfg) {
  mkdirSync(join(dir, ".opc"), { recursive: true });
  writeFileSync(join(dir, ".opc", "config.json"), JSON.stringify(cfg, null, 2));
}
/** Isolate HOME so user-config path lookup can't see the real ~/.opc. */
function withIsolatedHome(homeOverride, fn) {
  const prev = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  process.env.HOME = homeOverride;
  process.env.USERPROFILE = homeOverride;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    if (prevUserprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserprofile;
  }
}
function writeUserCfg(home, cfg) {
  mkdirSync(join(home, ".opc"), { recursive: true });
  writeFileSync(join(home, ".opc", "config.json"), JSON.stringify(cfg, null, 2));
}

// ─── tests ───────────────────────────────────────────────────────

describe("U1.4 — findRepoConfigPath (ancestor walk)", () => {
  let base;
  beforeEach(() => { base = tmp(); });
  afterEach(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  test("returns null when no .opc/config.json exists on any ancestor", () => {
    const nested = join(base, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    // HOME should not leak — isolate to a different tmp so homedir's .opc doesn't match.
    withIsolatedHome(tmp(), () => {
      assert.equal(findRepoConfigPath(nested), null);
    });
  });

  test("walks parents up and finds nearest .opc/config.json", () => {
    const nested = join(base, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    writeRepoCfg(join(base, "a"), { extensions: ["x"] });
    withIsolatedHome(tmp(), () => {
      const found = findRepoConfigPath(nested);
      assert.equal(found, join(base, "a", ".opc", "config.json"));
    });
  });

  test("picks the deepest ancestor with .opc/config.json when multiple exist", () => {
    const nested = join(base, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    writeRepoCfg(base, { extensions: ["outer"] });
    writeRepoCfg(join(base, "a", "b"), { extensions: ["inner"] });
    withIsolatedHome(tmp(), () => {
      const found = findRepoConfigPath(nested);
      assert.equal(found, join(base, "a", "b", ".opc", "config.json"));
    });
  });
});

describe("U1.4 — loadLayeredOpcConfig (merging)", () => {
  let home, repo;
  beforeEach(() => { home = tmp(); repo = tmp(); });
  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test("user-only config is returned with _source=user tags", () => {
    writeUserCfg(home, { extensionsDir: "/user/exts", devServerUrl: "http://u" });
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, {});
      assert.equal(out.extensionsDir, "/user/exts");
      assert.equal(out.devServerUrl, "http://u");
      assert.equal(out._source.extensionsDir, "user");
      assert.equal(out._source.devServerUrl, "user");
    });
  });

  test("repo-only config is returned with _source=repo tags", () => {
    writeRepoCfg(repo, { devServerUrl: "http://r", extensions: ["a", "b"] });
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, {});
      assert.equal(out.devServerUrl, "http://r");
      assert.deepEqual(out.extensions, ["a", "b"]);
      assert.equal(out._source.devServerUrl, "repo");
      assert.equal(out._source.extensions, "repo");
    });
  });

  test("cli override wins over both user and repo (high-wins scalar)", () => {
    writeUserCfg(home, { devServerUrl: "http://u" });
    writeRepoCfg(repo, { devServerUrl: "http://r" });
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, { devServerUrl: "http://cli" });
      assert.equal(out.devServerUrl, "http://cli");
      assert.equal(out._source.devServerUrl, "cli");
    });
  });

  test("extensions are UNIONed across all three layers (not replaced)", () => {
    writeUserCfg(home, { extensions: ["u-only", "shared"] });
    writeRepoCfg(repo, { extensions: ["shared", "r-only"] });
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, { extensions: ["cli-only"] });
      assert.deepEqual(out.extensions, ["u-only", "shared", "r-only", "cli-only"]);
      assert.equal(out._source.extensions, "layered");
    });
  });

  test("disabledExtensions OVERRIDES enable from any layer", () => {
    writeUserCfg(home, { extensions: ["a", "b"] });
    writeRepoCfg(repo, { disabledExtensions: ["a"] });
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, {});
      // "a" was enabled in user, but repo disables it → final set is ["b"]
      assert.deepEqual(out.extensions, ["b"]);
      assert.deepEqual(out.disabledExtensions, ["a"]);
    });
  });

  test("deep-merge: object keys recurse, scalars high-wins per-leaf", () => {
    writeUserCfg(home, { tool: { timeout: 10, retries: 2 } });
    writeRepoCfg(repo, { tool: { retries: 5, region: "us" } });
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, { tool: { region: "eu" } });
      assert.deepEqual(out.tool, { timeout: 10, retries: 5, region: "eu" });
    });
  });

  test("arrays other than extensions* are high-wins replace (not union)", () => {
    writeUserCfg(home, { requiredExtensions: ["u1"] });
    writeRepoCfg(repo, { requiredExtensions: ["r1", "r2"] });
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, {});
      // repo replaces user wholesale for arrays not in the extensions* allowlist
      assert.deepEqual(out.requiredExtensions, ["r1", "r2"]);
      assert.equal(out._source.requiredExtensions, "repo");
    });
  });

  test("_paths map exposes resolved user and repo paths", () => {
    writeUserCfg(home, { a: 1 });
    writeRepoCfg(repo, { b: 2 });
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, {});
      assert.equal(out._paths.user, join(home, ".opc", "config.json"));
      assert.equal(out._paths.repo, join(repo, ".opc", "config.json"));
    });
  });

  test("malformed JSON in any layer is silently ignored (does not throw)", () => {
    mkdirSync(join(home, ".opc"), { recursive: true });
    writeFileSync(join(home, ".opc", "config.json"), "{ not valid json");
    writeRepoCfg(repo, { ok: true });
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, {});
      assert.equal(out.ok, true); // repo still loaded
    });
  });
});

describe("U1.4 — opc-harness config resolve CLI", () => {
  let home, repo;
  beforeEach(() => { home = tmp(); repo = tmp(); });
  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test("`config resolve --dir <p>` prints merged JSON with _source", () => {
    writeUserCfg(home, { devServerUrl: "http://u" });
    writeRepoCfg(repo, { extensions: ["a"] });
    const harnessBin = join(process.cwd(), "bin", "opc-harness.mjs");
    const stdout = execFileSync("node", [harnessBin, "config", "resolve", "--dir", repo], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.devServerUrl, "http://u");
    assert.deepEqual(parsed.extensions, ["a"]);
    assert.equal(parsed._source.devServerUrl, "user");
    assert.equal(parsed._source.extensions, "repo");
  });

  test("unknown subcommand exits non-zero", () => {
    const harnessBin = join(process.cwd(), "bin", "opc-harness.mjs");
    let threw = false;
    try {
      execFileSync("node", [harnessBin, "config", "bogus"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      threw = true;
      assert.ok(err.status && err.status !== 0);
    }
    assert.ok(threw, "must exit non-zero on unknown subcommand");
  });
});
