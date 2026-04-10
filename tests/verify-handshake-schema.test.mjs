// tests/verify-handshake-schema.test.mjs — V551-V700 (150 tests)
// Exhaustive handshake.json validation via cmdValidate.
// Uses node:test + node:assert/strict, temp directories for all file I/O.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Console/exit capture ────────────────────────────────────────

let tmpDir;
let captured;
let origLog, origError, origExit;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-schema-"));
  captured = { stdout: [], stderr: [], exitCode: null };
  origLog = console.log;
  origError = console.error;
  origExit = process.exit;
  console.log = (...a) => captured.stdout.push(a.join(" "));
  console.error = (...a) => captured.stderr.push(a.join(" "));
  process.exit = (code) => { captured.exitCode = code; throw new Error(`EXIT_${code}`); };
}

function teardown() {
  console.log = origLog;
  console.error = origError;
  process.exit = origExit;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

function out() {
  if (captured.stdout.length === 0) return null;
  return JSON.parse(captured.stdout[captured.stdout.length - 1]);
}

const { cmdValidate } = await import(path.join(process.cwd(), "bin/lib/flow-commands.mjs"));

// ── Helpers ─────────────────────────────────────────────────────

function validHandshake(overrides = {}) {
  return {
    nodeId: "build-1",
    nodeType: "build",
    runId: "run_1",
    status: "completed",
    summary: "Build succeeded",
    timestamp: "2026-04-10T12:00:00Z",
    artifacts: [],
    verdict: "PASS",
    ...overrides,
  };
}

function writeAndValidate(data, filename) {
  filename = filename || "handshake.json";
  const filePath = path.join(tmpDir, filename);
  if (typeof data === "string") {
    fs.writeFileSync(filePath, data);
  } else {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }
  captured.stdout = [];
  captured.stderr = [];
  cmdValidate([filePath]);
  return out();
}

function writeRawAndValidate(rawString, filename) {
  filename = filename || "handshake.json";
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, rawString);
  captured.stdout = [];
  captured.stderr = [];
  cmdValidate([filePath]);
  return out();
}

// ══════════════════════════════════════════════════════════════════
// 1. FIELD TYPE VIOLATIONS (V551-V580, 30 tests)
// ══════════════════════════════════════════════════════════════════

describe("1 — Field type violations", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("V551 — nodeId as number produces error", () => {
    const r = writeAndValidate(validHandshake({ nodeId: 42 }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("nodeId")));
  });

  it("V552 — nodeId as boolean produces error", () => {
    const r = writeAndValidate(validHandshake({ nodeId: true }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("nodeId")));
  });

  it("V553 — nodeId as null produces error", () => {
    const r = writeAndValidate(validHandshake({ nodeId: null }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("nodeId")));
  });

  it("V554 — nodeId as empty string produces error", () => {
    const r = writeAndValidate(validHandshake({ nodeId: "" }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("nodeId")));
  });

  it("V555 — nodeId as array produces error", () => {
    const r = writeAndValidate(validHandshake({ nodeId: ["build"] }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("nodeId")));
  });

  it("V556 — nodeType as array produces error", () => {
    const r = writeAndValidate(validHandshake({ nodeType: ["build"] }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("nodeType")));
  });

  it("V557 — nodeType as number produces error", () => {
    const r = writeAndValidate(validHandshake({ nodeType: 123 }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("nodeType")));
  });

  it("V558 — nodeType as null produces error", () => {
    const r = writeAndValidate(validHandshake({ nodeType: null }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("nodeType")));
  });

  it("V559 — runId as boolean produces error", () => {
    const r = writeAndValidate(validHandshake({ runId: false }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("runId")));
  });

  it("V560 — runId as number produces error", () => {
    const r = writeAndValidate(validHandshake({ runId: 1 }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("runId")));
  });

  it("V561 — runId as null produces error", () => {
    const r = writeAndValidate(validHandshake({ runId: null }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("runId")));
  });

  it("V562 — status as null produces error", () => {
    const r = writeAndValidate(validHandshake({ status: null }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("status")));
  });

  it("V563 — status as number produces error", () => {
    const r = writeAndValidate(validHandshake({ status: 0 }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("status")));
  });

  it("V564 — status as object produces error", () => {
    const r = writeAndValidate(validHandshake({ status: {} }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("status")));
  });

  it("V565 — summary as object produces error", () => {
    const r = writeAndValidate(validHandshake({ summary: { text: "ok" } }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("summary")));
  });

  it("V566 — summary as number produces error", () => {
    const r = writeAndValidate(validHandshake({ summary: 42 }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("summary")));
  });

  it("V567 — summary as null produces error", () => {
    const r = writeAndValidate(validHandshake({ summary: null }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("summary")));
  });

  it("V568 — summary as empty string produces error", () => {
    const r = writeAndValidate(validHandshake({ summary: "" }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("summary")));
  });

  it("V569 — timestamp as number produces error", () => {
    const r = writeAndValidate(validHandshake({ timestamp: Date.now() }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("timestamp")));
  });

  it("V570 — timestamp as null produces error", () => {
    const r = writeAndValidate(validHandshake({ timestamp: null }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("timestamp")));
  });

  it("V571 — timestamp as empty string produces error", () => {
    const r = writeAndValidate(validHandshake({ timestamp: "" }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("timestamp")));
  });

  it("V572 — timestamp as boolean produces error", () => {
    const r = writeAndValidate(validHandshake({ timestamp: true }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("timestamp")));
  });

  it("V573 — missing nodeId field entirely produces error", () => {
    const hs = validHandshake();
    delete hs.nodeId;
    const r = writeAndValidate(hs);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("nodeId")));
  });

  it("V574 — missing nodeType field entirely produces error", () => {
    const hs = validHandshake();
    delete hs.nodeType;
    const r = writeAndValidate(hs);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("nodeType")));
  });

  it("V575 — missing runId field entirely produces error", () => {
    const hs = validHandshake();
    delete hs.runId;
    const r = writeAndValidate(hs);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("runId")));
  });

  it("V576 — missing status field entirely produces error", () => {
    const hs = validHandshake();
    delete hs.status;
    const r = writeAndValidate(hs);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("status")));
  });

  it("V577 — missing summary field entirely produces error", () => {
    const hs = validHandshake();
    delete hs.summary;
    const r = writeAndValidate(hs);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("summary")));
  });

  it("V578 — missing timestamp field entirely produces error", () => {
    const hs = validHandshake();
    delete hs.timestamp;
    const r = writeAndValidate(hs);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("timestamp")));
  });

  it("V579 — all required fields missing produces 6 errors", () => {
    const r = writeAndValidate({ artifacts: [] });
    assert.equal(r.valid, false);
    assert.ok(r.errors.length >= 6);
  });

  it("V580 — valid handshake passes validation", () => {
    const r = writeAndValidate(validHandshake());
    assert.equal(r.valid, true);
    assert.equal(r.errors.length, 0);
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. ENUM BOUNDARIES (V581-V600, 20 tests)
// ══════════════════════════════════════════════════════════════════

describe("2 — Enum boundaries", () => {
  beforeEach(setup);
  afterEach(teardown);

  // Valid nodeTypes
  it("V581 — nodeType 'discussion' is valid", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "discussion" }));
    assert.equal(r.valid, true);
  });

  it("V582 — nodeType 'build' is valid", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "build" }));
    assert.equal(r.valid, true);
  });

  it("V583 — nodeType 'review' is valid", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "review" }));
    assert.equal(r.valid, true);
  });

  it("V584 — nodeType 'execute' is valid", () => {
    const r = writeAndValidate(validHandshake({
      nodeType: "execute",
      artifacts: [{ type: "test-result", path: "dummy.txt" }],
    }));
    // Create the artifact file so artifact validation passes
    fs.writeFileSync(path.join(tmpDir, "dummy.txt"), "ok");
    // Re-validate
    const r2 = writeAndValidate(validHandshake({
      nodeType: "execute",
      artifacts: [{ type: "test-result", path: "dummy.txt" }],
    }));
    assert.equal(r2.valid, true);
  });

  it("V585 — nodeType 'gate' is valid", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "gate" }));
    assert.equal(r.valid, true);
  });

  // Invalid nodeTypes
  it("V586 — nodeType 'BUILD' (uppercase) is invalid", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "BUILD" }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("invalid nodeType")));
  });

  it("V587 — nodeType 'Discussion' (capitalized) is invalid", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "Discussion" }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("invalid nodeType")));
  });

  it("V588 — nodeType '' (empty) triggers missing field, not enum error", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "" }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("nodeType")));
  });

  it("V589 — nodeType ' gate' (leading space) is invalid", () => {
    const r = writeAndValidate(validHandshake({ nodeType: " gate" }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("invalid nodeType")));
  });

  it("V590 — nodeType 'test' is invalid", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "test" }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("invalid nodeType")));
  });

  it("V591 — nodeType 'deploy' is invalid", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "deploy" }));
    assert.equal(r.valid, false);
  });

  // Valid statuses
  it("V592 — status 'completed' is valid", () => {
    const r = writeAndValidate(validHandshake({ status: "completed" }));
    assert.equal(r.valid, true);
  });

  it("V593 — status 'failed' is valid", () => {
    const r = writeAndValidate(validHandshake({ status: "failed" }));
    assert.equal(r.valid, true);
  });

  it("V594 — status 'blocked' is valid", () => {
    const r = writeAndValidate(validHandshake({ status: "blocked" }));
    assert.equal(r.valid, true);
  });

  // Invalid statuses
  it("V595 — status 'COMPLETED' (uppercase) is invalid", () => {
    const r = writeAndValidate(validHandshake({ status: "COMPLETED" }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("invalid status")));
  });

  it("V596 — status 'pending' is invalid", () => {
    const r = writeAndValidate(validHandshake({ status: "pending" }));
    assert.equal(r.valid, false);
  });

  it("V597 — status 'running' is invalid", () => {
    const r = writeAndValidate(validHandshake({ status: "running" }));
    assert.equal(r.valid, false);
  });

  // Valid verdicts
  it("V598 — verdict 'PASS' is valid", () => {
    const r = writeAndValidate(validHandshake({ verdict: "PASS" }));
    assert.equal(r.valid, true);
  });

  it("V599 — verdict 'BLOCKED' is valid", () => {
    const r = writeAndValidate(validHandshake({ verdict: "BLOCKED" }));
    assert.equal(r.valid, true);
  });

  it("V600 — verdict 'pass' (lowercase) is invalid", () => {
    const r = writeAndValidate(validHandshake({ verdict: "pass" }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("invalid verdict")));
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. ARTIFACT PATH RESOLUTION (V601-V625, 25 tests)
// ══════════════════════════════════════════════════════════════════

describe("3 — Artifact path resolution", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("V601 — relative path to existing file passes", () => {
    fs.writeFileSync(path.join(tmpDir, "output.log"), "log data");
    const r = writeAndValidate(validHandshake({
      artifacts: [{ type: "cli-output", path: "output.log" }],
    }));
    assert.equal(r.valid, true);
  });

  it("V602 — relative path to non-existent file produces error", () => {
    const r = writeAndValidate(validHandshake({
      artifacts: [{ type: "cli-output", path: "missing.log" }],
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("file not found")));
  });

  it("V603 — absolute path to existing file passes", () => {
    const absFile = path.join(tmpDir, "abs-output.log");
    fs.writeFileSync(absFile, "data");
    const r = writeAndValidate(validHandshake({
      artifacts: [{ type: "cli-output", path: absFile }],
    }));
    assert.equal(r.valid, true);
  });

  it("V604 — absolute path to non-existent file produces error", () => {
    const r = writeAndValidate(validHandshake({
      artifacts: [{ type: "cli-output", path: "/tmp/definitely-not-here-9999.txt" }],
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("file not found")));
  });

  it("V605 — symlink to existing file passes", () => {
    const target = path.join(tmpDir, "real-file.txt");
    const link = path.join(tmpDir, "symlink.txt");
    fs.writeFileSync(target, "content");
    fs.symlinkSync(target, link);
    const r = writeAndValidate(validHandshake({
      artifacts: [{ type: "cli-output", path: "symlink.txt" }],
    }));
    assert.equal(r.valid, true);
  });

  it("V606 — path with spaces passes when file exists", () => {
    fs.writeFileSync(path.join(tmpDir, "my file.txt"), "content");
    const r = writeAndValidate(validHandshake({
      artifacts: [{ type: "cli-output", path: "my file.txt" }],
    }));
    assert.equal(r.valid, true);
  });

  it("V607 — path with Chinese characters passes when file exists", () => {
    fs.writeFileSync(path.join(tmpDir, "测试文件.txt"), "content");
    const r = writeAndValidate(validHandshake({
      artifacts: [{ type: "cli-output", path: "测试文件.txt" }],
    }));
    assert.equal(r.valid, true);
  });

  it("V608 — path with Chinese characters to non-existent file fails", () => {
    const r = writeAndValidate(validHandshake({
      artifacts: [{ type: "cli-output", path: "不存在.txt" }],
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("file not found")));
  });

  it("V609 — directory path (not a file) — existsSync returns true for dirs", () => {
    const subDir = path.join(tmpDir, "subdir");
    fs.mkdirSync(subDir);
    // existsSync returns true for directories, so this should pass path check
    const r = writeAndValidate(validHandshake({
      artifacts: [{ type: "cli-output", path: "subdir" }],
    }));
    assert.equal(r.valid, true); // existsSync doesn't distinguish files from dirs
  });

  it("V610 — artifact missing type produces error", () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "x");
    const r = writeAndValidate(validHandshake({
      artifacts: [{ path: "a.txt" }],
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("missing type or path")));
  });

  it("V611 — artifact missing path produces error", () => {
    const r = writeAndValidate(validHandshake({
      artifacts: [{ type: "cli-output" }],
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("missing type or path")));
  });

  it("V612 — artifact missing both type and path produces error", () => {
    const r = writeAndValidate(validHandshake({
      artifacts: [{}],
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("missing type or path")));
  });

  it("V613 — multiple artifacts: first valid, second invalid path", () => {
    fs.writeFileSync(path.join(tmpDir, "good.txt"), "ok");
    const r = writeAndValidate(validHandshake({
      artifacts: [
        { type: "cli-output", path: "good.txt" },
        { type: "cli-output", path: "bad.txt" },
      ],
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("file not found") && e.includes("bad.txt")));
  });

  it("V614 — multiple artifacts: both valid", () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "ok");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "ok");
    const r = writeAndValidate(validHandshake({
      artifacts: [
        { type: "cli-output", path: "a.txt" },
        { type: "test-result", path: "b.txt" },
      ],
    }));
    assert.equal(r.valid, true);
  });

  it("V615 — artifacts as string (not array) produces error", () => {
    const r = writeAndValidate(validHandshake({ artifacts: "file.txt" }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("artifacts must be an array")));
  });

  it("V616 — artifacts as null produces error", () => {
    const r = writeAndValidate(validHandshake({ artifacts: null }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("artifacts must be an array")));
  });

  it("V617 — artifacts as object produces error", () => {
    const r = writeAndValidate(validHandshake({ artifacts: { file: "a.txt" } }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("artifacts must be an array")));
  });

  it("V618 — artifacts as number produces error", () => {
    const r = writeAndValidate(validHandshake({ artifacts: 42 }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("artifacts must be an array")));
  });

  it("V619 — empty artifacts array is valid", () => {
    const r = writeAndValidate(validHandshake({ artifacts: [] }));
    assert.equal(r.valid, true);
  });

  it("V620 — artifact index 0 referenced in error message", () => {
    const r = writeAndValidate(validHandshake({
      artifacts: [{}],
    }));
    assert.ok(r.errors.some((e) => e.includes("artifact[0]")));
  });

  it("V621 — artifact index 2 referenced in error message for third item", () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "ok");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "ok");
    const r = writeAndValidate(validHandshake({
      artifacts: [
        { type: "cli-output", path: "a.txt" },
        { type: "cli-output", path: "b.txt" },
        {},
      ],
    }));
    assert.ok(r.errors.some((e) => e.includes("artifact[2]")));
  });

  it("V622 — nested directory artifact path passes", () => {
    const nested = path.join(tmpDir, "sub", "dir");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "f.txt"), "ok");
    const r = writeAndValidate(validHandshake({
      artifacts: [{ type: "cli-output", path: "sub/dir/f.txt" }],
    }));
    assert.equal(r.valid, true);
  });

  it("V623 — path with special chars passes when file exists", () => {
    fs.writeFileSync(path.join(tmpDir, "file-with_special.chars.v2.txt"), "ok");
    const r = writeAndValidate(validHandshake({
      artifacts: [{ type: "cli-output", path: "file-with_special.chars.v2.txt" }],
    }));
    assert.equal(r.valid, true);
  });

  it("V624 — path with dot-dot does not escape when resolved relatively", () => {
    // Create file one level up from a subdir
    fs.writeFileSync(path.join(tmpDir, "parent.txt"), "ok");
    const subDir = path.join(tmpDir, "sub");
    fs.mkdirSync(subDir);
    const hsPath = path.join(subDir, "handshake.json");
    const data = validHandshake({
      artifacts: [{ type: "cli-output", path: "../parent.txt" }],
    });
    fs.writeFileSync(hsPath, JSON.stringify(data));
    captured.stdout = [];
    cmdValidate([hsPath]);
    const r = out();
    assert.equal(r.valid, true);
  });

  it("V625 — broken symlink produces file-not-found error", () => {
    const link = path.join(tmpDir, "broken-link.txt");
    fs.symlinkSync(path.join(tmpDir, "nonexistent-target.txt"), link);
    const r = writeAndValidate(validHandshake({
      artifacts: [{ type: "cli-output", path: "broken-link.txt" }],
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("file not found")));
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. EVIDENCE RULES (V626-V650, 25 tests)
// ══════════════════════════════════════════════════════════════════

describe("4 — Evidence rules", () => {
  beforeEach(setup);
  afterEach(teardown);

  function evidenceHandshake(nodeType, status, hasEvidence) {
    const artifacts = [];
    if (hasEvidence) {
      fs.writeFileSync(path.join(tmpDir, "evidence.txt"), "test output");
      artifacts.push({ type: "test-result", path: "evidence.txt" });
    }
    return validHandshake({ nodeType, status, artifacts });
  }

  // execute + completed needs evidence
  it("V626 — execute+completed WITHOUT evidence produces error", () => {
    const r = writeAndValidate(evidenceHandshake("execute", "completed", false));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("evidence")));
  });

  it("V627 — execute+completed WITH test-result evidence passes", () => {
    const r = writeAndValidate(evidenceHandshake("execute", "completed", true));
    assert.equal(r.valid, true);
  });

  it("V628 — execute+completed WITH screenshot evidence passes", () => {
    fs.writeFileSync(path.join(tmpDir, "screen.png"), "fake png");
    const r = writeAndValidate(validHandshake({
      nodeType: "execute",
      status: "completed",
      artifacts: [{ type: "screenshot", path: "screen.png" }],
    }));
    assert.equal(r.valid, true);
  });

  it("V629 — execute+completed WITH cli-output evidence passes", () => {
    fs.writeFileSync(path.join(tmpDir, "output.log"), "cli output");
    const r = writeAndValidate(validHandshake({
      nodeType: "execute",
      status: "completed",
      artifacts: [{ type: "cli-output", path: "output.log" }],
    }));
    assert.equal(r.valid, true);
  });

  it("V630 — execute+completed WITH non-evidence artifact type fails", () => {
    fs.writeFileSync(path.join(tmpDir, "doc.md"), "docs");
    const r = writeAndValidate(validHandshake({
      nodeType: "execute",
      status: "completed",
      artifacts: [{ type: "documentation", path: "doc.md" }],
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("evidence")));
  });

  // execute + failed does NOT need evidence
  it("V631 — execute+failed WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({
      nodeType: "execute",
      status: "failed",
      artifacts: [],
    }));
    assert.equal(r.valid, true);
  });

  it("V632 — execute+failed WITH evidence also passes", () => {
    const r = writeAndValidate(evidenceHandshake("execute", "failed", true));
    assert.equal(r.valid, true);
  });

  // execute + blocked does NOT need evidence
  it("V633 — execute+blocked WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({
      nodeType: "execute",
      status: "blocked",
      artifacts: [],
    }));
    assert.equal(r.valid, true);
  });

  // review + completed does NOT need evidence
  it("V634 — review+completed WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({
      nodeType: "review",
      status: "completed",
      artifacts: [],
    }));
    assert.equal(r.valid, true);
  });

  it("V635 — review+completed WITH evidence also passes", () => {
    const r = writeAndValidate(evidenceHandshake("review", "completed", true));
    assert.equal(r.valid, true);
  });

  // gate does NOT need evidence
  it("V636 — gate+completed WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({
      nodeType: "gate",
      status: "completed",
      artifacts: [],
    }));
    assert.equal(r.valid, true);
  });

  // build does NOT need evidence
  it("V637 — build+completed WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({
      nodeType: "build",
      status: "completed",
      artifacts: [],
    }));
    assert.equal(r.valid, true);
  });

  // discussion does NOT need evidence
  it("V638 — discussion+completed WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({
      nodeType: "discussion",
      status: "completed",
      artifacts: [],
    }));
    assert.equal(r.valid, true);
  });

  // Exhaustive nodeType x status x has_evidence matrix
  it("V639 — build+failed WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "build", status: "failed", artifacts: [] }));
    assert.equal(r.valid, true);
  });

  it("V640 — build+blocked WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "build", status: "blocked", artifacts: [] }));
    assert.equal(r.valid, true);
  });

  it("V641 — review+failed WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "review", status: "failed", artifacts: [] }));
    assert.equal(r.valid, true);
  });

  it("V642 — review+blocked WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "review", status: "blocked", artifacts: [] }));
    assert.equal(r.valid, true);
  });

  it("V643 — discussion+failed WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "discussion", status: "failed", artifacts: [] }));
    assert.equal(r.valid, true);
  });

  it("V644 — discussion+blocked WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "discussion", status: "blocked", artifacts: [] }));
    assert.equal(r.valid, true);
  });

  it("V645 — gate+failed WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "gate", status: "failed", artifacts: [] }));
    assert.equal(r.valid, true);
  });

  it("V646 — gate+blocked WITHOUT evidence passes", () => {
    const r = writeAndValidate(validHandshake({ nodeType: "gate", status: "blocked", artifacts: [] }));
    assert.equal(r.valid, true);
  });

  it("V647 — execute+completed with mixed evidence+non-evidence passes (evidence present)", () => {
    fs.writeFileSync(path.join(tmpDir, "ev.txt"), "ok");
    fs.writeFileSync(path.join(tmpDir, "doc.md"), "doc");
    const r = writeAndValidate(validHandshake({
      nodeType: "execute",
      status: "completed",
      artifacts: [
        { type: "documentation", path: "doc.md" },
        { type: "test-result", path: "ev.txt" },
      ],
    }));
    assert.equal(r.valid, true);
  });

  it("V648 — execute+completed with ONLY non-evidence artifacts fails", () => {
    fs.writeFileSync(path.join(tmpDir, "doc.md"), "doc");
    const r = writeAndValidate(validHandshake({
      nodeType: "execute",
      status: "completed",
      artifacts: [{ type: "documentation", path: "doc.md" }],
    }));
    assert.equal(r.valid, false);
  });

  it("V649 — execute+completed with multiple evidence types passes", () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "ok");
    fs.writeFileSync(path.join(tmpDir, "b.png"), "ok");
    const r = writeAndValidate(validHandshake({
      nodeType: "execute",
      status: "completed",
      artifacts: [
        { type: "test-result", path: "a.txt" },
        { type: "screenshot", path: "b.png" },
      ],
    }));
    assert.equal(r.valid, true);
  });

  it("V650 — execute+completed: evidence check only fires on 'execute' nodeType", () => {
    // 'build' with completed and no evidence should still pass
    const r = writeAndValidate(validHandshake({
      nodeType: "build",
      status: "completed",
      artifacts: [],
    }));
    assert.equal(r.valid, true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. CROSS-FIELD VALIDATION (V651-V675, 25 tests)
// ══════════════════════════════════════════════════════════════════

describe("5 — Cross-field validation", () => {
  beforeEach(setup);
  afterEach(teardown);

  // findings.critical > 0 with PASS → error
  it("V651 — critical>0 with PASS verdict produces error", () => {
    const r = writeAndValidate(validHandshake({
      verdict: "PASS",
      findings: { critical: 1, high: 0, medium: 0, low: 0 },
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("critical") && e.includes("PASS")));
  });

  it("V652 — critical=5 with PASS produces error", () => {
    const r = writeAndValidate(validHandshake({
      verdict: "PASS",
      findings: { critical: 5 },
    }));
    assert.equal(r.valid, false);
  });

  it("V653 — critical=1 with FAIL is ok", () => {
    const r = writeAndValidate(validHandshake({
      verdict: "FAIL",
      findings: { critical: 1, high: 0, medium: 0, low: 0 },
    }));
    assert.equal(r.valid, true);
  });

  it("V654 — critical=1 with ITERATE is ok", () => {
    const r = writeAndValidate(validHandshake({
      verdict: "ITERATE",
      findings: { critical: 1 },
    }));
    assert.equal(r.valid, true);
  });

  it("V655 — critical=1 with BLOCKED is ok", () => {
    const r = writeAndValidate(validHandshake({
      verdict: "BLOCKED",
      findings: { critical: 1 },
    }));
    assert.equal(r.valid, true);
  });

  it("V656 — critical=0 with PASS is ok", () => {
    const r = writeAndValidate(validHandshake({
      verdict: "PASS",
      findings: { critical: 0 },
    }));
    assert.equal(r.valid, true);
  });

  it("V657 — critical absent (undefined) with PASS is ok", () => {
    const r = writeAndValidate(validHandshake({
      verdict: "PASS",
      findings: { high: 2, medium: 1 },
    }));
    assert.equal(r.valid, true);
  });

  it("V658 — findings null does not trigger cross-field check", () => {
    const r = writeAndValidate(validHandshake({
      verdict: "PASS",
      findings: null,
    }));
    assert.equal(r.valid, true);
  });

  it("V659 — findings absent does not trigger cross-field check", () => {
    const hs = validHandshake({ verdict: "PASS" });
    delete hs.findings;
    const r = writeAndValidate(hs);
    assert.equal(r.valid, true);
  });

  it("V660 — critical=0 with FAIL is ok", () => {
    const r = writeAndValidate(validHandshake({
      verdict: "FAIL",
      findings: { critical: 0 },
    }));
    assert.equal(r.valid, true);
  });

  // Loopback validation
  it("V661 — loopback as object with required fields passes", () => {
    const r = writeAndValidate(validHandshake({
      loopback: { from: "gate-test", reason: "failing tests", iteration: 2 },
    }));
    assert.equal(r.valid, true);
  });

  it("V662 — loopback missing 'from' produces error", () => {
    const r = writeAndValidate(validHandshake({
      loopback: { reason: "failing tests", iteration: 2 },
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("loopback.from")));
  });

  it("V663 — loopback missing 'reason' produces error", () => {
    const r = writeAndValidate(validHandshake({
      loopback: { from: "gate-test", iteration: 2 },
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("loopback.reason")));
  });

  it("V664 — loopback missing 'iteration' produces error", () => {
    const r = writeAndValidate(validHandshake({
      loopback: { from: "gate-test", reason: "failing" },
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("loopback.iteration")));
  });

  it("V665 — loopback as non-object (string) produces error", () => {
    const r = writeAndValidate(validHandshake({ loopback: "gate-test" }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("loopback must be an object")));
  });

  it("V666 — loopback as number produces error", () => {
    const r = writeAndValidate(validHandshake({ loopback: 42 }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("loopback must be an object")));
  });

  it("V667 — loopback as boolean produces error", () => {
    const r = writeAndValidate(validHandshake({ loopback: true }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("loopback must be an object")));
  });

  it("V668 — loopback as array produces error", () => {
    const r = writeAndValidate(validHandshake({ loopback: [1, 2] }));
    assert.equal(r.valid, false);
    // arrays are typeof "object" so it won't say "must be an object" —
    // it will complain about missing fields
    assert.ok(r.errors.length > 0);
  });

  it("V669 — loopback iteration as string produces error", () => {
    const r = writeAndValidate(validHandshake({
      loopback: { from: "gate-test", reason: "failing", iteration: "two" },
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("loopback.iteration")));
  });

  it("V670 — loopback null does not trigger loopback validation", () => {
    const r = writeAndValidate(validHandshake({ loopback: null }));
    assert.equal(r.valid, true);
  });

  it("V671 — loopback undefined (absent) does not trigger validation", () => {
    const hs = validHandshake();
    delete hs.loopback;
    const r = writeAndValidate(hs);
    assert.equal(r.valid, true);
  });

  it("V672 — critical>0 + PASS + loopback = multiple errors", () => {
    const r = writeAndValidate(validHandshake({
      verdict: "PASS",
      findings: { critical: 2 },
      loopback: "bad",
    }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.length >= 2);
  });

  it("V673 — findings as array does not trigger critical check", () => {
    // findings is checked with typeof === "object" && not null, arrays pass this
    const r = writeAndValidate(validHandshake({
      verdict: "PASS",
      findings: [{ critical: 1 }],
    }));
    // Array has no .critical property, so (undefined || 0) > 0 is false -> no error
    assert.equal(r.valid, true);
  });

  it("V674 — verdict null does not trigger invalid verdict error", () => {
    const r = writeAndValidate(validHandshake({ verdict: null }));
    // verdict != null is false for null, so no verdict check
    assert.equal(r.valid, true);
  });

  it("V675 — verdict undefined does not trigger invalid verdict error", () => {
    const hs = validHandshake();
    delete hs.verdict;
    const r = writeAndValidate(hs);
    assert.equal(r.valid, true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. MALFORMED JSON (V676-V700, 25 tests)
// ══════════════════════════════════════════════════════════════════

describe("6 — Malformed JSON", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("V676 — truncated JSON produces parse error", () => {
    const r = writeRawAndValidate('{"nodeId": "build"');
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("cannot read/parse")));
  });

  it("V677 — extra trailing comma produces parse error", () => {
    const r = writeRawAndValidate('{"nodeId": "build",}');
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("cannot read/parse")));
  });

  it("V678 — single quotes instead of double quotes produces parse error", () => {
    const r = writeRawAndValidate("{'nodeId': 'build'}");
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("cannot read/parse")));
  });

  it("V679 — unicode escape sequences are valid JSON", () => {
    const r = writeRawAndValidate(JSON.stringify(validHandshake({ nodeId: "build-\\u0031" })));
    // This should parse fine (nodeId = "build-\u0031" = "build-1")
    assert.equal(r.valid, true);
  });

  it("V680 — deeply nested objects parse correctly", () => {
    const hs = validHandshake({
      meta: { a: { b: { c: { d: { e: "deep" } } } } },
    });
    const r = writeAndValidate(hs);
    assert.equal(r.valid, true);
  });

  it("V681 — array where object expected at top level", () => {
    const r = writeRawAndValidate('[{"nodeId": "build"}]');
    assert.equal(r.valid, false);
    // Array doesn't have string fields, so all required fields will be "missing"
    assert.ok(r.errors.length > 0);
  });

  it("V682 — empty object", () => {
    const r = writeRawAndValidate("{}");
    assert.equal(r.valid, false);
    assert.ok(r.errors.length >= 6); // all required fields missing
  });

  it("V683 — empty string file produces parse error", () => {
    const r = writeRawAndValidate("");
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("cannot read/parse")));
  });

  it("V684 — just whitespace produces parse error", () => {
    const r = writeRawAndValidate("   \n\t  ");
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("cannot read/parse")));
  });

  it("V685 — null literal at top level throws (known edge case: data is null)", () => {
    // JSON.parse("null") returns null; cmdValidate crashes accessing null.nodeId
    // This documents the behavior — null top-level is not handled gracefully
    const filePath = path.join(tmpDir, "handshake.json");
    fs.writeFileSync(filePath, "null");
    captured.stdout = [];
    assert.throws(() => cmdValidate([filePath]), TypeError);
  });

  it("V686 — number literal at top level", () => {
    const r = writeRawAndValidate("42");
    assert.equal(r.valid, false);
  });

  it("V687 — string literal at top level", () => {
    const r = writeRawAndValidate('"hello"');
    assert.equal(r.valid, false);
  });

  it("V688 — boolean literal at top level", () => {
    const r = writeRawAndValidate("true");
    assert.equal(r.valid, false);
  });

  it("V689 — JSON with BOM character parses (or error is clear)", () => {
    const bom = "\uFEFF";
    const r = writeRawAndValidate(bom + JSON.stringify(validHandshake()));
    // JSON.parse handles BOM in some runtimes, may fail in others
    // Either way, result should have valid/errors structure
    assert.ok(r !== null);
    assert.ok(typeof r.valid === "boolean");
  });

  it("V690 — JSON with comments produces parse error", () => {
    const r = writeRawAndValidate('{\n  // comment\n  "nodeId": "build"\n}');
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("cannot read/parse")));
  });

  it("V691 — JSON with trailing data produces parse error", () => {
    const r = writeRawAndValidate('{"nodeId": "build"} extra');
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("cannot read/parse")));
  });

  it("V692 — non-existent file produces parse error", () => {
    captured.stdout = [];
    cmdValidate([path.join(tmpDir, "nonexistent.json")]);
    const r = out();
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("cannot read/parse")));
  });

  it("V693 — binary garbage file produces parse error", () => {
    const filePath = path.join(tmpDir, "garbage.json");
    fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]));
    captured.stdout = [];
    cmdValidate([filePath]);
    const r = out();
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("cannot read/parse")));
  });

  it("V694 — extremely large JSON key", () => {
    const bigKey = "x".repeat(10000);
    const hs = validHandshake();
    hs[bigKey] = "value";
    const r = writeAndValidate(hs);
    // Extra keys don't cause errors; required fields are present
    assert.equal(r.valid, true);
  });

  it("V695 — extremely long string value in nodeId", () => {
    const r = writeAndValidate(validHandshake({ nodeId: "a".repeat(100000) }));
    assert.equal(r.valid, true); // It's a non-empty string, passes type check
  });

  it("V696 — duplicate keys in JSON (last wins in JS)", () => {
    // JSON spec says behavior undefined; Node's JSON.parse takes last value
    const raw = '{"nodeId":"first","nodeId":"build","nodeType":"build","runId":"run_1","status":"completed","summary":"ok","timestamp":"2026-04-10T00:00:00Z","artifacts":[],"verdict":"PASS"}';
    const r = writeRawAndValidate(raw);
    assert.equal(r.valid, true); // last nodeId="build" is used
  });

  it("V697 — JSON with escaped unicode in value", () => {
    const r = writeAndValidate(validHandshake({ summary: "测试\\u0041成功" }));
    assert.equal(r.valid, true);
  });

  it("V698 — JSON with newlines in string values (escaped)", () => {
    const r = writeAndValidate(validHandshake({ summary: "line1\\nline2" }));
    assert.equal(r.valid, true);
  });

  it("V699 — JSON with tab characters in string values (escaped)", () => {
    const r = writeAndValidate(validHandshake({ summary: "col1\\tcol2" }));
    assert.equal(r.valid, true);
  });

  it("V700 — valid JSON with all optional fields present", () => {
    fs.writeFileSync(path.join(tmpDir, "ev.txt"), "evidence");
    const r = writeAndValidate(validHandshake({
      nodeType: "execute",
      status: "completed",
      verdict: "PASS",
      findings: { critical: 0, high: 1, medium: 2, low: 5 },
      loopback: null,
      artifacts: [{ type: "test-result", path: "ev.txt" }],
      meta: { extra: "data" },
    }));
    assert.equal(r.valid, true);
    assert.equal(r.errors.length, 0);
  });
});
