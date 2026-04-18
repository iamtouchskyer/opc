// extensions.test.mjs — Node.js built-in test runner
// Run: node --test bin/lib/extensions.test.mjs

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadExtensions,
  firePromptAppend,
  fireVerdictAppend,
  saveRegistryCache,
  readRegistryApplied,
  normalizeHook,
  resolveBypass,
  normalizeCapability,
  _resetBareCapabilityWarnings,
  lintCapability,
} from "./extensions.mjs";

// ─── Test helpers ────────────────────────────────────────────────

function makeTmpDir() {
  const dir = join(tmpdir(), `opc-ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeExtension(extDir, hookContent, promptContent = "") {
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, "hook.mjs"), hookContent, "utf8");
  if (promptContent) writeFileSync(join(extDir, "prompt.md"), promptContent, "utf8");
}

// Convenience: build ctx with nodeCapabilities
function ctx(overrides = {}) {
  return {
    node: "code-review",
    role: "x",
    task: "t",
    flowDir: "/tmp",
    runDir: "/tmp",
    nodeCapabilities: ["visual-consistency-check"],
    ...overrides,
  };
}

// ─── loadExtensions ──────────────────────────────────────────────

describe("loadExtensions", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("no extensions dir → returns empty registry (no throw)", async () => {
    const config = { extensionsDir: join(tmpBase, "nonexistent") };
    const registry = await loadExtensions(config);
    assert.deepEqual(registry.applied, []);
    assert.deepEqual(registry.extensions, []);
  });

  test("empty extensions dir → returns empty registry", async () => {
    const extDir = join(tmpBase, "extensions");
    mkdirSync(extDir);
    const registry = await loadExtensions({ extensionsDir: extDir });
    assert.deepEqual(registry.applied, []);
  });

  test("valid extension dir → loads extension", async () => {
    const extDir = join(tmpBase, "extensions");
    const alphaDir = join(extDir, "alpha");
    writeExtension(alphaDir, `export default { hooks: { 'startup.check': async () => {} } };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    assert.equal(registry.applied.length, 1);
    assert.equal(registry.applied[0], "alpha");
    assert.equal(registry.extensions[0].name, "alpha");
    assert.equal(registry.extensions[0].enabled, true);
  });

  test("skips .git directory silently (no warn, no crash)", async () => {
    const extDir = join(tmpBase, "extensions");
    // Simulate a git clone — .git/ exists with random files inside
    mkdirSync(join(extDir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(extDir, ".git", "config"), "[core]\n", "utf8");
    writeExtension(join(extDir, "real"), `export default { hooks: {} };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    assert.deepEqual(registry.applied, ["real"]);
  });

  test("skips dotfile directories (.DS_Store, .vscode)", async () => {
    const extDir = join(tmpBase, "extensions");
    mkdirSync(join(extDir, ".DS_Store"), { recursive: true });
    mkdirSync(join(extDir, ".vscode"), { recursive: true });
    writeExtension(join(extDir, "real"), `export default { hooks: {} };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    assert.deepEqual(registry.applied, ["real"]);
  });

  test("skips subdirs without hook.mjs silently", async () => {
    const extDir = join(tmpBase, "extensions");
    mkdirSync(join(extDir, "not-an-extension"), { recursive: true });
    writeFileSync(join(extDir, "not-an-extension", "README.md"), "hello", "utf8");
    writeExtension(join(extDir, "real"), `export default { hooks: {} };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    assert.deepEqual(registry.applied, ["real"]);
  });

  test("missing required extension → throws FATAL", async () => {
    const extDir = join(tmpBase, "extensions");
    mkdirSync(extDir);
    const config = { extensionsDir: extDir, requiredExtensions: ["missing-ext"] };
    await assert.rejects(
      () => loadExtensions(config),
      (err) => {
        assert.ok(err.message.includes("FATAL"));
        assert.ok(err.message.includes("missing-ext"));
        return true;
      }
    );
  });

  test("optional extension startup.check throws → warns, continues", async () => {
    const extDir = join(tmpBase, "extensions");
    const badDir = join(extDir, "bad-ext");
    writeExtension(badDir, `export default { hooks: { 'startup.check': async () => { throw new Error("env var missing"); } } };`);
    const goodDir = join(extDir, "good-ext");
    writeExtension(goodDir, `export default { hooks: {} };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    assert.ok(registry.applied.includes("good-ext"));
    assert.ok(!registry.applied.includes("bad-ext"));
  });

  test("required extension startup.check fails → throws FATAL", async () => {
    const extDir = join(tmpBase, "extensions");
    const reqDir = join(extDir, "req-ext");
    writeExtension(reqDir, `export default { hooks: { 'startup.check': async () => { throw new Error("missing env"); } } };`);
    await assert.rejects(
      () => loadExtensions({ extensionsDir: extDir, requiredExtensions: ["req-ext"] }),
      (err) => {
        assert.ok(err.message.includes("FATAL"));
        assert.ok(err.message.includes("req-ext"));
        return true;
      }
    );
  });

  test("OPC_EXTENSIONS_DIR env overrides default", async () => {
    const extDir = join(tmpBase, "env-extensions");
    mkdirSync(extDir);
    const origEnv = process.env.OPC_EXTENSIONS_DIR;
    process.env.OPC_EXTENSIONS_DIR = extDir;
    try {
      const registry = await loadExtensions({});
      assert.deepEqual(registry.applied, []);
    } finally {
      if (origEnv === undefined) delete process.env.OPC_EXTENSIONS_DIR;
      else process.env.OPC_EXTENSIONS_DIR = origEnv;
    }
  });

  test("extensionOrder array is respected", async () => {
    const extDir = join(tmpBase, "extensions");
    for (const name of ["zzz", "aaa", "mmm"]) {
      writeExtension(join(extDir, name), `export default { hooks: {} };`);
    }
    const registry = await loadExtensions({
      extensionsDir: extDir,
      extensionOrder: ["mmm", "zzz", "aaa"],
    });
    assert.deepEqual(registry.applied, ["mmm", "zzz", "aaa"]);
  });

  test("alphabetical fallback when no extensionOrder", async () => {
    const extDir = join(tmpBase, "extensions");
    for (const name of ["zzz", "aaa", "mmm"]) {
      writeExtension(join(extDir, name), `export default { hooks: {} };`);
    }
    const registry = await loadExtensions({ extensionsDir: extDir });
    assert.deepEqual(registry.applied, ["aaa", "mmm", "zzz"]);
  });

  test("meta.provides is normalized to array even if missing", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "no-meta"), `export default { hooks: {} };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    assert.deepEqual(registry.extensions[0].meta.provides, []);
  });

  test("meta.provides as string (malformed) → warn + treated as []", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "bad-meta"), `
export const meta = { name: "bad-meta", provides: "not-an-array" };
export async function promptAppend() { return "should not fire"; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    assert.deepEqual(registry.extensions[0].meta.provides, []);
    // With empty provides, hook should never fire
    const result = await firePromptAppend(registry, ctx({ nodeCapabilities: ["any-cap"] }));
    assert.equal(result, "");
  });
});

// ─── firePromptAppend — capability matching ──────────────────────

describe("firePromptAppend (capability matching)", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("fires when ext.provides matches nodeCapabilities", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "lint"), `
export const meta = { name: "lint", provides: ["visual-consistency-check"] };
export async function promptAppend() { return "## Lint fired"; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const result = await firePromptAppend(registry, ctx({ nodeCapabilities: ["visual-consistency-check"] }));
    assert.ok(result.includes("## Lint fired"));
  });

  test("does NOT fire when no capability match", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "lint"), `
export const meta = { name: "lint", provides: ["visual-consistency-check"] };
export async function promptAppend() { return "## should not fire"; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const result = await firePromptAppend(registry, ctx({ nodeCapabilities: ["security-check"] }));
    assert.equal(result, "");
  });

  test("does NOT fire when nodeCapabilities is empty", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "lint"), `
export const meta = { name: "lint", provides: ["visual-consistency-check"] };
export async function promptAppend() { return "## should not fire"; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const result = await firePromptAppend(registry, ctx({ nodeCapabilities: [] }));
    assert.equal(result, "");
  });

  test("does NOT fire when nodeCapabilities missing entirely", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "lint"), `
export const meta = { name: "lint", provides: ["visual-consistency-check"] };
export async function promptAppend() { return "## should not fire"; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    // ctx with no nodeCapabilities at all
    const result = await firePromptAppend(registry, { node: "code-review", role: "x", task: "t", flowDir: tmpBase, runDir: tmpBase });
    assert.equal(result, "");
  });

  test("extension with provides:[] never fires", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "pure"), `
export const meta = { name: "pure", provides: [] };
export async function startupCheck() { /* side effects only */ }
export async function promptAppend() { return "## never"; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    // Even with matching capabilities, provides:[] = 0 matches
    const result = await firePromptAppend(registry, ctx({ nodeCapabilities: ["anything"] }));
    assert.equal(result, "");
    assert.equal(registry.applied.length, 1, "pure extension should still be loaded");
  });

  test("multiple extensions — only matching ones fire", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "a"), `
export const meta = { name: "a", provides: ["cap-a"] };
export async function promptAppend() { return "## A"; }
`);
    writeExtension(join(extDir, "b"), `
export const meta = { name: "b", provides: ["cap-b"] };
export async function promptAppend() { return "## B"; }
`);
    writeExtension(join(extDir, "c"), `
export const meta = { name: "c", provides: ["cap-c"] };
export async function promptAppend() { return "## C"; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const result = await firePromptAppend(registry, ctx({ nodeCapabilities: ["cap-a", "cap-c"] }));
    assert.ok(result.includes("## A"));
    assert.ok(!result.includes("## B"));
    assert.ok(result.includes("## C"));
  });

  test("ext.provides can have multiple capabilities; any match fires", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "multi"), `
export const meta = { name: "multi", provides: ["cap-a", "cap-b"] };
export async function promptAppend() { return "## Multi"; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    // Only cap-b matches; should still fire
    const result = await firePromptAppend(registry, ctx({ nodeCapabilities: ["cap-b"] }));
    assert.ok(result.includes("## Multi"));
  });

  test("extension with no prompt.append hook → silent skip", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "quiet"), `
export const meta = { name: "quiet", provides: ["cap-a"] };
export default { hooks: {} };
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const result = await firePromptAppend(registry, ctx({ nodeCapabilities: ["cap-a"] }));
    assert.equal(result, "");
  });

  test("prompt.append throws → warn + continue; partial result returned", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "ok"), `
export const meta = { name: "ok", provides: ["cap"] };
export async function promptAppend() { return "## OK"; }
`);
    writeExtension(join(extDir, "throws"), `
export const meta = { name: "throws", provides: ["cap"] };
export async function promptAppend() { throw new Error("boom"); }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const result = await firePromptAppend(registry, ctx({ nodeCapabilities: ["cap"] }));
    assert.ok(result.includes("## OK"));
  });

  test("prompt.append returning non-string → warn + ignore", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "bad-return"), `
export const meta = { name: "bad-return", provides: ["cap"] };
export async function promptAppend() { return 42; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const result = await firePromptAppend(registry, ctx({ nodeCapabilities: ["cap"] }));
    assert.equal(result, "");
  });

  test("prompt.append slow hook is bounded by timeout", async () => {
    // Lower timeout for this test
    const origTimeout = process.env.OPC_HOOK_TIMEOUT_MS;
    process.env.OPC_HOOK_TIMEOUT_MS = "200";
    try {
      // Must re-import extensions.mjs with new env — but that's complicated.
      // Instead, use a hook that sleeps longer than our actual configured timeout
      // and rely on the current test runtime reading the env var. Since extensions.mjs
      // reads OPC_HOOK_TIMEOUT_MS at module-load time, we instead test by using a short-sleep
      // hook against the real 60s timeout — this test confirms timeout code-path exists
      // rather than actually triggering timeout within the test duration.
      // We verify a hook that sleeps briefly DOES resolve, confirming the timeout wrapper doesn't break normal path.
      const extDir = join(tmpBase, "extensions");
      writeExtension(join(extDir, "slow"), `
export const meta = { name: "slow", provides: ["cap"] };
export async function promptAppend() {
  await new Promise(r => setTimeout(r, 50));
  return "## done after 50ms";
}
`);
      const registry = await loadExtensions({ extensionsDir: extDir });
      const result = await firePromptAppend(registry, ctx({ nodeCapabilities: ["cap"] }));
      assert.ok(result.includes("## done after 50ms"));
    } finally {
      if (origTimeout === undefined) delete process.env.OPC_HOOK_TIMEOUT_MS;
      else process.env.OPC_HOOK_TIMEOUT_MS = origTimeout;
    }
  });
});

// ─── fireVerdictAppend — capability matching ─────────────────────

describe("fireVerdictAppend (capability matching)", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("writes eval-extensions.md with canonical severity emoji", async () => {
    const extDir = join(tmpBase, "extensions");
    const findings = [
      { severity: "error", category: "design-system", message: "Missing design token" },
      { severity: "warning", category: "design-lint", message: "Color contrast issue", file: "/src/Button.tsx" },
      { severity: "info", category: "design-system", message: "All good" },
    ];
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["visual-consistency-check"] };
export default { hooks: { 'verdict.append': async () => ${JSON.stringify(findings)} } };
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["visual-consistency-check"] }));
    const content = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    assert.ok(content.includes("# Extension Findings"));
    assert.ok(content.includes("🔴 design-system: Missing design token"));
    assert.ok(content.includes("🟡 design-lint: Color contrast issue in /src/Button.tsx"));
    assert.ok(content.includes("🔵 design-system: All good"));
  });

  test("no capability match → no findings from that extension", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["visual-consistency-check"] };
export async function verdictAppend() { return [{ severity: "info", category: "x", message: "should not show" }]; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["security-check"] }));
    const content = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    assert.ok(content.includes("No extension findings"));
  });

  test("no findings → placeholder line", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "empty"), `
export const meta = { name: "empty", provides: ["cap"] };
export async function verdictAppend() { return []; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run2");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }));
    const content = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    assert.ok(content.includes("🔵 extensions: No extension findings"));
  });

  test("missing runDir → creates dir and writes", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["cap"] };
export async function verdictAppend() { return [{ severity: "info", category: "test", message: "all good" }]; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "nonexistent-run", "nested");
    assert.ok(!existsSync(runDir));
    await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }));
    assert.ok(existsSync(join(runDir, "eval-extensions.md")));
  });

  test("verdict.append throws → warn + continue", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "good"), `
export const meta = { name: "good", provides: ["cap"] };
export async function verdictAppend() { return [{ severity: "info", category: "c", message: "ok" }]; }
`);
    writeExtension(join(extDir, "throws"), `
export const meta = { name: "throws", provides: ["cap"] };
export async function verdictAppend() { throw new Error("exploded"); }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "throw-run");
    mkdirSync(runDir);
    await assert.doesNotReject(() =>
      fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }))
    );
    const content = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    assert.ok(content.includes("🔵 c: ok"));
  });

  test("verdict.append returning non-array → warn + ignore", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "bad-return"), `
export const meta = { name: "bad-return", provides: ["cap"] };
export async function verdictAppend() { return "not an array"; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "bad-return-run");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }));
    const content = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    assert.ok(content.includes("No extension findings"));
  });

  test("empty registry → still creates eval-extensions.md", async () => {
    const extDir = join(tmpBase, "empty-ext-dir");
    mkdirSync(extDir);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run3");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }));
    assert.ok(existsSync(join(runDir, "eval-extensions.md")));
  });
});

// ─── normalizeHook (exported canonical) ──────────────────────────

describe("normalizeHook (exported)", () => {
  test("normalizes hooks object format", () => {
    const raw = { hooks: { "prompt.append": async () => "x" } };
    const hook = normalizeHook(raw, null);
    assert.equal(typeof hook.hooks["prompt.append"], "function");
  });

  test("normalizes named exports with camelCase", () => {
    const mod = {
      promptAppend: async () => "x",
      verdictAppend: async () => [],
      startupCheck: async () => {},
    };
    const hook = normalizeHook(mod, mod);
    assert.equal(typeof hook.hooks["prompt.append"], "function");
    assert.equal(typeof hook.hooks["verdict.append"], "function");
    assert.equal(typeof hook.hooks["startup.check"], "function");
  });

  test("normalizes named exports with dot-notation keys", () => {
    const mod = {
      "prompt.append": async () => "x",
      "verdict.append": async () => [],
    };
    const hook = normalizeHook(mod, mod);
    assert.equal(typeof hook.hooks["prompt.append"], "function");
    assert.equal(typeof hook.hooks["verdict.append"], "function");
  });
});

// ─── saveRegistryCache / readRegistryApplied ─────────────────────

describe("saveRegistryCache / readRegistryApplied", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("roundtrip: save then read returns same applied list", () => {
    const registry = { applied: ["ext-a", "ext-b"], extensions: [] };
    saveRegistryCache(tmpBase, registry);
    const result = readRegistryApplied(tmpBase);
    assert.deepEqual(result, ["ext-a", "ext-b"]);
  });

  test("readRegistryApplied returns [] when file missing", () => {
    const result = readRegistryApplied(join(tmpBase, "nonexistent"));
    assert.deepEqual(result, []);
  });

  test("saveRegistryCache writes bypass marker when present", () => {
    saveRegistryCache(tmpBase, {
      applied: [],
      extensions: [],
      bypass: { mode: "disable-all", source: "env" },
    });
    const cache = JSON.parse(readFileSync(join(tmpBase, ".ext-registry.json"), "utf8"));
    assert.deepEqual(cache.bypass, { mode: "disable-all", source: "env" });
  });

  test("saveRegistryCache writes bypass: null when absent", () => {
    saveRegistryCache(tmpBase, { applied: ["alpha"], extensions: [] });
    const cache = JSON.parse(readFileSync(join(tmpBase, ".ext-registry.json"), "utf8"));
    assert.equal(cache.bypass, null);
  });
});

// ─── Backwards compat: legacy hook formats ───────────────────────

describe("legacy hook formats", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("old-style named exports still work", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "old"), `
export const meta = { name: "old", provides: ["cap"] };
export async function promptAppend() { return "## Old works"; }
export async function verdictAppend() { return []; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    assert.equal(registry.applied.length, 1);
    const result = await firePromptAppend(registry, ctx({ nodeCapabilities: ["cap"] }));
    assert.ok(result.includes("## Old works"));
  });

  test("legacy startupCheck named export is called on load", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "checks"), `
export async function startupCheck() { throw new Error("env missing"); }
export async function promptAppend() { return "should not reach"; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    assert.equal(registry.applied.length, 0);
  });

  test("legacy { emoji, text } findings normalized", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "old-findings"), `
export const meta = { name: "old", provides: ["cap"] };
export async function verdictAppend() {
  return [
    { emoji: "🔴", text: "[ext] contrast: Low contrast ratio" },
    { emoji: "🟡", text: "[ext] spacing: Inconsistent margins", file: "/home" },
  ];
}
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "norm-run");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }));
    const content = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    assert.ok(content.includes("🔴 contrast: Low contrast ratio"));
    assert.ok(content.includes("🟡 spacing: Inconsistent margins in /home"));
  });
});

// ─── Benchmark bypass (U1.1) ─────────────────────────────────────

describe("resolveBypass", () => {
  let origEnv;
  beforeEach(() => { origEnv = process.env.OPC_DISABLE_EXTENSIONS; });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.OPC_DISABLE_EXTENSIONS;
    else process.env.OPC_DISABLE_EXTENSIONS = origEnv;
  });

  test("env OPC_DISABLE_EXTENSIONS=1 → disable-all/env (highest priority)", () => {
    process.env.OPC_DISABLE_EXTENSIONS = "1";
    // Even with conflicting flags, env wins
    const r = resolveBypass({ noExtensions: true, extensionWhitelist: ["a"], quietBypass: true });
    assert.equal(r.mode, "disable-all");
    assert.equal(r.source, "env");
  });

  test("config.noExtensions=true → disable-all/flag", () => {
    delete process.env.OPC_DISABLE_EXTENSIONS;
    const r = resolveBypass({ noExtensions: true, extensionWhitelist: ["a"], quietBypass: true });
    assert.equal(r.mode, "disable-all");
    assert.equal(r.source, "flag");
  });

  test("config.extensionWhitelist → whitelist/flag", () => {
    delete process.env.OPC_DISABLE_EXTENSIONS;
    const r = resolveBypass({ extensionWhitelist: ["alpha", "beta"], quietBypass: true });
    assert.equal(r.mode, "whitelist");
    assert.equal(r.source, "flag");
    assert.deepEqual(r.names, ["alpha", "beta"]);
  });

  test("no env + no flags → default", () => {
    delete process.env.OPC_DISABLE_EXTENSIONS;
    const r = resolveBypass({ quietBypass: true });
    assert.equal(r.mode, "default");
  });

  test("whitelist filters out empty/non-string names", () => {
    delete process.env.OPC_DISABLE_EXTENSIONS;
    const r = resolveBypass({ extensionWhitelist: ["alpha", "", null, undefined, "beta"], quietBypass: true });
    assert.deepEqual(r.names, ["alpha", "beta"]);
  });
});

describe("loadExtensions — benchmark bypass", () => {
  let tmpBase, origEnv;
  beforeEach(() => {
    tmpBase = makeTmpDir();
    origEnv = process.env.OPC_DISABLE_EXTENSIONS;
  });
  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.OPC_DISABLE_EXTENSIONS;
    else process.env.OPC_DISABLE_EXTENSIONS = origEnv;
  });

  function writeAlphaAndBeta(extDir) {
    writeExtension(join(extDir, "alpha"), `
export const meta = { name: "alpha", provides: ["cap"] };
export async function promptAppend() { return "ALPHA"; }
`);
    writeExtension(join(extDir, "beta"), `
export const meta = { name: "beta", provides: ["cap"] };
export async function promptAppend() { return "BETA"; }
`);
  }

  test("OPC_DISABLE_EXTENSIONS=1 returns empty registry without scanning disk", async () => {
    process.env.OPC_DISABLE_EXTENSIONS = "1";
    const extDir = join(tmpBase, "exts");
    writeAlphaAndBeta(extDir);
    const registry = await loadExtensions({ extensionsDir: extDir, quietBypass: true });
    assert.deepEqual(registry.applied, []);
    assert.deepEqual(registry.extensions, []);
  });

  test("OPC_DISABLE_EXTENSIONS=1 waives required extensions (benchmark reproducibility)", async () => {
    process.env.OPC_DISABLE_EXTENSIONS = "1";
    const extDir = join(tmpBase, "exts");
    // Don't write any extensions, but declare one required. Must NOT throw.
    const registry = await loadExtensions({
      extensionsDir: extDir,
      requiredExtensions: ["missing-required"],
      quietBypass: true,
    });
    assert.deepEqual(registry.applied, []);
  });

  test("config.noExtensions=true returns empty registry", async () => {
    delete process.env.OPC_DISABLE_EXTENSIONS;
    const extDir = join(tmpBase, "exts");
    writeAlphaAndBeta(extDir);
    const registry = await loadExtensions({ extensionsDir: extDir, noExtensions: true, quietBypass: true });
    assert.deepEqual(registry.applied, []);
  });

  test("config.extensionWhitelist=['alpha'] loads only alpha", async () => {
    delete process.env.OPC_DISABLE_EXTENSIONS;
    const extDir = join(tmpBase, "exts");
    writeAlphaAndBeta(extDir);
    const registry = await loadExtensions({
      extensionsDir: extDir,
      extensionWhitelist: ["alpha"],
      quietBypass: true,
    });
    assert.deepEqual(registry.applied, ["alpha"]);
  });

  test("empty whitelist → loads nothing", async () => {
    delete process.env.OPC_DISABLE_EXTENSIONS;
    const extDir = join(tmpBase, "exts");
    writeAlphaAndBeta(extDir);
    const registry = await loadExtensions({
      extensionsDir: extDir,
      extensionWhitelist: [],
      quietBypass: true,
    });
    assert.deepEqual(registry.applied, []);
  });

  test("priority: env beats noExtensions beats whitelist", async () => {
    // env + flag combo → env wins (disable-all)
    process.env.OPC_DISABLE_EXTENSIONS = "1";
    const extDir = join(tmpBase, "exts");
    writeAlphaAndBeta(extDir);
    const r1 = await loadExtensions({
      extensionsDir: extDir,
      noExtensions: true,
      extensionWhitelist: ["alpha"],
      quietBypass: true,
    });
    assert.deepEqual(r1.applied, []);

    // noExtensions + whitelist → noExtensions wins
    delete process.env.OPC_DISABLE_EXTENSIONS;
    const r2 = await loadExtensions({
      extensionsDir: extDir,
      noExtensions: true,
      extensionWhitelist: ["alpha"],
      quietBypass: true,
    });
    assert.deepEqual(r2.applied, []);
  });

  test("whitelist respects required-extensions: missing required still throws", async () => {
    delete process.env.OPC_DISABLE_EXTENSIONS;
    const extDir = join(tmpBase, "exts");
    writeAlphaAndBeta(extDir);
    // Require beta but whitelist only alpha → beta is effectively missing → throw
    await assert.rejects(
      () => loadExtensions({
        extensionsDir: extDir,
        extensionWhitelist: ["alpha"],
        requiredExtensions: ["beta"],
        quietBypass: true,
      }),
      /required extension 'beta' missing/
    );
  });
});

// ─── U1.2 — Capability versioning ─────────────────────────────────

describe("normalizeCapability", () => {
  beforeEach(() => { _resetBareCapabilityWarnings(); });

  test("versioned name passes through unchanged", () => {
    assert.equal(normalizeCapability("visual-check@2"), "visual-check@2");
    assert.equal(normalizeCapability("foo@1"), "foo@1");
    assert.equal(normalizeCapability("a@99"), "a@99");
  });

  test("bare name auto-upgrades to @1 with stderr WARN", () => {
    const origErr = console.error;
    let captured = "";
    console.error = (msg) => { captured += String(msg) + "\n"; };
    try {
      assert.equal(normalizeCapability("visual-check"), "visual-check@1");
      assert.match(captured, /auto-upgrading.*visual-check@1/);
    } finally {
      console.error = origErr;
    }
  });

  test("WARN fires once per bare name per process", () => {
    const origErr = console.error;
    let count = 0;
    console.error = () => { count++; };
    try {
      normalizeCapability("same-cap");
      normalizeCapability("same-cap");
      normalizeCapability("same-cap");
      assert.equal(count, 1, "same bare name should warn only once");
    } finally {
      console.error = origErr;
    }
  });

  test("different bare names warn separately", () => {
    const origErr = console.error;
    let count = 0;
    console.error = () => { count++; };
    try {
      normalizeCapability("cap-one");
      normalizeCapability("cap-two");
      normalizeCapability("cap-three");
      assert.equal(count, 3);
    } finally {
      console.error = origErr;
    }
  });

  test("invalid capability strings are returned unchanged (no match later)", () => {
    // Uppercase / numbers-first / malformed versioned — not normalized
    assert.equal(normalizeCapability("Foo"), "Foo");
    assert.equal(normalizeCapability("1foo"), "1foo");
    assert.equal(normalizeCapability("foo@v1"), "foo@v1");
    assert.equal(normalizeCapability("foo@"), "foo@");
    assert.equal(normalizeCapability(""), "");
  });
});

describe("capability matching — exact version", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); _resetBareCapabilityWarnings(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("ext provides foo@1, node requires foo@1 → fires", async () => {
    writeExtension(
      join(tmpBase, "ext"),
      `export const meta = { name: "ext", provides: ["foo@1"] };
       export async function promptAppend() { return "FIRED"; }`
    );
    const reg = await loadExtensions({ extensionsDir: tmpBase });
    const out = await firePromptAppend(reg, { ...ctx({ nodeCapabilities: ["foo@1"] }) });
    assert.equal(out, "FIRED");
  });

  test("ext provides foo@1, node requires foo@2 → does NOT fire", async () => {
    writeExtension(
      join(tmpBase, "ext"),
      `export const meta = { name: "ext", provides: ["foo@1"] };
       export async function promptAppend() { return "FIRED"; }`
    );
    const reg = await loadExtensions({ extensionsDir: tmpBase });
    const out = await firePromptAppend(reg, { ...ctx({ nodeCapabilities: ["foo@2"] }) });
    assert.equal(out, "");
  });
});

describe("capability matching — bare-name auto-upgrade symmetry", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); _resetBareCapabilityWarnings(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("ext provides bare 'foo', node requires foo@1 → fires (both normalized to foo@1)", async () => {
    writeExtension(
      join(tmpBase, "ext"),
      `export const meta = { name: "ext", provides: ["foo"] };
       export async function promptAppend() { return "OK"; }`
    );
    const reg = await loadExtensions({ extensionsDir: tmpBase });
    const out = await firePromptAppend(reg, { ...ctx({ nodeCapabilities: ["foo@1"] }) });
    assert.equal(out, "OK");
  });

  test("ext provides foo@1, node requires bare 'foo' → fires (both normalized to foo@1)", async () => {
    writeExtension(
      join(tmpBase, "ext"),
      `export const meta = { name: "ext", provides: ["foo@1"] };
       export async function promptAppend() { return "OK"; }`
    );
    const reg = await loadExtensions({ extensionsDir: tmpBase });
    const out = await firePromptAppend(reg, { ...ctx({ nodeCapabilities: ["foo"] }) });
    assert.equal(out, "OK");
  });

  test("bare-name matching emits WARN (stderr spy)", async () => {
    writeExtension(
      join(tmpBase, "ext"),
      `export const meta = { name: "ext", provides: ["bare-cap"] };
       export async function promptAppend() { return "FIRED"; }`
    );
    const origErr = console.error;
    let captured = "";
    console.error = (msg) => { captured += String(msg) + "\n"; };
    try {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      await firePromptAppend(reg, { ...ctx({ nodeCapabilities: ["bare-cap"] }) });
      assert.match(captured, /bare-cap.*@1/);
    } finally {
      console.error = origErr;
    }
  });
});

describe("capability matching — compatibleCapabilities", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); _resetBareCapabilityWarnings(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("ext provides visual@2 with compat=[visual@1] fires for visual@1 nodes", async () => {
    writeExtension(
      join(tmpBase, "ext"),
      `export const meta = {
         name: "ext",
         provides: ["visual@2"],
         compatibleCapabilities: ["visual@1"],
       };
       export async function promptAppend() { return "COMPAT"; }`
    );
    const reg = await loadExtensions({ extensionsDir: tmpBase });
    const out = await firePromptAppend(reg, { ...ctx({ nodeCapabilities: ["visual@1"] }) });
    assert.equal(out, "COMPAT");
  });

  test("ext provides visual@2 WITHOUT compat does not fire for visual@1", async () => {
    writeExtension(
      join(tmpBase, "ext"),
      `export const meta = { name: "ext", provides: ["visual@2"] };
       export async function promptAppend() { return "X"; }`
    );
    const reg = await loadExtensions({ extensionsDir: tmpBase });
    const out = await firePromptAppend(reg, { ...ctx({ nodeCapabilities: ["visual@1"] }) });
    assert.equal(out, "");
  });

  test("compatibleCapabilities also applies to verdict.append", async () => {
    writeExtension(
      join(tmpBase, "ext"),
      `export const meta = {
         name: "ext",
         provides: ["visual@2"],
         compatibleCapabilities: ["visual@1"],
       };
       export async function verdictAppend() {
         return [{ severity: "info", category: "t", message: "hit" }];
       }`
    );
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir, { recursive: true });
    const reg = await loadExtensions({ extensionsDir: tmpBase });
    await fireVerdictAppend(reg, { ...ctx({ nodeCapabilities: ["visual@1"], runDir }) });
    const md = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    assert.match(md, /hit/);
  });

  test("non-array compatibleCapabilities → treated as [] with WARN", async () => {
    writeExtension(
      join(tmpBase, "ext"),
      `export const meta = {
         name: "ext",
         provides: ["foo@1"],
         compatibleCapabilities: "not-an-array",
       };
       export async function promptAppend() { return "OK"; }`
    );
    const origErr = console.error;
    let captured = "";
    console.error = (msg) => { captured += String(msg) + "\n"; };
    try {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      assert.match(captured, /compatibleCapabilities is not an array/);
      // provides still works — this ext should fire for foo@1 nodes
      const out = await firePromptAppend(reg, { ...ctx({ nodeCapabilities: ["foo@1"] }) });
      assert.equal(out, "OK");
    } finally {
      console.error = origErr;
    }
  });

  test("compatibleCapabilities undefined → defaults to [] (no fire for unrelated cap)", async () => {
    writeExtension(
      join(tmpBase, "ext"),
      `export const meta = { name: "ext", provides: ["foo@1"] };
       export async function promptAppend() { return "X"; }`
    );
    const reg = await loadExtensions({ extensionsDir: tmpBase });
    assert.deepEqual(reg.extensions[0].meta.compatibleCapabilities, []);
  });
});

// ─── U1.2r — Regression: regex must reject non-positive integers ────

describe("normalizeCapability — version regex strictness", () => {
  beforeEach(() => { _resetBareCapabilityWarnings(); });

  test("rejects @0 (does not match versioned, treated as invalid passthrough)", () => {
    // @0 doesn't match versioned regex AND doesn't match bare regex →
    // returned as-is. Critical: it must NOT be treated as canonical.
    assert.equal(normalizeCapability("foo@0"), "foo@0");
    // And it must not equal a normalized real capability.
    assert.notEqual(normalizeCapability("foo@0"), normalizeCapability("foo"));
  });

  test("rejects leading-zero versions like @01, @007", () => {
    assert.equal(normalizeCapability("foo@01"), "foo@01");
    assert.equal(normalizeCapability("foo@007"), "foo@007");
    // None of these should equal foo@1.
    assert.notEqual(normalizeCapability("foo@01"), "foo@1");
    assert.notEqual(normalizeCapability("foo@007"), "foo@1");
  });

  test("accepts @1, @2, @99, @100 (positive integers)", () => {
    assert.equal(normalizeCapability("foo@1"), "foo@1");
    assert.equal(normalizeCapability("foo@2"), "foo@2");
    assert.equal(normalizeCapability("foo@99"), "foo@99");
    assert.equal(normalizeCapability("foo@100"), "foo@100");
  });

  test("invalid versions do not silently match valid normalized form", () => {
    // A node requiring "foo@1" must not accidentally match an ext providing "foo@01".
    // Both pass through normalize as-is when they don't match canonical regex,
    // so set comparison still works correctly.
    const required = ["foo@1"];
    const provided = ["foo@01"]; // invalid form
    const reqSet = new Set(required.map(normalizeCapability));
    const isMatch = provided.map(normalizeCapability).some(c => reqSet.has(c));
    assert.equal(isMatch, false, "@01 must not match @1");
  });
});

// ─── U1.2r — Regression: built-in flow templates must not WARN ──────

describe("built-in flow templates — no bare capability tokens", () => {
  test("FLOW_TEMPLATES nodeCapabilities all use versioned form", async () => {
    const { FLOW_TEMPLATES } = await import("./flow-templates.mjs");
    const versionedRe = /^[a-z][a-z0-9-]*@[1-9]\d*$/;
    const offenders = [];
    for (const [tplName, tpl] of Object.entries(FLOW_TEMPLATES)) {
      const caps = tpl.nodeCapabilities || {};
      for (const [nodeName, capList] of Object.entries(caps)) {
        for (const cap of capList) {
          if (!versionedRe.test(cap)) {
            offenders.push(`${tplName}.${nodeName}: '${cap}'`);
          }
        }
      }
    }
    assert.deepEqual(offenders, [],
      `built-in flow-templates.mjs has bare capability tokens — these will trigger WARN spam on cold start: ${offenders.join(", ")}`);
  });

  test("loading built-in templates emits no capability WARNs", async () => {
    _resetBareCapabilityWarnings();
    const { FLOW_TEMPLATES } = await import("./flow-templates.mjs");
    const origErr = console.error;
    let captured = "";
    console.error = (msg) => { captured += String(msg) + "\n"; };
    try {
      // Touch every cap through normalizeCapability — simulates startup
      for (const tpl of Object.values(FLOW_TEMPLATES)) {
        for (const capList of Object.values(tpl.nodeCapabilities || {})) {
          for (const cap of capList) normalizeCapability(cap);
        }
      }
    } finally {
      console.error = origErr;
    }
    assert.equal(captured, "", `built-in templates triggered WARNs:\n${captured}`);
  });
});

// ─── U1.3 — Hook failure isolation, recording, circuit-breaker ─────

import { writeFailureReport, resetExtension, HookTimeoutError } from "./extensions.mjs";

// Helper: silence console.error during noisy negative tests but still fail
// loudly if a test expects no errors. Wrap a fn and return captured stderr.
async function captureStderr(fn) {
  const orig = console.error;
  let buf = "";
  console.error = (...args) => { buf += args.map(String).join(" ") + "\n"; };
  try { return { result: await fn(), stderr: buf }; }
  finally { console.error = orig; }
}

describe("U1.3 — failure isolation in firePromptAppend", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

  test("a throwing extension does not block sibling extensions", async () => {
    writeExtension(
      join(tmpBase, "a-bad"),
      `export const meta = { name: "a-bad", provides: ["cap@1"] };
       export async function promptAppend() { throw new Error("boom"); }`
    );
    writeExtension(
      join(tmpBase, "b-good"),
      `export const meta = { name: "b-good", provides: ["cap@1"] };
       export async function promptAppend() { return "## from b\\n"; }`
    );
    const { result } = await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      const out = await firePromptAppend(reg, { nodeCapabilities: ["cap@1"] });
      return { reg, out };
    });
    assert.match(result.out, /from b/, "sibling output must survive");
    assert.equal(result.reg.failures.length, 1);
    assert.equal(result.reg.failures[0].ext, "a-bad");
    assert.equal(result.reg.failures[0].kind, "throw");
    assert.equal(result.reg.failures[0].hook, "prompt.append");
  });

  test("bad-return (non-string) is recorded as bad-return, not throw", async () => {
    writeExtension(
      join(tmpBase, "ext"),
      `export const meta = { name: "ext", provides: ["cap@1"] };
       export async function promptAppend() { return 42; }`
    );
    const { result } = await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      await firePromptAppend(reg, { nodeCapabilities: ["cap@1"] });
      return reg;
    });
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].kind, "bad-return");
    assert.match(result.failures[0].message, /number.*string/);
  });

  test("timeout is recorded as kind=timeout", async () => {
    process.env.OPC_HOOK_TIMEOUT_MS = "50";
    const mod = await import(`./extensions.mjs?timeout=${Date.now()}`);
    writeExtension(
      join(tmpBase, "slow"),
      `export const meta = { name: "slow", provides: ["cap@1"] };
       export async function promptAppend() {
         return new Promise(r => setTimeout(() => r("late"), 500));
       }`
    );
    try {
      const { result } = await captureStderr(async () => {
        const reg = await mod.loadExtensions({ extensionsDir: tmpBase });
        await mod.firePromptAppend(reg, { nodeCapabilities: ["cap@1"] });
        return reg;
      });
      assert.equal(result.failures.length, 1);
      assert.equal(result.failures[0].kind, "timeout");
    } finally {
      delete process.env.OPC_HOOK_TIMEOUT_MS;
    }
  });

  test("successful invocation resets failure streak", async () => {
    writeExtension(
      join(tmpBase, "flaky"),
      `let n = 0;
       export const meta = { name: "flaky", provides: ["cap@1"] };
       export async function promptAppend() {
         n++;
         if (n === 1) throw new Error("first call fails");
         return "## ok\\n";
       }`
    );
    await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      await firePromptAppend(reg, { nodeCapabilities: ["cap@1"] }); // fail
      await firePromptAppend(reg, { nodeCapabilities: ["cap@1"] }); // success — resets
      assert.equal(reg.extensions[0]._failStreak, 0);
      assert.equal(reg.extensions[0].enabled, true);
    });
  });
});

describe("U1.3 — circuit-breaker", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
    delete process.env.OPC_HOOK_FAILURE_THRESHOLD;
  });

  test("breaker trips after 3 consecutive failures (default threshold)", async () => {
    writeExtension(
      join(tmpBase, "doomed"),
      `export const meta = { name: "doomed", provides: ["cap@1"] };
       export async function promptAppend() { throw new Error("nope"); }`
    );
    await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      const ctx = { nodeCapabilities: ["cap@1"] };
      await firePromptAppend(reg, ctx);
      await firePromptAppend(reg, ctx);
      assert.equal(reg.extensions[0].enabled, true, "still enabled after 2 fails");
      await firePromptAppend(reg, ctx);
      assert.equal(reg.extensions[0].enabled, false, "disabled after 3rd fail");
      assert.match(reg.extensions[0].disabledReason, /circuit-breaker/);
      // 4th call must be a no-op — fn never invoked, no new failure recorded.
      const before = reg.failures.length;
      await firePromptAppend(reg, ctx);
      // Only the auto-injected disabled record is present, no new "throw".
      assert.equal(reg.failures.length, before, "no new failures after disable");
    });
  });

  test("OPC_HOOK_FAILURE_THRESHOLD=0 disables the breaker", async () => {
    // The threshold is read at module load via process.env, so we reload via
    // dynamic import with a fresh URL query each time.
    process.env.OPC_HOOK_FAILURE_THRESHOLD = "0";
    const mod = await import(`./extensions.mjs?breaker0=${Date.now()}`);
    writeExtension(
      join(tmpBase, "doomed"),
      `export const meta = { name: "doomed", provides: ["cap@1"] };
       export async function promptAppend() { throw new Error("nope"); }`
    );
    await captureStderr(async () => {
      const reg = await mod.loadExtensions({ extensionsDir: tmpBase });
      const ctx = { nodeCapabilities: ["cap@1"] };
      for (let i = 0; i < 5; i++) await mod.firePromptAppend(reg, ctx);
      // 5 throws recorded, 0 disabled records, ext still enabled.
      assert.equal(reg.failures.filter(f => f.kind === "disabled").length, 0);
      assert.equal(reg.extensions[0].enabled, true);
      assert.equal(reg.failures.length, 5);
    });
  });

  test("breaker is per-extension, not global", async () => {
    writeExtension(
      join(tmpBase, "a-doomed"),
      `export const meta = { name: "a-doomed", provides: ["cap@1"] };
       export async function promptAppend() { throw new Error("nope"); }`
    );
    writeExtension(
      join(tmpBase, "b-fine"),
      `export const meta = { name: "b-fine", provides: ["cap@1"] };
       export async function promptAppend() { return "ok\\n"; }`
    );
    await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      const ctx = { nodeCapabilities: ["cap@1"] };
      for (let i = 0; i < 4; i++) await firePromptAppend(reg, ctx);
      const a = reg.extensions.find(e => e.name === "a-doomed");
      const b = reg.extensions.find(e => e.name === "b-fine");
      assert.equal(a.enabled, false, "a tripped");
      assert.equal(b.enabled, true, "b unaffected");
    });
  });
});

describe("U1.3 — failure report file", () => {
  let tmpBase;
  let runDir;
  beforeEach(() => {
    tmpBase = makeTmpDir();
    runDir = makeTmpDir();
  });
  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
    try { rmSync(runDir, { recursive: true, force: true }); } catch {}
  });

  test("extension-failures.md written by fireVerdictAppend even when no failures", async () => {
    writeExtension(
      join(tmpBase, "ok"),
      `export const meta = { name: "ok", provides: ["cap@1"] };
       export async function verdictAppend() { return [{ severity: "info", category: "x", message: "y" }]; }`
    );
    await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      await fireVerdictAppend(reg, { nodeCapabilities: ["cap@1"], runDir });
    });
    const path = join(runDir, "extension-failures.md");
    assert.ok(existsSync(path), "failures report must be written");
    const body = readFileSync(path, "utf8");
    assert.match(body, /No hook failures recorded/);
    // Filename must NOT start with `eval-` so synthesize's `eval*.md` glob skips it.
    assert.ok(!existsSync(join(runDir, "eval-extension-failures.md")),
      "filename must not start with eval- (would trip synthesize thin-eval guards)");
  });

  test("extension-failures.md lists failures and disabled events", async () => {
    writeExtension(
      join(tmpBase, "bad"),
      `export const meta = { name: "bad", provides: ["cap@1"] };
       export async function verdictAppend() { throw new Error("explode"); }`
    );
    await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      const ctx = { nodeCapabilities: ["cap@1"], runDir };
      // Trip the breaker by firing 3 times.
      await fireVerdictAppend(reg, ctx);
      await fireVerdictAppend(reg, ctx);
      await fireVerdictAppend(reg, ctx);
    });
    const body = readFileSync(join(runDir, "extension-failures.md"), "utf8");
    assert.match(body, /bad\.verdict\.append \[throw\]/);
    assert.match(body, /\[disabled\]/);
    // First two writes have only throws (🟡); after trip there's also a 🔴.
    assert.match(body, /🔴/);
    assert.match(body, /🟡/);
  });

  test("writeFailureReport works standalone (orchestrator can call after firePromptAppend)", async () => {
    writeExtension(
      join(tmpBase, "x"),
      `export const meta = { name: "x", provides: ["cap@1"] };
       export async function promptAppend() { throw new Error("e"); }`
    );
    await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      await firePromptAppend(reg, { nodeCapabilities: ["cap@1"] });
      writeFailureReport(reg, runDir);
    });
    const body = readFileSync(join(runDir, "extension-failures.md"), "utf8");
    assert.match(body, /x\.prompt\.append \[throw\]/);
  });
});

// ─── U1.3r — fix-forward additions (contract & resilience reviewers) ─────

describe("U1.3r — HookTimeoutError sentinel (resilience 🟡)", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

  test("non-timeout Error containing 'timed out after' substring is NOT misclassified", async () => {
    // Pre-fix: regex /timed out after/ on err.message would mis-tag this as timeout.
    // Post-fix: classification is by HookTimeoutError sentinel only.
    writeExtension(
      join(tmpBase, "trickster"),
      `export const meta = { name: "trickster", provides: ["cap@1"] };
       export async function promptAppend() { throw new Error("operation timed out after retry"); }`
    );
    const { result } = await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      await firePromptAppend(reg, { nodeCapabilities: ["cap@1"] });
      return reg;
    });
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].kind, "throw",
      "user error containing 'timed out after' must be kind=throw, not timeout");
  });

  test("HookTimeoutError is exported and identifiable", () => {
    const err = new HookTimeoutError("x");
    assert.equal(err.name, "HookTimeoutError");
    assert.ok(err instanceof Error);
  });
});

describe("U1.3r — sync-throw hook (resilience 🔵 → 🟢 lock contract)", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

  test("non-async hook that throws synchronously is caught and recorded", async () => {
    writeExtension(
      join(tmpBase, "syncthrow"),
      `export const meta = { name: "syncthrow", provides: ["cap@1"] };
       // intentionally NOT async — sync throw before returning a promise
       export function promptAppend() { throw new Error("sync boom"); }`
    );
    writeExtension(
      join(tmpBase, "sibling"),
      `export const meta = { name: "sibling", provides: ["cap@1"] };
       export async function promptAppend() { return "## sibling-ok\\n"; }`
    );
    const { result } = await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      const out = await firePromptAppend(reg, { nodeCapabilities: ["cap@1"] });
      return { reg, out };
    });
    assert.match(result.out, /sibling-ok/, "sibling must run despite sync throw");
    assert.equal(result.reg.failures.length, 1);
    assert.equal(result.reg.failures[0].ext, "syncthrow");
    assert.equal(result.reg.failures[0].kind, "throw");
  });
});

describe("U1.3r — resetExtension helper (resilience 🟡)", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

  test("after trip + resetExtension, ext must NOT re-trip on the next single failure", async () => {
    writeExtension(
      join(tmpBase, "doomed"),
      `export const meta = { name: "doomed", provides: ["cap@1"] };
       export async function promptAppend() { throw new Error("nope"); }`
    );
    await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      const ctx = { nodeCapabilities: ["cap@1"] };
      for (let i = 0; i < 3; i++) await firePromptAppend(reg, ctx);
      assert.equal(reg.extensions[0].enabled, false, "tripped after 3");
      // Naive `ext.enabled = true` would re-trip on the very next failure
      // because _failStreak is still 3. resetExtension clears it.
      resetExtension(reg.extensions[0]);
      assert.equal(reg.extensions[0]._failStreak, 0);
      assert.equal(reg.extensions[0].disabledReason, undefined);
      await firePromptAppend(reg, ctx); // single failure
      assert.equal(reg.extensions[0].enabled, true,
        "single post-reset failure must NOT re-trip the breaker");
      assert.equal(reg.extensions[0]._failStreak, 1);
    });
  });
});

describe("U1.3r — failures[] cap (resilience 🟡)", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
    delete process.env.OPC_HOOK_FAILURE_LOG_CAP;
    delete process.env.OPC_HOOK_FAILURE_THRESHOLD;
  });

  test("failures[] is bounded; oldest dropped FIFO; failuresDropped tracks loss", async () => {
    process.env.OPC_HOOK_FAILURE_LOG_CAP = "5";
    process.env.OPC_HOOK_FAILURE_THRESHOLD = "0"; // disable breaker so we can pump
    const mod = await import(`./extensions.mjs?cap=${Date.now()}`);
    writeExtension(
      join(tmpBase, "flaky"),
      `export const meta = { name: "flaky", provides: ["cap@1"] };
       export async function promptAppend() { throw new Error("e"); }`
    );
    await captureStderr(async () => {
      const reg = await mod.loadExtensions({ extensionsDir: tmpBase });
      const ctx = { nodeCapabilities: ["cap@1"] };
      for (let i = 0; i < 12; i++) await mod.firePromptAppend(reg, ctx);
      assert.equal(reg.failures.length, 5, "cap must hold");
      assert.equal(reg.failuresDropped, 7, "dropped count must match overflow");
    });
  });
});

// ─── U1.5 — lintCapability + extension-test CLI lint ─────────────

describe("U1.5 — lintCapability", () => {
  test("versioned capability name@N passes with reason=versioned", () => {
    assert.deepEqual(lintCapability("visual-check@1"), { ok: true, reason: "versioned" });
    assert.deepEqual(lintCapability("a@1"),              { ok: true, reason: "versioned" });
    assert.deepEqual(lintCapability("foo-bar-baz@42"),   { ok: true, reason: "versioned" });
  });

  test("bare capability name passes with reason=bare (auto-upgrade later)", () => {
    assert.deepEqual(lintCapability("foo"),        { ok: true, reason: "bare" });
    assert.deepEqual(lintCapability("visual-check"), { ok: true, reason: "bare" });
  });

  test("non-string values fail with reason=not-a-string", () => {
    assert.deepEqual(lintCapability(1),         { ok: false, reason: "not-a-string" });
    assert.deepEqual(lintCapability(null),      { ok: false, reason: "not-a-string" });
    assert.deepEqual(lintCapability(undefined), { ok: false, reason: "not-a-string" });
    assert.deepEqual(lintCapability({}),        { ok: false, reason: "not-a-string" });
    assert.deepEqual(lintCapability([]),        { ok: false, reason: "not-a-string" });
  });

  test("empty string fails with reason=empty", () => {
    assert.deepEqual(lintCapability(""), { ok: false, reason: "empty" });
  });

  test("malformed shapes fail with reason=invalid-shape", () => {
    // @0 (zero version) — rejected by regex
    assert.deepEqual(lintCapability("foo@0"),      { ok: false, reason: "invalid-shape" });
    // leading zero version
    assert.deepEqual(lintCapability("foo@01"),     { ok: false, reason: "invalid-shape" });
    // uppercase not allowed
    assert.deepEqual(lintCapability("Foo"),        { ok: false, reason: "invalid-shape" });
    assert.deepEqual(lintCapability("FOO@1"),      { ok: false, reason: "invalid-shape" });
    // leading digit / hyphen
    assert.deepEqual(lintCapability("1foo"),       { ok: false, reason: "invalid-shape" });
    assert.deepEqual(lintCapability("-foo"),       { ok: false, reason: "invalid-shape" });
    // whitespace / illegal chars
    assert.deepEqual(lintCapability("foo bar"),    { ok: false, reason: "invalid-shape" });
    assert.deepEqual(lintCapability("foo_bar"),    { ok: false, reason: "invalid-shape" });
    assert.deepEqual(lintCapability("foo@"),       { ok: false, reason: "invalid-shape" });
    assert.deepEqual(lintCapability("foo@bar"),    { ok: false, reason: "invalid-shape" });
    assert.deepEqual(lintCapability("foo@1@2"),    { ok: false, reason: "invalid-shape" });
  });
});

describe("U1.5 — extension-test CLI lints meta capability shape", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

  // Capture both stdout and stderr across a synchronous-looking async fn.
  async function captureAll(fn) {
    const origOut = console.log, origErr = console.error;
    let out = "", err = "";
    console.log = (...a) => { out += a.map(String).join(" ") + "\n"; };
    console.error = (...a) => { err += a.map(String).join(" ") + "\n"; };
    const origExit = process.exit;
    let exitCode = 0;
    process.exit = (c) => { exitCode = c; throw new Error(`__exit__${c}`); };
    try {
      try { await fn(); } catch (e) { if (!/^__exit__/.test(e.message)) throw e; }
      return { out, err, exitCode };
    } finally {
      console.log = origOut; console.error = origErr; process.exit = origExit;
    }
  }

  test("WARN printed for malformed meta.provides entry; exit code still 0", async () => {
    const extDir = join(tmpBase, "bad-caps");
    writeExtension(
      extDir,
      `export const meta = { name: "bad-caps", provides: ["good@1", "BAD@1", "foo@0", 123, ""] };
       export async function startupCheck() { return true; }`
    );
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u15=${Date.now()}`);
    const { out, err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--hook", "startup.check"])
    );
    // Lint WARNs go to stderr (same channel as bare-token auto-upgrade WARN)
    assert.match(err, /\[lint\] ⚠️ {2}meta\.provides entry "BAD@1" failed capability-shape check: invalid-shape/);
    assert.match(err, /\[lint\] ⚠️ {2}meta\.provides entry "foo@0" failed capability-shape check: invalid-shape/);
    assert.match(err, /\[lint\] ⚠️ {2}meta\.provides entry 123 failed capability-shape check: not-a-string/);
    assert.match(err, /\[lint\] ⚠️ {2}meta\.provides entry "" failed capability-shape check: empty/);
    // good@1 must NOT appear in WARN output
    assert.doesNotMatch(err, /entry "good@1" failed/);
    // WARN is non-fatal — startup.check ran and passed → exit 0
    assert.equal(exitCode, 0);
    assert.match(out, /\[startup\.check\] ✅ passed/);
  });

  test("WARN printed for malformed meta.compatibleCapabilities entry", async () => {
    const extDir = join(tmpBase, "bad-compat");
    writeExtension(
      extDir,
      `export const meta = { name: "bad-compat", provides: ["foo@1"], compatibleCapabilities: ["foo@1", "NOPE"] };
       export async function startupCheck() { return true; }`
    );
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u15c=${Date.now()}`);
    const { err } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--hook", "startup.check"])
    );
    assert.match(err, /meta\.compatibleCapabilities entry "NOPE" failed capability-shape check: invalid-shape/);
    assert.doesNotMatch(err, /entry "foo@1" failed/);
  });

  test("non-array meta.provides emits shape WARN", async () => {
    const extDir = join(tmpBase, "provides-not-array");
    writeExtension(
      extDir,
      `export const meta = { name: "x", provides: "foo@1" };
       export async function startupCheck() { return true; }`
    );
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u15na=${Date.now()}`);
    const { err } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--hook", "startup.check"])
    );
    assert.match(err, /\[lint\] ⚠️ {2}meta\.provides is not an array \(got string\)/);
  });

  test("well-formed caps emit no lint WARN", async () => {
    const extDir = join(tmpBase, "clean");
    writeExtension(
      extDir,
      `export const meta = { name: "clean", provides: ["a@1", "b-c@2"], compatibleCapabilities: ["a@1"] };
       export async function startupCheck() { return true; }`
    );
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u15cl=${Date.now()}`);
    const { out, err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--hook", "startup.check"])
    );
    assert.doesNotMatch(out, /\[lint\]/);
    assert.doesNotMatch(err, /\[lint\]/);
    assert.equal(exitCode, 0);
  });
});
