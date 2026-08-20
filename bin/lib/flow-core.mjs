// Flow core commands: route, init, validate, validateHandshakeData, validate-context
// Depends on: flow-templates.mjs, viz-commands.mjs (getMarker), util.mjs

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  lstatSync,
} from "fs";
import { join, dirname, resolve, basename } from "path";
import { createHash } from "crypto";
import { homedir } from "os";
import { execFileSync, execSync } from "child_process";
import { FLOW_TEMPLATES, resolveFlowTemplate, loadFlowFromFile } from "./flow-templates.mjs";
import { getMarker } from "./viz-commands.mjs";
import {
  getFlag, hasFlag, resolveDir, atomicWriteSync, createSessionDir, getProjectRoot, getSessionsBaseDir,
  VALID_NODE_TYPES, VALID_STATUSES, VALID_VERDICTS, EVIDENCE_TYPES,
  WRITER_SIG,
} from "./util.mjs";
import {
  VALID_TIERS,
  getRequiredBaselineKeys,
  getAllBaselineKeys,
  formatTierCoverageHint,
} from "./tier-baselines.mjs";
import { checkEvalDistinctness, parseEvaluation } from "./eval-parser.mjs";
import { runBriefLint } from "./brief-lint.mjs";
import { loadExtensions, saveRegistryCache, resolveBypass, clearBreakerState, fireNodePreflight } from "./extensions.mjs";
import { parseBypassArgs } from "./bypass-args.mjs";
import {
  collectPromptExtensionProvenanceErrors,
  readTaskFromAC,
  resolveNodeExtensionContext,
} from "./ext-commands.mjs";
import {
  collectTestEvidenceProvenanceReasons,
  collectTestResultReasons,
} from "./test-result-gate.mjs";
import { loadTestCommandSpec, testCommandHash } from "./test-command-execution.mjs";
import {
  AUTO_MODE_REMINDER,
  readSessionRegistry,
  registryPath,
  resolveCurrentRun,
  writeSessionRegistry,
} from "./runaway-guard.mjs";
import { lockFile } from "./file-lock.mjs";
import { evaluateFlowBudget } from "./flow-budget.mjs";
import { parseRunOrdinal } from "./run-id.mjs";
import { stoppedFlowError } from "./flow-state-guard.mjs";
import {
  expectedRunForNode,
  isRunId,
  isPlainObject,
  readSessionAuthority,
  resolveExactRunHandshake,
  authoritativeEntries,
  canonicalProjectionErrors,
} from "./flow-evidence.mjs";
import {
  guardMissionMutation,
  prepareMissionState,
  sealMissionRuntimeState,
  verifyMissionIntegrity,
} from "./mission-contract.mjs";

// ─── route ──────────────────────────────────────────────────────

export function cmdRoute(args) {
  const node = getFlag(args, "node");
  const verdict = getFlag(args, "verdict");

  if (!node || !verdict) {
    console.error("Usage: opc-harness route --node <gateId> --verdict <PASS|FAIL|ITERATE> --flow <template> [--flow-file <path>]");
    process.exit(1);
  }

  // F7 fix: load flow-state.json BEFORE resolving the template so
  // resolveFlowTemplate can fall back to state.flowTemplate when neither --flow
  // nor --flow-file is given. The real /opc skill calls `route` without --flow,
  // so without this it errored "no --flow or --flow-file specified". Mirrors
  // viz-commands.mjs:34 / ext-commands.mjs:57.
  const stateDir = resolveDir(args, { optional: true });
  let state = null;
  if (stateDir) {
    const statePath = join(stateDir, "flow-state.json");
    if (existsSync(statePath)) {
      try {
        state = JSON.parse(readFileSync(statePath, "utf8"));
        if (!state || typeof state !== "object" || Array.isArray(state)) {
          console.log(JSON.stringify({ next: null, valid: false, error: "corrupt flow-state.json: expected an object" }));
          return;
        }
        if (state._flow_file) loadFlowFromFile(state._flow_file);
      } catch (error) {
        console.log(JSON.stringify({ next: null, valid: false, error: `corrupt flow-state.json: ${error.message}` }));
        return;
      }
    }
  }

  const resolved = resolveFlowTemplate(args, state);
  if (resolved.error) {
    console.log(JSON.stringify({ next: null, valid: false, error: resolved.error }));
    return;
  }
  const { template, name: flow } = resolved;

  if (!template.nodes.includes(node)) {
    console.log(JSON.stringify({ next: null, valid: false, error: `node '${node}' not in flow '${flow}'` }));
    return;
  }

  const nodeEdges = template.edges[node];
  if (!nodeEdges || !(verdict in nodeEdges)) {
    console.log(JSON.stringify({ next: null, valid: false, error: `no edge for verdict '${verdict}' from node '${node}' in flow '${flow}'` }));
    return;
  }

  const next = nodeEdges[verdict];
  if (state) {
    const budget = evaluateFlowBudget({ state, template, from: node, to: next, verdict });
    if (!budget.allowed) {
      console.log(JSON.stringify({ next: null, valid: false, error: budget.reason }));
      return;
    }
  }

  // Read autoMode from the state loaded above
  let autoReminder;
  if (state && state.autoMode) {
    autoReminder = AUTO_MODE_REMINDER;
  }

  console.log(JSON.stringify({ next, valid: true, ...(autoReminder ? { reminder: autoReminder } : {}) }));
}

// ─── init ───────────────────────────────────────────────────────

// Resolve the current git HEAD sha for a working tree, or null if not a repo.
function gitHeadSha(cwd) {
  try {
    return execSync("git rev-parse HEAD", {
      cwd, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}

// ─── record-commit ──────────────────────────────────────────────
// Record a commit the flow produced into flow-state.producedCommits. The gate's
// changeScope layer diffs exactly these commits, so a delivered change is
// coverage-checked while a session-local / no-commit flow is left alone.
// Usage: opc-harness record-commit [--sha <sha>] [--dir <session>]
export function cmdRecordCommit(args) {
  const dir = resolveDir(args);
  const statePath = join(dir, "flow-state.json");
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ recorded: false, error: "flow-state.json not found" }));
    return;
  }
  const lock = lockFile(statePath, { command: "record-commit" });
  if (!lock.acquired) {
    console.log(JSON.stringify({ recorded: false, error: "could not acquire flow state lock", holder: lock.holder }));
    return;
  }
  try {
    // The state must be read only after acquiring the same lock used by mission
    // decisions, otherwise a stale record-commit write can erase a newer gate.
    let state;
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch (err) {
      console.log(JSON.stringify({ recorded: false, error: `corrupt flow-state.json: ${err.message}` }));
      return;
    }
    const stopped = stoppedFlowError(state, "record-commit");
    if (stopped) {
      console.log(JSON.stringify({ recorded: false, error: stopped }));
      return;
    }
    const missionGuard = guardMissionMutation({ sessionDir: dir, state, command: "record-commit" });
    if (!missionGuard.allowed) {
      console.log(JSON.stringify({ recorded: false, error: missionGuard.reason, rebet_required: missionGuard.rebet_required }));
      return;
    }

    const root = (typeof state.projectRoot === "string" && state.projectRoot) ? state.projectRoot : getProjectRoot();
    let sha = getFlag(args, "sha", null);
    if (!sha) {
      sha = gitHeadSha(root);
      if (!sha) {
        console.log(JSON.stringify({ recorded: false, error: "cannot resolve HEAD — not a git repository" }));
        return;
      }
    }

    let full;
    try {
      full = execFileSync("git", ["rev-parse", "--verify", `${sha}^{commit}`], {
        cwd: root, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      console.log(JSON.stringify({ recorded: false, error: `not a valid commit: ${sha}` }));
      return;
    }

    if (!Array.isArray(state.producedCommits)) state.producedCommits = [];
    const already = state.producedCommits.includes(full);
    if (!already) state.producedCommits.push(full);
    state._written_by = WRITER_SIG;
    state._last_modified = new Date().toISOString();
    state._write_nonce = createHash("sha256")
      .update(`${state._last_modified}:${full}:${state._write_nonce || ""}`)
      .digest("hex")
      .slice(0, 16);
    if (state.mission) {
      const sealed = sealMissionRuntimeState({
        sessionDir: dir,
        state,
        statePath,
        reason: "record-commit",
      });
      if (!sealed.ok) {
        console.log(JSON.stringify({ recorded: false, error: sealed.error }));
        return;
      }
      state = sealed.state;
    }
    atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");
    console.log(JSON.stringify({ recorded: true, sha: full, already, producedCommits: state.producedCommits }));
  } finally {
    lock.release();
  }
}

function validatePreToolHook(home) {
  const hookPath = join(home, ".claude", "skills", "opc", "bin", "hooks", "opc-pre-tool-budget.mjs");
  if (!existsSync(hookPath)) {
    return `PreToolUse hook script is missing: ${hookPath}. Run 'opc install' and 'opc install-hooks'.`;
  }

  const settingsPath = join(home, ".claude", "settings.json");
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    return `PreToolUse hook is not installed: cannot read ${settingsPath}: ${error.message}`;
  }
  const entries = settings?.hooks?.PreToolUse;
  const expectedCommand = `node "${hookPath}"`;
  const installed = Array.isArray(entries) && entries.some(entry =>
    (entry?.matcher == null || entry.matcher === "") &&
    entry?.hooks?.some(hook =>
      hook?.type === "command" && hook.async !== true && hook.command === expectedCommand
    )
  );
  return installed ? null : `PreToolUse hook is not installed in ${settingsPath}. Run 'opc install-hooks'.`;
}

function activeRegistryConflict(sessionId, home) {
  let registry;
  try {
    registry = readSessionRegistry(sessionId, home);
  } catch (error) {
    return `cannot verify existing session registry: ${error.message}`;
  }
  if (!registry) return null;

  let state;
  try {
    state = JSON.parse(readFileSync(join(registry.sessionDir, "flow-state.json"), "utf8"));
  } catch (error) {
    return `cannot verify existing registered flow: ${error.message}`;
  }
  if (state?.status === "completed" || state?.status === "stopped") return null;
  if (state?.autoMode === true && state?._claudeSessionId === sessionId) {
    return `Claude session '${sessionId}' is already bound to an active auto flow at ${registry.sessionDir}`;
  }
  return `existing session registry for '${sessionId}' is not safely replaceable`;
}

function restoreLatestAfterFailedInit(latestLink, failedDir, previousTarget) {
  if (!latestLink) return;
  try {
    const currentTarget = readlinkSync(latestLink);
    if (resolve(dirname(latestLink), currentTarget) !== resolve(failedDir)) return;
    if (previousTarget === null) {
      rmSync(latestLink, { force: true });
      return;
    }
    const tempLink = `${latestLink}.rollback.${process.pid}`;
    rmSync(tempLink, { force: true });
    symlinkSync(previousTarget, tempLink);
    renameSync(tempLink, latestLink);
  } catch {
    // Best effort: registry failure remains the primary error.
  }
}

export async function cmdInit(args) {
  const entry = getFlag(args, "entry");
  const tier = getFlag(args, "tier");
  const autoMode = args.includes("--auto");
  const claudeSessionId = getFlag(args, "claude-session-id");
  const hasExplicitDir = args.includes("--dir");
  const missionPath = getFlag(args, "mission", null);
  const parentSession = getFlag(args, "parent-session", null);

  if (tier && !VALID_TIERS.has(tier)) {
    console.log(JSON.stringify({ created: false, error: `invalid tier: '${tier}' (expected: ${[...VALID_TIERS].join(", ")})` }));
    return;
  }

  if (autoMode) {
    if (!claudeSessionId) {
      console.log(JSON.stringify({ created: false, error: "init --auto requires non-empty --claude-session-id" }));
      return;
    }
    const home = homedir();
    const hookError = validatePreToolHook(home);
    if (hookError) {
      console.log(JSON.stringify({ created: false, error: hookError }));
      return;
    }
  }

  const resolved = resolveFlowTemplate(args);
  if (resolved.error) {
    console.log(JSON.stringify({ created: false, error: resolved.error }));
    return;
  }
  const { template, name: flow } = resolved;

  const entryNode = entry || template.nodes[0];
  if (!template.nodes.includes(entryNode)) {
    console.log(JSON.stringify({ created: false, error: `entry node '${entryNode}' not in flow '${flow}'` }));
    return;
  }

  let registryLock = null;
  if (autoMode) {
    const home = homedir();
    const path = registryPath(claudeSessionId, home);
    try {
      mkdirSync(dirname(path), { recursive: true });
      registryLock = lockFile(path, { command: "init-auto" });
    } catch (error) {
      console.log(JSON.stringify({ created: false, error: `cannot prepare session registry: ${error.message}` }));
      return;
    }
    if (!registryLock.acquired) {
      console.log(JSON.stringify({ created: false, error: "cannot acquire session registry lock" }));
      return;
    }
    const conflict = activeRegistryConflict(claudeSessionId, home);
    if (conflict) {
      registryLock.release();
      console.log(JSON.stringify({ created: false, error: conflict }));
      return;
    }
  }

  const explicitDir = hasExplicitDir ? resolveDir(args) : null;
  const removeDirOnRegistryFailure = !hasExplicitDir || !existsSync(explicitDir);
  const latestLink = hasExplicitDir ? null : join(getSessionsBaseDir(), "latest");
  let previousLatestTarget = null;
  if (latestLink) {
    try { previousLatestTarget = readlinkSync(latestLink); } catch { /* no previous session */ }
  }
  const dir = explicitDir || createSessionDir();
  const nodesPath = join(dir, "nodes");
  const nodesExistedBefore = existsSync(nodesPath);
  const statePath = join(dir, "flow-state.json");
  const force = args.includes("--force");
  if (existsSync(statePath) && !force) {
    registryLock?.release();
    console.log(JSON.stringify({ created: false, error: "flow-state.json already exists (use --force to overwrite)" }));
    return;
  }
  const priorStateText = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;

  // Initialization must not become an alternate Mission reset command. Check
  // both state modes explicitly so deleting the active state, deleting its
  // `mission` marker, or starting the other mode in the same directory cannot
  // bypass an intact runtime ledger.
  if (existsSync(dir)) {
    for (const candidatePath of [statePath, join(dir, "loop-state.json")]) {
      let candidateState = {};
      if (existsSync(candidatePath)) {
        try { candidateState = JSON.parse(readFileSync(candidatePath, "utf8")); } catch { /* verification fails closed */ }
      }
      const priorIntegrity = verifyMissionIntegrity({
        sessionDir: dir,
        state: candidateState,
        statePath: candidatePath,
        allowLegacyCorruptUnsealed: true,
      });
      if (!priorIntegrity.enabled) continue;
      registryLock?.release();
      console.log(JSON.stringify({
        created: false,
        error: priorIntegrity.ok
          ? "cannot overwrite an authoritative Mission session; use a new session or an audited Mission decision"
          : `cannot overwrite Mission runtime authority: ${priorIntegrity.errors.join("; ")}`,
        status: "mission_authority_exists",
      }));
      return;
    }
  }

  mkdirSync(nodesPath, { recursive: true });

  // ─── Resolve bypass state BEFORE writing flow-state.json ────────
  // Record it on flow-state so validate-chain and other downstream
  // tooling can honor the waiver without re-parsing CLI args. This
  // is the audit trail: a reviewer reading flow-state later can see
  // whether the run was executed with extensions disabled/whitelisted.
  const bypassCfg = parseBypassArgs(args);
  const bypassDecision = resolveBypass({ ...bypassCfg, quietBypass: true });
  const bypassRecord =
    bypassDecision.mode === "default"
      ? null
      : bypassDecision.mode === "disable-all"
        ? { mode: "disable-all", source: bypassDecision.source }
        : { mode: "whitelist", source: bypassDecision.source, names: bypassDecision.names || [] };

  const projectRoot = getProjectRoot();
  const flowStartedAt = new Date().toISOString();
  let preparedMission = { ok: true, enabled: false };
  if (missionPath || parentSession) {
    const explicitCriteria = getFlag(args, "criteria", null);
    const defaultCriteria = join(dir, "acceptance-criteria.md");
    const criteriaPath = explicitCriteria || defaultCriteria;
    const explicitPlan = getFlag(args, "plan", null);
    const defaultPlan = join(dir, "plan.md");
    const planPath = explicitPlan || (existsSync(defaultPlan) ? defaultPlan : null);
    preparedMission = prepareMissionState({
      sessionDir: dir,
      missionPath,
      criteriaPath,
      planPath,
      parentSession,
    });
    if (!preparedMission.ok) {
      registryLock?.release();
      if (!hasExplicitDir) {
        rmSync(dir, { recursive: true, force: true });
        restoreLatestAfterFailedInit(latestLink, dir, previousLatestTarget);
      } else if (!nodesExistedBefore) {
        rmSync(nodesPath, { recursive: true, force: true });
      }
      console.log(JSON.stringify({
        created: false,
        error: preparedMission.error,
        errors: preparedMission.errors,
        status: "invalid_mission",
      }));
      return;
    }
  }
  let state = {
    version: "1.0",
    flowTemplate: flow,
    currentNode: entryNode,
    entryNode,
    tier: tier || null,
    totalSteps: 0,
    maxTotalSteps: template.limits.maxTotalSteps,
    maxLoopsPerEdge: template.limits.maxLoopsPerEdge,
    maxNodeReentry: template.limits.maxNodeReentry,
    history: [],
    edgeCounts: {},
    repairEdgeCounts: {},
    projectRoot,
    // Git floor at flow start + commits the flow produces. changeScope diffs
    // producedCommits (recorded via `record-commit`), never a blind HEAD~1.
    baseSha: gitHeadSha(projectRoot),
    producedCommits: [],
    bypassMode: bypassRecord,
    flowStartedAt,
    autoMode: autoMode || undefined,
    ...(autoMode ? {
      _claudeSessionId: claudeSessionId,
      autoRepairCounts: {},
    } : {}),
    ...(preparedMission.enabled ? {
      flowStartedAt,
      mission: preparedMission.mission,
      trajectory: preparedMission.trajectory,
      findingRegistry: preparedMission.findingRegistry,
      evidenceReceipts: preparedMission.evidenceReceipts,
      checkpointReceipts: preparedMission.checkpointReceipts,
    } : {}),
    _written_by: WRITER_SIG,
    _last_modified: flowStartedAt,
    _flow_file: template._source_file || undefined,
    _write_nonce: createHash("sha256")
      .update(Date.now().toString() + Math.random().toString())
      .digest("hex").slice(0, 16),
  };

  // Auto registration can still fail. Delay the first Mission seal/write
  // until the registry has been published so that rollback never restores old
  // bytes behind a newer committed runtime seal. Mission-less init keeps its
  // established ordering and exact rollback behavior.
  const deferInitialMissionWrite = autoMode && Boolean(state.mission);
  const persistInitialState = () => {
    if (state.mission) {
      const sealed = sealMissionRuntimeState({
        sessionDir: dir,
        state,
        statePath,
        reason: "init",
        allowUnsealed: true,
      });
      if (!sealed.ok) return sealed;
      state = sealed.state;
    }
    atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");
    return { ok: true };
  };
  if (!deferInitialMissionWrite) {
    const persisted = persistInitialState();
    if (!persisted.ok) {
      registryLock?.release();
      console.log(JSON.stringify({ created: false, error: persisted.error, status: "invalid_mission_state" }));
      return;
    }
  }

  if (autoMode) {
    try {
      writeSessionRegistry({
        sessionId: claudeSessionId,
        sessionDir: resolve(dir),
        projectRoot,
        registeredAt: flowStartedAt,
      }, homedir());
    } catch (error) {
      if (removeDirOnRegistryFailure) {
        rmSync(dir, { recursive: true, force: true });
        restoreLatestAfterFailedInit(latestLink, dir, previousLatestTarget);
      } else {
        if (priorStateText === null) rmSync(statePath, { force: true });
        else atomicWriteSync(statePath, priorStateText);
        if (!nodesExistedBefore) rmSync(nodesPath, { recursive: true, force: true });
      }
      registryLock.release();
      console.log(JSON.stringify({ created: false, error: `cannot write session registry: ${error.message}` }));
      return;
    }
    if (deferInitialMissionWrite) {
      const persisted = persistInitialState();
      if (!persisted.ok) {
        // We still hold the registry lock, so removing the record cannot race
        // a second owner. The previous active state was never overwritten.
        try { rmSync(registryPath(claudeSessionId, homedir()), { force: true }); } catch { /* best effort */ }
        if (removeDirOnRegistryFailure) {
          rmSync(dir, { recursive: true, force: true });
          restoreLatestAfterFailedInit(latestLink, dir, previousLatestTarget);
        } else if (!nodesExistedBefore) {
          rmSync(nodesPath, { recursive: true, force: true });
        }
        registryLock.release();
        console.log(JSON.stringify({ created: false, error: persisted.error, status: "invalid_mission_state" }));
        return;
      }
    }
    registryLock.release();
  }

  // ─── Persist .ext-registry.json (which extensions this flow will use) ────
  // This is also the observable surface for the benchmark bypass: running
  // `init` under OPC_DISABLE_EXTENSIONS=1 / --no-extensions must produce an
  // empty applied[] so the benchmark harness can assert on the file.
  // Wrap in try/catch — a failed cache write (readonly dir, disk full) must
  // NOT crash init. The registry is recomputed at hook fire time anyway.
  try {
    // F5 / U5.7: do NOT pass flowDir here — init means "start over", we
    // don't want to inherit a stale .extension-state.json from a prior run.
    // clearBreakerState below wipes it before the first real hook fires.
    const registry = await loadExtensions(bypassCfg);
    // Stamp bypass marker into cache for post-hoc audit
    registry.bypass = bypassRecord;
    // Pin extension versions into flow-state for rubric freeze rule
    if (registry.extensions && registry.extensions.length > 0) {
      state.extensionVersions = registry.extensions.map(e => ({ name: e.name, version: e.meta?.rubricVersion || e.meta?.version || "unknown" }));
      if (state.mission) {
        const sealed = sealMissionRuntimeState({
          sessionDir: dir,
          state,
          statePath,
          reason: "init-extension-versions",
        });
        if (!sealed.ok) throw new Error(sealed.error);
        state = sealed.state;
      }
      atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");
    }
    try {
      saveRegistryCache(dir, registry);
    } catch (cacheErr) {
      console.error(`WARN: could not write .ext-registry.json: ${cacheErr.message}`);
    }
    // F5 / U5.7: fresh flow — clear any stale circuit-breaker state from a
    // prior aborted run. init == "start over", so no ext should be born
    // already disabled. clearBreakerState is idempotent (no-op if file missing).
    try {
      clearBreakerState(dir);
    } catch (clearErr) {
      console.error(`WARN: could not clear .extension-state.json: ${clearErr.message}`);
    }
  } catch (err) {
    // Extension load failures must not block init — they surface at hook
    // fire time. Record the intent (empty applied) so the cache is still
    // written and downstream tooling is consistent.
    try {
      saveRegistryCache(dir, { applied: [], extensions: [], bypass: bypassRecord });
    } catch (cacheErr) {
      console.error(`WARN: could not write .ext-registry.json: ${cacheErr.message}`);
    }
    console.error(`WARN: extensions failed to load during init: ${err.message}`);
  }

  // Print initial flow viz to stderr
  const vizLines = [""];
  for (let i = 0; i < template.nodes.length; i++) {
    const id = template.nodes[i];
    const m = getMarker(id, state);
    let line = `  ${m} ${id}`;
    const edges = template.edges[id];
    if (edges && edges.FAIL) line += `  ← FAIL → ${edges.FAIL}`;
    vizLines.push(line);
    if (i < template.nodes.length - 1) vizLines.push("  │");
  }
  vizLines.push("");
  console.error(vizLines.join("\n"));

  // ── Auto-preflight for entry node or first build node ──────────
  // Fire preflight hooks so design artifacts (tokens, brief) are ready
  // before the first node executes. Preflight failures must not block init.
  let preflightNode = null;
  let preflightResult = null;
  let preflightStatus = null;
  if (bypassCfg.noExtensions !== true) {
    try {
      const firstBriefOrBuild = template.nodes.find(n =>
        template.nodeTypes?.[n] === "brief" || template.nodeTypes?.[n] === "build" || n === "brief" || n === "build"
      );
      preflightNode = firstBriefOrBuild || entryNode;
      const preflightTask = readTaskFromAC(dir);
      const preflightCtx = resolveNodeExtensionContext(dir, preflightNode, args, {
        role: "preflight",
        task: preflightTask,
        devServerUrl: process.env.DEV_SERVER_URL || "",
      });
      const preflightCaps = preflightCtx.nodeCapabilities;

      if (preflightCaps.length > 0 && preflightTask.trim()) {
        const preflightRegistry = await loadExtensions(bypassCfg);
        preflightResult = await fireNodePreflight(preflightRegistry, preflightCtx);
        if (preflightResult?.length) preflightStatus = { node: preflightNode, status: "ok" };
        console.error(`[init] auto-preflight for '${preflightNode}': ${preflightResult?.length ? 'artifacts generated' : 'no output'}`);
      } else if (preflightCaps.length > 0) {
        preflightStatus = { node: preflightNode, status: "skipped", reason: "empty acceptance criteria" };
        console.error(`[init] auto-preflight for '${preflightNode}': skipped (empty acceptance criteria)`);
      }
    } catch (err) {
      console.error(`WARN: auto-preflight failed: ${err.message}`);
    }
  }

  console.log(JSON.stringify({
    created: true, flow, entry: entryNode, tier: tier || null, dir,
    mission_enabled: Boolean(state.mission),
    ...(state.mission ? {
      mission_version: state.mission.version,
      strategy_epoch: state.mission.strategyEpoch,
      mission_contract: join(dir, state.mission.path || "mission-contract.json"),
    } : {}),
    ...(preflightStatus ? { preflight: preflightStatus } : {}),
  }));
}

// ─── validate ───────────────────────────────────────────────────

/**
 * Shared handshake validation logic — used by both cmdValidate and pre-transition check.
 */
export function validateHandshakeData(data, opts = {}) {
  const errors = [];
  const warnings = [];

  for (const field of ["nodeId", "nodeType", "runId", "status", "summary", "timestamp"]) {
    if (typeof data[field] !== "string" || data[field].length === 0) {
      errors.push(`missing or empty required field: ${field}`);
    }
  }

  if (data.nodeType && !VALID_NODE_TYPES.has(data.nodeType)) {
    errors.push(`invalid nodeType: '${data.nodeType}' (expected: ${[...VALID_NODE_TYPES].join(", ")})`);
  }
  if (data.status && !VALID_STATUSES.has(data.status)) {
    errors.push(`invalid status: '${data.status}' (expected: ${[...VALID_STATUSES].join(", ")})`);
  }
  if (data.verdict != null && !VALID_VERDICTS.has(data.verdict)) {
    errors.push(`invalid verdict: '${data.verdict}' (expected: ${[...VALID_VERDICTS].join(", ")} or null)`);
  }

  if (!Array.isArray(data.artifacts)) {
    errors.push("artifacts must be an array");
  } else if (opts.baseDir) {
    for (let i = 0; i < data.artifacts.length; i++) {
      const a = data.artifacts[i];
      if (!a.type || !a.path) {
        errors.push(`artifact[${i}]: missing type or path`);
      } else if (!existsSync(join(opts.baseDir, a.path)) && !existsSync(a.path)) {
        errors.push(`artifact[${i}]: file not found: ${a.path}`);
      }
    }
  }

  if (opts.checkEvidence && data.nodeType === "execute" && data.status === "completed") {
    const hasEvidence = Array.isArray(data.artifacts) &&
      data.artifacts.some((a) => EVIDENCE_TYPES.has(a.type));
    if (!hasEvidence) {
      if (opts.softEvidence) {
        warnings.push("softEvidence: executor node missing standard evidence type (test-result, screenshot, cli-output) — warning only");
      } else {
        errors.push("executor node missing evidence (need at least one artifact with type: test-result, screenshot, or cli-output)");
      }
    }

    // Tier-based evidence requirements (zero trust: tier determines minimum evidence)
    if (opts.tier && Array.isArray(data.artifacts)) {
      const screenshots = data.artifacts.filter(a => a.type === "screenshot");
      const cliOrTest = data.artifacts.filter(a => a.type === "cli-output" || a.type === "test-result");

      if (opts.tier === "polished" || opts.tier === "delightful") {
        if (screenshots.length < 1) {
          errors.push(`${opts.tier} tier requires ≥1 screenshot evidence, got ${screenshots.length}`);
        }
        if (cliOrTest.length < 1) {
          errors.push(`${opts.tier} tier requires ≥1 cli-output or test-result evidence`);
        }
      }
      if (opts.tier === "delightful" && screenshots.length < 2) {
        errors.push(`delightful tier requires ≥2 screenshot evidence, got ${screenshots.length}`);
      }
    }
  }

  if (data.nodeType === "hotfix" && data.status === "completed") {
    const h = data.hotfix;
    if (h == null || typeof h !== "object" || Array.isArray(h)) {
      errors.push("hotfix node requires hotfix object describing the trivial repair");
    } else {
      if (h.scope !== "trivial") {
        errors.push("hotfix.scope must be 'trivial'");
      }
      if (!Array.isArray(h.allowedOperations) || h.allowedOperations.length === 0) {
        errors.push("hotfix.allowedOperations must list the trivial operation(s) performed");
      }
      if (h.structuralChange === true) {
        errors.push("hotfix.structuralChange must not be true");
      }
      if (Array.isArray(h.forbiddenOperations) && h.forbiddenOperations.length > 0) {
        errors.push("hotfix.forbiddenOperations must be empty");
      }
    }
  }

  // ─── Brief node must have build-brief.md + passing lint result ───
  if (data.nodeType === "brief" && data.status === "completed" && !data.skipped && Array.isArray(data.artifacts)) {
    const briefArt = data.artifacts.find(a => a.type === "brief");
    const hasReport = data.artifacts.some(a => a.type === "report");
    if (!briefArt) {
      errors.push("brief node requires artifact with type: 'brief' (build-brief.md)");
    }
    if (!hasReport) {
      errors.push("brief node requires artifact with type: 'report' (brief-lint-result.json)");
    }
    // Anti-forgery: re-run brief-lint on the actual brief content instead of trusting report JSON
    if (briefArt && opts.baseDir) {
      const briefPath = existsSync(join(opts.baseDir, briefArt.path))
        ? join(opts.baseDir, briefArt.path) : briefArt.path;
      try {
        const briefText = readFileSync(briefPath, "utf8");
        // Resolve tier: explicit opts.tier → flow-state.json → undefined (= all checks)
        let lintTier = opts.tier;
        if (!lintTier) {
          try {
            // baseDir is typically nodes/{nodeId}/, session root is two levels up
            const sessionRoot = resolve(opts.baseDir, "..", "..");
            const fsPath = join(sessionRoot, "flow-state.json");
            if (existsSync(fsPath)) {
              const fs = JSON.parse(readFileSync(fsPath, "utf8"));
              lintTier = fs.tier || undefined;
            }
          } catch { /* best-effort tier resolution */ }
        }
        const lintResult = runBriefLint(briefText, { tier: lintTier });
        if (lintResult.failures.length > 0) {
          const failNames = lintResult.failures.map(f => f.check).join(", ");
          errors.push(`brief-lint re-run failed on actual brief content: ${failNames}`);
        }
        // Iteration Delta enforcement on gate loopback: a brief re-entry (run_2+)
        // only happens when the gate sent the flow back with prior findings, so the
        // '## Iteration Delta' section becomes mandatory. We re-run with
        // hasPriorFindings so this is hard-enforced at validate stage — the brief
        // cannot pass validation on a loopback without listing what changed.
        const runOrdinal = parseRunOrdinal(data.runId);
        if (runOrdinal !== null && runOrdinal > 1n) {
          const deltaResult = runBriefLint(briefText, { tier: lintTier, hasPriorFindings: true });
          if (deltaResult.failures.some(f => f.check === "iteration-delta")) {
            errors.push("brief re-entered after gate loopback (" + data.runId + ") but has no '## Iteration Delta' section — list specific changes from prior findings");
          }
        }
      } catch {
        errors.push(`brief artifact unreadable: ${briefArt.path}`);
      }
    }
  }

  // ─── Review independence check (zero trust: ≥2 distinct eval artifacts) ───
  if (data.nodeType === "review" && data.status === "completed" && Array.isArray(data.artifacts)) {
    const evalArtifacts = data.artifacts.filter(
      a => a.type === "eval" || a.type === "evaluation"
    );
    if (evalArtifacts.length < 2) {
      errors.push(`review node requires ≥2 eval artifacts from independent agents, got ${evalArtifacts.length}`);
    } else if (opts.baseDir) {
      // Content distinctness check — reuse shared function from eval-parser
      const evalContents = [];
      for (const a of evalArtifacts) {
        const fullPath = existsSync(join(opts.baseDir, a.path))
          ? join(opts.baseDir, a.path)
          : a.path;
        try {
          evalContents.push({ path: a.path, content: readFileSync(fullPath, "utf8") });
        } catch { /* file not found — already caught by artifact check above */ }
      }
      if (evalContents.length >= 2) {
        const dc = checkEvalDistinctness(evalContents);
        errors.push(...dc.errors);
        warnings.push(...dc.warnings);
      }
    }
  }

  // ─── Gap 2: tier coverage check for execute nodes ───────────
  // When a flow has a quality tier, the execute node must explicitly
  // declare which baseline items were covered and which were skipped.
  // This prevents the executor from silently skipping polish requirements.
  if (opts.tier && data.nodeType === "execute" && data.status === "completed") {
    const requiredKeys = getRequiredBaselineKeys(opts.tier);
    const allKeys = getAllBaselineKeys(opts.tier);

    if (requiredKeys.size > 0) {
      const tc = data.tierCoverage;
      const tierHint = formatTierCoverageHint(opts.tier);
      if (tc == null || typeof tc !== "object") {
        errors.push(`execute node must have tierCoverage object when flow tier is '${opts.tier}'. ${tierHint}`);
      } else {
        const covered = Array.isArray(tc.covered) ? tc.covered : null;
        const skipped = Array.isArray(tc.skipped) ? tc.skipped : null;
        if (covered == null) errors.push(`tierCoverage.covered must be an array. ${tierHint}`);
        if (skipped == null) errors.push(`tierCoverage.skipped must be an array. ${tierHint}`);

        if (covered && skipped) {
          // Validate each skipped entry has {key, reason}
          for (let i = 0; i < skipped.length; i++) {
            const s = skipped[i];
            if (s == null || typeof s !== "object") {
              errors.push(`tierCoverage.skipped[${i}] must be an object. ${tierHint}`);
              continue;
            }
            if (!s.key || typeof s.key !== "string") {
              errors.push(`tierCoverage.skipped[${i}] missing 'key'. ${tierHint}`);
            }
            if (!s.reason || typeof s.reason !== "string" || s.reason.length < 10) {
              errors.push(`tierCoverage.skipped[${i}] missing 'reason' (min 10 chars — explain why the item is not applicable). ${tierHint}`);
            }
          }

          // Validate every covered/skipped key is a real baseline key
          for (const k of covered) {
            if (!allKeys.has(k)) {
              errors.push(`tierCoverage.covered contains unknown baseline key: '${k}'. ${tierHint}`);
            }
          }
          for (const s of skipped) {
            if (s && s.key && !allKeys.has(s.key)) {
              errors.push(`tierCoverage.skipped contains unknown baseline key: '${s.key}'. ${tierHint}`);
            }
          }

          // Every required key must be in covered or skipped
          const declared = new Set([...covered, ...skipped.map((s) => s && s.key).filter(Boolean)]);
          for (const k of requiredKeys) {
            if (!declared.has(k)) {
              errors.push(`tierCoverage missing required baseline item: '${k}' (must be in covered or skipped). ${tierHint}`);
            }
          }
        }
      }
    }
  }

  if (data.findings && typeof data.findings === "object") {
    if ((data.findings.critical || 0) > 0 && data.verdict === "PASS") {
      errors.push("verdict is PASS but findings.critical > 0");
    }
  }

  if (data.loopback != null) {
    if (typeof data.loopback !== "object") {
      errors.push("loopback must be an object");
    } else {
      if (!data.loopback.from) errors.push("loopback.from is required");
      if (!data.loopback.reason) errors.push("loopback.reason is required");
      if (typeof data.loopback.iteration !== "number") errors.push("loopback.iteration must be a number");
    }
  }

  return { errors, warnings };
}

function selectedRunHandshakeForNodePath(direct) {
  if (basename(direct) !== "handshake.json") return null;
  const nodeDir = dirname(direct);
  const harnessDir = dirname(dirname(nodeDir));
  const statePath = join(harnessDir, "flow-state.json");
  if (!existsSync(statePath)) return null;
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
  if (state.currentNode !== basename(nodeDir)) return null;
  const selected = resolveCurrentRun(state);
  if (!selected) return null;
  const selectedPath = join(nodeDir, selected.runId, "handshake.json");
  return existsSync(selectedPath) ? selectedPath : null;
}

function resolveHandshakeForValidate(file) {
  const direct = resolve(file);
  if (!existsSync(direct)) {
    const selected = selectedRunHandshakeForNodePath(direct);
    if (selected) return selected;
  }
  return direct;
}

function harnessDirForHandshake(file) {
  const dir = dirname(resolve(file));
  if (/^run_\d+$/.test(basename(dir))) return dirname(dirname(dirname(dir)));
  return dirname(dirname(dir));
}

function handshakeBaseDir(file, data = null) {
  const dir = dirname(resolve(file));
  if (!/^run_\d+$/.test(basename(dir))) return dir;
  const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
  return artifacts.some((artifact) =>
    typeof artifact?.path === "string" && !/^run_\d+\//.test(artifact.path)
  ) ? dir : dirname(dir);
}

function firstPositionalArg(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (!a.includes("=") && args[i + 1] && !args[i + 1].startsWith("--")) i++;
      continue;
    }
    return a;
  }
  return null;
}

function resolveDefaultHandshakeForValidate(args) {
  const dir = resolveDir(args);
  const statePath = join(dir, "flow-state.json");
  if (!existsSync(statePath)) {
    return { error: "flow-state.json not found" };
  }
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    return { error: `cannot parse flow-state.json: ${err.message}` };
  }
  if (!state.currentNode) {
    return { error: "flow-state.json has no currentNode" };
  }
  const currentRun = resolveCurrentRun(state);
  if (currentRun) {
    const exact = resolveExactRunHandshake(dir, state.currentNode, currentRun.runId);
    if (exact.error) return { error: exact.error };
    if (!exact.missing && exact.path && existsSync(exact.path)) return { file: exact.path };
    return { error: `missing exact selected-run handshake for node '${state.currentNode}' run '${currentRun.runId}'` };
  }
  return {
    file: resolveHandshakeForValidate(join(dir, "nodes", state.currentNode, "handshake.json")),
  };
}

function sessionExactEvidenceErrors(dir, state) {
  const errors = [];
  for (const entry of authoritativeEntries(state, { includeCurrent: true })) {
    const exact = resolveExactRunHandshake(dir, entry.nodeId, entry.runId);
    if (exact.error) errors.push(exact.error);
    else if (exact.missing || !existsSync(exact.path)) {
      errors.push(`missing exact selected/history handshake for node '${entry.nodeId}' run '${entry.runId}'`);
    }
  }
  return errors;
}

function nodeAndRunFromHandshakePath(file) {
  const abs = resolve(file);
  const parent = dirname(abs);
  const maybeRun = basename(parent);
  if (/^run_\d+$/.test(maybeRun)) {
    return { nodeId: basename(dirname(parent)), pathRunId: maybeRun };
  }
  return { nodeId: basename(parent), pathRunId: null };
}

function stateBackedValidateIdentityErrors(file, data) {
  if (!isPlainObject(data)) return [];
  const harnessDir = harnessDirForHandshake(file);
  const authority = readSessionAuthority(harnessDir);
  if (!authority.exists) return [];
  if (authority.error) return [authority.error];
  const state = authority.state;
  const { nodeId, pathRunId } = nodeAndRunFromHandshakePath(file);
  const expectedRun = expectedRunForNode(state, nodeId);
  const errors = sessionExactEvidenceErrors(harnessDir, state);
  if (!expectedRun) {
    errors.push(`no authoritative selected/history run for node '${nodeId}'`);
    return errors;
  }
  if (pathRunId && pathRunId !== expectedRun) {
    errors.push(`handshake path run is '${pathRunId}', expected '${expectedRun}'`);
  }
  if (data.nodeId !== nodeId) errors.push(`handshake nodeId is '${data.nodeId}', expected '${nodeId}'`);
  if (data.runId !== expectedRun) errors.push(`handshake runId is '${data.runId}', expected '${expectedRun}'`);
  return errors;
}

export function cmdValidate(args) {
  const inputFile = firstPositionalArg(args);
  let file;
  if (!inputFile) {
    const resolved = resolveDefaultHandshakeForValidate(args);
    if (resolved.error) {
      console.log(JSON.stringify({ valid: false, errors: [resolved.error] }));
      return;
    }
    file = resolved.file;
  } else {
    file = resolveHandshakeForValidate(inputFile);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ valid: false, errors: [`cannot read/parse: ${err.message}`] }));
    return;
  }

  let soft = false;
  let tier = null;
  let authorityState = null;
  let authorityTemplate = null;
  try {
    const harnessDir = harnessDirForHandshake(file);
    const authority = readSessionAuthority(harnessDir);
    if (authority.exists && authority.error) {
      console.log(JSON.stringify({ valid: false, errors: [authority.error] }));
      return;
    }
    if (authority.exists) {
      const state = authority.state;
      authorityState = state;
      // Auto-restore flow template from _flow_file if needed
      if (state._flow_file) {
        loadFlowFromFile(state._flow_file); // injects into FLOW_TEMPLATES
      }
      if (state.flowTemplate) {
        const tmpl = FLOW_TEMPLATES[state.flowTemplate];
        authorityTemplate = tmpl || null;
        if (tmpl && tmpl.softEvidence) soft = true;
      }
      if (state.tier && VALID_TIERS.has(state.tier)) tier = state.tier;
    }
  } catch (error) {
    console.log(JSON.stringify({ valid: false, errors: [`state-backed validation failed: ${error.message}`] }));
    return;
  }

  const { errors, warnings } = validateHandshakeData(data, {
    checkEvidence: true,
    softEvidence: soft,
    baseDir: handshakeBaseDir(file, data),
    tier,
  });
  if (data?.testEvidenceProvenance != null) {
    errors.push(...collectTestEvidenceProvenanceReasons(data));
  }
  errors.push(...stateBackedValidateIdentityErrors(file, data));
  if (authorityState) {
    const harnessDir = harnessDirForHandshake(file);
    errors.push(...canonicalProjectionErrors(harnessDir, authorityState, (canonical, path, nodeId, runId) =>
      canonicalHandshakeErrors(canonical, nodeId, runId, {
        nodeType: authorityTemplate?.nodeTypes?.[nodeId],
        softEvidence: soft,
        baseDir: handshakeBaseDir(path, canonical),
        tier,
      })
    ));
  }

  for (const w of warnings) {
    console.error(`\u26a0\ufe0f  ${w}`);
  }

  console.log(JSON.stringify({ valid: errors.length === 0, errors }));
}

// ─── seal ──────────────────────────────────────────────────────
// Auto-scan a node's run directory and generate handshake.json from found artifacts.

function testEvidenceContext(dir, handshake) {
  const sourceNode = handshake?.testEvidenceProvenance?.sourceNode;
  if (!sourceNode) return {};
  const sourceRunId = handshake?.testEvidenceProvenance?.sourceRunId;
  if (!/^run_\d+$/.test(sourceRunId || "")) return {};
  const spec = loadTestCommandSpec(dir, sourceNode, sourceRunId);
  if (!spec) return {};
  return {
    expectedCommandHash: testCommandHash(spec.testCommand),
    expectedSourcePlanHash: spec.sourcePlanHash,
    allowVacuousChecks: spec.allowVacuousChecks,
  };
}

export function collectFilesRecursive(root, prefix = "") {
  const out = [];
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFilesRecursive(full, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

export function classifyArtifact(relPath, nodeType) {
  const name = basename(relPath);
  const lower = name.toLowerCase();
  if (lower === "handshake.json" || lower === "flow-state.json") return null;
  if (lower === "build-brief.md") return "brief";
  if (lower === "test-plan.md") return "test-plan";
  if (lower === "test-execution.json") return "test-plan";
  if (/^eval-.*\.md$/i.test(name) || lower === "eval.md") return "eval";
  if (/^screenshot.*\.(png|jpg|jpeg|gif|webp)$/i.test(name)) return "screenshot";
  if (/^(command-output|cli-output|test-command-output).*\.(txt|log)$/i.test(name) || /\.log$/i.test(name)) return "cli-output";
  if ((nodeType === "execute" && /^test-.*\.json$/i.test(name)) || lower === "test-command-result.json") return "test-result";
  if (/^test-.*\.json$/i.test(name) && /execute/i.test(relPath)) return "test-result";
  if (/^(.*-)?lint-result\.json$/i.test(name) || /^(.*-)?report\.json$/i.test(name) || /^(.*-)?result\.json$/i.test(name)) return "report";
  // Every non-reserved JSON file inside run_N is a machine-readable report artifact.
  if (lower.endsWith(".json")) return "report";
  if (/\.(ts|tsx|js|jsx|css|html|mjs|cjs)$/i.test(name)) return "source";
  if (lower.endsWith(".md") || lower.endsWith(".txt")) return "source";
  return null;
}

export function scanNodeArtifacts(nodeDir, runDir, nodeType) {
  const runId = basename(runDir);
  const files = collectFilesRecursive(runDir).map((file) => `${runId}/${file}`);
  for (const nodeLevel of ["build-brief.md", "test-plan.md", "test-execution.json"]) {
    if (existsSync(join(nodeDir, nodeLevel))) files.push(nodeLevel);
  }
  return files
    .sort()
    .map((path) => ({ type: classifyArtifact(path, nodeType), path }))
    .filter((artifact) => artifact.type);
}

function normalizeEvalVerdict(raw) {
  const text = String(raw || "").toUpperCase();
  if (/\bBLOCKED\b/.test(text)) return "BLOCKED";
  if (/\bFAIL\b/.test(text)) return "FAIL";
  if (/\bITERATE\b/.test(text)) return "ITERATE";
  if (/\b(PASS|APPROVE|LGTM|TEST-CASES)\b/.test(text)) return "PASS";
  return null;
}

function inferEvalVerdict(evalArtifacts, nodeDir) {
  const findings = { critical: 0, warning: 0, suggestion: 0 };
  const parsedVerdicts = [];
  for (const a of evalArtifacts) {
    try {
      const parsed = parseEvaluation(readFileSync(join(nodeDir, a.path), "utf8"));
      findings.critical += parsed.critical || 0;
      findings.warning += parsed.warning || 0;
      findings.suggestion += parsed.suggestion || 0;
      const v = normalizeEvalVerdict(parsed.verdict);
      if (v) parsedVerdicts.push(v);
    } catch { /* skip unreadable eval; artifact validation catches missing files */ }
  }
  let verdict = null;
  if (parsedVerdicts.includes("BLOCKED")) verdict = "BLOCKED";
  else if (parsedVerdicts.includes("FAIL") || findings.critical > 0) verdict = "FAIL";
  else if (parsedVerdicts.includes("ITERATE") || findings.warning > 0) verdict = "ITERATE";
  else if (parsedVerdicts.includes("PASS") || findings.suggestion > 0) verdict = "PASS";
  return { verdict, findings };
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonicalHandshakeErrors(data, nodeId, runId, options = {}) {
  if (!isPlainObject(data)) return ["canonical handshake.json root must be a non-null object"];
  const errors = [];
  const validation = validateHandshakeData(data, {
    checkEvidence: true,
    softEvidence: !!options.softEvidence,
    baseDir: options.baseDir,
    tier: options.tier,
  });
  errors.push(...validation.errors.map((error) => `canonical handshake.json: ${error}`));
  if (data.nodeId !== nodeId) errors.push(`canonical handshake.json nodeId is '${data.nodeId}', expected '${nodeId}'`);
  if (data.runId !== runId) errors.push(`canonical handshake.json runId is '${data.runId}', expected '${runId}'`);
  if (options.nodeType && data.nodeType !== options.nodeType) {
    errors.push(`canonical handshake.json nodeType is '${data.nodeType}', expected '${options.nodeType}'`);
  }
  if (typeof data.status !== "string" || data.status.length === 0) {
    errors.push("canonical handshake.json status missing or invalid");
  }
  if (!Array.isArray(data.artifacts)) errors.push("canonical handshake.json artifacts must be an array");
  if (data.testEvidenceProvenance != null) {
    errors.push(...collectTestEvidenceProvenanceReasons(data)
      .map((error) => `canonical handshake.json: ${error}`));
  }
  return errors;
}

function preserveHarnessTestEvidence(target, existing) {
  const prov = existing?.testEvidenceProvenance;
  if (prov?.kind !== "opc-test-command" || prov?.executionActor !== "opc-harness:test-command") return;
  for (const key of [
    "testCommand",
    "testCommandCwd",
    "testCommandCwdSource",
    "prerequisites",
    "testEvidenceProvenance",
    "testEvidencePolicy",
    // These claims were validated against the frozen source test-plan before
    // harness execution. Re-sealing artifacts must not erase that coverage
    // mapping while retaining only its provenance shell.
    "evidence",
    "scenarioId",
    "validatorType",
    "satisfies",
  ]) {
    if (Object.hasOwn(existing, key)) target[key] = existing[key];
  }
}

const NODE_LEVEL_SEAL_ARTIFACTS = new Set([
  "build-brief.md",
  "test-plan.md",
  "test-execution.json",
]);

function exactArtifactPathFromCanonical(path, runId) {
  if (typeof path !== "string") return path;
  if (path.startsWith(`${runId}/`)) return path.slice(runId.length + 1);
  if (NODE_LEVEL_SEAL_ARTIFACTS.has(path)) return `../${path}`;
  return path;
}

function exactHandshakeFromCanonical(handshake, runId) {
  const exact = JSON.parse(JSON.stringify(handshake));
  if (Array.isArray(exact.artifacts)) {
    exact.artifacts = exact.artifacts.map((artifact) => ({
      ...artifact,
      path: exactArtifactPathFromCanonical(artifact.path, runId),
    }));
  }
  return exact;
}

function isPriorRun(priorRunId, currentRunId) {
  const prior = parseRunOrdinal(priorRunId);
  const current = parseRunOrdinal(currentRunId);
  return prior !== null && current !== null && prior < current;
}

function staleCanonicalAuthorityErrors(dir, state, template, nodeId, runId) {
  const authorized = Array.isArray(state.history) &&
    state.history.some((entry) => (entry?.nodeId || entry?.node) === nodeId && (entry?.runId || entry?.run) === runId);
  if (!authorized) return [`stale canonical ${nodeId}/${runId} is not recorded in authoritative history`];
  const exact = resolveExactRunHandshake(dir, nodeId, runId);
  if (exact.error) return [`stale canonical ${nodeId}/${runId} exact ${exact.error}`];
  if (exact.missing || !existsSync(exact.path || "")) {
    return [`stale canonical ${nodeId}/${runId} exact handshake missing at ${exact.path}`];
  }
  return canonicalProjectionErrors(dir, state, (canonical, path, projectionNodeId, projectionRunId) =>
    canonicalHandshakeErrors(canonical, projectionNodeId, projectionRunId, {
      nodeType: template.nodeTypes?.[projectionNodeId],
      softEvidence: !!template.softEvidence,
      baseDir: handshakeBaseDir(path, canonical),
      tier: state.tier && VALID_TIERS.has(state.tier) ? state.tier : null,
    }), { entries: [{ nodeId, runId }] });
}

export function cmdSeal(args) {
  const nodeId = getFlag(args, "node");
  const runOverrideProvided = hasFlag(args, "run");
  const runOverride = getFlag(args, "run", "");
  const dir = resolveDir(args);

  if (!nodeId) {
    console.error("Usage: opc-harness seal --node <nodeId> [--run <N>] [--dir <path>]");
    process.exit(1);
  }

  // Read flow state for template info
  const statePath = join(dir, "flow-state.json");
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ sealed: false, error: "flow-state.json not found" }));
    return;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ sealed: false, error: `corrupt flow-state.json: ${err.message}` }));
    return;
  }
  const stopped = stoppedFlowError(state, "seal");
  if (stopped) {
    console.log(JSON.stringify({ sealed: false, error: stopped }));
    return;
  }
  if (state.currentNode !== nodeId) {
    console.log(JSON.stringify({
      sealed: false,
      error: `cannot seal node '${nodeId}': current node is '${state.currentNode}'`,
    }));
    return;
  }
  const selectedRun = resolveCurrentRun(state);
  if (!selectedRun) {
    console.log(JSON.stringify({ sealed: false, error: `cannot resolve selected run for '${nodeId}'` }));
    return;
  }
  if (runOverrideProvided && !/^[1-9]\d*$/.test(runOverride)) {
    console.log(JSON.stringify({ sealed: false, error: "--run must be a positive numeric ordinal" }));
    return;
  }
  if (runOverrideProvided && `run_${runOverride}` !== selectedRun.runId) {
    console.log(JSON.stringify({
      sealed: false,
      error: `--run ${runOverride} does not match selected run '${selectedRun.runId}'`,
    }));
    return;
  }

  // Resolve template for nodeType lookup
  const resolved = resolveFlowTemplate(args, state);
  if (resolved.error) {
    console.log(JSON.stringify({ sealed: false, error: resolved.error }));
    return;
  }
  const { template } = resolved;

  const nodeType = template.nodeTypes?.[nodeId] || (nodeId.startsWith("gate") ? "gate" : "build");

  // Find the latest run dir
  const nodeDir = join(dir, "nodes", nodeId);
  if (!existsSync(nodeDir)) {
    console.log(JSON.stringify({ sealed: false, error: `node dir not found: nodes/${nodeId}` }));
    return;
  }

  const runDir = join(nodeDir, selectedRun.runId);

  if (!existsSync(runDir) || !lstatSync(runDir).isDirectory()) {
    console.log(JSON.stringify({ sealed: false, error: `run dir not found: ${runDir}` }));
    return;
  }

  const runId = runDir.split("/").pop();
  const handshakePath = join(nodeDir, "handshake.json");
  let existingHandshake;
  const canonicalExists = existsSync(handshakePath);
  try {
    existingHandshake = canonicalExists ? readJsonFile(handshakePath) : null;
  } catch (error) {
    console.log(JSON.stringify({
      sealed: false,
      handshakePath,
      artifacts: 0,
      verdict: null,
      validationErrors: [`canonical handshake.json parse error — fail-closed: ${error.message}`],
      warnings: [],
    }));
    return;
  }
  const staleCanonical = canonicalExists && isPlainObject(existingHandshake) &&
    isRunId(existingHandshake.runId) && isPriorRun(existingHandshake.runId, runId);
  if (staleCanonical) {
    const canonicalErrors = staleCanonicalAuthorityErrors(dir, state, template, nodeId, existingHandshake.runId);
    if (canonicalErrors.length > 0) {
      console.log(JSON.stringify({
        sealed: false,
        handshakePath,
        artifacts: 0,
        verdict: null,
        validationErrors: canonicalErrors,
        warnings: [],
      }));
      return;
    }
  }
  if (canonicalExists && !staleCanonical) {
    const canonicalErrors = canonicalHandshakeErrors(existingHandshake, nodeId, runId, {
      nodeType,
      softEvidence: !!template.softEvidence,
      baseDir: handshakeBaseDir(handshakePath, existingHandshake),
      tier: state.tier && VALID_TIERS.has(state.tier) ? state.tier : null,
    });
    canonicalErrors.push(...canonicalProjectionErrors(dir, state, (canonical, path, projectionNodeId, projectionRunId) =>
      canonicalHandshakeErrors(canonical, projectionNodeId, projectionRunId, {
        nodeType: template.nodeTypes?.[projectionNodeId],
        softEvidence: !!template.softEvidence,
        baseDir: handshakeBaseDir(path, canonical),
        tier: state.tier && VALID_TIERS.has(state.tier) ? state.tier : null,
      }), { entries: [{ nodeId, runId }] }));
    if (canonicalErrors.length > 0) {
      console.log(JSON.stringify({
        sealed: false,
        handshakePath,
        artifacts: 0,
        verdict: null,
        validationErrors: canonicalErrors,
        warnings: [],
      }));
      return;
    }
  }
  const selectedRunHandshakePath = join(runDir, "handshake.json");
  let selectedRunHandshake = null;
  let selectedRunHandshakeError = null;
  if (existsSync(selectedRunHandshakePath)) {
    try {
      selectedRunHandshake = JSON.parse(readFileSync(selectedRunHandshakePath, "utf8"));
      if (!selectedRunHandshake || typeof selectedRunHandshake !== "object" || Array.isArray(selectedRunHandshake)) {
        selectedRunHandshakeError = `${runId}/handshake.json schema error: root must be an object`;
        selectedRunHandshake = null;
      }
    } catch (error) {
      selectedRunHandshakeError = `${runId}/handshake.json parse error: ${error.message}`;
    }
  }

  // Scan files and classify artifacts
  const artifacts = scanNodeArtifacts(nodeDir, runDir, nodeType);
  const warnings = [];

  // Infer verdict from eval files
  const evalFiles = artifacts.filter(a => a.type === "eval");
  const inferred = inferEvalVerdict(evalFiles, nodeDir);
  let verdict = inferred.verdict;

  // Review node: warn if < 2 eval files
  if (nodeType === "review" && evalFiles.length < 2) {
    warnings.push(`review node has ${evalFiles.length} eval file(s), expected ≥2 for independent review`);
  }

  // Build handshake
  const handshake = {
    nodeId,
    nodeType,
    runId,
    status: "completed",
    verdict,
    summary: `Sealed ${artifacts.length} artifacts (${evalFiles.length} evals)`,
    timestamp: new Date().toISOString(),
    artifacts,
    findings: null,
  };

  const selectedParticipants = selectedRunHandshake?.extensionsApplied;
  if (
    Array.isArray(selectedParticipants) &&
    selectedParticipants.every((name) => typeof name === "string" && name.length > 0)
  ) {
    handshake.extensionsApplied = selectedParticipants.slice();
  }

  if (nodeType === "execute" && existingHandshake?.runId === runId) {
    preserveHarnessTestEvidence(handshake, existingHandshake);
  }

  const { critical, warning, suggestion } = inferred.findings;
  if (critical + warning + suggestion > 0) {
    handshake.findings = { critical, warning, suggestion };
  }

  // Validate before sealing. Invalid machine-readable evidence must not rewrite
  // the canonical handshake.
  const { errors } = validateHandshakeData(handshake, {
    checkEvidence: nodeType === "execute",
    baseDir: nodeDir,
  });
  const exactHandshake = exactHandshakeFromCanonical(handshake, runId);
  const exactValidation = validateHandshakeData(exactHandshake, {
    checkEvidence: nodeType === "execute",
    baseDir: runDir,
  });
  errors.push(...exactValidation.errors.map((error) => `selected run handshake: ${error}`));
  if (selectedRunHandshakeError) errors.push(selectedRunHandshakeError);
  if (
    (nodeType === "brief" || nodeType === "build") &&
    Array.isArray(handshake.extensionsApplied) &&
    handshake.extensionsApplied.length > 0
  ) {
    errors.push(...collectPromptExtensionProvenanceErrors(runDir, {
      nodeId,
      runId,
      extensionsApplied: handshake.extensionsApplied,
    }));
  }
  const parsedJsonArtifacts = new Map();
  for (const art of artifacts) {
    if (!/\.json$/i.test(art.path)) continue;
    try {
      const text = readFileSync(join(nodeDir, art.path), "utf8");
      parsedJsonArtifacts.set(art.path, { text, data: JSON.parse(text) });
    } catch (error) {
      errors.push(`artifact ${art.path} is not valid JSON — fail-closed: ${error.message}`);
    }
  }
  if (nodeType === "execute") {
    const evidenceContext = testEvidenceContext(dir, handshake);
    const testResultArtifacts = artifacts.filter((art) =>
      art.type === "test-result" && /\.json$/i.test(art.path || ""));
    if (handshake.testEvidenceProvenance && testResultArtifacts.length === 0) {
      errors.push("testEvidenceProvenance requires a test-result JSON artifact");
    }
    for (const art of artifacts) {
      if (art.type !== "test-result" || !/\.json$/i.test(art.path)) continue;
      const parsed = parsedJsonArtifacts.get(art.path);
      if (!parsed) continue;
      errors.push(...collectTestEvidenceProvenanceReasons(handshake, {
        sessionDir: dir,
        artifact: art,
        artifactHash: createHash("sha256").update(parsed.text).digest("hex"),
      }));
      errors.push(...collectTestResultReasons(parsed.data, {
        handshake,
        nodeId,
        runId: handshake.runId,
        artifact: art,
        artifactHash: createHash("sha256").update(parsed.text).digest("hex"),
        sessionDir: dir,
        ...evidenceContext,
      }));
    }
  }

  if (errors.length > 0) {
    for (const w of warnings) console.error(`⚠️  ${w}`);
    console.log(JSON.stringify({
      sealed: false,
      handshakePath,
      artifacts: artifacts.length,
      verdict,
      validationErrors: errors,
      warnings,
    }));
    return;
  }
  atomicWriteSync(selectedRunHandshakePath, JSON.stringify(exactHandshake, null, 2) + "\n");
  atomicWriteSync(handshakePath, JSON.stringify(handshake, null, 2) + "\n");

  for (const w of warnings) console.error(`⚠️  ${w}`);

  console.log(JSON.stringify({
    sealed: errors.length === 0,
    handshakePath,
    artifacts: artifacts.length,
    verdict,
    validationErrors: errors,
    warnings,
  }));
}

// ─── validate-context ──────────────────────────────────────────

export const RULE_VALIDATORS = {
  "non-empty-array": (v) => Array.isArray(v) && v.length > 0,
  "non-empty-object": (v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0,
  "non-empty-string": (v) => typeof v === "string" && v.length > 0,
  "positive-integer": (v) => Number.isInteger(v) && v > 0,
};

export function cmdValidateContext(args) {
  const node = getFlag(args, "node");
  const dir = resolveDir(args);

  if (!node) {
    console.error("Usage: opc-harness validate-context --flow <template> [--flow-file <path>] --node <nodeId> --dir <path>");
    process.exit(1);
  }

  // F7-sibling: load flow-state.json so resolveFlowTemplate can fall back to
  // state.flowTemplate / restore state._flow_file when called without --flow.
  let vcState = null;
  try {
    vcState = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
    if (vcState._flow_file) loadFlowFromFile(vcState._flow_file);
  } catch { /* no/corrupt state file — resolve from args alone */ }

  const resolved = resolveFlowTemplate(args, vcState);
  if (resolved.error) {
    console.log(JSON.stringify({ valid: false, errors: [resolved.error] }));
    return;
  }
  const { template } = resolved;

  if (!template.contextSchema) {
    console.log(JSON.stringify({ valid: true, errors: [], note: "no contextSchema in template" }));
    return;
  }

  const nodeSchema = template.contextSchema[node];
  if (!nodeSchema) {
    console.log(JSON.stringify({ valid: true, errors: [], note: `no contextSchema for node '${node}'` }));
    return;
  }

  const contextPath = join(dir, "flow-context.json");
  if (!existsSync(contextPath)) {
    console.log(JSON.stringify({ valid: false, errors: [`flow-context.json not found`] }));
    return;
  }

  let context;
  try {
    context = JSON.parse(readFileSync(contextPath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ valid: false, errors: [`cannot parse flow-context.json: ${err.message}`] }));
    return;
  }

  const errors = [];

  if (nodeSchema.required) {
    for (const field of nodeSchema.required) {
      if (context[field] === undefined || context[field] === null) {
        errors.push(`missing required field: '${field}'`);
      }
    }
  }

  if (nodeSchema.rules) {
    for (const [field, ruleName] of Object.entries(nodeSchema.rules)) {
      const validator = Object.hasOwn(RULE_VALIDATORS, ruleName) ? RULE_VALIDATORS[ruleName] : undefined;
      if (typeof validator !== "function") {
        errors.push(`unknown rule '${ruleName}' for field '${field}'`);
        continue;
      }
      if (context[field] !== undefined && context[field] !== null && !validator(context[field])) {
        errors.push(`field '${field}' fails rule '${ruleName}'`);
      }
    }
  }

  console.log(JSON.stringify({ valid: errors.length === 0, errors }));
}
