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
const MAX_KEYWORDS = 5;
const MAX_RESULTS = 3;

// Small multilingual stopword list — prevents injecting high-noise keywords
// like "the", "a", "做", "的".
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "as", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "have", "has", "had", "this", "that", "these", "those",
  "it", "its", "my", "your", "our", "their",
  "的", "了", "在", "是", "和", "与", "或", "但", "我", "你", "他", "她", "它",
  "帮", "做", "要", "把", "给", "让", "能",
]);

function cliAvailable() {
  const r = spawnSync("which", ["memex"], { encoding: "utf8", timeout: 1500 });
  return r.status === 0;
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
  // Split on whitespace + punctuation (but keep CJK chars as single tokens
  // — no tokenizer here, just surface the unique non-stopword runs).
  const tokens = text
    .toLowerCase()
    .split(/[\s,.!?;:()[\]{}"'`\/\\<>—–\-_]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length >= 2)
    .filter((t) => !STOPWORDS.has(t));
  const seen = new Set();
  const unique = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
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
    for (const kw of keywords) {
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
