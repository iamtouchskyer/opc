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

function allowVacuous(context, check) {
  const allowed = context?.allowVacuousChecks;
  return Array.isArray(allowed) && allowed.includes(check?.id);
}

function checkTotal(check) {
  if (typeof check?.total === "number") return check.total;
  const detail = parseDetail(check?.detail);
  return typeof detail?.total === "number" ? detail.total : null;
}

function collectChecksReasons(data, context) {
  if (!Array.isArray(data?.checks)) return [];
  const reasons = [];
  const failed = data.checks.filter(c => c && c.pass === false);
  if (failed.length > 0) {
    const ids = failed.slice(0, 5).map(c => c.id || "unnamed").join(", ");
    reasons.push(`${failed.length} structured check(s) failed: ${ids}`);
  }
  const vacuous = data.checks.filter(c =>
    c && c.pass === true && !allowVacuous(context, c) && checkTotal(c) === 0);
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

function hasCommandProvenance(data, handshake, context) {
  const resultProv = data?.provenance || data?.testEvidenceProvenance;
  const handshakeProv = handshake?.testEvidenceProvenance;
  if (resultProv?.kind !== "opc-test-command") return false;
  if (handshakeProv?.kind !== "opc-test-command") return false;
  if (typeof resultProv.commandHash !== "string") return false;
  if (typeof handshakeProv.commandHash !== "string") return false;
  if (resultProv.commandHash !== handshakeProv.commandHash) return false;
  if (resultProv.executionActor !== "opc-harness:test-command") return false;
  if (handshakeProv.executionActor !== "opc-harness:test-command") return false;
  if (typeof context.expectedCommandHash !== "string" || resultProv.commandHash !== context.expectedCommandHash) return false;
  if (typeof handshakeProv.sourcePlanHash !== "string" || !handshakeProv.sourcePlanHash) return false;
  if (typeof resultProv.sourcePlanHash !== "string" || !resultProv.sourcePlanHash) return false;
  return typeof context.expectedSourcePlanHash === "string"
    && resultProv.sourcePlanHash === context.expectedSourcePlanHash
    && handshakeProv.sourcePlanHash === context.expectedSourcePlanHash;
}

function collectProvenanceReasons(data, context) {
  if (!isTestExecuteNode(context.nodeId) || context.artifact?.type !== "test-result") {
    return [];
  }
  if (hasCommandProvenance(data, context.handshake, context)) return [];
  return ["test-execute test-result lacks matching OPC testCommand provenance and source test-plan hash — self-authored test evidence is weak"];
}

export function collectTestResultReasons(data, context = {}) {
  return [
    ...collectSummaryReasons(data),
    ...collectChecksReasons(data, context),
    ...collectProvenanceReasons(data, context),
  ];
}
