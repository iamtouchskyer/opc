// Loop state management commands: init-loop, complete-tick, next-tick
// Tamper-detecting guardrails for OPC Layer 2 (loop protocol)
//
// These commands enforce plan structure, evidence requirements, and detect tampering:
// - init-loop: plan structure validation + plan hash fingerprint
// - complete-tick: evidence validation + writer signature + content checks
// - next-tick: auto-termination + plan hash integrity + writer chain verification
//
// Threat model: LLM agent is forgetful/lazy, not adversarial.
// Tamper detection catches: direct state edits, plan modification after init,
// skipped ticks, empty/fake artifacts.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

function getFlag(args, name, fallback = null) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] != null ? args[idx + 1] : fallback;
}

// Tamper detection constants
const WRITER_SIG = "opc-harness";

function hashContent(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ─── plan validation helpers ────────────────────────────────────

/**
 * Parse plan.md into structured units.
 * Expected format: lines like "{F}.{N}  <type>  — <description>"
 * or "- {F}.{N}: <type> — <description>"
 */
function parsePlan(planText) {
  const units = [];
  const lines = planText.split("\n");
  // Match ONLY bullet-prefixed lines: "- F1.2  implement-a" or "- F1.2: implement-a"
  // Requires [-*] bullet to avoid matching prose lines containing word.digit patterns
  const unitPattern = /^\s*[-*]\s+(\w+\.\d+)\s*[:\s]\s*(\S+)\s*[—–-]?\s*(.*)/;
  for (const line of lines) {
    const m = line.match(unitPattern);
    if (m) {
      units.push({ id: m[1], type: m[2].toLowerCase(), description: m[3].trim() });
    }
  }
  return units;
}

/**
 * Validate plan structure:
 * - Every implement* unit must be followed by a review* unit (before the next implement)
 * - No two implement units in a row without review between them
 */
function validatePlanStructure(units) {
  const errors = [];
  let pendingImplement = null;

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const type = u.type;

    if (type.startsWith("implement")) {
      if (pendingImplement) {
        errors.push(
          `unit ${u.id} (${type}) follows ${pendingImplement.id} (${pendingImplement.type}) without a review unit between them`
        );
      }
      pendingImplement = u;
    } else if (type.startsWith("review")) {
      pendingImplement = null; // review clears the pending implement
    }
    // fix, spec, design, e2e-verify, accept — don't affect the implement→review chain
    // NOTE: fix units are code changes but they respond to review findings,
    // so the review→fix sequence is valid. However, fix→implement without review is caught
    // because fix does NOT clear pendingImplement. The sequence must be:
    //   implement → review → fix (ok, review happened)
    //   implement → review → fix → implement (caught: fix didn't clear pending, but review did)
    // This is correct because fix follows a review by definition.
  }

  // If plan ends with an implement unit and no review follows
  if (pendingImplement) {
    errors.push(
      `plan ends with ${pendingImplement.id} (${pendingImplement.type}) — no review unit follows`
    );
  }

  return errors;
}

// ─── init-loop ──────────────────────────────────────────────────

export function cmdInitLoop(args) {
  const dir = getFlag(args, "dir", ".harness");
  const planFile = getFlag(args, "plan", join(dir, "plan.md"));

  // 1. Plan file must exist
  if (!existsSync(planFile)) {
    console.log(JSON.stringify({
      initialized: false,
      errors: [`plan file not found: ${planFile}`],
    }));
    return;
  }

  // 2. Parse and validate plan structure
  const planText = readFileSync(planFile, "utf8");
  const units = parsePlan(planText);

  if (units.length === 0) {
    console.log(JSON.stringify({
      initialized: false,
      errors: ["no units found in plan — expected lines like 'F1.1  spec — description'"],
    }));
    return;
  }

  const structureErrors = validatePlanStructure(units);

  // Check for duplicate unit IDs
  const idCounts = {};
  for (const u of units) {
    idCounts[u.id] = (idCounts[u.id] || 0) + 1;
  }
  for (const [id, count] of Object.entries(idCounts)) {
    if (count > 1) {
      structureErrors.push(`duplicate unit ID '${id}' appears ${count} times`);
    }
  }

  // 3. Check loop-state doesn't already exist
  const statePath = join(dir, "loop-state.json");
  if (existsSync(statePath)) {
    const existing = JSON.parse(readFileSync(statePath, "utf8"));
    if (existing.status !== "pipeline_complete" && existing.status !== "terminated") {
      console.log(JSON.stringify({
        initialized: false,
        errors: ["loop-state.json already exists and is active — use next-tick to advance or delete to restart"],
      }));
      return;
    }
  }

  // 4. If structure errors exist, reject initialization
  if (structureErrors.length > 0) {
    console.log(JSON.stringify({
      initialized: false,
      errors: structureErrors,
      units: units.map(u => `${u.id}: ${u.type}`),
      hint: "every implement unit must be followed by a review unit before the next implement",
    }));
    return;
  }

  // 5. Initialize loop state with tamper-detection fields
  mkdirSync(dir, { recursive: true });
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
    // Tamper detection
    _written_by: WRITER_SIG,
    _plan_hash: planHash,
    _last_modified: new Date().toISOString(),
  };

  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  console.log(JSON.stringify({
    initialized: true,
    units: units.map(u => `${u.id}: ${u.type}`),
    first_unit: units[0].id,
    total_units: units.length,
  }));
}

// ─── complete-tick ──────────────────────────────────────────────

export function cmdCompleteTick(args) {
  const dir = getFlag(args, "dir", ".harness");
  const unit = getFlag(args, "unit");
  const artifactsRaw = getFlag(args, "artifacts", "");
  const description = getFlag(args, "description", "");
  const status = getFlag(args, "status", "completed");

  const VALID_TICK_STATUSES = new Set(["completed", "blocked", "failed"]);

  if (!unit) {
    console.error("Usage: opc-harness complete-tick --unit <id> --artifacts <comma-sep> --description <text> --dir <path>");
    process.exit(1);
  }

  // Validate status whitelist (R3 fix: arbitrary status bypassed all checks)
  if (!VALID_TICK_STATUSES.has(status)) {
    console.log(JSON.stringify({ completed: false, errors: [`invalid status '${status}' — must be one of: ${[...VALID_TICK_STATUSES].join(", ")}`] }));
    return;
  }

  const statePath = join(dir, "loop-state.json");
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ completed: false, errors: ["loop-state.json not found"] }));
    return;
  }

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const errors = [];
  const warnings = [];

  // 0. Reject if pipeline is already terminated
  if (state.status === "pipeline_complete" || state.status === "terminated") {
    console.log(JSON.stringify({ completed: false, errors: [`loop is '${state.status}' — cannot complete ticks on a terminated pipeline`] }));
    return;
  }

  // 0a. Tamper detection: check writer signature
  if (state._written_by !== WRITER_SIG) {
    warnings.push("state was not written by opc-harness — possible direct edit detected");
  }

  // 0b. Tamper detection: check plan hash integrity
  const planFile = state.plan_file || join(dir, "plan.md");
  if (state._plan_hash && existsSync(planFile)) {
    const currentPlanHash = hashContent(readFileSync(planFile, "utf8"));
    if (currentPlanHash !== state._plan_hash) {
      errors.push(`plan.md was modified after init-loop (hash ${state._plan_hash} → ${currentPlanHash}) — re-run init-loop to re-validate structure`);
    }
  }

  // 1. Unit must match current next_unit
  if (state.next_unit !== unit) {
    errors.push(`expected unit '${state.next_unit}', got '${unit}'`);
  }

  // 2. Determine unit type from plan (read ONCE, reuse for next-unit lookup)
  let unitType = "unknown";
  let allUnits = [];
  if (existsSync(planFile)) {
    allUnits = parsePlan(readFileSync(planFile, "utf8"));
    const found = allUnits.find(u => u.id === unit);
    if (found) unitType = found.type;
  }

  // 3. Validate artifacts/evidence based on unit type
  const artifacts = artifactsRaw ? artifactsRaw.split(",").map(a => a.trim()).filter(Boolean) : [];

  if (status === "completed") {
    if (unitType.startsWith("implement") || unitType.startsWith("build")) {
      // Implement units MUST have test evidence
      if (artifacts.length === 0) {
        errors.push(`implement unit '${unit}' has no artifacts — must have test evidence (test output, build output)`);
      }
      // ALL declared artifacts must exist, be non-empty, and contain test-like content
      for (const a of artifacts) {
        if (!existsSync(a)) {
          errors.push(`artifact not found: ${a}`);
        } else {
          const content = readFileSync(a, "utf8");
          if (content.trim().length === 0) {
            errors.push(`artifact is empty: ${a}`);
          } else if (a.endsWith(".json")) {
            // JSON artifacts should parse and have meaningful test fields
            try {
              const data = JSON.parse(content);
              const hasTestFields = data.tests_run != null || data.testsRun != null ||
                data.passed != null || data.failures != null || data.exitCode != null ||
                data.pass != null || data.fail != null || data.total != null;
              if (!hasTestFields) {
                warnings.push(`artifact '${a}' is JSON but has no test-result fields (tests_run, passed, failures, exitCode)`);
              }
            } catch {
              // Not valid JSON — that's ok, could be raw output
            }
          }
        }
      }
    } else if (unitType.startsWith("review")) {
      // Review units MUST have eval files with severity markers
      if (artifacts.length === 0) {
        errors.push(`review unit '${unit}' has no artifacts — must have eval-*.md files`);
      }
      for (const a of artifacts) {
        if (!existsSync(a)) {
          errors.push(`artifact not found: ${a}`);
        } else {
          const content = readFileSync(a, "utf8");
          if (content.trim().length === 0) {
            errors.push(`artifact is empty: ${a}`);
          } else if (a.endsWith(".md")) {
            // Eval markdown must contain at least one severity emoji OR explicit LGTM
            const hasSeverity = /[🔴🟡🔵]/.test(content) || /LGTM/i.test(content) ||
              /critical|warning|suggestion/i.test(content);
            if (!hasSeverity) {
              errors.push(`eval artifact '${a}' has no severity markers (🔴🟡🔵) or LGTM — review must produce structured findings`);
            }
          }
        }
      }
    } else if (unitType.startsWith("e2e") || unitType.startsWith("accept")) {
      // Verification units MUST have evidence
      if (artifacts.length === 0) {
        errors.push(`${unitType} unit '${unit}' has no artifacts — must have verification evidence`);
      }
    }
    // spec, design, fix — artifacts recommended but not required
  }

  if (errors.length > 0) {
    console.log(JSON.stringify({ completed: false, errors }));
    return;
  }

  // 4. Determine next unit (using allUnits from step 2 — single plan read)
  const currentIdx = allUnits.findIndex(u => u.id === unit);
  const nextUnit = currentIdx >= 0 && currentIdx < allUnits.length - 1
    ? allUnits[currentIdx + 1].id
    : null;

  // 5. Update state with writer signature
  state.tick = (state.tick || 0) + 1;
  state.unit = unit;
  state.description = description || `Completed unit ${unit} (${unitType})`;
  state.status = status;
  state.artifacts = artifacts;
  state.next_unit = nextUnit;
  state.review_of_previous = "";
  // Tamper detection
  state._written_by = WRITER_SIG;
  state._last_modified = new Date().toISOString();
  // Preserve plan hash from init

  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  console.log(JSON.stringify({
    completed: true,
    tick: state.tick,
    unit,
    unitType,
    next_unit: nextUnit,
    terminate: nextUnit === null,
    warnings: warnings.length > 0 ? warnings : undefined,
  }));
}

// ─── next-tick ──────────────────────────────────────────────────

export function cmdNextTick(args) {
  const dir = getFlag(args, "dir", ".harness");

  const statePath = join(dir, "loop-state.json");
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ ready: false, terminate: true, reason: "loop-state.json not found" }));
    return;
  }

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const warnings = [];

  // 0. Tamper detection: writer chain
  if (state._written_by !== WRITER_SIG) {
    warnings.push("loop-state.json was not written by opc-harness — possible direct edit");
  }

  // 1. Already terminated?
  if (state.status === "pipeline_complete" || state.status === "terminated") {
    console.log(JSON.stringify({
      ready: false,
      terminate: true,
      reason: `loop already ${state.status}`,
    }));
    return;
  }

  // 2. No next unit?
  if (!state.next_unit) {
    // Auto-terminate
    state.status = "pipeline_complete";
    state.description = `Pipeline complete at tick ${state.tick}`;
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

    console.log(JSON.stringify({
      ready: false,
      terminate: true,
      reason: "next_unit is null — pipeline complete",
      total_ticks: state.tick,
    }));
    return;
  }

  // 3. Validate next_unit exists in plan + check plan hash integrity
  const planFile = state.plan_file || join(dir, "plan.md");
  if (existsSync(planFile)) {
    const planText = readFileSync(planFile, "utf8");
    const units = parsePlan(planText);
    const unitIds = units.map(u => u.id);

    // Plan hash integrity check
    if (state._plan_hash) {
      const currentHash = hashContent(planText);
      if (currentHash !== state._plan_hash) {
        warnings.push(`plan.md modified since init-loop (hash ${state._plan_hash} → ${currentHash})`);
      }
    }

    if (!unitIds.includes(state.next_unit)) {
      // next_unit not in plan → auto-terminate
      state.status = "pipeline_complete";
      state.description = `Auto-terminated: unit '${state.next_unit}' not found in plan`;
      const badUnit = state.next_unit;
      state.next_unit = null;
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

      console.log(JSON.stringify({
        ready: false,
        terminate: true,
        reason: `next_unit '${badUnit}' not found in plan — auto-terminated`,
        total_ticks: state.tick,
      }));
      return;
    }

    // Get unit details
    const unitDetails = units.find(u => u.id === state.next_unit);

    console.log(JSON.stringify({
      ready: true,
      terminate: false,
      next_unit: state.next_unit,
      unit_type: unitDetails ? unitDetails.type : "unknown",
      unit_description: unitDetails ? unitDetails.description : "",
      tick: state.tick + 1,
      previous_unit: state.unit,
      previous_status: state.status,
      warnings: warnings.length > 0 ? warnings : undefined,
    }));
    return;
  }

  // No plan file — hard error, cannot validate
  console.log(JSON.stringify({
    ready: false,
    terminate: false,
    error: `plan file '${planFile}' not found — cannot validate next unit`,
  }));
}
