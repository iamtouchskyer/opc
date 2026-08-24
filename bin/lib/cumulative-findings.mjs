import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { parseEvaluation } from "./eval-parser.mjs";
import { parseStructuredFindings, structuredSeverityName } from "./structured-findings.mjs";
import { compareRunIds } from "./run-id.mjs";
import { authoritativeEntries } from "./flow-evidence.mjs";

const OUT = "cumulative-findings.md";

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function listRunDirs(nodeDir) {
  if (!existsSync(nodeDir)) return [];
  try {
    return readdirSync(nodeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^run_\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareRunIds);
  } catch { return []; }
}

function listEvalFiles(runDir) {
  if (!existsSync(runDir)) return [];
  try {
    return readdirSync(runDir)
      .filter((name) => /^eval-.*\.md$/.test(name))
      .sort()
      .map((name) => ({ name, path: join(runDir, name) }));
  } catch { return []; }
}

function fmtFinding(f) {
  const loc = f.file && f.line ? ` (${f.file}:${f.line})` : "";
  const metadata = [
    f.class ? `class=${f.class}` : null,
    f.criterion ? `criterion=${f.criterion}` : null,
    f.finding_ref ? `finding_ref=${f.finding_ref}` : null,
    f.fingerprint ? `fingerprint=${f.fingerprint}` : null,
  ].filter(Boolean);
  const suffix = metadata.length > 0 ? ` [${metadata.join(", ")}]` : "";
  const invariant = f.invariant ? ` — invariant: ${f.invariant}` : "";
  const evidence = f.evidence ? ` — evidence: ${f.evidence}` : "";
  return `  - ${f.severity}: ${f.issue}${loc}${suffix}${invariant}${evidence}`;
}

function fmtStructuredFinding(f) {
  const loc = f.location ? ` (${f.location})` : "";
  const status = f.status ? `, status ${f.status}` : "";
  return `  - ${structuredSeverityName(f.severity)}: ${f.title}${loc}${status}`;
}

function parsedHasTitle(parsed, title) {
  const wanted = String(title || "").toLowerCase();
  return parsed.findings.some((f) => String(f.issue || "").toLowerCase().includes(wanted));
}

function fixText(raw) {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";
  return raw.title || raw.summary || raw.description || raw.fix || raw.file || JSON.stringify(raw);
}

function fixArrays(handshake) {
  if (!handshake || typeof handshake !== "object") return [];
  return [
    handshake.fixes_applied,
    handshake.fixesApplied,
    handshake.hotfixes,
  ].filter(Array.isArray).flat();
}

function readRunSummary(dir, entry) {
  const nodeId = entry.nodeId || entry.node;
  const runId = entry.runId || entry.run || "";
  const nodeDir = join(dir, "nodes", nodeId);
  const runDir = runId ? join(nodeDir, runId) : "";
  const handshake = runId ? readJson(join(nodeDir, "handshake.json")) : null;
  const runHandshake = readJson(join(runDir, "handshake.json"));
  return { nodeId, runId, nodeDir, runDir, handshake, runHandshake };
}

function orderedEntries(dir, state) {
  return authoritativeEntries(state);
}

function orphanEntries(dir, state) {
  const authoritative = new Set(orderedEntries(dir, state).map((entry) => `${entry.nodeId}\0${entry.runId}`));
  const nodesDir = join(dir, "nodes");
  if (!existsSync(nodesDir)) return [];
  const orphans = [];
  for (const nodeId of readdirSync(nodesDir).sort()) {
    const nodeDir = join(nodesDir, nodeId);
    if (!statSync(nodeDir).isDirectory()) continue;
    for (const runId of listRunDirs(nodeDir)) {
      if (!authoritative.has(`${nodeId}\0${runId}`)) orphans.push({ nodeId, runId });
    }
  }
  return orphans;
}

export function collectExecutionFixes(dir, state) {
  const fixes = [];
  for (const entry of orderedEntries(dir, state)) {
    const { nodeId, runId } = entry;
    const hs = readJson(join(dir, "nodes", nodeId, runId, "handshake.json"));
    for (const raw of fixArrays(hs)) {
      const text = fixText(raw);
      if (text) fixes.push({ nodeId, runId, text });
    }
  }
  return fixes;
}

function appendNode(lines, summary) {
  const { nodeId, runId, nodeDir, runDir, handshake, runHandshake } = summary;
  lines.push(`## ${nodeId}${runId ? ` / ${runId}` : ""}`);
  const hs = runHandshake || handshake;
  if (hs) lines.push(`- Status: ${hs.status || "unknown"}${hs.verdict ? `, verdict: ${hs.verdict}` : ""}`);
  if (existsSync(join(nodeDir, "extension-context.md"))) {
    lines.push(`- Extension context: nodes/${nodeId}/extension-context.md`);
  }
  for (const ev of listEvalFiles(runDir)) appendEval(lines, ev);
  lines.push("");
}

function appendEval(lines, ev) {
  const content = readFileSync(ev.path, "utf8");
  const parsed = parseEvaluation(content);
  const structured = parseStructuredFindings(content).filter((f) => !parsedHasTitle(parsed, f.title));
  if (parsed.findings_count === 0 && structured.length === 0) return;
  const counts = { critical: parsed.critical, warning: parsed.warning, suggestion: parsed.suggestion };
  for (const f of structured) {
    const key = structuredSeverityName(f.severity);
    if (Object.hasOwn(counts, key)) counts[key]++;
  }
  lines.push(`- ${ev.name}: ${counts.critical} critical, ${counts.warning} warning, ${counts.suggestion} suggestion`);
  for (const f of parsed.findings) lines.push(fmtFinding(f));
  for (const f of structured) lines.push(fmtStructuredFinding(f));
}

export function buildCumulativeFindingsMarkdown(dir, state) {
  const lines = ["# OPC Cumulative Findings", ""];
  lines.push(`- Current node: ${state?.currentNode || "unknown"}`);
  lines.push(`- Flow status: ${state?.status || "in_progress"}`);
  lines.push(`- Total steps: ${state?.totalSteps ?? 0}`, "");
  for (const entry of orderedEntries(dir, state)) appendNode(lines, readRunSummary(dir, entry));
  const orphans = orphanEntries(dir, state);
  if (orphans.length > 0) {
    lines.push("## Forensic Orphan Runs");
    lines.push("These runs are present on disk but are not selected by flow-state/history.");
    for (const entry of orphans) lines.push(`- ${entry.nodeId}/${entry.runId}`);
    lines.push("");
  }
  const fixes = collectExecutionFixes(dir, state);
  if (fixes.length) {
    lines.push("## Fixes Applied During Execution");
    for (const f of fixes) lines.push(`- [${f.nodeId}${f.runId ? `/${f.runId}` : ""}] ${f.text}`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function writeCumulativeFindings(dir, state) {
  writeFileSync(join(dir, OUT), buildCumulativeFindingsMarkdown(dir, state), "utf8");
}

export function readCumulativeFindingsAppend(dir) {
  const path = join(dir, OUT);
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8").trim();
  if (!content) return "";
  return `## OPC Recovery Context\n\n${content}`;
}
