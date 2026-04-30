// util.test.mjs — Node.js built-in test runner
// Run: node --test bin/lib/util.test.mjs

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readlinkSync, existsSync, rmSync, readdirSync, utimesSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import {
  getFlag,
  atomicWriteSync,
  VALID_NODE_TYPES,
  VALID_STATUSES,
  VALID_VERDICTS,
  EVIDENCE_TYPES,
  VALID_LOOP_STATUSES,
  TERMINAL_LOOP_STATUSES,
  WRITER_SIG,
  IDEMPOTENCY_WINDOW_MS,
  getProjectHash,
  createSessionId,
  getSessionsBaseDir,
  createSessionDir,
  getLatestSessionDir,
  gcSessions,
  cmdGc,
  resolveDirReadOnly,
} from "./util.mjs";

function makeTmpDir() {
  const dir = join(tmpdir(), `opc-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── getFlag ────────────────────────────────────────────────────────

describe("getFlag", () => {
  test("extracts flag value", () => {
    assert.equal(getFlag(["--dir", "/tmp/foo"], "dir"), "/tmp/foo");
  });

  test("returns fallback when flag missing", () => {
    assert.equal(getFlag(["--other", "val"], "dir"), null);
  });

  test("returns explicit fallback when flag missing", () => {
    assert.equal(getFlag([], "dir", "default"), "default");
  });

  test("returns fallback when flag is last arg (no value)", () => {
    assert.equal(getFlag(["--dir"], "dir", "fb"), "fb");
  });

  test("returns first occurrence", () => {
    assert.equal(getFlag(["--dir", "a", "--dir", "b"], "dir"), "a");
  });
});

// ── atomicWriteSync ────────────────────────────────────────────────

describe("atomicWriteSync", () => {
  let tmp;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("writes file with correct content", () => {
    const p = join(tmp, "out.json");
    atomicWriteSync(p, '{"ok":true}');
    assert.equal(existsSync(p), true);
    assert.equal(readFileSync(p, "utf8"), '{"ok":true}');
  });

  test("no leftover tmp files", () => {
    const p = join(tmp, "clean.txt");
    atomicWriteSync(p, "data");
    const files = readdirSync(tmp);
    assert.equal(files.length, 1);
    assert.equal(files[0], "clean.txt");
  });
});

// ── Constants ──────────────────────────────────────────────────────

describe("constants", () => {
  test("VALID_NODE_TYPES", () => {
    assert.deepEqual([...VALID_NODE_TYPES].sort(), ["build", "discussion", "execute", "gate", "review"]);
  });

  test("VALID_STATUSES", () => {
    assert.deepEqual([...VALID_STATUSES].sort(), ["blocked", "completed", "failed"]);
  });

  test("VALID_VERDICTS", () => {
    assert.deepEqual([...VALID_VERDICTS].sort(), ["BLOCKED", "FAIL", "ITERATE", "PASS"]);
  });

  test("EVIDENCE_TYPES", () => {
    assert.deepEqual([...EVIDENCE_TYPES].sort(), ["cli-output", "screenshot", "test-result"]);
  });

  test("VALID_LOOP_STATUSES", () => {
    assert.deepEqual([...VALID_LOOP_STATUSES].sort(), ["in_progress", "initialized", "pipeline_complete", "stalled", "terminated"]);
  });

  test("TERMINAL_LOOP_STATUSES is subset of VALID_LOOP_STATUSES", () => {
    for (const s of TERMINAL_LOOP_STATUSES) {
      assert.equal(VALID_LOOP_STATUSES.has(s), true, `${s} should be in VALID_LOOP_STATUSES`);
    }
  });

  test("TERMINAL_LOOP_STATUSES contents", () => {
    assert.deepEqual([...TERMINAL_LOOP_STATUSES].sort(), ["pipeline_complete", "stalled", "terminated"]);
  });

  test("WRITER_SIG", () => {
    assert.equal(WRITER_SIG, "opc-harness");
  });

  test("IDEMPOTENCY_WINDOW_MS", () => {
    assert.equal(IDEMPOTENCY_WINDOW_MS, 5000);
  });
});

// ── getProjectHash ─────────────────────────────────────────────────

describe("getProjectHash", () => {
  test("returns 12-char hex string", () => {
    const hash = getProjectHash();
    assert.match(hash, /^[0-9a-f]{12}$/);
  });

  test("same cwd produces same hash", () => {
    assert.equal(getProjectHash("/tmp"), getProjectHash("/tmp"));
  });

  test("different cwd produces different hash", () => {
    assert.notEqual(getProjectHash("/tmp/a"), getProjectHash("/tmp/b"));
  });
});

// ── createSessionId ────────────────────────────────────────────────

describe("createSessionId", () => {
  test("format: base36 timestamp + dash + 8-char hex", () => {
    const id = createSessionId();
    const [ts, rand] = id.split("-");
    assert.ok(ts.length > 0, "timestamp part exists");
    assert.match(rand, /^[0-9a-f]{8}$/, "random part is 8-char hex");
    // Timestamp should parse back to a reasonable epoch
    const epoch = parseInt(ts, 36);
    assert.ok(epoch > 1_700_000_000_000, "timestamp is recent");
  });

  test("two calls produce different ids", () => {
    assert.notEqual(createSessionId(), createSessionId());
  });
});

// ── getSessionsBaseDir ─────────────────────────────────────────────

describe("getSessionsBaseDir", () => {
  test("returns path under ~/.opc/sessions/", () => {
    const dir = getSessionsBaseDir();
    assert.ok(dir.includes("/.opc/sessions/"));
  });

  test("ends with project hash", () => {
    const dir = getSessionsBaseDir();
    const hash = getProjectHash();
    assert.ok(dir.endsWith(hash));
  });
});

// ── createSessionDir & getLatestSessionDir ─────────────────────────

describe("createSessionDir / getLatestSessionDir", () => {
  let tmp;
  let origHome;

  beforeEach(() => {
    tmp = makeTmpDir();
    origHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("creates directory and latest symlink", () => {
    const dir = createSessionDir();
    assert.ok(existsSync(dir), "session dir exists");
    const base = getSessionsBaseDir();
    const latestLink = join(base, "latest");
    assert.ok(existsSync(latestLink), "latest symlink exists");
    const target = readlinkSync(latestLink);
    // symlink target is relative session id
    assert.ok(dir.endsWith(target), "symlink points to session dir");
  });

  test("getLatestSessionDir returns null when no sessions", () => {
    // With a fresh HOME, no sessions exist — but getLatestSessionDir
    // needs flow-state.json to return the dir
    assert.equal(getLatestSessionDir(), null);
  });

  test("getLatestSessionDir returns dir when flow-state.json exists", () => {
    const dir = createSessionDir();
    writeFileSync(join(dir, "flow-state.json"), "{}");
    const latest = getLatestSessionDir();
    assert.equal(latest, dir);
  });
});

// ── gcSessions ─────────────────────────────────────────────────────

describe("gcSessions", () => {
  let tmp;
  let origHome;

  beforeEach(() => {
    tmp = makeTmpDir();
    origHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns empty when no sessions base exists", () => {
    const result = gcSessions("/nonexistent/path/xyz");
    assert.deepEqual(result, { deleted: [], errors: [] });
  });

  test("deletes old sessions, keeps new ones", () => {
    // Create a "new" session first to establish the base dir
    const newDir = createSessionDir();
    writeFileSync(join(newDir, "flow-state.json"), "{}");

    // Manually create an "old" session in the same base
    const base = getSessionsBaseDir();
    const oldDir = join(base, "old-session");
    mkdirSync(oldDir, { recursive: true });
    const oldFlowState = join(oldDir, "flow-state.json");
    writeFileSync(oldFlowState, "{}");
    // Backdate mtime to 30 days ago
    const past = new Date(Date.now() - 30 * 86400_000);
    utimesSync(oldFlowState, past, past);

    const result = gcSessions();
    assert.ok(result.deleted.includes("old-session"), "old session deleted");
    assert.ok(!existsSync(oldDir), "old dir removed");
    assert.ok(existsSync(newDir), "new session kept");
  });
});

// ── cmdGc ──────────────────────────────────────────────────────────

describe("cmdGc", () => {
  let tmp;
  let origHome;
  let origLog;
  let captured;

  beforeEach(() => {
    tmp = makeTmpDir();
    origHome = process.env.HOME;
    process.env.HOME = tmp;
    origLog = console.log;
    captured = [];
    console.log = (...a) => captured.push(a.join(" "));
  });

  afterEach(() => {
    process.env.HOME = origHome;
    console.log = origLog;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("outputs valid JSON", () => {
    cmdGc([]);
    assert.equal(captured.length, 1);
    const parsed = JSON.parse(captured[0]);
    assert.ok(Array.isArray(parsed.deleted));
    assert.ok(Array.isArray(parsed.errors));
  });
});

// ── resolveDirReadOnly ─────────────────────────────────────────────

describe("resolveDirReadOnly", () => {
  test("returns --dir value when provided", () => {
    assert.equal(resolveDirReadOnly(["--dir", "/some/path"]), "/some/path");
  });

  test("returns fallback when no --dir and no sessions", () => {
    // Override HOME so no sessions are found
    const origHome = process.env.HOME;
    const tmp = makeTmpDir();
    process.env.HOME = tmp;
    try {
      const result = resolveDirReadOnly([]);
      assert.equal(result, ".harness");
    } finally {
      process.env.HOME = origHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns custom fallback", () => {
    const origHome = process.env.HOME;
    const tmp = makeTmpDir();
    process.env.HOME = tmp;
    try {
      assert.equal(resolveDirReadOnly([], "custom"), "custom");
    } finally {
      process.env.HOME = origHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
