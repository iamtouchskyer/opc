// Loop reinit command: reinit-loop
// Allows decomposing a stalled unit into sub-units without losing tick history.
// Depends on: loop-helpers.mjs, util.mjs

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parsePlan, hashContent } from "./loop-helpers.mjs";
import { getFlag, resolveDir, atomicWriteSync, WRITER_SIG } from "./util.mjs";
import { createHash } from "crypto";

// ─── reinit-loop ───────────────────────────────────────────────

export function cmdReinitLoop(args) {
  const dir = resolveDir(args);
  const targetUnit = getFlag(args, "unit");
  const subUnitsRaw = getFlag(args, "sub-units");

  if (!targetUnit || !subUnitsRaw) {
    console.error('Usage: opc-harness reinit-loop --unit <stalledUnit> --sub-units "X.1: type — desc, X.2: type — desc" --dir <path>');
    process.exit(1);
  }

  const statePath = join(dir, "loop-state.json");
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ reinitialized: false, errors: ["loop-state.json not found"] }));
    return;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ reinitialized: false, errors: [`corrupt loop-state.json: ${err.message}`] }));
    return;
  }

  // Only allowed on stalled loops
  if (state.status !== "stalled") {
    console.log(JSON.stringify({
      reinitialized: false,
      errors: [`loop status is '${state.status}' — reinit-loop only works on stalled loops`],
      hint: "a loop becomes stalled when a unit fails 3 consecutive ticks or oscillates",
    }));
    return;
  }

  // Validate target unit exists in plan
  const planFile = state.plan_file || join(dir, "plan.md");
  if (!existsSync(planFile)) {
    console.log(JSON.stringify({ reinitialized: false, errors: [`plan file not found: ${planFile}`] }));
    return;
  }

  const planText = readFileSync(planFile, "utf8");
  const units = parsePlan(planText);
  const targetIdx = units.findIndex(u => u.id === targetUnit);

  if (targetIdx === -1) {
    console.log(JSON.stringify({
      reinitialized: false,
      errors: [`unit '${targetUnit}' not found in plan`],
      available_units: units.map(u => u.id),
    }));
    return;
  }

  // Parse sub-units: "X.1: implement — desc, X.2: review — desc"
  const subUnitParts = subUnitsRaw.split(",").map(s => s.trim()).filter(Boolean);
  if (subUnitParts.length < 2) {
    console.log(JSON.stringify({
      reinitialized: false,
      errors: ["need at least 2 sub-units for decomposition"],
    }));
    return;
  }

  const subUnitPattern = /^(\S+)\s*:\s*(\S+)\s*[—–-]?\s*(.*)/;
  const parsedSubUnits = [];
  const parseErrors = [];

  for (const part of subUnitParts) {
    const m = part.match(subUnitPattern);
    if (!m) {
      parseErrors.push(`cannot parse sub-unit: '${part}' — expected format: 'ID: type — description'`);
    } else {
      parsedSubUnits.push({ id: m[1], type: m[2].toLowerCase(), description: m[3].trim() });
    }
  }

  if (parseErrors.length > 0) {
    console.log(JSON.stringify({ reinitialized: false, errors: parseErrors }));
    return;
  }

  // Check for duplicate IDs with existing units (excluding the target) AND among sub-units
  const existingIds = new Set(units.filter((_, i) => i !== targetIdx).map(u => u.id));
  const subIds = new Set();
  const dupeErrors = [];
  for (const su of parsedSubUnits) {
    if (existingIds.has(su.id)) {
      dupeErrors.push(`sub-unit ID '${su.id}' conflicts with existing unit`);
    }
    if (subIds.has(su.id)) {
      dupeErrors.push(`duplicate sub-unit ID '${su.id}'`);
    }
    subIds.add(su.id);
  }
  if (dupeErrors.length > 0) {
    console.log(JSON.stringify({ reinitialized: false, errors: dupeErrors }));
    return;
  }

  // Rewrite plan: replace target unit line with sub-unit lines
  const lines = planText.split("\n");
  const unitLinePattern = /^\s*[-*]\s+(\w+\.\d+)\s*[:\s]\s*(\S+)\s*[—–-]?\s*(.*)/;
  const subLinePattern = /^\s+[-*]\s+(verify|eval)\s*:\s*(.*)/i;

  // Find the line range of the target unit (including sub-lines)
  let startLine = -1, endLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(unitLinePattern);
    if (m && m[1] === targetUnit) {
      startLine = i;
      endLine = i;
      // Include sub-lines (verify/eval)
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].match(subLinePattern)) {
          endLine = j;
        } else if (lines[j].match(unitLinePattern) || lines[j].trim() === "") {
          break;
        }
      }
      break;
    }
  }

  if (startLine === -1) {
    console.log(JSON.stringify({
      reinitialized: false,
      errors: [`could not find unit '${targetUnit}' line in plan file`],
    }));
    return;
  }

  // Build replacement lines
  const replacementLines = parsedSubUnits.map(su =>
    `- ${su.id}: ${su.type} — ${su.description}`
  );

  // Replace in plan
  const newLines = [
    ...lines.slice(0, startLine),
    ...replacementLines,
    ...lines.slice(endLine + 1),
  ];
  const newPlanText = newLines.join("\n");

  // Validate the new plan parses correctly
  const newUnits = parsePlan(newPlanText);
  if (newUnits.length === 0) {
    console.log(JSON.stringify({
      reinitialized: false,
      errors: ["plan rewrite produced no parseable units — aborting"],
    }));
    return;
  }

  // Write new plan
  atomicWriteSync(planFile, newPlanText);

  // Update state
  const newPlanHash = hashContent(newPlanText);
  state.status = "initialized";
  state.next_unit = parsedSubUnits[0].id;
  state._plan_hash = newPlanHash;
  state._written_by = WRITER_SIG;
  state._last_modified = new Date().toISOString();
  state.unit_ids = newUnits.map(u => u.id);
  state.units_total = newUnits.length;
  // Bug fix: account for already-consumed ticks in budget
  state._max_total_ticks = (state.tick || 0) + newUnits.length * 3;
  state._write_nonce = createHash("sha256")
    .update(Date.now().toString() + Math.random().toString())
    .digest("hex").slice(0, 16);

  // Bug fix: insert reinit marker in tick history to break stall detection pattern
  // Without this, next-tick's stall detector would see the old repeated unit entries
  // and immediately re-stall the loop — making reinit useless.
  if (!Array.isArray(state._tick_history)) state._tick_history = [];
  state._tick_history.push({
    unit: "__reinit__",
    tick: state.tick,
    status: "reinit",
    decomposed: targetUnit,
    sub_units: parsedSubUnits.map(su => su.id),
  });

  // tick history is PRESERVED (plus reinit marker) — not reset
  atomicWriteSync(statePath, JSON.stringify(state, null, 2) + "\n");

  console.log(JSON.stringify({
    reinitialized: true,
    decomposed_unit: targetUnit,
    sub_units: parsedSubUnits.map(su => `${su.id}: ${su.type}`),
    next_unit: parsedSubUnits[0].id,
    total_units: newUnits.length,
    ticks_preserved: state._tick_history.length,
    new_plan_hash: newPlanHash,
  }));
}
