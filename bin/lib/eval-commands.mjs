// Evaluation analysis commands: verify, synthesize, report, diff
// Depends on: eval-parser.mjs (parseEvaluation)

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseEvaluation } from "./eval-parser.mjs";

function getFlag(args, name, fallback = null) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] != null ? args[idx + 1] : fallback;
}

export function cmdVerify(args) {
  const file = args[0];
  if (!file) {
    console.error("Usage: opc-harness verify <file>");
    process.exit(1);
  }

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

  for (let i = 0; i < result.findings.length; i++) {
    const f = result.findings[i];
    const label = `#${i + 1} [${f.severity}] ${f.file || "no-file"}:${f.line || "?"} — ${(f.issue || "").slice(0, 60)}`;

    if (!f.file) {
      findingsWithoutRefs.push(label);
    }
    if (f.severity === "critical" && !f.fix) {
      criticalWithoutFix.push(label);
    }
    if (!f.reasoning) {
      findingsWithoutReasoning.push(label);
    }
  }

  const evidenceComplete =
    findingsWithoutRefs.length === 0 &&
    criticalWithoutFix.length === 0 &&
    findingsWithoutReasoning.length === 0;

  const { findings, ...output } = result;
  output.findings_without_refs = findingsWithoutRefs;
  output.critical_without_fix = criticalWithoutFix;
  output.findings_without_reasoning = findingsWithoutReasoning;
  output.evidence_complete = evidenceComplete;
  console.log(JSON.stringify(output, null, 2));
}

// Note: synthesize assumes findings are bugs/issues (review use case). For brainstorm/analysis
// tasks, findings are context markers, not defects — use single evaluator path (skip synthesize).
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

    const text = readFileSync(f.path, "utf8");
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

  console.log(JSON.stringify({ roles, totals, verdict, reason }, null, 2));
}

export function cmdReport(args) {
  const dir = args[0];
  if (!dir) {
    console.error(
      "Usage: opc-harness report <dir> --mode <mode> --task <task> [--challenged N] [--dismissed N] [--downgraded N]"
    );
    process.exit(1);
  }

  const mode = getFlag(args, "mode");
  const task = getFlag(args, "task");
  if (!mode || !task) {
    console.error("--mode and --task are required");
    process.exit(1);
  }

  const challenged = parseInt(getFlag(args, "challenged", "0"), 10);
  const dismissed = parseInt(getFlag(args, "dismissed", "0"), 10);
  const downgraded = parseInt(getFlag(args, "downgraded", "0"), 10);

  const harnessDir = join(dir, ".harness");
  const ROLE_FILE_RE = /^evaluation-wave-\d+-(?!round\d)(.+)\.md$/;
  const SINGLE_EVAL_RE = /^evaluation-wave-(\d+)\.md$/;
  let roleFiles;
  try {
    roleFiles = readdirSync(harnessDir).filter((f) => ROLE_FILE_RE.test(f));
  } catch (err) {
    console.error(`Cannot read ${harnessDir}: ${err.message}`);
    process.exit(1);
  }

  let singleEvalFiles = [];
  if (roleFiles.length === 0) {
    try {
      singleEvalFiles = readdirSync(harnessDir).filter((f) => SINGLE_EVAL_RE.test(f));
    } catch { /* already handled */ }
  }

  const agents = [];
  const summary = { critical: 0, warning: 0, suggestion: 0 };

  for (const f of roleFiles) {
    const roleMatch = f.match(/^evaluation-wave-\d+-(.+)\.md$/);
    if (!roleMatch) continue;
    const roleName = roleMatch[1];

    const text = readFileSync(join(harnessDir, f), "utf8");
    const parsed = parseEvaluation(text);

    const scope = [
      ...new Set(parsed.findings.map((fd) => fd.file).filter(Boolean)),
    ];

    agents.push({
      role: roleName,
      scope,
      verdict: parsed.verdict,
      findings: parsed.findings.map((fd) => ({
        severity: fd.severity,
        file: fd.file,
        line: fd.line,
        issue: fd.issue,
        fix: fd.fix,
        reasoning: fd.reasoning,
        status: fd.status,
        dismissReason: fd.dismissReason,
      })),
    });

    for (const fd of parsed.findings) {
      if (fd.status === "accepted") {
        summary[fd.severity]++;
      }
    }
  }

  for (const f of singleEvalFiles) {
    const text = readFileSync(join(harnessDir, f), "utf8");
    const parsed = parseEvaluation(text);

    const scope = [
      ...new Set(parsed.findings.map((fd) => fd.file).filter(Boolean)),
    ];

    agents.push({
      role: "evaluator",
      scope,
      verdict: parsed.verdict,
      findings: parsed.findings.map((fd) => ({
        severity: fd.severity,
        file: fd.file,
        line: fd.line,
        issue: fd.issue,
        fix: fd.fix,
        reasoning: fd.reasoning,
        status: fd.status,
        dismissReason: fd.dismissReason,
      })),
    });

    for (const fd of parsed.findings) {
      if (fd.status === "accepted") {
        summary[fd.severity]++;
      }
    }
  }

  const report = {
    version: "1.0",
    timestamp: new Date().toISOString(),
    mode,
    task,
    agents,
    coordinator: { challenged, dismissed, downgraded },
    summary,
    timeline: [],
  };

  console.log(JSON.stringify(report, null, 2));
}

export function cmdDiff(args) {
  const [file1, file2] = args;
  if (!file1 || !file2) {
    console.error("Usage: opc-harness diff <file1> <file2>");
    process.exit(1);
  }

  function extractKeys(findings) {
    return findings.map((f) => {
      const fileKey = f.file || "";
      const norm = (f.issue || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
      return { key: `${fileKey}:${norm}`, finding: f };
    });
  }

  let text1, text2;
  try {
    text1 = readFileSync(file1, "utf8");
  } catch (err) {
    console.log(JSON.stringify({ error: `Cannot read ${file1}: ${err.message}` }));
    return;
  }
  try {
    text2 = readFileSync(file2, "utf8");
  } catch (err) {
    console.log(JSON.stringify({ error: `Cannot read ${file2}: ${err.message}` }));
    return;
  }

  const parsed1 = parseEvaluation(text1);
  const parsed2 = parseEvaluation(text2);

  const keyed1 = extractKeys(parsed1.findings);
  const keyed2 = extractKeys(parsed2.findings);

  const keys1 = new Set(keyed1.map((k) => k.key));
  const keys2 = new Set(keyed2.map((k) => k.key));

  const recurringKeys = [...keys1].filter((k) => keys2.has(k));
  const newKeys = [...keys2].filter((k) => !keys1.has(k));
  const resolvedKeys = [...keys1].filter((k) => !keys2.has(k));

  const keyed1Map = Object.fromEntries(keyed1.map((k) => [k.key, k.finding]));
  const keyed2Map = Object.fromEntries(keyed2.map((k) => [k.key, k.finding]));

  const recurringDetails = recurringKeys.map((key) => ({
    file: keyed1Map[key].file,
    issue_key: key.slice(0, 80),
    severity_changed: keyed1Map[key].severity !== keyed2Map[key].severity,
  }));

  const round1 = parsed1.findings.length;
  const oscillation = round1 > 0 ? recurringKeys.length / round1 > 0.6 : false;

  const result = {
    round1_findings: round1,
    round2_findings: parsed2.findings.length,
    recurring: recurringKeys.length,
    new: newKeys.length,
    resolved: resolvedKeys.length,
    oscillation,
    recurring_details: recurringDetails,
  };

  console.log(JSON.stringify(result, null, 2));
}
