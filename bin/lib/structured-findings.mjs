const SEV_RE = /\*\*Severity\*\*:?\s*(🔴|🟡|🔵)/;
const STATUS_RE = /\*\*(?:R2\s+)?Status\*?\*?:?\s*(✅|⚠️|❌)/;
const LOCATION_RE = /\*\*Location\*\*:?\s*(.+)/;
const FINDING_HEADING_RE = /^#{2,3}\s+(?:Finding\s+)?(\d+)[\s.:—\-]+(.+)/i;
const FINDING_HEADING_ALT = /^#{2,3}\s+(\d+)\.\s+(.+)/;

export function parseStructuredFindings(content) {
  const lines = content.split('\n');
  const findings = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(FINDING_HEADING_RE) || line.match(FINDING_HEADING_ALT);
    if (m) {
      if (current) findings.push(current);
      current = { num: m[1], title: m[2].trim(), severity: null, location: null, status: null };
      continue;
    }
    if (/^#{2,3}\s+/.test(line) && !m) {
      if (current) findings.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const sevM = line.match(SEV_RE);
    if (sevM) { current.severity = sevM[1]; continue; }
    const statM = line.match(STATUS_RE);
    if (statM) { current.status = statM[1]; continue; }
    const locM = line.match(LOCATION_RE);
    if (locM) { current.location = locM[1].replace(/`/g, '').trim(); }
  }
  if (current) findings.push(current);
  return findings;
}

export function structuredSeverityName(severity) {
  return { '🔴': 'critical', '🟡': 'warning', '🔵': 'suggestion' }[severity] || 'finding';
}
