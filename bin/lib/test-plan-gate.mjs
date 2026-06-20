import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { TEST_LAYERS, TEST_LAYER_KEYWORDS } from "./tier-baselines.mjs";

const CMD_RE = /\b(npm\s+(test|run)|npx\s+\w|pytest|vitest|jest|playwright\s+test|curl\s+|bash\s+|sh\s+|node\s+|python[3]?\s+)/i;

function latestRunDir(nodeDir) {
  try {
    return readdirSync(nodeDir)
      .filter(name => /^run_\d+$/.test(name))
      .sort((a, b) => parseInt(b.slice(4), 10) - parseInt(a.slice(4), 10))
      .map(name => join(nodeDir, name))[0] || null;
  } catch {
    return null;
  }
}

function findPlanPath(dir, nodeId) {
  const nodeDir = join(dir, "nodes", nodeId);
  const runDir = latestRunDir(nodeDir);
  const runPlan = runDir ? join(runDir, "test-plan.md") : null;
  if (runPlan && existsSync(runPlan)) return runPlan;
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

function caseBlocks(lines) {
  const blocks = [];
  let cur = null;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^#{2,4}\s+(TC-[\w-]+)/i);
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

function anchorIssues(lines, roots) {
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
    const ref = anchor.split(/\s+[—–-]\s+/)[0].trim().match(/^(.+):(\d+)$/);
    if (!ref) continue;
    const resolved = roots.map(root => join(root, ref[1].trim())).find(existsSync);
    if (!resolved) {
      issues.push(`${block.id} Anchor ref unresolved: ${ref[1].trim()}`);
      continue;
    }
    const line = Number(ref[2]);
    const lineCount = readFileSync(resolved, "utf8").split("\n").length;
    if (line < 1 || line > lineCount) {
      issues.push(`${block.id} Anchor line out of range: ${ref[1].trim()}:${line}`);
    }
  }
  return issues;
}

export function collectTestDesignPlanReasons(dir, nodeId) {
  const planPath = findPlanPath(dir, nodeId);
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
