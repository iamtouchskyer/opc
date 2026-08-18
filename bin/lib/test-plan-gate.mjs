import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { TEST_LAYERS, TEST_LAYER_KEYWORDS } from "./tier-baselines.mjs";
import { compareRunIds } from "./run-id.mjs";

const CMD_RE = /\b(npm\s+(test|run)|npx\s+\w|pytest|vitest|jest|playwright\s+test|curl\s+|bash\s+|sh\s+|node\s+|python[3]?\s+)/i;

function latestRunDir(nodeDir) {
  try {
    return readdirSync(nodeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^run_\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => compareRunIds(b, a))
      .map((name) => join(nodeDir, name))[0] || null;
  } catch {
    return null;
  }
}

function runDirFor(nodeDir, runId) {
  if (typeof runId !== "string" || !/^run_\d+$/.test(runId)) return null;
  const dir = join(nodeDir, runId);
  return existsSync(dir) ? dir : null;
}

function findPlanPath(dir, nodeId, runId = null) {
  const nodeDir = join(dir, "nodes", nodeId);
  const runDir = runId ? runDirFor(nodeDir, runId) : latestRunDir(nodeDir);
  const runPlan = runDir ? join(runDir, "test-plan.md") : null;
  if (runPlan && existsSync(runPlan)) return runPlan;
  if (runId) {
    const canonical = join(nodeDir, "handshake.json");
    if (!existsSync(canonical)) return null;
    let handshake;
    try {
      handshake = JSON.parse(readFileSync(canonical, "utf8"));
    } catch {
      return null;
    }
    if (!handshake || typeof handshake !== "object" || Array.isArray(handshake)) return null;
    if (handshake.nodeId !== nodeId || handshake.runId !== runId) return null;
    const artifact = Array.isArray(handshake.artifacts)
      ? handshake.artifacts.find(a => a?.type === "test-plan" && typeof a.path === "string")
      : null;
    const artifactPath = artifact ? join(nodeDir, artifact.path) : null;
    return artifactPath && existsSync(artifactPath) ? artifactPath : null;
  }
  const nodePlan = join(nodeDir, "test-plan.md");
  return existsSync(nodePlan) ? nodePlan : null;
}

function layerCoverage(lines) {
  const lower = lines.join("\n").toLowerCase();
  const missing = [];
  const shallow = [];
  for (const layer of TEST_LAYERS) {
    const keywords = TEST_LAYER_KEYWORDS[layer];
    const found = keywords.some(kw => lower.includes(kw));
    if (!found) {
      missing.push(layer);
      continue;
    }
    const start = lines.findIndex(line =>
      /^#{1,3}\s/.test(line) && keywords.some(kw => line.toLowerCase().includes(kw))
    );
    if (start === -1) continue;
    let contentLines = 0;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{1,3}\s/.test(lines[i])) break;
      if (lines[i].trim()) contentLines++;
    }
    if (contentLines < 3) shallow.push(layer);
  }
  return { missing, shallow };
}

export function caseBlocks(lines) {
  const blocks = [];
  let cur = null;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^#{2,4}\s+(TC-[\w-]+)/i)
      || lines[i].match(/^\s*[-*]\s+(?:\*\*)?(TC-[\w-]+)\b/i);
    if (match) {
      if (cur) blocks.push({ id: cur, lines: lines.slice(start, i) });
      cur = match[1];
      start = i;
    } else if (cur && /^#{1,2}\s/.test(lines[i])) {
      blocks.push({ id: cur, lines: lines.slice(start, i) });
      cur = null;
    }
  }
  if (cur) blocks.push({ id: cur, lines: lines.slice(start) });
  return blocks;
}

function resolveAnchorRef(anchor, roots) {
  const ref = anchor.split(/\s+[—–-]\s+/)[0].trim().match(/^(.+):(\d+)(?:-(\d+))?$/);
  if (!ref) return { error: "invalid format" };
  const file = ref[1].trim();
  const startLine = Number(ref[2]);
  const endLine = ref[3] ? Number(ref[3]) : startLine;
  const resolved = file.startsWith("/")
    ? (existsSync(file) ? file : null)
    : roots.map(root => join(root, file)).find(existsSync);
  if (!resolved) return { error: "unresolved", file };
  const lineCount = readFileSync(resolved, "utf8").split("\n").length;
  if (startLine < 1 || startLine > lineCount) {
    return { error: "line out of range", file, line: startLine, lineCount };
  }
  if (endLine < startLine || endLine > lineCount) {
    return { error: "range out of range", file, line: endLine, lineCount };
  }
  return {};
}

export function anchorIssues(lines, roots) {
  const issues = [];
  for (const block of caseBlocks(lines)) {
    if (/^TC-TIER/i.test(block.id)) continue;
    const text = block.lines.join("\n");
    const priority = text.match(/priority[^\n]*?\b(P[012])\b/i)?.[1]?.toUpperCase();
    if (priority !== "P0" && priority !== "P1") continue;
    const anchor = text.match(/\banchor\b[^\n]*?:\s*(.+)$/im)?.[1]?.trim().replace(/`/g, "");
    if (!anchor) {
      issues.push(`${block.id} (${priority}) missing Anchor`);
      continue;
    }
    const result = resolveAnchorRef(anchor, roots);
    if (result.error === "invalid format") {
      issues.push(`${block.id} Anchor invalid format: ${anchor}`);
    } else if (result.error === "unresolved") {
      issues.push(`${block.id} Anchor ref unresolved: ${result.file}`);
    } else if (result.error === "line out of range") {
      issues.push(`${block.id} Anchor line out of range: ${result.file}:${result.line}`);
    } else if (result.error === "range out of range") {
      issues.push(`${block.id} Anchor range out of range: ${result.file}:${result.line}`);
    }
  }
  return issues;
}

export function collectTestDesignPlanReasons(dir, nodeId, runId = null) {
  const planPath = findPlanPath(dir, nodeId, runId);
  if (!planPath) return [`${nodeId} test-plan.md missing`];
  const text = readFileSync(planPath, "utf8");
  const lines = text.split("\n");
  const { missing, shallow } = layerCoverage(lines);
  const noCommands = lines.filter(line => CMD_RE.test(line)).length === 0 && lines.length >= 10;
  const anchors = anchorIssues(lines, [dir, process.cwd()]);
  const reasons = [];
  if (missing.length > 0) reasons.push(`missing layers: ${missing.join(", ")}`);
  if (shallow.length > 0) reasons.push(`shallow sections: ${shallow.join(", ")}`);
  if (noCommands) reasons.push("0 actionable commands in test plan");
  if (anchors.length > 0) reasons.push(`anchor: ${anchors.join("; ")}`);
  return reasons.map(reason => `${nodeId} test plan: ${reason}`);
}
