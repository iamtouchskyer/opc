// Evaluation reporting commands: report, diff
// Depends on: eval-parser.mjs, util.mjs

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseEvaluation } from "./eval-parser.mjs";
import { getFlag } from "./util.mjs";

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
