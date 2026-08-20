// Mechanical gate for structured test-result artifacts.
import { findProvenanceEvent } from "./provenance-ledger.mjs";

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

function hasResultIntegrity(handshakeProv, context) {
  return typeof handshakeProv?.resultHash === "string"
    && typeof context.artifactHash === "string"
    && handshakeProv.resultHash === context.artifactHash;
}

function ledgerReason(handshakeProv, context) {
  const ledger = handshakeProv?.ledger;
  if (ledger?.kind !== "opc-hmac-ledger") return "missing OPC signed provenance ledger";
  const found = findProvenanceEvent(context.sessionDir, ledger.recordHash);
  if (!found.ok) return found.error;
  const event = found.event;
  if (event.eventType !== "test-command-result") return "ledger event type mismatch";
  const expectedRunId = context.runId || context.handshake?.runId;
  const artifactPath = context.artifact?.path;
  if (typeof artifactPath !== "string" || artifactPath.length === 0) return "ledger result path mismatch";
  const resultPath = typeof artifactPath === "string" && artifactPath.startsWith(`${expectedRunId}/`)
    ? `nodes/${context.nodeId}/${artifactPath}`
    : `nodes/${context.nodeId}/${expectedRunId}/${artifactPath}`;
  if (event.nodeId !== context.nodeId || event.runId !== expectedRunId) return "ledger node/run mismatch";
  if (event.sourceNode !== handshakeProv.sourceNode) return "ledger source node mismatch";
  if (event.sourceRunId !== handshakeProv.sourceRunId) return "ledger source run mismatch";
  if (event.commandHash !== handshakeProv.commandHash) return "ledger command hash mismatch";
  if (event.sourcePlanHash !== handshakeProv.sourcePlanHash) return "ledger source plan hash mismatch";
  if (event.resultHash !== handshakeProv.resultHash) return "ledger result hash mismatch";
  if (event.resultPath !== resultPath) return "ledger result path mismatch";
  return null;
}

export function collectTestEvidenceProvenanceReasons(handshake, context = {}) {
  const prov = handshake?.testEvidenceProvenance;
  if (prov == null) return [];
  const reasons = [];
  const needString = (field) => {
    if (typeof prov[field] !== "string" || prov[field].length === 0) {
      reasons.push(`testEvidenceProvenance.${field} missing or invalid`);
    }
  };
  if (prov.kind !== "opc-test-command") reasons.push("testEvidenceProvenance.kind must be opc-test-command");
  if (prov.executionActor !== "opc-harness:test-command") {
    reasons.push("testEvidenceProvenance.executionActor mismatch");
  }
  for (const field of ["sourceNode", "sourceRunId", "commandHash", "sourcePlanHash", "resultHash"]) {
    needString(field);
  }
  if (!/^run_\d+$/.test(prov.sourceRunId || "")) {
    reasons.push("testEvidenceProvenance.sourceRunId invalid");
  }
  const policy = handshake?.testEvidencePolicy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    reasons.push("testEvidencePolicy must be a non-null object");
  } else if (!Array.isArray(policy.allowVacuousChecks)) {
    reasons.push("testEvidencePolicy.allowVacuousChecks must be an array");
  }
  if (prov.ledger?.kind !== "opc-hmac-ledger" || typeof prov.ledger?.recordHash !== "string") {
    reasons.push("testEvidenceProvenance signed provenance ledger missing or invalid");
  } else if (context.sessionDir) {
    const reason = ledgerReason(prov, {
      ...context,
      handshake,
      nodeId: handshake?.nodeId,
      runId: handshake?.runId,
    });
    if (reason) reasons.push(`testEvidenceProvenance ledger invalid: ${reason}`);
  }
  return reasons;
}

function hasCommandProvenance(data, handshake, context) {
  const resultProv = data?.provenance || data?.testEvidenceProvenance;
  const handshakeProv = handshake?.testEvidenceProvenance;
  return publicProvenanceReason(resultProv, handshakeProv, context) === null
    && ledgerReason(handshakeProv, context) === null;
}

function publicProvenanceReason(resultProv, handshakeProv, context) {
  if (resultProv?.kind !== "opc-test-command") return "test-result is not OPC testCommand evidence";
  if (handshakeProv?.kind !== "opc-test-command") return "handshake is not OPC testCommand evidence";
  if (typeof resultProv.commandHash !== "string") return "test-result command hash missing";
  if (typeof handshakeProv.commandHash !== "string") return "handshake command hash missing";
  if (resultProv.commandHash !== handshakeProv.commandHash) return "test-result and handshake command hashes differ";
  if (resultProv.sourceRunId !== handshakeProv.sourceRunId) return "test-result and handshake source run differ";
  if (resultProv.executionActor !== "opc-harness:test-command") return "test-result execution actor mismatch";
  if (handshakeProv.executionActor !== "opc-harness:test-command") return "handshake execution actor mismatch";
  if (typeof context.expectedCommandHash !== "string" || resultProv.commandHash !== context.expectedCommandHash) return "source testCommand hash mismatch";
  if (typeof handshakeProv.sourcePlanHash !== "string" || !handshakeProv.sourcePlanHash) return "handshake source test-plan hash missing";
  if (typeof resultProv.sourcePlanHash !== "string" || !resultProv.sourcePlanHash) return "test-result source test-plan hash missing";
  if (typeof context.expectedSourcePlanHash !== "string") return "source test-plan hash missing";
  if (resultProv.sourcePlanHash !== context.expectedSourcePlanHash) return "test-result source test-plan hash mismatch";
  if (handshakeProv.sourcePlanHash !== context.expectedSourcePlanHash) return "handshake source test-plan hash mismatch";
  if (!hasResultIntegrity(handshakeProv, context)) return "result hash mismatch";
  return null;
}

function collectProvenanceReasons(data, context) {
  if (!isTestExecuteNode(context.nodeId) || context.artifact?.type !== "test-result") {
    return [];
  }
  const schemaReasons = collectTestEvidenceProvenanceReasons(context.handshake, context);
  if (schemaReasons.length === 0 && hasCommandProvenance(data, context.handshake, context)) return [];
  const reasons = [...schemaReasons];
  const resultProv = data?.provenance || data?.testEvidenceProvenance;
  const prov = context.handshake?.testEvidenceProvenance;
  const publicReason = publicProvenanceReason(resultProv, prov, context);
  if (publicReason) {
    reasons.push(`test-execute test-result lacks matching OPC testCommand provenance, source test-plan hash, and result hash: ${publicReason}`);
  }
  const reason = ledgerReason(prov, context);
  if (reason) reasons.push(`test-execute test-result lacks valid OPC signed provenance ledger: ${reason}`);
  if (reasons.length > 0) return reasons;
  return ["test-execute test-result lacks matching OPC testCommand provenance, source test-plan hash, and result hash — self-authored or modified test evidence is weak"];
}

export function collectTestResultReasons(data, context = {}) {
  return [
    ...collectSummaryReasons(data),
    ...collectChecksReasons(data, context),
    ...collectProvenanceReasons(data, context),
  ];
}
