#!/usr/bin/env node

import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";

// ─── Shared parsing ──────────────────────────────────────────────

const SEVERITY_MAP = {
  "🔴": "critical",
  "🟡": "warning",
  "🔵": "suggestion",
};

const SEVERITY_RE = /(?:\[?)(🔴|🟡|🔵)(?:\]?)/;
const FILE_REF_RE = /[\w./-]+\.\w+:\d+/;
const HEDGING_RE = /\bmight\b|\bcould potentially\b|\bconsider\b/i;
const VERDICT_RE = /VERDICT:\s*(.+)/i;
const FINDINGS_N_RE = /FINDINGS\s*\[(\d+)\]/i;

function parseEvaluation(text) {
  const lines = text.split("\n");

  let verdictPresent = false;
  let verdict = "";
  const severityCounts = { critical: 0, warning: 0, suggestion: 0 };
  let hasFileRefs = false;
  const hedgingDetected = [];
  const findings = [];

  let currentFinding = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Verdict detection
    const verdictMatch = trimmed.match(VERDICT_RE);
    if (verdictMatch) {
      verdictPresent = true;
      verdict = verdictMatch[1].trim();
    }

    // File reference detection
    if (FILE_REF_RE.test(trimmed)) {
      hasFileRefs = true;
    }

    // Severity / finding detection
    const sevMatch = trimmed.match(SEVERITY_RE);
    if (sevMatch) {
      const severity = SEVERITY_MAP[sevMatch[1]];
      severityCounts[severity]++;

      // Parse finding details
      const fileMatch = trimmed.match(FILE_REF_RE);
      const dashIdx = trimmed.indexOf("—");
      const issue = dashIdx !== -1 ? trimmed.slice(dashIdx + 1).trim() : trimmed;

      let filePath = null;
      let fileLine = null;
      if (fileMatch) {
        const parts = fileMatch[0].split(":");
        filePath = parts[0];
        fileLine = parseInt(parts[1], 10);
      }

      // Flush previous finding
      if (currentFinding) findings.push(currentFinding);

      currentFinding = {
        severity,
        file: filePath,
        line: fileLine,
        issue,
        fix: null,
        reasoning: null,
        status: "accepted",
        dismissReason: null,
      };

      // Hedging check on finding lines (not headings)
      if (!trimmed.startsWith("#") && HEDGING_RE.test(trimmed)) {
        hedgingDetected.push(`line ${lineNum}: '${trimmed}'`);
      }
      continue;
    }

    // Fix line (belongs to current finding)
    if (currentFinding && trimmed.startsWith("→")) {
      currentFinding.fix = trimmed.slice(1).trim();
      continue;
    }

    // Reasoning line
    if (currentFinding && /^reasoning:/i.test(trimmed)) {
      currentFinding.reasoning = trimmed.replace(/^reasoning:\s*/i, "").trim();
      continue;
    }

    // Hedging in non-heading, non-finding lines that are part of findings context
    if (
      currentFinding &&
      !trimmed.startsWith("#") &&
      trimmed.length > 0 &&
      HEDGING_RE.test(trimmed)
    ) {
      hedgingDetected.push(`line ${lineNum}: '${trimmed}'`);
    }
  }

  // Flush last finding
  if (currentFinding) findings.push(currentFinding);

  const findingsCount =
    severityCounts.critical + severityCounts.warning + severityCounts.suggestion;

  // Verdict count match
  let verdictCountMatch = true;
  const fnMatch = verdict.match(FINDINGS_N_RE);
  if (fnMatch) {
    verdictCountMatch = parseInt(fnMatch[1], 10) === findingsCount;
  } else if (findingsCount > 0) {
    // Non-FINDINGS verdict but there are findings → mismatch
    verdictCountMatch = false;
  }

  return {
    verdict_present: verdictPresent,
    verdict,
    findings_count: findingsCount,
    critical: severityCounts.critical,
    warning: severityCounts.warning,
    suggestion: severityCounts.suggestion,
    has_file_refs: hasFileRefs,
    hedging_detected: hedgingDetected,
    verdict_count_match: verdictCountMatch,
    findings,
  };
}

// ─── Subcommands ─────────────────────────────────────────────────

function cmdVerify(args) {
  const file = args[0];
  if (!file) {
    console.error("Usage: opc-harness verify <file>");
    process.exit(1);
  }

  const text = readFileSync(file, "utf8");
  const result = parseEvaluation(text);

  // Strip internal-only fields
  const { findings, ...output } = result;
  console.log(JSON.stringify(output, null, 2));
}

function cmdSynthesize(args) {
  const dir = args[0];
  const waveIdx = args.indexOf("--wave");
  if (!dir || waveIdx === -1 || !args[waveIdx + 1]) {
    console.error("Usage: opc-harness synthesize <dir> --wave <N>");
    process.exit(1);
  }
  const wave = args[waveIdx + 1];

  const prefix = `evaluation-wave-${wave}-`;
  const mergedName = `evaluation-wave-${wave}.md`;
  const harnessDir = join(dir, ".harness");

  const ROUND_RE = /^evaluation-wave-\d+-round\d+/;
  let files;
  try {
    files = readdirSync(harnessDir).filter(
      (f) => f.startsWith(prefix) && f.endsWith(".md") && f !== mergedName && !ROUND_RE.test(f)
    );
  } catch (err) {
    console.error(`Cannot read ${harnessDir}: ${err.message}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`No evaluation files matching ${prefix}*.md in ${harnessDir}`);
    process.exit(1);
  }

  const roles = [];
  const totals = { critical: 0, warning: 0, suggestion: 0 };

  for (const f of files) {
    const roleName = f.replace(prefix, "").replace(/\.md$/, "");
    const text = readFileSync(join(harnessDir, f), "utf8");
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

function cmdReport(args) {
  const dir = args[0];
  if (!dir) {
    console.error(
      "Usage: opc-harness report <dir> --mode <mode> --task <task> [--challenged N] [--dismissed N] [--downgraded N]"
    );
    process.exit(1);
  }

  function getArg(name, fallback) {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && args[idx + 1] != null ? args[idx + 1] : fallback;
  }

  const mode = getArg("mode", null);
  const task = getArg("task", null);
  if (!mode || !task) {
    console.error("--mode and --task are required");
    process.exit(1);
  }

  const challenged = parseInt(getArg("challenged", "0"), 10);
  const dismissed = parseInt(getArg("dismissed", "0"), 10);
  const downgraded = parseInt(getArg("downgraded", "0"), 10);

  const harnessDir = join(dir, ".harness");
  const ROLE_FILE_RE = /^evaluation-wave-\d+-(?!round\d)(.+)\.md$/;
  let roleFiles;
  try {
    roleFiles = readdirSync(harnessDir).filter((f) => ROLE_FILE_RE.test(f));
  } catch (err) {
    console.error(`Cannot read ${harnessDir}: ${err.message}`);
    process.exit(1);
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

    // Only count accepted findings
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

function cmdDiff(args) {
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

  const text1 = readFileSync(file1, "utf8");
  const text2 = readFileSync(file2, "utf8");

  const parsed1 = parseEvaluation(text1);
  const parsed2 = parseEvaluation(text2);

  const keyed1 = extractKeys(parsed1.findings);
  const keyed2 = extractKeys(parsed2.findings);

  const keys1 = new Set(keyed1.map((k) => k.key));
  const keys2 = new Set(keyed2.map((k) => k.key));

  const recurringKeys = [...keys1].filter((k) => keys2.has(k));
  const newKeys = [...keys2].filter((k) => !keys1.has(k));
  const resolvedKeys = [...keys1].filter((k) => !keys2.has(k));

  // Build recurring details
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

// ─── CLI router ──────────────────────────────────────────────────

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "verify":
    cmdVerify(args);
    break;
  case "synthesize":
    cmdSynthesize(args);
    break;
  case "report":
    cmdReport(args);
    break;
  case "diff":
    cmdDiff(args);
    break;
  default:
    console.log("opc-harness — Mechanical verification for OPC evaluations");
    console.log();
    console.log("Usage:");
    console.log("  opc-harness verify <file>                            Parse evaluation → JSON");
    console.log("  opc-harness synthesize <dir> --wave <N>              Merge wave evaluations → verdict");
    console.log("  opc-harness report <dir> --mode <m> --task <t>       Generate full report JSON");
    console.log("  opc-harness diff <file1> <file2>                     Compare two evaluation rounds");
    console.log();
    console.log("All output is JSON to stdout. Errors go to stderr.");
    break;
}
