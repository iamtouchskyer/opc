import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { parseEvaluation } from "./eval-parser.mjs";

const OUT = "cumulative-findings.md";

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function listRunDirs(nodeDir) {
  if (!existsSync(nodeDir)) return [];
  try {
    return readdirSync(nodeDir)
      .filter((name) => /^run_\d+$/.test(name))
      .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
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
  return `  - ${f.severity}: ${f.issue}${loc}`;
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
  const runDir = runId ? join(nodeDir, runId) : join(nodeDir, listRunDirs(nodeDir).at(-1) || "");
  const handshake = readJson(join(nodeDir, "handshake.json"));
  const runHandshake = readJson(join(runDir, "handshake.json"));
  return { nodeId, runId, nodeDir, runDir, handshake, runHandshake };
}

function orderedEntries(dir, state) {
  const entries = [];
  const seen = new Set();
  const add = (entry) => {
    const nodeId = entry?.nodeId || entry?.node;
    if (!nodeId || seen.has(nodeId)) return;
    seen.add(nodeId);
    entries.push(entry);
  };
  add({ nodeId: state?.entryNode });
  for (const entry of state?.history || []) add(entry);
  add({ nodeId: state?.currentNode });
  const nodesDir = join(dir, "nodes");
  if (!existsSync(nodesDir)) return entries;
  for (const nodeId of readdirSync(nodesDir).sort()) {
    const nodeDir = join(nodesDir, nodeId);
    if (statSync(nodeDir).isDirectory()) add({ nodeId });
  }
  return entries;
}

export function collectExecutionFixes(dir) {
  const fixes = [];
  const nodesDir = join(dir, "nodes");
  if (!existsSync(nodesDir)) return fixes;
  for (const nodeId of readdirSync(nodesDir).sort()) {
    const nodeDir = join(nodesDir, nodeId);
    if (!statSync(nodeDir).isDirectory()) continue;
    for (const raw of fixArrays(readJson(join(nodeDir, "handshake.json")))) {
      const text = fixText(raw);
      if (text) fixes.push({ nodeId, runId: null, text });
    }
    for (const runId of listRunDirs(nodeDir)) {
      for (const raw of fixArrays(readJson(join(nodeDir, runId, "handshake.json")))) {
        const text = fixText(raw);
        if (text) fixes.push({ nodeId, runId, text });
      }
    }
  }
  return fixes;
}

function appendNode(lines, summary) {
  const { nodeId, runId, nodeDir, runDir, handshake, runHandshake } = summary;
  lines.push(`## ${nodeId}${runId ? ` / ${runId}` : ""}`);
  const hs = handshake || runHandshake;
  if (hs) lines.push(`- Status: ${hs.status || "unknown"}${hs.verdict ? `, verdict: ${hs.verdict}` : ""}`);
  if (existsSync(join(nodeDir, "extension-context.md"))) {
    lines.push(`- Extension context: nodes/${nodeId}/extension-context.md`);
  }
  for (const ev of listEvalFiles(runDir)) appendEval(lines, ev);
  lines.push("");
}

function appendEval(lines, ev) {
  const parsed = parseEvaluation(readFileSync(ev.path, "utf8"));
  if (parsed.findings_count === 0) return;
  lines.push(`- ${ev.name}: ${parsed.critical} critical, ${parsed.warning} warning, ${parsed.suggestion} suggestion`);
  for (const f of parsed.findings) lines.push(fmtFinding(f));
}

export function buildCumulativeFindingsMarkdown(dir, state) {
  const lines = ["# OPC Cumulative Findings", ""];
  lines.push(`- Current node: ${state?.currentNode || "unknown"}`);
  lines.push(`- Flow status: ${state?.status || "in_progress"}`);
  lines.push(`- Total steps: ${state?.totalSteps ?? 0}`, "");
  for (const entry of orderedEntries(dir, state)) appendNode(lines, readRunSummary(dir, entry));
  const fixes = collectExecutionFixes(dir);
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
