// driver-owner.test.mjs — Node.js built-in test runner
// Run: node --test bin/lib/driver-owner.test.mjs
//
// Covers session-ownership discrimination, with emphasis on the PID-reuse guard
// (Hole 2): a recycled dead-owner PID must NOT produce a permanent false BLOCKED.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isPidAlive,
  psStartTime,
  makeOwner,
  resolveCallerIdentity,
  checkOwnership,
  ownershipEnforcementWarning,
} from "./driver-owner.mjs";

const HOST = "testhost";
// A PID that is essentially certain not to exist. Above the typical pid_max on
// macOS/Linux, and not 0/1.
const DEAD_PID = 2147483646;

// Helpers to build owner/caller identity records without touching real Claude.
function owner({ pid, start, host = HOST, token = "tok" }) {
  return { token, claude_pid: pid, claude_started_at: start ?? null, host, claimed_at: "2026-01-01T00:00:00Z" };
}
function caller({ pid, start, host = HOST }) {
  return { claude_pid: pid, claude_started_at: start ?? null, host };
}

describe("isPidAlive", () => {
  test("own process is alive", () => {
    assert.equal(isPidAlive(process.pid), true);
  });
  test("pid 1 / invalid → not alive (guarded)", () => {
    assert.equal(isPidAlive(1), false);
    assert.equal(isPidAlive(-5), false);
    assert.equal(isPidAlive("nope"), false);
  });
  test("unused high pid → not alive", () => {
    assert.equal(isPidAlive(DEAD_PID), false);
  });
});

describe("psStartTime", () => {
  test("own process yields a non-empty start-time string", () => {
    const s = psStartTime(process.pid);
    assert.equal(typeof s, "string");
    assert.ok(s.length > 0);
  });
  test("stable across calls for the same live process", () => {
    assert.equal(psStartTime(process.pid), psStartTime(process.pid));
  });
  test("invalid pid → null", () => {
    assert.equal(psStartTime(1), null);
    assert.equal(psStartTime(-1), null);
  });
  test("dead pid → null", () => {
    assert.equal(psStartTime(DEAD_PID), null);
  });
});

describe("resolveCallerIdentity", () => {
  test("returns host and (pid, start) shape", () => {
    const id = resolveCallerIdentity();
    assert.ok("claude_pid" in id);
    assert.ok("claude_started_at" in id);
    assert.equal(typeof id.host, "string");
    // When a claude_pid is resolvable its start-time is populated; when not,
    // both are null. They must be consistent.
    if (id.claude_pid == null) assert.equal(id.claude_started_at, null);
  });
});

describe("makeOwner", () => {
  test("carries pid, start-time, host, token, claimed_at", () => {
    const o = makeOwner({ claude_pid: 42, claude_started_at: "S", host: HOST }, "mytoken");
    assert.equal(o.claude_pid, 42);
    assert.equal(o.claude_started_at, "S");
    assert.equal(o.host, HOST);
    assert.equal(o.token, "mytoken");
    assert.equal(typeof o.claimed_at, "string");
  });
  test("missing start-time defaults to null", () => {
    const o = makeOwner({ claude_pid: 42, host: HOST }, "t");
    assert.equal(o.claude_started_at, null);
  });
});

describe("checkOwnership — baseline", () => {
  test("legacy loop (no _owner) → OWNER", () => {
    assert.equal(checkOwnership({}, caller({ pid: process.pid, start: "x" })).decision, "OWNER");
  });
  test("owner live but caller pid unresolvable → BLOCKED (fail closed)", () => {
    const state = { _owner: owner({ pid: process.pid, start: psStartTime(process.pid) }) };
    assert.equal(checkOwnership(state, caller({ pid: null })).decision, "BLOCKED");
  });
  test("owner live, caller pid unresolvable, --force → TAKEOVER", () => {
    const state = { _owner: owner({ pid: process.pid, start: psStartTime(process.pid) }) };
    assert.equal(checkOwnership(state, caller({ pid: null }), { force: true }).decision, "TAKEOVER");
  });
  test("owner dead, caller pid unresolvable → OWNER (not provably live)", () => {
    const state = { _owner: owner({ pid: DEAD_PID, start: "old" }) };
    assert.equal(checkOwnership(state, caller({ pid: null })).decision, "OWNER");
  });
  test("same pid + same start-time → OWNER (caller is the owning session)", () => {
    const start = psStartTime(process.pid);
    const state = { _owner: owner({ pid: process.pid, start }) };
    const res = checkOwnership(state, caller({ pid: process.pid, start }));
    assert.equal(res.decision, "OWNER");
  });
});

describe("checkOwnership — live foreign owner is BLOCKED", () => {
  test("different pid, owner instance alive → BLOCKED", () => {
    const start = psStartTime(process.pid); // real → owner instance is live
    const state = { _owner: owner({ pid: process.pid, start }) };
    const res = checkOwnership(state, caller({ pid: process.pid + 1000000, start: "other" }));
    assert.equal(res.decision, "BLOCKED");
    assert.ok(res.owner);
  });
  test("--force overrides a live foreign owner → TAKEOVER", () => {
    const start = psStartTime(process.pid);
    const state = { _owner: owner({ pid: process.pid, start }) };
    const res = checkOwnership(state, caller({ pid: process.pid + 1000000, start: "other" }), { force: true });
    assert.equal(res.decision, "TAKEOVER");
    assert.match(res.reason, /forced/);
  });
});

describe("checkOwnership — dead owner is reclaimable", () => {
  test("owner pid dead → TAKEOVER", () => {
    const state = { _owner: owner({ pid: DEAD_PID, start: "Mon Jan  1 00:00:00 2020" }) };
    const res = checkOwnership(state, caller({ pid: process.pid, start: psStartTime(process.pid) }));
    assert.equal(res.decision, "TAKEOVER");
  });
  test("token match is surfaced in the reclaim reason", () => {
    const state = { _owner: owner({ pid: DEAD_PID, start: "old", token: "abc" }) };
    const res = checkOwnership(state, caller({ pid: process.pid, start: "x" }), { callerToken: "abc" });
    assert.equal(res.decision, "TAKEOVER");
    assert.match(res.reason, /holds the loop token/);
  });
});

describe("checkOwnership — PID reuse guard (Hole 2)", () => {
  // The owner recorded a PID that is currently ALIVE, but the recorded start
  // time does NOT match the live process at that PID → the original owner
  // instance is gone and the PID was recycled. Pre-fix this returned BLOCKED
  // (pure isPidAlive); the fix must return TAKEOVER.
  test("alive PID but stale start-time → TAKEOVER (not a false BLOCKED)", () => {
    const state = { _owner: owner({ pid: process.pid, start: "Sat Jan  1 00:00:00 2000" }) };
    // Caller is a different session so we don't short-circuit on samePid.
    const res = checkOwnership(state, caller({ pid: process.pid + 1000000, start: "fresh" }));
    assert.equal(res.decision, "TAKEOVER");
  });

  test("caller reused owner's dead PID (samePid, start-time mismatch) → TAKEOVER", () => {
    // owner pid == caller pid, but owner's recorded start-time is stale, so the
    // caller is a NEW process that happened to get the same PID.
    const state = { _owner: owner({ pid: process.pid, start: "Sat Jan  1 00:00:00 2000" }) };
    const res = checkOwnership(state, caller({ pid: process.pid, start: psStartTime(process.pid) }));
    assert.equal(res.decision, "TAKEOVER");
  });
});

describe("checkOwnership — legacy stamp fallback (no start-time)", () => {
  // Owner stamped before the start-time field existed. Liveness must degrade to
  // PID-only so we neither over-block nor crash.
  test("legacy owner, alive pid, foreign caller → BLOCKED (PID-only)", () => {
    const state = { _owner: owner({ pid: process.pid, start: null }) };
    const res = checkOwnership(state, caller({ pid: process.pid + 1000000, start: "x" }));
    assert.equal(res.decision, "BLOCKED");
  });
  test("legacy owner, dead pid → TAKEOVER", () => {
    const state = { _owner: owner({ pid: DEAD_PID, start: null }) };
    const res = checkOwnership(state, caller({ pid: process.pid, start: "x" }));
    assert.equal(res.decision, "TAKEOVER");
  });
  test("legacy owner, same pid → OWNER (start-time unknown, PID-only match)", () => {
    const state = { _owner: owner({ pid: process.pid, start: null }) };
    const res = checkOwnership(state, caller({ pid: process.pid, start: "whatever" }));
    assert.equal(res.decision, "OWNER");
  });
});

describe("ownershipEnforcementWarning — degraded-mode detection (Hole 3)", () => {
  test("caller with a resolvable pid → no warning", () => {
    assert.equal(ownershipEnforcementWarning(caller({ pid: process.pid, start: "x" })), null);
  });
  test("caller with null pid → warning surfaced", () => {
    const w = ownershipEnforcementWarning(caller({ pid: null }));
    assert.equal(typeof w, "string");
    assert.match(w, /degraded/);
  });
  test("missing/undefined caller → warning (defensive)", () => {
    assert.match(ownershipEnforcementWarning(undefined), /degraded/);
  });
});
