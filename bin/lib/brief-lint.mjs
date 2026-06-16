// Brief lint — mechanical quality gate for build briefs.
// Ensures briefs are concrete, unambiguous, and mechanically executable.
// Depends on: util.mjs (getFlag).

import { readFileSync } from "fs";
import { getFlag } from "./util.mjs";

// ── Section extraction ─────────────────────────────────────────
function extractSections(text) {
  const sections = {};
  const parts = text.split(/^## /m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const nlIdx = part.indexOf("\n");
    const header = nlIdx >= 0 ? part.slice(0, nlIdx).trim() : part.trim();
    const body = nlIdx >= 0 ? part.slice(nlIdx + 1) : "";
    sections[header] = body;
  }
  return sections;
}

// ── Vague design words — these must not appear in a resolved brief ──
const VAGUE_DESIGN_WORDS = /\b(appropriate|suitable|nice|good|proper|warm color|cool tone|pleasant|attractive|clean look|modern feel|professional appearance)\b/i;

// ── Incompleteness markers ──
const INCOMPLETE_MARKERS = /\b(etc\.?|and more|as needed|and so on|to be determined|TBD|TODO)\b/i;

// ── Hex color pattern ──
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g;

// ── Quantified value pattern (numbers with units) ──
const QUANTIFIED_VALUE = /\d+\s*(px|rem|em|ms|s|%|:1|vw|vh|fr)\b/i;

// ── Has bullet items ──
const HAS_BULLETS = /^-\s+/m;

// ── Has concrete data (numbers, quoted strings, specific values) ──
const HAS_CONCRETE_DATA = /(\d{2,}|["'][^"']{2,}["']|¥|€|\$|\£|https?:\/\/)/;

// ── Run all checks ─────────────────────────────────────────────
export function runBriefLint(text, opts = {}) {
  const sections = extractSections(text);
  const failures = [];
  const warnings = [];
  let checksRun = 0;

  const fail = (check, msg) => failures.push({ check, message: msg });
  const warn = (check, msg) => warnings.push({ check, message: msg });

  // ── 1. file-plan-exists ──
  checksRun++;
  const filePlanSection = sections["File Plan"];
  if (filePlanSection === undefined) {
    fail("file-plan-exists", "No '## File Plan' section found");
  } else if (!HAS_BULLETS.test(filePlanSection)) {
    fail("file-plan-exists", "'## File Plan' section has no bullet items");
  }

  // ── 2. file-plan-complete ──
  checksRun++;
  if (filePlanSection) {
    const incompleteMatch = filePlanSection.match(INCOMPLETE_MARKERS);
    if (incompleteMatch) {
      fail("file-plan-complete", `File Plan contains '${incompleteMatch[0]}' — list every file explicitly`);
    }
  }

  // ── 3. tech-decisions-resolved ──
  checksRun++;
  const techSection = sections["Technology Decisions"];
  if (techSection === undefined) {
    fail("tech-decisions-resolved", "No '## Technology Decisions' section found");
  } else {
    // Must have at least one version number (e.g. v4.4.0, 2.1, @18)
    const hasVersion = /v?\d+\.\d+(\.\d+)?|@\d+/i.test(techSection);
    if (!hasVersion) {
      fail("tech-decisions-resolved", "Technology Decisions has no version numbers — specify library@version for every dependency");
    }
    // Reject open-ended tech choices
    const OPEN_ENDED_TECH = /\b(use a |choose a |pick a |select a |find a |some |any )(library|framework|package|tool|solution|charting|component|module)\b/i;
    const openMatch = techSection.match(OPEN_ENDED_TECH);
    if (openMatch) {
      fail("tech-decisions-resolved", `Open-ended tech choice: '${openMatch[0]}' — name the specific library and version`);
    }
    // Reject bare language/runtime names without a specific library
    // "Use JavaScript v1.0 via CDN" is not a tech decision — a real one names a library (Chart.js, React, D3)
    const BARE_LANG = /\b(use |via )(JavaScript|TypeScript|Python|Ruby|Go|Rust|Java|HTML|CSS)\b/i;
    const bareLangMatch = techSection.match(BARE_LANG);
    if (bareLangMatch) {
      // Only flag if there's no actual library name nearby (heuristic: no npm-style package name)
      const hasLibrary = /\b[a-z][\w-]*\.js\b|@[\w-]+\/[\w-]+|\b(chart|react|vue|angular|d3|tailwind|bootstrap|express|next|nuxt|vite|webpack|rollup|esbuild|axios|lodash|moment|dayjs|three|gsap|framer)[\w.-]*/i.test(techSection);
      if (!hasLibrary) {
        fail("tech-decisions-resolved", `Bare language '${bareLangMatch[0]}' without specific library — name the npm package, CDN library, or framework`);
      }
    }
    // Must have at least one source reference (CDN URL, npm package, or file path)
    const hasSource = /https?:\/\/|cdn\.|unpkg|jsdelivr|cdnjs|npm |yarn |pnpm |node_modules|from ['"]|import ['"]|require\(/i.test(techSection);
    if (!hasSource) {
      warn("tech-decisions-source", "No CDN URL, npm package, or import reference found — consider adding source for each dependency");
    }
  }

  // ── 4. tokens-resolved (skipped for functional tier) ──
  const isFunctional = opts.tier === "functional";
  const hexColors = text.match(HEX_COLOR) || [];
  if (!isFunctional) {
    checksRun++;
    if (hexColors.length < 3) {
      fail("tokens-resolved", `Found ${hexColors.length} hex color values — need ≥3 resolved design tokens`);
    }
  }

  // ── 5. no-vague-design (skipped for functional tier) ──
  if (!isFunctional) {
    checksRun++;
    const vagueMatch = text.match(VAGUE_DESIGN_WORDS);
    if (vagueMatch) {
      fail("no-vague-design", `Brief contains vague design term '${vagueMatch[0]}' — resolve to specific values`);
    }
  }

  // ── 6. data-fixtures (skipped for functional tier) ──
  // Accepts "Component Inventory" OR "API Contract" OR "Data Contract"
  if (!isFunctional) {
    checksRun++;
    const dataKey = Object.keys(sections).find(k =>
      k === "Component Inventory" || k.toLowerCase().includes("api contract") || k.toLowerCase().includes("data contract")
    );
    const dataSection = dataKey ? sections[dataKey] : undefined;
    if (dataSection === undefined) {
      fail("data-fixtures", "No '## Component Inventory' or '## API Contract' section found");
    } else if (!HAS_CONCRETE_DATA.test(dataSection)) {
      fail("data-fixtures", `${dataKey} has no concrete data (numbers, quoted strings, URLs) — add specific mock values`);
    }
  }

  // ── 7. constraints-quantified ──
  checksRun++;
  const constraintsKey = Object.keys(sections).find(k =>
    k.toLowerCase().startsWith("constraint")
  );
  const constraintsSection = constraintsKey ? sections[constraintsKey] : undefined;
  if (constraintsSection === undefined) {
    fail("constraints-quantified", "No '## Constraints' section found");
  } else if (!QUANTIFIED_VALUE.test(constraintsSection)) {
    fail("constraints-quantified", "Constraints section has no quantified values (px, rem, ms, ratio) — add measurable thresholds");
  }

  // ── 8. iteration-delta ──
  checksRun++;
  if (opts.hasPriorFindings) {
    const deltaKey = Object.keys(sections).find(k =>
      k.toLowerCase().includes("iteration") || k.toLowerCase().includes("delta")
    );
    if (!deltaKey) {
      fail("iteration-delta", "Gate returned ITERATE but brief has no '## Iteration Delta' section — list specific changes from prior findings");
    }
  }

  // ── Warnings ──

  // W1: tokens section name variant
  const tokensKey = Object.keys(sections).find(k =>
    k.toLowerCase().includes("token") || k.toLowerCase().includes("design token")
  );
  if (!tokensKey && hexColors.length >= 3) {
    warn("tokens-section-name", "Hex colors found but no dedicated tokens section — consider adding '## Design Tokens'");
  }

  // W2: no file count estimates — upgraded to failure (brief protocol requires estimates)
  checksRun++;
  if (filePlanSection && !/~?\d+\s*(lines?|loc)/i.test(filePlanSection)) {
    fail("file-plan-estimates", "File Plan has no line count estimates — add ~N lines per file");
  }

  const passed = checksRun - failures.length;
  return { passed, failures, warnings, checksRun };
}

// ══════════════════════════════════════════════════════════════
// cmdBriefLint — main command
// ══════════════════════════════════════════════════════════════
export function cmdBriefLint(args) {
  const file = args[0];
  const hasPriorFindings = args.includes("--has-prior-findings");
  const tier = getFlag(args, "tier") || undefined;

  if (!file) {
    console.error("Usage: opc-harness brief-lint <file> [--has-prior-findings] [--tier functional|polished|delightful]");
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

  const result = runBriefLint(text, { hasPriorFindings, tier });
  const ok = result.failures.length === 0;

  // Human-readable output to stderr
  if (ok) {
    console.error(`✅ brief-lint: ${result.passed} checks passed, ${result.warnings.length} warning${result.warnings.length !== 1 ? "s" : ""}`);
  } else {
    console.error(`❌ brief-lint: ${result.failures.length} failure${result.failures.length !== 1 ? "s" : ""}, ${result.warnings.length} warning${result.warnings.length !== 1 ? "s" : ""}`);
  }
  for (const f of result.failures) {
    console.error(`  ❌ ${f.check}: ${f.message}`);
  }
  for (const w of result.warnings) {
    console.error(`  ⚠️  ${w.check}: ${w.message}`);
  }

  // Machine-readable JSON to stdout
  console.log(JSON.stringify({
    pass: ok,
    checksRun: result.checksRun,
    checksPassed: result.passed,
    failures: result.failures,
    warnings: result.warnings,
  }, null, 2));

  process.exit(ok ? 0 : 1);
}
