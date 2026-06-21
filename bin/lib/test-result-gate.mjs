// Mechanical gate for structured test-result artifacts.

function safeInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function parseDetail(detail) {
  if (!detail) return null;
  if (typeof detail === "object") return detail;
  if (typeof detail !== "string") return null;
  const text = detail.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function allowVacuous(data, check) {
  if (check?.allowVacuous === true) return true;
  const allowed = data?.allowVacuousChecks;
  return Array.isArray(allowed) && allowed.includes(check?.id);
}

function checkTotal(check) {
  if (typeof check?.total === "number") return check.total;
  const detail = parseDetail(check?.detail);
  return typeof detail?.total === "number" ? detail.total : null;
}

function collectChecksReasons(data) {
  if (!Array.isArray(data?.checks)) return [];
  const reasons = [];
  const failed = data.checks.filter(c => c && c.pass === false);
  if (failed.length > 0) {
    const ids = failed.slice(0, 5).map(c => c.id || "unnamed").join(", ");
    reasons.push(`${failed.length} structured check(s) failed: ${ids}`);
  }
  const vacuous = data.checks.filter(c =>
    c && c.pass === true && !allowVacuous(data, c) && checkTotal(c) === 0);
  if (vacuous.length > 0) {
    const ids = vacuous.slice(0, 5).map(c => c.id || "unnamed").join(", ");
    reasons.push(`${vacuous.length} vacuous PASS check(s) matched total=0: ${ids}`);
  }
  return reasons;
}

function collectSummaryReasons(data) {
  const reasons = [];
  if (Array.isArray(data?.summary?.failed) && data.summary.failed.length > 0) {
    reasons.push(`${data.summary.failed.length} summarized test failure(s) present`);
  }
  if (safeInt(data?.test_fail_count) > 0)
    reasons.push(`${safeInt(data.test_fail_count)} test(s) failed`);
  if (safeInt(data?.dead_test_count) > 0)
    reasons.push(`${safeInt(data.dead_test_count)} dead test(s) detected`);
  if (safeInt(data?.p0_count) > 0)
    reasons.push(`${safeInt(data.p0_count)} P0 issue(s) unresolved`);
  if (String(data?.sync_check_status || "").toUpperCase() === "FAIL")
    reasons.push("sync-check failed");
  return reasons;
}

function isTestExecuteNode(nodeId) {
  return /^test[-_]execute$/.test(String(nodeId || ""));
}

function hasCommandProvenance(data, handshake) {
  const prov = data?.provenance || data?.testEvidenceProvenance || handshake?.testEvidenceProvenance;
  return prov?.kind === "opc-test-command" && typeof prov.commandHash === "string";
}

function collectProvenanceReasons(data, handshake, nodeId) {
  if (!isTestExecuteNode(nodeId) || !Array.isArray(data?.checks) || data.checks.length === 0) {
    return [];
  }
  if (hasCommandProvenance(data, handshake)) return [];
  return ["test-execute checks lack OPC testCommand provenance — self-authored test evidence is weak"];
}

export function collectTestResultReasons(data, context = {}) {
  return [
    ...collectSummaryReasons(data),
    ...collectChecksReasons(data),
    ...collectProvenanceReasons(data, context.handshake, context.nodeId),
  ];
}
