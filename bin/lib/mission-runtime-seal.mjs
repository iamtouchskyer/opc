// Crash-safe, HMAC-ledger-backed sealing for Mission-enabled runtime state.
//
// The active state file and the append-only provenance ledger cannot be
// replaced in one filesystem operation.  We therefore use a small durable
// transaction:
//   1. stage the complete next state,
//   2. append a signed PREPARE event,
//   3. atomically replace the active state,
//   4. append a signed COMMIT event, and
//   5. remove the stage.
// Validation completes an interrupted transaction instead of treating a
// newer signed event as an ignorable orphan (which would permit rollback).

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "fs";
import { createHash, randomBytes } from "crypto";
import { basename, dirname, join, resolve } from "path";
import { atomicWriteSync } from "./util.mjs";
import { lockFile } from "./file-lock.mjs";
import { appendProvenanceEvent, findProvenanceEvent } from "./provenance-ledger.mjs";

const SEAL_FIELD = "_missionRuntimeSeal";
const LEDGER_NAME = ".opc-provenance.jsonl";
const FLOW_STATE = "flow-state.json";
const LOOP_STATE = "loop-state.json";
const PREPARE_TYPE = "mission_runtime_state_prepared";
const COMMIT_TYPE = "mission_runtime_state_committed";
const SHA256_RE = /^[a-f0-9]{64}$/;
const SEAL_ID_RE = /^MRS-[a-f0-9]{32}$/;

function sha256(value) {
  return createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8"))
    .digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stateFileName(state) {
  return Object.hasOwn(state || {}, "tick") ||
      Object.hasOwn(state || {}, "next_unit") ||
      Object.hasOwn(state || {}, "plan_file")
    ? LOOP_STATE
    : FLOW_STATE;
}

function canonicalSessionDir(sessionDir) {
  return realpathSync(resolve(sessionDir));
}

function resolveStatePath(sessionDir, state, statePath = null) {
  const name = statePath ? basename(resolve(statePath)) : stateFileName(state);
  if (!new Set([FLOW_STATE, LOOP_STATE]).has(name)) {
    throw new Error(`Mission runtime state path must be ${FLOW_STATE} or ${LOOP_STATE}`);
  }
  const expected = join(sessionDir, name);
  if (statePath) {
    let suppliedParent;
    try {
      suppliedParent = realpathSync(dirname(resolve(statePath)));
    } catch {
      suppliedParent = resolve(dirname(resolve(statePath)));
    }
    if (suppliedParent !== sessionDir) {
      throw new Error("Mission runtime state path must be directly inside the canonical session");
    }
  }
  return expected;
}

function stagePathFor(statePath) {
  return `${statePath}.mission-runtime-stage`;
}

function sealLockPath(sessionDir, statePath) {
  return join(sessionDir, `.mission-runtime-${basename(statePath)}`);
}

/** The entire serialized state is authoritative except for its self-seal. */
export function missionRuntimeStateDigest(state) {
  const normalized = jsonClone(state || {});
  delete normalized[SEAL_FIELD];
  return sha256(canonical(normalized));
}

function serializedState(state) {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function parseJsonBytes(bytes, label) {
  try {
    return { ok: true, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    return { ok: false, error: `${label} is not valid JSON: ${error.message}` };
  }
}

function readRegularFile(path, label) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { ok: false, error: `${label} must be a regular, non-symlink file` };
    }
    return { ok: true, bytes: readFileSync(path) };
  } catch (error) {
    return { ok: false, error: `${label} is unreadable: ${error.message}` };
  }
}

function validPrepareEvent(event) {
  return event?.type === PREPARE_TYPE &&
    event.schemaVersion === 1 &&
    SEAL_ID_RE.test(event.sealId || "") &&
    Number.isInteger(event.generation) && event.generation >= 1 &&
    (event.previousSealId === null || SEAL_ID_RE.test(event.previousSealId || "")) &&
    SHA256_RE.test(event.authoritativeStateSha256 || "") &&
    SHA256_RE.test(event.serializedStateSha256 || "") &&
    new Set([FLOW_STATE, LOOP_STATE]).has(event.stateFile);
}

/**
 * Read and authenticate the full ledger, then derive the latest committed and
 * (at most one) prepared Mission runtime seal.  Calling findProvenanceEvent on
 * the final record authenticates every preceding record in the HMAC chain.
 */
function inspectRuntimeLedger(sessionDir, stateFile) {
  const path = join(sessionDir, LEDGER_NAME);
  if (!existsSync(path)) return { ok: true, committed: null, pending: null, hasAuthority: false };
  const file = readRegularFile(path, "Mission provenance ledger");
  if (!file.ok) return file;
  const lines = file.bytes.toString("utf8").split(/\n/).filter(Boolean);
  if (lines.length === 0) return { ok: true, committed: null, pending: null, hasAuthority: false };
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      return { ok: false, error: "Mission provenance ledger is corrupt" };
    }
  }
  const recordHashes = records.map(record => record?.recordHash);
  if (recordHashes.some(hash => !SHA256_RE.test(hash || "")) ||
      new Set(recordHashes).size !== recordHashes.length) {
    return { ok: false, error: "Mission provenance ledger has invalid or duplicate record hashes" };
  }
  const lastHash = records.at(-1)?.recordHash;
  const authenticated = findProvenanceEvent(sessionDir, lastHash);
  if (!authenticated.ok) {
    return { ok: false, error: `Mission provenance ledger is invalid: ${authenticated.error}` };
  }

  let committed = null;
  let pending = null;
  let hasAuthority = false;
  for (const record of records) {
    if (record.type === PREPARE_TYPE && record.stateFile === stateFile) {
      hasAuthority = true;
      if (!validPrepareEvent(record)) {
        return { ok: false, error: "Mission runtime PREPARE event is invalid" };
      }
      if (pending) {
        return { ok: false, error: "Mission runtime ledger contains overlapping PREPARE events" };
      }
      const expectedGeneration = (committed?.event?.generation || 0) + 1;
      const expectedPrevious = committed?.event?.sealId || null;
      if (record.generation !== expectedGeneration || record.previousSealId !== expectedPrevious) {
        return { ok: false, error: "Mission runtime seal generation chain is invalid" };
      }
      pending = { event: record, prepareRecordHash: record.recordHash };
      continue;
    }
    if (record.type === COMMIT_TYPE && record.stateFile === stateFile) {
      hasAuthority = true;
      if (!pending || record.schemaVersion !== 1 ||
          record.sealId !== pending.event.sealId ||
          record.prepareRecordHash !== pending.prepareRecordHash ||
          record.authoritativeStateSha256 !== pending.event.authoritativeStateSha256) {
        return { ok: false, error: "Mission runtime COMMIT event does not match its PREPARE" };
      }
      committed = pending;
      pending = null;
    }
  }
  return { ok: true, committed, pending, hasAuthority };
}

function stateMatchesPrepare(state, prepared) {
  if (!state || !prepared) return false;
  const seal = state[SEAL_FIELD];
  const event = prepared.event;
  return seal?.schemaVersion === 1 &&
    seal.sealId === event.sealId &&
    seal.generation === event.generation &&
    (seal.previousSealId ?? null) === event.previousSealId &&
    seal.authoritativeStateSha256 === event.authoritativeStateSha256 &&
    missionRuntimeStateDigest(state) === event.authoritativeStateSha256 &&
    sha256(serializedState(state)) === event.serializedStateSha256;
}

function readActiveState(statePath) {
  if (!existsSync(statePath)) return { ok: true, state: null, bytes: null };
  const file = readRegularFile(statePath, `active Mission runtime state '${basename(statePath)}'`);
  if (!file.ok) return file;
  const parsed = parseJsonBytes(file.bytes, "active Mission runtime state");
  if (!parsed.ok) return parsed;
  return { ok: true, state: parsed.value, bytes: file.bytes };
}

function readStagedState(stagePath) {
  if (!existsSync(stagePath)) return { ok: true, state: null, bytes: null };
  const file = readRegularFile(stagePath, "staged Mission runtime state");
  if (!file.ok) return file;
  const parsed = parseJsonBytes(file.bytes, "staged Mission runtime state");
  if (!parsed.ok) return parsed;
  return { ok: true, state: parsed.value, bytes: file.bytes };
}

function replaceObjectContents(target, source) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, jsonClone(source));
}

function appendCommit(sessionDir, prepared) {
  return appendProvenanceEvent(sessionDir, {
    type: COMMIT_TYPE,
    schemaVersion: 1,
    sealId: prepared.event.sealId,
    prepareRecordHash: prepared.prepareRecordHash,
    stateFile: prepared.event.stateFile,
    authoritativeStateSha256: prepared.event.authoritativeStateSha256,
  });
}

/** Complete an interrupted signed state transaction while the seal lock is held. */
function recoverPendingTransaction({ sessionDir, statePath, ledger }) {
  const stagePath = stagePathFor(statePath);
  if (!ledger.pending) {
    // A stage without a signed PREPARE has no authority and can be discarded.
    if (existsSync(stagePath)) rmSync(stagePath, { force: true });
    return { ok: true, ledger, state: null, recovered: false };
  }

  const active = readActiveState(statePath);
  if (!active.ok) return active;
  const staged = readStagedState(stagePath);
  if (!staged.ok) return staged;
  const pending = ledger.pending;
  const activeIsNext = stateMatchesPrepare(active.state, pending);
  const stageIsNext = stateMatchesPrepare(staged.state, pending);
  const activeIsPrevious = ledger.committed
    ? stateMatchesPrepare(active.state, ledger.committed)
    : active.state === null || !active.state?.[SEAL_FIELD];

  let recoveredState;
  if (activeIsNext) {
    recoveredState = active.state;
  } else if (activeIsPrevious && stageIsNext) {
    atomicWriteSync(statePath, staged.bytes);
    recoveredState = staged.state;
  } else {
    return {
      ok: false,
      error: "Interrupted Mission runtime seal cannot be recovered: active/staged state does not match the signed transaction",
    };
  }

  appendCommit(sessionDir, pending);
  rmSync(stagePath, { force: true });
  const rescanned = inspectRuntimeLedger(sessionDir, basename(statePath));
  if (!rescanned.ok) return rescanned;
  return { ok: true, ledger: rescanned, state: recoveredState, recovered: true };
}

function invokeFault(faultInjector, phase) {
  if (typeof faultInjector === "function") faultInjector(phase);
}

/**
 * Persist a new sealed Mission runtime state.  The complete transaction is
 * owned by this API; callers may perform an identical redundant write after it
 * returns, but must never write when `ok` is false.
 */
export function sealMissionRuntimeState({
  sessionDir,
  state,
  statePath = null,
  reason = "mission-runtime-mutation",
  allowUnsealed = false,
  faultInjector = null,
} = {}) {
  if (!state?.mission) {
    return { ok: false, error: "Mission runtime sealing requires state.mission" };
  }
  let canonicalDir;
  let activePath;
  try {
    canonicalDir = canonicalSessionDir(sessionDir);
    activePath = resolveStatePath(canonicalDir, state, statePath);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const lock = lockFile(sealLockPath(canonicalDir, activePath), {
    command: "mission-runtime-seal",
  });
  if (!lock.acquired) {
    return { ok: false, error: "could not acquire Mission runtime seal lock", holder: lock.holder };
  }

  try {
    let ledger = inspectRuntimeLedger(canonicalDir, basename(activePath));
    if (!ledger.ok) return ledger;
    const recovered = recoverPendingTransaction({ sessionDir: canonicalDir, statePath: activePath, ledger });
    if (!recovered.ok) return recovered;
    ledger = recovered.ledger;

    const active = readActiveState(activePath);
    if (!active.ok) return active;
    if (ledger.committed && !stateMatchesPrepare(active.state, ledger.committed)) {
      return { ok: false, error: "active Mission runtime state does not match its newest committed seal" };
    }
    if (!ledger.committed && active.state?.mission && !allowUnsealed) {
      return { ok: false, error: "Mission runtime state is unsealed" };
    }

    const suppliedSeal = state[SEAL_FIELD] || null;
    // `allowUnsealed` is only a migration/bootstrap allowance for the first
    // seal.  Once authority exists, every successor must descend from the
    // newest committed state; otherwise init --force could reset trajectory
    // counters/history and bless the replacement as a new generation.
    if (ledger.committed) {
      const currentSeal = active.state?.[SEAL_FIELD];
      if (!suppliedSeal || suppliedSeal.sealId !== currentSeal?.sealId ||
          suppliedSeal.generation !== currentSeal?.generation ||
          suppliedSeal.authoritativeStateSha256 !== currentSeal?.authoritativeStateSha256) {
        return { ok: false, error: "Mission runtime mutation is not based on the newest committed state" };
      }
    }

    const next = jsonClone(state);
    delete next[SEAL_FIELD];
    const authoritativeStateSha256 = missionRuntimeStateDigest(next);
    const previousSealId = ledger.committed?.event?.sealId || null;
    const generation = (ledger.committed?.event?.generation || 0) + 1;
    const sealId = `MRS-${randomBytes(16).toString("hex")}`;
    next[SEAL_FIELD] = {
      schemaVersion: 1,
      sealId,
      generation,
      previousSealId,
      authoritativeStateSha256,
    };
    const nextBytes = serializedState(next);
    const serializedStateSha256 = sha256(nextBytes);
    const stagePath = stagePathFor(activePath);
    atomicWriteSync(stagePath, nextBytes);
    invokeFault(faultInjector, "after-stage");

    const prepared = appendProvenanceEvent(canonicalDir, {
      type: PREPARE_TYPE,
      schemaVersion: 1,
      sealId,
      generation,
      previousSealId,
      stateFile: basename(activePath),
      authoritativeStateSha256,
      serializedStateSha256,
      reason: String(reason || "mission-runtime-mutation"),
    });
    invokeFault(faultInjector, "after-prepare");

    atomicWriteSync(activePath, nextBytes);
    invokeFault(faultInjector, "after-state-write");

    appendCommit(canonicalDir, {
      event: {
        sealId,
        stateFile: basename(activePath),
        authoritativeStateSha256,
      },
      prepareRecordHash: prepared.recordHash,
    });
    invokeFault(faultInjector, "after-commit");
    rmSync(stagePath, { force: true });
    return { ok: true, state: next, seal: next[SEAL_FIELD], statePath: activePath };
  } catch (error) {
    return { ok: false, error: `Mission runtime sealing failed: ${error.message}` };
  } finally {
    lock.release();
  }
}

/**
 * Validate the newest committed seal, recovering a signed interrupted write if
 * necessary.  When recovery changes the active state, the supplied object is
 * updated in place so the calling command cannot overwrite it with stale data.
 */
export function validateMissionRuntimeStateSeal({
  sessionDir,
  state,
  statePath = null,
  allowLegacyCorruptUnsealed = false,
} = {}) {
  let canonicalDir;
  let activePath;
  try {
    canonicalDir = canonicalSessionDir(sessionDir);
    activePath = resolveStatePath(canonicalDir, state || {}, statePath);
  } catch (error) {
    return { ok: false, enabled: true, errors: [error.message], error: error.message };
  }
  const lock = lockFile(sealLockPath(canonicalDir, activePath), {
    command: "mission-runtime-verify",
  });
  if (!lock.acquired) {
    const error = "could not acquire Mission runtime seal lock";
    return { ok: false, enabled: true, errors: [error], error, holder: lock.holder };
  }
  try {
    let ledger = inspectRuntimeLedger(canonicalDir, basename(activePath));
    if (!ledger.ok) return { ok: false, enabled: true, errors: [ledger.error], error: ledger.error };
    const recovered = recoverPendingTransaction({ sessionDir: canonicalDir, statePath: activePath, ledger });
    if (!recovered.ok) return { ok: false, enabled: true, errors: [recovered.error], error: recovered.error };
    ledger = recovered.ledger;
    const active = readActiveState(activePath);
    if (!active.ok) {
      // Legacy init historically replaced corrupt mission-less state. Preserve
      // that behavior only when the authenticated ledger proves there is no
      // signed Mission runtime authority for this state file. A PREPARE/COMMIT
      // chain remains authoritative even if the active file was corrupted.
      if (allowLegacyCorruptUnsealed && !ledger.hasAuthority && !state?.mission) {
        return { ok: true, enabled: false, errors: [], state, recovered: recovered.recovered };
      }
      return { ok: false, enabled: true, errors: [active.error], error: active.error };
    }

    if (!ledger.hasAuthority && !active.state?.mission && !state?.mission) {
      return { ok: true, enabled: false, errors: [], state: active.state || state, recovered: recovered.recovered };
    }
    if (!ledger.committed) {
      const error = "Mission runtime state has no committed HMAC seal";
      return { ok: false, enabled: true, errors: [error], error };
    }
    if (!active.state?.mission) {
      const error = "Mission runtime authority exists but state.mission was removed";
      return { ok: false, enabled: true, errors: [error], error };
    }
    if (!stateMatchesPrepare(active.state, ledger.committed)) {
      const error = "Mission runtime state digest/seal mismatch (possible direct edit or rollback)";
      return { ok: false, enabled: true, errors: [error], error };
    }
    replaceObjectContents(state, active.state);
    return {
      ok: true,
      enabled: true,
      errors: [],
      state: active.state,
      seal: active.state[SEAL_FIELD],
      recovered: recovered.recovered,
    };
  } catch (error) {
    const message = `Mission runtime seal verification failed: ${error.message}`;
    return { ok: false, enabled: true, errors: [message], error: message };
  } finally {
    lock.release();
  }
}
