// Mission trajectory gate: pure finding/trajectory decisions plus bounded
// packet/review/decision helpers.  The harness owns persistence and locking.

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { existsSync, lstatSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { atomicWriteSync } from "./util.mjs";
import { appendProvenanceEvent, findProvenanceEvent } from "./provenance-ledger.mjs";

export const FINDING_CLASSES = new Set(["ARTIFACT", "PLAN", "GOAL_SPEC", "ENVIRONMENT"]);
export const MISSION_ACTIONS = new Set([
  "CONTINUE_CURRENT",
  "RESHAPE_SMALLER",
  "RESTORE",
  "RECON",
  "HUMAN_REBET",
  "STOP_SALVAGE",
]);

function sha256(value) {
  return createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8"))
    .digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function trajectoryOf(state) {
  return state?.trajectory && typeof state.trajectory === "object"
    ? state.trajectory
    : {};
}

function criterionHashesOf(state) {
  return state?.mission?.criterionHashes && typeof state.mission.criterionHashes === "object"
    ? state.mission.criterionHashes
    : {};
}

function missionContractOf(state, supplied = null) {
  return supplied || state?.mission?.contract || state?.contract || state?.mission || {};
}

function findingValue(finding, snake, camel = snake) {
  return finding?.[snake] ?? finding?.[camel] ?? null;
}

function normalizedFinding(finding) {
  const findingClass = String(findingValue(finding, "class") || "").toUpperCase();
  const criterion = String(findingValue(finding, "criterion") || "");
  const findingRef = String(findingValue(finding, "finding_ref", "findingRef") || "").toUpperCase();
  const fingerprint = findingValue(finding, "fingerprint");
  const invariant = findingValue(finding, "invariant");
  return {
    ...finding,
    class: findingClass,
    criterion,
    finding_ref: findingRef,
    fingerprint: fingerprint == null ? null : String(fingerprint),
    invariant: invariant == null ? null : String(invariant),
  };
}

function nextRegistryNumber(registry) {
  let max = 0;
  for (const entry of registry) {
    const match = String(entry?.id || entry?.findingRef || "").match(/^FIND-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/**
 * Register one evaluator batch without allowing evaluator prose to define the
 * durable identity. Existing-registry collisions fail; concurrent NEW entries
 * are coalesced only by exact criterion/invariant hash.
 */
export function registerFindingBatch({ registry = [], findings = [], criterionHashes = {} } = {}) {
  const committed = clone(Array.isArray(registry) ? registry : []);
  const errors = [];
  const prepared = [];
  const committedById = new Map(committed.map(entry => [entry.id, entry]));
  const newGroups = new Map();

  for (let index = 0; index < findings.length; index++) {
    const finding = normalizedFinding(findings[index]);
    const label = `finding ${index + 1}`;
    if (!FINDING_CLASSES.has(finding.class)) {
      errors.push(`${label}: invalid class '${finding.class || "missing"}'`);
      continue;
    }
    if (!finding.criterion) {
      errors.push(`${label}: missing criterion`);
      continue;
    }
    const criterionHash = finding.criterion === "UNLINKED"
      ? sha256("UNLINKED")
      : criterionHashes[finding.criterion];
    if (!criterionHash) {
      errors.push(`${label}: unknown criterion '${finding.criterion}'`);
      continue;
    }

    if (/^FIND-\d+$/.test(finding.finding_ref)) {
      const existing = committedById.get(finding.finding_ref);
      if (!existing) {
        errors.push(`${label}: finding_ref '${finding.finding_ref}' is not registered`);
        continue;
      }
      if (existing.criterionHash !== criterionHash) {
        errors.push(`${label}: finding_ref '${finding.finding_ref}' belongs to a different criterion`);
        continue;
      }
      if (existing.class && existing.class !== finding.class) {
        errors.push(`${label}: finding_ref '${finding.finding_ref}' belongs to class ${existing.class}, not ${finding.class}`);
        continue;
      }
      if (!existing.class) existing.class = finding.class;
      if (!finding.fingerprint || !finding.invariant) {
        errors.push(`${label}: finding_ref '${finding.finding_ref}' must repeat its canonical fingerprint and invariant`);
        continue;
      }
      if (finding.fingerprint !== existing.fingerprint) {
        errors.push(`${label}: finding_ref '${finding.finding_ref}' fingerprint differs from its registry entry`);
        continue;
      }
      if (sha256(finding.invariant.trim()) !== existing.invariantHash) {
        errors.push(`${label}: finding_ref '${finding.finding_ref}' invariant differs from its registry entry`);
        continue;
      }
      prepared[index] = {
        ...finding,
        fingerprint: existing.fingerprint,
        invariant: existing.invariant,
        finding_ref: existing.id,
        findingRef: existing.id,
        registryId: existing.id,
        criterionHash,
        invariantHash: existing.invariantHash,
        gateKey: `${criterionHash}:${existing.id}`,
      };
      continue;
    }

    if (finding.finding_ref !== "NEW") {
      errors.push(`${label}: finding_ref must be NEW or FIND-N`);
      continue;
    }
    if (!finding.fingerprint || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(finding.fingerprint)) {
      errors.push(`${label}: NEW finding requires a semantic kebab-case fingerprint`);
      continue;
    }
    if (!finding.invariant || !finding.invariant.trim()) {
      errors.push(`${label}: NEW finding requires a non-empty invariant`);
      continue;
    }

    const invariantHash = sha256(finding.invariant.trim());
    const committedCollision = committed.find(entry =>
      entry.criterionHash === criterionHash
      && entry.fingerprint === finding.fingerprint
      && entry.invariantHash !== invariantHash
    );
    if (committedCollision) {
      errors.push(`${label}: fingerprint collision with ${committedCollision.id}`);
      continue;
    }

    const exactCommitted = committed.find(entry =>
      entry.criterionHash === criterionHash
      && entry.invariantHash === invariantHash
    );
    if (exactCommitted) {
      if (exactCommitted.class && exactCommitted.class !== finding.class) {
        errors.push(`${label}: invariant is already registered as class ${exactCommitted.class}, not ${finding.class}`);
        continue;
      }
      if (!exactCommitted.class) exactCommitted.class = finding.class;
      prepared[index] = {
        ...finding,
        fingerprint: exactCommitted.fingerprint,
        invariant: exactCommitted.invariant,
        finding_ref: exactCommitted.id,
        findingRef: exactCommitted.id,
        registryId: exactCommitted.id,
        criterionHash,
        invariantHash,
        gateKey: `${criterionHash}:${exactCommitted.id}`,
      };
      continue;
    }

    const groupKey = `${criterionHash}:${invariantHash}`;
    if (!newGroups.has(groupKey)) {
      newGroups.set(groupKey, {
        class: finding.class,
        criterion: finding.criterion,
        criterionHash,
        fingerprint: finding.fingerprint,
        invariant: finding.invariant.trim(),
        invariantHash,
        indexes: [],
      });
    } else {
      const group = newGroups.get(groupKey);
      if (group.class !== finding.class) {
        errors.push(`${label}: the same invariant has conflicting classes ${group.class} and ${finding.class}`);
        continue;
      }
      if (finding.fingerprint.localeCompare(group.fingerprint) < 0) {
        // The durable representative must not depend on evaluator/file order.
        group.fingerprint = finding.fingerprint;
      }
    }
    newGroups.get(groupKey).indexes.push(index);
  }

  if (errors.length > 0) return { ok: false, errors, registry: committed, findings: [] };

  let next = nextRegistryNumber(committed);
  const sortedGroups = [...newGroups.values()].sort((a, b) => {
    const ak = `${a.criterionHash}:${a.fingerprint}:${a.invariantHash}`;
    const bk = `${b.criterionHash}:${b.fingerprint}:${b.invariantHash}`;
    return ak.localeCompare(bk);
  });
  for (const group of sortedGroups) {
    const id = `FIND-${next++}`;
    const entry = {
      id,
      class: group.class,
      criterion: group.criterion,
      criterionHash: group.criterionHash,
      fingerprint: group.fingerprint,
      invariant: group.invariant,
      invariantHash: group.invariantHash,
    };
    committed.push(entry);
    for (const index of group.indexes) {
      const finding = normalizedFinding(findings[index]);
      prepared[index] = {
        ...finding,
        finding_ref: id,
        findingRef: id,
        registryId: id,
        criterionHash: group.criterionHash,
        invariantHash: group.invariantHash,
        gateKey: `${group.criterionHash}:${id}`,
      };
    }
  }

  return { ok: true, errors: [], registry: committed, findings: prepared };
}

function integratedPassReceipts(state) {
  const epoch = state?.mission?.strategyEpoch;
  return (Array.isArray(state?.evidenceReceipts) ? state.evidenceReceipts : [])
    .filter(receipt => receipt?.scope === "integrated"
      && receipt?.result === "PASS"
      && receipt?.stale !== true
      && receipt?.strategyEpoch === epoch);
}

function evidenceCursorHasProgress(state, edgeKey) {
  const receipts = integratedPassReceipts(state);
  const seenIds = new Set(trajectoryOf(state).repairEvidenceSeenIds?.[edgeKey] || []);
  if (seenIds.size > 0) return receipts.some(receipt => !seenIds.has(receipt.id));
  const cursor = trajectoryOf(state).repairEvidenceCursor?.[edgeKey] ?? 0;
  return receipts.length > cursor;
}

function gitOutput(root, args, { encoding = "utf8" } = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding,
    timeout: 15000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function gitArtifactSnapshot(state) {
  const requestedRoot = state?.projectRoot || state?.projectDir || null;
  if (!requestedRoot || !existsSync(requestedRoot)) return null;
  try {
    const root = gitOutput(requestedRoot, ["rev-parse", "--show-toplevel"]).trim();
    const head = gitOutput(root, ["rev-parse", "HEAD"]).trim();
    const changed = gitOutput(root, ["diff", "--name-only", "-z", "HEAD"], { encoding: null })
      .toString("utf8").split("\0").filter(Boolean);
    const untracked = gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: null })
      .toString("utf8").split("\0").filter(Boolean);
    const paths = [...new Set([...changed, ...untracked])].sort();
    const entries = paths.map(path => {
      const absolute = resolve(root, path);
      if (!existsSync(absolute)) return { path, kind: "deleted" };
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        let nestedHead = null;
        let nestedStatusSha256 = null;
        try {
          nestedHead = gitOutput(absolute, ["rev-parse", "HEAD"]).trim();
          nestedStatusSha256 = sha256(gitOutput(absolute, ["status", "--porcelain=v1", "-z"], { encoding: null }));
        } catch { /* directory is not a submodule */ }
        return { path, kind: "directory", mode: stat.mode, nestedHead, nestedStatusSha256 };
      }
      let contentObject;
      try {
        contentObject = gitOutput(root, ["hash-object", "--", path]).trim();
      } catch {
        contentObject = sha256(canonical({ size: stat.size, modifiedAtMs: stat.mtimeMs }));
      }
      return {
        path,
        kind: stat.isSymbolicLink() ? "symlink" : "file",
        mode: stat.mode,
        contentObject,
      };
    });
    return { root, head, entries };
  } catch {
    return null;
  }
}

function declaredArtifactEntries(state) {
  const base = state?.projectRoot || state?.projectDir || process.cwd();
  const values = [
    ...(Array.isArray(state?.artifacts) ? state.artifacts : []),
    ...(Array.isArray(state?.deliverables) ? state.deliverables : []),
    ...(Array.isArray(state?.declaredArtifacts) ? state.declaredArtifacts : []),
  ];
  return [...new Set(values.map(value => typeof value === "string" ? value : value?.path).filter(Boolean))]
    .sort()
    .map(path => {
    const absolute = resolve(base, path);
    if (!existsSync(absolute)) return { path, absolute, sha256: null, kind: "missing" };
    try {
      const stat = lstatSync(absolute);
      return stat.isFile() || stat.isSymbolicLink()
        ? { path, absolute, sha256: sha256(readFileSync(absolute)), kind: stat.isSymbolicLink() ? "symlink" : "file" }
        : { path, absolute, sha256: null, kind: "directory" };
    } catch {
      return { path, absolute, sha256: null, kind: "unreadable" };
    }
  });
}

function artifactSnapshot(state) {
  const git = gitArtifactSnapshot(state);
  const declared = declaredArtifactEntries(state);
  const manifest = {
    git,
    declared,
    producedCommits: Array.isArray(state?.producedCommits) ? state.producedCommits : [],
    evidenceArtifactHashes: (Array.isArray(state?.evidenceReceipts) ? state.evidenceReceipts : [])
      .flatMap(receipt => Array.isArray(receipt?.artifactHashes) ? receipt.artifactHashes : []),
  };
  return {
    sha256: sha256(canonical(manifest)),
    root: git?.root || state?.projectRoot || state?.projectDir || null,
    head: git?.head || null,
    changedEntries: git?.entries || [],
    declaredEntries: declared,
  };
}

function decisionScopeTokens(packet) {
  const findingRefs = Array.isArray(packet?.findingRefs)
    ? packet.findingRefs.filter(ref => /^FIND-\d+$/.test(String(ref)))
    : [];
  if (findingRefs.length > 0) return [...new Set(findingRefs)].sort();
  if (packet?.edgeKey) return [`EDGE:${packet.edgeKey}`];
  return packet?.planSummary?.nextUnit ? [`UNIT:${packet.planSummary.nextUnit}`] : [];
}

function observationScopeTokens(findings, edgeKey, unit) {
  const findingRefs = (Array.isArray(findings) ? findings : [])
    .map(finding => finding?.finding_ref || finding?.findingRef)
    .filter(ref => /^FIND-\d+$/.test(String(ref)));
  if (findingRefs.length > 0) return [...new Set(findingRefs)].sort();
  if (edgeKey) return [`EDGE:${edgeKey}`];
  return unit ? [`UNIT:${unit}`] : [];
}

export function missionRetryGrantMatches({
  state,
  findings = [],
  edgeKey = null,
  command = null,
  fromNode = null,
  unit = null,
  sessionSha256 = null,
} = {}) {
  const grant = trajectoryOf(state).retryGrant;
  if (!grant || grant.remaining !== 1 || grant.strategyEpoch !== state?.mission?.strategyEpoch) return false;
  if (command && grant.command && grant.command !== command) return false;
  if (fromNode && grant.sourceNode && grant.sourceNode !== fromNode) return false;
  if (unit && grant.nextUnit && grant.nextUnit !== unit) return false;
  if (edgeKey && grant.edgeKey && grant.edgeKey !== edgeKey) return false;
  if (sessionSha256 && grant.sessionSha256 && grant.sessionSha256 !== sessionSha256) return false;
  const observed = observationScopeTokens(findings, edgeKey, unit);
  const granted = new Set(Array.isArray(grant.scopeTokens) ? grant.scopeTokens : []);
  return observed.length > 0 && observed.every(token => granted.has(token));
}

export function consumeMissionRetryGrant(state) {
  const next = clone(state);
  if (!next?.mission) return next;
  next.trajectory ||= {};
  next.trajectory.retryGrant = null;
  next.trajectory.retryAllowance = 0;
  return next;
}

function packetFindingSummaries(state, trigger) {
  const requested = new Set(Array.isArray(trigger?.findingRefs) ? trigger.findingRefs : []);
  const activeById = new Map(
    (Array.isArray(state?.trajectory?.activeFindings) ? state.trajectory.activeFindings : [])
      .map(finding => [finding?.finding_ref || finding?.findingRef, finding]),
  );
  const summaries = (Array.isArray(state?.findingRegistry) ? state.findingRegistry : [])
    .filter(entry => requested.has(entry?.id))
    .map(entry => {
      const active = activeById.get(entry.id) || {};
      return {
        id: entry.id,
        class: entry.class || active.class || null,
        criterion: entry.criterion || active.criterion || null,
        criterionHash: entry.criterionHash || active.criterionHash || null,
        fingerprint: entry.fingerprint || null,
        invariant: entry.invariant || null,
        invariantHash: entry.invariantHash || null,
      };
    });
  return {
    count: summaries.length,
    entries: summaries.slice(0, 50),
    truncated: summaries.length > 50,
  };
}

function allowedDecisionsForTrigger(trigger) {
  if (trigger?.checkpoint === "before_finalize") return ["CONTINUE_CURRENT", "STOP_SALVAGE"];
  if (trigger?.retryable === false) return ["HUMAN_REBET", "STOP_SALVAGE"];
  // A retryable trigger's local classification is only a hypothesis. The cold
  // reviewer must be able to reclassify ARTIFACT ↔ PLAN ↔ ENVIRONMENT (or
  // discover GOAL_SPEC) to escape the local optimum. Its own classification is
  // then constrained by REVIEW_ROUTE_MATRIX below.
  return [...MISSION_ACTIONS];
}

/** Pure trajectory decision. */
export function evaluateTrajectory({
  state,
  missionContract = null,
  findings = [],
  edgeKey = null,
  verdict = null,
  isRepairEdge = false,
  checkpoint = null,
  now = new Date().toISOString(),
} = {}) {
  if (!state?.mission) return { action: "ALLOW_LOCAL", missionEnabled: false };
  const trajectory = trajectoryOf(state);
  if (trajectory.pending) {
    return {
      action: "OPEN_MISSION_GATE",
      reason: trajectory.reason || "MISSION_PENDING",
      triggerId: trajectory.triggerId || null,
      alreadyPending: true,
      retryable: false,
    };
  }

  const contract = missionContractOf(state, missionContract);
  const expiresAt = contract.appetite?.expiresAt || state.mission.expiresAt || null;
  if (expiresAt && Date.parse(now) >= Date.parse(expiresAt)) {
    return { action: "OPEN_MISSION_GATE", reason: "APPETITE_EXPIRED", findingRefs: [], retryable: false };
  }
  const maxRepairs = contract.appetite?.maxRepairCycles ?? state.mission.maxRepairCycles;
  if (Number.isInteger(maxRepairs) && (trajectory.repairCycles || 0) >= maxRepairs) {
    return { action: "OPEN_MISSION_GATE", reason: "REPAIR_APPETITE_REACHED", findingRefs: [], retryable: false };
  }
  const maxTokens = contract.appetite?.maxTokens ?? null;
  if (typeof maxTokens === "number" && Number.isFinite(trajectory.measuredTokens) &&
      trajectory.measuredTokens >= maxTokens) {
    return { action: "OPEN_MISSION_GATE", reason: "TOKEN_APPETITE_REACHED", findingRefs: [], retryable: false };
  }
  const maxWallTimeHours = contract.appetite?.maxWallTimeHours ?? null;
  const startedAt = state._started_at || state.flowStartedAt || null;
  const elapsedWallTimeHours = startedAt && !Number.isNaN(Date.parse(startedAt))
    ? (Date.parse(now) - Date.parse(startedAt)) / 3_600_000
    : null;
  if (typeof maxWallTimeHours === "number" && Number.isFinite(elapsedWallTimeHours) &&
      elapsedWallTimeHours >= maxWallTimeHours) {
    return { action: "OPEN_MISSION_GATE", reason: "WALL_TIME_APPETITE_REACHED", findingRefs: [], retryable: false };
  }
  const expiredAssumptions = (Array.isArray(contract.assumptions) ? contract.assumptions : [])
    .filter(assumption => assumption?.freshUntil && Date.parse(now) >= Date.parse(assumption.freshUntil));
  if (expiredAssumptions.length > 0) {
    return {
      action: "OPEN_MISSION_GATE",
      reason: "ASSUMPTION_EXPIRED",
      classification: "ENVIRONMENT",
      assumptionIds: expiredAssumptions.map(assumption => assumption.id),
      findingRefs: [],
      retryable: true,
    };
  }

  if (checkpoint) {
    return {
      action: "OPEN_MISSION_GATE",
      reason: checkpoint === "before_finalize" ? "FINAL_REVIEW_REQUIRED" : "MISSION_CHECKPOINT",
      checkpoint,
      findingRefs: [],
      retryable: checkpoint !== "before_finalize",
    };
  }

  const normalized = findings.map(normalizedFinding);
  const nonArtifact = normalized.filter(f => f.class && f.class !== "ARTIFACT");
  if (nonArtifact.length > 0) {
    const priority = ["GOAL_SPEC", "ENVIRONMENT", "PLAN"];
    const selected = priority.map(cls => nonArtifact.find(f => f.class === cls)).find(Boolean) || nonArtifact[0];
    return {
      action: "OPEN_MISSION_GATE",
      reason: `${selected.class}_FINDING`,
      classification: selected.class,
      findingRefs: nonArtifact.map(f => f.finding_ref).filter(Boolean),
      affectedCriteria: [...new Set(nonArtifact.map(f => f.criterion).filter(Boolean))],
      retryable: selected.class === "PLAN" || selected.class === "ENVIRONMENT",
    };
  }

  const counts = trajectory.findingFailureCounts || {};
  const repeated = normalized.filter(f => f.gateKey && (counts[f.gateKey] || 0) >= 1);
  if (repeated.length > 0) {
    if (missionRetryGrantMatches({ state, findings: repeated, edgeKey })) {
      return {
        action: "ALLOW_LOCAL",
        reason: "MISSION_RETRY_ALLOWANCE",
        authorizedRetry: true,
        consumeRetry: isRepairEdge,
        findingRefs: repeated.map(f => f.finding_ref),
      };
    }
    return {
      action: "OPEN_MISSION_GATE",
      reason: "REPEATED_CANONICAL_FINDING",
      classification: "ARTIFACT",
      edgeKey,
      findingRefs: repeated.map(f => f.finding_ref),
      affectedCriteria: [...new Set(repeated.map(f => f.criterion))],
      retryable: true,
    };
  }

  const negative = verdict === "FAIL" || verdict === "ITERATE";
  if (negative && isRepairEdge && edgeKey) {
    const edgeFailures = trajectory.repairEdgeFailures?.[edgeKey] || 0;
    if (edgeFailures >= 1 && !evidenceCursorHasProgress(state, edgeKey)) {
      if (missionRetryGrantMatches({ state, findings: normalized, edgeKey })) {
        return {
          action: "ALLOW_LOCAL",
          reason: "MISSION_RETRY_ALLOWANCE",
          authorizedRetry: true,
          consumeRetry: true,
          findingRefs: normalized.map(f => f.finding_ref).filter(Boolean),
        };
      }
      return {
        action: "OPEN_MISSION_GATE",
        reason: "REPEATED_REPAIR_EDGE_WITHOUT_PROGRESS",
        classification: "ARTIFACT",
        edgeKey,
        findingRefs: normalized.map(f => f.finding_ref).filter(Boolean),
        retryable: true,
      };
    }
  }

  return { action: "ALLOW_LOCAL", reason: "FIRST_LOCAL_ATTEMPT", authorizedRetry: false, consumeRetry: false };
}

/** Apply bookkeeping only after the protected state mutation has been accepted. */
export function commitTrajectoryObservation({
  state,
  findings = [],
  edgeKey = null,
  verdict = null,
  isRepairEdge = false,
  recordFindingFailures = true,
  consumeRetry = false,
  chargeRepairCycle = true,
} = {}) {
  const next = clone(state);
  if (!next?.mission) return next;
  next.trajectory ||= {};
  next.trajectory.findingFailureCounts ||= {};
  next.trajectory.repairEdgeFailures ||= {};
  next.trajectory.repairEvidenceCursor ||= {};
  next.trajectory.repairEvidenceSeenIds ||= {};
  next.findingHistory ||= [];

  const negative = verdict === "FAIL" || verdict === "ITERATE";
  if (negative && recordFindingFailures) {
    for (const finding of findings) {
      if (!finding?.gateKey || finding.class !== "ARTIFACT") continue;
      next.trajectory.findingFailureCounts[finding.gateKey] =
        (next.trajectory.findingFailureCounts[finding.gateKey] || 0) + 1;
      next.findingHistory.push({
        class: finding.class,
        criterion: finding.criterion,
        findingRef: finding.finding_ref,
        gateKey: finding.gateKey,
        strategyEpoch: next.mission.strategyEpoch,
        verdict,
        evidenceDelta: integratedPassReceipts(next).length,
      });
    }
    next.trajectory.activeFindings = clone(findings);
  }

  if (negative && isRepairEdge && edgeKey) {
    next.trajectory.repairEdgeFailures[edgeKey] =
      (next.trajectory.repairEdgeFailures[edgeKey] || 0) + 1;
    next.trajectory.repairEvidenceCursor[edgeKey] = integratedPassReceipts(next).length;
    next.trajectory.repairEvidenceSeenIds[edgeKey] = integratedPassReceipts(next).map(receipt => receipt.id);
    if (chargeRepairCycle) {
      next.trajectory.repairCycles = (next.trajectory.repairCycles || 0) + 1;
    }
  }
  if (consumeRetry) {
    next.trajectory.retryGrant = null;
    next.trajectory.retryAllowance = 0;
  }
  return next;
}

export function currentMissionBindings(state, { artifacts = null } = {}) {
  const mission = state?.mission || {};
  const evidence = Array.isArray(state?.evidenceReceipts) ? state.evidenceReceipts : [];
  const artifactState = artifacts || artifactSnapshot(state);
  return {
    missionSha256: mission.sha256 ?? null,
    acceptanceCriteriaSha256: mission.acceptanceCriteriaSha256 ?? null,
    planSha256: mission.planSha256 ?? null,
    evidenceSetSha256: sha256(canonical(evidence)),
    artifactManifestSha256: artifactState.sha256,
    strategyEpoch: mission.strategyEpoch ?? null,
  };
}

export function createTrajectoryPacket({ state, trigger, missionContract = null, now = new Date().toISOString() } = {}) {
  const trajectory = trajectoryOf(state);
  const contract = missionContractOf(state, missionContract);
  const artifacts = artifactSnapshot(state);
  const bindings = currentMissionBindings(state, { artifacts });
  const receipts = integratedPassReceipts(state);
  const seenReceiptIds = new Set(Array.isArray(trajectory.evidenceGateReceiptIds)
    ? trajectory.evidenceGateReceiptIds
    : []);
  const evidenceDelta = receipts.filter(receipt => !seenReceiptIds.has(receipt.id)).map(receipt => ({
    id: receipt.id,
    receiptSha256: sha256(canonical(receipt)),
    scenarioId: receipt.scenarioId ?? null,
    validatorType: receipt.validatorType ?? null,
    satisfies: Array.isArray(receipt.satisfies) ? receipt.satisfies : [],
    artifactHashes: Array.isArray(receipt.artifactHashes) ? receipt.artifactHashes : [],
  }));
  const triggerNumber = (trajectory.triggerCount || 0) + 1;
  const triggerId = trigger?.triggerId || `TRJ-${triggerNumber}`;
  const reviewRunId = `mission-review-${sha256(canonical({
    triggerId,
    requestedAt: now,
    missionSha256: bindings.missionSha256,
    planSha256: bindings.planSha256,
    strategyEpoch: bindings.strategyEpoch,
  })).slice(0, 24)}`;
  const packet = {
    schemaVersion: 1,
    triggerId,
    reason: trigger?.reason || "MISSION_REVIEW_REQUIRED",
    triggerClassification: trigger?.classification || null,
    retryable: trigger?.retryable !== false,
    findingRefs: trigger?.findingRefs || [],
    affectedCriteria: trigger?.affectedCriteria || [],
    assumptionIds: trigger?.assumptionIds || [],
    environmentDelta: trigger?.environmentDelta || null,
    evidenceSha256: trigger?.environmentDelta?.sha256 || null,
    edgeKey: trigger?.edgeKey || null,
    origin: trigger?.origin && typeof trigger.origin === "object"
      ? clone(trigger.origin)
      : null,
    checkpoint: trigger?.checkpoint || null,
    findingSummary: packetFindingSummaries(state, trigger),
    bindings,
    mission: {
      path: state.mission.path,
      version: state.mission.version,
      strategyEpoch: state.mission.strategyEpoch,
      originalRequestSha256: state.mission.originalRequestSha256,
      originalRequest: contract.originalRequest ?? null,
      owner: contract.owner ?? null,
      affectedParties: contract.affectedParties ?? [],
      mode: contract.mode ?? null,
      outcomes: contract.outcomes ?? [],
      protectedFloors: contract.protectedFloors ?? [],
      nonGoals: contract.nonGoals ?? [],
      appetite: contract.appetite ?? null,
      endToEndScenario: contract.endToEndScenario ?? null,
      realitySignals: contract.realitySignals ?? [],
      guardrails: contract.guardrails ?? [],
      assumptions: contract.assumptions ?? [],
      exitAndSalvage: contract.exitAndSalvage ?? null,
    },
    planSummary: {
      path: state.mission.planPath ?? state.plan_file ?? null,
      sha256: state.mission.planSha256 ?? null,
      currentNode: state.currentNode ?? null,
      currentUnit: state.unit ?? null,
      nextUnit: state.next_unit ?? null,
      completedUnits: (Array.isArray(state._tick_history) ? state._tick_history : [])
        .filter(tick => tick?.status === "completed" && tick?.stale !== true)
        .map(tick => tick.unit),
    },
    artifactSummary: {
      manifestSha256: bindings.artifactManifestSha256,
      projectRoot: artifacts.root,
      gitHead: artifacts.head,
      changedEntryCount: artifacts.changedEntries.length,
      changedEntries: artifacts.changedEntries.slice(0, 200),
      changedEntriesTruncated: artifacts.changedEntries.length > 200,
      declaredEntryCount: artifacts.declaredEntries.length,
      declaredEntries: artifacts.declaredEntries.slice(0, 200),
      declaredEntriesTruncated: artifacts.declaredEntries.length > 200,
      changedArtifactHashes: [...new Set(evidenceDelta.flatMap(receipt => receipt.artifactHashes))],
    },
    appetiteStatus: {
      repairCycles: trajectory.repairCycles || 0,
      measuredTokens: Number.isFinite(trajectory.measuredTokens) ? trajectory.measuredTokens : "unknown",
      elapsedWallTimeHours: (state._started_at || state.flowStartedAt) &&
        !Number.isNaN(Date.parse(state._started_at || state.flowStartedAt))
        ? Math.max(0, (Date.parse(now) - Date.parse(state._started_at || state.flowStartedAt)) / 3_600_000)
        : "unknown",
    },
    evidenceDelta,
    validatorSummary: {
      currentIntegratedPassCount: receipts.length,
      currentIntegratedPassReceipts: receipts.slice(0, 100).map(receipt => ({
        id: receipt.id,
        scenarioId: receipt.scenarioId ?? null,
        validatorType: receipt.validatorType ?? null,
        validator: receipt.validator ?? null,
        satisfies: Array.isArray(receipt.satisfies) ? receipt.satisfies : [],
      })),
      truncated: receipts.length > 100,
      requiredRealitySignalIds: (Array.isArray(contract.realitySignals) ? contract.realitySignals : [])
        .filter(signal => signal?.required)
        .map(signal => signal.id),
    },
    allowedDecisions: allowedDecisionsForTrigger(trigger),
    decisionGuidance: {
      CONTINUE_CURRENT: { reversibility: "high", effect: "one bounded local attempt" },
      RESHAPE_SMALLER: { reversibility: "medium", effect: "replace the affected plan and increment strategy epoch" },
      RESTORE: { reversibility: "medium", effect: "pause until a bound restore receipt selects the resume point" },
      RECON: { reversibility: "high", effect: "refresh the measured baseline, then reclassify" },
      HUMAN_REBET: { reversibility: "low", effect: "require approved versioned mission and criteria" },
      STOP_SALVAGE: { reversibility: "low", effect: "terminate without success and preserve salvage instructions" },
    },
    requestedAt: now,
    reviewRequest: {
      runId: reviewRunId,
      contextMode: "cold",
    },
  };
  return packet;
}

/** Build a cloned pending state; the canonical writer seals and publishes it atomically. */
export function openMissionGate({ sessionDir, state, trigger, missionContract = null, now = new Date().toISOString() } = {}) {
  const next = clone(state);
  const packet = createTrajectoryPacket({ state: next, trigger, missionContract, now });
  next.trajectory ||= {};
  next.trajectory.pending = true;
  next.trajectory.triggerId = packet.triggerId;
  next.trajectory.reason = packet.reason;
  next.trajectory.retryAllowance = 0;
  next.trajectory.retryGrant = null;
  next.trajectory.triggerCount = (next.trajectory.triggerCount || 0) + 1;
  next.trajectory.evidenceGateCursor = integratedPassReceipts(next).length;
  next.trajectory.evidenceGateReceiptIds = [
    ...new Set([
      ...(Array.isArray(next.trajectory.evidenceGateReceiptIds) ? next.trajectory.evidenceGateReceiptIds : []),
      ...integratedPassReceipts(next).map(receipt => receipt.id),
    ]),
  ];
  next.trajectory.pendingPacket = packet;
  next.trajectory.pendingPacketSha256 = null;
  next.trajectory.pendingPacketProvenanceRecordHash = null;
  if (Object.hasOwn(next, "next_unit")) next.status = "mission_pending";
  return { state: next, packet };
}

/** Seal a pending packet and its harness-issued cold-review run in the HMAC ledger. */
export function sealPendingMissionGate({ sessionDir, state } = {}) {
  if (!sessionDir || !state?.trajectory?.pending || !state.trajectory.pendingPacket) {
    return { ok: false, error: "a canonical session and pending Mission Gate packet are required" };
  }
  const next = clone(state);
  const packet = next.trajectory.pendingPacket;
  const packetSha256 = sha256(canonical(packet));
  const reviewRunId = packet.reviewRequest?.runId || null;
  if (!reviewRunId || packet.reviewRequest?.contextMode !== "cold") {
    return { ok: false, error: "pending Mission Gate packet has no harness-issued cold-review run" };
  }
  if (next.trajectory.pendingPacketSha256 || next.trajectory.pendingPacketProvenanceRecordHash) {
    const verified = validatePendingMissionGateSeal({ sessionDir, state: next, requirePacketFile: false });
    return verified.ok ? { ok: true, state: next, packet, already: true } : { ok: false, error: verified.errors.join("; ") };
  }
  const provenance = appendProvenanceEvent(sessionDir, {
    type: "mission_gate_opened",
    triggerId: packet.triggerId,
    packetSha256,
    reviewRunId,
    missionSha256: packet.bindings?.missionSha256 ?? null,
    planSha256: packet.bindings?.planSha256 ?? null,
    strategyEpoch: packet.bindings?.strategyEpoch ?? null,
  });
  next.trajectory.pendingPacketSha256 = packetSha256;
  next.trajectory.pendingPacketProvenanceRecordHash = provenance.recordHash;
  atomicWriteSync(join(sessionDir, "trajectory-review-request.json"), JSON.stringify(packet, null, 2) + "\n");
  return { ok: true, state: next, packet, provenanceRecordHash: provenance.recordHash };
}

/** Validate the state packet, public packet file, and signed opening event as one binding. */
export function validatePendingMissionGateSeal({ sessionDir, state, requirePacketFile = true } = {}) {
  if (!state?.trajectory?.pending) return { ok: true, errors: [] };
  const errors = [];
  const packet = state.trajectory.pendingPacket;
  if (!packet || typeof packet !== "object") return { ok: false, errors: ["pending Mission Gate packet is missing"] };
  const packetSha256 = sha256(canonical(packet));
  if (state.trajectory.pendingPacketSha256 !== packetSha256) {
    errors.push("pending Mission Gate packet hash mismatch");
  }
  const recordHash = state.trajectory.pendingPacketProvenanceRecordHash;
  const provenance = findProvenanceEvent(sessionDir, recordHash);
  if (!provenance.ok) {
    errors.push(`Mission Gate opening provenance is invalid: ${provenance.error}`);
  } else {
    const event = provenance.event || {};
    if (event.type !== "mission_gate_opened") errors.push("Mission Gate opening provenance type is invalid");
    if (event.triggerId !== packet.triggerId) errors.push("Mission Gate opening provenance triggerId mismatch");
    if (event.packetSha256 !== packetSha256) errors.push("Mission Gate opening provenance packet hash mismatch");
    if (event.reviewRunId !== packet.reviewRequest?.runId) errors.push("Mission Gate opening provenance review run mismatch");
    if ((event.missionSha256 ?? null) !== (packet.bindings?.missionSha256 ?? null)) errors.push("Mission Gate opening mission binding mismatch");
    if ((event.planSha256 ?? null) !== (packet.bindings?.planSha256 ?? null)) errors.push("Mission Gate opening plan binding mismatch");
    if ((event.strategyEpoch ?? null) !== (packet.bindings?.strategyEpoch ?? null)) errors.push("Mission Gate opening strategy epoch mismatch");
  }
  if (requirePacketFile) {
    const packetPath = join(sessionDir, "trajectory-review-request.json");
    try {
      const publicPacket = JSON.parse(readFileSync(packetPath, "utf8"));
      if (sha256(canonical(publicPacket)) !== packetSha256) {
        errors.push("trajectory-review-request.json differs from the signed pending packet");
      }
    } catch (error) {
      errors.push(`trajectory-review-request.json is unreadable: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function sameBinding(actual, expected) {
  return (actual ?? null) === (expected ?? null);
}

const REVIEW_ROUTE_MATRIX = {
  ARTIFACT: new Set(["CONTINUE_CURRENT", "RESTORE", "HUMAN_REBET", "STOP_SALVAGE"]),
  PLAN: new Set(["RESHAPE_SMALLER", "HUMAN_REBET", "STOP_SALVAGE"]),
  GOAL_SPEC: new Set(["HUMAN_REBET", "STOP_SALVAGE"]),
  ENVIRONMENT: new Set(["RECON", "RESTORE", "HUMAN_REBET", "STOP_SALVAGE"]),
  NONE: new Set(["CONTINUE_CURRENT", "STOP_SALVAGE"]),
};

export function validateColdMissionReview({ state, review, requireFinalPass = false } = {}) {
  const errors = [];
  const packet = trajectoryOf(state).pendingPacket;
  if (!review || typeof review !== "object") return { ok: false, errors: ["mission review is missing"] };
  if (review.schemaVersion !== 1) errors.push("mission review schemaVersion must be 1");
  if (!packet || review.triggerId !== packet.triggerId) errors.push("mission review triggerId is stale or mismatched");
  if (review.reviewer?.contextMode !== "cold") errors.push("mission review contextMode must be cold");
  if (!review.reviewer?.runId) errors.push("mission review runId is required");
  if (packet?.reviewRequest?.runId && review.reviewer?.runId !== packet.reviewRequest.runId) {
    errors.push("mission review runId does not match the harness-issued cold-review run");
  }
  if (!review.reviewer?.provenanceRecordHash) errors.push("mission review provenanceRecordHash is required");
  if (review.localFixesIncluded !== false) errors.push("mission review must set localFixesIncluded=false");
  if (!Object.hasOwn(REVIEW_ROUTE_MATRIX, review.classification || "")) {
    errors.push("mission review classification is invalid");
  } else if (!REVIEW_ROUTE_MATRIX[review.classification].has(review.recommendation)) {
    errors.push(`mission review recommendation '${review.recommendation}' is invalid for ${review.classification}`);
  }
  if (Array.isArray(packet?.allowedDecisions) && !packet.allowedDecisions.includes(review.recommendation)) {
    errors.push(`mission review recommendation '${review.recommendation}' is not executable for this trigger`);
  }
  if (review.classification === "NONE" && !packet?.checkpoint) {
    errors.push("mission review classification NONE is only valid at a scheduled checkpoint");
  }

  const expectedBindings = packet?.bindings || currentMissionBindings(state);
  const liveBindings = currentMissionBindings(state);
  for (const [key, expected] of Object.entries(expectedBindings)) {
    if (!sameBinding(review.bindings?.[key], expected)) errors.push(`mission review binding '${key}' is stale or mismatched`);
    if (!sameBinding(liveBindings?.[key], expected)) errors.push(`Mission Gate packet binding '${key}' is stale against current state`);
  }

  const usedRunIds = new Set([
    ...(Array.isArray(state?.history) ? state.history.map(entry => entry?.runId) : []),
    ...(Array.isArray(state?._tick_history) ? state._tick_history.map(entry => entry?.runId) : []),
    ...(Array.isArray(trajectoryOf(state).usedReviewRunIds) ? trajectoryOf(state).usedReviewRunIds : []),
  ].filter(Boolean));
  if (review.reviewer?.runId && usedRunIds.has(review.reviewer.runId)) {
    errors.push("mission review runId was already used by build/evaluation/review work");
  }

  const declaredSignals = Array.isArray(packet?.mission?.realitySignals) ? packet.mission.realitySignals : [];
  const reviewSignals = Array.isArray(review.realitySignals) ? review.realitySignals : [];
  const declaredSignalIds = new Set(declaredSignals.map(signal => signal.id));
  const seenSignalIds = new Set();
  const currentReceiptIds = new Set(
    (Array.isArray(state?.evidenceReceipts) ? state.evidenceReceipts : [])
      .filter(receipt => receipt?.stale !== true && receipt?.strategyEpoch === state.mission.strategyEpoch)
      .map(receipt => receipt.id),
  );
  for (const signal of reviewSignals) {
    if (!declaredSignalIds.has(signal?.id)) errors.push(`mission review contains unknown reality signal '${signal?.id || "missing"}'`);
    if (seenSignalIds.has(signal?.id)) errors.push(`mission review repeats reality signal '${signal.id}'`);
    seenSignalIds.add(signal?.id);
    if (!new Set(["SUPPORTS", "REFUTES", "INSUFFICIENT"]).has(signal?.status)) {
      errors.push(`reality signal '${signal?.id || "missing"}' has invalid status`);
    }
    if (!Array.isArray(signal?.evidenceReceiptIds)) {
      errors.push(`reality signal '${signal?.id || "missing"}' evidenceReceiptIds must be an array`);
      continue;
    }
    const unknownReceipts = signal.evidenceReceiptIds.filter(id => !currentReceiptIds.has(id));
    if (unknownReceipts.length > 0) {
      errors.push(`reality signal '${signal.id}' cites stale or unknown evidence: ${unknownReceipts.join(", ")}`);
    }
    if ((signal.status === "SUPPORTS" || signal.status === "REFUTES") && signal.evidenceReceiptIds.length === 0) {
      errors.push(`reality signal '${signal.id}' status ${signal.status} requires current evidence`);
    }
  }
  for (const signal of declaredSignals) {
    if (!seenSignalIds.has(signal.id)) errors.push(`reality signal '${signal.id}' was not settled by the cold review`);
  }

  const finalPass = requireFinalPass || packet?.checkpoint === "before_finalize";
  if (finalPass) {
    if (review.classification !== "NONE") errors.push("final Mission review classification must be NONE");
    if (review.recommendation !== "CONTINUE_CURRENT") errors.push("final Mission review must recommend CONTINUE_CURRENT");
    const statuses = new Map((review.realitySignals || []).map(signal => [signal.id, signal]));
    const coveredCriteria = new Set(
      integratedPassReceipts(state).flatMap(receipt => Array.isArray(receipt.satisfies) ? receipt.satisfies : []),
    );
    for (const criterionId of Object.keys(state?.mission?.criterionHashes || {})) {
      if (!coveredCriteria.has(criterionId)) {
        errors.push(`mission criterion '${criterionId}' lacks current integrated PASS evidence`);
      }
    }
    const requiredSignals = Array.isArray(packet?.mission?.realitySignals)
      ? packet.mission.realitySignals.filter(signal => signal.required)
      : [];
    for (const signal of review.realitySignals || []) {
      if (signal.status === "REFUTES") errors.push(`reality signal '${signal.id}' refutes mission success`);
      if (signal.status === "SUPPORTS") {
        const cited = new Set(signal.evidenceReceiptIds || []);
        const scenarioId = packet?.mission?.endToEndScenario?.id;
        const validReceipt = integratedPassReceipts(state).some(receipt => cited.has(receipt.id)
          && (!scenarioId || receipt.scenarioId === scenarioId));
        if (!validReceipt) errors.push(`reality signal '${signal.id}' lacks current integrated PASS evidence`);
      }
    }
    for (const required of requiredSignals) {
      if (statuses.get(required.id)?.status !== "SUPPORTS") {
        errors.push(`required reality signal '${required.id}' is not SUPPORTS`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function hasCurrentFinalCheckpoint(state) {
  if (!state?.mission || trajectoryOf(state).pending) return false;
  const bindings = currentMissionBindings(state);
  return (Array.isArray(state.checkpointReceipts) ? state.checkpointReceipts : []).some(receipt =>
    receipt?.checkpointId === "before_finalize"
    && receipt?.stale !== true
    && receipt?.strategyEpoch === bindings.strategyEpoch
    && sameBinding(receipt?.missionSha256, bindings.missionSha256)
    && sameBinding(receipt?.acceptanceCriteriaSha256, bindings.acceptanceCriteriaSha256)
    && sameBinding(receipt?.planSha256, bindings.planSha256)
    && sameBinding(receipt?.evidenceSetSha256, bindings.evidenceSetSha256)
    && sameBinding(receipt?.artifactManifestSha256, bindings.artifactManifestSha256)
    && receipt?.missionReviewSha256
    && receipt?.provenanceRecordHash
  );
}

/** Pure bounded decision state update; filesystem/provenance commit stays in the CLI owner. */
export function applyMissionDecision({
  state,
  action,
  actor = "agent",
  review = null,
  carryIntentReview = false,
  approval = null,
  decisionEventId = null,
  now = new Date().toISOString(),
} = {}) {
  const errors = [];
  if (!state?.mission) return { ok: false, errors: ["mission is not enabled"] };
  if (!MISSION_ACTIONS.has(action)) return { ok: false, errors: [`invalid mission action '${action}'`] };
  if (!trajectoryOf(state).pending) return { ok: false, errors: ["no Mission Gate is pending"] };
  const pendingPacket = trajectoryOf(state).pendingPacket;
  if (pendingPacket?.retryable === false && pendingPacket?.checkpoint !== "before_finalize" &&
      !new Set(["HUMAN_REBET", "STOP_SALVAGE"]).has(action)) {
    return { ok: false, errors: ["this Mission Gate is non-retryable; choose HUMAN_REBET or STOP_SALVAGE"] };
  }
  const scopeTokens = decisionScopeTokens(pendingPacket);
  const reshaped = new Set(Array.isArray(trajectoryOf(state).agentReshapedFindingRefs)
    ? trajectoryOf(state).agentReshapedFindingRefs
    : []);
  if (scopeTokens.some(token => reshaped.has(token)) &&
      !new Set(["HUMAN_REBET", "STOP_SALVAGE"]).has(action)) {
    return {
      ok: false,
      errors: ["this invariant survived its one agent reshape; choose HUMAN_REBET or STOP_SALVAGE"],
    };
  }
  if (Array.isArray(pendingPacket?.allowedDecisions) && !pendingPacket.allowedDecisions.includes(action)) {
    return { ok: false, errors: [`action '${action}' is not executable for this Mission Gate`] };
  }
  const continued = new Set(Array.isArray(trajectoryOf(state).continuedFindingRefs)
    ? trajectoryOf(state).continuedFindingRefs
    : []);
  if (action === "CONTINUE_CURRENT" && !pendingPacket?.checkpoint &&
      scopeTokens.some(token => continued.has(token))) {
    return {
      ok: false,
      errors: ["the bounded retry for this invariant was already granted; reshape, re-bet, or stop"],
    };
  }

  const reviewResult = validateColdMissionReview({
    state,
    review,
    requireFinalPass: trajectoryOf(state).pendingPacket?.checkpoint === "before_finalize",
  });
  if ((actor === "agent" || action === "CONTINUE_CURRENT") && !carryIntentReview) {
    errors.push(...reviewResult.errors);
  }
  if (review && review.recommendation !== action && !(actor === "human" && approval)) {
    errors.push("decision does not match the cold review recommendation");
  }
  if (actor === "human" && review && review.recommendation !== action && !approval) {
    errors.push("human override requires an approval artifact");
  }
  if (review?.classification === "GOAL_SPEC" &&
      !new Set(["HUMAN_REBET", "STOP_SALVAGE"]).has(action)) {
    errors.push("GOAL_SPEC can only resolve through HUMAN_REBET or STOP_SALVAGE");
  }
  if (errors.length > 0) return { ok: false, errors };

  const next = clone(state);
  next.trajectory ||= {};
  delete next.trajectory.pendingDecision;
  next.trajectory.lastDecision = { action, actor, eventId: decisionEventId, decidedAt: now };
  next.trajectory.usedReviewRunIds ||= [];
  if (review?.reviewer?.runId) next.trajectory.usedReviewRunIds.push(review.reviewer.runId);

  if (action === "CONTINUE_CURRENT") {
    const checkpointId = next.trajectory.pendingPacket?.checkpoint || null;
    if (checkpointId) {
      const bindings = currentMissionBindings(next);
      next.checkpointReceipts ||= [];
      next.checkpointReceipts.push({
        checkpointId,
        ...bindings,
        missionReviewSha256: sha256(canonical(review)),
        provenanceRecordHash: review.reviewer.provenanceRecordHash,
        decisionEventId,
        observedAt: now,
      });
      next.trajectory.retryAllowance = 0;
      next.trajectory.retryGrant = null;
    } else {
      next.trajectory.retryAllowance = 1;
      next.trajectory.retryGrant = {
        triggerId: pendingPacket.triggerId,
        strategyEpoch: next.mission.strategyEpoch,
        scopeTokens,
        edgeKey: pendingPacket.edgeKey || null,
        command: pendingPacket.origin?.command || (Object.hasOwn(next, "next_unit") ? "next-tick" : "transition"),
        sourceNode: pendingPacket.origin?.fromNode ?? pendingPacket.planSummary?.currentNode ?? null,
        nextUnit: pendingPacket.origin?.nextUnit ?? pendingPacket.planSummary?.nextUnit ?? null,
        sessionSha256: pendingPacket.origin?.sessionSha256 || null,
        remaining: 1,
      };
      next.trajectory.continuedFindingRefs ||= [];
      next.trajectory.continuedFindingRefs = [
        ...new Set([...next.trajectory.continuedFindingRefs, ...scopeTokens]),
      ];
    }
    next.trajectory.pending = false;
    next.trajectory.reason = null;
    next.trajectory.triggerId = null;
    next.trajectory.pendingPacket = null;
  } else if (action === "RESHAPE_SMALLER") {
    next.mission.strategyEpoch = (next.mission.strategyEpoch || 0) + 1;
    if (actor === "agent") {
      next.trajectory.agentReshapedFindingRefs ||= [];
      next.trajectory.agentReshapedFindingRefs = [
        ...new Set([...next.trajectory.agentReshapedFindingRefs, ...scopeTokens]),
      ];
    }
    next.trajectory.pending = false;
    next.trajectory.reason = null;
    next.trajectory.triggerId = null;
    next.trajectory.pendingPacket = null;
    next.trajectory.retryAllowance = 0;
    next.trajectory.retryGrant = null;
  } else if (action === "STOP_SALVAGE") {
    if (next.trajectory.pendingAction) {
      next.trajectory.lastSupersededIntent = {
        action: next.trajectory.pendingAction,
        eventId: next.trajectory.pendingActionEventId || null,
        supersededAt: now,
      };
    }
    next.trajectory.pendingAction = null;
    next.trajectory.pendingActionEventId = null;
    next.trajectory.pendingActionActor = null;
    next.trajectory.pendingActionReviewSha256 = null;
    next.trajectory.pendingActionReviewProvenanceRecordHash = null;
    next.trajectory.retryAllowance = 0;
    next.trajectory.retryGrant = null;
    next.trajectory.pending = false;
    next.trajectory.pendingPacket = null;
    next.status = Object.hasOwn(next, "next_unit") ? "terminated" : "stopped";
    next.stoppedAt = now;
  } else {
    next.trajectory.pendingAction = action;
    next.trajectory.pendingActionEventId = decisionEventId;
    next.trajectory.retryAllowance = 0;
    next.trajectory.retryGrant = null;
  }
  return { ok: true, errors: [], state: next };
}
