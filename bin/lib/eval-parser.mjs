// Evaluation markdown parser — regex constants + pure parsing function.
// No I/O, no dependencies.

export const SEVERITY_MAP = {
  "🔴": "critical",
  "🟡": "warning",
  "🔵": "suggestion",
};

export const SEVERITY_RE = /(?:\[?)(🔴|🟡|🔵)(?:\]?)/;
export const FILE_REF_RE = /[\w./-]+\.\w+:\d+/;
export const HEDGING_RE = /\bmight\b|\bcould potentially\b|\bconsider\b/i;
export const VERDICT_RE = /VERDICT:\s*(.+)/i;
export const FINDINGS_N_RE = /FINDINGS\s*\[(\d+)\]/i;

/**
 * Check eval file distinctness — shared by flow-core validate and loop-tick.
 * Takes array of { path, content } objects (at least 2).
 * Returns { errors: [], warnings: [] }.
 */
export function checkEvalDistinctness(evalContents) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(evalContents) || evalContents.length < 2) return { errors, warnings };

  for (let i = 0; i < evalContents.length; i++) {
    for (let j = i + 1; j < evalContents.length; j++) {
      const a = evalContents[i], b = evalContents[j];

      // Byte-identical → error
      if (a.content === b.content) {
        errors.push(`eval files '${a.path}' and '${b.path}' are identical — reviews must be independent`);
        continue;
      }

      // >70% line overlap → warning
      const linesA = a.content.split("\n").filter(l => l.trim().length > 10);
      const linesB = new Set(b.content.split("\n").filter(l => l.trim().length > 10));
      if (linesA.length > 0 && linesB.size > 0) {
        const shared = linesA.filter(l => linesB.has(l)).length;
        const overlapPct = shared / Math.min(linesA.length, linesB.size);
        if (overlapPct > 0.7) {
          warnings.push(`eval files '${a.path}' and '${b.path}' have ${Math.round(overlapPct * 100)}% line overlap — reviews may lack independence`);
        }
      }

      // Identical heading → error (same heading = same agent role)
      const headingA = (a.content.match(/^#\s+(.+)/m) || [])[1] || "";
      const headingB = (b.content.match(/^#\s+(.+)/m) || [])[1] || "";
      if (headingA && headingB && headingA === headingB) {
        errors.push(`eval files '${a.path}' and '${b.path}' have identical headings '${headingA}' — reviews must come from independent agents with distinct roles`);
      }

      // Role tag check — extract "Role: X" or "Agent: X" from content
      const roleTagRe = /^(?:role|agent|reviewer)\s*:\s*(.+)/im;
      const roleA = (a.content.match(roleTagRe) || [])[1]?.trim().toLowerCase() || "";
      const roleB = (b.content.match(roleTagRe) || [])[1]?.trim().toLowerCase() || "";
      if (roleA && roleB && roleA === roleB) {
        errors.push(`eval files '${a.path}' and '${b.path}' have identical role tag '${roleA}' — reviews must be from different roles`);
      }
    }
  }
  return { errors, warnings };
}

export function parseEvaluation(text) {
  text = text.replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  let verdictPresent = false;
  let verdict = "";
  const severityCounts = { critical: 0, warning: 0, suggestion: 0 };
  let hasFileRefs = false;
  const hedgingDetected = [];
  const findings = [];

  let currentFinding = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Verdict detection
    const verdictMatch = trimmed.match(VERDICT_RE);
    if (verdictMatch) {
      verdictPresent = true;
      verdict = verdictMatch[1].trim();
    }

    // File reference detection
    if (FILE_REF_RE.test(trimmed)) {
      hasFileRefs = true;
    }

    // Severity / finding detection (skip markdown headings and section labels)
    const sevMatch = trimmed.match(SEVERITY_RE);
    if (sevMatch && !trimmed.startsWith("#")) {
      const fileMatch = trimmed.match(FILE_REF_RE);
      const dashIdx = trimmed.indexOf("—");

      // Skip section labels like "🔴 Must Fix:" — require em-dash or file ref to count as finding
      if (dashIdx === -1 && !fileMatch && trimmed.endsWith(":")) {
        continue;
      }

      const severity = SEVERITY_MAP[sevMatch[1]];
      severityCounts[severity]++;
      const issue = dashIdx !== -1 ? trimmed.slice(dashIdx + 1).trim() : trimmed;

      let filePath = null;
      let fileLine = null;
      if (fileMatch) {
        const parts = fileMatch[0].split(":");
        filePath = parts[0];
        fileLine = parseInt(parts[1], 10);
      }

      if (currentFinding) findings.push(currentFinding);

      currentFinding = {
        severity,
        file: filePath,
        line: fileLine,
        issue,
        fix: null,
        reasoning: null,
        status: "accepted",
        dismissReason: null,
      };

      if (!trimmed.startsWith("#") && HEDGING_RE.test(trimmed)) {
        hedgingDetected.push(`line ${lineNum}: '${trimmed}'`);
      }
      continue;
    }

    // Fix line
    if (currentFinding && trimmed.startsWith("→")) {
      currentFinding.fix = trimmed.slice(1).trim();
      if (HEDGING_RE.test(trimmed)) {
        hedgingDetected.push(`line ${lineNum}: '${trimmed}'`);
      }
      continue;
    }

    // Reasoning line
    if (currentFinding && /^reasoning:/i.test(trimmed)) {
      currentFinding.reasoning = trimmed.replace(/^reasoning:\s*/i, "").trim();
      if (HEDGING_RE.test(trimmed)) {
        hedgingDetected.push(`line ${lineNum}: '${trimmed}'`);
      }
      continue;
    }

    // Hedging in findings context
    if (
      currentFinding &&
      !trimmed.startsWith("#") &&
      trimmed.length > 0 &&
      HEDGING_RE.test(trimmed)
    ) {
      hedgingDetected.push(`line ${lineNum}: '${trimmed}'`);
    }
  }

  if (currentFinding) findings.push(currentFinding);

  const findingsCount =
    severityCounts.critical + severityCounts.warning + severityCounts.suggestion;

  let verdictCountMatch = true;
  const fnMatch = verdict.match(FINDINGS_N_RE);
  if (fnMatch) {
    verdictCountMatch = parseInt(fnMatch[1], 10) === findingsCount;
  } else if (findingsCount > 0) {
    verdictCountMatch = null;
  }

  // Thin eval detection: mechanical quality signal
  const lineCount = lines.length;
  const thinEval = lineCount < 50;
  const fileLineRefCount = (text.match(/[\w./-]+\.\w+:\d+/g) || []).length;
  const noCodeRefs = fileLineRefCount === 0;

  // ── Compound defense layers (probability stacking) ──────────────
  // Each check is independently bypassable, but stacking them multiplies
  // the effort required to produce garbage that passes all gates.

  // Layer: unique content ratio — detect copy-paste padding
  const trimmedLines = lines.map(l => l.trim()).filter(l => l.length > 0);
  const uniqueLines = new Set(trimmedLines);
  const uniqueRatio = trimmedLines.length > 0 ? uniqueLines.size / trimmedLines.length : 0;
  const lowUniqueContent = trimmedLines.length >= 20 && uniqueRatio < 0.6;

  // Layer: heading structure — real reviews have multiple sections
  const headingCount = lines.filter(l => /^#{1,3}\s+\S/.test(l)).length;
  const singleHeading = headingCount <= 1 && lineCount >= 30;

  // Layer: finding density — if findings declared, emoji lines should be proportional
  const emojiLineCount = lines.filter(l => SEVERITY_RE.test(l)).length;
  const findingDensityLow = findingsCount > 0 && lineCount >= 50 && (emojiLineCount / lineCount) < 0.02;

  // Layer: findings without reasoning — every finding should explain WHY
  const findingsWithoutReasoning = findings.filter(f => !f.reasoning).length;
  const missingReasoningRatio = findingsCount > 0 ? findingsWithoutReasoning / findingsCount : 0;

  // Layer: findings without fix — every finding should say HOW to fix
  const findingsWithoutFix = findings.filter(f => !f.fix).length;
  const missingFixRatio = findingsCount > 0 ? findingsWithoutFix / findingsCount : 0;

  // Layer: line length variance — real prose has varied line lengths
  // Template fill-in tends to produce uniform lengths
  const contentLineLengths = trimmedLines.filter(l => l.length > 5).map(l => l.length);
  let lineLengthVarianceLow = false;
  if (contentLineLengths.length >= 15) {
    const mean = contentLineLengths.reduce((a, b) => a + b, 0) / contentLineLengths.length;
    const variance = contentLineLengths.reduce((a, b) => a + (b - mean) ** 2, 0) / contentLineLengths.length;
    const cv = Math.sqrt(variance) / mean; // coefficient of variation
    lineLengthVarianceLow = cv < 0.15; // very uniform = suspicious
  }

  return {
    verdict_present: verdictPresent,
    verdict,
    findings_count: findingsCount,
    critical: severityCounts.critical,
    warning: severityCounts.warning,
    suggestion: severityCounts.suggestion,
    has_file_refs: hasFileRefs,
    hedging_detected: hedgingDetected,
    verdict_count_match: verdictCountMatch,
    findings,
    // Thin eval signals (consumed by synthesize)
    lineCount,
    thinEval,
    noCodeRefs,
    fileLineRefCount,
    // Compound defense layers
    uniqueRatio: Math.round(uniqueRatio * 100),
    lowUniqueContent,
    headingCount,
    singleHeading,
    findingDensityLow,
    findingsWithoutReasoning,
    missingReasoningRatio: Math.round(missingReasoningRatio * 100),
    findingsWithoutFix,
    missingFixRatio: Math.round(missingFixRatio * 100),
    lineLengthVarianceLow,
  };
}
