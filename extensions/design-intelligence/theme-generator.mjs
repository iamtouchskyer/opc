#!/usr/bin/env node
// theme-generator.mjs — LLM-powered theme generation engine
// Usage:
//   node theme-generator.mjs generate "微软风格"
//   node theme-generator.mjs generate --random
//   node theme-generator.mjs batch --count 10
//   node theme-generator.mjs export <id> --format css|json
//   node theme-generator.mjs export --all --format css-block
//   node theme-generator.mjs validate <file...>
//   node theme-generator.mjs list

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEMES_DIR = join(__dirname, "themes");
const SCHEMA_PATH = join(__dirname, "theme-schema.json");
const SEEDS_PATH = join(THEMES_DIR, "_seeds.json");

mkdirSync(THEMES_DIR, { recursive: true });

// ─── Schema Validation ──────────────────────────────────────────────

const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

// Derive validation keys from schema — single source of truth
const colorProps = SCHEMA.properties.tokens.properties.color;
const REQUIRED_COLOR_KEYS = colorProps.required || [];
const ALL_COLOR_KEYS = Object.keys(colorProps.properties || {});
const VALID_EFFECTS = SCHEMA.properties.effects.items.enum || [];

function validate(theme) {
  const errors = [];
  if (!theme || typeof theme !== "object") return ["Theme must be a JSON object"];

  // Required fields
  if (!theme.id || typeof theme.id !== "string") errors.push("Missing or invalid 'id'");
  else if (!/^[a-z][a-z0-9-]*$/.test(theme.id)) errors.push(`id '${theme.id}' must be kebab-case`);

  if (!theme.name || typeof theme.name !== "string") errors.push("Missing 'name'");
  if (!theme.tokens || typeof theme.tokens !== "object") {
    errors.push("Missing 'tokens' object");
    return errors;
  }

  // Color tokens
  const c = theme.tokens.color;
  if (!c || typeof c !== "object") {
    errors.push("Missing tokens.color");
  } else {
    for (const k of REQUIRED_COLOR_KEYS) {
      if (!c[k]) errors.push(`Missing required color token: ${k}`);
    }
    for (const k of Object.keys(c)) {
      if (!ALL_COLOR_KEYS.includes(k)) errors.push(`Unknown color token: ${k}`);
    }
  }

  // Typography
  const t = theme.tokens.typography;
  if (!t || typeof t !== "object") {
    errors.push("Missing tokens.typography");
  } else {
    if (!t["heading-font"]) errors.push("Missing heading-font");
    if (!t["body-font"]) errors.push("Missing body-font");
  }

  // Shape
  const s = theme.tokens.shape;
  if (!s || typeof s !== "object") {
    errors.push("Missing tokens.shape");
  } else {
    if (s["border-radius"] == null) errors.push("Missing border-radius");
    if (s["card-shadow"] == null) errors.push("Missing card-shadow");
  }

  // Effects
  if (theme.effects) {
    for (const e of theme.effects) {
      if (!VALID_EFFECTS.includes(e)) errors.push(`Unknown effect: ${e}`);
    }
  }

  // WCAG contrast check
  if (c && errors.length === 0) {
    const contrastIssues = checkContrast(c);
    errors.push(...contrastIssues);
  }

  return errors;
}

// ─── WCAG AA Contrast ────────────────────────────────────────────────

function parseColor(str) {
  if (!str || typeof str !== "string") return null;
  str = str.trim();

  // hex
  const hexMatch = str.match(/^#([0-9a-f]{3,8})$/i);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    if (hex.length === 4) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3];
    // ignore alpha channel for contrast
    return {
      r: parseInt(hex.slice(0,2), 16),
      g: parseInt(hex.slice(2,4), 16),
      b: parseInt(hex.slice(4,6), 16),
    };
  }

  // rgb/rgba
  const rgbMatch = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    return { r: +rgbMatch[1], g: +rgbMatch[2], b: +rgbMatch[3] };
  }

  return null; // unparseable (e.g. "none", complex values)
}

function luminance(rgb) {
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map(v => {
    v = v / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(c1, c2) {
  const l1 = luminance(c1);
  const l2 = luminance(c2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function checkContrast(colors) {
  const issues = [];
  const bg = parseColor(colors.bg);
  const bgCard = parseColor(colors["bg-card"]);
  const text = parseColor(colors.text);
  const textMuted = parseColor(colors["text-muted"]);
  const accent = parseColor(colors.accent);
  const passageBg = parseColor(colors["passage-bg"]);
  const correctColor = parseColor(colors["correct-color"]);
  const correctBg = parseColor(colors["correct-bg"]);

  // Warn when colors can't be parsed (e.g. HSL, oklch) — don't silent skip
  const unparseable = [];
  for (const [name, val] of Object.entries({ bg: colors.bg, "bg-card": colors["bg-card"], text: colors.text, "text-muted": colors["text-muted"], accent: colors.accent, "passage-bg": colors["passage-bg"], "correct-color": colors["correct-color"], "correct-bg": colors["correct-bg"] })) {
    if (val && !parseColor(val)) unparseable.push(name);
  }
  if (unparseable.length > 0) {
    issues.push(`WCAG AA warn: cannot parse color format for [${unparseable.join(", ")}] — contrast not checked`);
  }

  // text on bg: AA requires 4.5:1 for normal text
  if (bg && text) {
    const ratio = contrastRatio(bg, text);
    if (ratio < 4.5) issues.push(`WCAG AA fail: text on bg contrast ${ratio.toFixed(2)} < 4.5`);
  }
  if (bgCard && text) {
    const ratio = contrastRatio(bgCard, text);
    if (ratio < 4.5) issues.push(`WCAG AA fail: text on bg-card contrast ${ratio.toFixed(2)} < 4.5`);
  }
  // muted text: AA requires 3:1 for large text (we're lenient here)
  if (bg && textMuted) {
    const ratio = contrastRatio(bg, textMuted);
    if (ratio < 3.0) issues.push(`WCAG AA fail: text-muted on bg contrast ${ratio.toFixed(2)} < 3.0`);
  }
  if (bgCard && textMuted) {
    const ratio = contrastRatio(bgCard, textMuted);
    if (ratio < 3.0) issues.push(`WCAG AA fail: text-muted on bg-card contrast ${ratio.toFixed(2)} < 3.0`);
  }
  // accent on bg and bg-card: 3:1 for UI components
  if (bg && accent) {
    const ratio = contrastRatio(bg, accent);
    if (ratio < 3.0) issues.push(`WCAG AA warn: accent on bg contrast ${ratio.toFixed(2)} < 3.0`);
  }
  if (bgCard && accent) {
    const ratio = contrastRatio(bgCard, accent);
    if (ratio < 3.0) issues.push(`WCAG AA warn: accent on bg-card contrast ${ratio.toFixed(2)} < 3.0`);
  }
  // text on passage-bg: critical for reading scenarios
  if (passageBg && text) {
    const ratio = contrastRatio(passageBg, text);
    if (ratio < 4.5) issues.push(`WCAG AA fail: text on passage-bg contrast ${ratio.toFixed(2)} < 4.5`);
  }
  // correct-color on correct-bg
  if (correctBg && correctColor) {
    const ratio = contrastRatio(correctBg, correctColor);
    if (ratio < 3.0) issues.push(`WCAG AA warn: correct-color on correct-bg contrast ${ratio.toFixed(2)} < 3.0`);
  }

  return issues;
}

// ─── Theme Generation via LLM ────────────────────────────────────────

const FEW_SHOT_EXAMPLES = [
  {
    id: "japanese-editorial",
    name: "Japanese Editorial",
    description: "Cream layout with red accents and vertical text feel",
    tags: ["light", "editorial", "elegant"],
    source: "design-school",
    tokens: {
      color: {
        bg: "#faf8f5", "bg-card": "#ffffff", text: "#1a1a1a", "text-muted": "#787067",
        accent: "#c1272d", "accent-light": "rgba(193,39,45,0.06)", border: "#e5e0d8",
        "passage-bg": "#f7f5f0", "passage-border": "#d6d0c6",
        "correct-color": "#c1272d", "correct-bg": "rgba(193,39,45,0.04)",
        "explanation-border": "#c1272d44",
        cat1: "#c1272d", cat2: "#2d5a87", cat3: "#7a6c3a", cat4: "#4a7c6f", cat5: "#8b5e83", cat6: "#c47a2a"
      },
      typography: { "heading-font": "'Noto Serif',Georgia,serif", "body-font": "system-ui,-apple-system,sans-serif" },
      shape: { "border-radius": "2px", "card-shadow": "none" }
    },
    effects: ["subtle-transition"],
    "google-fonts": ["Noto Serif"]
  },
  {
    id: "dark-elegant",
    name: "Dark Elegant",
    description: "Luxury dark theme with gold accents",
    tags: ["dark", "luxury", "elegant"],
    source: "mood",
    tokens: {
      color: {
        bg: "#0a0e1a", "bg-card": "#141829", text: "#e8e6e1", "text-muted": "#8a8997",
        accent: "#c9a84c", "accent-light": "rgba(201,168,76,0.12)", border: "#252a3a",
        "passage-bg": "#0f1322", "passage-border": "#c9a84c33",
        "correct-color": "#5bcea6", "correct-bg": "rgba(91,206,166,0.08)",
        "explanation-border": "#c9a84c44",
        cat1: "#c9a84c", cat2: "#5bcea6", cat3: "#e07882", cat4: "#7b9ff0", cat5: "#d4a0e8", cat6: "#e8b468"
      },
      typography: { "heading-font": "'Playfair Display',Georgia,serif", "body-font": "'Inter',sans-serif" },
      shape: { "border-radius": "8px", "card-shadow": "0 2px 16px rgba(0,0,0,0.4)" }
    },
    effects: ["hover-lift"],
    "google-fonts": ["Playfair Display", "Inter"]
  },
  {
    id: "terminal-hacker",
    name: "Terminal",
    description: "Green-on-black matrix hacker aesthetic",
    tags: ["dark", "developer", "monospace"],
    source: "mood",
    tokens: {
      color: {
        bg: "#000000", "bg-card": "#0a0a0a", text: "#00ff41", "text-muted": "#00b330",
        accent: "#00ff41", "accent-light": "#003b00", border: "#00ff4133",
        "passage-bg": "#0a0a0a", "passage-border": "#00ff4144",
        "correct-color": "#00ff41", "correct-bg": "#00ff4115",
        "explanation-border": "#00ff4133",
        cat1: "#00ff41", cat2: "#00cc33", cat3: "#33ff77", cat4: "#00ff9f", cat5: "#66ffaa", cat6: "#00bb44"
      },
      typography: { "heading-font": "'Fira Code',monospace", "body-font": "'Fira Code',monospace" },
      shape: { "border-radius": "0px", "card-shadow": "0 0 8px #00ff4118" }
    },
    effects: ["scanline-overlay", "glow-border"],
    "google-fonts": ["Fira Code"]
  }
];

function buildPrompt(descriptor) {
  return `You are a design system expert. Generate a complete theme JSON for a web application.

## Theme Schema

The theme MUST have this exact structure:
\`\`\`json
{
  "id": "kebab-case-id",
  "name": "Display Name (max 40 chars)",
  "description": "One-line description (max 120 chars)",
  "tags": ["tag1", "tag2"],
  "source": "brand|design-school|mood|custom|variant",
  "tokens": {
    "color": {
      "bg": "#hex",
      "bg-card": "#hex",
      "text": "#hex",
      "text-muted": "#hex",
      "accent": "#hex",
      "accent-light": "#hex or rgba()",
      "accent-hover": "#hex",
      "border": "#hex",
      "passage-bg": "#hex",
      "passage-border": "#hex",
      "correct-color": "#hex",
      "correct-bg": "#hex or rgba()",
      "explanation-border": "#hex",
      "cat1": "#hex", "cat2": "#hex", "cat3": "#hex",
      "cat4": "#hex", "cat5": "#hex", "cat6": "#hex"
    },
    "typography": {
      "heading-font": "CSS font-family string",
      "body-font": "CSS font-family string"
    },
    "shape": {
      "border-radius": "CSS value like '8px'",
      "card-shadow": "CSS box-shadow value or 'none'"
    }
  },
  "effects": [],
  "google-fonts": [],
  "overrides": ""
}
\`\`\`

## Available Effects (pick 0-3)
hover-lift, glass-cards, hard-shadow, scanline-overlay, gradient-bg, subtle-transition, glow-border, paper-texture

## Constraints
- WCAG AA contrast: text on bg ≥ 4.5:1, text-muted on bg ≥ 3:1, accent on bg ≥ 3:1
- cat1-cat6 should be 6 distinct colors that work with the theme palette
- google-fonts: only list fonts that need loading (not system fonts)
- overrides: only use for truly unique CSS that can't be expressed via tokens (gradient backgrounds, scanlines, etc)

## Few-Shot Examples

${JSON.stringify(FEW_SHOT_EXAMPLES, null, 2)}

## Your Task

Generate a theme for: "${descriptor}"

Respond with ONLY the JSON object. No markdown fences, no explanation.`;
}

function probeClaude() {
  try {
    execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function generateTheme(descriptor, { maxRetries = 2 } = {}) {
  const prompt = buildPrompt(descriptor);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = execFileSync("claude", ["-p", prompt, "--output-format", "json"], {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });

      // claude --output-format json wraps response in {"result": "..."}
      let parsed;
      try {
        const wrapper = JSON.parse(result);
        const text = wrapper.result || wrapper.content || result;
        const jsonStr = typeof text === "string" ? extractJson(text) : JSON.stringify(text);
        parsed = JSON.parse(jsonStr);
      } catch {
        parsed = JSON.parse(extractJson(result));
      }

      return parsed;
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
        console.error(`  ⚠️  Attempt ${attempt + 1} failed: ${err.message}. Retrying in ${(delay / 1000).toFixed(1)}s...`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

function extractJson(text) {
  // Strip markdown fences if present
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1];

  // Bracket-balanced extraction: find first { and track depth to matching }
  const start = text.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in LLM response");

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  throw new Error("No complete JSON object found in LLM response (unbalanced braces)");
}

// ─── Export ──────────────────────────────────────────────────────────

const CSS_OVERRIDE_BLOCKLIST = /(?:@import|@charset|expression\s*\(|url\s*\(\s*["']?javascript:|<\/style|<script|-moz-binding)/i;

function sanitizeOverrides(css) {
  if (!css || typeof css !== "string") return "";
  if (CSS_OVERRIDE_BLOCKLIST.test(css)) return "/* overrides blocked: contains disallowed pattern */";
  // Block scope escape: unbalanced } that could break out of [data-theme] selector
  let depth = 0;
  for (const ch of css) {
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth < 0) return "/* overrides blocked: unbalanced braces */"; }
  }
  return css;
}

const EFFECT_CSS = {
  "hover-lift": `.card:hover { transform: translateY(-2px); transition: transform 0.2s ease; }`,
  "glass-cards": `.card { backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }`,
  "hard-shadow": `.card { box-shadow: 4px 4px 0 var(--border); }`,
  "scanline-overlay": `body::after { content:''; position:fixed; top:0; left:0; width:100%; height:100%; background:repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px); pointer-events:none; z-index:9999; }`,
  "gradient-bg": `/* gradient-bg: override body background in theme overrides */`,
  "subtle-transition": `.card { transition: box-shadow 0.2s ease, transform 0.2s ease; }`,
  "glow-border": `.card { box-shadow: 0 0 8px var(--accent); }`,
  "paper-texture": `body { background-image: url("data:image/svg+xml,%3Csvg width='6' height='6' viewBox='0 0 6 6' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%239C92AC' fill-opacity='0.03'%3E%3Cpath d='M5 0h1L0 5V4zM6 5v1H5z'/%3E%3C/g%3E%3C/svg%3E"); }`,
};

function themeToCSS(theme) {
  const c = theme.tokens.color;
  const t = theme.tokens.typography;
  const s = theme.tokens.shape;

  const vars = [];
  for (const [k, v] of Object.entries(c)) {
    vars.push(`--${k}:${v}`);
  }
  vars.push(`--heading-font:${t["heading-font"]}`);
  vars.push(`--body-font:${t["body-font"]}`);
  if (t["mono-font"]) vars.push(`--mono-font:${t["mono-font"]}`);
  vars.push(`--border-radius:${s["border-radius"]}`);
  vars.push(`--card-shadow:${s["card-shadow"]}`);

  return `[data-theme="${theme.id}"] {\n    ${vars.join("; ")};\n  }`;
}

function themeToCSSBlock(theme) {
  let css = themeToCSS(theme);

  // Add effect CSS scoped to this theme
  if (theme.effects) {
    for (const effect of theme.effects) {
      if (EFFECT_CSS[effect]) {
        css += `\n  [data-theme="${theme.id}"] ${EFFECT_CSS[effect]}`;
      }
    }
  }

  // Add overrides (sanitized)
  if (theme.overrides) {
    const safe = sanitizeOverrides(theme.overrides);
    css += `\n  [data-theme="${theme.id}"] { ${safe} }`;
  }

  return css;
}

function themeToSwitcherEntry(theme) {
  const entry = {
    id: theme.id,
    name: theme.name,
    desc: theme.description || "",
    dot: theme.tokens.color.accent,
  };
  return JSON.stringify(entry);
}

// ─── CLI ─────────────────────────────────────────────────────────────

function loadTheme(idOrPath) {
  if (idOrPath.endsWith(".json")) {
    return JSON.parse(readFileSync(idOrPath, "utf8"));
  }
  const p = join(THEMES_DIR, `${idOrPath}.json`);
  if (!existsSync(p)) throw new Error(`Theme not found: ${idOrPath}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function loadAllThemes() {
  return readdirSync(THEMES_DIR)
    .filter(f => f.endsWith(".json") && !f.startsWith("_"))
    .map(f => JSON.parse(readFileSync(join(THEMES_DIR, f), "utf8")));
}

function saveTheme(theme) {
  const p = join(THEMES_DIR, `${theme.id}.json`);
  writeFileSync(p, JSON.stringify(theme, null, 2) + "\n");
  return p;
}

// ─── Exports (for testing) ──────────────────────────────────────────────
export {
  validate, extractJson, sanitizeOverrides,
  parseColor, luminance, contrastRatio, checkContrast,
  themeToCSS, themeToCSSBlock, themeToSwitcherEntry,
  REQUIRED_COLOR_KEYS, ALL_COLOR_KEYS, VALID_EFFECTS,
};

// ─── CLI (only when run directly) ───────────────────────────────────────
const isMain = process.argv[1] && existsSync(process.argv[1])
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (!isMain) {
  // Imported as module — skip CLI
} else {

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case "generate": {
    let descriptor;
    if (args[0] === "--random") {
      const seeds = JSON.parse(readFileSync(SEEDS_PATH, "utf8"));
      const all = [...seeds.brand, ...seeds["design-school"], ...seeds.mood];
      const pick = all[Math.floor(Math.random() * all.length)];
      descriptor = pick.descriptor;
      console.error(`🎲 Random seed: ${pick.id}`);
    } else {
      descriptor = args.join(" ");
    }
    if (!descriptor) {
      console.error("Usage: theme-generator.mjs generate <descriptor|--random>");
      process.exit(1);
    }

    console.error(`🎨 Generating theme for: "${descriptor}"...`);
    let theme;
    try {
      theme = await generateTheme(descriptor);
    } catch (err) {
      console.error(`❌ Generation failed: ${err.message}`);
      process.exit(1);
    }
    const errors = validate(theme);
    if (errors.length > 0) {
      console.error(`⚠️  Validation issues (${errors.length}):`);
      errors.forEach(e => console.error(`  - ${e}`));
      // Still save if only WCAG warnings
      const critical = errors.filter(e => !e.startsWith("WCAG AA"));
      if (critical.length > 0) {
        console.error("❌ Critical schema errors, not saving.");
        console.log(JSON.stringify(theme, null, 2));
        process.exit(1);
      }
    }
    const path = saveTheme(theme);
    console.error(`✅ Saved: ${path}`);
    console.log(JSON.stringify(theme, null, 2));
    break;
  }

  case "batch": {
    const countIdx = args.indexOf("--count");
    const count = countIdx >= 0 ? parseInt(args[countIdx + 1]) : 10;
    const categoryFilter = args.includes("--brand") ? "brand"
      : args.includes("--design-school") ? "design-school"
      : args.includes("--mood") ? "mood" : null;

    const seeds = JSON.parse(readFileSync(SEEDS_PATH, "utf8"));
    let pool = categoryFilter
      ? seeds[categoryFilter]
      : [...seeds.brand, ...seeds["design-school"], ...seeds.mood];

    // Exclude already-generated
    const existing = new Set(
      readdirSync(THEMES_DIR).filter(f => f.endsWith(".json") && !f.startsWith("_")).map(f => f.replace(".json", ""))
    );
    pool = pool.filter(s => !existing.has(s.id));

    const batch = pool.slice(0, count);
    console.error(`📦 Batch generating ${batch.length} themes (${pool.length - batch.length} remaining)...`);

    // Early probe: check claude CLI is available before wasting time
    if (!probeClaude()) {
      console.error("❌ 'claude' CLI not found or not working. Install it first.");
      process.exit(1);
    }

    let ok = 0, fail = 0, consecutiveFails = 0;
    for (const seed of batch) {
      try {
        console.error(`\n🎨 [${ok + fail + 1}/${batch.length}] ${seed.id}...`);
        const theme = await generateTheme(seed.descriptor);
        consecutiveFails = 0;
        // Use seed ID if LLM generated a different one
        theme.id = seed.id;
        const errors = validate(theme);
        const critical = errors.filter(e => !e.startsWith("WCAG AA"));
        if (critical.length > 0) {
          console.error(`  ❌ Schema errors: ${critical.join("; ")}`);
          fail++;
          continue;
        }
        if (errors.length > 0) {
          console.error(`  ⚠️  ${errors.length} WCAG warnings`);
        }
        saveTheme(theme);
        console.error(`  ✅ Saved`);
        ok++;
      } catch (err) {
        console.error(`  ❌ Failed: ${err.message}`);
        fail++;
        consecutiveFails++;
        if (consecutiveFails >= 3) {
          console.error(`\n⛔ 3 consecutive failures — likely rate limited. Stopping batch.`);
          break;
        }
      }
    }

    console.error(`\n📊 Results: ${ok} saved, ${fail} failed, ${pool.length - batch.length} remaining seeds`);
    break;
  }

  case "export": {
    const format = args.includes("--format") ? args[args.indexOf("--format") + 1] : "css";
    const isAll = args.includes("--all");

    const themes = isAll ? loadAllThemes() : [loadTheme(args[0])];

    if (format === "json") {
      console.log(JSON.stringify(themes.length === 1 ? themes[0] : themes, null, 2));
    } else if (format === "css" || format === "css-block") {
      // Collect Google Fonts
      const allFonts = new Set();
      for (const t of themes) {
        if (t["google-fonts"]) t["google-fonts"].forEach(f => allFonts.add(f));
      }
      if (allFonts.size > 0) {
        const families = [...allFonts].map(f => `family=${f.replace(/ /g, "+")}`).join("&");
        console.log(`@import url('https://fonts.googleapis.com/css2?${families}&display=swap');`);
        console.log();
      }
      for (const t of themes) {
        console.log(format === "css-block" ? themeToCSSBlock(t) : themeToCSS(t));
        console.log();
      }
    } else if (format === "switcher-js") {
      console.log("const THEMES = [");
      for (const t of themes) {
        console.log(`  ${themeToSwitcherEntry(t)},`);
      }
      console.log("];");
    } else {
      console.error(`Unknown format: ${format}. Use css, css-block, json, or switcher-js`);
      process.exit(1);
    }
    break;
  }

  case "validate": {
    if (args.length === 0) {
      console.error("Usage: theme-generator.mjs validate <file...>");
      process.exit(1);
    }
    let allOk = true;
    for (const arg of args) {
      try {
        const theme = JSON.parse(readFileSync(arg, "utf8"));
        const errors = validate(theme);
        if (errors.length === 0) {
          console.log(`✅ ${arg}: PASS`);
        } else {
          console.log(`⚠️  ${arg}: ${errors.length} issue(s)`);
          errors.forEach(e => console.log(`  - ${e}`));
          if (errors.some(e => !e.startsWith("WCAG"))) allOk = false;
        }
      } catch (err) {
        console.log(`❌ ${arg}: ${err.message}`);
        allOk = false;
      }
    }
    process.exit(allOk ? 0 : 1);
  }

  case "list": {
    const themes = loadAllThemes();
    if (themes.length === 0) {
      console.log("No themes generated yet. Run: theme-generator.mjs batch --count 10");
    } else {
      console.log(`${themes.length} themes:\n`);
      for (const t of themes) {
        const tags = (t.tags || []).join(", ");
        console.log(`  ${t.id.padEnd(25)} ${(t.name || "").padEnd(20)} [${tags}]`);
      }
    }
    break;
  }

  default:
    console.log(`theme-generator — LLM-powered visual theme generator

Commands:
  generate <descriptor>    Generate a theme from a style description
  generate --random        Generate from a random seed
  batch --count N          Batch generate N themes from seed library
  export <id> --format F   Export theme (css|css-block|json|switcher-js)
  export --all --format F  Export all themes
  validate <file...>       Validate theme JSON files
  list                     List all generated themes

Examples:
  node theme-generator.mjs generate "微软风格"
  node theme-generator.mjs generate "Apple Human Interface Guidelines"
  node theme-generator.mjs batch --count 20 --brand
  node theme-generator.mjs export --all --format css-block > themes.css
  node theme-generator.mjs export --all --format switcher-js`);
    break;
}

} // end isMain
