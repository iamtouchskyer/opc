// Flow core commands: route, init, validate, validateHandshakeData, validate-context
// Depends on: flow-templates.mjs, viz-commands.mjs (getMarker), util.mjs

import { readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "crypto";
import { FLOW_TEMPLATES, resolveFlowTemplate, loadFlowFromFile } from "./flow-templates.mjs";
import { getMarker } from "./viz-commands.mjs";
import {
  getFlag, resolveDir, atomicWriteSync,
  VALID_NODE_TYPES, VALID_STATUSES, VALID_VERDICTS, EVIDENCE_TYPES,
  WRITER_SIG,
} from "./util.mjs";
import { VALID_TIERS, getRequiredBaselineKeys, getAllBaselineKeys } from "./tier-baselines.mjs";
import { checkEvalDistinctness } from "./eval-parser.mjs";
import { loadExtensions, saveRegistryCache, resolveBypass, clearBreakerState } from "./extensions.mjs";
import { parseBypassArgs } from "./bypass-args.mjs";

// ─── route ──────────────────────────────────────────────────────

export function cmdRoute(args) {
  const node = getFlag(args, "node");
  const verdict = getFlag(args, "verdict");

  if (!node || !verdict) {
    console.error("Usage: opc-harness route --node <gateId> --verdict <PASS|FAIL|ITERATE> --flow <template> [--flow-file <path>]");
    process.exit(1);
  }

  const resolved = resolveFlowTemplate(args);
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

  console.log(JSON.stringify({ next: nodeEdges[verdict], valid: true }));
}

// ─── init ───────────────────────────────────────────────────────

export async function cmdInit(args) {
  const entry = getFlag(args, "entry");
  const tier = getFlag(args, "tier");
  const dir = resolveDir(args);

  if (tier && !VALID_TIERS.has(tier)) {
    console.log(JSON.stringify({ created: false, error: `invalid tier: '${tier}' (expected: ${[...VALID_TIERS].join(", ")})` }));
    return;
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

  const statePath = join(dir, "flow-state.json");
  const force = args.includes("--force");
  if (existsSync(statePath) && !force) {
    console.log(JSON.stringify({ created: false, error: "flow-state.json already exists (use --force to overwrite)" }));
    return;
  }

  mkdirSync(join(dir, "nodes"), { recursive: true });

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
    bypassMode: bypassRecord,
    _written_by: WRITER_SIG,
    _last_modified: new Date().toISOString(),
    _flow_file: template._source_file || undefined,
    _write_nonce: createHash("sha256")
      .update(Date.now().toString() + Math.random().toString())
      .digest("hex").slice(0, 16),
  };

  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

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

  console.log(JSON.stringify({ created: true, flow, entry: entryNode, tier: tier || null }));
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
      if (tc == null || typeof tc !== "object") {
        errors.push(`execute node must have tierCoverage object when flow tier is '${opts.tier}'`);
      } else {
        const covered = Array.isArray(tc.covered) ? tc.covered : null;
        const skipped = Array.isArray(tc.skipped) ? tc.skipped : null;
        if (covered == null) errors.push("tierCoverage.covered must be an array");
        if (skipped == null) errors.push("tierCoverage.skipped must be an array");

        if (covered && skipped) {
          // Validate each skipped entry has {key, reason}
          for (let i = 0; i < skipped.length; i++) {
            const s = skipped[i];
            if (s == null || typeof s !== "object") {
              errors.push(`tierCoverage.skipped[${i}] must be an object`);
              continue;
            }
            if (!s.key || typeof s.key !== "string") {
              errors.push(`tierCoverage.skipped[${i}] missing 'key'`);
            }
            if (!s.reason || typeof s.reason !== "string" || s.reason.length < 10) {
              errors.push(`tierCoverage.skipped[${i}] missing 'reason' (min 10 chars — explain why the item is not applicable)`);
            }
          }

          // Validate every covered/skipped key is a real baseline key
          for (const k of covered) {
            if (!allKeys.has(k)) {
              errors.push(`tierCoverage.covered contains unknown baseline key: '${k}'`);
            }
          }
          for (const s of skipped) {
            if (s && s.key && !allKeys.has(s.key)) {
              errors.push(`tierCoverage.skipped contains unknown baseline key: '${s.key}'`);
            }
          }

          // Every required key must be in covered or skipped
          const declared = new Set([...covered, ...skipped.map((s) => s && s.key).filter(Boolean)]);
          for (const k of requiredKeys) {
            if (!declared.has(k)) {
              errors.push(`tierCoverage missing required baseline item: '${k}' (must be in covered or skipped)`);
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

export function cmdValidate(args) {
  const file = args[0];
  if (!file) {
    console.error("Usage: opc-harness validate <handshake.json>");
    process.exit(1);
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
    const harnessDir = dirname(dirname(dirname(file)));
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

  const resolved = resolveFlowTemplate(args);
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
