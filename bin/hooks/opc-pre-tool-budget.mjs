#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_NODE_WALL_MS,
  budgetPaths,
  claimToolSlot,
  createStopMarker,
  ensureBudgetContext,
  readSessionRegistry,
  resolveCurrentRun,
} from "../lib/runaway-guard.mjs";

const DENY_OUTPUT = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "OPC accidental-runaway circuit breaker tripped for the current node/run. Stop and report. Recovery requires an external terminal transition or stop.",
  },
};

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function allow() {
  return { allowed: true };
}

function deny(reason) {
  return { allowed: false, reason, output: DENY_OUTPUT };
}

function cwdMatchesProject(cwd, projectRoot) {
  if (!nonEmptyString(cwd)) throw new Error("hook input is missing cwd");
  const canonicalCwd = realpathSync(cwd);
  const canonicalRoot = realpathSync(projectRoot);
  return canonicalCwd === canonicalRoot || canonicalCwd.startsWith(`${canonicalRoot}${sep}`);
}

function readFlowState(sessionDir) {
  const state = JSON.parse(readFileSync(join(sessionDir, "flow-state.json"), "utf8"));
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("flow state must be a JSON object");
  }
  return state;
}

function validNow(value) {
  if (!nonEmptyString(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function evaluatePreToolUse(
  input,
  { home = homedir(), now = new Date().toISOString() } = {},
) {
  const sessionId = input?.session_id;
  if (!nonEmptyString(sessionId)) return allow();

  let registry;
  try {
    registry = readSessionRegistry(sessionId, home);
  } catch (error) {
    return deny(error.message);
  }
  if (!registry) return allow();

  try {
    if (!cwdMatchesProject(input.cwd, registry.projectRoot)) return allow();

    const state = readFlowState(registry.sessionDir);
    if (state.status === "completed" || state.status === "stopped") return allow();
    if (state.autoMode === undefined || state.autoMode === false) return allow();
    if (state.autoMode !== true || state.status !== undefined) {
      return deny("auto flow state is invalid");
    }
    if (state._claudeSessionId !== sessionId) {
      return deny("auto flow session identity mismatch");
    }
    if (!nonEmptyString(input.tool_use_id) || !nonEmptyString(input.tool_name)) {
      return deny("hook input is missing tool identity");
    }
    if (input.agent_id !== undefined && !nonEmptyString(input.agent_id)) {
      return deny("hook input has invalid agent identity");
    }
    if (!validNow(now)) return deny("hook timestamp is invalid");

    const run = resolveCurrentRun(state);
    if (!run) return deny("cannot resolve current run");
    const paths = budgetPaths(registry.sessionDir, state.currentNode, run.runKey);
    if (existsSync(paths.stop)) return deny("current run is already stopped");

    ensureBudgetContext(paths, state.currentNode, run);
    const elapsedMs = Date.parse(now) - Date.parse(run.startedAt);
    if (elapsedMs < 0) return deny("current run starts in the future");
    if (elapsedMs >= MAX_NODE_WALL_MS) {
      createStopMarker(registry.sessionDir, state, {
        reason: "wall-time-budget",
        now,
      });
      return deny("wall-time budget reached");
    }

    const evidence = {
      sessionId,
      toolUseId: input.tool_use_id,
      toolName: input.tool_name,
      ...(input.agent_id ? { agentId: input.agent_id } : {}),
      claimedAt: now,
    };
    if (claimToolSlot(paths, evidence) !== null) return allow();

    createStopMarker(registry.sessionDir, state, {
      reason: "tool-call-budget",
      now,
    });
    return deny("tool-call budget reached");
  } catch (error) {
    return deny(error.message);
  }
}

function runCli() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const result = evaluatePreToolUse(input);
  if (!result.allowed) process.stdout.write(JSON.stringify(result.output));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli();
}
