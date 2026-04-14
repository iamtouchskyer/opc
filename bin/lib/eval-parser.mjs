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
  };
}
