import {
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { atomicWriteSync, runtimeRegistryPath } from "./util.mjs";

export const MAX_NODE_WALL_MS = 30 * 60 * 1000;
export const MAX_TOOL_CALLS = 100;
export const AUTO_MODE_REMINDER = "auto mode — continue without confirmation only while node and repair-edge budgets remain; when the circuit breaker trips, stop and report immediately; do not retry or attempt recovery from the current Claude session";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function validTimestamp(value) {
  if (!nonEmptyString(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function registryPath(sessionId, home = homedir()) {
  return runtimeRegistryPath(sessionId, home);
}

export function resolveCurrentRun(state) {
  if (!state || typeof state !== "object" || Array.isArray(state) ||
      !Array.isArray(state.history) || !nonEmptyString(state.currentNode)) {
    return null;
  }

  const tail = state.history.at(-1);
  if (tail?.nodeId === state.currentNode &&
      nonEmptyString(tail.runId) && validTimestamp(tail.timestamp)) {
    return {
      runId: tail.runId,
      startedAt: tail.timestamp,
      runKey: `history:${state.history.length - 1}:${tail.runId}:${tail.timestamp}`,
    };
  }

  if (state.totalSteps === 0 && state.history.length === 0 &&
      nonEmptyString(state.entryNode) && state.currentNode === state.entryNode &&
      validTimestamp(state.flowStartedAt)) {
    return {
      runId: "run_1",
      startedAt: state.flowStartedAt,
      runKey: `initial:${state.entryNode}:${state.flowStartedAt}`,
    };
  }

  if (state.autoMode !== true && state.totalSteps === 0 && state.history.length === 0 &&
      nonEmptyString(state.entryNode) && state.currentNode === state.entryNode &&
      state.flowStartedAt == null) {
    return {
      runId: "run_1",
      startedAt: null,
      runKey: `legacy-initial:${state.entryNode}`,
    };
  }

  return null;
}

export function budgetPaths(sessionDir, nodeId, runKey) {
  const key = sha256(JSON.stringify([nodeId, runKey]));
  const dir = join(sessionDir, "node-budget", key);
  return {
    dir,
    context: join(dir, "context.json"),
    stop: join(dir, "guard-stop.json"),
    slots: join(dir, "slots"),
  };
}

function validateRegistryRecord(record, expectedSessionId = null) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("session registry must be a JSON object");
  }
  if (expectedSessionId !== null && record.sessionId !== expectedSessionId) {
    throw new Error("session registry session ID mismatch");
  }
  for (const field of ["sessionId", "sessionDir", "projectRoot", "registeredAt"]) {
    if (!nonEmptyString(record[field])) {
      throw new Error(`session registry requires non-empty ${field}`);
    }
  }
  if (!isAbsolute(record.sessionDir) || !isAbsolute(record.projectRoot)) {
    throw new Error("session registry paths must be absolute");
  }
  if (!validTimestamp(record.registeredAt)) {
    throw new Error("session registry registeredAt must be an ISO timestamp");
  }
  return record;
}

export function readSessionRegistry(sessionId, home = homedir()) {
  const path = registryPath(sessionId, home);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`cannot read session registry '${path}': ${error.message}`);
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse session registry '${path}': ${error.message}`);
  }
  return validateRegistryRecord(record, sessionId);
}

export function writeSessionRegistry(record, home = homedir()) {
  validateRegistryRecord(record);
  const path = registryPath(record.sessionId, home);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteSync(path, JSON.stringify(record, null, 2) + "\n");
  return path;
}

export function atomicCreateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

export function atomicPublishJson(path, value, publish = linkSync) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  try {
    try {
      publish(temp, path);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    unlinkSync(temp);
  }
}

export function ensureBudgetContext(paths, nodeId, run) {
  const expected = {
    nodeId,
    runId: run.runId,
    runKey: run.runKey,
    startedAt: run.startedAt,
    maxWallTimeSeconds: MAX_NODE_WALL_MS / 1000,
    maxToolCalls: MAX_TOOL_CALLS,
  };
  atomicPublishJson(paths.context, expected);

  let actual;
  try {
    actual = JSON.parse(readFileSync(paths.context, "utf8"));
  } catch (error) {
    throw new Error(`cannot parse budget context '${paths.context}': ${error.message}`);
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`budget context mismatch for '${paths.context}'`);
  }
  return actual;
}

export function claimToolSlot(paths, evidence, maxToolCalls = MAX_TOOL_CALLS) {
  mkdirSync(paths.slots, { recursive: true });
  for (let index = 1; index <= maxToolCalls; index++) {
    const slot = join(paths.slots, `${String(index).padStart(6, "0")}.json`);
    if (atomicCreateJson(slot, evidence)) return index;
  }
  return null;
}

export function createStopMarker(
  sessionDir,
  state,
  { reason, edgeKey, now = new Date().toISOString() },
) {
  const run = resolveCurrentRun(state);
  if (!run) throw new Error("cannot resolve current run for stop marker");
  if (!nonEmptyString(state._claudeSessionId)) {
    throw new Error("auto flow is missing _claudeSessionId");
  }

  const paths = budgetPaths(sessionDir, state.currentNode, run.runKey);
  const marker = {
    sessionId: state._claudeSessionId,
    nodeId: state.currentNode,
    runKey: run.runKey,
    reason,
    ...(edgeKey ? { edgeKey } : {}),
    createdAt: now,
  };
  return {
    created: atomicCreateJson(paths.stop, marker),
    path: paths.stop,
    marker,
    run,
    paths,
  };
}
