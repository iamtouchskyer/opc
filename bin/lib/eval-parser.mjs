// Evaluation markdown parser — regex constants + pure parsing function.

import { createHash } from "node:crypto";

export const SEVERITY_MAP = {
  "🔴": "critical",
  "🟡": "warning",
  "🔵": "suggestion",
  "CRITICAL": "critical",
  "WARNING": "warning",
  "SUGGESTION": "suggestion",
};

// Emoji: optional brackets. Text: MUST use brackets to avoid false positives.
export const SEVERITY_RE = /(?:\[?)(🔴|🟡|🔵)(?:\]?)|\[(CRITICAL|WARNING|SUGGESTION)\]/i;
const FINDING_SEVERITY_RE = /^(?:[-*]\s*)?(?:\*{0,2})?(?:(?:\[?)(🔴|🟡|🔵)(?:\]?)|\[(CRITICAL|WARNING|SUGGESTION)\])/i;
export const FILE_REF_RE = /[\w./-]+\.\w+:\d+/;
export const HEDGING_RE = /\bmight\b|\bcould potentially\b|\bconsider\b/i;
// Aspirational / non-actionable claims — phrases that sound good but commit to nothing
// Excludes "long-term" and "future improvement" which are legitimate in tech-debt findings
export const ASPIRATIONAL_RE = /\bshould\s+consider\b|\bworth\s+(?:considering|exploring|investigating)\b|\bit\s+would\s+be\s+(?:nice|good|beneficial|advisable)\b|\bmay\s+want\s+to\b|\bcould\s+(?:be\s+improved|benefit\s+from)\b|\bideally\b|\bin\s+(?:an?\s+)?ideal\s+world\b|\bdown\s+the\s+(?:road|line)\b/i;
export const VERDICT_RE = /VERDICT:\s*(.+)/i;
export const FINDINGS_N_RE = /FINDINGS\s*\[(\d+)\]/i;

export const MISSION_FINDING_CLASSES = new Set(["ARTIFACT", "PLAN", "GOAL_SPEC", "ENVIRONMENT"]);
const CRITERION_ID_RE = /^(?:OUT|FLOOR)-\d+$/;
const FINDING_REF_RE = /^(?:NEW|FIND-\d+)$/;
const FINGERPRINT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function missionCriterionIds(mission) {
  const ids = new Set();
  for (const id of mission?.criterionIds || []) {
    if (typeof id === "string") ids.add(id);
  }
  for (const item of mission?.outcomes || []) {
    if (typeof item?.id === "string") ids.add(item.id);
  }
  for (const item of mission?.protectedFloors || []) {
    if (typeof item?.id === "string") ids.add(item.id);
  }
  for (const id of Object.keys(mission?.criterionHashes || {})) ids.add(id);
  return ids;
}

function missionFindingRefs(mission) {
  const refs = new Set();
  for (const item of mission?.findingRegistry || []) {
    const id = typeof item === "string" ? item : item?.id || item?.finding_ref || item?.findingRef;
    if (typeof id === "string") refs.add(id);
  }
  return refs;
}

function missionFindingEntry(mission, findingRef) {
  return (mission?.findingRegistry || []).find(item =>
    item && typeof item === "object"
    && (item.id || item.finding_ref || item.findingRef) === findingRef
  ) || null;
}

function validateMissionFinding(finding, mission) {
  const errors = [];
  if (!finding.class) errors.push("missing class");
  else if (!MISSION_FINDING_CLASSES.has(finding.class)) errors.push(`invalid class '${finding.class}'`);

  const criterionIds = missionCriterionIds(mission);
  const criterionRegistryProvided = Array.isArray(mission?.criterionIds)
    || Array.isArray(mission?.outcomes)
    || Array.isArray(mission?.protectedFloors)
    || (mission?.criterionHashes && typeof mission.criterionHashes === "object");
  if (!finding.criterion) errors.push("missing criterion");
  else if (finding.criterion !== "UNLINKED" && !CRITERION_ID_RE.test(finding.criterion)) {
    errors.push(`invalid criterion '${finding.criterion}'`);
  } else if (finding.criterion !== "UNLINKED" && criterionRegistryProvided && !criterionIds.has(finding.criterion)) {
    errors.push(`unknown criterion '${finding.criterion}'`);
  }

  const knownRefs = missionFindingRefs(mission);
  const findingRegistryProvided = Array.isArray(mission?.findingRegistry);
  if (!finding.finding_ref) errors.push("missing finding_ref");
  else if (!FINDING_REF_RE.test(finding.finding_ref)) errors.push(`invalid finding_ref '${finding.finding_ref}'`);
  else if (finding.finding_ref !== "NEW" && findingRegistryProvided && !knownRefs.has(finding.finding_ref)) {
    errors.push(`unknown finding_ref '${finding.finding_ref}'`);
  }

  if (finding.finding_ref) {
    if (!finding.fingerprint) errors.push(`${finding.finding_ref === "NEW" ? "NEW" : "existing"} finding missing fingerprint`);
    else if (!FINGERPRINT_RE.test(finding.fingerprint)) errors.push(`invalid fingerprint '${finding.fingerprint}'`);
    if (!finding.invariant) errors.push(`${finding.finding_ref === "NEW" ? "NEW" : "existing"} finding missing invariant`);
  }
  if (finding.finding_ref && finding.finding_ref !== "NEW") {
    const existing = missionFindingEntry(mission, finding.finding_ref);
    if (existing?.fingerprint && finding.fingerprint && existing.fingerprint !== finding.fingerprint) {
      errors.push(`finding_ref '${finding.finding_ref}' fingerprint differs from its registry entry`);
    }
    if (existing?.invariant && finding.invariant && existing.invariant !== finding.invariant) {
      errors.push(`finding_ref '${finding.finding_ref}' invariant differs from its registry entry`);
    }
  }
  if (finding.class === "GOAL_SPEC" && finding.criterion === "UNLINKED" && !finding.evidence) {
    errors.push("GOAL_SPEC UNLINKED finding requires evidence");
  }
  return errors;
}

function reviewClaim(finding, errors) {
  const claim = {
    routing: false,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    issue: finding.issue,
    class: finding.class,
    criterion: finding.criterion,
    finding_ref: finding.finding_ref,
    fingerprint: finding.fingerprint,
    invariant: finding.invariant,
    evidence: finding.evidence,
    errors,
  };
  return {
    claim_hash: createHash("sha256").update(JSON.stringify(claim)).digest("hex"),
    ...claim,
  };
}

function hasDispositionEvidence(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

/**
 * Validate the mandatory treatment of claims retained from an invalid Mission
 * review. This is deliberately pure so standard and loop flows can enforce the
 * same retry contract while persisting their artifacts independently.
 */
export function validateReviewClaimDispositions({ pendingClaims = [], dispositions = [], findings = [] } = {}) {
  const claims = Array.isArray(pendingClaims) ? pendingClaims : [];
  const supplied = Array.isArray(dispositions) ? dispositions : [];
  if (claims.length === 0) {
    return {
      ok: supplied.length === 0,
      required: false,
      errors: supplied.length === 0 ? [] : ["claim dispositions were supplied but no pending claims exist"],
      dispositions: [],
    };
  }

  const expected = new Map(claims
    .filter(claim => typeof claim?.claim_hash === "string")
    .map(claim => [claim.claim_hash, claim]));
  const errors = [];
  const seen = new Set();
  const normalized = [];
  for (const [index, raw] of supplied.entries()) {
    const claimHash = raw?.claimHash || raw?.claim_hash;
    const disposition = String(raw?.disposition || "").toUpperCase();
    const label = `disposition ${index + 1}`;
    if (!expected.has(claimHash)) {
      errors.push(`${label} references an unknown claim hash`);
      continue;
    }
    if (seen.has(claimHash)) {
      errors.push(`claim ${claimHash} has more than one disposition`);
      continue;
    }
    seen.add(claimHash);
    if (!["CONFIRM", "REJECT", "SUPERSEDE"].includes(disposition)) {
      errors.push(`claim ${claimHash} has invalid disposition '${disposition || "missing"}'`);
      continue;
    }

    const item = {
      claim_hash: claimHash,
      disposition,
      finding_ref: String(raw?.findingRef || raw?.finding_ref || "").toUpperCase() || null,
      fingerprint: typeof raw?.fingerprint === "string" ? raw.fingerprint : null,
      evidence: raw?.evidence ?? null,
    };
    if (disposition === "REJECT") {
      if (!hasDispositionEvidence(item.evidence)) {
        errors.push(`REJECT disposition for claim ${claimHash} requires evidence`);
      }
      normalized.push(item);
      continue;
    }

    const matchingFinding = findings.find(finding =>
      finding?.routing_eligible === true
      && ((item.finding_ref && item.finding_ref !== "NEW" && finding.finding_ref === item.finding_ref)
        || (item.fingerprint && finding.fingerprint === item.fingerprint)));
    if (!matchingFinding) {
      errors.push(`${disposition} disposition for claim ${claimHash} must reference a valid canonical finding`);
    } else if (disposition === "CONFIRM") {
      const claim = expected.get(claimHash);
      if (claim?.class && matchingFinding.class !== claim.class) {
        errors.push(`CONFIRM disposition for claim ${claimHash} changes its class`);
      }
      if (claim?.criterion && matchingFinding.criterion !== claim.criterion) {
        errors.push(`CONFIRM disposition for claim ${claimHash} changes its criterion`);
      }
      if (claim?.invariant && matchingFinding.invariant && matchingFinding.invariant !== claim.invariant) {
        errors.push(`CONFIRM disposition for claim ${claimHash} changes its invariant`);
      }
    }
    normalized.push(item);
  }
  for (const claimHash of expected.keys()) {
    if (!seen.has(claimHash)) errors.push(`claim ${claimHash} has no disposition`);
  }
  return { ok: errors.length === 0, required: true, errors, dispositions: normalized };
}

function missionVerdictErrors({ verdictPresent, verdict, findingsCount, verdictCountMatch }) {
  const errors = [];
  if (!verdictPresent) return ["missing VERDICT line"];
  const normalized = String(verdict || "").trim();
  const hasCount = FINDINGS_N_RE.test(normalized);
  const lgtm = /^LGTM(?:\s|$)/i.test(normalized);
  const blocked = /^BLOCKED\s*\[[^\]]+\](?:\s|$)/i.test(normalized);
  if (findingsCount > 0) {
    if (!hasCount) errors.push("VERDICT with findings must declare FINDINGS [N]");
    else if (verdictCountMatch !== true) errors.push("VERDICT FINDINGS count does not match parsed findings");
  } else if (!(lgtm || blocked || (hasCount && verdictCountMatch === true))) {
    errors.push("zero-finding VERDICT must be LGTM, BLOCKED [reason], or FINDINGS [0]");
  }
  return errors;
}

// Extract role/agent tag from first 10 lines only (avoids matching prose mentions)
const ROLE_TAG_RE = /^(?:role|agent|reviewer)\s*:\s*(.+)/i;
function _extractRoleTag(content) {
  const lines = content.split("\n").slice(0, 10);
  for (const line of lines) {
    const m = line.match(ROLE_TAG_RE);
    if (m) return m[1].trim().toLowerCase();
  }
  return "";
}

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

      // Identical heading → warning (two reviewers may use a generic heading like "# Code Review")
      const headingA = (a.content.match(/^#\s+(.+)/m) || [])[1] || "";
      const headingB = (b.content.match(/^#\s+(.+)/m) || [])[1] || "";
      if (headingA && headingB && headingA === headingB) {
        warnings.push(`eval files '${a.path}' and '${b.path}' have identical headings — each reviewer should have a distinct angle`);
      }

      // Role tag check — extract "Role: X" or "Agent: X" from first 10 lines (avoid matching prose)
      const roleA = _extractRoleTag(a.content);
      const roleB = _extractRoleTag(b.content);
      if (roleA && roleB && roleA === roleB) {
        errors.push(`eval files '${a.path}' and '${b.path}' have identical role tag '${roleA}' — reviews must be from different roles`);
      }
    }
  }
  return { errors, warnings };
}

export function parseEvaluation(text, options = {}) {
  text = text.replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  let verdictPresent = false;
  let verdict = "";
  const severityCounts = { critical: 0, warning: 0, suggestion: 0 };
  let hasFileRefs = false;
  const hedgingDetected = [];
  const findings = [];
  const formatErrors = [];

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

    // Reasoning line — accept: "Reasoning: ...", "**Reasoning:** ...", "→ Reasoning: ..."
    // NOTE: must check BEFORE severity detection, since severity matches emoji anywhere in line
    const reasoningRe = /^(?:→\s*)?(?:\*{0,2})reasoning(?:\*{0,2}):\s*/i;
    if (currentFinding && reasoningRe.test(trimmed)) {
      currentFinding.reasoning = trimmed.replace(reasoningRe, "").trim();
      if (HEDGING_RE.test(trimmed)) {
        hedgingDetected.push(`line ${lineNum}: '${trimmed}'`);
      }
      continue;
    }

    // Mission metadata is parsed for every evaluation so recovery/cumulative
    // context can retain it. It becomes mandatory only when options.mission is
    // present, preserving legacy parseEvaluation(text) behavior.
    const missionMetaMatch = currentFinding && trimmed.match(/^(class|criterion|finding[_ ]ref|fingerprint|invariant|evidence):\s*(.+)$/i);
    if (missionMetaMatch) {
      const key = missionMetaMatch[1].toLowerCase().replace(/[ _]/g, "_");
      const value = missionMetaMatch[2].trim();
      if (key === "class" || key === "criterion" || key === "finding_ref") {
        currentFinding[key] = value.toUpperCase();
      } else {
        currentFinding[key] = value;
      }
      continue;
    }

    // Fix line — accept: "→ ...", "Fix: ...", "**Fix:** ...", "→ Fix: ..."
    // NOTE: must check BEFORE severity detection, since "→ Fix: ... 🔵 ..." would match severity
    const fixMatch = currentFinding && (trimmed.startsWith("→") || /^\*{0,2}fix\*{0,2}:/i.test(trimmed));
    if (fixMatch) {
      if (trimmed.startsWith("→")) {
        currentFinding.fix = trimmed.replace(/^→\s*(?:\*{0,2}fix\*{0,2}:\s*)?/i, "").trim();
      } else {
        currentFinding.fix = trimmed.replace(/^\*{0,2}fix\*{0,2}:\s*/i, "").trim();
      }
      if (HEDGING_RE.test(trimmed)) {
        hedgingDetected.push(`line ${lineNum}: '${trimmed}'`);
      }
      continue;
    }

    // Severity / finding detection (skip markdown headings, tables, and section labels)
    const sevMatch = trimmed.match(FINDING_SEVERITY_RE);
    if (sevMatch && !trimmed.startsWith("#") && !trimmed.startsWith("|") && !VERDICT_RE.test(trimmed)) {
      if (/^\*{0,2}(severity|location|status|r2\s+status)\*{0,2}:/i.test(trimmed)) {
        continue;
      }
      const fileMatch = trimmed.match(FILE_REF_RE);
      const dashIdx = trimmed.indexOf("—");

      // Skip section labels like "🔴 Must Fix:" — require em-dash or file ref to count as finding
      if (dashIdx === -1 && !fileMatch && trimmed.endsWith(":")) {
        // Peek next non-blank line: if it's an emptiness marker ("- None.", "N/A"),
        // the whole section is empty — don't count OR treat as finding.
        let j = i + 1;
        while (j < lines.length && lines[j].trim().length === 0) j++;
        if (j < lines.length) {
          const next = lines[j].trim().replace(/^[-*]\s+/, "");
          if (/^(none|n\/?a|n\.a\.?|nothing)\s*\.?$/i.test(next)) {
            // Skip both the label line and the emptiness marker
            i = j;
          }
        }
        continue;
      }

      // Skip empty-content lines that just carry the emoji + a filler ("🔴 None.", "🟡 N/A")
      const bareContent = trimmed
        .replace(/^[-*]\s+/, "")
        .replace(/[🔴🟡🔵]/g, "")
        .replace(/\[(CRITICAL|WARNING|SUGGESTION)\]/gi, "")
        .replace(/[*_`\[\]()]/g, "")
        .trim();
      if (/^(none|n\/?a|n\.a\.?|nothing|—|-)\s*\.?$/i.test(bareContent)) {
        continue;
      }

      const severityKey = sevMatch[1] || sevMatch[2];
      const severity = SEVERITY_MAP[severityKey.toUpperCase()] || SEVERITY_MAP[severityKey];
      severityCounts[severity]++;
      const issue = dashIdx !== -1 ? trimmed.slice(dashIdx + 1).trim() : trimmed;

      let filePath = null;
      let fileLine = null;
      if (fileMatch) {
        const parts = fileMatch[0].split(":");
        filePath = parts[0];
        fileLine = parseInt(parts[1], 10);
      }

      // Track unstructured findings: severity marker without em-dash AND without file:line
      if (dashIdx === -1 && !fileMatch) {
        formatErrors.push({ line: lineNum, text: trimmed, reason: "severity marker found but no em-dash or file:line — unstructured finding" });
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
        class: null,
        criterion: null,
        finding_ref: null,
        fingerprint: null,
        invariant: null,
        evidence: null,
        routing_eligible: null,
      };

      if (!trimmed.startsWith("#") && HEDGING_RE.test(trimmed)) {
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

  // Layer: aspirational claims — findings that say "should consider" instead of "must fix"
  // Only scan finding-context lines (emoji lines, fix lines, reasoning lines) — not prose/summary
  const findingContextLines = lines.filter(l => {
    const t = l.trim();
    return (SEVERITY_RE.test(t) || /^\*{0,2}fix\*{0,2}:/i.test(t) || t.startsWith("→") || /^\*{0,2}reasoning\*{0,2}:/i.test(t)) && !t.startsWith("#");
  });
  const aspirationalLines = findingContextLines.filter(l => ASPIRATIONAL_RE.test(l));
  const aspirationalRatio = findingContextLines.length > 0
    ? aspirationalLines.length / findingContextLines.length : 0;
  const aspirationalClaims = aspirationalLines.length >= 3 || (aspirationalRatio > 0.15 && aspirationalLines.length >= 2);

  const missionEnabled = Boolean(options?.mission);
  const missionFindingErrors = [];
  if (missionEnabled) {
    for (let index = 0; index < findings.length; index++) {
      const finding = findings[index];
      // Blue suggestions remain advisory and may omit routing metadata.
      if (finding.severity === "suggestion") {
        finding.routing_eligible = false;
        continue;
      }
      const errors = validateMissionFinding(finding, options.mission);
      const evidencedUnlinkedFloorRisk = finding.class === "GOAL_SPEC"
        && finding.criterion === "UNLINKED"
        && Boolean(finding.evidence);
      finding.routing_eligible = errors.length === 0
        && (finding.criterion !== "UNLINKED" || evidencedUnlinkedFloorRisk);
      if (errors.length > 0) missionFindingErrors.push({ finding_index: index, errors });
    }
  }
  const missionGlobalErrors = missionEnabled ? [
    ...missionVerdictErrors({ verdictPresent, verdict, findingsCount, verdictCountMatch }),
    ...(formatErrors.length > 0 ? ["one or more findings are unstructured"] : []),
    ...(findingsWithoutReasoning > 0 ? ["one or more findings are missing reasoning"] : []),
    ...(findingsWithoutFix > 0 ? ["one or more findings are missing fix"] : []),
  ] : [];
  const reviewQualityOk = missionFindingErrors.length === 0 && missionGlobalErrors.length === 0;
  const errorByIndex = new Map(missionFindingErrors.map((entry) => [entry.finding_index, entry.errors]));
  const reviewClaims = missionEnabled && !reviewQualityOk
    ? findings
      .map((finding, index) => ({ finding, index }))
      .filter(({ finding }) => finding.severity !== "suggestion")
      .map(({ finding, index }) => reviewClaim(finding, [
        ...(errorByIndex.get(index) || []),
        ...missionGlobalErrors,
      ]))
    : [];

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
    // Aspirational claims layer
    aspirationalClaims,
    aspirationalLineCount: aspirationalLines.length,
    // Format errors (severity markers that failed to parse as findings)
    formatErrors,
    // Mission review-quality separation. Invalid claims are visible but never
    // routing inputs; callers must redispatch evaluation before mutation.
    mission_enabled: missionEnabled,
    review_quality_ok: reviewQualityOk,
    reevaluate_required: missionEnabled && !reviewQualityOk,
    review_quality_errors: [
      ...missionFindingErrors,
      ...(missionGlobalErrors.length > 0 ? [{ review_errors: missionGlobalErrors }] : []),
    ],
    review_quality_global_errors: missionGlobalErrors,
    review_claims: reviewClaims,
  };
}
