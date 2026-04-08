#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join, basename, dirname } from "path";

// ─── Flow graph definitions ──────────────────────────────────────

const FLOW_TEMPLATES = {
  "legacy-linear": {
    nodes: ["design", "plan", "build", "evaluate", "deliver"],
    edges: {
      design:   { PASS: "plan" },
      plan:     { PASS: "build" },
      build:    { PASS: "evaluate" },
      evaluate: { PASS: "deliver", FAIL: "build", ITERATE: "build" },
      deliver:  { PASS: null },
    },
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 20, maxNodeReentry: 5 },
  },
  "quick-review": {
    nodes: ["code-review", "gate"],
    edges: {
      "code-review": { PASS: "gate" },
      gate:          { PASS: null },
    },
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
  },
  "build-verify": {
    nodes: ["build", "code-review", "test-verify", "gate"],
    edges: {
      build:         { PASS: "code-review" },
      "code-review": { PASS: "test-verify" },
      "test-verify": { PASS: "gate" },
      gate:          { PASS: null, FAIL: "build", ITERATE: "build" },
    },
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 20, maxNodeReentry: 5 },
  },
  "full-stack": {
    nodes: [
      "discuss", "build", "code-review", "test-verify", "gate-test",
      "acceptance", "gate-acceptance",
      "audit", "gate-audit",
      "e2e-user", "gate-e2e",
      "post-launch-sim", "gate-final",
    ],
    edges: {
      discuss:             { PASS: "build" },
      build:               { PASS: "code-review" },
      "code-review":       { PASS: "test-verify" },
      "test-verify":       { PASS: "gate-test" },
      "gate-test":         { PASS: "acceptance", FAIL: "discuss", ITERATE: "discuss" },
      acceptance:          { PASS: "gate-acceptance" },
      "gate-acceptance":   { PASS: "audit", FAIL: "discuss", ITERATE: "discuss" },
      audit:               { PASS: "gate-audit" },
      "gate-audit":        { PASS: "e2e-user", FAIL: "discuss", ITERATE: "discuss" },
      "e2e-user":          { PASS: "gate-e2e" },
      "gate-e2e":          { PASS: "post-launch-sim", FAIL: "discuss", ITERATE: "discuss" },
      "post-launch-sim":   { PASS: "gate-final" },
      "gate-final":        { PASS: null, FAIL: "discuss", ITERATE: "discuss" },
    },
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 30, maxNodeReentry: 5 },
  },
  "pre-release": {
    nodes: ["acceptance", "gate-acceptance", "audit", "gate-audit", "e2e-user", "gate-e2e"],
    edges: {
      acceptance:          { PASS: "gate-acceptance" },
      "gate-acceptance":   { PASS: "audit", FAIL: "acceptance", ITERATE: "acceptance" },
      audit:               { PASS: "gate-audit" },
      "gate-audit":        { PASS: "e2e-user", FAIL: "acceptance", ITERATE: "acceptance" },
      "e2e-user":          { PASS: "gate-e2e" },
      "gate-e2e":          { PASS: null, FAIL: "acceptance", ITERATE: "acceptance" },
    },
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 20, maxNodeReentry: 5 },
  },
};

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
  text = text.replace(/\r\n/g, "\n");
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

    // Severity / finding detection (skip markdown headings — they contain severity emoji as section labels, not findings)
    const sevMatch = trimmed.match(SEVERITY_RE);
    if (sevMatch && !trimmed.startsWith("#")) {
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
      if (HEDGING_RE.test(trimmed)) {
        hedgingDetected.push(`line ${lineNum}: '${trimmed}'`);
      }
      continue;
    }

    // Reasoning line
    if (currentFinding && /^reasoning:/i.test(trimmed)) {
      currentFinding.reasoning = trimmed.replace(/^reasoning:\s*/i, "").trim();
      if (HEDGING_RE.test(trimmed)) {
        hedgingDetected.push(`line ${lineNum}: '${trimmed}'`);
      }
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
    // Non-FINDINGS verdict (e.g. "ANALYSIS COMPLETE", "OPTIONS [3]") — count check not applicable
    verdictCountMatch = null;
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

  // Per-finding evidence checks
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

  // Strip internal-only fields, add evidence checks
  const { findings, ...output } = result;
  output.findings_without_refs = findingsWithoutRefs;
  output.critical_without_fix = criticalWithoutFix;
  output.findings_without_reasoning = findingsWithoutReasoning;
  output.evidence_complete = evidenceComplete;
  console.log(JSON.stringify(output, null, 2));
}

// Note: synthesize assumes findings are bugs/issues (review use case). For brainstorm/analysis
// tasks, findings are context markers, not defects — use single evaluator path (skip synthesize).
function cmdSynthesize(args) {
  const dir = args[0];
  const waveIdx = args.indexOf("--wave");
  const nodeIdx = args.indexOf("--node");

  if (!dir || (waveIdx === -1 && nodeIdx === -1)) {
    console.error("Usage: opc-harness synthesize <dir> --wave <N>           (legacy: dir = project root)");
    console.error("       opc-harness synthesize <dir> --node <nodeId> [--run <N>]  (dir = .harness/ path)");
    process.exit(1);
  }

  let files;
  let harnessDir;

  if (nodeIdx !== -1) {
    // Node-based mode
    const nodeId = args[nodeIdx + 1];
    if (!nodeId) {
      console.error("--node requires a nodeId");
      process.exit(1);
    }

    const runFlag = args.indexOf("--run");
    let targetRunDir;

    if (runFlag !== -1 && args[runFlag + 1]) {
      // Specific run
      targetRunDir = join(dir, "nodes", nodeId, `run_${args[runFlag + 1]}`);
    } else {
      // Find latest run by reading flow-state or scanning directory
      const nodeDir = join(dir, "nodes", nodeId);
      try {
        const runs = readdirSync(nodeDir)
          .filter((d) => d.startsWith("run_"))
          .sort((a, b) => {
            const na = parseInt(a.replace("run_", ""), 10);
            const nb = parseInt(b.replace("run_", ""), 10);
            return nb - na; // descending — latest first
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
    // Wave-based mode (backward compat)
    const wave = args[waveIdx + 1];
    if (!wave) {
      console.error("--wave requires a wave number");
      process.exit(1);
    }

    const prefix = `evaluation-wave-${wave}-`;
    const mergedName = `evaluation-wave-${wave}.md`;
    harnessDir = join(dir, ".harness");

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
    // Extract role name from filename
    let roleName;
    if (f.name.startsWith("eval-")) {
      roleName = f.name.replace("eval-", "").replace(/\.md$/, "");
    } else if (f.name === "eval.md") {
      roleName = "evaluator";
    } else {
      // Wave-based: evaluation-wave-N-{role}.md
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
  const SINGLE_EVAL_RE = /^evaluation-wave-(\d+)\.md$/;
  let roleFiles;
  try {
    roleFiles = readdirSync(harnessDir).filter((f) => ROLE_FILE_RE.test(f));
  } catch (err) {
    console.error(`Cannot read ${harnessDir}: ${err.message}`);
    process.exit(1);
  }

  // Fallback: if no role-suffixed files found, use single-evaluator files (evaluation-wave-N.md)
  let singleEvalFiles = [];
  if (roleFiles.length === 0) {
    try {
      singleEvalFiles = readdirSync(harnessDir).filter((f) => SINGLE_EVAL_RE.test(f));
    } catch {
      // already handled above
    }
  }

  const agents = [];
  const summary = { critical: 0, warning: 0, suggestion: 0 };

  // Process role-suffixed files
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

  // Process single-evaluator files (fallback when no role-suffixed files exist)
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

// ─── Argument helper ─────────────────────────────────────────────

function getFlag(args, name, fallback = null) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] != null ? args[idx + 1] : fallback;
}

// ─── route command ───────────────────────────────────────────────

function cmdRoute(args) {
  const node = getFlag(args, "node");
  const verdict = getFlag(args, "verdict");
  const flow = getFlag(args, "flow");

  if (!node || !verdict || !flow) {
    console.error("Usage: opc-harness route --node <gateId> --verdict <PASS|FAIL|ITERATE> --flow <template>");
    process.exit(1);
  }

  const template = FLOW_TEMPLATES[flow];
  if (!template) {
    console.log(JSON.stringify({ next: null, valid: false, error: `unknown flow template: ${flow}` }));
    return;
  }

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

// ─── init command ────────────────────────────────────────────────

function cmdInit(args) {
  const flow = getFlag(args, "flow");
  const entry = getFlag(args, "entry");
  const dir = getFlag(args, "dir", ".harness");

  if (!flow) {
    console.error("Usage: opc-harness init --flow <template> --entry <nodeId> --dir <path>");
    process.exit(1);
  }

  const template = FLOW_TEMPLATES[flow];
  if (!template) {
    console.log(JSON.stringify({ created: false, error: `unknown flow template: ${flow}` }));
    return;
  }

  const entryNode = entry || template.nodes[0];
  if (!template.nodes.includes(entryNode)) {
    console.log(JSON.stringify({ created: false, error: `entry node '${entryNode}' not in flow '${flow}'` }));
    return;
  }

  const statePath = join(dir, "flow-state.json");
  if (existsSync(statePath)) {
    console.log(JSON.stringify({ created: false, error: "flow-state.json already exists" }));
    return;
  }

  mkdirSync(join(dir, "nodes"), { recursive: true });

  const state = {
    version: "1.0",
    flowTemplate: flow,
    currentNode: entryNode,
    entryNode,
    totalSteps: 0,
    maxTotalSteps: template.limits.maxTotalSteps,
    maxLoopsPerEdge: template.limits.maxLoopsPerEdge,
    maxNodeReentry: template.limits.maxNodeReentry,
    history: [],
    edgeCounts: {},
  };

  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  console.log(JSON.stringify({ created: true, flow, entry: entryNode }));
}

// ─── validate command ────────────────────────────────────────────

const VALID_NODE_TYPES = new Set(["discussion", "build", "review", "execute", "gate"]);
const VALID_STATUSES = new Set(["completed", "failed", "blocked"]);
const VALID_VERDICTS = new Set(["PASS", "ITERATE", "FAIL", "BLOCKED"]);
const EVIDENCE_TYPES = new Set(["test-result", "screenshot", "cli-output"]);

function cmdValidate(args) {
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

  const errors = [];

  // Required string fields
  for (const field of ["nodeId", "nodeType", "runId", "status", "summary", "timestamp"]) {
    if (typeof data[field] !== "string" || data[field].length === 0) {
      errors.push(`missing or empty required field: ${field}`);
    }
  }

  // Enum checks
  if (data.nodeType && !VALID_NODE_TYPES.has(data.nodeType)) {
    errors.push(`invalid nodeType: '${data.nodeType}' (expected: ${[...VALID_NODE_TYPES].join(", ")})`);
  }
  if (data.status && !VALID_STATUSES.has(data.status)) {
    errors.push(`invalid status: '${data.status}' (expected: ${[...VALID_STATUSES].join(", ")})`);
  }
  if (data.verdict != null && !VALID_VERDICTS.has(data.verdict)) {
    errors.push(`invalid verdict: '${data.verdict}' (expected: ${[...VALID_VERDICTS].join(", ")} or null)`);
  }

  // Artifacts check
  if (!Array.isArray(data.artifacts)) {
    errors.push("artifacts must be an array");
  } else {
    const baseDir = dirname(file);
    for (let i = 0; i < data.artifacts.length; i++) {
      const a = data.artifacts[i];
      if (!a.type || !a.path) {
        errors.push(`artifact[${i}]: missing type or path`);
      } else if (!existsSync(join(baseDir, a.path)) && !existsSync(a.path)) {
        errors.push(`artifact[${i}]: file not found: ${a.path}`);
      }
    }
  }

  // Execute nodes must have evidence
  if (data.nodeType === "execute" && data.status === "completed") {
    const hasEvidence = Array.isArray(data.artifacts) &&
      data.artifacts.some((a) => EVIDENCE_TYPES.has(a.type));
    if (!hasEvidence) {
      errors.push("executor node missing evidence (need at least one artifact with type: test-result, screenshot, or cli-output)");
    }
  }

  // Verdict/findings consistency
  if (data.findings && typeof data.findings === "object") {
    if ((data.findings.critical || 0) > 0 && data.verdict === "PASS") {
      errors.push("verdict is PASS but findings.critical > 0");
    }
  }

  // Loopback structure (optional)
  if (data.loopback != null) {
    if (typeof data.loopback !== "object") {
      errors.push("loopback must be an object");
    } else {
      if (!data.loopback.from) errors.push("loopback.from is required");
      if (!data.loopback.reason) errors.push("loopback.reason is required");
      if (typeof data.loopback.iteration !== "number") errors.push("loopback.iteration must be a number");
    }
  }

  console.log(JSON.stringify({ valid: errors.length === 0, errors }));
}

// ─── transition command ──────────────────────────────────────────

function cmdTransition(args) {
  const from = getFlag(args, "from");
  const to = getFlag(args, "to");
  const verdict = getFlag(args, "verdict");
  const flow = getFlag(args, "flow");
  const dir = getFlag(args, "dir", ".harness");

  if (!from || !to || !verdict || !flow) {
    console.error("Usage: opc-harness transition --from <node> --to <node> --verdict <V> --flow <template> --dir <path>");
    process.exit(1);
  }

  // Validate edge exists in flow
  const template = FLOW_TEMPLATES[flow];
  if (!template) {
    console.log(JSON.stringify({ allowed: false, reason: `unknown flow template: ${flow}` }));
    return;
  }

  const nodeEdges = template.edges[from];
  if (!nodeEdges || nodeEdges[verdict] !== to) {
    console.log(JSON.stringify({ allowed: false, reason: `edge '${from}' --${verdict}--> '${to}' not in flow '${flow}'` }));
    return;
  }

  // Read or init flow-state
  const statePath = join(dir, "flow-state.json");
  let state;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf8"));
    // Guard: --from must match current node in state
    if (state.currentNode !== from) {
      console.log(JSON.stringify({ allowed: false, reason: `currentNode is '${state.currentNode}', not '${from}' — cannot transition from a node you are not at` }));
      return;
    }
  } else {
    // Auto-init
    mkdirSync(join(dir, "nodes"), { recursive: true });
    state = {
      version: "1.0",
      flowTemplate: flow,
      currentNode: from,
      entryNode: template.nodes[0],
      totalSteps: 0,
      maxTotalSteps: template.limits.maxTotalSteps,
      maxLoopsPerEdge: template.limits.maxLoopsPerEdge,
      maxNodeReentry: template.limits.maxNodeReentry,
      history: [],
      edgeCounts: {},
    };
  }

  const limits = {
    maxTotalSteps: state.maxTotalSteps ?? template.limits.maxTotalSteps,
    maxLoopsPerEdge: state.maxLoopsPerEdge ?? template.limits.maxLoopsPerEdge,
    maxNodeReentry: state.maxNodeReentry ?? template.limits.maxNodeReentry,
  };

  // Check totalSteps
  if (state.totalSteps >= limits.maxTotalSteps) {
    console.log(JSON.stringify({ allowed: false, reason: `maxTotalSteps (${limits.maxTotalSteps}) reached` }));
    return;
  }

  // Check edge count
  const edgeKey = `${from}→${to}`;
  const edgeCount = state.edgeCounts[edgeKey] || 0;
  if (edgeCount >= limits.maxLoopsPerEdge) {
    console.log(JSON.stringify({ allowed: false, reason: `maxLoopsPerEdge (${limits.maxLoopsPerEdge}) reached for edge '${edgeKey}'` }));
    return;
  }

  // Check node re-entry
  const nodeEntries = state.history.filter((h) => h.nodeId === to).length;
  if (nodeEntries >= limits.maxNodeReentry) {
    console.log(JSON.stringify({ allowed: false, reason: `maxNodeReentry (${limits.maxNodeReentry}) reached for node '${to}'` }));
    return;
  }

  // Compute runId for target node
  const existingRuns = state.history.filter((h) => h.nodeId === to).length;
  const runId = `run_${existingRuns + 1}`;

  // Write gate handshake if 'from' is a gate node
  if (from.startsWith("gate")) {
    const gateDir = join(dir, "nodes", from);
    mkdirSync(gateDir, { recursive: true });
    const gateHandshake = {
      nodeId: from,
      nodeType: "gate",
      runId: `run_${(state.history.filter((h) => h.nodeId === from).length || 0) + 1}`,
      status: "completed",
      verdict,
      summary: `verdict=${verdict}, next=${to}`,
      timestamp: new Date().toISOString(),
      artifacts: [],
      findings: null,
    };
    writeFileSync(join(gateDir, "handshake.json"), JSON.stringify(gateHandshake, null, 2) + "\n");
  }

  // Update state
  state.history.push({ nodeId: to, runId, timestamp: new Date().toISOString() });
  state.currentNode = to;
  state.totalSteps++;
  state.edgeCounts[edgeKey] = edgeCount + 1;

  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  // Ensure target node dir exists
  mkdirSync(join(dir, "nodes", to, runId), { recursive: true });

  console.log(JSON.stringify({ allowed: true, reason: "ok", next: to, runId, state }));
}

// ─── validate-chain command ──────────────────────────────────────

function cmdValidateChain(args) {
  const dir = getFlag(args, "dir", ".harness");

  const statePath = join(dir, "flow-state.json");
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ valid: false, errors: ["flow-state.json not found"], executedPath: [] }));
    return;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ valid: false, errors: [`cannot parse flow-state.json: ${err.message}`], executedPath: [] }));
    return;
  }

  const errors = [];
  const executedPath = [];

  // Check each history entry has a corresponding handshake
  for (const entry of state.history) {
    const handshakePath = join(dir, "nodes", entry.nodeId, "handshake.json");
    executedPath.push(entry.nodeId);

    if (!existsSync(handshakePath)) {
      // Gate nodes written by transition may not exist yet for the current node
      if (entry.nodeId === state.currentNode) continue;
      errors.push(`missing handshake for node '${entry.nodeId}' (expected: ${handshakePath})`);
    }
  }

  // Validate each handshake that exists
  let nodesDir;
  try {
    nodesDir = join(dir, "nodes");
    if (existsSync(nodesDir)) {
      const nodeDirs = readdirSync(nodesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const nd of nodeDirs) {
        const hp = join(nodesDir, nd, "handshake.json");
        if (existsSync(hp)) {
          try {
            const data = JSON.parse(readFileSync(hp, "utf8"));
            // Basic schema checks
            if (!data.nodeId) errors.push(`${nd}/handshake.json: missing nodeId`);
            if (!data.nodeType) errors.push(`${nd}/handshake.json: missing nodeType`);
            if (!data.status) errors.push(`${nd}/handshake.json: missing status`);
          } catch (err) {
            errors.push(`${nd}/handshake.json: parse error: ${err.message}`);
          }
        }
      }
    }
  } catch {
    // nodes dir doesn't exist — that's ok if history is empty
  }

  console.log(JSON.stringify({ valid: errors.length === 0, errors, executedPath }));
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
  case "route":
    cmdRoute(args);
    break;
  case "init":
    cmdInit(args);
    break;
  case "validate":
    cmdValidate(args);
    break;
  case "transition":
    cmdTransition(args);
    break;
  case "validate-chain":
    cmdValidateChain(args);
    break;
  default:
    console.log("opc-harness — Mechanical verification for OPC evaluations");
    console.log();
    console.log("Usage:");
    console.log("  opc-harness verify <file>                            Parse evaluation → JSON");
    console.log("  opc-harness synthesize <dir> --wave <N>              Merge wave evaluations → verdict");
    console.log("  opc-harness synthesize <dir> --node <id> [--run N]   Merge node evaluations → verdict");
    console.log("  opc-harness report <dir> --mode <m> --task <t>       Generate full report JSON");
    console.log("  opc-harness diff <file1> <file2>                     Compare two evaluation rounds");
    console.log("  opc-harness route --node <id> --verdict <V> --flow <tpl>    Get next node from graph");
    console.log("  opc-harness init --flow <tpl> [--entry <node>] [--dir <p>]  Init flow state");
    console.log("  opc-harness validate <handshake.json>                Validate handshake schema");
    console.log("  opc-harness transition --from <n> --to <n> --verdict <V> --flow <tpl> --dir <p>");
    console.log("                                                      Execute state transition");
    console.log("  opc-harness validate-chain [--dir <p>]               Validate entire execution path");
    console.log();
    console.log("All output is JSON to stdout. Errors go to stderr.");
    break;
}
