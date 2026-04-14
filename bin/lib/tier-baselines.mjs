// Quality tier baseline definitions — single source of truth.
// Used by: init (store tier), synthesize (coverage check), tier-baseline (P0 test cases).
// No I/O, no dependencies.

export const VALID_TIERS = new Set(["functional", "polished", "delightful"]);

// Each baseline item has:
//   key: machine-readable identifier
//   label: human-readable name
//   keywords: strings to search for in evaluator output (case-insensitive)
//   severity: { functional, polished, delightful } — null means "not applicable"
//   testCase: auto-generated P0 test case for test-design injection
export const TIER_BASELINES = [
  {
    key: "typography",
    label: "Typography hierarchy",
    keywords: ["typography", "font", "typeface", "font-family", "font stack"],
    severity: { functional: null, polished: "warning", delightful: "critical" },
    testCase: {
      category: "e2e-ui",
      description: "Verify intentional typography hierarchy with at least 2 distinct typefaces (heading vs body). System defaults are not acceptable at this tier.",
      steps: [
        "Open the main page in a browser",
        "Inspect heading elements (h1, h2, h3) — note the font-family",
        "Inspect body text — note the font-family",
        "Verify at least 2 distinct typefaces are used",
        "Check that web fonts load with font-display: swap (no FOIT)",
      ],
      expected: "Headings and body use different, intentional typefaces. No system-default-only typography.",
      failureImpact: "Product looks like an unstyled prototype — undermines professional credibility.",
    },
  },
  {
    key: "color-scheme",
    label: "Dark/light theme support",
    keywords: ["dark", "light", "theme", "color scheme", "prefers-color-scheme", "color token", "design token"],
    severity: { functional: null, polished: "warning", delightful: "critical" },
    testCase: {
      category: "e2e-ui",
      description: "Verify dark/light theme support. Must respect prefers-color-scheme or provide a toggle.",
      steps: [
        "Open the app with system set to light mode — screenshot",
        "Switch system to dark mode (or use toggle) — screenshot",
        "Compare: all text must be readable, no hardcoded colors breaking contrast",
        "Check that colors use CSS custom properties or design tokens, not hardcoded hex",
      ],
      expected: "App renders correctly in both light and dark modes. All text readable, no contrast failures.",
      failureImpact: "Users in dark mode see broken UI — white text on white, invisible elements.",
    },
  },
  {
    key: "navigation",
    label: "Structured navigation",
    keywords: ["navigation", "sidebar", "nav", "menu", "active state", "collapsible"],
    severity: { functional: null, polished: "critical", delightful: "critical" },
    testCase: {
      category: "e2e-ui",
      description: "Verify persistent, structured navigation with active state indicator.",
      steps: [
        "Open the app — verify navigation is visible (sidebar, top nav, or tabs)",
        "Click different navigation items — verify active state indicator updates",
        "Resize to mobile viewport (375px) — verify navigation collapses or adapts",
        "Verify navigation is not just inline links in page content",
      ],
      expected: "Persistent navigation with clear active state. Collapses appropriately on mobile.",
      failureImpact: "Users cannot navigate the product efficiently — no wayfinding.",
    },
  },
  {
    key: "responsive",
    label: "Responsive layout",
    keywords: ["responsive", "mobile", "viewport", "breakpoint", "320px", "768px", "1024px", "1440px"],
    severity: { functional: null, polished: "critical", delightful: "critical" },
    testCase: {
      category: "e2e-ui",
      description: "Verify responsive layout at standard breakpoints: 320px, 768px, 1024px, 1440px.",
      steps: [
        "Screenshot at 1440px width — verify desktop layout",
        "Screenshot at 1024px width — verify tablet landscape",
        "Screenshot at 768px width — verify tablet portrait",
        "Screenshot at 320px width — verify mobile",
        "At each viewport: no horizontal scroll, no content overflow, no overlapping elements",
      ],
      expected: "Layout adapts correctly at all 4 breakpoints. No horizontal scroll on any viewport.",
      failureImpact: "Mobile users see broken layout — unusable on the most common device type.",
    },
  },
  {
    key: "code-blocks",
    label: "Styled code blocks",
    keywords: ["code block", "syntax highlight", "copy button", "code styling", "prism", "shiki", "hljs"],
    severity: { functional: null, polished: "warning", delightful: "critical" },
    testCase: {
      category: "e2e-ui",
      description: "Verify code blocks have syntax highlighting, theme-consistent colors, and copy button.",
      steps: [
        "Find a page with code blocks",
        "Verify syntax highlighting is applied (colored tokens, not monochrome)",
        "Verify colors are consistent with the app's theme (light/dark)",
        "Verify a copy button is present on code blocks",
        "Click copy — verify code is copied to clipboard",
      ],
      expected: "Code blocks are syntax-highlighted, theme-aware, and have a working copy button.",
      failureImpact: "Default-styled code blocks look unprofessional in a developer-facing product.",
    },
  },
  {
    key: "tables",
    label: "Styled tables",
    keywords: ["table", "striped", "bordered", "hover", "cell padding", "table styling"],
    severity: { functional: null, polished: "warning", delightful: "critical" },
    testCase: {
      category: "e2e-ui",
      description: "Verify tables have styled rows (striped or bordered), hover effect, and proper padding.",
      steps: [
        "Find a page with a data table",
        "Verify rows are visually distinct (striped or bordered)",
        "Hover over rows — verify hover effect",
        "Check cell padding is adequate (not cramped)",
        "On mobile (375px), verify table is horizontally scrollable if too wide",
      ],
      expected: "Tables are styled, have hover feedback, and scroll horizontally on mobile.",
      failureImpact: "Default browser tables look amateur — dense, unreadable, no visual hierarchy.",
    },
  },
  {
    key: "testing-md",
    label: "TESTING.md with feature inventory",
    keywords: ["testing.md", "testing doc", "feature inventory", "qa doc", "test documentation"],
    severity: { functional: null, polished: "warning", delightful: "critical" },
    testCase: {
      category: "integration",
      description: "Verify TESTING.md exists with environment setup, feature inventory, and cleanup instructions for someone who has never seen the source code.",
      steps: [
        "Check that TESTING.md exists in project root",
        "Verify it contains: environment setup with exact commands",
        "Verify it contains: feature inventory table (feature, command/entry point, expected behavior)",
        "Verify it contains: cleanup/reset instructions between test runs",
        "Verify instructions are copy-paste-able by someone without source code access",
      ],
      expected: "TESTING.md exists with setup, feature inventory, and cleanup sections. All instructions work from a clean environment.",
      failureImpact: "QA and new contributors cannot test the product without reading source code — black-box testing impossible.",
    },
  },
  {
    key: "loading-states",
    label: "Loading states",
    keywords: ["loading", "spinner", "skeleton", "async", "loading state"],
    severity: { functional: "suggestion", polished: "warning", delightful: "critical" },
    testCase: {
      category: "e2e-ui",
      description: "Verify every async operation shows a loading state (skeleton or spinner, not blank).",
      steps: [
        "Trigger an async operation (page load, data fetch, form submit)",
        "Observe the transition — there should be a skeleton, spinner, or progress indicator",
        "Verify no blank/white screen during loading",
      ],
      expected: "All async operations show visible loading feedback.",
      failureImpact: "Users see blank screens during loading — think the app is broken.",
    },
  },
  {
    key: "error-states",
    label: "Error states with recovery",
    keywords: ["error", "error state", "recovery", "retry", "error handling"],
    severity: { functional: "suggestion", polished: "warning", delightful: "critical" },
    testCase: {
      category: "e2e-ui",
      description: "Verify error states show actionable recovery (not just 'something went wrong').",
      steps: [
        "Trigger an error condition (bad input, network failure, 404)",
        "Verify an error message is shown with specific context",
        "Verify a recovery action is provided (retry button, back link, suggestion)",
      ],
      expected: "Errors show specific message and recovery action.",
      failureImpact: "Users hit dead ends with no way to recover — abandon the product.",
    },
  },
  {
    key: "favicon-meta",
    label: "Favicon and meta tags",
    keywords: ["favicon", "meta", "og:image", "title", "description", "meta tag"],
    severity: { functional: null, polished: "warning", delightful: "critical" },
    testCase: {
      category: "e2e-ui",
      description: "Verify favicon is set and meta tags (title, description, og:image) are present.",
      steps: [
        "Open the app — check browser tab for favicon (not default browser icon)",
        "View page source — verify <title> tag is set",
        "Verify meta description tag exists",
        "Verify og:image tag exists for social sharing",
      ],
      expected: "Custom favicon displayed, title/description/og:image meta tags present.",
      failureImpact: "Shared links show no preview — looks unfinished. Browser tab has generic icon.",
    },
  },
  {
    key: "focus-styles",
    label: "Keyboard focus styles",
    keywords: ["focus", "focus-visible", "keyboard", "tab", "a11y", "accessibility"],
    severity: { functional: "suggestion", polished: "warning", delightful: "critical" },
    testCase: {
      category: "e2e-ui",
      description: "Verify focus-visible styles for keyboard navigation on interactive elements.",
      steps: [
        "Tab through the page using keyboard only",
        "Verify every interactive element (links, buttons, inputs) shows a visible focus ring",
        "Verify focus order is logical (top-to-bottom, left-to-right)",
      ],
      expected: "All interactive elements have visible focus indicators when navigated by keyboard.",
      failureImpact: "Keyboard-only users cannot see where they are — accessibility failure.",
    },
  },
  {
    key: "page-transitions",
    label: "Smooth page transitions",
    keywords: ["transition", "animation", "page transition", "fade", "slide", "cross-fade"],
    severity: { functional: null, polished: "suggestion", delightful: "warning" },
    testCase: {
      category: "e2e-ui",
      description: "Verify smooth page/view transitions (fade, slide, or cross-fade — not hard cuts).",
      steps: [
        "Navigate between pages/views",
        "Observe transition — should be smooth (fade, slide, cross-fade)",
        "Not a hard cut (instant content swap)",
      ],
      expected: "Page transitions are animated and smooth.",
      failureImpact: "Hard cuts feel jarring — breaks the illusion of a cohesive product.",
    },
  },
  {
    key: "micro-interactions",
    label: "Micro-interactions",
    keywords: ["micro-interaction", "hover effect", "button feedback", "animation", "interaction"],
    severity: { functional: null, polished: null, delightful: "warning" },
    testCase: {
      category: "e2e-ui",
      description: "Verify micro-interactions on user actions (button press feedback, hover effects, success animations).",
      steps: [
        "Hover over buttons — verify visual feedback (color change, shadow, scale)",
        "Click a button — verify press feedback",
        "Complete a success action — verify success animation or feedback",
      ],
      expected: "Interactive elements provide visual feedback on hover, press, and success.",
      failureImpact: "Product feels static and unresponsive — no sense of direct manipulation.",
    },
  },
];

/**
 * Get baseline items applicable to a given tier.
 * Returns items where severity[tier] is not null.
 */
export function getBaselineForTier(tier) {
  if (!VALID_TIERS.has(tier)) return [];
  return TIER_BASELINES.filter((item) => item.severity[tier] != null);
}

/**
 * Get the severity level for a baseline item at a given tier.
 */
export function getSeverity(item, tier) {
  return item.severity[tier] || null;
}

/**
 * Generate P0 test cases for a tier (for injection into test-design).
 * Only includes items where severity >= warning (i.e., not just suggestion).
 */
export function generateTierTestCases(tier) {
  if (!VALID_TIERS.has(tier)) return [];
  const items = getBaselineForTier(tier);
  return items
    .filter((item) => item.severity[tier] === "warning" || item.severity[tier] === "critical")
    .map((item, idx) => ({
      id: `TC-TIER-${String(idx + 1).padStart(2, "0")}`,
      category: item.testCase.category,
      priority: "P0",
      description: item.testCase.description,
      steps: item.testCase.steps,
      expected: item.testCase.expected,
      failureImpact: item.testCase.failureImpact,
      baselineKey: item.key,
      label: item.label,
    }));
}

/**
 * Get the set of baseline keys required at warning or critical severity.
 * These are the keys an execute node MUST declare in tierCoverage.
 */
export function getRequiredBaselineKeys(tier) {
  if (!VALID_TIERS.has(tier)) return new Set();
  return new Set(
    getBaselineForTier(tier)
      .filter((item) => item.severity[tier] === "warning" || item.severity[tier] === "critical")
      .map((item) => item.key)
  );
}

/**
 * Get all valid baseline keys for a tier (including suggestion-severity items).
 */
export function getAllBaselineKeys(tier) {
  if (!VALID_TIERS.has(tier)) return new Set();
  return new Set(getBaselineForTier(tier).map((item) => item.key));
}

/**
 * Check evaluator text for coverage of tier baseline items.
 * Returns { covered: [...], uncovered: [...] } where each entry has { key, label, severity }.
 */
export function checkBaselineCoverage(evalText, tier) {
  if (!VALID_TIERS.has(tier)) return { covered: [], uncovered: [] };
  const items = getBaselineForTier(tier);
  const lowerText = evalText.toLowerCase();
  const covered = [];
  const uncovered = [];

  for (const item of items) {
    const found = item.keywords.some((kw) => lowerText.includes(kw.toLowerCase()));
    const entry = { key: item.key, label: item.label, severity: item.severity[tier] };
    if (found) {
      covered.push(entry);
    } else {
      uncovered.push(entry);
    }
  }

  return { covered, uncovered };
}
