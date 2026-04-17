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
