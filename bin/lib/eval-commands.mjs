// Evaluation analysis commands: verify, synthesize, tier-baseline
// Depends on: eval-parser.mjs, tier-baselines.mjs, util.mjs

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { parseEvaluation } from "./eval-parser.mjs";
import { getFlag } from "./util.mjs";
import { checkBaselineCoverage, generateTierTestCases, VALID_TIERS, TEST_LAYERS, TEST_LAYER_KEYWORDS, TEST_LAYER_LABELS } from "./tier-baselines.mjs";

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
  let nodeId = null;
  let targetRunDir = null;

  if (nodeIdx !== -1) {
    nodeId = args[nodeIdx + 1];
    if (!nodeId) {
      console.error("--node requires a nodeId");
      process.exit(1);
    }

    const runFlag = args.indexOf("--run");

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
  const thinEvalWarnings = [];

  // --base <dir> — project root for validating file:line references in findings
  const baseDir = getFlag(args, "base", null);

  // D1: --base deprecation warning — next version makes this a hard error
  if (!baseDir) {
    console.error("⚠️  --base not provided — file:line reference validation skipped. Pass --base <project-root> to enable.");
  }

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

    // ── Thin eval detection (mechanical) ──────────────────────
    // Eval under 50 lines is too thin to be a real review — UNLESS
    // every finding has reasoning + fix + file refs (substance exemption).
    let thinEvalExempt = false;
    if (parsed.thinEval && parsed.findings_count > 0) {
      const allSubstantive = parsed.findings.every(f => f.reasoning && f.fix && f.file);
      if (allSubstantive && parsed.has_file_refs) thinEvalExempt = true;
    }
    if (parsed.thinEval && !thinEvalExempt) {
      totals.warning += 1;
      thinEvalWarnings.push(`${roleName}: eval is thin (${parsed.lineCount} lines, min 50)`);
    }
    // Review evals with zero file:line references → no grounding in code.
    if (parsed.noCodeRefs && parsed.findings_count > 0) {
      totals.warning += 1;
      thinEvalWarnings.push(`${roleName}: eval has 0 file:line references — findings not grounded in code`);
    }

    // ── Compound defense layers (probability stacking) ──────
    // Each is independently ~30% bypassable, but stacked:
    // 5 layers × 30% each = 0.3^5 = 0.24% bypass probability.

    // Layer: low unique content ratio → copy-paste padding detected
    if (parsed.lowUniqueContent) {
      totals.warning += 1;
      thinEvalWarnings.push(`${roleName}: low unique content (${parsed.uniqueRatio}% unique lines) — possible copy-paste padding`);
    }
    // Layer: single heading in a 30+ line eval → no structural diversity
    if (parsed.singleHeading) {
      totals.warning += 1;
      thinEvalWarnings.push(`${roleName}: only ${parsed.headingCount} heading(s) in ${parsed.lineCount} lines — real reviews have multiple sections`);
    }
    // Layer: findings declared but emoji density too low → bulk filler
    if (parsed.findingDensityLow) {
      totals.warning += 1;
      thinEvalWarnings.push(`${roleName}: finding density too low — ${parsed.findings_count} findings in ${parsed.lineCount} lines suggests bulk filler`);
    }
    // Layer: findings without reasoning — every finding must explain WHY
    if (parsed.findings_count > 0 && parsed.missingReasoningRatio > 50) {
      totals.warning += 1;
      thinEvalWarnings.push(`${roleName}: ${parsed.findingsWithoutReasoning}/${parsed.findings_count} findings lack reasoning — findings must explain why`);
    }
    // Layer: findings without fix suggestion — every finding must say HOW
    if (parsed.findings_count > 0 && parsed.missingFixRatio > 50) {
      totals.warning += 1;
      thinEvalWarnings.push(`${roleName}: ${parsed.findingsWithoutFix}/${parsed.findings_count} findings lack fix suggestion — findings must be actionable`);
    }
    // Layer: line length variance — uniform line lengths suggest template fill
    if (parsed.lineLengthVarianceLow) {
      totals.warning += 1;
      thinEvalWarnings.push(`${roleName}: suspiciously uniform line lengths — possible template fill`);
    }

    // Layer: file:line reality check (requires --base) — detect fabricated references
    // This is the highest-value layer because it requires findings to reference REAL code.
    let invalidRefCount = 0;
    let weakRefCount = 0;
    if (baseDir && parsed.findings.length > 0) {
      for (const f of parsed.findings) {
        if (f.file) {
          const resolved = f.file.startsWith("/") ? f.file : join(baseDir, f.file);
          if (!existsSync(resolved)) {
            invalidRefCount++;
          } else if (f.line != null) {
            try {
              const content = readFileSync(resolved, "utf8");
              const srcLines = content.split("\n");
              if (f.line < 1 || f.line > srcLines.length) {
                invalidRefCount++;
              } else {
                // Content relevance: extract source line, check token overlap with finding issue
                const srcLine = srcLines[f.line - 1].toLowerCase();
                const issueTokens = (f.issue || "").toLowerCase()
                  .replace(/[^a-z0-9_]/g, " ").split(/\s+/)
                  .filter(t => t.length >= 3); // skip noise words
                const srcTokens = srcLine.replace(/[^a-z0-9_]/g, " ").split(/\s+/)
                  .filter(t => t.length >= 3);
                if (issueTokens.length >= 2 && srcTokens.length >= 1) {
                  const shared = issueTokens.filter(t => srcTokens.some(s => s.includes(t) || t.includes(s)));
                  if (shared.length === 0) {
                    weakRefCount++;
                  }
                }
              }
            } catch { invalidRefCount++; }
          }
        }
      }
      if (invalidRefCount > 0) {
        totals.warning += invalidRefCount;
        thinEvalWarnings.push(`${roleName}: ${invalidRefCount} finding(s) reference non-existent or out-of-range file:line — fabricated refs detected`);
      }
      if (weakRefCount > 0) {
        thinEvalWarnings.push(`${roleName}: ${weakRefCount} finding(s) reference valid file:line but issue text shares no tokens with actual source — possible mismatch`);
      }
    }

    roles.push({
      role: roleName,
      critical: parsed.critical,
      warning: parsed.warning,
      suggestion: parsed.suggestion,
      blocked,
      thinEval: (parsed.thinEval && !thinEvalExempt) || false,
      thinEvalExempt: thinEvalExempt || false,
      noCodeRefs: parsed.noCodeRefs || false,
      lineCount: parsed.lineCount,
      findingsCount: parsed.findings_count || 0,
      lowUniqueContent: parsed.lowUniqueContent || false,
      singleHeading: parsed.singleHeading || false,
      findingDensityLow: parsed.findingDensityLow || false,
      missingReasoningTripped: parsed.findings_count > 0 && parsed.missingReasoningRatio > 50,
      missingFixTripped: parsed.findings_count > 0 && parsed.missingFixRatio > 50,
      lineLengthVarianceLow: parsed.lineLengthVarianceLow || false,
      invalidRefCount,
    });

    totals.critical += parsed.critical;
    totals.warning += parsed.warning;
    totals.suggestion += parsed.suggestion;
  }

  // ── D2: Compound eval quality gate ─────────────────────────────
  for (const role of roles) {
    let compoundFails = 0;
    if (role.thinEval) compoundFails++;
    if (role.noCodeRefs && role.findingsCount > 0) compoundFails++;
    if (role.lowUniqueContent) compoundFails++;
    if (role.singleHeading) compoundFails++;
    if (role.findingDensityLow) compoundFails++;
    if (role.missingReasoningTripped) compoundFails++;
    if (role.missingFixTripped) compoundFails++;
    if (role.lineLengthVarianceLow) compoundFails++;
    if (role.invalidRefCount > 0) compoundFails += 2; // weighted: fabricated refs
    role._compoundFails = compoundFails;
  }
  const qualityFailRoles = roles.filter(r => r._compoundFails >= 3);
  const noStrict = args.includes("--no-strict");
  const strict = !noStrict; // D2 enforce by default; --no-strict reverts to shadow
  let qfDetail = "";
  if (qualityFailRoles.length > 0) {
    qfDetail = qualityFailRoles.map(r => `${r.role}(${r._compoundFails} layers)`).join(", ");
  }

  let verdict, reason;
  const blockedRoles = roles.filter((r) => r.blocked);
  if (blockedRoles.length > 0) {
    verdict = "BLOCKED";
    reason = `blocked by ${blockedRoles.map((r) => r.role).join(", ")}`;
  } else if (totals.critical > 0) {
    verdict = "FAIL";
    reason = `${totals.critical} validated critical finding(s)`;
  } else if (qualityFailRoles.length > 0 && strict) {
    // D2: --strict mode enforces compound gate as hard FAIL
    verdict = "FAIL";
    reason = `eval quality gate: ${qfDetail}`;
  } else if (totals.warning > 0) {
    verdict = "ITERATE";
    reason = `${totals.warning} warning finding(s)`;
  } else {
    verdict = "PASS";
    reason = "all roles LGTM or suggestions only";
  }

  // ── D3: Iteration escalation ──────────────────────────────────
  const iterationN = getFlag(args, "iteration", null);
  if (iterationN && parseInt(iterationN) >= 2 && thinEvalWarnings.length > 0) {
    verdict = "FAIL";
    reason = `eval quality warnings persist after ${iterationN} iterations — escalating to FAIL`;
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

  // ── Test plan layer coverage check (for test-design nodes) ──────
  // Keyword-based: checks that test-plan.md mentions all 5 test layers.
  // Honest caveat: LLM can write a section header without real content.
  // But this is better than 0 check — forces the label to exist.
  let testPlanCoverage = null;
  if (nodeId && (nodeId.includes("test-design") || nodeId.includes("test_design"))) {
    const testPlanPath = targetRunDir ? join(targetRunDir, "test-plan.md") : null;
    // Also check node-level test-plan.md
    const nodeTestPlanPath = nodeId ? join(dir, "nodes", nodeId, "test-plan.md") : null;
    let planText = null;

    if (testPlanPath && existsSync(testPlanPath)) {
      planText = readFileSync(testPlanPath, "utf8");
    } else if (nodeTestPlanPath && existsSync(nodeTestPlanPath)) {
      planText = readFileSync(nodeTestPlanPath, "utf8");
    }

    if (planText) {
      const lowerPlan = planText.toLowerCase();
      const planLines = planText.split("\n");
      const covered = [];
      const missing = [];
      const shallow = [];
      for (const layer of TEST_LAYERS) {
        const keywords = TEST_LAYER_KEYWORDS[layer];
        const found = keywords.some(kw => lowerPlan.includes(kw));
        if (found) {
          covered.push(layer);
        } else {
          missing.push({ layer, label: TEST_LAYER_LABELS[layer] });
          totals.warning += 1;
        }
      }

      // ── Compound defense: section depth check ─────────────
      // For each covered layer, find the section and verify it has ≥3
      // non-empty lines of actual content (not just a heading).
      // Bypass probability: ~20% (must write 3+ real lines per section).
      for (const layer of covered) {
        const keywords = TEST_LAYER_KEYWORDS[layer];
        // Find heading line that contains a layer keyword
        let sectionStart = -1;
        for (let i = 0; i < planLines.length; i++) {
          const lower = planLines[i].toLowerCase();
          if (/^#{1,3}\s/.test(planLines[i]) && keywords.some(kw => lower.includes(kw))) {
            sectionStart = i;
            break;
          }
        }
        if (sectionStart === -1) continue;

        // Count non-empty content lines until next heading or EOF
        let contentLines = 0;
        for (let i = sectionStart + 1; i < planLines.length; i++) {
          if (/^#{1,3}\s/.test(planLines[i])) break;
          if (planLines[i].trim().length > 0) contentLines++;
        }
        if (contentLines < 3) {
          shallow.push({ layer, label: TEST_LAYER_LABELS[layer], contentLines });
          totals.warning += 1;
        }
      }

      // ── Compound defense: actionable command density ──────
      // Real test plans contain executable commands. Zero commands = suspicious.
      // Matches: npm test, npx ..., pytest, vitest, jest, playwright, curl, etc.
      const CMD_RE = /\b(npm\s+(test|run)|npx\s+\w|pytest|vitest|jest|playwright\s+test|curl\s+|bash\s+|sh\s+|node\s+|python[3]?\s+)/i;
      const cmdLineCount = planLines.filter(l => CMD_RE.test(l)).length;
      const noActionableCommands = cmdLineCount === 0 && planLines.length >= 10;

      testPlanCoverage = { covered, missing, shallow: shallow.length > 0 ? shallow : undefined, cmdLineCount, noActionableCommands: noActionableCommands || undefined };

      if (noActionableCommands) {
        totals.warning += 1;
      }

      const issues = [];
      if (missing.length > 0) issues.push(`missing layers: ${missing.map(m => m.layer).join(", ")}`);
      if (shallow.length > 0) issues.push(`shallow sections: ${shallow.map(s => s.layer).join(", ")}`);
      if (noActionableCommands) issues.push("0 actionable commands in test plan");

      if (issues.length > 0) {
        if (verdict === "PASS") {
          verdict = "ITERATE";
          reason = `${reason}; test plan: ${issues.join("; ")}`;
        } else if (verdict === "ITERATE") {
          reason = `${reason}; test plan: ${issues.join("; ")}`;
        }
      }
    }
  }

  console.log(JSON.stringify({
    roles, totals, verdict, reason, tierCoverage,
    thinEvalWarnings: thinEvalWarnings.length > 0 ? thinEvalWarnings : undefined,
    evalQualityGate: qualityFailRoles.length > 0
      ? { triggered: true, mode: strict ? "enforce" : "shadow", roles: qfDetail }
      : undefined,
    testPlanCoverage: testPlanCoverage || undefined,
  }, null, 2));
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
