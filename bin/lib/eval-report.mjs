// Evaluation reporting commands: report, diff
// Depends on: eval-parser.mjs, util.mjs

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { parseEvaluation } from "./eval-parser.mjs";
import { getFlag } from "./util.mjs";

const ROLE_FILE_RE = /^evaluation-wave-\d+-(?!round\d)(.+)\.md$/;
const SINGLE_EVAL_RE = /^evaluation-wave-(\d+)\.md$/;
const NODE_EVAL_RE = /^eval-(.+)\.md$/;

function processEvalFile(filepath, roleName) {
  const text = readFileSync(filepath, "utf8");
  const parsed = parseEvaluation(text);
  const scope = [...new Set(parsed.findings.map((fd) => fd.file).filter(Boolean))];
  return {
    agent: {
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
    },
    accepted: parsed.findings.filter((fd) => fd.status === "accepted"),
  };
}

function resolveReportDir(dir) {
  if (existsSync(join(dir, "flow-state.json"))) return dir;
  return join(dir, ".harness");
}

function collectRootEvalEntries(harnessDir) {
  const files = readdirSync(harnessDir);
  const roleFiles = files.filter((f) => ROLE_FILE_RE.test(f));
  if (roleFiles.length > 0) {
    return roleFiles.map((f) => ({
      path: join(harnessDir, f),
      role: f.match(ROLE_FILE_RE)[1],
    }));
  }
  return files.filter((f) => SINGLE_EVAL_RE.test(f)).map((f) => ({
    path: join(harnessDir, f),
    role: "evaluator",
  }));
}

function collectNodeEvalEntries(harnessDir) {
  const nodesDir = join(harnessDir, "nodes");
  if (!existsSync(nodesDir)) return [];
  const entries = [];
  for (const nodeId of readdirSync(nodesDir).sort()) {
    const nodeDir = join(nodesDir, nodeId);
    if (!statSync(nodeDir).isDirectory()) continue;
    const dirs = [nodeDir];
    for (const child of readdirSync(nodeDir).sort()) {
      const childDir = join(nodeDir, child);
      if (statSync(childDir).isDirectory()) dirs.push(childDir);
    }
    for (const dir of dirs) {
      for (const file of readdirSync(dir).sort()) {
        const match = file.match(NODE_EVAL_RE);
        if (!match) continue;
        entries.push({ path: join(dir, file), role: `${nodeId}/${match[1]}` });
      }
    }
  }
  return entries;
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

  const harnessDir = resolveReportDir(dir);
  let evalEntries;
  try {
    evalEntries = [
      ...collectRootEvalEntries(harnessDir),
      ...collectNodeEvalEntries(harnessDir),
    ];
  } catch (err) {
    console.error(`Cannot read ${harnessDir}: ${err.message}`);
    process.exit(1);
  }

  const agents = [];
  const summary = { critical: 0, warning: 0, suggestion: 0 };

  for (const entry of evalEntries) {
    const { agent, accepted } = processEvalFile(entry.path, entry.role);
    agents.push(agent);
    for (const fd of accepted) summary[fd.severity]++;
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
