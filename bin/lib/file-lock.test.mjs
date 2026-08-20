import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lockFile } from "./file-lock.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opc-file-lock-"));
  roots.push(root);
  const target = join(root, "state.json");
  return { target, lockPath: `${target}.lock` };
}

test("fresh unreadable lock is treated as busy instead of deleted", () => {
  const { target, lockPath } = fixture();
  writeFileSync(lockPath, "{");

  const lock = lockFile(target, { timeout: 0, command: "contender" });

  assert.equal(lock.acquired, false);
  assert.equal(existsSync(lockPath), true);
  assert.equal(readFileSync(lockPath, "utf8"), "{");
});

test("fresh unreadable lock waits but remains fail-closed", () => {
  const { target, lockPath } = fixture();
  writeFileSync(lockPath, "{");

  const started = Date.now();
  const lock = lockFile(target, { timeout: 60, command: "waiting-contender" });

  assert.equal(lock.acquired, false);
  assert.ok(Date.now() - started >= 50);
  assert.equal(existsSync(lockPath), true);
});

test("a disappearing unreadable lock is retried without deletion", () => {
  const { target, lockPath } = fixture();
  writeFileSync(lockPath, "{");
  const originalStatSync = fs.statSync;
  let first = true;
  fs.statSync = (...args) => {
    if (first) {
      first = false;
      const error = new Error("lock disappeared");
      error.code = "ENOENT";
      throw error;
    }
    return originalStatSync(...args);
  };
  syncBuiltinESMExports();
  try {
    const lock = lockFile(target, { timeout: 0, command: "racing-contender" });
    assert.equal(lock.acquired, false);
    assert.equal(existsSync(lockPath), true);
  } finally {
    fs.statSync = originalStatSync;
    syncBuiltinESMExports();
  }
});

test("lock publication errors fail closed and clean temporary files", () => {
  const { target } = fixture();
  const originalLinkSync = fs.linkSync;
  fs.linkSync = () => {
    const error = new Error("publication denied");
    error.code = "EPERM";
    throw error;
  };
  syncBuiltinESMExports();
  try {
    const lock = lockFile(target, { timeout: 0, command: "publisher" });
    assert.equal(lock.acquired, false);
    assert.deepEqual(fs.readdirSync(dirname(target)), []);
  } finally {
    fs.linkSync = originalLinkSync;
    syncBuiltinESMExports();
  }
});

test("a competing atomic publication reports an unknown holder when unreadable", () => {
  const { target } = fixture();
  const originalLinkSync = fs.linkSync;
  fs.linkSync = () => {
    const error = new Error("already published");
    error.code = "EEXIST";
    throw error;
  };
  syncBuiltinESMExports();
  try {
    const lock = lockFile(target, { timeout: 0, command: "publisher" });
    assert.equal(lock.acquired, false);
    assert.equal(lock.holder.command, "unknown");
  } finally {
    fs.linkSync = originalLinkSync;
    syncBuiltinESMExports();
  }
});

test("old unreadable lock is removed as stale", () => {
  const { target, lockPath } = fixture();
  writeFileSync(lockPath, "{");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);

  const lock = lockFile(target, { timeout: 0, command: "replacement" });

  assert.equal(lock.acquired, true);
  assert.doesNotThrow(() => JSON.parse(readFileSync(lockPath, "utf8")));
  lock.release();
  assert.equal(existsSync(lockPath), false);
});
