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
} from "fs";
import { join, dirname, resolve, basename } from "path";
import { createHash } from "crypto";
import { homedir } from "os";
import { execSync } from "child_process";
import { FLOW_TEMPLATES, resolveFlowTemplate, loadFlowFromFile } from "./flow-templates.mjs";
import { getMarker } from "./viz-commands.mjs";
import {
  getFlag, resolveDir, atomicWriteSync, createSessionDir, getProjectRoot, getSessionsBaseDir,
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
import { readTaskFromAC, findLatestRunDir } from "./ext-commands.mjs";
import { collectTestResultReasons } from "./test-result-gate.mjs";
import { loadTestCommandSpec, testCommandHash } from "./test-command-execution.mjs";
import {
  AUTO_MODE_REMINDER,
  readSessionRegistry,
  registryPath,
  writeSessionRegistry,
} from "./runaway-guard.mjs";
import { lockFile } from "./file-lock.mjs";

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
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state._flow_file) loadFlowFromFile(state._flow_file);
    } catch { /* no/corrupt state file — resolve from args alone */ }
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

  // Read autoMode from the state loaded above
  let autoReminder;
  if (state && state.autoMode) {
    autoReminder = AUTO_MODE_REMINDER;
  }

  console.log(JSON.stringify({ next: nodeEdges[verdict], valid: true, ...(autoReminder ? { reminder: autoReminder } : {}) }));
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
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ recorded: false, error: `corrupt flow-state.json: ${err.message}` }));
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

  // Fail closed: only record a real, resolvable commit.
  let full;
  try {
    full = execSync(`git rev-parse --verify ${sha}^{commit}`, {
      cwd: root, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    console.log(JSON.stringify({ recorded: false, error: `not a valid commit: ${sha}` }));
    return;
  }

  if (!Array.isArray(state.producedCommits)) state.producedCommits = [];
  const already = state.producedCommits.includes(full);
  if (!already) state.producedCommits.push(full);
  state._last_modified = new Date().toISOString();
  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");
  console.log(JSON.stringify({ recorded: true, sha: full, already, producedCommits: state.producedCommits }));
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
  const state = {
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
    projectRoot,
    // Git floor at flow start + commits the flow produces. changeScope diffs
    // producedCommits (recorded via `record-commit`), never a blind HEAD~1.
    baseSha: gitHeadSha(projectRoot),
    producedCommits: [],
    bypassMode: bypassRecord,
    autoMode: autoMode || undefined,
    ...(autoMode ? {
      _claudeSessionId: claudeSessionId,
      flowStartedAt,
      autoRepairCounts: {},
    } : {}),
    _written_by: WRITER_SIG,
    _last_modified: flowStartedAt,
    _flow_file: template._source_file || undefined,
    _write_nonce: createHash("sha256")
      .update(Date.now().toString() + Math.random().toString())
      .digest("hex").slice(0, 16),
  };

  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

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
      const preflightCaps = template.nodeCapabilities?.[preflightNode] || [];
      const preflightTask = readTaskFromAC(dir);

      if (preflightCaps.length > 0 && preflightTask.trim()) {
        const preflightRegistry = await loadExtensions(bypassCfg);
        const preflightCtx = {
          node: preflightNode,
          nodeId: preflightNode,
          nodeType: template.nodeTypes?.[preflightNode] || null,
          role: "preflight",
          task: preflightTask,
          taskDescription: preflightTask,
          flowDir: resolve(dir),
          cwd: process.cwd(),
          devServerUrl: process.env.DEV_SERVER_URL || "",
          nodeCapabilities: preflightCaps,
        };
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
        const runNum = parseInt(String(data.runId).replace(/^run_/, ""), 10);
        if (Number.isFinite(runNum) && runNum > 1) {
          const deltaResult = runBriefLint(briefText, { tier: lintTier, hasPriorFindings: true });
          if (deltaResult.failures.some(f => f.check === "iteration-delta")) {
            errors.push("brief re-entered after gate loopback (run_" + runNum + ") but has no '## Iteration Delta' section — list specific changes from prior findings");
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

function resolveHandshakeForValidate(file) {
  const direct = resolve(file);
  if (existsSync(direct)) return direct;
  if (basename(direct) !== "handshake.json") return direct;
  const latestRun = findLatestRunDir(dirname(direct));
  const fallback = latestRun ? join(latestRun, "handshake.json") : null;
  return fallback && existsSync(fallback) ? fallback : direct;
}

function harnessDirForHandshake(file) {
  const dir = dirname(resolve(file));
  if (/^run_\d+$/.test(basename(dir))) return dirname(dirname(dirname(dir)));
  return dirname(dirname(dir));
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
  return {
    file: resolveHandshakeForValidate(join(dir, "nodes", state.currentNode, "handshake.json")),
  };
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
  try {
    const harnessDir = harnessDirForHandshake(file);
    const statePath = join(harnessDir, "flow-state.json");
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      // Auto-restore flow template from _flow_file if needed
      if (state._flow_file) {
        loadFlowFromFile(state._flow_file); // injects into FLOW_TEMPLATES
      }
      if (state.flowTemplate) {
        const tmpl = FLOW_TEMPLATES[state.flowTemplate];
        if (tmpl && tmpl.softEvidence) soft = true;
      }
      if (state.tier && VALID_TIERS.has(state.tier)) tier = state.tier;
    }
  } catch { /* flow-state.json unreadable — treat as strict */ }

  const { errors, warnings } = validateHandshakeData(data, {
    checkEvidence: true,
    softEvidence: soft,
    baseDir: dirname(file),
    tier,
  });

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
  const spec = loadTestCommandSpec(dir, sourceNode);
  if (!spec) return {};
  return {
    expectedCommandHash: testCommandHash(spec.testCommand),
    expectedSourcePlanHash: spec.sourcePlanHash,
    allowVacuousChecks: spec.allowVacuousChecks,
  };
}

function collectFilesRecursive(root, prefix = "") {
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

function classifyArtifact(relPath, nodeType) {
  const name = basename(relPath);
  const lower = name.toLowerCase();
  if (lower === "build-brief.md") return "brief";
  if (lower === "test-plan.md") return "test-plan";
  if (lower === "test-execution.json") return "test-plan";
  if (/^eval-.*\.md$/i.test(name) || lower === "eval.md") return "eval";
  if (/^screenshot.*\.(png|jpg|jpeg|gif|webp)$/i.test(name)) return "screenshot";
  if (/^(command-output|cli-output|test-command-output).*\.(txt|log)$/i.test(name) || /\.log$/i.test(name)) return "cli-output";
  if ((nodeType === "execute" && /^test-.*\.json$/i.test(name)) || lower === "test-command-result.json") return "test-result";
  if (/^test-.*\.json$/i.test(name) && /execute/i.test(relPath)) return "test-result";
  if (/^(.*-)?lint-result\.json$/i.test(name) || /^(.*-)?report\.json$/i.test(name) || /^(.*-)?result\.json$/i.test(name)) return "report";
  if (/\.(ts|tsx|js|jsx|css|html|mjs|cjs)$/i.test(name)) return "source";
  if (lower.endsWith(".md") || lower.endsWith(".txt")) return "source";
  return null;
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
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
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
  ]) {
    if (Object.hasOwn(existing, key)) target[key] = existing[key];
  }
}

export function cmdSeal(args) {
  const nodeId = getFlag(args, "node");
  const runOverride = getFlag(args, "run");
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

  // Resolve template for nodeType lookup
  if (state._flow_file) loadFlowFromFile(state._flow_file);
  const template = FLOW_TEMPLATES[state.flowTemplate];
  if (!template) {
    console.log(JSON.stringify({ sealed: false, error: `unknown flow template: ${state.flowTemplate}` }));
    return;
  }

  const nodeType = template.nodeTypes?.[nodeId] || (nodeId.startsWith("gate") ? "gate" : "build");

  // Find the latest run dir
  const nodeDir = join(dir, "nodes", nodeId);
  if (!existsSync(nodeDir)) {
    console.log(JSON.stringify({ sealed: false, error: `node dir not found: nodes/${nodeId}` }));
    return;
  }

  let runDir;
  if (runOverride) {
    runDir = join(nodeDir, `run_${runOverride}`);
  } else {
    // Find latest run_N
    const runs = readdirSync(nodeDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^run_\d+$/.test(e.name))
      .sort((a, b) => {
        const na = parseInt(a.name.split("_")[1]);
        const nb = parseInt(b.name.split("_")[1]);
        return nb - na;
      });
    if (runs.length === 0) {
      console.log(JSON.stringify({ sealed: false, error: `no run_N directories found in nodes/${nodeId}` }));
      return;
    }
    runDir = join(nodeDir, runs[0].name);
  }

  if (!existsSync(runDir)) {
    console.log(JSON.stringify({ sealed: false, error: `run dir not found: ${runDir}` }));
    return;
  }

  const runId = runDir.split("/").pop();
  const handshakePath = join(nodeDir, "handshake.json");
  const existingHandshake = readJsonFile(handshakePath);

  // Scan files and classify artifacts
  const files = collectFilesRecursive(runDir).map(f => `${runId}/${f}`);
  for (const nodeLevel of ["build-brief.md", "test-plan.md", "test-execution.json"]) {
    if (existsSync(join(nodeDir, nodeLevel))) files.push(nodeLevel);
  }
  const artifacts = [];
  const warnings = [];

  for (const f of files.sort()) {
    const type = classifyArtifact(f, nodeType);
    if (!type) continue;
    artifacts.push({ type, path: f });
  }

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

  if (nodeType === "execute") preserveHarnessTestEvidence(handshake, existingHandshake);

  const { critical, warning, suggestion } = inferred.findings;
  if (critical + warning + suggestion > 0) {
    handshake.findings = { critical, warning, suggestion };
  }

  // Write handshake
  atomicWriteSync(handshakePath, JSON.stringify(handshake, null, 2) + "\n");

  // Validate
  const { errors } = validateHandshakeData(handshake, {
    checkEvidence: nodeType === "execute",
    baseDir: nodeDir,
  });
  if (nodeType === "execute") {
    const evidenceContext = testEvidenceContext(dir, handshake);
    for (const art of artifacts) {
      if (art.type !== "test-result" || !/\.json$/i.test(art.path)) continue;
      try {
        const text = readFileSync(join(nodeDir, art.path), "utf8");
        const data = JSON.parse(text);
        errors.push(...collectTestResultReasons(data, {
          handshake,
          nodeId,
          runId: handshake.runId,
          artifact: art,
          artifactHash: createHash("sha256").update(text).digest("hex"),
          sessionDir: dir,
          ...evidenceContext,
        }));
      } catch {
        errors.push(`artifact ${art.path} unreadable — fail-closed`);
      }
    }
  }

  for (const w of warnings) console.error(`⚠️  ${w}`);

  console.log(JSON.stringify({
    sealed: true,
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
