// theme-generator.test.mjs — Node.js built-in test runner
// Run: node --test extensions/design-intelligence/theme-generator.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractJson, sanitizeOverrides,
  parseColor, luminance, contrastRatio, checkContrast,
  validate, themeToCSS, themeToCSSBlock, themeToSwitcherEntry,
  REQUIRED_COLOR_KEYS, ALL_COLOR_KEYS, VALID_EFFECTS,
} from "./theme-generator.mjs";

// ─── Test fixtures ──────────────────────────────────────────────────

function makeValidTheme(overrides = {}) {
  return {
    id: "test-theme",
    name: "Test Theme",
    description: "A test theme",
    tags: ["light"],
    source: "custom",
    tokens: {
      color: {
        bg: "#ffffff", "bg-card": "#f8f8f8", text: "#111111", "text-muted": "#666666",
        accent: "#0066cc", "accent-light": "rgba(0,102,204,0.1)", "accent-hover": "#0055aa",
        border: "#dddddd", "passage-bg": "#f0f0f0", "passage-border": "#cccccc",
        "correct-color": "#228822", "correct-bg": "rgba(34,136,34,0.1)",
        "explanation-border": "#22882244",
        cat1: "#e63946", cat2: "#457b9d", cat3: "#2a9d8f", cat4: "#e9c46a", cat5: "#f4a261", cat6: "#264653",
      },
      typography: { "heading-font": "Georgia,serif", "body-font": "system-ui,sans-serif" },
      shape: { "border-radius": "8px", "card-shadow": "0 2px 4px rgba(0,0,0,0.1)" },
    },
    effects: ["hover-lift"],
    "google-fonts": [],
    overrides: "",
    ...overrides,
  };
}

// ─── extractJson ────────────────────────────────────────────────────

describe("extractJson", () => {
  test("extracts bare JSON object", () => {
    const json = extractJson('{"id":"foo","val":1}');
    assert.deepEqual(JSON.parse(json), { id: "foo", val: 1 });
  });

  test("extracts JSON from surrounding text", () => {
    const json = extractJson('Here is the result:\n{"id":"bar"}\nDone.');
    assert.deepEqual(JSON.parse(json), { id: "bar" });
  });

  test("extracts JSON from markdown fence", () => {
    const json = extractJson('```json\n{"id":"fenced"}\n```');
    assert.deepEqual(JSON.parse(json), { id: "fenced" });
  });

  test("extracts JSON from fence without language tag", () => {
    const json = extractJson('```\n{"id":"plain-fence"}\n```');
    assert.deepEqual(JSON.parse(json), { id: "plain-fence" });
  });

  test("handles nested braces correctly", () => {
    const input = '{"outer":{"inner":{"deep":1}}}trailing garbage}}}';
    const json = extractJson(input);
    assert.deepEqual(JSON.parse(json), { outer: { inner: { deep: 1 } } });
  });

  test("handles strings containing braces", () => {
    const input = '{"css":"body { color: red; }","id":"x"}';
    const json = extractJson(input);
    assert.deepEqual(JSON.parse(json), { css: "body { color: red; }", id: "x" });
  });

  test("handles escaped quotes in strings", () => {
    const input = '{"val":"she said \\"hi\\""}';
    const json = extractJson(input);
    assert.deepEqual(JSON.parse(json), { val: 'she said "hi"' });
  });

  test("throws on no JSON object", () => {
    assert.throws(() => extractJson("no json here"), /No JSON object found/);
  });

  test("throws on unbalanced braces", () => {
    assert.throws(() => extractJson('{"open": "never closed"'), /unbalanced braces/);
  });

  test("ignores trailing objects after first complete one", () => {
    const json = extractJson('{"first":1}{"second":2}');
    assert.deepEqual(JSON.parse(json), { first: 1 });
  });
});

// ─── sanitizeOverrides ─────────────────────────────────────────────

describe("sanitizeOverrides", () => {
  test("passes clean CSS through", () => {
    const css = ".card { color: red; background: blue; }";
    assert.equal(sanitizeOverrides(css), css);
  });

  test("returns empty string for null/undefined", () => {
    assert.equal(sanitizeOverrides(null), "");
    assert.equal(sanitizeOverrides(undefined), "");
    assert.equal(sanitizeOverrides(""), "");
  });

  test("returns empty string for non-string", () => {
    assert.equal(sanitizeOverrides(42), "");
    assert.equal(sanitizeOverrides({}), "");
  });

  test("blocks @import", () => {
    assert.match(sanitizeOverrides('@import url("evil.css")'), /blocked/);
  });

  test("blocks @charset", () => {
    assert.match(sanitizeOverrides('@charset "utf-8"'), /blocked/);
  });

  test("blocks expression()", () => {
    assert.match(sanitizeOverrides("width: expression(alert(1))"), /blocked/);
  });

  test("blocks javascript: url", () => {
    assert.match(sanitizeOverrides('background: url("javascript:alert(1)")'), /blocked/);
  });

  test("blocks </style> tag", () => {
    assert.match(sanitizeOverrides("color:red;</style><script>alert(1)</script>"), /blocked/);
  });

  test("blocks <script> tag", () => {
    assert.match(sanitizeOverrides("<script>alert(1)</script>"), /blocked/);
  });

  test("blocks -moz-binding", () => {
    assert.match(sanitizeOverrides("-moz-binding:url(evil.xml#xss)"), /blocked/);
  });

  test("blocks unbalanced closing brace (scope escape)", () => {
    assert.match(sanitizeOverrides("} .evil { color: red; }"), /unbalanced braces/);
  });

  test("allows balanced braces", () => {
    const css = ".nested { .inner { color: red; } }";
    assert.equal(sanitizeOverrides(css), css);
  });
});

// ─── parseColor ────────────────────────────────────────────────────

describe("parseColor", () => {
  test("parses 6-digit hex", () => {
    assert.deepEqual(parseColor("#ff8800"), { r: 255, g: 136, b: 0 });
  });

  test("parses 3-digit hex (expanded)", () => {
    assert.deepEqual(parseColor("#f80"), { r: 255, g: 136, b: 0 });
  });

  test("parses 8-digit hex (ignores alpha)", () => {
    assert.deepEqual(parseColor("#ff880080"), { r: 255, g: 136, b: 0 });
  });

  test("parses 4-digit hex (ignores alpha)", () => {
    assert.deepEqual(parseColor("#f808"), { r: 255, g: 136, b: 0 });
  });

  test("parses rgb()", () => {
    assert.deepEqual(parseColor("rgb(10, 20, 30)"), { r: 10, g: 20, b: 30 });
  });

  test("parses rgba()", () => {
    assert.deepEqual(parseColor("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30 });
  });

  test("case insensitive hex", () => {
    assert.deepEqual(parseColor("#FF8800"), { r: 255, g: 136, b: 0 });
  });

  test("returns null for null/undefined/empty", () => {
    assert.equal(parseColor(null), null);
    assert.equal(parseColor(undefined), null);
    assert.equal(parseColor(""), null);
  });

  test("returns null for unparseable formats", () => {
    assert.equal(parseColor("none"), null);
    assert.equal(parseColor("hsl(0,0%,100%)"), null);
    assert.equal(parseColor("oklch(0.5 0.2 120)"), null);
  });

  test("trims whitespace", () => {
    assert.deepEqual(parseColor("  #ff0000  "), { r: 255, g: 0, b: 0 });
  });
});

// ─── luminance & contrastRatio ──────────────────────────────────────

describe("luminance", () => {
  test("black = 0", () => {
    assert.equal(luminance({ r: 0, g: 0, b: 0 }), 0);
  });

  test("white = 1", () => {
    assert.ok(Math.abs(luminance({ r: 255, g: 255, b: 255 }) - 1) < 0.001);
  });

  test("mid-gray is between 0 and 1", () => {
    const l = luminance({ r: 128, g: 128, b: 128 });
    assert.ok(l > 0 && l < 1);
  });
});

describe("contrastRatio", () => {
  test("black on white = 21:1", () => {
    const ratio = contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
    assert.ok(Math.abs(ratio - 21) < 0.1);
  });

  test("same color = 1:1", () => {
    const c = { r: 100, g: 100, b: 100 };
    assert.equal(contrastRatio(c, c), 1);
  });

  test("order doesn't matter", () => {
    const c1 = { r: 0, g: 0, b: 0 };
    const c2 = { r: 255, g: 255, b: 255 };
    assert.equal(contrastRatio(c1, c2), contrastRatio(c2, c1));
  });
});

// ─── checkContrast ──────────────────────────────────────────────────

describe("checkContrast", () => {
  test("good contrast returns no issues", () => {
    const colors = {
      bg: "#ffffff", "bg-card": "#f8f8f8", text: "#111111", "text-muted": "#555555",
      accent: "#0044cc", "passage-bg": "#f0f0f0", "correct-color": "#006600", "correct-bg": "#eeffee",
    };
    const issues = checkContrast(colors);
    const failures = issues.filter(i => i.includes("fail"));
    assert.equal(failures.length, 0, `Unexpected failures: ${failures.join("; ")}`);
  });

  test("low text/bg contrast fails", () => {
    const colors = {
      bg: "#ffffff", "bg-card": "#ffffff", text: "#cccccc", "text-muted": "#dddddd",
      accent: "#eeeeee", "passage-bg": "#ffffff", "correct-color": "#ffffff", "correct-bg": "#ffffff",
    };
    const issues = checkContrast(colors);
    assert.ok(issues.some(i => i.includes("text on bg")), "Should flag text on bg");
  });

  test("warns on unparseable color formats", () => {
    const colors = {
      bg: "hsl(0,0%,100%)", "bg-card": "#ffffff", text: "#000000", "text-muted": "#666666",
      accent: "#0066cc", "passage-bg": "#f0f0f0", "correct-color": "#228822", "correct-bg": "#eeffee",
    };
    const issues = checkContrast(colors);
    assert.ok(issues.some(i => i.includes("cannot parse")), "Should warn about unparseable bg");
  });

  test("checks all 8 pairs", () => {
    // Use colors that will fail every pair
    const colors = {
      bg: "#808080", "bg-card": "#808080", text: "#888888", "text-muted": "#808080",
      accent: "#808080", "passage-bg": "#808080", "correct-color": "#808080", "correct-bg": "#808080",
    };
    const issues = checkContrast(colors);
    // Should have multiple failures covering text/bg, text/bg-card, muted, accent, passage, correct
    assert.ok(issues.length >= 4, `Expected at least 4 issues, got ${issues.length}: ${issues.join("; ")}`);
  });
});

// ─── validate ──────────────────────────────────────────────────────

describe("validate", () => {
  test("valid theme returns no errors", () => {
    const errors = validate(makeValidTheme());
    // Filter out WCAG warnings for structural validation
    const structural = errors.filter(e => !e.startsWith("WCAG"));
    assert.equal(structural.length, 0, `Unexpected errors: ${structural.join("; ")}`);
  });

  test("null input returns error", () => {
    const errors = validate(null);
    assert.ok(errors.length > 0);
  });

  test("missing id errors", () => {
    const theme = makeValidTheme();
    delete theme.id;
    assert.ok(validate(theme).some(e => e.includes("id")));
  });

  test("non-kebab-case id errors", () => {
    const theme = makeValidTheme({ id: "CamelCase" });
    assert.ok(validate(theme).some(e => e.includes("kebab-case")));
  });

  test("missing name errors", () => {
    const theme = makeValidTheme();
    delete theme.name;
    assert.ok(validate(theme).some(e => e.includes("name")));
  });

  test("missing tokens errors", () => {
    const theme = makeValidTheme();
    delete theme.tokens;
    assert.ok(validate(theme).some(e => e.includes("tokens")));
  });

  test("missing required color keys errors", () => {
    const theme = makeValidTheme();
    delete theme.tokens.color.bg;
    const errors = validate(theme);
    assert.ok(errors.some(e => e.includes("bg")));
  });

  test("unknown color key errors", () => {
    const theme = makeValidTheme();
    theme.tokens.color["made-up-key"] = "#ff0000";
    assert.ok(validate(theme).some(e => e.includes("Unknown color token")));
  });

  test("missing heading-font errors", () => {
    const theme = makeValidTheme();
    delete theme.tokens.typography["heading-font"];
    assert.ok(validate(theme).some(e => e.includes("heading-font")));
  });

  test("missing body-font errors", () => {
    const theme = makeValidTheme();
    delete theme.tokens.typography["body-font"];
    assert.ok(validate(theme).some(e => e.includes("body-font")));
  });

  test("border-radius=null errors", () => {
    const theme = makeValidTheme();
    theme.tokens.shape["border-radius"] = null;
    assert.ok(validate(theme).some(e => e.includes("border-radius")));
  });

  test("border-radius=0px is valid (falsy but present)", () => {
    const theme = makeValidTheme();
    theme.tokens.shape["border-radius"] = "0px";
    theme.tokens.shape["card-shadow"] = "none";
    const errors = validate(theme).filter(e => !e.startsWith("WCAG"));
    assert.ok(!errors.some(e => e.includes("border-radius")), `Should not error on 0px: ${errors.join("; ")}`);
  });

  test("card-shadow=none is valid", () => {
    const theme = makeValidTheme();
    theme.tokens.shape["card-shadow"] = "none";
    const errors = validate(theme).filter(e => !e.startsWith("WCAG"));
    assert.ok(!errors.some(e => e.includes("card-shadow")));
  });

  test("card-shadow=null errors", () => {
    const theme = makeValidTheme();
    theme.tokens.shape["card-shadow"] = null;
    assert.ok(validate(theme).some(e => e.includes("card-shadow")));
  });

  test("unknown effect errors", () => {
    const theme = makeValidTheme({ effects: ["nonexistent-effect"] });
    assert.ok(validate(theme).some(e => e.includes("Unknown effect")));
  });

  test("valid effects pass", () => {
    const theme = makeValidTheme({ effects: ["hover-lift", "glass-cards"] });
    const errors = validate(theme).filter(e => e.includes("effect"));
    assert.equal(errors.length, 0);
  });
});

// ─── Schema-derived constants ───────────────────────────────────────

describe("schema-derived constants", () => {
  test("REQUIRED_COLOR_KEYS matches schema", () => {
    const expected = ["bg", "bg-card", "text", "text-muted", "accent", "accent-light", "border", "correct-color", "correct-bg"];
    assert.deepEqual(REQUIRED_COLOR_KEYS, expected);
  });

  test("ALL_COLOR_KEYS includes all schema color properties", () => {
    assert.ok(ALL_COLOR_KEYS.includes("bg"));
    assert.ok(ALL_COLOR_KEYS.includes("cat6"));
    assert.ok(ALL_COLOR_KEYS.includes("passage-bg"));
    assert.ok(ALL_COLOR_KEYS.length >= 17); // 9 required + optional
  });

  test("VALID_EFFECTS matches schema enum", () => {
    assert.ok(VALID_EFFECTS.includes("hover-lift"));
    assert.ok(VALID_EFFECTS.includes("scanline-overlay"));
    assert.ok(!VALID_EFFECTS.includes("nonexistent"));
    assert.equal(VALID_EFFECTS.length, 8);
  });
});

// ─── themeToCSS / themeToCSSBlock ──────────────────────────────────

describe("themeToCSS", () => {
  test("generates valid CSS custom properties block", () => {
    const theme = makeValidTheme();
    const css = themeToCSS(theme);
    assert.ok(css.includes('[data-theme="test-theme"]'));
    assert.ok(css.includes("--bg:#ffffff"));
    assert.ok(css.includes("--accent:#0066cc"));
    assert.ok(css.includes("--heading-font:Georgia,serif"));
    assert.ok(css.includes("--border-radius:8px"));
  });

  test("includes mono-font when present", () => {
    const theme = makeValidTheme();
    theme.tokens.typography["mono-font"] = "'Fira Code',monospace";
    const css = themeToCSS(theme);
    assert.ok(css.includes("--mono-font:'Fira Code',monospace"));
  });
});

describe("themeToCSSBlock", () => {
  test("includes effect CSS", () => {
    const theme = makeValidTheme({ effects: ["hover-lift"] });
    const css = themeToCSSBlock(theme);
    assert.ok(css.includes("translateY(-2px)"));
  });

  test("sanitizes overrides", () => {
    const theme = makeValidTheme({ overrides: '@import url("evil.css")' });
    const css = themeToCSSBlock(theme);
    assert.ok(css.includes("blocked"));
    assert.ok(!css.includes("evil.css"));
  });

  test("includes clean overrides", () => {
    const theme = makeValidTheme({ overrides: "font-weight: bold" });
    const css = themeToCSSBlock(theme);
    assert.ok(css.includes("font-weight: bold"));
  });

  test("handles empty overrides gracefully", () => {
    const theme = makeValidTheme({ overrides: "" });
    const css = themeToCSSBlock(theme);
    assert.ok(!css.includes("undefined"));
  });
});

// ─── themeToSwitcherEntry ──────────────────────────────────────────

describe("themeToSwitcherEntry", () => {
  test("returns valid JSON string", () => {
    const theme = makeValidTheme();
    const entry = themeToSwitcherEntry(theme);
    const parsed = JSON.parse(entry);
    assert.equal(parsed.id, "test-theme");
    assert.equal(parsed.name, "Test Theme");
    assert.equal(parsed.dot, "#0066cc");
  });

  test("neutralizes quote injection via JSON.stringify", () => {
    // Old code used string interpolation: `name:'${theme.name}'` — a name with quotes broke out
    const theme = makeValidTheme({ name: "Test','hack':'pwned" });
    const entry = themeToSwitcherEntry(theme);
    // JSON.stringify escapes internal quotes, so no breakout
    const parsed = JSON.parse(entry);
    assert.equal(parsed.name, "Test','hack':'pwned");
    // The entry must be valid JSON (no syntax break)
    assert.doesNotThrow(() => JSON.parse(entry));
  });

  test("handles missing description", () => {
    const theme = makeValidTheme();
    delete theme.description;
    const entry = themeToSwitcherEntry(theme);
    const parsed = JSON.parse(entry);
    assert.equal(parsed.desc, "");
  });

  test("neutralizes quotes in id", () => {
    const theme = makeValidTheme({ id: 'test"theme' });
    const entry = themeToSwitcherEntry(theme);
    // JSON.stringify escapes the quote
    const parsed = JSON.parse(entry);
    assert.equal(parsed.id, 'test"theme');
  });
});
