// Shared helpers for loop commands: plan parsing, git detection, hashing
// Depends on: util.mjs

import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { execFileSync } from "child_process";

// ── Plan parsing ────────────────────────────────────────────────

export function parsePlan(planText) {
  const units = [];
  const lines = planText.split("\n");
  const unitPattern = /^\s*[-*]\s+(\w+\.\d+\w*)\s*[:\s]\s*(\S+)\s*[—–-]?\s*(.*)/;
  const subLinePattern = /^\s+[-*]\s+(verify|eval)\s*:\s*(.*)/i;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(unitPattern);
    if (m) {
      const unit = { id: m[1], type: m[2].toLowerCase(), description: m[3].trim(), verify: null, eval: null };
      for (let j = i + 1; j < lines.length; j++) {
        const sub = lines[j].match(subLinePattern);
        if (sub) {
          unit[sub[1].toLowerCase()] = sub[2].trim();
        } else if (lines[j].match(unitPattern) || lines[j].trim() === "") {
          break;
        }
      }
      units.push(unit);
    }
  }
  return units;
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

// ── Content hashing ─────────────────────────────────────────────

export function hashContent(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ── Git helpers ─────────────────────────────────────────────────

export function getGitHeadHash() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

export function detectPreCommitHooks() {
  const indicators = [
    ".husky/pre-commit",
    ".git/hooks/pre-commit",
    ".pre-commit-config.yaml",
  ];
  return indicators.some(p => existsSync(p));
}

export function detectTestScript() {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const scripts = pkg.scripts || {};
    return {
      test: !!scripts.test,
      lint: !!scripts.lint || !!scripts.eslint,
      typecheck: !!scripts.typecheck || !!scripts["type-check"] || !!scripts.tsc,
    };
  } catch {
    return { test: false, lint: false, typecheck: false };
  }
}
