// Loop init command: init-loop
// Depends on: loop-helpers.mjs, util.mjs

import { readFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import {
  parsePlan, validatePlanStructure, hashContent,
  getGitHeadHash, detectPreCommitHooks, detectTestScript,
} from "./loop-helpers.mjs";
import { getFlag, resolveDir, atomicWriteSync, WRITER_SIG } from "./util.mjs";
import { runLint } from "./criteria-lint.mjs";

// ─── init-loop ──────────────────────────────────────────────────

export function cmdInitLoop(args) {
  const dir = resolveDir(args);
  const planFile = getFlag(args, "plan", join(dir, "plan.md"));
  const flowTemplate = getFlag(args, "flow-template", null);
  const flowFile = getFlag(args, "flow-file", null);
  const handlersRaw = getFlag(args, "handlers", null);
  const skipLint = args.includes("--skip-lint");

  if (!existsSync(planFile)) {
    console.log(JSON.stringify({
      initialized: false,
      errors: [`plan file not found: ${planFile}`],
    }));
    return;
  }

  const planText = readFileSync(planFile, "utf8");
  const units = parsePlan(planText);

  if (units.length === 0) {
    console.log(JSON.stringify({
      initialized: false,
      errors: ["no units found in plan — expected lines like '- F1.1: spec — description'"],
    }));
    return;
  }

  const structureErrors = validatePlanStructure(units);

  // Duplicate ID check
  const idCounts = {};
  for (const u of units) {
    idCounts[u.id] = (idCounts[u.id] || 0) + 1;
  }
  for (const [id, count] of Object.entries(idCounts)) {
    if (count > 1) {
      structureErrors.push(`duplicate unit ID '${id}' appears ${count} times`);
    }
  }

  // Active loop check
  const statePath = join(dir, "loop-state.json");
  if (existsSync(statePath)) {
    try {
      const existing = JSON.parse(readFileSync(statePath, "utf8"));
      if (existing.status !== "pipeline_complete" && existing.status !== "terminated") {
        console.log(JSON.stringify({
          initialized: false,
          errors: ["loop-state.json already exists and is active — use next-tick to advance or delete to restart"],
        }));
        return;
      }
    } catch { /* corrupt state, ok to overwrite */ }
  }

  if (structureErrors.length > 0) {
    console.log(JSON.stringify({
      initialized: false,
      errors: structureErrors,
      units: units.map(u => `${u.id}: ${u.type}`),
      hint: "every implement/build unit must be followed by a review unit before the next implement",
    }));
    return;
  }

  // ── G3: Criteria-lint gate ────────────────────────────────────
  const criteriaFile = join(dir, "acceptance-criteria.md");
  const initWarnings = [];

  if (!existsSync(criteriaFile)) {
    initWarnings.push("no acceptance-criteria.md found — loop has no definition of done");
  } else if (skipLint) {
    initWarnings.push("criteria-lint skipped via --skip-lint — acceptance criteria not mechanically validated");
  } else {
    const criteriaText = readFileSync(criteriaFile, "utf8");
    const lintResult = runLint(criteriaText);
    if (lintResult.failures.length > 0) {
      console.log(JSON.stringify({
        initialized: false,
        errors: lintResult.failures.map(f => `criteria-lint [${f.check}]: ${f.message}`),
        hint: "fix acceptance-criteria.md or pass --skip-lint to bypass",
      }));
      return;
    }
    if (lintResult.warnings.length > 0) {
      for (const w of lintResult.warnings) {
        initWarnings.push(`criteria-lint [${w.check}]: ${w.message}`);
      }
    }
  }

  mkdirSync(dir, { recursive: true });
  const unitsWithoutVerify = units.filter(u =>
    !u.verify && (u.type.startsWith("implement") || u.type.startsWith("build") || u.type.startsWith("fix") || u.type.startsWith("e2e"))
  );
  const unitsWithoutEval = units.filter(u =>
    !u.eval && (u.type.startsWith("review") || u.type.startsWith("accept"))
  );
  if (unitsWithoutVerify.length > 0) {
    initWarnings.push(`${unitsWithoutVerify.length} implement/fix/e2e unit(s) have no verify: line — ticks won't know how to verify themselves (${unitsWithoutVerify.map(u => u.id).join(", ")})`);
  }
  if (unitsWithoutEval.length > 0) {
    initWarnings.push(`${unitsWithoutEval.length} review/accept unit(s) have no eval: line — reviewers won't know what to look for (${unitsWithoutEval.map(u => u.id).join(", ")})`);
  }

  const planHash = hashContent(planText);
  const state = {
    tick: 0,
    unit: null,
    description: "Loop initialized",
    status: "initialized",
    artifacts: [],
    next_unit: units[0].id,
    blockers: [],
    review_of_previous: "",
    plan_file: planFile,
    units_total: units.length,
    unit_ids: units.map(u => u.id),
    _written_by: WRITER_SIG,
    _plan_hash: planHash,
    _last_modified: new Date().toISOString(),
    _git_head: getGitHeadHash(),
    _tick_history: [],
    _max_total_ticks: units.length * 3,
    _started_at: new Date().toISOString(),
    _max_duration_hours: 24,
    _flow_template: flowTemplate || undefined,
    _flow_file: flowFile ? resolve(flowFile) : undefined,
  };

  // Parse --handlers JSON if provided (unit type → skill/command dispatch)
  if (handlersRaw) {
    try {
      const handlers = JSON.parse(handlersRaw);
      if (typeof handlers === "object" && handlers !== null && !Array.isArray(handlers)) {
        state._unit_handlers = handlers;
      } else {
        console.log(JSON.stringify({ initialized: false, errors: ["--handlers must be a JSON object"] }));
        return;
      }
    } catch (e) {
      console.log(JSON.stringify({ initialized: false, errors: [`--handlers is not valid JSON: ${e.message}`] }));
      return;
    }
  }

  state._write_nonce = createHash("sha256")
    .update(Date.now().toString() + Math.random().toString())
    .digest("hex").slice(0, 16);

  const hasHooks = detectPreCommitHooks();
  const testScripts = detectTestScript();
  state._external_validators = {
    pre_commit_hooks: hasHooks,
    test_script: testScripts.test,
    lint_script: testScripts.lint,
    typecheck_script: testScripts.typecheck,
  };

  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

  const validatorList = [];
  if (hasHooks) validatorList.push("pre-commit hooks");
  if (testScripts.test) validatorList.push("test script");
  if (testScripts.lint) validatorList.push("lint script");
  if (testScripts.typecheck) validatorList.push("typecheck script");

  console.log(JSON.stringify({
    initialized: true,
    units: units.map(u => `${u.id}: ${u.type}`),
    first_unit: units[0].id,
    total_units: units.length,
    external_validators: validatorList.length > 0 ? validatorList : ["none detected — quality relies on in-process checks only"],
    warnings: initWarnings.length > 0 ? initWarnings : undefined,
  }));
}
