// tier-baselines.test.mjs — unit tests for tier-baselines.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  VALID_TIERS,
  TEST_LAYERS,
  TEST_LAYER_LABELS,
  TEST_LAYER_KEYWORDS,
  TIER_BASELINES,
  RED_FLAGS,
  RED_FLAG_KEYS,
  TRUST_SIGNAL_KEYS,
  TIER_FIT_BUCKETS,
  DELTA_ASSESSMENTS,
  WARNING_THRESHOLDS,
  getRedFlagSeverity,
  parseRedFlagOverrides,
  getBaselineForTier,
  getSeverity,
  generateTierTestCases,
  getRequiredBaselineKeys,
  getAllBaselineKeys,
  formatTierCoverageHint,
  checkBaselineCoverage,
} from "./tier-baselines.mjs";

describe("VALID_TIERS", () => {
  test("is a Set with exactly 3 tiers", () => {
    assert.ok(VALID_TIERS instanceof Set);
    assert.equal(VALID_TIERS.size, 3);
    for (const t of ["functional", "polished", "delightful"]) {
      assert.ok(VALID_TIERS.has(t));
    }
  });
});

describe("TEST_LAYERS / TEST_LAYER_LABELS / TEST_LAYER_KEYWORDS", () => {
  test("TEST_LAYERS has 5 entries L1–L5", () => {
    assert.deepEqual(TEST_LAYERS, ["L1", "L2", "L3", "L4", "L5"]);
  });

  test("TEST_LAYER_LABELS has a label for each layer", () => {
    for (const layer of TEST_LAYERS) {
      assert.equal(typeof TEST_LAYER_LABELS[layer], "string");
      assert.ok(TEST_LAYER_LABELS[layer].length > 0);
    }
  });

  test("TEST_LAYER_KEYWORDS has a non-empty array for each layer", () => {
    for (const layer of TEST_LAYERS) {
      assert.ok(Array.isArray(TEST_LAYER_KEYWORDS[layer]));
      assert.ok(TEST_LAYER_KEYWORDS[layer].length > 0);
    }
  });
});

describe("TIER_BASELINES", () => {
  test("is a non-empty array", () => {
    assert.ok(Array.isArray(TIER_BASELINES));
    assert.ok(TIER_BASELINES.length > 0);
  });

  test("each item has required keys", () => {
    for (const item of TIER_BASELINES) {
      assert.equal(typeof item.key, "string");
      assert.equal(typeof item.label, "string");
      assert.ok(Array.isArray(item.keywords));
      assert.ok(item.keywords.length > 0);
      assert.equal(typeof item.severity, "object");
      assert.equal(typeof item.testCase, "object");
    }
  });

  test("severity has all 3 tiers", () => {
    for (const item of TIER_BASELINES) {
      for (const tier of VALID_TIERS) {
        assert.ok(tier in item.severity, `${item.key} missing severity for ${tier}`);
      }
    }
  });

  test("testCase has required fields", () => {
    for (const item of TIER_BASELINES) {
      const tc = item.testCase;
      assert.equal(typeof tc.category, "string");
      assert.equal(typeof tc.description, "string");
      assert.ok(Array.isArray(tc.steps));
      assert.equal(typeof tc.expected, "string");
      assert.equal(typeof tc.failureImpact, "string");
    }
  });
});

describe("RED_FLAGS / RED_FLAG_KEYS", () => {
  test("RED_FLAGS is a non-empty array with required keys", () => {
    assert.ok(RED_FLAGS.length > 0);
    for (const flag of RED_FLAGS) {
      assert.equal(typeof flag.key, "string");
      assert.equal(typeof flag.label, "string");
      assert.equal(typeof flag.severity, "object");
    }
  });

  test("each flag severity has all 3 tiers", () => {
    for (const flag of RED_FLAGS) {
      for (const tier of VALID_TIERS) {
        assert.ok(tier in flag.severity, `${flag.key} missing severity for ${tier}`);
      }
    }
  });

  test("RED_FLAG_KEYS is a Set matching RED_FLAGS keys", () => {
    assert.ok(RED_FLAG_KEYS instanceof Set);
    assert.equal(RED_FLAG_KEYS.size, RED_FLAGS.length);
    for (const flag of RED_FLAGS) {
      assert.ok(RED_FLAG_KEYS.has(flag.key));
    }
  });
});

describe("TRUST_SIGNAL_KEYS", () => {
  test("is a non-empty Set of strings", () => {
    assert.ok(TRUST_SIGNAL_KEYS instanceof Set);
    assert.ok(TRUST_SIGNAL_KEYS.size > 0);
    for (const k of TRUST_SIGNAL_KEYS) {
      assert.equal(typeof k, "string");
    }
  });
});

describe("TIER_FIT_BUCKETS", () => {
  test("contains expected buckets", () => {
    assert.ok(TIER_FIT_BUCKETS instanceof Set);
    assert.equal(TIER_FIT_BUCKETS.size, 4);
    for (const b of ["free-only", "below-tier", "at-tier", "above-tier"]) {
      assert.ok(TIER_FIT_BUCKETS.has(b));
    }
  });
});

describe("DELTA_ASSESSMENTS", () => {
  test("contains expected assessments", () => {
    assert.ok(DELTA_ASSESSMENTS instanceof Set);
    assert.equal(DELTA_ASSESSMENTS.size, 4);
    for (const a of ["regression", "same", "improvement", "significant-improvement"]) {
      assert.ok(DELTA_ASSESSMENTS.has(a));
    }
  });
});

describe("WARNING_THRESHOLDS", () => {
  test("has correct values per tier", () => {
    assert.equal(WARNING_THRESHOLDS.functional, 3);
    assert.equal(WARNING_THRESHOLDS.polished, 2);
    assert.equal(WARNING_THRESHOLDS.delightful, 1);
  });
});

describe("getRedFlagSeverity", () => {
  test("returns correct severity for valid flag and tier", () => {
    assert.equal(getRedFlagSeverity("broken-link", "functional"), "critical");
    assert.equal(getRedFlagSeverity("default-favicon", "polished"), "warning");
    assert.equal(getRedFlagSeverity("default-favicon", "delightful"), "critical");
  });

  test("returns null for flag with null severity at tier", () => {
    assert.equal(getRedFlagSeverity("default-favicon", "functional"), null);
  });

  test("returns null for invalid tier", () => {
    assert.equal(getRedFlagSeverity("broken-link", "bogus"), null);
  });

  test("returns null for unknown key", () => {
    assert.equal(getRedFlagSeverity("nonexistent-key", "functional"), null);
  });

  test("returns suggestion for 'other' key", () => {
    assert.equal(getRedFlagSeverity("other", "functional"), "suggestion");
    assert.equal(getRedFlagSeverity("other", "delightful"), "suggestion");
  });

  test("applies overrides — replaces severity", () => {
    const overrides = new Map([["broken-link", "warning"]]);
    assert.equal(getRedFlagSeverity("broken-link", "functional", overrides), "warning");
  });

  test("applies overrides — null/dash override returns null", () => {
    const dashOverride = new Map([["broken-link", "—"]]);
    assert.equal(getRedFlagSeverity("broken-link", "functional", dashOverride), null);

    const hyphenOverride = new Map([["broken-link", "-"]]);
    assert.equal(getRedFlagSeverity("broken-link", "functional", hyphenOverride), null);

    const nullOverride = new Map([["broken-link", "null"]]);
    assert.equal(getRedFlagSeverity("broken-link", "functional", nullOverride), null);
  });
});

describe("parseRedFlagOverrides", () => {
  test("parses valid content into a Map", () => {
    const content = "- broken-link: warning\n- default-favicon: critical";
    const result = parseRedFlagOverrides(content);
    assert.ok(result instanceof Map);
    assert.equal(result.size, 2);
    assert.equal(result.get("broken-link"), "warning");
    assert.equal(result.get("default-favicon"), "critical");
  });

  test("returns null for empty content", () => {
    assert.equal(parseRedFlagOverrides(""), null);
  });

  test("returns null for content with no valid lines", () => {
    assert.equal(parseRedFlagOverrides("just some text\nanother line"), null);
  });

  test("handles mixed valid/invalid lines", () => {
    const content = "# comment\n- broken-link: warning\ninvalid line\n- lorem-ipsum: —";
    const result = parseRedFlagOverrides(content);
    assert.equal(result.size, 2);
    assert.equal(result.get("broken-link"), "warning");
    assert.equal(result.get("lorem-ipsum"), "—");
  });
});

describe("getBaselineForTier", () => {
  test("returns items with non-null severity for valid tier", () => {
    const items = getBaselineForTier("delightful");
    assert.ok(items.length > 0);
    for (const item of items) {
      assert.notEqual(item.severity.delightful, null);
    }
  });

  test("functional returns fewer items than delightful", () => {
    const func = getBaselineForTier("functional");
    const del = getBaselineForTier("delightful");
    assert.ok(func.length < del.length);
  });

  test("returns empty array for invalid tier", () => {
    assert.deepEqual(getBaselineForTier("bogus"), []);
  });
});

describe("getSeverity", () => {
  test("returns correct severity for item and tier", () => {
    const typo = TIER_BASELINES.find((i) => i.key === "typography");
    assert.equal(getSeverity(typo, "delightful"), "critical");
    assert.equal(getSeverity(typo, "polished"), "warning");
  });

  test("returns null when severity is null", () => {
    const typo = TIER_BASELINES.find((i) => i.key === "typography");
    assert.equal(getSeverity(typo, "functional"), null);
  });
});

describe("generateTierTestCases", () => {
  test("only includes warning/critical items", () => {
    const cases = generateTierTestCases("delightful");
    assert.ok(cases.length > 0);
    for (const tc of cases) {
      const item = TIER_BASELINES.find((i) => i.key === tc.baselineKey);
      const sev = item.severity.delightful;
      assert.ok(sev === "warning" || sev === "critical", `${tc.baselineKey} has severity ${sev}`);
    }
  });

  test("uses correct TC-TIER-NN format", () => {
    const cases = generateTierTestCases("polished");
    for (const tc of cases) {
      assert.match(tc.id, /^TC-TIER-\d{2}$/);
    }
  });

  test("all cases have P0 priority", () => {
    const cases = generateTierTestCases("polished");
    for (const tc of cases) {
      assert.equal(tc.priority, "P0");
    }
  });

  test("cases include required fields", () => {
    const cases = generateTierTestCases("delightful");
    for (const tc of cases) {
      assert.equal(typeof tc.id, "string");
      assert.equal(typeof tc.category, "string");
      assert.equal(typeof tc.description, "string");
      assert.ok(Array.isArray(tc.steps));
      assert.equal(typeof tc.expected, "string");
      assert.equal(typeof tc.failureImpact, "string");
      assert.equal(typeof tc.baselineKey, "string");
      assert.equal(typeof tc.label, "string");
    }
  });

  test("returns empty array for invalid tier", () => {
    assert.deepEqual(generateTierTestCases("bogus"), []);
  });

  test("excludes suggestion-only items", () => {
    const cases = generateTierTestCases("functional");
    for (const tc of cases) {
      const item = TIER_BASELINES.find((i) => i.key === tc.baselineKey);
      assert.notEqual(item.severity.functional, "suggestion");
    }
  });
});

describe("getRequiredBaselineKeys", () => {
  test("returns Set of warning+critical keys", () => {
    const keys = getRequiredBaselineKeys("polished");
    assert.ok(keys instanceof Set);
    assert.ok(keys.size > 0);
    for (const key of keys) {
      const item = TIER_BASELINES.find((i) => i.key === key);
      const sev = item.severity.polished;
      assert.ok(sev === "warning" || sev === "critical");
    }
  });

  test("returns empty Set for invalid tier", () => {
    const keys = getRequiredBaselineKeys("bogus");
    assert.ok(keys instanceof Set);
    assert.equal(keys.size, 0);
  });
});

describe("getAllBaselineKeys", () => {
  test("returns Set of all keys for tier", () => {
    const keys = getAllBaselineKeys("delightful");
    assert.ok(keys instanceof Set);
    const expected = TIER_BASELINES.filter((i) => i.severity.delightful != null);
    assert.equal(keys.size, expected.length);
  });

  test("includes suggestion-severity keys", () => {
    const allKeys = getAllBaselineKeys("functional");
    const reqKeys = getRequiredBaselineKeys("functional");
    assert.ok(allKeys.size >= reqKeys.size);
  });

  test("returns empty Set for invalid tier", () => {
    assert.equal(getAllBaselineKeys("bogus").size, 0);
  });
});

describe("formatTierCoverageHint", () => {
  test("names schema doc and valid tier keys", () => {
    const hint = formatTierCoverageHint("delightful");
    assert.ok(hint.includes("pipeline/tier-coverage-schema.md"));
    assert.ok(hint.includes("Expected tierCoverage"));
    assert.ok(hint.includes("typography"));
    assert.ok(hint.includes("micro-interactions"));
    assert.ok(!hint.includes("responsive-layout"));
    assert.ok(!hint.includes("dark-mode"));
  });
});

describe("checkBaselineCoverage", () => {
  test("matches keywords case-insensitively", () => {
    const result = checkBaselineCoverage("TYPOGRAPHY and NAVIGATION present", "delightful");
    const coveredKeys = result.covered.map((c) => c.key);
    assert.ok(coveredKeys.includes("typography"));
    assert.ok(coveredKeys.includes("navigation"));
  });

  test("classifies covered vs uncovered correctly", () => {
    const result = checkBaselineCoverage("has loading spinner and error recovery", "delightful");
    const coveredKeys = result.covered.map((c) => c.key);
    assert.ok(coveredKeys.includes("loading-states"));
    assert.ok(coveredKeys.includes("error-states"));
    // items not mentioned should be uncovered
    const uncoveredKeys = result.uncovered.map((c) => c.key);
    assert.ok(uncoveredKeys.includes("typography"));
  });

  test("each entry has key, label, severity", () => {
    const result = checkBaselineCoverage("typography", "polished");
    for (const entry of [...result.covered, ...result.uncovered]) {
      assert.equal(typeof entry.key, "string");
      assert.equal(typeof entry.label, "string");
      assert.ok(entry.severity !== undefined);
    }
  });

  test("returns empty arrays for invalid tier", () => {
    const result = checkBaselineCoverage("typography", "bogus");
    assert.deepEqual(result.covered, []);
    assert.deepEqual(result.uncovered, []);
  });

  test("all items accounted for (covered + uncovered = total for tier)", () => {
    const result = checkBaselineCoverage("", "delightful");
    const total = getBaselineForTier("delightful").length;
    assert.equal(result.covered.length + result.uncovered.length, total);
    // empty text means nothing covered
    assert.equal(result.covered.length, 0);
  });
});
