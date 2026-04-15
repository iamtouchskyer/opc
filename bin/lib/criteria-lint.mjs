// Criteria lint — mechanical DoD quality check for acceptance-criteria.md.
// Single-pass, zero-token-cost structural validation.
// Depends on: util.mjs (getFlag).

import { readFileSync } from "fs";
import { getFlag } from "./util.mjs";
import { VALID_TIERS } from "./tier-baselines.mjs";

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

// ── Extract OUT-N bullets ──────────────────────────────────────
function extractOutcomes(sectionsBody) {
  const outcomes = [];
  const re = /^-\s+(OUT-(\d+):\s*.+)$/gm;
  let m;
  while ((m = re.exec(sectionsBody)) !== null) {
    outcomes.push({ id: `OUT-${m[2]}`, text: m[1], num: parseInt(m[2], 10) });
  }
  return outcomes;
}

// ── Jaccard similarity on word sets ────────────────────────────
function jaccard(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// ── Vague word detection ───────────────────────────────────────
const VAGUE_WORDS = /\b(fast|clean|intuitive|responsive|robust|secure|correct|handles edge cases|user-friendly|seamless|smooth)\b/i;
const HAS_MEASUREMENT = /\d|threshold|measured by|within \d|under \d|at least|no more than|percent|%|ms|seconds/i;

// ── Impossible to fail phrases ─────────────────────────────────
const IMPOSSIBLE_PHRASES = /\b(should work|intended purpose|as expected|properly|correctly)\b/i;
const HAS_CONCRETE_TEST = /\b(returns|outputs|responds with|status code|HTTP \d|throws|rejects|contains|matches|equals|asserts)\b/i;

// ── Manual-only verification ───────────────────────────────────
const MANUAL_ONLY = /\b(manual inspection|code review|looks correct|it should be obvious|visually inspect)\b/i;

// ── Run all checks ─────────────────────────────────────────────
function runLint(text, tier) {
  const sections = extractSections(text);
  const failures = [];
  const warnings = [];
  let checksRun = 0;

  // Helper
  const fail = (check, msg) => failures.push({ check, message: msg });
  const warn = (check, msg) => warnings.push({ check, message: msg });

  // ── Structural checks (7) ──────────────────────────────────

  // 1. outcomes-exist
  checksRun++;
  const outcomesSection = sections["Outcomes"];
  if (outcomesSection === undefined) {
    fail("outcomes-exist", "No outcomes section or no OUT-N bullets found");
  }

  const outcomes = outcomesSection ? extractOutcomes(outcomesSection) : [];

  // 2. outcomes-count
  checksRun++;
  if (outcomesSection && (outcomes.length < 3 || outcomes.length > 7)) {
    fail("outcomes-count", `Found ${outcomes.length} outcomes — must be 3-7`);
  }

  // 3. verification-exists
  checksRun++;
  const verificationSection = sections["Verification"];
  if (verificationSection === undefined) {
    fail("verification-exists", "No verification section");
  }

  // 4. verification-mapped
  checksRun++;
  if (verificationSection && outcomes.length > 0) {
    for (const out of outcomes) {
      if (!verificationSection.includes(out.id)) {
        fail("verification-mapped", `${out.id} has no verification method`);
      }
    }
  }

  // 5. quality-section
  checksRun++;
  if (sections["Quality Constraints"] === undefined) {
    fail("quality-section", "No quality constraints section");
  }

  // 6. scope-section
  checksRun++;
  if (sections["Out of Scope"] === undefined) {
    fail("scope-section", "No out-of-scope section");
  }

  // 7. tier-section
  checksRun++;
  if (tier && VALID_TIERS.has(tier)) {
    const tierKey = Object.keys(sections).find((k) =>
      k.toLowerCase().startsWith("quality baseline")
    );
    if (!tierKey) {
      fail("tier-section", `Tier is '${tier}' but no quality baseline section`);
    }
  }

  // ── Content checks (4) ─────────────────────────────────────

  // 8. no-vague-outcomes
  checksRun++;
  for (const out of outcomes) {
    // Strip "OUT-N: " prefix for content analysis — prefix digits cause false positives
    const contentText = out.text.replace(/^OUT-\d+:\s*/, "");
    const vagueMatch = contentText.match(VAGUE_WORDS);
    if (vagueMatch && !HAS_MEASUREMENT.test(contentText)) {
      fail("no-vague-outcomes", `${out.id} uses '${vagueMatch[0]}' without a measurement threshold`);
    }
  }

  // 9. no-impossible-to-fail
  checksRun++;
  for (const out of outcomes) {
    const contentText = out.text.replace(/^OUT-\d+:\s*/, "");
    const impossibleMatch = contentText.match(IMPOSSIBLE_PHRASES);
    if (impossibleMatch && !HAS_CONCRETE_TEST.test(contentText)) {
      fail("no-impossible-to-fail", `${out.id} is impossible to fail — '${impossibleMatch[0]}' has no concrete test`);
    }
  }

  // 10. verification-not-manual
  checksRun++;
  if (verificationSection) {
    // Check per OUT-N verification block
    for (const out of outcomes) {
      // Find the verification text for this outcome
      const re = new RegExp(`${out.id}[^]*?(?=OUT-\\d+|$)`, "i");
      const block = verificationSection.match(re);
      if (block) {
        const blockText = block[0];
        if (MANUAL_ONLY.test(blockText) && !HAS_CONCRETE_TEST.test(blockText)) {
          fail("verification-not-manual", `${out.id} verification is manual-only — add a mechanical check`);
        }
      }
    }
  }

  // 11. outcomes-unique
  checksRun++;
  for (let i = 0; i < outcomes.length; i++) {
    for (let j = i + 1; j < outcomes.length; j++) {
      const sim = jaccard(outcomes[i].text, outcomes[j].text);
      if (sim > 0.8) {
        fail("outcomes-unique", `${outcomes[i].id} and ${outcomes[j].id} are >80% similar — merge or differentiate`);
      }
    }
  }

  // ── Warning checks (3) ─────────────────────────────────────

  // 12. scope-empty
  const scopeSection = sections["Out of Scope"];
  if (scopeSection !== undefined) {
    const hasItems = /^-\s+/m.test(scopeSection);
    if (!hasItems) {
      warn("scope-empty", "Out of Scope is empty — consider listing at least 1 explicit exclusion");
    }
  }

  // 13. no-failure-modes
  const failureModes = /\b(error|failure|invalid|edge case|fails|reject|timeout|unavailable)\b/i;
  const anyFailureOutcome = outcomes.some((o) => failureModes.test(o.text));
  if (!anyFailureOutcome && outcomes.length > 0) {
    warn("no-failure-modes", "No outcomes address failure modes — consider adding at least 1");
  }

  // 14. high-outcome-count
  if (outcomes.length > 5) {
    warn("high-outcome-count", `${outcomes.length} outcomes increases scope risk — consider whether all are essential`);
  }

  const passed = checksRun - failures.length;
  return { passed, failures, warnings, checksRun };
}

// ══════════════════════════════════════════════════════════════
// cmdCriteriaLint — main command
// ══════════════════════════════════════════════════════════════
export function cmdCriteriaLint(args) {
  const file = args[0];
  const tier = getFlag(args, "tier");

  if (!file) {
    console.error("Usage: opc-harness criteria-lint <file> [--tier <t>]");
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

  if (tier && !VALID_TIERS.has(tier)) {
    console.error(`Invalid tier: ${tier}. Valid: functional, polished, delightful`);
    process.exit(1);
  }

  const result = runLint(text, tier);
  const ok = result.failures.length === 0;

  // Human-readable output to stderr
  if (ok) {
    console.error(`✅ criteria-lint: ${result.passed} checks passed, ${result.warnings.length} warning${result.warnings.length !== 1 ? "s" : ""}`);
  } else {
    console.error(`❌ criteria-lint: ${result.failures.length} failure${result.failures.length !== 1 ? "s" : ""}, ${result.warnings.length} warning${result.warnings.length !== 1 ? "s" : ""}`);
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
