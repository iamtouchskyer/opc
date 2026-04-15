// Loop tick completion command: complete-tick
// Depends on: loop-helpers.mjs, util.mjs

import { readFileSync, appendFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { parsePlan, hashContent, getGitHeadHash } from "./loop-helpers.mjs";
import { getFlag, resolveDir, atomicWriteSync, WRITER_SIG } from "./util.mjs";
import { checkEvalDistinctness, parseEvaluation } from "./eval-parser.mjs";

// ─── complete-tick ──────────────────────────────────────────────

export function cmdCompleteTick(args) {
  const dir = resolveDir(args);
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
  if (state.status === "pipeline_complete" || state.status === "terminated" || state.status === "stalled") {
    console.log(JSON.stringify({ completed: false, errors: [`loop is '${state.status}' — cannot complete ticks on a terminated pipeline`] }));
    return;
  }

  // Tamper: writer signature + nonce
  if (state._written_by !== WRITER_SIG || !state._write_nonce) {
    errors.push("state was not written by opc-harness — possible direct edit detected");
  }

  // Tamper: plan hash
  const planFile = state.plan_file || join(dir, "plan.md");
  if (state._plan_hash && existsSync(planFile)) {
    const currentPlanHash = hashContent(readFileSync(planFile, "utf8"));
    if (currentPlanHash !== state._plan_hash) {
      errors.push(`plan.md was modified after init-loop (hash ${state._plan_hash} \u2192 ${currentPlanHash}) — re-run init-loop`);
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

  let reviewVerdict = undefined;

  if (status === "completed") {
    // ── Rule 2+3+6: Evidence validation per unit type ──
    if (unitType.startsWith("implement") || unitType.startsWith("build")) {
      validateImplementArtifacts(unit, unitType, artifacts, errors, warnings, state);
    } else if (unitType.startsWith("review")) {
      reviewVerdict = validateReviewArtifacts(unit, artifacts, errors, warnings, state);
    } else if (unitType.startsWith("fix")) {
      validateFixArtifacts(unit, artifacts, errors, warnings, state);
    } else if (unitType.startsWith("e2e") || unitType.startsWith("accept")) {
      if (artifacts.length === 0) {
        errors.push(`${unitType} unit '${unit}' has no artifacts — must have verification evidence`);
      }
    }
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

  if (!Array.isArray(state._tick_history)) state._tick_history = [];
  state._tick_history.push({ unit, tick: newTick, status, verdict: reviewVerdict });

  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

  // Rule 14: append to progress.md
  const progressPath = join(dir, "progress.md");
  const progressLine = `- **Tick ${newTick}** [${unit}] (${unitType}): ${description || status} \u2014 ${new Date().toISOString()}\n`;
  try {
    appendFileSync(progressPath, progressLine);
  } catch {
    warnings.push("failed to append to progress.md");
  }

  console.log(JSON.stringify({
    completed: true,
    tick: newTick,
    unit,
    unitType,
    next_unit: nextUnit,
    terminate: nextUnit === null,
    verdict: reviewVerdict,
    warnings: warnings.length > 0 ? warnings : undefined,
  }));
}

// ── Validation helpers ──────────────────────────────────────────

const MAX_ARTIFACT_SIZE = 10 * 1024 * 1024; // 10 MB

function _checkArtifactSize(a, errors) {
  const sz = statSync(a).size;
  if (sz > MAX_ARTIFACT_SIZE) {
    errors.push(`artifact too large (${Math.round(sz / 1024 / 1024)}MB, max 10MB): ${a}`);
    return false;
  }
  return true;
}

function validateImplementArtifacts(unit, unitType, artifacts, errors, warnings, state) {
  if (artifacts.length === 0) {
    errors.push(`implement unit '${unit}' has no artifacts — must have test evidence`);
  }
  for (const a of artifacts) {
    if (!existsSync(a)) {
      errors.push(`artifact not found: ${a}`);
    } else if (!_checkArtifactSize(a, errors)) {
      continue;
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
          if (hasTestFields) {
            if (!data._command && !data.command) {
              warnings.push(`artifact '${a}' has no _command field — test results should record what command was executed`);
            }
            if (data.durationMs != null && data.durationMs <= 0) {
              errors.push(`artifact '${a}' has durationMs=${data.durationMs} — test runs must take positive time`);
            }
            if (data._timestamp) {
              const ts = new Date(data._timestamp).getTime();
              const now = Date.now();
              if (ts > now + 60000) {
                errors.push(`artifact '${a}' has future timestamp — evidence must be from current tick`);
              } else if (now - ts > 30 * 60 * 1000) {
                warnings.push(`artifact '${a}' timestamp is >30min old — may be stale evidence`);
              }
            }
            try {
              const fstat = statSync(a);
              const fileAge = Date.now() - fstat.mtimeMs;
              if (fileAge > 30 * 60 * 1000) {
                warnings.push(`artifact '${a}' file mtime is >30min ago — may be reused from previous run`);
              }
            } catch { /* stat fail is non-fatal */ }
          }
        } catch { /* raw output ok */ }
      }
    }
  }

  // Rule 6: UI implement needs screenshot
  if (unitType.includes("ui") || unitType.includes("frontend") || unitType.includes("fe")) {
    const hasScreenshot = artifacts.some(a => a.endsWith(".png") || a.endsWith(".jpg") || a.endsWith(".jpeg"));
    if (!hasScreenshot) {
      errors.push(`UI implement unit '${unit}' has no screenshot artifact (.png/.jpg) — UI changes require visual verification`);
    }
  }

  // Rule 3: atomic commit
  const currentHead = getGitHeadHash();
  if (currentHead && state._git_head && currentHead === state._git_head) {
    errors.push(`git HEAD unchanged since last tick — implement unit must produce a commit`);
  }

  if (state._external_validators && !state._external_validators.pre_commit_hooks) {
    warnings.push("no pre-commit hooks detected — git commit has no external quality gate (lint/typecheck/format)");
  }
}

function validateReviewArtifacts(unit, artifacts, errors, warnings, state) {
  if (artifacts.length === 0) {
    errors.push(`review unit '${unit}' has no artifacts — must have eval-*.md files`);
  }
  const evalFiles = artifacts.filter(a => a.endsWith(".md"));
  if (evalFiles.length < 2) {
    errors.push(`review unit '${unit}' has ${evalFiles.length} eval file(s) — need \u22652 for independent review (separate subagents)`);
  }
  const evalContents = [];
  for (const a of artifacts) {
    if (!existsSync(a)) {
      errors.push(`artifact not found: ${a}`);
    } else if (!_checkArtifactSize(a, errors)) {
      continue;
    } else {
      const content = readFileSync(a, "utf8");
      if (content.trim().length === 0) {
        errors.push(`artifact is empty: ${a}`);
      } else if (a.endsWith(".md")) {
        evalContents.push({ path: a, content });
        const hasSeverity = /[\ud83d\udd34\ud83d\udfe1\ud83d\udd35]/.test(content) || /LGTM/i.test(content) ||
          /critical|warning|suggestion/i.test(content);
        if (!hasSeverity) {
          errors.push(`eval '${a}' has no severity markers (\ud83d\udd34\ud83d\udfe1\ud83d\udd35) or LGTM — review must produce structured findings`);
        }
      }
    }
  }

  // Distinctness check — delegate to shared function
  if (evalContents.length >= 2) {
    const dc = checkEvalDistinctness(evalContents);
    errors.push(...dc.errors);
    warnings.push(...dc.warnings);
  }

  // Rule 5: hash eval files for tamper detection
  const evalHashes = {};
  for (const a of evalFiles) {
    if (existsSync(a)) {
      evalHashes[a] = hashContent(readFileSync(a, "utf8"));
    }
  }
  state._last_review_evals = evalHashes;

  // Synthesize verdict from eval files (reuse parseEvaluation from eval-parser)
  if (evalContents.length === 0) return undefined;

  let totalCritical = 0, totalWarning = 0, totalSuggestion = 0;
  for (const { content } of evalContents) {
    const parsed = parseEvaluation(content);
    totalCritical += parsed.critical;
    totalWarning += parsed.warning;
    totalSuggestion += parsed.suggestion;
  }

  let verdict = "PASS";
  if (totalCritical > 0) verdict = "FAIL";
  else if (totalWarning > 0) verdict = "ITERATE";

  return verdict;
}

function validateFixArtifacts(unit, artifacts, errors, warnings, state) {
  // Rule 5: verify eval file integrity from previous review
  if (state._last_review_evals && typeof state._last_review_evals === "object") {
    for (const [evalPath, expectedHash] of Object.entries(state._last_review_evals)) {
      if (existsSync(evalPath)) {
        const actualHash = hashContent(readFileSync(evalPath, "utf8"));
        if (actualHash !== expectedHash) {
          errors.push(`eval file '${evalPath}' was modified after review (hash ${expectedHash} \u2192 ${actualHash}) — review findings must not be altered before fix`);
        }
      } else {
        errors.push(`eval file '${evalPath}' from previous review was deleted — review findings must persist through fix`);
      }
    }
  }

  // Rule 17: fix must reference upstream review findings
  if (artifacts.length > 0) {
    let referencesFindings = false;
    for (const a of artifacts) {
      if (existsSync(a) && _checkArtifactSize(a, errors)) {
        const content = readFileSync(a, "utf8");
        if (/[\ud83d\udd34\ud83d\udfe1\ud83d\udd35]/.test(content) || /\w+\.\w+:\d+/.test(content)) {
          referencesFindings = true;
        }
      }
    }
    if (!referencesFindings) {
      warnings.push(`fix unit '${unit}' artifacts don't reference review findings — fixes should trace to specific \ud83d\udd34/\ud83d\udfe1 items or file:line refs`);
    }
  }

  // Rule 3: fix should also commit
  const currentHead = getGitHeadHash();
  if (currentHead && state._git_head && currentHead === state._git_head) {
    errors.push(`git HEAD unchanged — fix unit must produce a commit`);
  }
}
