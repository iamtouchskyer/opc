// Loop init command: init-loop
// Depends on: loop-helpers.mjs, util.mjs

import { readFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import {
  parsePlan, validatePlanStructure, hashContent, parseTaskScope,
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
  const projectDirRaw = getFlag(args, "project-dir", null);

  // Resolve and validate projectDir
  let projectDir = null;
  if (projectDirRaw) {
    projectDir = resolve(projectDirRaw);
    if (!existsSync(projectDir)) {
      console.log(JSON.stringify({
        initialized: false,
        errors: [`--project-dir path does not exist: ${projectDir}`],
        status: "invalid_config",
        detail: `The path '${projectDir}' passed via --project-dir does not exist on the filesystem.`,
        hint: "verify the path exists and is accessible, or omit --project-dir to use the current working directory",
      }));
      return;
    }
    if (!statSync(projectDir).isDirectory()) {
      console.log(JSON.stringify({
        initialized: false,
        errors: [`--project-dir path is not a directory: ${projectDir}`],
        status: "invalid_config",
        detail: `The path '${projectDir}' exists but is not a directory.`,
        hint: "pass a directory path, not a file path",
      }));
      return;
    }
  }

  // ── G0: Recon file gate ─────────────────────────────────────────
  const reconFile = getFlag(args, "recon", null);
  if (reconFile) {
    if (!existsSync(reconFile)) {
      console.log(JSON.stringify({
        initialized: false,
        errors: [`recon file not found: ${reconFile} — run codebase reconnaissance before planning`],
        status: "missing_recon",
        detail: `The recon file '${reconFile}' does not exist. Codebase reconnaissance must be completed before planning.`,
        hint: "write a recon summary (directory structure, existing tests, current implementation) to a file and pass its path via --recon",
      }));
      return;
    }
    const reconSize = readFileSync(reconFile, "utf8").length;
    if (reconSize < 200) {
      console.log(JSON.stringify({
        initialized: false,
        errors: [`recon file too small (${reconSize} chars, need ≥200) — a meaningful recon must describe the existing codebase`],
        status: "insufficient_recon",
        detail: `Recon file is only ${reconSize} characters (minimum 200). A meaningful recon must describe the existing codebase structure.`,
        hint: "include: directory layout, existing tests, relevant source files, what's already implemented",
      }));
      return;
    }
  }

  if (!existsSync(planFile)) {
    console.log(JSON.stringify({
      initialized: false,
      errors: [`plan file not found: ${planFile}`],
      status: "missing_plan",
      detail: `Expected plan file at '${planFile}' but it does not exist.`,
      hint: "create plan.md with unit definitions (e.g. '- F1.1: implement — description') or pass --plan <path>",
    }));
    return;
  }

  const planText = readFileSync(planFile, "utf8");
  const units = parsePlan(planText);

  if (units.length === 0) {
    console.log(JSON.stringify({
      initialized: false,
      errors: ["no units found in plan — expected lines like '- F1.1: spec — description'"],
      status: "invalid_plan",
      detail: "Plan file was found but contains no parseable unit definitions.",
      hint: "each unit must match pattern: '- ID: type — description' (e.g. '- F1.1: implement — add login form')",
    }));
    return;
  }

  const structureResult = validatePlanStructure(units);
  const structureErrors = structureResult.errors;
  const structureWarnings = structureResult.warnings || [];

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
          status: "active_loop_exists",
          detail: `An active loop (status: '${existing.status}', tick: ${existing.tick || 0}) already exists in this directory.`,
          hint: "run next-tick to continue the existing loop, or delete loop-state.json to start fresh",
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
      status: "invalid_plan_structure",
      detail: `Plan has ${structureErrors.length} structural error(s): implement/build units must be followed by review units.`,
      hint: "every implement/build unit must be followed by a review unit before the next implement",
    }));
    return;
  }

  // ── G2.5: Task Scope validation ──────────────────────────────
  const skipScope = args.includes("--skip-scope");
  const taskScope = parseTaskScope(planText);
  if (taskScope.length === 0 && !skipScope) {
    console.log(JSON.stringify({
      initialized: false,
      errors: ["plan.md has no '## Task Scope' section with SCOPE-N items — every plan must declare what the original task requires so the harness can verify coverage at pipeline end"],
      status: "missing_scope",
      detail: "Plan file lacks a '## Task Scope' section. The harness uses scope items to verify all requirements are covered at pipeline completion.",
      hint: "add '## Task Scope' with '- SCOPE-1: ...' items, or pass --skip-scope to bypass",
    }));
    return;
  }

  // ── G3: Criteria-lint gate ────────────────────────────────────
  const criteriaFile = join(dir, "acceptance-criteria.md");
  const initWarnings = [...structureWarnings];

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
        status: "criteria_lint_failed",
        detail: `acceptance-criteria.md failed ${lintResult.failures.length} lint check(s). The criteria are not mechanically valid.`,
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
    _git_head: getGitHeadHash(projectDir),
    projectDir: projectDir || undefined,
    _tick_history: [],
    _max_total_ticks: units.length * 3,
    _started_at: new Date().toISOString(),
    _max_duration_hours: 24,
    _flow_template: flowTemplate || undefined,
    _flow_file: flowFile ? resolve(flowFile) : undefined,
    _task_scope: taskScope.length > 0 ? taskScope : undefined,
    autoMode: args.includes("--auto") || undefined,
  };

  // Parse --handlers JSON if provided (unit type → skill/command dispatch)
  if (handlersRaw) {
    try {
      const handlers = JSON.parse(handlersRaw);
      if (typeof handlers === "object" && handlers !== null && !Array.isArray(handlers)) {
        state._unit_handlers = handlers;
      } else {
        console.log(JSON.stringify({ initialized: false, errors: ["--handlers must be a JSON object"], status: "invalid_config", detail: "--handlers value parsed as JSON but is not an object (got array or primitive).", hint: "pass a JSON object mapping unit types to handler commands, e.g. '{\"implement\":\"skill:build\"}'" }));
        return;
      }
    } catch (e) {
      console.log(JSON.stringify({ initialized: false, errors: [`--handlers is not valid JSON: ${e.message}`], status: "invalid_config", detail: `--handlers value could not be parsed as JSON: ${e.message}`, hint: "ensure the value is valid JSON, properly quoted for your shell" }));
      return;
    }
  }

  state._write_nonce = createHash("sha256")
    .update(Date.now().toString() + Math.random().toString())
    .digest("hex").slice(0, 16);

  const hasHooks = detectPreCommitHooks(projectDir);
  const testScripts = detectTestScript(projectDir);
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
