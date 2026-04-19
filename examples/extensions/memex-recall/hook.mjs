// hook.mjs — memex-recall extension (OPC Run 3 U3.3)
//
// Declares `context-enrichment@1`. On prompt.append, extracts keywords from
// ctx.task / ctx.taskDescription, runs `memex search <kw>` (3s timeout) and
// injects top-3 results as a "## 相关历史笔记" prompt section.
//
// Contract: returns "" (no injection) whenever the backend is unavailable —
// missing CLI, ENOENT, timeout, empty output. Never throws.

import { spawnSync } from "node:child_process";

export const meta = {
  provides: ["context-enrichment@1"],
  compatibleCapabilities: ["verification@1", "execute@1", "design-review@1"],
};

const MEMEX_TIMEOUT_MS = 3000;
const TOTAL_BUDGET_MS = 6000; // hard cap across all search calls
const MAX_KEYWORDS = 5;
const MAX_RESULTS = 3;

// Small multilingual stopword list — prevents injecting high-noise keywords
// like "the", "a", "做", "的".
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "as", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "have", "has", "had", "this", "that", "these", "those",
  "it", "its", "my", "your", "our", "their",
  "please", "just", "can", "could", "would", "should", "will", "need", "want",
  "的", "了", "在", "是", "和", "与", "或", "但", "我", "你", "他", "她", "它",
  "帮", "做", "要", "把", "给", "让", "能", "吧", "呢", "一下", "好",
]);

// Cache cliAvailable() result for process lifetime — avoids spawning `which`
// on every promptAppend call (Reviewer B flagged).
let _cliAvailableCache = null;
function cliAvailable() {
  if (_cliAvailableCache !== null) return _cliAvailableCache;
  const r = spawnSync("which", ["memex"], { encoding: "utf8", timeout: 1500 });
  _cliAvailableCache = r.status === 0;
  return _cliAvailableCache;
}

export function startupCheck() {
  if (!cliAvailable()) {
    process.stderr.write(
      `[memex-recall] WARN: memex CLI not in PATH — promptAppend will no-op\n`
    );
    return { ok: true, available: false };
  }
  return { ok: true, available: true };
}

function extractKeywords(text) {
  if (!text || typeof text !== "string") return [];
  // Treat every CJK character as its own token boundary too — no jieba-style
  // segmentation here, but this beats matching runs of 6+ CJK chars that
  // memex will never index. Latin tokens stay whole.
  // Strategy: split on punctuation/whitespace first, then break CJK runs
  // into 2-char sliding windows (common Chinese word length).
  const raw = text
    .toLowerCase()
    .split(/[\s,.!?;:()[\]{}"'`\/\\<>—–\-_]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const tokens = [];
  for (const tok of raw) {
    // Split each coarse token into runs of [CJK] vs [non-CJK] — handles
    // mixed tokens like "帮我fix一下" that have no whitespace between scripts.
    const runs = tok.match(/[\u4e00-\u9fff]+|[^\u4e00-\u9fff]+/g) || [];
    for (const run of runs) {
      if (/^[\u4e00-\u9fff]+$/.test(run)) {
        if (run.length <= 2) tokens.push(run);
        else for (let i = 0; i + 2 <= run.length; i++) tokens.push(run.slice(i, i + 2));
      } else if (run.length >= 2) {
        tokens.push(run);
      }
    }
  }
  const seen = new Set();
  const unique = [];
  for (const t of tokens) {
    if (t.length < 2 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
    if (unique.length >= MAX_KEYWORDS) break;
  }
  return unique;
}

function memexSearch(keyword) {
  try {
    const r = spawnSync("memex", ["search", keyword], {
      encoding: "utf8",
      timeout: MEMEX_TIMEOUT_MS,
    });
    if (r.status !== 0) return [];
    const lines = (r.stdout || "").split("\n").filter(Boolean);
    // Memex search output format varies; best-effort parse: take up to
    // MAX_RESULTS top lines as "slug: summary" entries.
    return lines.slice(0, MAX_RESULTS).map((line) => line.trim());
  } catch {
    return [];
  }
}

export function promptAppend(ctx) {
  try {
    if (!cliAvailable()) return "";
    const task =
      ctx?.task || ctx?.taskDescription || ctx?.acceptanceCriteria || "";
    const keywords = extractKeywords(task);
    if (keywords.length === 0) return "";

    const hits = new Set();
    const deadline = Date.now() + TOTAL_BUDGET_MS;
    for (const kw of keywords) {
      if (Date.now() >= deadline) break;
      for (const hit of memexSearch(kw)) {
        if (hits.size >= MAX_RESULTS) break;
        hits.add(hit);
      }
      if (hits.size >= MAX_RESULTS) break;
    }
    if (hits.size === 0) return "";

    const items = [...hits].map((h) => `- ${h}`).join("\n");
    return `\n## 相关历史笔记\n\n${items}\n`;
  } catch (err) {
    process.stderr.write(
      `[memex-recall] WARN: promptAppend failed: ${err?.message || err}\n`
    );
    return "";
  }
}

export { extractKeywords as _extractKeywords };
