// audit.mjs — Process conformance metrics across OPC sessions
// Mechanical checks only — no LLM, no network.

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import { getFlag, getSessionsBaseDir } from "./util.mjs";

const THIN_EVAL_THRESHOLD = 50; // lines

// ── Helpers ─────────────────────────────────────────────────────

function scanSessions(projectDir) {
  const sessions = [];
  try {
    const base = getSessionsBaseDir(projectDir);
    if (!existsSync(base)) return sessions;
    const entries = readdirSync(base, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "latest") continue;
      const dir = join(base, e.name);
      const sp = join(dir, "flow-state.json");
      if (!existsSync(sp)) continue;
      try {
        const state = JSON.parse(readFileSync(sp, "utf8"));
        const st = statSync(sp);
        sessions.push({ dir, id: e.name, state, mtime: st.mtime });
      } catch { /* corrupt */ }
    }
  } catch { /* no sessions dir */ }
  return sessions.sort((a, b) => a.mtime - b.mtime);
}

function findEvalFiles(sessionDir) {
  // Returns [{nodeId, runId, file, path, lineCount}]
  const results = [];
  const nodesDir = join(sessionDir, "nodes");
  if (!existsSync(nodesDir)) return results;

  try {
    for (const nodeEntry of readdirSync(nodesDir, { withFileTypes: true })) {
      if (!nodeEntry.isDirectory()) continue;
      const nodeDir = join(nodesDir, nodeEntry.name);
      // Scan run_* dirs
      for (const runEntry of readdirSync(nodeDir, { withFileTypes: true })) {
        if (!runEntry.isDirectory() || !runEntry.name.startsWith("run_")) continue;
        const runDir = join(nodeDir, runEntry.name);
        for (const f of readdirSync(runDir)) {
          if (f.startsWith("eval") && f.endsWith(".md")) {
            const fp = join(runDir, f);
            try {
              const content = readFileSync(fp, "utf8");
              results.push({
                nodeId: nodeEntry.name,
                runId: runEntry.name,
                file: f,
                path: fp,
                lineCount: content.split("\n").length,
              });
            } catch { /* unreadable */ }
          }
        }
      }
    }
  } catch { /* unreadable */ }
  return results;
}

function extractRoleName(evalFileName) {
  // eval-frontend.md → frontend, eval-skeptic-owner.md → skeptic-owner
  if (evalFileName === "eval.md") return "evaluator";
  return evalFileName.replace(/^eval-/, "").replace(/\.md$/, "");
}

// ── Conformance Checks ──────────────────────────────────────────

function checkSkepticOwner(evalFiles) {
  const skepticNames = new Set(["skeptic-owner", "devil-advocate"]);
  return evalFiles.some(e => skepticNames.has(extractRoleName(e.file)));
}

function checkRoleDiversity(evalFiles) {
  // Group by nodeId, check each review node has ≥2 distinct evals
  const byNode = {};
  for (const e of evalFiles) {
    if (!byNode[e.nodeId]) byNode[e.nodeId] = new Set();
    byNode[e.nodeId].add(extractRoleName(e.file));
  }
  const nodes = Object.values(byNode);
  if (nodes.length === 0) return null;
  const passing = nodes.filter(roles => roles.size >= 2).length;
  return passing / nodes.length;
}

function checkEvalDepth(evalFiles) {
  if (evalFiles.length === 0) return null;
  const nonThin = evalFiles.filter(e => e.lineCount >= THIN_EVAL_THRESHOLD).length;
  return nonThin / evalFiles.length;
}

function checkNoManualBypass(state) {
  if (!Array.isArray(state.history)) return true;
  return !state.history.some(h => h.skipped || h.forcePassed);
}

function checkAcceptanceCriteria(sessionDir) {
  return existsSync(join(sessionDir, "acceptance-criteria.md"));
}

function checkFlowCompleted(state) {
  return state.status === "completed" || state.status === "finalized";
}

// ── Main ────────────────────────────────────────────────────────

export function cmdAudit(args) {
  const format = getFlag(args, "format", "table");
  const lastN = getFlag(args, "last", null);
  const projectDir = getFlag(args, "base", process.cwd());

  let sessions = scanSessions(projectDir);

  if (lastN) {
    sessions = sessions.slice(-parseInt(lastN, 10));
  }

  if (sessions.length === 0) {
    console.error("No OPC sessions found.");
    process.exit(1);
  }

  const scorecards = [];

  for (const { dir, id, state, mtime } of sessions) {
    const evalFiles = findEvalFiles(dir);
    const checks = {
      skeptic_owner_present: checkSkepticOwner(evalFiles),
      role_diversity: checkRoleDiversity(evalFiles),
      eval_depth: checkEvalDepth(evalFiles),
      no_manual_bypass: checkNoManualBypass(state),
      acceptance_criteria_exists: checkAcceptanceCriteria(dir),
      flow_completed: checkFlowCompleted(state),
    };

    // Conformance score: average of non-null checks (bools → 1/0, ratios as-is)
    const values = Object.values(checks).filter(v => v !== null);
    const numericValues = values.map(v => (v === true ? 1 : v === false ? 0 : v));
    const conformanceScore = numericValues.length > 0
      ? numericValues.reduce((a, b) => a + b, 0) / numericValues.length
      : null;

    scorecards.push({
      id,
      flow: state.flowTemplate || "unknown",
      tier: state.tier || null,
      timestamp: mtime.toISOString(),
      totalSteps: state.totalSteps || 0,
      evalFileCount: evalFiles.length,
      checks,
      conformance_score: conformanceScore != null ? Math.round(conformanceScore * 100) / 100 : null,
    });
  }

  // Aggregate
  const validScores = scorecards.filter(s => s.conformance_score != null).map(s => s.conformance_score);
  const avgConformance = validScores.length > 0
    ? Math.round((validScores.reduce((a, b) => a + b, 0) / validScores.length) * 100) / 100
    : null;

  // Worst check: which check fails most often
  const checkFailCounts = {};
  for (const sc of scorecards) {
    for (const [k, v] of Object.entries(sc.checks)) {
      if (v === false || (typeof v === "number" && v < 0.5)) {
        checkFailCounts[k] = (checkFailCounts[k] || 0) + 1;
      }
    }
  }
  const worstCheck = Object.entries(checkFailCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Weekly trend (group by ISO week)
  const weeklyGroups = {};
  for (const sc of scorecards) {
    if (sc.conformance_score == null) continue;
    const d = new Date(sc.timestamp);
    const week = `${d.getFullYear()}-W${String(Math.ceil(((d - new Date(d.getFullYear(), 0, 1)) / 86400000 + 1) / 7)).padStart(2, "0")}`;
    if (!weeklyGroups[week]) weeklyGroups[week] = [];
    weeklyGroups[week].push(sc.conformance_score);
  }
  const trend = Object.entries(weeklyGroups)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, scores]) => ({
      week,
      avg: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
      count: scores.length,
    }));

  const output = {
    sessions: scorecards,
    aggregate: {
      total_sessions: scorecards.length,
      avg_conformance: avgConformance,
      worst_check: worstCheck,
      worst_check_fail_count: checkFailCounts[worstCheck] || 0,
      trend,
    },
  };

  if (format === "json") {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Table format
  console.log(`\n  OPC Process Conformance Audit — ${scorecards.length} session(s)\n`);
  const pad = (s, n) => s.slice(0, n).padEnd(n);
  console.log(`  ${pad("Session",24)} ${pad("Flow",14)} ${pad("Tier",5)} Skept Div   Depth NoBP  AC    Done  Score`);
  console.log("  " + "─".repeat(100));

  for (const sc of scorecards) {
    const c = sc.checks;
    const fmt = (v) => v === null ? " — " : v === true ? " ✓  " : v === false ? " ✗  " : `${(v * 100).toFixed(0).padStart(3)}%`;
    const score = sc.conformance_score != null ? (sc.conformance_score * 100).toFixed(0) + "%" : "—";
    console.log(`  ${pad(sc.id,24)} ${pad(sc.flow||"?",14)} ${pad(sc.tier||"—",5)} ${fmt(c.skeptic_owner_present)} ${fmt(c.role_diversity)} ${fmt(c.eval_depth)} ${fmt(c.no_manual_bypass)} ${fmt(c.acceptance_criteria_exists)} ${fmt(c.flow_completed)} ${score}`);
  }

  console.log("\n  " + "─".repeat(100));
  console.log(`  Avg conformance: ${avgConformance != null ? (avgConformance * 100).toFixed(0) + "%" : "—"}`);
  if (worstCheck) console.log(`  Worst check: ${worstCheck} (failed in ${checkFailCounts[worstCheck]}/${scorecards.length} sessions)`);
  if (trend.length > 1) {
    console.log(`  Trend: ${trend.map(t => `${t.week}:${(t.avg * 100).toFixed(0)}%`).join(" → ")}`);
  }
  console.log();
}
