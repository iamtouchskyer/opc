// hook.mjs — design-intelligence extension
//
// Capability: design-system-injection@1
// Fills the build-verify and full-stack flow templates' build node capability.
//
// Hooks:
//   startupCheck — verify themes dir exists
//   promptAppend — inject design token schema + theme guidance into build prompts
//   verdictAppend — check for hardcoded colors in review nodes
//
// Install: symlink or copy to ~/.opc/extensions/design-intelligence/

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEMES_DIR = join(__dirname, "themes");
const SCHEMA_PATH = join(__dirname, "theme-schema.json");
const PROMPT_PATH = join(__dirname, "prompt.md");

export const meta = {
  provides: ["design-system-injection@1"],
  compatibleCapabilities: ["design-spec-conformance@1"],
  description: "Injects design system tokens and theme generation guidance into build nodes. Checks for hardcoded colors in review nodes.",
};

export function startupCheck() {
  if (!existsSync(THEMES_DIR)) {
    process.stderr.write(
      `[design-intelligence] WARN: themes/ dir not found at ${THEMES_DIR} — promptAppend will use schema-only mode\n`
    );
  }
  if (!existsSync(SCHEMA_PATH)) {
    throw new Error(`theme-schema.json not found at ${SCHEMA_PATH}`);
  }
}

export function promptAppend(ctx) {
  if (!ctx?.task) return "";

  const parts = [];

  // Always inject the prompt.md template if it exists
  if (existsSync(PROMPT_PATH)) {
    parts.push(readFileSync(PROMPT_PATH, "utf8"));
  }

  // Inject the schema as reference
  if (existsSync(SCHEMA_PATH)) {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    parts.push(`## Theme JSON Schema\n\n\`\`\`json\n${schema}\n\`\`\``);
  }

  // List available themes if any exist
  if (existsSync(THEMES_DIR)) {
    const themes = readdirSync(THEMES_DIR)
      .filter(f => f.endsWith(".json") && !f.startsWith("_"));
    if (themes.length > 0) {
      parts.push(`## Available Themes (${themes.length})\n\n${themes.map(f => `- ${f.replace(".json", "")}`).join("\n")}`);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : "";
}

export function verdictAppend(ctx) {
  if (!ctx?.runDir) return [];

  const findings = [];

  // Scan artifacts for hardcoded color values that should use CSS variables
  try {
    const artifactsDir = join(ctx.runDir, "artifacts");
    if (!existsSync(artifactsDir)) return [];

    const files = readdirSync(artifactsDir).filter(f =>
      f.endsWith(".html") || f.endsWith(".css") || f.endsWith(".tsx") || f.endsWith(".jsx") || f.endsWith(".vue")
    );

    for (const file of files) {
      const content = readFileSync(join(artifactsDir, file), "utf8");

      // Look for inline color values in style attributes or CSS that could be variables
      const hexInStyle = content.match(/(?:color|background|border)[^;]*:#[0-9a-f]{3,8}/gi);
      if (hexInStyle && hexInStyle.length > 5) {
        findings.push({
          severity: "warning",
          category: "design-system-injection",
          message: `${file} has ${hexInStyle.length} hardcoded color values — consider using CSS custom properties (--bg, --accent, etc.) for theme support`,
          file,
        });
      }
    }
  } catch (err) {
    process.stderr.write(
      `[design-intelligence] WARN: verdictAppend scan failed: ${err?.message}\n`
    );
  }

  return findings;
}

export function executeRun() {
  // No-op: theme generation doesn't need live server interaction
  return;
}

export function artifactEmit(ctx) {
  if (!ctx?.runDir) return [];
  // Future: if build produced a new theme JSON in artifacts, validate and copy to themes/
  return [];
}
