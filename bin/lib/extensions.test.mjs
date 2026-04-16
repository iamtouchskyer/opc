// extensions.test.mjs — Node.js built-in test runner
// Run: node --test bin/lib/extensions.test.mjs

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadExtensions, firePromptAppend, fireVerdictAppend, saveRegistryCache, readRegistryApplied } from "./extensions.mjs";

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

// ─── Tests ───────────────────────────────────────────────────────

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
    // bad-ext is optional (not in requiredExtensions)
    const registry = await loadExtensions({ extensionsDir: extDir });
    // bad-ext failed startup.check, good-ext should be applied
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
});

describe("firePromptAppend", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("concatenates strings from multiple extensions", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "ext-a"), `export default { hooks: { 'prompt.append': async () => "## A\\ncontent a" } };`);
    writeExtension(join(extDir, "ext-b"), `export default { hooks: { 'prompt.append': async () => "## B\\ncontent b" } };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const ctx = { node: "build", role: "frontend", task: "test", flowDir: tmpBase, runDir: tmpBase };
    const result = await firePromptAppend(registry, ctx);
    assert.ok(result.includes("## A"));
    assert.ok(result.includes("## B"));
    assert.ok(result.includes("\n\n"));
  });

  test("extension with no prompt.append hook → skipped silently", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "quiet"), `export default { hooks: {} };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const result = await firePromptAppend(registry, { node: "build", role: "x", task: "t", flowDir: tmpBase, runDir: tmpBase });
    assert.equal(result, "");
  });

  test("extension prompt.append throws → warns and continues, returns partial result", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "ext-ok"), `export default { hooks: { 'prompt.append': async () => "## OK\\nworks fine" } };`);
    writeExtension(join(extDir, "ext-throw"), `export default { hooks: { 'prompt.append': async () => { throw new Error("boom"); } } };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const ctx = { node: "build", role: "frontend", task: "test", flowDir: tmpBase, runDir: tmpBase };
    const result = await firePromptAppend(registry, ctx);
    assert.ok(result.includes("## OK"));
    assert.ok(result.includes("works fine"));
  });
});

describe("fireVerdictAppend", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("writes eval-extensions.md with correct emoji format (canonical severity)", async () => {
    const extDir = join(tmpBase, "extensions");
    const findings = [
      { severity: "error", category: "design-system", message: "Missing design token" },
      { severity: "warning", category: "design-lint", message: "Color contrast issue", file: "/src/Button.tsx" },
      { severity: "info", category: "design-system", message: "All good" },
    ];
    writeExtension(join(extDir, "linter"), `export default { hooks: { 'verdict.append': async () => ${JSON.stringify(findings)} } };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, { node: "review", role: "frontend", task: "t", flowDir: tmpBase, runDir });
    const content = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    assert.ok(content.includes("# Extension Findings"));
    assert.ok(content.includes("🔴 design-system: Missing design token"));
    assert.ok(content.includes("🟡 design-lint: Color contrast issue in /src/Button.tsx"));
    assert.ok(content.includes("🔵 design-system: All good"));
  });

  test("no findings → writes placeholder line", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "empty"), `export default { hooks: { 'verdict.append': async () => [] } };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run2");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, { node: "review", role: "x", task: "t", flowDir: tmpBase, runDir });
    const content = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    assert.ok(content.includes("🔵 extensions: No extension findings"));
  });

  test("fireVerdictAppend with missing runDir → creates dir and writes successfully (canonical severity)", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `export default { hooks: { 'verdict.append': async () => [{ severity: "info", category: "test", message: "all good" }] } };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "nonexistent-run", "nested");
    // runDir does NOT exist — fireVerdictAppend must create it
    assert.ok(!existsSync(runDir));
    await fireVerdictAppend(registry, { node: "review", role: "x", task: "t", flowDir: tmpBase, runDir });
    assert.ok(existsSync(join(runDir, "eval-extensions.md")));
    const content = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    assert.ok(content.includes("🔵 test: all good"));
  });

  test("verdict.append throw-path → warns and continues with partial findings (canonical severity)", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "good"), `export default { hooks: { 'verdict.append': async () => [{ severity: "info", category: "c", message: "ok" }] } };`);
    writeExtension(join(extDir, "throws"), `export default { hooks: { 'verdict.append': async () => { throw new Error("exploded"); } } };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "throw-run");
    mkdirSync(runDir);
    // Should NOT throw — throw-path is caught and warned
    await assert.doesNotReject(() =>
      fireVerdictAppend(registry, { node: "review", role: "x", task: "t", flowDir: tmpBase, runDir })
    );
    const content = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    // good extension's finding should still be present
    assert.ok(content.includes("🔵 c: ok"));
  });

  test("empty registry → still creates eval-extensions.md", async () => {
    const extDir = join(tmpBase, "empty-ext-dir");
    mkdirSync(extDir);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run3");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, { node: "review", role: "x", task: "t", flowDir: tmpBase, runDir });
    assert.ok(existsSync(join(runDir, "eval-extensions.md")));
  });
});

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

describe("old-style named export hooks (backwards compat)", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("old-style promptAppend named export is called", async () => {
    const extDir = join(tmpBase, "extensions");
    // Old-style: export async function promptAppend(ctx)
    writeExtension(join(extDir, "old-style"), `
export async function promptAppend(ctx) { return "## Old Style\\nworks"; }
export async function verdictAppend(ctx) { return []; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    assert.equal(registry.applied.length, 1);
    const result = await firePromptAppend(registry, { node: "review", role: "x", task: "t", flowDir: tmpBase, runDir: tmpBase });
    assert.ok(result.includes("## Old Style"));
    assert.ok(result.includes("works"));
  });

  test("old-style verdictAppend named export is called and finding schema normalized", async () => {
    const extDir = join(tmpBase, "extensions");
    // Old-style hook with old-style { emoji, text, file } findings
    writeExtension(join(extDir, "old-verdict"), `
export async function verdictAppend(ctx) {
  return [{ emoji: "🔴", text: "[old-verdict] font-consistency: Body uses 3 fonts", file: "/index" }];
}
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "old-run");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, { node: "review", role: "x", task: "t", flowDir: tmpBase, runDir });
    const content = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    // Should be normalized and written with correct emoji
    assert.ok(content.includes("🔴"), `Expected 🔴 in:\n${content}`);
    assert.ok(content.includes("font-consistency"), `Expected category in:\n${content}`);
  });

  test("old-style startupCheck named export is called on load", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "checks"), `
export async function startupCheck(ctx) { throw new Error("env missing"); }
export async function promptAppend(ctx) { return "should not reach"; }
`);
    // Not required → startup failure is a warn, not a throw
    const registry = await loadExtensions({ extensionsDir: extDir });
    // Extension should NOT be in applied since startup check failed
    assert.equal(registry.applied.length, 0);
  });
});

describe("meta.nodes routing", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("extension with meta.nodes is skipped on non-matching nodes", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "lint"), `
export const meta = { nodes: ["code-review", "review"] };
export async function promptAppend(ctx) { return "## Lint active"; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    // On "build" node — not in meta.nodes
    const result = await firePromptAppend(registry, { node: "build", role: "x", task: "t", flowDir: tmpBase, runDir: tmpBase });
    assert.equal(result, "");
  });

  test("extension with meta.nodes is called on matching node", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "lint"), `
export const meta = { nodes: ["code-review", "review"] };
export async function promptAppend(ctx) { return "## Lint active"; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    // On "code-review" node — in meta.nodes
    const result = await firePromptAppend(registry, { node: "code-review", role: "x", task: "t", flowDir: tmpBase, runDir: tmpBase });
    assert.ok(result.includes("## Lint active"));
  });

  test("extension without meta.nodes is always called (no filter)", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "global"), `
export async function promptAppend(ctx) { return "## Global always"; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    // No meta.nodes → runs on any node
    const result = await firePromptAppend(registry, { node: "build", role: "x", task: "t", flowDir: tmpBase, runDir: tmpBase });
    assert.ok(result.includes("## Global always"));
  });

  test("meta.nodes routing works for verdictAppend too", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "accept-only"), `
export const meta = { nodes: ["acceptance"] };
export async function verdictAppend(ctx) { return [{ severity: "info", category: "ux", message: "looks good" }]; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "meta-run");
    mkdirSync(runDir);
    // On "code-review" — should be skipped
    await fireVerdictAppend(registry, { node: "code-review", role: "x", task: "t", flowDir: tmpBase, runDir });
    const content = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    assert.ok(content.includes("No extension findings"), `Expected no findings on wrong node:\n${content}`);
  });
});

describe("finding normalization (old emoji format)", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("old-style { emoji, text } findings are normalized to canonical form", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "old-findings"), `
export default { hooks: { 'verdict.append': async () => [
  { emoji: "🔴", text: "[ext] contrast: Low contrast ratio" },
  { emoji: "🟡", text: "[ext] spacing: Inconsistent margins", file: "/home" },
  { emoji: "🔵", text: "[ext] fonts: One font family" },
] } };
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "norm-run");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, { node: "review", role: "x", task: "t", flowDir: tmpBase, runDir });
    const content = readFileSync(join(runDir, "eval-extensions.md"), "utf8");
    assert.ok(content.includes("🔴 contrast: Low contrast ratio"), `Missing 🔴 in:\n${content}`);
    assert.ok(content.includes("🟡 spacing: Inconsistent margins in /home"), `Missing 🟡 in:\n${content}`);
    assert.ok(content.includes("🔵 fonts: One font family"), `Missing 🔵 in:\n${content}`);
  });
});
