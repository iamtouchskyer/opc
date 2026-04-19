// extensions.test.mjs — Node.js built-in test runner
// Run: node --test bin/lib/extensions.test.mjs

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, mkdtempSync } from "fs";
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
  fireExecuteRun,
  fireArtifactEmit,
  renderEvalMarkdown,
  loadBreakerState,
  saveBreakerState,
  clearBreakerState,
  applyBreakerState,
  BREAKER_STATE_FILE,
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

// ─── F1: fireVerdictAppend structured return ─────────────────────

describe("F1 — fireVerdictAppend return shape", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("returns {findings, filePath} with findings array tagged by _ext", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["cap"] };
export async function verdictAppend() { return [{ severity: "warning", category: "x", message: "m1" }]; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    const result = await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }));
    assert.ok(result && typeof result === "object", "returns object");
    assert.ok(Array.isArray(result.findings), "findings is array");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].category, "x");
    assert.equal(result.findings[0].message, "m1");
    assert.equal(result.findings[0]._ext, "linter");
    assert.ok(typeof result.filePath === "string" && result.filePath.endsWith("eval-extensions.md"));
  });

  test("returns filePath:null when context.runDir is undefined", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["cap"] };
export async function verdictAppend() { return []; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const result = await fireVerdictAppend(registry, { nodeCapabilities: ["cap"] });
    assert.ok(result, "still returns object");
    assert.equal(result.filePath, null);
    assert.ok(Array.isArray(result.findings));
  });
});

// ─── F2: nodeCapabilities WARN-once ──────────────────────────────

describe("F2 — nodeCapabilities WARN-once", () => {
  let tmpBase;
  let origStderrWrite;
  let captured;
  beforeEach(() => {
    tmpBase = makeTmpDir();
    captured = [];
    origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      captured.push(String(chunk));
      return true;
    };
  });
  afterEach(() => {
    process.stderr.write = origStderrWrite;
    rmSync(tmpBase, { recursive: true, force: true });
  });

  test("WARN fires once when nodeCapabilities is missing", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["cap"] };
export async function verdictAppend() { return []; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, { runDir /* no nodeCapabilities */ });
    const warns = captured.filter(s => s.includes("ctx.nodeCapabilities not set"));
    assert.equal(warns.length, 1, "fires exactly once");

    // Second call on same registry → silent
    captured.length = 0;
    await fireVerdictAppend(registry, { runDir });
    const warns2 = captured.filter(s => s.includes("ctx.nodeCapabilities not set"));
    assert.equal(warns2.length, 0, "silent on second call (same registry)");
  });

  test("WARN does NOT fire when nodeCapabilities is supplied", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["cap"] };
export async function verdictAppend() { return []; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, { runDir, nodeCapabilities: ["cap"] });
    const warns = captured.filter(s => s.includes("ctx.nodeCapabilities not set"));
    assert.equal(warns.length, 0, "happy path stays silent");
  });

  test("WARN fires for empty-array nodeCapabilities too", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["cap"] };
export async function verdictAppend() { return []; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, { runDir, nodeCapabilities: [] });
    const warns = captured.filter(s => s.includes("ctx.nodeCapabilities not set"));
    assert.equal(warns.length, 1, "empty array still warns");
  });

  test("WARN stays silent when registry has zero extensions", async () => {
    // Fix-pair F-B1: short-circuit noise when no one is listening
    const extDir = join(tmpBase, "empty-exts");
    mkdirSync(extDir);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, { runDir /* no caps */ });
    const warns = captured.filter(s => s.includes("ctx.nodeCapabilities not set"));
    assert.equal(warns.length, 0, "no extensions = no warning");
  });

  test("WARN is deduped across different fire* hooks on same registry", async () => {
    // Fix-pair F-B4: dedup is per-registry, not per-function
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["cap"] };
export const promptAppend = async () => "";
export const verdictAppend = async () => [];
export const executeRun = async () => {};
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    await firePromptAppend(registry, { /* no caps */ });
    await fireVerdictAppend(registry, { runDir });
    await fireExecuteRun(registry, { runDir });
    const warns = captured.filter(s => s.includes("ctx.nodeCapabilities not set"));
    assert.equal(warns.length, 1, "warns once total across prompt+verdict+execute");
  });

  test("WARN message names loaded extensions (actionable)", async () => {
    // Fix-pair F-B2: hint must be actionable
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "alpha"), `
export const meta = { name: "alpha", provides: ["cap"] };
export async function verdictAppend() { return []; }
`);
    writeExtension(join(extDir, "beta"), `
export const meta = { name: "beta", provides: ["cap"] };
export async function verdictAppend() { return []; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    await fireVerdictAppend(registry, { runDir });
    const joined = captured.join("");
    assert.ok(joined.includes("alpha"), "mentions alpha");
    assert.ok(joined.includes("beta"), "mentions beta");
    assert.ok(joined.includes("flow template") || joined.includes("harness CLI"), "suggests where to set caps");
  });
});

// ─── F4: eval-extensions.json sidecar ────────────────────────────

describe("F4 — eval-extensions.json sidecar", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  test("writes canonical JSON alongside markdown", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["cap"] };
export async function verdictAppend() {
  return [{ severity: "warning", category: "lint", message: "missing semicolon", file: "a.js" }];
}
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    const result = await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }));

    assert.ok(typeof result.jsonPath === "string" && result.jsonPath.endsWith("eval-extensions.json"));
    assert.ok(existsSync(result.jsonPath), "json file exists");

    const doc = JSON.parse(readFileSync(result.jsonPath, "utf8"));
    assert.equal(doc.version, 1, "schema version is 1");
    assert.equal(typeof doc.generatedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(doc.generatedAt)), "generatedAt is ISO timestamp");
    assert.ok(doc.generatedAt.endsWith("Z"), "generatedAt is UTC");
    assert.deepEqual(doc.extensionsLoaded, [{ name: "linter", enabled: true }]);
    assert.equal(doc.findings.length, 1);
    assert.deepEqual(doc.findings[0], {
      extension: "linter",
      severity: "warning",
      category: "lint",
      message: "missing semicolon",
      file: "a.js",
    });
  });

  test("empty findings → JSON has findings:[], markdown still written", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["cap"] };
export async function verdictAppend() { return []; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    const result = await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }));

    const doc = JSON.parse(readFileSync(result.jsonPath, "utf8"));
    assert.deepEqual(doc.findings, []);
    const md = readFileSync(result.filePath, "utf8");
    assert.ok(md.includes("No extension findings"), "markdown fallback still present");
  });

  test("markdown is derived from JSON — field-for-field consistent", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["cap"] };
export async function verdictAppend() {
  return [
    { severity: "error", category: "security", message: "xss risk" },
    { severity: "warning", category: "style", message: "too long", file: "b.js" },
    { severity: "info", category: "note", message: "FYI" },
  ];
}
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    const result = await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }));

    const md = readFileSync(result.filePath, "utf8");
    assert.ok(md.includes("🔴 security: xss risk"), "red for error");
    assert.ok(md.includes("🟡 style: too long in b.js"), "yellow + file suffix for warning");
    assert.ok(md.includes("🔵 note: FYI"), "blue for info");
  });

  test("jsonPath is null when runDir not set", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["cap"] };
export async function verdictAppend() { return []; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const result = await fireVerdictAppend(registry, { nodeCapabilities: ["cap"] });
    assert.equal(result.jsonPath, null);
    assert.equal(result.filePath, null);
  });

  test("malformed findings are dropped; JSON only contains normalized", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["cap"] };
export async function verdictAppend() {
  return [
    { severity: "warning", category: "ok", message: "kept" },
    null,
    "not-an-object",
    42,
  ];
}
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    const result = await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }));
    const doc = JSON.parse(readFileSync(result.jsonPath, "utf8"));
    assert.equal(doc.findings.length, 1, "only the normalized finding survives");
    assert.equal(doc.findings[0].message, "kept");
  });

  // ─ Fix-pair U5.4r ─────────────────────────────────────────────

  test("fix-pair: renderEvalMarkdown exported + golden byte-identical output", () => {
    const hand = {
      version: 1,
      generatedAt: "2026-04-19T00:00:00.000Z",
      extensionsLoaded: [{ name: "linter", enabled: true }],
      findings: [
        { extension: "linter", severity: "error", category: "sec", message: "xss" },
        { extension: "linter", severity: "warning", category: "style", message: "long", file: "b.js" },
        { extension: "linter", severity: "info", category: "note", message: "FYI" },
      ],
    };
    const md = renderEvalMarkdown(hand);
    const expected =
      "<!-- derived from eval-extensions.json — edits here will be overwritten -->\n" +
      "# Extension Findings\n" +
      "\n" +
      "🔴 sec: xss\n" +
      "🟡 style: long in b.js\n" +
      "🔵 note: FYI\n";
    assert.equal(md, expected, "golden byte-exact");
  });

  test("fix-pair: renderEvalMarkdown empty → 'No extension findings' fallback", () => {
    const md = renderEvalMarkdown({
      version: 1, generatedAt: "x", extensionsLoaded: [], findings: [],
    });
    assert.ok(md.includes("🔵 extensions: No extension findings"));
    assert.ok(md.startsWith("<!-- derived"), "banner always first");
  });

  test("fix-pair: hook throws → JSON still written with findings:[]", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "boom"), `
export const meta = { name: "boom", provides: ["cap"] };
export async function verdictAppend() { throw new Error("kaboom"); }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    // Swallow stderr WARN
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const result = await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }));
      const doc = JSON.parse(readFileSync(result.jsonPath, "utf8"));
      assert.deepEqual(doc.findings, [], "no findings on throw");
      assert.equal(doc.extensionsLoaded[0].name, "boom");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("fix-pair: disabled (circuit-broken) ext shows enabled:false", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "tripped"), `
export const meta = { name: "tripped", provides: ["cap"] };
export async function verdictAppend() { return []; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    // Trip breaker manually
    registry.extensions[0].enabled = false;
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    const result = await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }));
    const doc = JSON.parse(readFileSync(result.jsonPath, "utf8"));
    assert.equal(doc.extensionsLoaded[0].enabled, false, "disabled is visible");
  });

  test("fix-pair: markdown contains 'derived — do not edit' banner", async () => {
    const extDir = join(tmpBase, "extensions");
    writeExtension(join(extDir, "linter"), `
export const meta = { name: "linter", provides: ["cap"] };
export async function verdictAppend() { return []; }
`);
    const registry = await loadExtensions({ extensionsDir: extDir });
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir);
    const result = await fireVerdictAppend(registry, ctx({ runDir, nodeCapabilities: ["cap"] }));
    const md = readFileSync(result.filePath, "utf8");
    assert.ok(md.startsWith("<!-- derived from eval-extensions.json"), "banner on first line");
    assert.ok(md.includes("edits here will be overwritten"));
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

  // Run 2 OUT-1 contract: extension-test is a LINT command. Individual hook
  // failures are reported in stdout with ❌ markers; the exit code stays 0 so
  // CI can run the test command across a fixture tree without bailing on the
  // first intentionally-broken hook. Non-zero exit is reserved for load-time
  // errors (missing --ext, missing hook.mjs, bad --context JSON).
  test("hook throw reports ❌ but still exits 0", async () => {
    const extDir = join(tmpBase, "throwing");
    writeExtension(
      extDir,
      `export const meta = { name: "throwing", provides: ["foo@1"] };
       export async function startupCheck() { return true; }
       export async function verdictAppend() { throw new Error("boom"); }`
    );
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u15thr=${Date.now()}`);
    const { out, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--all-hooks"])
    );
    assert.match(out, /\[verdict\.append\] ❌ error: boom/);
    assert.equal(exitCode, 0);
  });
});

// ─── U1.6 — normalizeHook recognizes execute.run / artifact.emit ────

describe("U1.6 — normalizeHook recognizes execute.run / artifact.emit", () => {
  test("camel-case named exports wire to kebab hook names", () => {
    const mod = {
      executeRun: async () => "ran",
      artifactEmit: async () => [],
    };
    const raw = mod;
    const n = normalizeHook(raw, mod);
    assert.equal(typeof n.hooks["execute.run"], "function");
    assert.equal(typeof n.hooks["artifact.emit"], "function");
  });

  test("kebab-case named exports wire through", () => {
    const mod = {
      "execute.run": async () => "ran",
      "artifact.emit": async () => [],
    };
    const n = normalizeHook(mod, mod);
    assert.equal(typeof n.hooks["execute.run"], "function");
    assert.equal(typeof n.hooks["artifact.emit"], "function");
  });

  test("legacy { hooks: { 'execute.run': fn } } default-export preserved", () => {
    const raw = { hooks: { "execute.run": async () => "ran" } };
    const n = normalizeHook(raw, raw);
    assert.equal(typeof n.hooks["execute.run"], "function");
  });
});

// ─── U1.6 — fireExecuteRun ───────────────────────────────────────

describe("U1.6 — fireExecuteRun", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

  test("fires on matching capability; skips non-matching ext", async () => {
    writeExtension(
      join(tmpBase, "match"),
      `export const meta = { name: "match", provides: ["cap@1"] };
       export async function executeRun() { return "ok"; }`
    );
    writeExtension(
      join(tmpBase, "nomatch"),
      `export const meta = { name: "nomatch", provides: ["other@1"] };
       export async function executeRun() { return "nope"; }`
    );
    const reg = await loadExtensions({ extensionsDir: tmpBase });
    const out = await fireExecuteRun(reg, { nodeCapabilities: ["cap@1"], runDir: tmpBase });
    assert.equal(out.length, 1);
    assert.equal(out[0].ext, "match");
    assert.equal(out[0].result, "ok");
  });

  test("throwing extension does not block sibling; records failure", async () => {
    writeExtension(
      join(tmpBase, "a-bad"),
      `export const meta = { name: "a-bad", provides: ["cap@1"] };
       export async function executeRun() { throw new Error("boom"); }`
    );
    writeExtension(
      join(tmpBase, "b-good"),
      `export const meta = { name: "b-good", provides: ["cap@1"] };
       export async function executeRun() { return "survived"; }`
    );
    const { result } = await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      const out = await fireExecuteRun(reg, { nodeCapabilities: ["cap@1"], runDir: tmpBase });
      return { reg, out };
    });
    const names = result.out.map(r => r.ext).sort();
    assert.deepEqual(names, ["b-good"]);
    assert.equal(result.reg.failures.length, 1);
    assert.equal(result.reg.failures[0].ext, "a-bad");
    assert.equal(result.reg.failures[0].hook, "execute.run");
    assert.equal(result.reg.failures[0].kind, "throw");
  });

  test("timeout is recorded as kind=timeout", async () => {
    process.env.OPC_HOOK_TIMEOUT_MS = "50";
    const mod = await import(`./extensions.mjs?u16timeout=${Date.now()}`);
    writeExtension(
      join(tmpBase, "slow"),
      `export const meta = { name: "slow", provides: ["cap@1"] };
       export async function executeRun() {
         return new Promise(r => setTimeout(() => r("late"), 500));
       }`
    );
    try {
      const { result } = await captureStderr(async () => {
        const reg = await mod.loadExtensions({ extensionsDir: tmpBase });
        await mod.fireExecuteRun(reg, { nodeCapabilities: ["cap@1"], runDir: tmpBase });
        return reg;
      });
      assert.equal(result.failures.length, 1);
      assert.equal(result.failures[0].kind, "timeout");
      assert.equal(result.failures[0].hook, "execute.run");
    } finally {
      delete process.env.OPC_HOOK_TIMEOUT_MS;
    }
  });

  test("missing execute.run hook → silently skipped, not recorded as failure", async () => {
    writeExtension(
      join(tmpBase, "no-execute"),
      `export const meta = { name: "no-execute", provides: ["cap@1"] };
       export async function promptAppend() { return "x"; }`
    );
    const reg = await loadExtensions({ extensionsDir: tmpBase });
    const out = await fireExecuteRun(reg, { nodeCapabilities: ["cap@1"], runDir: tmpBase });
    assert.equal(out.length, 0);
    assert.equal(reg.failures.length, 0);
  });
});

// ─── U1.6 — fireArtifactEmit ─────────────────────────────────────

describe("U1.6 — fireArtifactEmit", () => {
  let tmpBase;
  let runDir;
  beforeEach(() => {
    tmpBase = makeTmpDir();
    runDir = join(tmpBase, "run");
    mkdirSync(runDir, { recursive: true });
  });
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

  test("writes each item to <runDir>/ext-<name>/<basename>; returns ext-artifact entries", async () => {
    writeExtension(
      join(tmpBase, "emitter"),
      `export const meta = { name: "emitter", provides: ["cap@1"] };
       export async function artifactEmit() {
         return [
           { name: "a.txt", content: "hello" },
           { name: "b.txt", content: Buffer.from("bytes") },
         ];
       }`
    );
    const reg = await loadExtensions({ extensionsDir: tmpBase });
    const emitted = await fireArtifactEmit(reg, { nodeCapabilities: ["cap@1"], runDir });
    assert.equal(emitted.length, 2);
    for (const e of emitted) {
      assert.equal(e.type, "ext-artifact");
      assert.equal(e.ext, "emitter");
      assert.ok(existsSync(e.path));
    }
    assert.equal(readFileSync(join(runDir, "ext-emitter", "a.txt"), "utf8"), "hello");
    assert.equal(readFileSync(join(runDir, "ext-emitter", "b.txt"), "utf8"), "bytes");
  });

  test("path-traversal attempts (../ and absolute) are skipped with WARN", async () => {
    writeExtension(
      join(tmpBase, "evil"),
      `export const meta = { name: "evil", provides: ["cap@1"] };
       export async function artifactEmit() {
         return [
           { name: "../escape.txt", content: "nope" },
           { name: "/etc/passwd", content: "nope" },
           { name: "sub/nested.txt", content: "nope" },
           { name: "", content: "nope" },
           { name: "good.txt", content: "ok" },
         ];
       }`
    );
    const { result, stderr } = await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      return await fireArtifactEmit(reg, { nodeCapabilities: ["cap@1"], runDir });
    });
    assert.equal(result.length, 1);
    assert.ok(result[0].path.endsWith("good.txt"));
    // No files leaked outside ext-evil/
    assert.equal(existsSync(join(tmpBase, "escape.txt")), false);
    assert.equal(existsSync(join(runDir, "ext-evil", "sub")), false);
    assert.match(stderr, /not a plain basename/);
  });

  test("non-array return → recorded as bad-return, no files emitted", async () => {
    writeExtension(
      join(tmpBase, "wrong-shape"),
      `export const meta = { name: "wrong-shape", provides: ["cap@1"] };
       export async function artifactEmit() { return "not an array"; }`
    );
    const { result, stderr } = await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      const emitted = await fireArtifactEmit(reg, { nodeCapabilities: ["cap@1"], runDir });
      return { reg, emitted };
    });
    assert.equal(result.emitted.length, 0);
    assert.equal(result.reg.failures.length, 1);
    assert.equal(result.reg.failures[0].kind, "bad-return");
    assert.equal(result.reg.failures[0].hook, "artifact.emit");
    assert.match(stderr, /expected array/);
  });

  test("item with non-string/Buffer content is skipped", async () => {
    writeExtension(
      join(tmpBase, "mixed"),
      `export const meta = { name: "mixed", provides: ["cap@1"] };
       export async function artifactEmit() {
         return [
           { name: "bad.json", content: { foo: 1 } },
           { name: "ok.txt", content: "good" },
         ];
       }`
    );
    const { result, stderr } = await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      return await fireArtifactEmit(reg, { nodeCapabilities: ["cap@1"], runDir });
    });
    assert.equal(result.length, 1);
    assert.ok(result[0].path.endsWith("ok.txt"));
    assert.match(stderr, /content is not string\/Buffer/);
  });

  test("throwing artifact.emit is recorded as failure, no files emitted", async () => {
    writeExtension(
      join(tmpBase, "thrower"),
      `export const meta = { name: "thrower", provides: ["cap@1"] };
       export async function artifactEmit() { throw new Error("kaboom"); }`
    );
    const { result } = await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      const emitted = await fireArtifactEmit(reg, { nodeCapabilities: ["cap@1"], runDir });
      return { reg, emitted };
    });
    assert.equal(result.emitted.length, 0);
    assert.equal(result.reg.failures.length, 1);
    assert.equal(result.reg.failures[0].kind, "throw");
    assert.equal(result.reg.failures[0].hook, "artifact.emit");
  });

  test("no runDir → returns empty array, no writes", async () => {
    writeExtension(
      join(tmpBase, "e"),
      `export const meta = { name: "e", provides: ["cap@1"] };
       export async function artifactEmit() { return [{ name: "x.txt", content: "y" }]; }`
    );
    const reg = await loadExtensions({ extensionsDir: tmpBase });
    const emitted = await fireArtifactEmit(reg, { nodeCapabilities: ["cap@1"], runDir: null });
    assert.equal(emitted.length, 0);
  });
});

// ─── U1.6 — extension-artifact CLI integration ───────────────────

describe("U1.6 — extension-artifact CLI integration", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

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

  test("fires execute.run + artifact.emit, merges into handshake.artifacts[], writes failure report", async () => {
    // Extensions layout
    const extDir = join(tmpBase, "exts");
    writeExtension(
      join(extDir, "runner"),
      `export const meta = { name: "runner", provides: ["nodecap@1"] };
       export async function executeRun() { return "ran"; }
       export async function artifactEmit() {
         return [{ name: "out.txt", content: "data" }];
       }`
    );

    // Harness layout with flow template + node run dir
    const harnessDir = join(tmpBase, ".harness");
    const nodeId = "exec-node";
    const runDir = join(harnessDir, "nodes", nodeId, "run_1");
    mkdirSync(runDir, { recursive: true });
    // Seed handshake with an existing artifact to verify merge + dedup
    writeFileSync(
      join(runDir, "handshake.json"),
      JSON.stringify({ artifacts: [{ type: "existing", path: "/pre-existing" }] }),
      "utf8"
    );
    // Seed flow-state + flow template with nodeCapabilities
    writeFileSync(
      join(harnessDir, "flow-state.json"),
      JSON.stringify({
        flow: "test-flow",
        flowFile: join(harnessDir, "flow.json"),
        currentNode: nodeId,
      }),
      "utf8"
    );
    writeFileSync(
      join(harnessDir, "flow.json"),
      JSON.stringify({
        opc_compat: ">=0.0",
        nodes: [nodeId],
        edges: { [nodeId]: { PASS: null } },
        limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
        nodeTypes: { [nodeId]: "execute" },
        nodeCapabilities: { [nodeId]: ["nodecap@1"] },
      }),
      "utf8"
    );
    // Config pointing at extensions dir — repo layer: <harnessDir>/.opc/config.json
    mkdirSync(join(harnessDir, ".opc"), { recursive: true });
    writeFileSync(
      join(harnessDir, ".opc", "config.json"),
      JSON.stringify({ extensionsDir: extDir }),
      "utf8"
    );

    const { cmdExtensionArtifact } = await import(`./ext-commands.mjs?u16cli=${Date.now()}`);
    const { out, exitCode } = await captureAll(() =>
      cmdExtensionArtifact([
        "--node", nodeId,
        "--dir", harnessDir,
        "--flow-file", join(harnessDir, "flow.json"),
      ])
    );
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(out.trim().split("\n").pop());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.node, nodeId);
    assert.deepEqual(parsed.extensionsApplied, ["runner"]);
    assert.equal(parsed.executeRunCount, 1);
    assert.equal(parsed.emitted.length, 1);

    // File was written
    const emittedPath = join(runDir, "ext-runner", "out.txt");
    assert.ok(existsSync(emittedPath));
    assert.equal(readFileSync(emittedPath, "utf8"), "data");

    // handshake.artifacts[] was updated: existing preserved + ext-artifact merged
    const hs = JSON.parse(readFileSync(join(runDir, "handshake.json"), "utf8"));
    assert.ok(hs.artifacts.find(a => a.type === "existing"));
    assert.ok(hs.artifacts.find(a => a.type === "ext-artifact" && a.ext === "runner"));
    assert.deepEqual(hs.extensionsApplied, ["runner"]);

    // extension-failures.md written (even when no failures — "no failures recorded")
    assert.ok(existsSync(join(runDir, "extension-failures.md")));
  });

  test("failing execute.run hook writes extension-failures.md with record", async () => {
    const extDir = join(tmpBase, "exts");
    writeExtension(
      join(extDir, "bad"),
      `export const meta = { name: "bad", provides: ["nodecap@1"] };
       export async function executeRun() { throw new Error("execute boom"); }`
    );

    const harnessDir = join(tmpBase, ".harness");
    const nodeId = "exec-node";
    const runDir = join(harnessDir, "nodes", nodeId, "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "handshake.json"), "{}", "utf8");
    writeFileSync(
      join(harnessDir, "flow-state.json"),
      JSON.stringify({ flow: "f", flowFile: join(harnessDir, "flow.json"), currentNode: nodeId }),
      "utf8"
    );
    writeFileSync(
      join(harnessDir, "flow.json"),
      JSON.stringify({
        opc_compat: ">=0.0",
        nodes: [nodeId],
        edges: { [nodeId]: { PASS: null } },
        limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
        nodeTypes: { [nodeId]: "execute" },
        nodeCapabilities: { [nodeId]: ["nodecap@1"] },
      }),
      "utf8"
    );
    mkdirSync(join(harnessDir, ".opc"), { recursive: true });
    writeFileSync(
      join(harnessDir, ".opc", "config.json"),
      JSON.stringify({ extensionsDir: extDir }),
      "utf8"
    );

    const { cmdExtensionArtifact } = await import(`./ext-commands.mjs?u16clierr=${Date.now()}`);
    const { exitCode } = await captureAll(() =>
      cmdExtensionArtifact([
        "--node", nodeId,
        "--dir", harnessDir,
        "--flow-file", join(harnessDir, "flow.json"),
      ])
    );
    // Per contract: hook failures are isolated — CLI still exits 0.
    assert.equal(exitCode, 0);

    const failReport = readFileSync(join(runDir, "extension-failures.md"), "utf8");
    assert.match(failReport, /bad\.execute\.run/);
    assert.match(failReport, /execute boom/);
  });
});

// ─── U1.6r fix-forward regressions ───────────────────────────────

describe("U1.6r — fireArtifactEmit accepts Uint8Array content (semantics F2)", () => {
  let tmpBase, runDir;
  beforeEach(() => {
    tmpBase = makeTmpDir();
    runDir = join(tmpBase, "run");
    mkdirSync(runDir, { recursive: true });
  });
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

  test("Uint8Array content is written as bytes, not dropped", async () => {
    writeExtension(
      join(tmpBase, "bin-emit"),
      `export const meta = { name: "bin-emit", provides: ["cap@1"] };
       export async function artifactEmit() {
         const bytes = new Uint8Array([0x48, 0x49]); // "HI"
         return [{ name: "hi.bin", content: bytes }];
       }`
    );
    const { result, stderr } = await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: tmpBase });
      return await fireArtifactEmit(reg, { nodeCapabilities: ["cap@1"], runDir });
    });
    assert.equal(result.length, 1);
    const buf = readFileSync(result[0].path);
    assert.equal(buf.toString("utf8"), "HI");
    // No bogus "not string/Buffer" WARN
    assert.doesNotMatch(stderr, /content is not string/);
  });
});

describe("U1.6r — circuit-breaker trips on persistent artifact.emit write failures (semantics F1)", () => {
  let tmpBase, runDir;
  beforeEach(() => {
    tmpBase = makeTmpDir();
    runDir = join(tmpBase, "run");
    mkdirSync(runDir, { recursive: true });
  });
  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
    delete process.env.OPC_HOOK_FAILURE_THRESHOLD;
  });

  test("per-item write failure is NOT undone by recordSuccess; _failStreak grows", async () => {
    // Simulate a persistent write failure by pointing output at a read-only
    // path. Easier: have the extension emit a valid item, then MANUALLY make
    // the output path a dir so atomicWriteSync throws. Even simpler: emit an
    // item whose eventual file path already exists as a directory → EISDIR.
    const extDir = join(tmpBase, "ext");
    writeExtension(
      join(extDir, "collider"),
      `export const meta = { name: "collider", provides: ["cap@1"] };
       export async function artifactEmit() {
         return [{ name: "blocked", content: "x" }];
       }`
    );
    // Pre-create <runDir>/ext-collider/blocked as a DIRECTORY — fs.writeFileSync
    // on it will throw EISDIR.
    mkdirSync(join(runDir, "ext-collider", "blocked"), { recursive: true });

    const { result, stderr } = await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: extDir });
      // Fire twice — with the old bug, _failStreak would reset to 0 each time.
      await fireArtifactEmit(reg, { nodeCapabilities: ["cap@1"], runDir });
      await fireArtifactEmit(reg, { nodeCapabilities: ["cap@1"], runDir });
      return reg;
    });
    assert.match(stderr, /write failed for 'blocked'/);
    const ext = result.extensions.find(e => e.name === "collider");
    assert.equal(ext._failStreak, 2, "failure streak must persist across calls");
    assert.equal(result.failures.length, 2);
  });

  test("success reset only fires when ALL items in the call succeeded", async () => {
    const extDir = join(tmpBase, "ext");
    writeExtension(
      join(extDir, "mixed"),
      `export const meta = { name: "mixed", provides: ["cap@1"] };
       export async function artifactEmit() {
         return [
           { name: "ok.txt", content: "good" },
           { name: "bad", content: "also good" },
         ];
       }`
    );
    mkdirSync(join(runDir, "ext-mixed", "bad"), { recursive: true });
    const { result } = await captureStderr(async () => {
      const reg = await loadExtensions({ extensionsDir: extDir });
      await fireArtifactEmit(reg, { nodeCapabilities: ["cap@1"], runDir });
      return reg;
    });
    const ext = result.extensions.find(e => e.name === "mixed");
    assert.equal(ext._failStreak, 1, "mixed per-item outcome must count as failure");
  });
});

describe("U1.6r — extension-artifact CLI includes nodeCapabilities (contract #1)", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

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

  test("output JSON includes nodeCapabilities (consistency with extension-verdict)", async () => {
    const extDir = join(tmpBase, "exts");
    writeExtension(
      join(extDir, "noop"),
      `export const meta = { name: "noop", provides: ["nodecap@1"] };
       export async function executeRun() { return; }`
    );
    const harnessDir = join(tmpBase, ".harness");
    const nodeId = "exec-node";
    const runDir = join(harnessDir, "nodes", nodeId, "run_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "handshake.json"), "{}");
    writeFileSync(
      join(harnessDir, "flow-state.json"),
      JSON.stringify({ flow: "f", flowFile: join(harnessDir, "flow.json"), currentNode: nodeId })
    );
    writeFileSync(
      join(harnessDir, "flow.json"),
      JSON.stringify({
        opc_compat: ">=0.0",
        nodes: [nodeId],
        edges: { [nodeId]: { PASS: null } },
        limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
        nodeTypes: { [nodeId]: "execute" },
        nodeCapabilities: { [nodeId]: ["nodecap@1"] },
      })
    );
    mkdirSync(join(harnessDir, ".opc"), { recursive: true });
    writeFileSync(
      join(harnessDir, ".opc", "config.json"),
      JSON.stringify({ extensionsDir: extDir })
    );

    const { cmdExtensionArtifact } = await import(`./ext-commands.mjs?u16rnc=${Date.now()}`);
    const { out, exitCode } = await captureAll(() =>
      cmdExtensionArtifact([
        "--node", nodeId, "--dir", harnessDir,
        "--flow-file", join(harnessDir, "flow.json"),
      ])
    );
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(out.trim().split("\n").pop());
    assert.deepEqual(parsed.nodeCapabilities, ["nodecap@1"]);
  });
});

// ─── U5.5 — F3 (--fixture-dir) + F6 (--lint hook/provides mismatch) ──────

describe("U5.5 F3 — extension-test --fixture-dir", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

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

  test("copies fixture dir into tmp and sets ctx.flowDir/ctx.runDir", async () => {
    const fixtureSrc = join(tmpBase, "fixture");
    mkdirSync(fixtureSrc, { recursive: true });
    writeFileSync(join(fixtureSrc, "marker.txt"), "hello-u55", "utf8");
    const extDir = join(tmpBase, "reader");
    writeExtension(extDir, `
      import { existsSync, readFileSync } from "fs";
      import { join } from "path";
      export const meta = { provides: ["verification@1"] };
      export function promptAppend(ctx) {
        const p = join(ctx.flowDir || "", "marker.txt");
        if (!existsSync(p)) return "no marker; flowDir=" + ctx.flowDir;
        // Assert runDir === flowDir (both point at fixture tmp copy)
        const same = ctx.runDir === ctx.flowDir ? "same" : "different";
        return "marker=" + readFileSync(p, "utf8") + " flow=" + ctx.flowDir + " rd=" + same;
      }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u55a=${Date.now()}`);
    const { out, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--hook", "prompt.append", "--fixture-dir", fixtureSrc])
    );
    assert.equal(exitCode, 0);
    assert.match(out, /marker=hello-u55/);
    assert.match(out, /rd=same/);
    // Must not be the original src path (copy, not pass-through)
    assert.doesNotMatch(out, new RegExp("flow=" + fixtureSrc.replace(/[.\-]/g, "\\$&")));
  });

  test("--fixture-dir tmp is cleaned up after success", async () => {
    const fixtureSrc = join(tmpBase, "fx2");
    mkdirSync(fixtureSrc, { recursive: true });
    writeFileSync(join(fixtureSrc, "a.txt"), "a", "utf8");
    const extDir = join(tmpBase, "noop");
    writeExtension(extDir, `
      export const meta = { provides: ["verification@1"] };
      let capturedFlowDir = null;
      export function promptAppend(ctx) { capturedFlowDir = ctx.flowDir; return "ok"; }
      export function _getCaptured() { return capturedFlowDir; }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u55b=${Date.now()}`);
    // Capture the fixture tmp path via a log pattern
    let capturedPath = null;
    const origLog = console.log;
    console.log = (...a) => {
      const msg = a.map(String).join(" ");
      const m = msg.match(/opc-fixture-[A-Za-z0-9]+/);
      if (m) capturedPath = m[0];
      origLog(...a);
    };
    try {
      // Patch prompt.append to log its flowDir so we can observe the tmp path
      writeExtension(extDir, `
        export const meta = { provides: ["verification@1"] };
        export function promptAppend(ctx) { return "flowDir=" + ctx.flowDir; }
      `);
      const { out, exitCode } = await captureAll(() =>
        cmdExtensionTest(["--ext", extDir, "--hook", "prompt.append", "--fixture-dir", fixtureSrc])
      );
      assert.equal(exitCode, 0);
      const m = out.match(/flowDir=([^\s]+)/);
      assert.ok(m, "flowDir appeared in output: " + out);
      const tmpPath = m[1];
      // After cmdExtensionTest returns (process.exit), the tmp dir should be gone.
      assert.equal(existsSync(tmpPath), false, `expected tmp dir cleaned: ${tmpPath}`);
    } finally {
      console.log = origLog;
    }
  });

  test("--fixture-dir with missing source path → exit 1 stderr error", async () => {
    const missing = join(tmpBase, "does-not-exist");
    const extDir = join(tmpBase, "ext");
    writeExtension(extDir, `
      export const meta = { provides: ["verification@1"] };
      export function promptAppend(ctx) { return "ok"; }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u55c=${Date.now()}`);
    const { err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--hook", "prompt.append", "--fixture-dir", missing])
    );
    assert.equal(exitCode, 1);
    assert.match(err, /--fixture-dir not found/);
  });
});

describe("U5.5 F6 — extension-test --lint hook/provides mismatch", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

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

  test("provides declared but no hooks → stderr 'hook mismatch'; exit 0", async () => {
    const extDir = join(tmpBase, "declared-no-hooks");
    writeExtension(extDir, `
      export const meta = { provides: ["verification@1"] };
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u55d=${Date.now()}`);
    const { err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--lint"])
    );
    assert.equal(exitCode, 0);
    assert.match(err, /hook mismatch/);
    assert.match(err, /no hooks are implemented/);
  });

  test("hooks implemented but provides empty → stderr 'hook mismatch'; exit 0", async () => {
    const extDir = join(tmpBase, "hooks-no-provides");
    writeExtension(extDir, `
      export const meta = { provides: [] };
      export function verdictAppend(ctx) { return []; }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u55e=${Date.now()}`);
    const { err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--lint"])
    );
    assert.equal(exitCode, 0);
    assert.match(err, /hook mismatch/);
    assert.match(err, /meta\.provides is empty/);
  });

  test("well-formed ext (provides+hooks) → no 'hook mismatch' line", async () => {
    const extDir = join(tmpBase, "good");
    writeExtension(extDir, `
      export const meta = { provides: ["verification@1"] };
      export function verdictAppend(ctx) { return []; }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u55f=${Date.now()}`);
    const { err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--lint"])
    );
    assert.equal(exitCode, 0);
    assert.doesNotMatch(err, /hook mismatch/);
  });

  test("--lint does not invoke hooks (side-effect-free)", async () => {
    const extDir = join(tmpBase, "side-effect");
    writeExtension(extDir, `
      export const meta = { provides: ["verification@1"] };
      let fired = false;
      export function verdictAppend(ctx) { fired = true; throw new Error("SHOULD NOT FIRE"); }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u55g=${Date.now()}`);
    const { out, err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--lint"])
    );
    assert.equal(exitCode, 0);
    // No hook was invoked → no ✅/❌ lines, no SHOULD NOT FIRE error.
    assert.doesNotMatch(out, /verdict\.append/);
    assert.doesNotMatch(err, /SHOULD NOT FIRE/);
  });

  test("soft overlap between provides and compatibleCapabilities is NOT a mismatch", async () => {
    // This was Reviewer B's explicit concern in U5.6r protocol — an extension
    // legitimately migrating v1→v2 that declares both should NOT get flagged.
    const extDir = join(tmpBase, "versioned");
    writeExtension(extDir, `
      export const meta = {
        provides: ["visual-check@2"],
        compatibleCapabilities: ["visual-check@1"],
      };
      export function verdictAppend(ctx) { return []; }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u55h=${Date.now()}`);
    const { err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--lint"])
    );
    assert.equal(exitCode, 0);
    assert.doesNotMatch(err, /hook mismatch/);
  });
});

// ─── U5.6r fix-pair — reviewer feedback ──────────────────────────

describe("U5.6r fix-pair — DX and robustness polish", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

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

  test("typo-guard: --fixturedir (unknown flag) → exit 1 with actionable error", async () => {
    // Reviewer B 🟡: before the fix, getFlag silently ignored unknown flags,
    // so `--fixturedir /tmp/x` ran with no sandbox and could write into repo.
    const extDir = join(tmpBase, "any");
    writeExtension(extDir, `
      export const meta = { provides: ["verification@1"] };
      export function verdictAppend(ctx) { return []; }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u56a=${Date.now()}`);
    const { err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--fixturedir", "/tmp/typo", "--lint"])
    );
    assert.equal(exitCode, 1);
    assert.match(err, /Unknown flag: --fixturedir/);
    assert.match(err, /--fixture-dir/); // list shows the real flag for correction
  });

  test("typo-guard: --lint-stict (unknown flag) → exit 1", async () => {
    const extDir = join(tmpBase, "any2");
    writeExtension(extDir, `
      export const meta = { provides: ["verification@1"] };
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u56b=${Date.now()}`);
    const { err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--lint-stict"])
    );
    assert.equal(exitCode, 1);
    assert.match(err, /Unknown flag: --lint-stict/);
  });

  test("--lint-strict: no lint issues → exit 0", async () => {
    const extDir = join(tmpBase, "clean");
    writeExtension(extDir, `
      export const meta = { provides: ["verification@1"] };
      export function verdictAppend(ctx) { return []; }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u56c=${Date.now()}`);
    const { exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--lint-strict"])
    );
    assert.equal(exitCode, 0);
  });

  test("--lint-strict: hook mismatch → exit 1 (CI-failable)", async () => {
    // Reviewer B 🟡: `--lint` is documented as pre-commit check but exits 0
    // always, so CI can't fail the build. `--lint-strict` gives CI a knob.
    const extDir = join(tmpBase, "mismatched");
    writeExtension(extDir, `
      export const meta = { provides: [] };
      export function verdictAppend(ctx) { return []; }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u56d=${Date.now()}`);
    const { err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--lint-strict"])
    );
    assert.equal(exitCode, 1);
    assert.match(err, /hook mismatch/);
  });

  test("--lint-strict: malformed capability shape → exit 1", async () => {
    const extDir = join(tmpBase, "badcap");
    writeExtension(extDir, `
      export const meta = { provides: ["BAD@1"] };
      export function verdictAppend(ctx) { return []; }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u56e=${Date.now()}`);
    const { err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--lint-strict"])
    );
    assert.equal(exitCode, 1);
    assert.match(err, /failed capability-shape check/);
  });

  test("fixture-dir: symlinks are dereferenced (no sandbox escape)", async () => {
    // Reviewer A 🟡: without dereference:true, `cp -r` preserves symlinks.
    // A fixture with a symlink to /etc/passwd would read /etc/passwd during
    // test. With dereference:true, the target content is copied as a plain
    // file into the tmp sandbox — removing the tmp dir removes all copies.
    const realDir = join(tmpBase, "real");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "secret.txt"), "OUTSIDE-SANDBOX", "utf8");
    const fixtureSrc = join(tmpBase, "fx-with-symlink");
    mkdirSync(fixtureSrc, { recursive: true });
    // Create a symlink inside the fixture pointing OUTSIDE the fixture.
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(realDir, "secret.txt"), join(fixtureSrc, "escape-link"));

    const extDir = join(tmpBase, "peek");
    writeExtension(extDir, `
      import { existsSync, readFileSync, lstatSync } from "fs";
      import { join } from "path";
      export const meta = { provides: ["verification@1"] };
      export function promptAppend(ctx) {
        const p = join(ctx.flowDir, "escape-link");
        if (!existsSync(p)) return "missing";
        const stat = lstatSync(p);
        return "isSymlink=" + stat.isSymbolicLink() + " content=" + readFileSync(p, "utf8");
      }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u56f=${Date.now()}`);
    const { out, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--hook", "prompt.append", "--fixture-dir", fixtureSrc])
    );
    assert.equal(exitCode, 0);
    // dereference:true means the copy is a plain file, not a symlink.
    assert.match(out, /isSymlink=false/);
    // Content is preserved (it's what we'd expect for a useful fixture) but
    // the real file can be deleted and the tmp copy stays readable → sandbox.
    assert.match(out, /content=OUTSIDE-SANDBOX/);
  });

  test("stderr text 'Specify --hook <name> or --all-hooks' preserved (no breaking change)", async () => {
    // Reviewer B 🟡: the U5.5 version changed this text to include "or --lint
    // for lint-only mode", which would break scripts grepping for the old
    // phrase. Restored to verbatim pre-U5.5 text.
    const extDir = join(tmpBase, "any3");
    writeExtension(extDir, `
      export const meta = { provides: ["verification@1"] };
      export function verdictAppend(ctx) { return []; }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u56g=${Date.now()}`);
    const { err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir])
    );
    assert.equal(exitCode, 1);
    // Exact phrase, no trailing additions.
    assert.match(err, /Specify --hook <name> or --all-hooks\n?$/m);
  });

  test("--lint with --hook ignored (lint wins, hook not invoked)", async () => {
    // Reviewer B 🟡: --lint + --hook combination was undocumented. Now
    // verified: --lint wins, hooks are skipped regardless of --hook/--all-hooks.
    const extDir = join(tmpBase, "should-not-fire");
    writeExtension(extDir, `
      export const meta = { provides: ["verification@1"] };
      export function verdictAppend(ctx) { throw new Error("MUST NOT FIRE"); }
    `);
    const { cmdExtensionTest } = await import(`./ext-commands.mjs?u56h=${Date.now()}`);
    const { out, err, exitCode } = await captureAll(() =>
      cmdExtensionTest(["--ext", extDir, "--hook", "verdict.append", "--lint"])
    );
    assert.equal(exitCode, 0);
    assert.doesNotMatch(out, /verdict\.append/);
    assert.doesNotMatch(err, /MUST NOT FIRE/);
  });
});

// ─── U5.7 F5: Persistent circuit-breaker state ───────────────────

describe("U5.7 F5 — persistent circuit-breaker state", () => {
  let tmpBase;
  beforeEach(() => { tmpBase = makeTmpDir(); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  function writeFlaky(extsDir, name = "flaky") {
    const d = join(extsDir, name);
    writeExtension(d, `
      export const meta = { provides: ["verification@1"] };
      export function verdictAppend(ctx) { throw new Error("boom"); }
    `);
    return d;
  }

  test("saveBreakerState writes valid schema v1 JSON atomically", async () => {
    const extsDir = join(tmpBase, "extensions");
    mkdirSync(extsDir, { recursive: true });
    writeFlaky(extsDir);
    const flowDir = join(tmpBase, "flow");
    mkdirSync(flowDir, { recursive: true });

    const registry = await loadExtensions({ extensionsDir: extsDir, flowDir });
    // Hand-disable to simulate tripped state
    registry.extensions[0].enabled = false;
    registry.extensions[0].disabledReason = "test-tripped";
    registry.extensions[0]._failStreak = 5;

    saveBreakerState(flowDir, registry);

    const path = join(flowDir, BREAKER_STATE_FILE);
    assert.ok(existsSync(path));
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.version, 1);
    assert.match(parsed.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(parsed.extensions.flaky.enabled, false);
    assert.equal(parsed.extensions.flaky.failStreak, 5);
    assert.equal(parsed.extensions.flaky.disabledReason, "test-tripped");
  });

  test("loadBreakerState reads v1 file and ignores unknown versions", () => {
    const flowDir = join(tmpBase, "flow");
    mkdirSync(flowDir, { recursive: true });
    const path = join(flowDir, BREAKER_STATE_FILE);

    // Missing file → null
    assert.equal(loadBreakerState(flowDir), null);

    // Unknown version → null + WARN
    writeFileSync(path, JSON.stringify({ version: 99, extensions: {} }));
    assert.equal(loadBreakerState(flowDir), null);

    // Valid v1 → object
    writeFileSync(path, JSON.stringify({
      version: 1, updatedAt: new Date().toISOString(),
      extensions: { foo: { enabled: false, failStreak: 3 } },
    }));
    const snap = loadBreakerState(flowDir);
    assert.equal(snap.version, 1);
    assert.equal(snap.extensions.foo.enabled, false);

    // Corrupt JSON → null, no crash
    writeFileSync(path, "{not-json");
    assert.equal(loadBreakerState(flowDir), null);
  });

  test("applyBreakerState marks matching extensions disabled", async () => {
    const extsDir = join(tmpBase, "extensions");
    mkdirSync(extsDir, { recursive: true });
    writeFlaky(extsDir, "ext-a");
    writeFlaky(extsDir, "ext-b");

    const registry = await loadExtensions({ extensionsDir: extsDir });
    applyBreakerState(registry, {
      version: 1,
      extensions: { "ext-a": { enabled: false, failStreak: 4, disabledReason: "prior-run" } },
    });

    const a = registry.extensions.find(e => e.name === "ext-a");
    const b = registry.extensions.find(e => e.name === "ext-b");
    assert.equal(a.enabled, false);
    assert.equal(a._failStreak, 4);
    assert.equal(a.disabledReason, "prior-run");
    // Unmentioned ext untouched
    assert.equal(b.enabled, true);
    assert.equal(b._failStreak || 0, 0);
  });

  test("loadExtensions({flowDir}) re-applies persisted disabled state", async () => {
    const extsDir = join(tmpBase, "extensions");
    mkdirSync(extsDir, { recursive: true });
    writeFlaky(extsDir);
    const flowDir = join(tmpBase, "flow");
    mkdirSync(flowDir, { recursive: true });

    // Seed persisted state
    writeFileSync(join(flowDir, BREAKER_STATE_FILE), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      extensions: { flaky: { enabled: false, failStreak: 7, disabledReason: "persisted" } },
    }));

    const registry = await loadExtensions({ extensionsDir: extsDir, flowDir });
    assert.equal(registry._flowDir, flowDir);
    const ext = registry.extensions[0];
    assert.equal(ext.enabled, false);
    assert.equal(ext._failStreak, 7);
    assert.equal(ext.disabledReason, "persisted");
  });

  test("fireVerdictAppend persists breaker state across invocations (same flow)", async () => {
    const extsDir = join(tmpBase, "extensions");
    mkdirSync(extsDir, { recursive: true });
    writeFlaky(extsDir);
    const flowDir = join(tmpBase, "flow");
    mkdirSync(flowDir, { recursive: true });

    // Three invocations — each reloads extensions with flowDir, fires, state persists.
    const runDir = join(tmpBase, "runs/r1");
    mkdirSync(runDir, { recursive: true });

    async function invoke() {
      const registry = await loadExtensions({ extensionsDir: extsDir, flowDir });
      await fireVerdictAppend(registry, {
        nodeCapabilities: ["verification@1"], flowDir, runDir,
      });
      return registry;
    }

    // Default threshold is 3 consecutive failures.
    const r1 = await invoke();
    assert.equal(r1.extensions[0].enabled, true, "run1: not yet tripped");
    assert.equal(r1.extensions[0]._failStreak, 1);

    const r2 = await invoke();
    assert.equal(r2.extensions[0].enabled, true, "run2: one more failure");
    assert.equal(r2.extensions[0]._failStreak, 2);

    const r3 = await invoke();
    // Third failure trips the breaker. After the next load the ext should
    // come back already disabled.
    assert.equal(r3.extensions[0].enabled, false, "run3: breaker tripped");

    // Fourth invocation — ext starts disabled, so no hook fires, no new failure.
    const r4 = await invoke();
    assert.equal(r4.extensions[0].enabled, false, "run4: still disabled");
  });

  test("clearBreakerState removes the file (delete-on-init semantics)", () => {
    const flowDir = join(tmpBase, "flow");
    mkdirSync(flowDir, { recursive: true });
    const path = join(flowDir, BREAKER_STATE_FILE);
    writeFileSync(path, JSON.stringify({
      version: 1, updatedAt: "x",
      extensions: { foo: { enabled: false, failStreak: 9 } },
    }));

    clearBreakerState(flowDir);
    // U5.8r: clear must delete, not rewrite. Missing file and empty
    // file should be semantically equivalent — keep the lifecycle simple.
    assert.ok(!existsSync(path));
  });

  test("clearBreakerState on missing file is a no-op (no throw, no file created)", () => {
    const flowDir = join(tmpBase, "flow");
    mkdirSync(flowDir, { recursive: true });
    // Sanity: no state file yet
    assert.ok(!existsSync(join(flowDir, BREAKER_STATE_FILE)));
    clearBreakerState(flowDir);
    assert.ok(!existsSync(join(flowDir, BREAKER_STATE_FILE)));
  });

  test("saveBreakerState creates parent dir if missing (no ENOENT crash)", async () => {
    const extsDir = join(tmpBase, "extensions");
    mkdirSync(extsDir, { recursive: true });
    writeFlaky(extsDir);
    const flowDir = join(tmpBase, "not/yet/created");
    // Parent dir doesn't exist — saveBreakerState must mkdir -p it.
    const registry = await loadExtensions({ extensionsDir: extsDir, flowDir });
    registry._flowDir = flowDir;
    saveBreakerState(flowDir, registry);
    assert.ok(existsSync(join(flowDir, BREAKER_STATE_FILE)));
  });

  test("no flowDir → fire* does not persist (no file created anywhere)", async () => {
    const extsDir = join(tmpBase, "extensions");
    mkdirSync(extsDir, { recursive: true });
    writeFlaky(extsDir);
    const runDir = join(tmpBase, "run");
    mkdirSync(runDir, { recursive: true });

    // No flowDir passed into config
    const registry = await loadExtensions({ extensionsDir: extsDir });
    assert.equal(registry._flowDir, undefined);
    await fireVerdictAppend(registry, {
      nodeCapabilities: ["verification@1"], flowDir: undefined, runDir,
    });
    // No state file anywhere under tmpBase
    // Walk: just check obvious candidates
    assert.ok(!existsSync(join(tmpBase, BREAKER_STATE_FILE)));
    assert.ok(!existsSync(join(runDir, BREAKER_STATE_FILE)));
  });

  test("bypass (disable-all) does not attempt to load or persist breaker state", async () => {
    const flowDir = join(tmpBase, "flow");
    mkdirSync(flowDir, { recursive: true });
    // Seed a stale state file to prove it's not consulted
    writeFileSync(join(flowDir, BREAKER_STATE_FILE), JSON.stringify({
      version: 1, extensions: { ghost: { enabled: false } },
    }));

    const registry = await loadExtensions({ noExtensions: true, flowDir, quietBypass: true });
    assert.deepEqual(registry.extensions, []);
    // _flowDir should not be set under bypass (no extensions to track)
    assert.equal(registry._flowDir, undefined);
  });

  // ── U5.8r fix-pair: review findings from persistence-auditor + bypass-dx-reviewer ──

  test("U5.8r: saveBreakerState preserves entries for extensions not in the current registry (whitelist-bypass safety)", async () => {
    const extsDir = join(tmpBase, "extensions");
    mkdirSync(extsDir, { recursive: true });
    writeFlaky(extsDir, "ext-a");
    writeFlaky(extsDir, "ext-b");
    const flowDir = join(tmpBase, "flow");
    mkdirSync(flowDir, { recursive: true });

    // Seed a file with a disabled 'ghost' extension that isn't loaded in
    // this invocation (simulates: prior run tripped ext-ghost, this run
    // uses `--extensions ext-a` whitelist).
    const statePath = join(flowDir, BREAKER_STATE_FILE);
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      updatedAt: "2026-04-18T00:00:00.000Z",
      extensions: {
        ghost: { enabled: false, failStreak: 3, disabledReason: "from yesterday" },
      },
    }));

    // Load only ext-a (whitelist). This fires verdict.append → save.
    const reg = await loadExtensions({ extensionsDir: extsDir, flowDir, extensionWhitelist: ["ext-a"], quietBypass: true });
    await fireVerdictAppend(reg, { node: "review", runDir: mkdtempSync(join(tmpBase, "run-")) });

    const after = JSON.parse(readFileSync(statePath, "utf8"));
    // ghost must still be there — not wiped by ext-a's save
    assert.equal(after.extensions.ghost?.enabled, false);
    assert.equal(after.extensions.ghost?.disabledReason, "from yesterday");
    // ext-a must also be present
    assert.ok(after.extensions["ext-a"], "ext-a should be in the file too");
  });

  test("U5.8r: saveBreakerState preserves unknown top-level fields (forward-compat round-trip)", async () => {
    const extsDir = join(tmpBase, "extensions");
    mkdirSync(extsDir, { recursive: true });
    writeFlaky(extsDir);
    const flowDir = join(tmpBase, "flow");
    mkdirSync(flowDir, { recursive: true });

    // Seed a file with a future field a v1 writer doesn't know about
    const statePath = join(flowDir, BREAKER_STATE_FILE);
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      updatedAt: "2026-04-18T00:00:00.000Z",
      extensions: {},
      futureField: { hello: "world" },
    }));

    const reg = await loadExtensions({ extensionsDir: extsDir, flowDir, quietBypass: true });
    saveBreakerState(flowDir, reg);

    const after = JSON.parse(readFileSync(statePath, "utf8"));
    // futureField must survive round-trip
    assert.deepEqual(after.futureField, { hello: "world" });
    assert.equal(after.version, 1);
  });

  test("U5.8r: applyBreakerState emits a stderr breadcrumb naming restored-disabled extensions", async () => {
    const extsDir = join(tmpBase, "extensions");
    mkdirSync(extsDir, { recursive: true });
    writeFlaky(extsDir, "ext-a");
    writeFlaky(extsDir, "ext-b");
    const flowDir = join(tmpBase, "flow");
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, BREAKER_STATE_FILE), JSON.stringify({
      version: 1,
      updatedAt: "x",
      extensions: {
        "ext-a": { enabled: false, failStreak: 3, disabledReason: "prior trip" },
        "ext-b": { enabled: true, failStreak: 0 },
      },
    }));

    const captured = [];
    const origErr = console.error;
    console.error = (...args) => { captured.push(args.join(" ")); };
    try {
      await loadExtensions({ extensionsDir: extsDir, flowDir, quietBypass: true });
    } finally {
      console.error = origErr;
    }

    const joined = captured.join("\n");
    assert.ok(/restored disabled state/.test(joined), `expected breadcrumb in stderr, got:\n${joined}`);
    assert.ok(/ext-a/.test(joined), "breadcrumb must name ext-a");
    assert.ok(!/ext-b/.test(joined.split("restored disabled")[1] || ""), "breadcrumb must NOT name ext-b (it was enabled)");
  });

  test("U5.8r: resetExtension(ext, registry) persists the reset when flowDir is tracked", async () => {
    const extsDir = join(tmpBase, "extensions");
    mkdirSync(extsDir, { recursive: true });
    writeFlaky(extsDir);
    const flowDir = join(tmpBase, "flow");
    mkdirSync(flowDir, { recursive: true });
    // Seed disabled state
    writeFileSync(join(flowDir, BREAKER_STATE_FILE), JSON.stringify({
      version: 1, updatedAt: "x",
      extensions: { flaky: { enabled: false, failStreak: 3, disabledReason: "old" } },
    }));

    const reg = await loadExtensions({ extensionsDir: extsDir, flowDir, quietBypass: true });
    // Loaded as disabled
    assert.equal(reg.extensions[0].enabled, false);

    // Reset with registry → should persist
    resetExtension(reg.extensions[0], reg);

    const after = JSON.parse(readFileSync(join(flowDir, BREAKER_STATE_FILE), "utf8"));
    assert.equal(after.extensions.flaky.enabled, true, "persisted state must show enabled=true after reset");
    assert.equal(after.extensions.flaky.failStreak, 0);
    assert.ok(!after.extensions.flaky.disabledReason, "disabledReason must be cleared");
  });

  test("U5.8r: OPC_BREAKER_STATE=disabled disables both load and save (no file reads/writes)", async () => {
    const extsDir = join(tmpBase, "extensions");
    mkdirSync(extsDir, { recursive: true });
    writeFlaky(extsDir);
    const flowDir = join(tmpBase, "flow");
    mkdirSync(flowDir, { recursive: true });
    // Seed a file that would normally disable the extension
    const statePath = join(flowDir, BREAKER_STATE_FILE);
    writeFileSync(statePath, JSON.stringify({
      version: 1, updatedAt: "x",
      extensions: { flaky: { enabled: false, failStreak: 3, disabledReason: "x" } },
    }));

    const prev = process.env.OPC_BREAKER_STATE;
    process.env.OPC_BREAKER_STATE = "disabled";
    try {
      const reg = await loadExtensions({ extensionsDir: extsDir, flowDir, quietBypass: true });
      // Load was skipped — extension must appear enabled
      assert.equal(reg.extensions[0].enabled, true, "with OPC_BREAKER_STATE=disabled, the stale-disabled state must not apply");
      // Save is also a no-op
      saveBreakerState(flowDir, reg);
      const after = JSON.parse(readFileSync(statePath, "utf8"));
      // File unchanged (still shows flaky disabled from the seed)
      assert.equal(after.extensions.flaky.enabled, false, "file must be unchanged when persistence is disabled");
    } finally {
      if (prev === undefined) delete process.env.OPC_BREAKER_STATE;
      else process.env.OPC_BREAKER_STATE = prev;
    }
  });
});
