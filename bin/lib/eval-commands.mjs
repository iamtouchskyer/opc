// Evaluation analysis commands: verify, synthesize, tier-baseline
// Depends on: eval-parser.mjs, tier-baselines.mjs, util.mjs

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { parseEvaluation } from "./eval-parser.mjs";
import { getFlag } from "./util.mjs";
import { checkBaselineCoverage, generateTierTestCases, VALID_TIERS } from "./tier-baselines.mjs";

export function cmdVerify(args) {
  const file = args[0];
  if (!file) {
    console.error("Usage: opc-harness verify <file> [--base <dir>]");
    process.exit(1);
  }

  // --base <dir> — root for resolving finding file:line refs (default: cwd)
  const base = getFlag(args, "base", process.cwd());

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`File not found: ${file}`);
    } else {
      console.error(`Cannot read ${file}: ${err.message}`);
    }
    process.exit(1);
  }
  const result = parseEvaluation(text);

  const findingsWithoutRefs = [];
  const criticalWithoutFix = [];
  const findingsWithoutReasoning = [];
  const invalidFileRefs = [];

  // Cache line counts to avoid re-reading the same file
  const lineCountCache = new Map();
  const getLineCount = (path) => {
    if (lineCountCache.has(path)) return lineCountCache.get(path);
    try {
      const content = readFileSync(path, "utf8");
      const count = content.split("\n").length;
      lineCountCache.set(path, count);
      return count;
    } catch {
      lineCountCache.set(path, -1);
      return -1;
    }
  };

  for (let i = 0; i < result.findings.length; i++) {
    const f = result.findings[i];
    const label = `#${i + 1} [${f.severity}] ${f.file || "no-file"}:${f.line || "?"} \u2014 ${(f.issue || "").slice(0, 60)}`;

    if (!f.file) {
      findingsWithoutRefs.push(label);
    }
    if (f.severity === "critical" && !f.fix) {
      criticalWithoutFix.push(label);
    }
    if (!f.reasoning) {
      findingsWithoutReasoning.push(label);
    }

    // ─── Gap 1: file:line reality check ───────────────────────
    // An evaluator that invents file:line references is producing fake
    // findings. We verify the file exists and the line number is valid.
    if (f.file) {
      // Resolve relative to --base (skip absolute paths — leave as-is)
      const resolved = f.file.startsWith("/") ? f.file : join(base, f.file);
      if (!existsSync(resolved)) {
        invalidFileRefs.push({
          index: i + 1,
          file: f.file,
          line: f.line,
          severity: f.severity,
          reason: "file does not exist",
        });
      } else if (f.line != null) {
        const lineCount = getLineCount(resolved);
        if (lineCount === -1) {
          invalidFileRefs.push({
            index: i + 1,
            file: f.file,
            line: f.line,
            severity: f.severity,
            reason: "file unreadable",
          });
        } else if (f.line < 1 || f.line > lineCount) {
          invalidFileRefs.push({
            index: i + 1,
            file: f.file,
            line: f.line,
            severity: f.severity,
            reason: `line ${f.line} outside file (1-${lineCount})`,
          });
        }
      }
    }
  }

  const evidenceComplete =
    findingsWithoutRefs.length === 0 &&
    criticalWithoutFix.length === 0 &&
    findingsWithoutReasoning.length === 0 &&
    invalidFileRefs.length === 0;

  const { findings, ...output } = result;
  output.findings_without_refs = findingsWithoutRefs;
  output.critical_without_fix = criticalWithoutFix;
  output.findings_without_reasoning = findingsWithoutReasoning;
  output.invalid_file_refs = invalidFileRefs;
  output.invalid_file_refs_count = invalidFileRefs.length;
  output.evidence_complete = evidenceComplete;
  console.log(JSON.stringify(output, null, 2));
}

// Note: synthesize assumes findings are bugs/issues (review use case).
export function cmdSynthesize(args) {
  const dir = args[0];
  const waveIdx = args.indexOf("--wave");
  const nodeIdx = args.indexOf("--node");

  if (!dir || (waveIdx === -1 && nodeIdx === -1)) {
    console.error("Usage: opc-harness synthesize <dir> --wave <N>           (legacy: dir = project root)");
    console.error("       opc-harness synthesize <dir> --node <nodeId> [--run <N>]  (dir = .harness/ path)");
    process.exit(1);
  }

  let files;

  if (nodeIdx !== -1) {
    const nodeId = args[nodeIdx + 1];
    if (!nodeId) {
      console.error("--node requires a nodeId");
      process.exit(1);
    }

    const runFlag = args.indexOf("--run");
    let targetRunDir;

    if (runFlag !== -1 && args[runFlag + 1]) {
      targetRunDir = join(dir, "nodes", nodeId, `run_${args[runFlag + 1]}`);
    } else {
      const nodeDir = join(dir, "nodes", nodeId);
      try {
        const runs = readdirSync(nodeDir)
          .filter((d) => d.startsWith("run_"))
          .sort((a, b) => {
            const na = parseInt(a.replace("run_", ""), 10);
            const nb = parseInt(b.replace("run_", ""), 10);
            return nb - na;
          });
        if (runs.length === 0) {
          console.error(`No runs found for node '${nodeId}' in ${nodeDir}`);
          process.exit(1);
        }
        targetRunDir = join(nodeDir, runs[0]);
      } catch (err) {
        console.error(`Cannot read node dir ${nodeDir}: ${err.message}`);
        process.exit(1);
      }
    }

    try {
      files = readdirSync(targetRunDir)
        .filter((f) => f.startsWith("eval") && f.endsWith(".md"))
        .map((f) => ({ name: f, path: join(targetRunDir, f) }));
    } catch (err) {
      console.error(`Cannot read ${targetRunDir}: ${err.message}`);
      process.exit(1);
    }

    if (files.length === 0) {
      console.error(`No eval-*.md files in ${targetRunDir}`);
      process.exit(1);
    }
  } else {
    const wave = args[waveIdx + 1];
    if (!wave) {
      console.error("--wave requires a wave number");
      process.exit(1);
    }

    const prefix = `evaluation-wave-${wave}-`;
    const mergedName = `evaluation-wave-${wave}.md`;
    const harnessDir = join(dir, ".harness");

    const ROUND_RE = /^evaluation-wave-\d+-round\d+/;
    try {
      files = readdirSync(harnessDir)
        .filter(
          (f) => f.startsWith(prefix) && f.endsWith(".md") && f !== mergedName && !ROUND_RE.test(f)
        )
        .map((f) => ({ name: f, path: join(harnessDir, f) }));
    } catch (err) {
      console.error(`Cannot read ${harnessDir}: ${err.message}`);
      process.exit(1);
    }

    if (files.length === 0) {
      console.error(`No evaluation files matching ${prefix}*.md in ${harnessDir}`);
      process.exit(1);
    }
  }

  const roles = [];
  const totals = { critical: 0, warning: 0, suggestion: 0 };

  for (const f of files) {
    let roleName;
    if (f.name.startsWith("eval-")) {
      roleName = f.name.replace("eval-", "").replace(/\.md$/, "");
    } else if (f.name === "eval.md") {
      roleName = "evaluator";
    } else {
      const prefix = f.name.match(/^evaluation-wave-\d+-(.+)\.md$/);
      roleName = prefix ? prefix[1] : f.name.replace(/\.md$/, "");
    }

    let text;
    try {
      text = readFileSync(f.path, "utf8");
    } catch (readErr) {
      console.error(`⚠️  Cannot read ${f.path}: ${readErr.message}`);
      continue;
    }
    const parsed = parseEvaluation(text);

    const blocked = /BLOCKED/i.test(parsed.verdict);
    roles.push({
      role: roleName,
      critical: parsed.critical,
      warning: parsed.warning,
      suggestion: parsed.suggestion,
      blocked,
    });

    totals.critical += parsed.critical;
    totals.warning += parsed.warning;
    totals.suggestion += parsed.suggestion;
  }

  let verdict, reason;
  const blockedRoles = roles.filter((r) => r.blocked);
  if (blockedRoles.length > 0) {
    verdict = "BLOCKED";
    reason = `blocked by ${blockedRoles.map((r) => r.role).join(", ")}`;
  } else if (totals.critical > 0) {
    verdict = "FAIL";
    reason = `${totals.critical} validated critical finding(s)`;
  } else if (totals.warning > 0) {
    verdict = "ITERATE";
    reason = `${totals.warning} warning finding(s)`;
  } else {
    verdict = "PASS";
    reason = "all roles LGTM or suggestions only";
  }

  // ── Tier baseline coverage check ──────────────────────────────
  let tierCoverage = null;
  if (nodeIdx !== -1) {
    try {
      const harnessDir = dir;
      const statePath = join(harnessDir, "flow-state.json");
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        if (state.tier && VALID_TIERS.has(state.tier)) {
          // Concatenate all eval text for coverage check
          const allEvalText = files.map((f) => {
            try { return readFileSync(f.path, "utf8"); } catch { return ""; }
          }).join("\n");
          const coverage = checkBaselineCoverage(allEvalText, state.tier);
          tierCoverage = {
            tier: state.tier,
            covered: coverage.covered.length,
            uncovered: coverage.uncovered.length,
            uncoveredItems: coverage.uncovered,
          };
          // Uncovered baseline items with severity >= warning become warnings in synthesize output
          for (const item of coverage.uncovered) {
            if (item.severity === "warning" || item.severity === "critical") {
              totals.warning += 1;
              // Re-evaluate verdict — uncovered tier items are treated as warnings
              if (verdict === "PASS") {
                verdict = "ITERATE";
                reason = `${reason}; tier baseline items uncovered`;
              }
            }
          }
        }
      }
    } catch { /* flow-state unreadable — skip tier check */ }
  }

  console.log(JSON.stringify({ roles, totals, verdict, reason, tierCoverage }, null, 2));
}

// ─── tier-baseline ──────────────────────────────────────────────

export function cmdTierBaseline(args) {
  const tier = getFlag(args, "tier");

  if (!tier) {
    console.error("Usage: opc-harness tier-baseline --tier <functional|polished|delightful>");
    process.exit(1);
  }

  if (!VALID_TIERS.has(tier)) {
    console.log(JSON.stringify({ error: `invalid tier: '${tier}' (expected: ${[...VALID_TIERS].join(", ")})`, testCases: [] }));
    return;
  }

  const testCases = generateTierTestCases(tier);
  console.log(JSON.stringify({ tier, total: testCases.length, testCases }, null, 2));
}
