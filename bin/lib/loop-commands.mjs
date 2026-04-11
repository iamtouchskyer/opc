// Loop state management commands: init-loop, complete-tick, next-tick
// Tamper-detecting guardrails for OPC Layer 2 (loop protocol)
//
// Coverage target: ALL 16 rules from loop-protocol.md should have code participation.
// Threat model: LLM agent is forgetful/lazy, not adversarial.
//
// Rules enforced:
//  1. implement→review chain          (init-loop: structure validation)
//  2. verifiable output per unit       (complete-tick: artifact content checks)
//  3. atomic commit per unit           (complete-tick: git HEAD check)
//  4. review independence (≥2 evals)   (complete-tick: review needs ≥2 distinct eval files)
//  5. eval file integrity              (complete-tick: eval hash lock after dispatch)
//  6. UI changes need screenshot       (complete-tick: ui-implement needs .png artifact)
//  7. blocked ≠ completed              (complete-tick: status whitelist)
//  8. stall detection (2 same unit)    (next-tick: consecutive same-unit check)
//  9. 3-tick stall → stop              (next-tick: hard stop after 3)
// 10. auto-termination                 (next-tick: null/missing next_unit)
// 11. cron termination signal          (next-tick: returns terminate + cron hint)
// 12. 🟡 → backlog.md                  (transition: backlog enforcement in flow-commands.mjs)
// 13. backlog surfaced at end          (next-tick: terminate checks backlog exists)
// 14. progress.md append per tick      (complete-tick: appends to progress.md)
// 15/16. review ≠ self-review          (= rule 4, ≥2 distinct eval files)
// 17. fix must reference findings      (complete-tick: fix artifacts must mention upstream review)
// 18. plan in .harness/plan.md         (init-loop: plan file validation)

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";

function getFlag(args, name, fallback = null) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] != null ? args[idx + 1] : fallback;
}

const WRITER_SIG = "opc-harness";

function hashContent(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function atomicWriteSync(filePath, data) {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

// ─── plan validation helpers ────────────────────────────────────

function parsePlan(planText) {
  const units = [];
  const lines = planText.split("\n");
  const unitPattern = /^\s*[-*]\s+(\w+\.\d+)\s*[:\s]\s*(\S+)\s*[—–-]?\s*(.*)/;
  for (const line of lines) {
    const m = line.match(unitPattern);
    if (m) {
      units.push({ id: m[1], type: m[2].toLowerCase(), description: m[3].trim() });
    }
  }
  return units;
}

function validatePlanStructure(units) {
  const errors = [];
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
    // fix, spec, design, e2e-verify, accept — don't clear pendingImplement
  }

  if (pendingImplement) {
    errors.push(
      `plan ends with ${pendingImplement.id} (${pendingImplement.type}) — no review unit follows`
    );
  }

  return errors;
}

// ─── git helpers ────────────────────────────────────────────────

function getGitHeadHash() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

// ─── init-loop ──────────────────────────────────────────────────

export function cmdInitLoop(args) {
  const dir = getFlag(args, "dir", ".harness");
  const planFile = getFlag(args, "plan", join(dir, "plan.md"));

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
    _written_by: WRITER_SIG,
    _plan_hash: planHash,
    _last_modified: new Date().toISOString(),
    _git_head: getGitHeadHash(),
    _tick_history: [],  // for stall detection: [{unit, tick}]
    _max_total_ticks: units.length * 3,  // 3x unit count as safety cap
    _started_at: new Date().toISOString(),
    _max_duration_hours: 24,  // wall-clock deadline
  };

  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

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

  if (!VALID_TICK_STATUSES.has(status)) {
    console.log(JSON.stringify({ completed: false, errors: [`invalid status '${status}' — must be one of: ${[...VALID_TICK_STATUSES].join(", ")}`] }));
    return;
  }

  if (status === "blocked" && (!description || description.trim().length === 0)) {
    console.log(JSON.stringify({ completed: false, errors: ["blocked status requires --description explaining the blocker"] }));
    return;
  }

  const statePath = join(dir, "loop-state.json");
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ completed: false, errors: ["loop-state.json not found"] }));
    return;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ completed: false, errors: [`corrupt loop-state.json: ${err.message}`] }));
    return;
  }
  const errors = [];
  const warnings = [];

  // Rule 7: terminated pipeline
  if (state.status === "pipeline_complete" || state.status === "terminated") {
    console.log(JSON.stringify({ completed: false, errors: [`loop is '${state.status}' — cannot complete ticks on a terminated pipeline`] }));
    return;
  }

  // Tamper: writer signature
  if (state._written_by !== WRITER_SIG) {
    warnings.push("state was not written by opc-harness — possible direct edit detected");
  }

  // Tamper: plan hash
  const planFile = state.plan_file || join(dir, "plan.md");
  if (state._plan_hash && existsSync(planFile)) {
    const currentPlanHash = hashContent(readFileSync(planFile, "utf8"));
    if (currentPlanHash !== state._plan_hash) {
      errors.push(`plan.md was modified after init-loop (hash ${state._plan_hash} → ${currentPlanHash}) — re-run init-loop`);
    }
  }

  // Unit sequence
  if (state.next_unit !== unit) {
    errors.push(`expected unit '${state.next_unit}', got '${unit}'`);
  }

  // Determine unit type
  let unitType = "unknown";
  let allUnits = [];
  if (existsSync(planFile)) {
    allUnits = parsePlan(readFileSync(planFile, "utf8"));
    const found = allUnits.find(u => u.id === unit);
    if (found) unitType = found.type;
  }

  const artifacts = artifactsRaw ? artifactsRaw.split(",").map(a => a.trim()).filter(Boolean) : [];

  if (status === "completed") {
    // ── Rule 2+3+6: Evidence validation per unit type ──

    if (unitType.startsWith("implement") || unitType.startsWith("build")) {
      // Rule 2: implement needs test evidence
      if (artifacts.length === 0) {
        errors.push(`implement unit '${unit}' has no artifacts — must have test evidence`);
      }
      for (const a of artifacts) {
        if (!existsSync(a)) {
          errors.push(`artifact not found: ${a}`);
        } else {
          const content = readFileSync(a, "utf8");
          if (content.trim().length === 0) {
            errors.push(`artifact is empty: ${a}`);
          } else if (a.endsWith(".json")) {
            try {
              const data = JSON.parse(content);
              const hasTestFields = data.tests_run != null || data.testsRun != null ||
                data.passed != null || data.failures != null || data.exitCode != null ||
                data.pass != null || data.fail != null || data.total != null;
              if (!hasTestFields) {
                warnings.push(`artifact '${a}' is JSON but has no test-result fields`);
              }
            } catch { /* raw output ok */ }
          }
        }
      }

      // Rule 6: UI implement needs screenshot (HARD ERROR)
      if (unitType.includes("ui") || unitType.includes("frontend") || unitType.includes("fe")) {
        const hasScreenshot = artifacts.some(a => a.endsWith(".png") || a.endsWith(".jpg") || a.endsWith(".jpeg"));
        if (!hasScreenshot) {
          errors.push(`UI implement unit '${unit}' has no screenshot artifact (.png/.jpg) — UI changes require visual verification`);
        }
      }

      // Rule 3: atomic commit — git HEAD must have changed since last tick (HARD ERROR)
      const currentHead = getGitHeadHash();
      if (currentHead && state._git_head && currentHead === state._git_head) {
        errors.push(`git HEAD unchanged since last tick — implement unit must produce a commit`);
      }

    } else if (unitType.startsWith("review")) {
      // Rule 4/15/16: review independence — need ≥2 DISTINCT eval files
      if (artifacts.length === 0) {
        errors.push(`review unit '${unit}' has no artifacts — must have eval-*.md files`);
      }
      const evalFiles = artifacts.filter(a => a.endsWith(".md"));
      if (evalFiles.length < 2) {
        errors.push(`review unit '${unit}' has ${evalFiles.length} eval file(s) — need ≥2 for independent review (separate subagents)`);
      }
      for (const a of artifacts) {
        if (!existsSync(a)) {
          errors.push(`artifact not found: ${a}`);
        } else {
          const content = readFileSync(a, "utf8");
          if (content.trim().length === 0) {
            errors.push(`artifact is empty: ${a}`);
          } else if (a.endsWith(".md")) {
            // Rule 2: eval must have severity markers
            const hasSeverity = /[🔴🟡🔵]/.test(content) || /LGTM/i.test(content) ||
              /critical|warning|suggestion/i.test(content);
            if (!hasSeverity) {
              errors.push(`eval '${a}' has no severity markers (🔴🟡🔵) or LGTM — review must produce structured findings`);
            }
          }
        }
      }

      // Rule 5: hash eval files for tamper detection downstream
      const evalHashes = {};
      for (const a of evalFiles) {
        if (existsSync(a)) {
          evalHashes[a] = hashContent(readFileSync(a, "utf8"));
        }
      }
      // Store in state for fix-unit cross-reference
      state._last_review_evals = evalHashes;

    } else if (unitType.startsWith("fix")) {
      // Rule 5: verify eval file integrity from previous review
      if (state._last_review_evals && typeof state._last_review_evals === "object") {
        for (const [evalPath, expectedHash] of Object.entries(state._last_review_evals)) {
          if (existsSync(evalPath)) {
            const actualHash = hashContent(readFileSync(evalPath, "utf8"));
            if (actualHash !== expectedHash) {
              errors.push(`eval file '${evalPath}' was modified after review (hash ${expectedHash} → ${actualHash}) — review findings must not be altered before fix`);
            }
          } else {
            errors.push(`eval file '${evalPath}' from previous review was deleted — review findings must persist through fix`);
          }
        }
      }

      // Rule 17: fix must reference upstream review findings
      // Require severity emoji (🔴🟡🔵) OR file:line pattern — NOT just generic words
      if (artifacts.length > 0) {
        let referencesFindings = false;
        for (const a of artifacts) {
          if (existsSync(a)) {
            const content = readFileSync(a, "utf8");
            // Fix artifacts should reference severity emojis or specific file.ext:linenum from review
            if (/[🔴🟡🔵]/.test(content) || /\w+\.\w+:\d+/.test(content)) {
              referencesFindings = true;
            }
          }
        }
        if (!referencesFindings) {
          warnings.push(`fix unit '${unit}' artifacts don't reference review findings — fixes should trace to specific 🔴/🟡 items or file:line refs`);
        }
      }

      // Rule 3: fix should also commit (HARD ERROR)
      const currentHead = getGitHeadHash();
      if (currentHead && state._git_head && currentHead === state._git_head) {
        errors.push(`git HEAD unchanged — fix unit must produce a commit`);
      }

    } else if (unitType.startsWith("e2e") || unitType.startsWith("accept")) {
      // Rule 2: verification needs evidence
      if (artifacts.length === 0) {
        errors.push(`${unitType} unit '${unit}' has no artifacts — must have verification evidence`);
      }
    }
    // spec, design — artifacts recommended but not required
  }

  if (errors.length > 0) {
    console.log(JSON.stringify({ completed: false, errors, warnings: warnings.length > 0 ? warnings : undefined }));
    return;
  }

  // Only advance to next unit on successful completion
  let nextUnit = null;
  if (status === "completed") {
    const currentIdx = allUnits.findIndex(u => u.id === unit);
    nextUnit = currentIdx >= 0 && currentIdx < allUnits.length - 1
      ? allUnits[currentIdx + 1].id
      : null;
  } else {
    // blocked/failed: stay on current unit (retry next tick)
    nextUnit = unit;
  }

  // Update state
  const newTick = (state.tick || 0) + 1;
  state.tick = newTick;
  state.unit = unit;
  state.description = description || `Completed unit ${unit} (${unitType})`;
  state.status = status;
  state.artifacts = artifacts;
  state.next_unit = nextUnit;
  state.review_of_previous = "";
  state._written_by = WRITER_SIG;
  state._last_modified = new Date().toISOString();
  state._git_head = getGitHeadHash();

  // Rule 8/9: stall detection history
  if (!Array.isArray(state._tick_history)) state._tick_history = [];
  state._tick_history.push({ unit, tick: newTick, status });

  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

  // Rule 14: append to progress.md
  const progressPath = join(dir, "progress.md");
  const progressLine = `- **Tick ${newTick}** [${unit}] (${unitType}): ${description || status} — ${new Date().toISOString()}\n`;
  try {
    appendFileSync(progressPath, progressLine);
  } catch {
    // progress.md write failed — non-blocking
    warnings.push("failed to append to progress.md");
  }

  console.log(JSON.stringify({
    completed: true,
    tick: newTick,
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

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ ready: false, terminate: true, reason: `corrupt loop-state.json: ${err.message}` }));
    return;
  }
  const warnings = [];

  // Tamper: writer chain
  if (state._written_by !== WRITER_SIG) {
    warnings.push("loop-state.json was not written by opc-harness — possible direct edit");
  }

  // Already terminated
  if (state.status === "pipeline_complete" || state.status === "terminated") {
    console.log(JSON.stringify({
      ready: false,
      terminate: true,
      reason: `loop already ${state.status}`,
    }));
    return;
  }

  // Rule 8/9: Stall detection
  const history = state._tick_history || [];
  if (history.length >= 2) {
    const last2 = history.slice(-2);
    if (last2[0].unit === last2[1].unit) {
      warnings.push(`stall detected: unit '${last2[0].unit}' completed in 2 consecutive ticks`);

      if (history.length >= 3) {
        const last3 = history.slice(-3);
        if (last3[0].unit === last3[1].unit && last3[1].unit === last3[2].unit) {
          // Rule 9: hard stop after 3 consecutive same unit
          state.status = "stalled";
          state.description = `Stalled on unit '${last3[0].unit}' for 3 consecutive ticks`;
          state._written_by = WRITER_SIG;
          state._last_modified = new Date().toISOString();
          atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

          console.log(JSON.stringify({
            ready: false,
            terminate: true,
            reason: `⛔ stalled on unit '${last3[0].unit}' for 3 ticks — needs human input`,
            stalled_unit: last3[0].unit,
          }));
          return;
        }
      }
    }
  }

  // Oscillation detection: A↔B pattern over last 4 ticks
  if (history.length >= 4) {
    const last4 = history.slice(-4);
    if (last4[0].unit === last4[2].unit && last4[1].unit === last4[3].unit && last4[0].unit !== last4[1].unit) {
      warnings.push(`oscillation detected: '${last4[0].unit}' ↔ '${last4[1].unit}' repeating for 4 ticks`);

      if (history.length >= 6) {
        const last6 = history.slice(-6);
        if (last6[0].unit === last6[2].unit && last6[2].unit === last6[4].unit &&
            last6[1].unit === last6[3].unit && last6[3].unit === last6[5].unit) {
          state.status = "stalled";
          state.description = `Oscillation stall: '${last6[0].unit}' ↔ '${last6[1].unit}' for 6 ticks`;
          state._written_by = WRITER_SIG;
          state._last_modified = new Date().toISOString();
          atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

          console.log(JSON.stringify({
            ready: false,
            terminate: true,
            reason: `⛔ oscillation stall: '${last6[0].unit}' ↔ '${last6[1].unit}' for 6 ticks — needs human input`,
            stalled_units: [last6[0].unit, last6[1].unit],
          }));
          return;
        }
      }
    }
  }

  // Total tick limit
  const maxTicks = state._max_total_ticks || Infinity;
  if (state.tick >= maxTicks) {
    state.status = "terminated";
    state.description = `maxTotalTicks (${maxTicks}) reached at tick ${state.tick}`;
    state._written_by = WRITER_SIG;
    state._last_modified = new Date().toISOString();
    atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

    console.log(JSON.stringify({
      ready: false,
      terminate: true,
      reason: `maxTotalTicks (${maxTicks}) reached`,
      total_ticks: state.tick,
    }));
    return;
  }

  // Wall-clock deadline
  if (state._started_at && state._max_duration_hours) {
    const elapsed = (Date.now() - new Date(state._started_at).getTime()) / (1000 * 60 * 60);
    if (elapsed >= state._max_duration_hours) {
      state.status = "terminated";
      state.description = `Wall-clock deadline (${state._max_duration_hours}h) reached after ${elapsed.toFixed(1)}h`;
      state._written_by = WRITER_SIG;
      state._last_modified = new Date().toISOString();
      atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

      console.log(JSON.stringify({
        ready: false,
        terminate: true,
        reason: `wall-clock deadline (${state._max_duration_hours}h) reached after ${elapsed.toFixed(1)}h`,
        elapsed_hours: parseFloat(elapsed.toFixed(1)),
      }));
      return;
    }
  }

  // No next unit → terminate
  if (!state.next_unit) {
    state.status = "pipeline_complete";
    state.description = `Pipeline complete at tick ${state.tick}`;
    state._written_by = WRITER_SIG;
    state._last_modified = new Date().toISOString();
    atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

    // Rule 13: surface backlog at termination
    const backlogPath = join(dir, "backlog.md");
    const backlogExists = existsSync(backlogPath);
    let backlogSummary = null;
    if (backlogExists) {
      const backlogText = readFileSync(backlogPath, "utf8");
      const openItems = (backlogText.match(/^- \[ \]/gm) || []).length;
      backlogSummary = { file: backlogPath, open_items: openItems };
    }

    console.log(JSON.stringify({
      ready: false,
      terminate: true,
      reason: "next_unit is null — pipeline complete",
      total_ticks: state.tick,
      backlog: backlogSummary,
      hint: backlogSummary && backlogSummary.open_items > 0
        ? `⚠️ ${backlogSummary.open_items} open backlog items — review before closing`
        : undefined,
    }));
    return;
  }

  // Validate next_unit in plan + plan hash
  const planFile = state.plan_file || join(dir, "plan.md");
  if (existsSync(planFile)) {
    const planText = readFileSync(planFile, "utf8");
    const units = parsePlan(planText);
    const unitIds = units.map(u => u.id);

    // Plan hash integrity
    if (state._plan_hash) {
      const currentHash = hashContent(planText);
      if (currentHash !== state._plan_hash) {
        warnings.push(`plan.md modified since init-loop (hash ${state._plan_hash} → ${currentHash})`);
      }
    }

    if (!unitIds.includes(state.next_unit)) {
      state.status = "pipeline_complete";
      state.description = `Auto-terminated: unit '${state.next_unit}' not found in plan`;
      const badUnit = state.next_unit;
      state.next_unit = null;
      state._written_by = WRITER_SIG;
      state._last_modified = new Date().toISOString();
      atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

      console.log(JSON.stringify({
        ready: false,
        terminate: true,
        reason: `next_unit '${badUnit}' not found in plan — auto-terminated`,
        total_ticks: state.tick,
      }));
      return;
    }

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

  // No plan file — hard error
  console.log(JSON.stringify({
    ready: false,
    terminate: false,
    error: `plan file '${planFile}' not found — cannot validate next unit`,
  }));
}
