// extensions.test.mjs — Node.js built-in test runner
// Run: node --test bin/lib/extensions.test.mjs

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadExtensions, firePromptAppend, fireVerdictAppend } from "./extensions.mjs";

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
});

describe("fireVerdictAppend", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("writes ext-findings.md with correct emoji format", async () => {
    const extDir = join(tmpBase, "extensions");
    const findings = [
      { severity: "🔴", category: "design-system", message: "Missing design token" },
      { severity: "🟡", category: "design-lint", message: "Color contrast issue", file: "/src/Button.tsx" },
      { severity: "🔵", category: "design-system", message: "All good" },
    ];
    writeExtension(join(extDir, "linter"), `export default { hooks: { 'verdict.append': async () => ${JSON.stringify(findings)} } };`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, { node: "review", role: "frontend", task: "t", flowDir: tmpBase, runDir });
    const content = readFileSync(join(runDir, "ext-findings.md"), "utf8");
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
    const content = readFileSync(join(runDir, "ext-findings.md"), "utf8");
    assert.ok(content.includes("🔵 extensions: No extension findings"));
  });

  test("empty registry → still creates ext-findings.md", async () => {
    const extDir = join(tmpBase, "empty-ext-dir");
    mkdirSync(extDir);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run3");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, { node: "review", role: "x", task: "t", flowDir: tmpBase, runDir });
    assert.ok(existsSync(join(runDir, "ext-findings.md")));
  });
});
