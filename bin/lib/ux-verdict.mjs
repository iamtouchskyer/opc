// UX simulation verdict computation — red flag aggregation, delta comparison, gate logic.
// Depends on: tier-baselines.mjs (RED_FLAGS, severity mapping), util.mjs (flags, atomic write).

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { getFlag, resolveDir, atomicWriteSync } from "./util.mjs";
import {
  VALID_TIERS, RED_FLAG_KEYS, TRUST_SIGNAL_KEYS, TIER_FIT_BUCKETS,
  WARNING_THRESHOLDS, getRedFlagSeverity, parseRedFlagOverrides,
} from "./tier-baselines.mjs";

// ── JSON extraction from markdown ──────────────────────────────
function extractJSON(md) {
  const m = md.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// ── Schema validation (7 reject conditions) ────────────────────
const REQUIRED_FIELDS = ["persona", "tier", "red_flags", "trust_signals", "friction_points", "tier_fit", "reasoning"];
const VALID_PERSONAS = new Set(["new-user", "active-user", "churned-user"]);
const VALID_STAGES = new Set(["first-30s", "core-flow", "edge-case", "exit"]);
const THIRD_PERSON_PATTERNS = /\b(users|people|one would|customers|they would)\b/i;

function validateObserver(data, filename) {
  const errors = [];

  // 1. Missing top-level field
  for (const field of REQUIRED_FIELDS) {
    if (data[field] === undefined || data[field] === null) {
      errors.push(`missing field '${field}'`);
    }
  }
  if (errors.length > 0) return errors; // early exit — can't validate deeper

  // 2. Red flag key not in enum and not 'other'
  if (Array.isArray(data.red_flags)) {
    for (const flag of data.red_flags) {
      if (!flag.key) {
        errors.push("red_flag entry missing 'key'");
      } else if (flag.key !== "other" && !RED_FLAG_KEYS.has(flag.key)) {
        errors.push(`invalid red_flag key '${flag.key}'`);
      }
      // 3. 'other' without description
      if (flag.key === "other" && (!flag.description || flag.description.length < 5)) {
        errors.push("red_flag 'other' missing description");
      }
    }
  }

  // 4. tier_fit not in valid enum
  if (!TIER_FIT_BUCKETS.has(data.tier_fit)) {
    errors.push(`invalid tier_fit '${data.tier_fit}'`);
  }

  // 5. Friction point missing reference
  if (Array.isArray(data.friction_points)) {
    for (let i = 0; i < data.friction_points.length; i++) {
      const fp = data.friction_points[i];
      if (!fp.reference) {
        errors.push(`friction_points[${i}] missing 'reference'`);
      }
    }
  }

  // 6. reasoning < 40 chars
  if (typeof data.reasoning === "string" && data.reasoning.length < 40) {
    errors.push(`reasoning too short (${data.reasoning.length} chars, min 40)`);
  }

  // 7. reasoning contains third-person language
  if (typeof data.reasoning === "string" && THIRD_PERSON_PATTERNS.test(data.reasoning)) {
    errors.push("reasoning uses third-person language (must speak as yourself)");
  }

  return errors;
}

// ── Red flag aggregation ───────────────────────────────────────
function aggregateRedFlags(observers, tier, overrides) {
  // Deduplicate by key, take worst severity per key across observers
  const flagMap = new Map(); // key -> { key, stage, severity, observers: [] }
  for (const obs of observers) {
    if (!Array.isArray(obs.data.red_flags)) continue;
    for (const flag of obs.data.red_flags) {
      const sev = getRedFlagSeverity(flag.key, tier, overrides);
      if (sev === null) continue; // not applicable for this tier
      const existing = flagMap.get(flag.key);
      if (!existing) {
        flagMap.set(flag.key, {
          key: flag.key,
          stage: flag.stage,
          severity: sev,
          observers: [obs.persona],
          reference: flag.reference,
        });
      } else {
        // Take worse severity
        const rank = { suggestion: 1, warning: 2, critical: 3 };
        if ((rank[sev] || 0) > (rank[existing.severity] || 0)) {
          existing.severity = sev;
        }
        if (!existing.observers.includes(obs.persona)) {
          existing.observers.push(obs.persona);
        }
      }
    }
  }
  return flagMap;
}

// ── Trust signal aggregation ───────────────────────────────────
function aggregateTrustSignals(observers) {
  const present = new Set();
  const absent = new Set();
  for (const obs of observers) {
    const ts = obs.data.trust_signals;
    if (!ts) continue;
    if (Array.isArray(ts.present)) ts.present.forEach((s) => present.add(s));
    if (Array.isArray(ts.absent)) ts.absent.forEach((s) => absent.add(s));
  }
  // Remove from absent if any observer marks present
  for (const s of present) absent.delete(s);
  return { present: [...present].sort(), absent: [...absent].sort() };
}

// ── Tier fit consensus ─────────────────────────────────────────
function tierFitConsensus(observers) {
  const counts = {};
  for (const obs of observers) {
    const fit = obs.data.tier_fit;
    if (fit) counts[fit] = (counts[fit] || 0) + 1;
  }
  let best = null;
  let bestCount = 0;
  for (const [bucket, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = bucket;
      bestCount = count;
    }
  }
  return best;
}

// ── Delta comparison ───────────────────────────────────────────
function computeDelta(currentFlags, baselineFlags, baselineRun) {
  const currentKeys = new Set(currentFlags.keys());
  const baselineKeys = new Set(baselineFlags.keys());

  const regressions = []; // in current but not baseline, or severity worse
  const improvements = []; // severity better in current
  const newFlags = []; // in current but not baseline at all
  const resolvedFlags = []; // in baseline but not current at all

  for (const key of currentKeys) {
    if (!baselineKeys.has(key)) {
      newFlags.push(key);
    }
  }
  for (const key of baselineKeys) {
    if (!currentKeys.has(key)) {
      resolvedFlags.push(key);
    }
  }

  const rank = { suggestion: 1, warning: 2, critical: 3 };
  for (const key of currentKeys) {
    if (baselineKeys.has(key)) {
      const curSev = rank[currentFlags.get(key).severity] || 0;
      const baseSev = rank[baselineFlags.get(key).severity] || 0;
      if (curSev > baseSev) {
        regressions.push(`${key} (${baselineFlags.get(key).severity} → ${currentFlags.get(key).severity})`);
      } else if (curSev < baseSev) {
        improvements.push(`${key} (${baselineFlags.get(key).severity} → ${currentFlags.get(key).severity})`);
      }
    }
  }

  // Also: new critical/warning flags count as regressions
  for (const key of newFlags) {
    const cur = currentFlags.get(key);
    if (cur && (cur.severity === "critical" || cur.severity === "warning")) {
      regressions.push(`${key} (new ${cur.severity})`);
    }
  }

  return {
    vs_run: baselineRun,
    regressions,
    improvements,
    new_flags: newFlags,
    resolved_flags: resolvedFlags,
  };
}

// ── Gate logic ─────────────────────────────────────────────────
function applyGateLogic(counts, tier, tierFit, delta) {
  const threshold = WARNING_THRESHOLDS[tier] ?? 2;
  const hasBaseline = delta !== null;

  if (counts.critical >= 1) return "FAIL";

  if (hasBaseline) {
    // Subsequent run
    if (delta.regressions.length > 0) return "FAIL";
    const hasImprovement = delta.improvements.length > 0 || delta.resolved_flags.length > 0;
    if (hasImprovement && counts.warning <= threshold) return "PASS";
    if (hasImprovement && counts.warning > threshold) return "ITERATE";
    // same (no improvement, no regression)
    if (counts.warning > threshold) return "ITERATE";
    return "PASS";
  }

  // First run
  if (counts.warning > threshold) return "ITERATE";
  if (tierFit === "free-only" || tierFit === "below-tier") return "ITERATE";
  return "PASS";
}

// ── Count severities ───────────────────────────────────────────
function countSeverities(flagMap) {
  const counts = { critical: 0, warning: 0, suggestion: 0, other: 0 };
  for (const flag of flagMap.values()) {
    if (counts[flag.severity] !== undefined) {
      counts[flag.severity]++;
    } else {
      counts.other++;
    }
  }
  return counts;
}

// ── Load baseline verdict ──────────────────────────────────────
function loadBaseline(dir, currentRun) {
  const runNum = parseInt(currentRun, 10);
  if (isNaN(runNum) || runNum <= 1) return null;
  const prevRun = `run_${runNum - 1}`;
  const prevPath = join(dir, "nodes", "ux-simulation", prevRun, "ux-verdict.json");
  try {
    return { data: JSON.parse(readFileSync(prevPath, "utf8")), runId: prevRun };
  } catch {
    return null;
  }
}

// Reconstruct flag map from baseline verdict JSON
function baselineFlagMapFromVerdict(verdict) {
  const map = new Map();
  if (!verdict.uxResult || !verdict.uxResult.flagDetails) return map;
  for (const flag of verdict.uxResult.flagDetails) {
    map.set(flag.key, flag);
  }
  return map;
}

// ══════════════════════════════════════════════════════════════
// cmdUxVerdict — main command
// ══════════════════════════════════════════════════════════════
export function cmdUxVerdict(args) {
  const dir = resolveDir(args);
  const run = getFlag(args, "run");

  if (!run) {
    console.error("Usage: opc-harness ux-verdict --dir <p> --run <N>");
    process.exit(1);
  }

  const runDir = join(dir, "nodes", "ux-simulation", `run_${run}`);
  if (!existsSync(runDir)) {
    console.error(`Run directory not found: ${runDir}`);
    process.exit(1);
  }

  // Read flow-state for tier
  let tier;
  try {
    const state = JSON.parse(readFileSync(join(dir, "flow-state.json"), "utf8"));
    tier = state.tier;
  } catch (err) {
    console.error(`Cannot read flow-state.json: ${err.message}`);
    process.exit(1);
  }
  if (!tier || !VALID_TIERS.has(tier)) {
    console.error(`Invalid or missing tier '${tier}' in flow-state.json`);
    process.exit(1);
  }

  // Load overrides
  let overrides = null;
  try {
    const ovContent = readFileSync(join(dir, "red-flag-overrides.md"), "utf8");
    overrides = parseRedFlagOverrides(ovContent);
  } catch {
    // No overrides file — fine
  }

  // Read observer files
  const files = readdirSync(runDir).filter((f) => f.startsWith("observer-") && f.endsWith(".md"));
  if (files.length === 0) {
    console.log(JSON.stringify({
      verdict: "BLOCKED",
      reason: "no observer files found",
      runDir,
    }));
    process.exit(0);
  }

  const observers = [];
  const blocked = [];

  for (const file of files) {
    const path = join(runDir, file);
    const md = readFileSync(path, "utf8");
    const data = extractJSON(md);
    const persona = file.replace("observer-", "").replace(".md", "");

    if (!data) {
      blocked.push({ file, errors: ["no valid JSON block found"] });
      continue;
    }

    const errors = validateObserver(data, file);
    if (errors.length > 0) {
      blocked.push({ file, errors });
      continue;
    }

    observers.push({ persona, data, file });
  }

  // If any blocked, verdict = BLOCKED
  if (blocked.length > 0) {
    console.log(JSON.stringify({
      verdict: "BLOCKED",
      reason: "malformed observer reports",
      blocked,
      observersTotal: files.length,
      observersValid: observers.length,
    }, null, 2));
    process.exit(0);
  }

  // Aggregate
  const flagMap = aggregateRedFlags(observers, tier, overrides);
  const counts = countSeverities(flagMap);
  const trustSignals = aggregateTrustSignals(observers);
  const tierFit = tierFitConsensus(observers);

  // Delta
  const baseline = loadBaseline(dir, run);
  let delta = null;
  if (baseline) {
    const baselineFlags = baselineFlagMapFromVerdict(baseline.data);
    delta = computeDelta(flagMap, baselineFlags, baseline.runId);
  }

  // Gate logic
  const verdict = applyGateLogic(counts, tier, tierFit, delta);

  // Build output
  const result = {
    nodeId: "ux-simulation",
    nodeType: "execute",
    runId: `run_${run}`,
    status: "completed",
    verdict,
    summary: `Red flags: ${counts.critical} critical, ${counts.warning} warning. Trust signals: ${trustSignals.present.length}/${trustSignals.present.length + trustSignals.absent.length} present. ${delta ? `Delta vs ${delta.vs_run}: ${delta.regressions.length} regressions, ${delta.resolved_flags.length} resolved` : "First run (no baseline)"}`,
    timestamp: new Date().toISOString(),
    artifacts: files.map((f) => ({ type: "eval", path: `run_${run}/${f}` })),
    uxResult: {
      tier,
      observersTotal: observers.length,
      redFlags: counts,
      flagDetails: [...flagMap.values()],
      trustSignals,
      tierFitConsensus: tierFit,
      delta,
      warningThreshold: WARNING_THRESHOLDS[tier],
      warningCount: counts.warning,
    },
    findings: { critical: counts.critical, warning: counts.warning, suggestion: counts.suggestion },
  };

  // Persist verdict
  const verdictPath = join(runDir, "ux-verdict.json");
  atomicWriteSync(verdictPath, JSON.stringify(result, null, 2));

  console.log(JSON.stringify(result, null, 2));
}

// ══════════════════════════════════════════════════════════════
// cmdUxFrictionAggregate — friction report
// ══════════════════════════════════════════════════════════════
export function cmdUxFrictionAggregate(args) {
  const dir = resolveDir(args);
  const run = getFlag(args, "run");
  const output = getFlag(args, "output");

  if (!run || !output) {
    console.error("Usage: opc-harness ux-friction-aggregate --dir <p> --run <N> --output <path>");
    process.exit(1);
  }

  const runDir = join(dir, "nodes", "ux-simulation", `run_${run}`);
  if (!existsSync(runDir)) {
    console.error(`Run directory not found: ${runDir}`);
    process.exit(1);
  }

  const files = readdirSync(runDir).filter((f) => f.startsWith("observer-") && f.endsWith(".md"));
  const STAGE_ORDER = ["first-30s", "core-flow", "edge-case", "exit"];
  const byStage = {};
  for (const s of STAGE_ORDER) byStage[s] = [];

  for (const file of files) {
    const md = readFileSync(join(runDir, file), "utf8");
    const data = extractJSON(md);
    if (!data || !Array.isArray(data.friction_points)) continue;
    const persona = file.replace("observer-", "").replace(".md", "");
    for (const fp of data.friction_points) {
      const stage = VALID_STAGES.has(fp.stage) ? fp.stage : "core-flow";
      byStage[stage].push({ ...fp, persona });
    }
  }

  // Build markdown report
  const lines = ["# Friction Report", "", `Run: ${run}`, ""];
  let totalPoints = 0;
  for (const stage of STAGE_ORDER) {
    const points = byStage[stage];
    if (points.length === 0) continue;
    lines.push(`## ${stage}`, "");
    for (const fp of points) {
      lines.push(`- **[${fp.persona}]** ${fp.observation || fp.description || "no description"}`);
      if (fp.reference) lines.push(`  - Reference: ${fp.reference}`);
      totalPoints++;
    }
    lines.push("");
  }
  lines.push(`---`, `Total friction points: ${totalPoints}`);

  const report = lines.join("\n");
  atomicWriteSync(output, report);

  console.log(JSON.stringify({
    written: output,
    totalFrictionPoints: totalPoints,
    byStage: Object.fromEntries(STAGE_ORDER.map((s) => [s, byStage[s].length])),
  }, null, 2));
}
