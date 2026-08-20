// Shared helpers for loop commands: plan parsing, git detection, hashing
// Depends on: util.mjs

import { readFileSync, existsSync, lstatSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { execFileSync } from "child_process";

// ── Plan parsing ────────────────────────────────────────────────

export function parsePlan(planText) {
  const units = [];
  const lines = planText.split("\n");
  const unitPattern = /^\s*[-*]\s+(\w+\.\d+\w*)\s*[:\s]\s*(\S+)\s*[—–-]?\s*(.*)/;
  const subLinePattern = /^\s+[-*]\s+(verify|eval|satisfies|scenario|validator-type)\s*:\s*(.*)/i;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(unitPattern);
    if (m) {
      const unit = {
        id: m[1],
        type: m[2].toLowerCase(),
        description: m[3].trim(),
        verify: null,
        eval: null,
        satisfies: null,
        satisfiesError: null,
        scenario: null,
        validatorType: null,
      };
      for (let j = i + 1; j < lines.length; j++) {
        const sub = lines[j].match(subLinePattern);
        if (sub) {
          const field = sub[1].toLowerCase();
          if (field === "satisfies") {
            const parsed = parseSatisfiesList(sub[2]);
            unit.satisfies = parsed.criteria;
            unit.satisfiesError = parsed.error || null;
          } else if (field === "validator-type") {
            unit.validatorType = sub[2].trim();
          } else {
            unit[field] = sub[2].trim();
          }
        } else if (lines[j].match(unitPattern) || lines[j].trim() === "") {
          break;
        }
      }
      units.push(unit);
    }
  }
  return units;
}

/** Parse a frozen Mission criterion mapping without accepting prose labels. */
export function parseSatisfiesList(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { criteria: [], error: "satisfies mapping is empty" };
  }
  const normalized = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  const criteria = normalized.split(",").map(value =>
    value.trim().replace(/^['\"]|['\"]$/g, "")
  ).filter(Boolean);
  if (criteria.length === 0) return { criteria: [], error: "satisfies mapping is empty" };
  const invalid = criteria.filter(id => !/^(?:OUT|FLOOR)-\d+$/.test(id));
  if (invalid.length > 0) {
    return { criteria: [], error: `satisfies mapping contains invalid criterion IDs: ${invalid.join(", ")}` };
  }
  if (new Set(criteria).size !== criteria.length) {
    return { criteria: [], error: "satisfies mapping contains duplicate criterion IDs" };
  }
  return { criteria, error: null };
}

/** Parse the one top-level mapping in a standard-flow test plan. */
export function parsePlanSatisfiesMapping(planText) {
  const matches = [];
  for (const line of String(planText || "").split("\n")) {
    const match = line.match(/^\s{0,3}(?:[-*]\s+)?satisfies\s*:\s*(.*)$/i);
    if (match) matches.push(match[1]);
  }
  if (matches.length === 0) return { criteria: [], error: "test plan has no frozen satisfies: mapping" };
  if (matches.length > 1) return { criteria: [], error: "test plan contains multiple satisfies: mappings" };
  return parseSatisfiesList(matches[0]);
}

/** Parse the frozen scenario, validator, and criteria tuple in a standard test plan. */
export function parsePlanEvidenceMapping(planText) {
  const values = { scenarioId: [], validatorType: [] };
  for (const line of String(planText || "").split("\n")) {
    const scenario = line.match(/^\s{0,3}(?:[-*]\s+)?scenario\s*:\s*(\S.*)$/i);
    const validator = line.match(/^\s{0,3}(?:[-*]\s+)?validator-type\s*:\s*(\S.*)$/i);
    if (scenario) values.scenarioId.push(scenario[1].trim());
    if (validator) values.validatorType.push(validator[1].trim());
  }
  if (values.scenarioId.length !== 1) {
    return { error: `test plan must contain exactly one scenario: mapping (found ${values.scenarioId.length})` };
  }
  if (values.validatorType.length !== 1) {
    return { error: `test plan must contain exactly one validator-type: mapping (found ${values.validatorType.length})` };
  }
  const satisfies = parsePlanSatisfiesMapping(planText);
  if (satisfies.error) return { error: satisfies.error };
  return {
    error: null,
    scenarioId: values.scenarioId[0],
    validatorType: values.validatorType[0],
    criteria: satisfies.criteria,
  };
}

function proofContentPasses(binding, content) {
  if (binding?.proof === "opc-loop-verify") {
    return /^# Harness-owned test execution\s*$/m.test(content)
      && /^# Command: \S.*$/m.test(content)
      && /^# Exit code: 0\s*$/m.test(content)
      && /^# Non-vacuous oracle: true\s*$/m.test(content)
      && /^# Timestamp: \S.*$/m.test(content);
  }
  if (binding?.proof === "opc-test-command") {
    try {
      const data = JSON.parse(content);
      const checks = Array.isArray(data?.checks) ? data.checks : [];
      const structuredOracle = checks.length > 0 && checks.every(check =>
        check?.pass === true && Number.isFinite(Number(check.total)) && Number(check.total) > 0
      );
      let markerOracle = false;
      for (const line of String(data?.stdout || "").split(/\r?\n/)) {
        const marker = line.match(/^OPC_ORACLE\s+(.+)$/);
        if (!marker) continue;
        try {
          const oracle = JSON.parse(marker[1]);
          const oracleChecks = Array.isArray(oracle?.checks) ? oracle.checks : [];
          markerOracle = oracleChecks.length > 0 && oracleChecks.every(check =>
            check?.pass === true && Number.isFinite(Number(check.total)) && Number(check.total) > 0
          );
        } catch { /* malformed markers remain non-proving */ }
        if (markerOracle) break;
      }
      const tapTests = String(data?.stdout || "").match(/^# tests\s+(\d+)\s*$/m);
      const tapFailures = String(data?.stdout || "").match(/^# fail\s+(\d+)\s*$/m);
      const tapOracle = Number(tapTests?.[1] || 0) > 0 && Number(tapFailures?.[1] || 0) === 0;
      return data?.provenance?.kind === "opc-test-command"
        && data.provenance.executionActor === "opc-harness:test-command"
        && Number(data.exitCode) === 0
        && Number(data.test_fail_count || 0) === 0
        && (structuredOracle || markerOracle || tapOracle);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Re-hash the concrete files behind current integrated PASS receipts.
 * A stale receipt remains in the audit trail but no longer counts as progress.
 */
export function revalidateMissionEvidenceReceipts(state, now = new Date().toISOString()) {
  const next = structuredClone(state);
  const staleReceiptIds = [];
  const epoch = next?.mission?.strategyEpoch;
  if (!Array.isArray(next?.evidenceReceipts)) {
    return { state: next, changed: false, staleReceiptIds };
  }
  for (const receipt of next.evidenceReceipts) {
    if (receipt?.scope !== "integrated" || receipt?.result !== "PASS" ||
        receipt?.stale === true || receipt?.strategyEpoch !== epoch) continue;
    const bindings = Array.isArray(receipt.artifactBindings) ? receipt.artifactBindings : [];
    let staleReason = null;
    if (bindings.length === 0) {
      staleReason = "receipt has no path-bound evidence artifacts";
    } else {
      const boundHashes = [];
      let passProofs = 0;
      for (const binding of bindings) {
        if (!binding || typeof binding.path !== "string" || typeof binding.sha256 !== "string") {
          staleReason = "receipt contains an invalid artifact binding";
          break;
        }
        const artifactPath = resolve(binding.path);
        try {
          const stat = lstatSync(artifactPath);
          if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(artifactPath) !== artifactPath) {
            staleReason = `evidence artifact is no longer a canonical regular file: ${binding.path}`;
            break;
          }
          const content = readFileSync(artifactPath);
          const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
          if (hash !== binding.sha256) {
            staleReason = `evidence artifact content changed: ${binding.path}`;
            break;
          }
          boundHashes.push(hash);
          if (binding.proof) {
            passProofs++;
            if (!proofContentPasses(binding, content.toString("utf8"))) {
              staleReason = `evidence PASS content is no longer valid: ${binding.path}`;
              break;
            }
          }
        } catch {
          staleReason = `evidence artifact is missing or unreadable: ${binding.path}`;
          break;
        }
      }
      if (!staleReason) {
        const declared = Array.isArray(receipt.artifactHashes) ? receipt.artifactHashes : [];
        const actual = [...boundHashes].sort();
        if (JSON.stringify(actual) !== JSON.stringify([...declared].sort())) {
          staleReason = "receipt artifact hash set does not match its path bindings";
        } else if (passProofs === 0) {
          staleReason = "receipt has no harness-owned PASS proof";
        }
      }
    }
    if (staleReason) {
      receipt.stale = true;
      receipt.staleReason = staleReason;
      receipt.staleAt = now;
      staleReceiptIds.push(receipt.id);
    }
  }
  return { state: next, changed: staleReceiptIds.length > 0, staleReceiptIds };
}

export function validatePlanStructure(units) {
  const errors = [];
  const warnings = [];
  let pendingImplement = null;

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const type = u.type;

    if (type.startsWith("implement") || type.startsWith("build")) {
      if (pendingImplement) {
        errors.push(
          `unit ${u.id} (${type}) follows ${pendingImplement.id} (${pendingImplement.type}) without a review unit between them`
        );
      }
      pendingImplement = u;
    } else if (type.startsWith("review")) {
      pendingImplement = null;
    }
  }

  if (pendingImplement) {
    errors.push(
      `plan ends with ${pendingImplement.id} (${pendingImplement.type}) — no review unit follows`
    );
  }

  // Plan completeness: implement units without verification coverage
  const implementCount = units.filter(u => u.type.startsWith("implement") || u.type.startsWith("build")).length;
  const testCount = units.filter(u => u.type.startsWith("e2e") || u.type.startsWith("accept") || u.type.startsWith("test")).length;

  if (implementCount > 0 && testCount === 0) {
    warnings.push(
      `plan has ${implementCount} implement/build unit(s) but 0 test/e2e/accept units — consider adding verification units`
    );
  } else if (testCount > 0 && implementCount >= 3 * testCount) {
    warnings.push(
      `plan has ${implementCount} implement/build unit(s) but only ${testCount} test/e2e/accept unit(s) (ratio ${implementCount}:${testCount}) — consider adding more verification units`
    );
  }

  return { errors, warnings };
}

// ── Task Scope parsing ──────────────────────────────────────────

export function parseTaskScope(planText) {
  const scopeItems = [];
  const sections = planText.split(/^## /m);
  let scopeBody = null;
  for (const sec of sections) {
    if (sec.trimStart().startsWith("Task Scope")) {
      const nlIdx = sec.indexOf("\n");
      scopeBody = nlIdx >= 0 ? sec.slice(nlIdx + 1) : "";
      break;
    }
  }
  if (scopeBody === null) return scopeItems;

  const re = /^-\s+SCOPE-(\d+):\s*(.+)$/gm;
  let m;
  while ((m = re.exec(scopeBody)) !== null) {
    scopeItems.push({ id: `SCOPE-${m[1]}`, text: m[2].trim() });
  }
  return scopeItems;
}

// ── Scope coverage check ────────────────────────────────────────

export function checkScopeCoverage(scopeItems, tickHistory, planUnits) {
  // Build set of completed unit descriptions (from tick history + plan + tick descriptions)
  const completedDescriptions = [];
  for (const tick of tickHistory) {
    if (tick.status === "completed" || tick.verdict === "PASS") {
      const unit = planUnits.find(u => u.id === tick.unit);
      if (unit) completedDescriptions.push(unit.description.toLowerCase());
      // Also include unit id itself for explicit SCOPE-N references
      completedDescriptions.push(tick.unit.toLowerCase());
      // Include tick description if available (set by --description flag)
      if (tick.description) completedDescriptions.push(tick.description.toLowerCase());
    }
  }
  const allCompletedText = completedDescriptions.join(" ");

  const uncovered = [];
  for (const scope of scopeItems) {
    // Check 1: explicit SCOPE-N reference in any completed unit description
    if (allCompletedText.includes(scope.id.toLowerCase())) continue;

    // Check 2: keyword overlap (Jaccard > 0.3)
    const scopeWords = new Set(scope.text.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    let matched = false;
    for (const desc of completedDescriptions) {
      const descWords = new Set(desc.split(/\s+/).filter(w => w.length > 2));
      const intersection = new Set([...scopeWords].filter(w => descWords.has(w)));
      const union = new Set([...scopeWords, ...descWords]);
      const similarity = union.size === 0 ? 0 : intersection.size / scopeWords.size;
      if (similarity >= 0.3) { matched = true; break; }
    }
    if (!matched) uncovered.push(scope);
  }
  return uncovered;
}

// ── Content hashing ─────────────────────────────────────────────

export function hashContent(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ── Git helpers ─────────────────────────────────────────────────

export function getGitHeadHash(projectDir) {
  try {
    const opts = { encoding: "utf8", timeout: 5000 };
    if (projectDir) opts.cwd = projectDir;
    return execFileSync("git", ["rev-parse", "HEAD"], opts).trim();
  } catch {
    return null;
  }
}

export function detectPreCommitHooks(projectDir) {
  const base = projectDir || process.cwd();
  const indicators = [
    join(base, ".husky/pre-commit"),
    join(base, ".git/hooks/pre-commit"),
    join(base, ".pre-commit-config.yaml"),
  ];
  return indicators.some(p => existsSync(p));
}

export function detectTestScript(projectDir) {
  try {
    const pkgPath = projectDir ? join(projectDir, "package.json") : "package.json";
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const scripts = pkg.scripts || {};
    // Return actual command strings (for execution) or false
    return {
      test: scripts.test ? `npm run test` : false,
      lint: scripts.lint ? `npm run lint` : (scripts.eslint ? `npm run eslint` : false),
      typecheck: scripts.typecheck ? `npm run typecheck` : (scripts["type-check"] ? `npm run type-check` : (scripts.tsc ? `npm run tsc` : false)),
    };
  } catch {
    return { test: false, lint: false, typecheck: false };
  }
}
