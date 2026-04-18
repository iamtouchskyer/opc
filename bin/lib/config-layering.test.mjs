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
  stripProvenance,
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
      // stderr warning is emitted but execution continues — capture to avoid test noise
      const origErr = console.error; console.error = () => {};
      try {
        const out = loadLayeredOpcConfig(repo, {});
        assert.equal(out.ok, true); // repo still loaded
      } finally { console.error = origErr; }
    });
  });
});

// ─── U1.4r fix-forward regressions ───────────────────────────────

describe("U1.4r — prototype pollution hardening", () => {
  let home, repo;
  beforeEach(() => { home = tmp(); repo = tmp(); });
  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test("top-level __proto__ key in user config must NOT pollute returned object's prototype", () => {
    writeUserCfg(home, JSON.parse(
      '{"__proto__":{"injected":"YES","enableSafeMode":true},"ok":true}'
    ));
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, {});
      assert.equal(out.injected, undefined, "injected must not appear via prototype chain");
      assert.equal(out.enableSafeMode, undefined, "enableSafeMode must not leak through proto");
      assert.equal(Object.getPrototypeOf(out), Object.prototype, "prototype must remain Object.prototype");
      assert.equal(out.ok, true, "legitimate keys still merge");
    });
  });

  test("__proto__ in nested objects must not pollute via deep-merge", () => {
    writeUserCfg(home, JSON.parse('{"tool":{"__proto__":{"bad":"x"},"ok":true}}'));
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, {});
      assert.equal(out.tool.bad, undefined, "nested __proto__ must not leak");
      assert.equal(out.tool.ok, true);
    });
  });

  test("constructor / prototype keys are also dropped", () => {
    writeUserCfg(home, JSON.parse('{"constructor":"x","prototype":"y","ok":true}'));
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, {});
      assert.equal(out.ok, true);
      // constructor/prototype should be filtered (not set as own data properties)
      assert.ok(!Object.hasOwn(out, "constructor"), "constructor must not be a top-level merged key");
      assert.ok(!Object.hasOwn(out, "prototype"), "prototype must not be a top-level merged key");
    });
  });
});

describe("U1.4r — home/repo collision guard", () => {
  let home;
  beforeEach(() => { home = tmp(); });
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch {} });

  test("findRepoConfigPath must NOT return the user-layer path even when home is an ancestor", () => {
    writeUserCfg(home, { fromHome: true });
    withIsolatedHome(home, () => {
      // harnessDir === home → walk-up would otherwise match ~/.opc/config.json
      const found = findRepoConfigPath(home);
      assert.equal(found, null, "must skip home-dir match to prevent user/repo collapse");
    });
  });

  test("loadLayeredOpcConfig under home with no project .opc tags everything as user", () => {
    writeUserCfg(home, { fromHome: true, extensions: ["h"] });
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(home, {});
      assert.equal(out._paths.repo, null);
      assert.equal(out._source.fromHome, "user");
      assert.equal(out._source.extensions, "user", "single contributor ≠ layered");
    });
  });
});

describe("U1.4r — input validation & provenance reservation", () => {
  let home, repo;
  beforeEach(() => { home = tmp(); repo = tmp(); });
  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test("non-object JSON (array) at user layer is rejected with stderr warning", () => {
    mkdirSync(join(home, ".opc"), { recursive: true });
    writeFileSync(join(home, ".opc", "config.json"), '["not","an","object"]');
    writeRepoCfg(repo, { ok: true });
    const warnings = [];
    const origErr = console.error; console.error = (m) => warnings.push(m);
    try {
      withIsolatedHome(home, () => {
        const out = loadLayeredOpcConfig(repo, {});
        assert.ok(!Object.hasOwn(out, "0"), "indexed keys from array must not merge");
        assert.equal(out.ok, true, "repo layer still loads");
      });
    } finally { console.error = origErr; }
    assert.ok(warnings.some(w => /not a JSON object/.test(String(w))), "stderr warning expected");
  });

  test("user-authored _source / _paths top-level keys are stripped (reserved)", () => {
    writeUserCfg(home, { _source: { evil: "x" }, _paths: { user: "/evil" }, real: true });
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, {});
      assert.equal(out.real, true);
      // _source and _paths exist but only contain OPC-generated data
      assert.equal(out._source.evil, undefined, "user _source key must not leak in");
      assert.equal(out._source._source, undefined, "no meta-provenance keys");
      assert.notEqual(out._paths.user, "/evil", "user-supplied _paths must not override");
    });
  });

  test("malformed JSON emits one-line stderr warning", () => {
    mkdirSync(join(home, ".opc"), { recursive: true });
    writeFileSync(join(home, ".opc", "config.json"), "{ broken json");
    const warnings = [];
    const origErr = console.error; console.error = (m) => warnings.push(m);
    try {
      withIsolatedHome(home, () => { loadLayeredOpcConfig(repo, {}); });
    } finally { console.error = origErr; }
    assert.ok(warnings.some(w => /not valid JSON/.test(String(w))), "stderr warning expected");
  });
});

describe("U1.4r — stripProvenance helper", () => {
  test("removes _source / _paths / any _-prefixed key", () => {
    const cfg = {
      a: 1, nested: { b: 2 },
      _source: { a: "user" },
      _paths: { user: "/u" },
      _future: "x",
    };
    const stripped = stripProvenance(cfg);
    assert.equal(stripped.a, 1);
    assert.deepEqual(stripped.nested, { b: 2 });
    assert.ok(!("_source" in stripped));
    assert.ok(!("_paths" in stripped));
    assert.ok(!("_future" in stripped));
  });

  test("is a no-op on non-plain-object input", () => {
    assert.equal(stripProvenance(null), null);
    assert.equal(stripProvenance("x"), "x");
    assert.deepEqual(stripProvenance([1, 2]), [1, 2]);
  });
});

describe("U1.4r v2 — nested proto sanitization on single-layer passthrough", () => {
  let home, repo;
  beforeEach(() => { home = tmp(); repo = tmp(); });
  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test("single-layer nested __proto__ is stripped (Object.assign survives)", () => {
    // Only user layer contributes `alone` — no merge, so passthrough path.
    writeUserCfg(home, JSON.parse('{"alone":{"__proto__":{"polluted":"YES"},"legit":1}}'));
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, {});
      // Nested __proto__ must NOT survive as an own property.
      const ownKeys = Object.getOwnPropertyNames(out.alone);
      assert.ok(!ownKeys.includes("__proto__"), "nested __proto__ must be stripped");
      assert.equal(out.alone.legit, 1);
      assert.equal(Object.getPrototypeOf(out.alone), Object.prototype);

      // Object.assign (which uses [[Set]]) must NOT pollute a fresh target.
      const consumer = {};
      Object.assign(consumer, out.alone);
      assert.equal(Object.getPrototypeOf(consumer), Object.prototype,
        "Object.assign(target, cfg.nested) must not pollute target's prototype");
      assert.equal(consumer.polluted, undefined);
    });
  });

  test("single-layer nested constructor is stripped", () => {
    writeUserCfg(home, JSON.parse('{"alone":{"constructor":"x","legit":2}}'));
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, {});
      assert.ok(!Object.hasOwn(out.alone, "constructor"));
      assert.equal(out.alone.legit, 2);
    });
  });

  test("deeply nested (3+ levels) __proto__ via single-layer is stripped", () => {
    writeUserCfg(home, JSON.parse(
      '{"alone":{"nested":{"deeper":{"__proto__":{"polluted":"YES"},"ok":1}}}}'
    ));
    withIsolatedHome(home, () => {
      const out = loadLayeredOpcConfig(repo, {});
      const deeper = out.alone.nested.deeper;
      assert.ok(!Object.getOwnPropertyNames(deeper).includes("__proto__"));
      assert.equal(deeper.ok, 1);
      const consumer = {};
      Object.assign(consumer, deeper);
      assert.equal(Object.getPrototypeOf(consumer), Object.prototype);
    });
  });
});

describe("U1.4r — CLI --dir missing value", () => {
  test("`config resolve --dir` with no value exits non-zero", () => {
    const harnessBin = join(process.cwd(), "bin", "opc-harness.mjs");
    let threw = false;
    try {
      execFileSync("node", [harnessBin, "config", "resolve", "--dir"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      threw = true;
      assert.ok(err.status && err.status !== 0);
      assert.ok(/--dir requires/.test(String(err.stderr)), "stderr must explain missing value");
    }
    assert.ok(threw, "must exit non-zero when --dir has no value");
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
