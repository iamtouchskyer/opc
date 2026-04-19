// runbooks.mjs — OPC Runbook schema v1 + loader + matcher
//
// Runbooks are reusable task recipes. When the user invokes
//   /opc loop <task>
// the loop-protocol checks `~/.opc/runbooks/` (or the configured dir)
// for a runbook whose `match:` patterns cover the task, and uses its
// `units:` list as the decomposition — avoiding a fresh decompose on
// every run.
//
// A runbook is a markdown file with YAML-lite frontmatter:
//
//   ---
//   version: 1
//   id: add-feature          # kebab-case slug, filename-independent
//   title: Add a Feature
//   tags: [build, frontend]
//   match:
//     - "add feature"        # whole-word keyword (case-insensitive)
//     - "/^implement /i"     # /.../flags regex literal
//   flow: build-verify
//   tier: polished
//   units:
//     - plan
//     - build
//     - review
//     - test-design
//     - test-execute
//   protocolRefs:
//     - implementer-prompt.md
//   createdAt: 2026-04-19
//   updatedAt: 2026-04-19
//   ---
//   # How this runbook works
//   (markdown body — human guidance for the orchestrator)
//
// Schema is deliberately narrow at v1. Unknown frontmatter keys are
// preserved on the parsed object (future-forward) but not validated.

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

export const RUNBOOK_SCHEMA_VERSION = 1;

// ─── Frontmatter parser (YAML-lite) ──────────────────────────────
//
// We parse a tiny subset of YAML intentionally — adding a dep just for
// runbook loading is overkill, and the schema is small enough that a
// 40-line hand-roll is both readable and debuggable. Supported:
//   key: value
//   key: "quoted value"
//   key: 'quoted value'
//   key: 42                  (number if matches /^-?\d+(\.\d+)?$/)
//   key: [a, b, "c d"]       (flow-style inline list)
//   key:                     (block-style list follows)
//     - item one
//     - "item two"
// Lines starting with '#' (after optional indent) are skipped.

function stripQuotes(s) {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') ||
                        (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (!s) return "";
  if (s[0] === '"' || s[0] === "'") return stripQuotes(s);
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseInlineList(raw) {
  // Expects "[a, b, \"c d\"]"
  const inner = raw.trim().slice(1, -1);
  const items = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ",") { items.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() || items.length === 0) items.push(cur.trim());
  return items.filter(s => s.length > 0).map(s => parseScalar(s));
}

/**
 * parseFrontmatter(src) → { meta, body }
 *
 * If src has no leading '---' block, meta is {} and body is the full src.
 * If frontmatter is unclosed (no trailing '---'), returns empty meta and
 * original body (permissive — we don't want a typo to silently half-parse).
 */
export function parseFrontmatter(src) {
  if (typeof src !== "string") return { meta: {}, body: "" };
  const lines = src.split("\n");
  if (lines[0] !== "---") return { meta: {}, body: src };
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") { closeIdx = i; break; }
  }
  if (closeIdx < 0) return { meta: {}, body: src };

  const fmLines = lines.slice(1, closeIdx);
  const meta = {};
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) { i++; continue; }

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) { i++; continue; }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1);
    const restTrim = rest.trim();

    if (restTrim === "") {
      // Block-style list: consume following `  - item` lines.
      const items = [];
      i++;
      while (i < fmLines.length) {
        const l = fmLines[i];
        const lt = l.trim();
        if (!lt || lt.startsWith("#")) { i++; continue; }
        if (/^\s*-\s+/.test(l)) {
          const itemRaw = l.replace(/^\s*-\s+/, "");
          items.push(parseScalar(itemRaw));
          i++;
          continue;
        }
        break;
      }
      meta[key] = items;
      continue;
    }
    if (restTrim.startsWith("[") && restTrim.endsWith("]")) {
      meta[key] = parseInlineList(restTrim);
      i++;
      continue;
    }
    meta[key] = parseScalar(restTrim);
    i++;
  }

  const body = lines.slice(closeIdx + 1).join("\n").replace(/^\n/, "");
  return { meta, body };
}

// ─── Validation ──────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function isRegexLiteral(s) {
  return typeof s === "string" && /^\/.*\/[gimsuy]*$/.test(s);
}

function parseRegexLiteral(s) {
  // s matches /PATTERN/FLAGS — extract both halves.
  const lastSlash = s.lastIndexOf("/");
  const pattern = s.slice(1, lastSlash);
  const flags = s.slice(lastSlash + 1);
  return new RegExp(pattern, flags);
}

/**
 * validateRunbook(obj) → { ok: boolean, errors: string[] }
 */
export function validateRunbook(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["runbook must be an object"] };
  }
  if (obj.version !== RUNBOOK_SCHEMA_VERSION) {
    errors.push(`version must be ${RUNBOOK_SCHEMA_VERSION} (got ${JSON.stringify(obj.version)})`);
  }
  if (typeof obj.id !== "string") {
    errors.push("id is required (string)");
  } else if (!SLUG_RE.test(obj.id)) {
    errors.push(`id must be kebab-case slug (matching ${SLUG_RE}); got ${JSON.stringify(obj.id)}`);
  }
  if (typeof obj.title !== "string" || obj.title.trim() === "") {
    errors.push("title is required (non-empty string)");
  }
  if (!Array.isArray(obj.units) || obj.units.length === 0) {
    errors.push("units is required (non-empty array)");
  } else if (obj.units.some(u => typeof u !== "string" || u.trim() === "")) {
    errors.push("units entries must be non-empty strings");
  }
  if (obj.tags !== undefined && !Array.isArray(obj.tags)) {
    errors.push("tags must be an array if present");
  }
  if (obj.match !== undefined) {
    if (!Array.isArray(obj.match)) {
      errors.push("match must be an array if present");
    } else {
      for (const p of obj.match) {
        if (typeof p !== "string") {
          errors.push(`match entry must be string; got ${typeof p}`);
          continue;
        }
        if (isRegexLiteral(p)) {
          try { parseRegexLiteral(p); }
          catch (err) { errors.push(`match entry has invalid regex '${p}': ${err.message}`); }
        }
      }
    }
  }
  if (obj.flow !== undefined && typeof obj.flow !== "string") {
    errors.push("flow must be a string if present");
  }
  if (obj.tier !== undefined && typeof obj.tier !== "string") {
    errors.push("tier must be a string if present");
  }
  if (obj.protocolRefs !== undefined && !Array.isArray(obj.protocolRefs)) {
    errors.push("protocolRefs must be an array if present");
  }
  return { ok: errors.length === 0, errors };
}

// ─── parseRunbook ────────────────────────────────────────────────

/**
 * parseRunbook(path, src) → { ok, runbook?, errors? }
 *
 * Parses frontmatter, validates schema, and returns a runbook object
 * enriched with _path (for list/show) and body (markdown after fm).
 */
export function parseRunbook(path, src) {
  const { meta, body } = parseFrontmatter(src);
  const { ok, errors } = validateRunbook(meta);
  if (!ok) return { ok: false, errors };
  return {
    ok: true,
    runbook: { ...meta, body, _path: path },
  };
}

// ─── loadRunbooks ────────────────────────────────────────────────

/**
 * loadRunbooks(dir) → [{ path, runbook }]
 *
 * Scans dir (non-recursive) for *.md files. Invalid runbooks are
 * skipped with a stderr WARN naming the file + error. Duplicate ids
 * (second occurrence) are skipped with WARN. Missing dir returns [].
 */
export function loadRunbooks(dir) {
  if (!dir || !existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`WARN: runbooks dir ${dir} unreadable: ${err.message}`);
    return [];
  }
  const mdFiles = entries
    .filter(e => e.isFile() && e.name.endsWith(".md"))
    .map(e => join(dir, e.name))
    .sort();
  const result = [];
  const seen = new Set();
  for (const path of mdFiles) {
    let src;
    try { src = readFileSync(path, "utf8"); }
    catch (err) {
      console.error(`WARN: runbook ${path} unreadable: ${err.message}`);
      continue;
    }
    const parsed = parseRunbook(path, src);
    if (!parsed.ok) {
      console.error(`WARN: runbook ${path} invalid: ${parsed.errors.join("; ")}`);
      continue;
    }
    const id = parsed.runbook.id;
    if (seen.has(id)) {
      console.error(`WARN: runbook ${path} has duplicate id '${id}' — skipping`);
      continue;
    }
    seen.add(id);
    result.push({ path, runbook: parsed.runbook });
  }
  return result;
}

// ─── matchRunbook ────────────────────────────────────────────────

const WORD_BOUNDARY = /[\p{L}\p{N}_]/u;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wholeWordMatch(task, keyword) {
  // Case-insensitive whole-word boundary check. "add" must NOT match
  // inside "address" — hence boundary, not substring.
  const pat = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(keyword)}(?:$|[^\\p{L}\\p{N}_])`, "iu");
  return pat.test(task);
}

const KEYWORD_SCORE = 10;
const REGEX_SCORE = 5;
const TAG_SCORE = 3;

/**
 * matchRunbook(task, runbooks) → { runbook, score, matches: [string] }
 *
 * Scoring:
 *   - each match pattern (keyword or regex) that fires: +10 or +5
 *   - each tag that appears as whole word in task: +3
 *
 * Tie-breakers (in order):
 *   1. higher total score wins
 *   2. more patterns matched wins
 *   3. alphabetical (id asc)
 *
 * Empty task or empty runbooks → { runbook: null, score: 0, matches: [] }.
 */
export function matchRunbook(task, runbooks) {
  const NO_MATCH = { runbook: null, score: 0, matches: [] };
  if (typeof task !== "string" || task.trim() === "") return NO_MATCH;
  if (!Array.isArray(runbooks) || runbooks.length === 0) return NO_MATCH;

  const scored = [];
  for (const entry of runbooks) {
    const rb = entry.runbook || entry;
    let score = 0;
    const matches = [];
    const patterns = Array.isArray(rb.match) ? rb.match : [];
    for (const p of patterns) {
      if (typeof p !== "string") continue;
      if (isRegexLiteral(p)) {
        try {
          if (parseRegexLiteral(p).test(task)) {
            score += REGEX_SCORE;
            matches.push(p);
          }
        } catch { /* treat malformed regex as literal */
          if (wholeWordMatch(task, p)) {
            score += KEYWORD_SCORE;
            matches.push(p);
          }
        }
        continue;
      }
      if (wholeWordMatch(task, p)) {
        // Multi-word phrase bonus: longer, more specific patterns win
        // against generic single-word matches. "add a feature" (3 words)
        // scores 30 vs "add" (1 word) scoring 10.
        const wordCount = p.trim().split(/\s+/).length;
        score += KEYWORD_SCORE * wordCount;
        matches.push(p);
      }
    }
    const tags = Array.isArray(rb.tags) ? rb.tags : [];
    for (const t of tags) {
      if (typeof t !== "string") continue;
      if (wholeWordMatch(task, t)) {
        score += TAG_SCORE;
        matches.push(`tag:${t}`);
      }
    }
    if (score > 0) scored.push({ runbook: rb, score, matches });
  }

  if (scored.length === 0) return NO_MATCH;
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.matches.length !== a.matches.length) return b.matches.length - a.matches.length;
    return String(a.runbook.id).localeCompare(String(b.runbook.id));
  });
  return scored[0];
}
