// Flow graph definitions — nodes, edges, limits per template
// Built-in templates + external flow loading from ~/.claude/flows/ (deprecated) + --flow-file

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, dirname, isAbsolute, resolve, relative } from "path";
import { homedir } from "os";
import { VALID_NODE_TYPES, getFlag } from "./util.mjs";

// Harness version — used for opc_compat checking
export const HARNESS_VERSION = "0.8.0";

export const FLOW_TEMPLATES = {
  "legacy-linear": {
    nodes: ["design", "plan", "build", "evaluate", "deliver"],
    edges: {
      design:   { PASS: "plan" },
      plan:     { PASS: "build" },
      build:    { PASS: "evaluate" },
      evaluate: { PASS: "deliver", FAIL: "build", ITERATE: "build" },
      deliver:  { PASS: null },
    },
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 20, maxNodeReentry: 5 },
    nodeTypes: { design: "discussion", plan: "build", build: "build", evaluate: "review", deliver: "execute" },
  },
  "review": {
    nodes: ["review", "gate"],
    edges: {
      review: { PASS: "gate" },
      gate:   { PASS: null, FAIL: "review", ITERATE: "review" },
    },
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
    nodeTypes: { review: "review", gate: "gate" },
  },
  "build-verify": {
    nodes: ["build", "code-review", "test-design", "test-execute", "gate"],
    edges: {
      build:           { PASS: "code-review" },
      "code-review":   { PASS: "test-design" },
      "test-design":   { PASS: "test-execute" },
      "test-execute":  { PASS: "gate" },
      gate:            { PASS: null, FAIL: "build", ITERATE: "build" },
    },
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 25, maxNodeReentry: 5 },
    nodeTypes: { build: "build", "code-review": "review", "test-design": "review", "test-execute": "execute", gate: "gate" },
  },
  "full-stack": {
    nodes: [
      "discuss", "build", "code-review", "test-design", "test-execute", "gate-test",
      "acceptance", "gate-acceptance",
      "audit", "gate-audit",
      "e2e-user", "gate-e2e",
      "post-launch-sim", "gate-final",
    ],
    edges: {
      discuss:             { PASS: "build" },
      build:               { PASS: "code-review" },
      "code-review":       { PASS: "test-design" },
      "test-design":       { PASS: "test-execute" },
      "test-execute":      { PASS: "gate-test" },
      "gate-test":         { PASS: "acceptance", FAIL: "build", ITERATE: "build" },
      acceptance:          { PASS: "gate-acceptance" },
      "gate-acceptance":   { PASS: "audit", FAIL: "build", ITERATE: "acceptance" },
      audit:               { PASS: "gate-audit" },
      "gate-audit":        { PASS: "e2e-user", FAIL: "build", ITERATE: "audit" },
      "e2e-user":          { PASS: "gate-e2e" },
      "gate-e2e":          { PASS: "post-launch-sim", FAIL: "build", ITERATE: "e2e-user" },
      "post-launch-sim":   { PASS: "gate-final" },
      "gate-final":        { PASS: null, FAIL: "build", ITERATE: "discuss" },
    },
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 35, maxNodeReentry: 5 },
    nodeTypes: {
      discuss: "discussion", build: "build", "code-review": "review",
      "test-design": "review", "test-execute": "execute",
      "gate-test": "gate", acceptance: "review", "gate-acceptance": "gate",
      audit: "review", "gate-audit": "gate", "e2e-user": "execute", "gate-e2e": "gate",
      "post-launch-sim": "execute", "gate-final": "gate",
    },
  },
  "pre-release": {
    nodes: ["acceptance", "gate-acceptance", "audit", "gate-audit", "e2e-user", "gate-e2e"],
    edges: {
      acceptance:          { PASS: "gate-acceptance" },
      "gate-acceptance":   { PASS: "audit", FAIL: "acceptance", ITERATE: "acceptance" },
      audit:               { PASS: "gate-audit" },
      "gate-audit":        { PASS: "e2e-user", FAIL: "acceptance", ITERATE: "acceptance" },
      "e2e-user":          { PASS: "gate-e2e" },
      "gate-e2e":          { PASS: null, FAIL: "acceptance", ITERATE: "acceptance" },
    },
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 20, maxNodeReentry: 5 },
    nodeTypes: {
      acceptance: "review", "gate-acceptance": "gate",
      audit: "review", "gate-audit": "gate",
      "e2e-user": "execute", "gate-e2e": "gate",
    },
  },
};

// ── External flow template loading ──
// Scans ~/.claude/flows/*.json and merges into FLOW_TEMPLATES.
// Built-in templates take precedence (external cannot override).

// Simple semver-range check: supports ">=X.Y" format only (good enough for opc_compat)
function satisfiesVersion(range, version) {
  if (!range || !version) return true; // missing = no constraint
  const m = range.match(/^>=(\d+)\.(\d+)/);
  if (!m) { console.error(`⚠️  malformed opc_compat range: '${range}' — rejecting`); return false; }
  const rMaj = parseInt(m[1], 10);
  const rMin = parseInt(m[2], 10);
  const v = version.match(/^(\d+)\.(\d+)/);
  if (!v) return true;
  const vMaj = parseInt(v[1], 10);
  const vMin = parseInt(v[2], 10);
  return vMaj > rMaj || (vMaj === rMaj && vMin >= rMin);
}

function loadExternalFlows() {
  const flowDir = join(homedir(), ".claude", "flows");
  try {
    if (!existsSync(flowDir)) return;
    const files = readdirSync(flowDir).filter((f) => f.endsWith(".json"));
    if (files.length > 0) {
      console.error(`⚠️  ~/.claude/flows/ is deprecated — use --flow-file instead. Found: ${files.join(", ")}`);
    }
    for (const f of files) {
      const name = f.replace(/\.json$/, "");
      if (Object.hasOwn(FLOW_TEMPLATES, name)) continue; // built-in takes precedence
      // Guard against prototype pollution
      if (name === "__proto__" || name === "constructor" || name === "prototype") continue;
      try {
        const data = JSON.parse(readFileSync(join(flowDir, f), "utf8"));
        // Validate required fields
        if (!Array.isArray(data.nodes) || data.nodes.length === 0 || !data.edges || !data.limits) {
          console.error(`⚠️  Skipping ${f}: missing or empty nodes/edges/limits`);
          continue;
        }
        // Validate edges reference valid nodes
        let valid = true;
        for (const [src, dests] of Object.entries(data.edges)) {
          if (!data.nodes.includes(src)) {
            console.error(`⚠️  Skipping ${f}: edge source '${src}' not in nodes`);
            valid = false;
            break;
          }
          for (const [, target] of Object.entries(dests)) {
            if (target !== null && !data.nodes.includes(target)) {
              console.error(`⚠️  Skipping ${f}: edge target '${target}' not in nodes`);
              valid = false;
              break;
            }
          }
          if (!valid) break;
        }
        if (!valid) continue;
        // Validate nodeTypes values if present
        if (data.nodeTypes) {
          for (const [node, type] of Object.entries(data.nodeTypes)) {
            if (!data.nodes.includes(node)) {
              console.error(`⚠️  Skipping ${f}: nodeTypes key '${node}' not in nodes array`);
              valid = false;
              break;
            }
            if (!VALID_NODE_TYPES.has(type)) {
              console.error(`⚠️  Skipping ${f}: nodeType '${type}' for '${node}' is invalid`);
              valid = false;
              break;
            }
          }
          if (!valid) continue;
        }
        // Validate contextSchema if present
        if (data.contextSchema) {
          if (typeof data.contextSchema !== "object" || Array.isArray(data.contextSchema)) {
            console.error(`⚠️  Skipping ${f}: contextSchema must be an object`);
            continue;
          }
          const validRules = new Set(["non-empty-string", "non-empty-array", "non-empty-object", "positive-integer"]);
          let schemaValid = true;
          for (const [schemaNode, nodeSchema] of Object.entries(data.contextSchema)) {
            if (!data.nodes.includes(schemaNode)) {
              console.error(`⚠️  Skipping ${f}: contextSchema key '${schemaNode}' not in nodes array`);
              schemaValid = false;
              break;
            }
            if (nodeSchema.required !== undefined) {
              if (!Array.isArray(nodeSchema.required) || !nodeSchema.required.every((r) => typeof r === "string")) {
                console.error(`⚠️  Skipping ${f}: contextSchema['${schemaNode}'].required must be an array of strings`);
                schemaValid = false;
                break;
              }
            }
            if (nodeSchema.rules !== undefined) {
              if (typeof nodeSchema.rules !== "object" || Array.isArray(nodeSchema.rules)) {
                console.error(`⚠️  Skipping ${f}: contextSchema['${schemaNode}'].rules must be an object`);
                schemaValid = false;
                break;
              }
              for (const [field, ruleName] of Object.entries(nodeSchema.rules)) {
                if (!validRules.has(ruleName)) {
                  console.error(`⚠️  Skipping ${f}: contextSchema['${schemaNode}'].rules['${field}'] has invalid rule '${ruleName}'`);
                  schemaValid = false;
                  break;
                }
              }
              if (!schemaValid) break;
            }
          }
          if (!schemaValid) continue;
        }
        // Validate unitHandlers if present
        if (data.unitHandlers) {
          if (typeof data.unitHandlers !== "object" || Array.isArray(data.unitHandlers)) {
            console.error(`⚠️  Skipping ${f}: unitHandlers must be an object`);
            continue;
          }
          let uhValid = true;
          for (const [unitType, handler] of Object.entries(data.unitHandlers)) {
            if (typeof handler !== "object" || handler === null || Array.isArray(handler)) {
              console.error(`⚠️  Skipping ${f}: unitHandlers['${unitType}'] must be an object`);
              uhValid = false;
              break;
            }
            if (!handler.skill && !handler.command) {
              console.error(`⚠️  Skipping ${f}: unitHandlers['${unitType}'] must have 'skill' or 'command'`);
              uhValid = false;
              break;
            }
            if (handler.skill && handler.command) {
              console.error(`⚠️  Skipping ${f}: unitHandlers['${unitType}'] has both 'skill' and 'command' — pick one`);
              uhValid = false;
              break;
            }
          }
          if (!uhValid) continue;
        }
        // Validate rolesDir / protocolDir if present (must be strings)
        if (data.rolesDir !== undefined && typeof data.rolesDir !== "string") {
          console.error(`⚠️  Skipping ${f}: rolesDir must be a string`);
          continue;
        }
        if (data.protocolDir !== undefined && typeof data.protocolDir !== "string") {
          console.error(`⚠️  Skipping ${f}: protocolDir must be a string`);
          continue;
        }
        // Resolve rolesDir / protocolDir relative to flow JSON file (with path safety)
        if (data.rolesDir) {
          const rdErr = validateRelativePath(data.rolesDir, flowDir, "rolesDir");
          if (rdErr) { console.error(`⚠️  Skipping ${f}: ${rdErr}`); continue; }
          data._resolvedRolesDir = resolve(flowDir, data.rolesDir);
        }
        if (data.protocolDir) {
          const pdErr = validateRelativePath(data.protocolDir, flowDir, "protocolDir");
          if (pdErr) { console.error(`⚠️  Skipping ${f}: ${pdErr}`); continue; }
          data._resolvedProtocolDir = resolve(flowDir, data.protocolDir);
        }
        // Check opc_compat version constraint
        if (data.opc_compat && !satisfiesVersion(data.opc_compat, HARNESS_VERSION)) {
          console.error(`⚠️  Skipping ${f}: requires opc_compat ${data.opc_compat} but harness is ${HARNESS_VERSION}`);
          continue;
        }
        FLOW_TEMPLATES[name] = data;
      } catch (e) {
        console.error(`⚠️  Skipping ${f}: ${e.message}`);
      }
    }
  } catch {
    // ~/.claude/flows/ doesn't exist or not readable — that's fine
  }
}

loadExternalFlows();

// ── Load a single flow from an explicit file path ──
// Used by --flow-file. Runs the same validation as loadExternalFlows().
// Returns { name, template } on success, { error } on failure.

export function loadFlowFromFile(filePath) {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    return { error: `flow file not found: ${absPath}` };
  }

  let data;
  try {
    data = JSON.parse(readFileSync(absPath, "utf8"));
  } catch (e) {
    return { error: `cannot parse flow file: ${e.message}` };
  }

  const flowDir = dirname(absPath);
  const name = absPath.split("/").pop().replace(/\.json$/, "");

  // Guard against prototype pollution
  if (name === "__proto__" || name === "constructor" || name === "prototype") {
    return { error: `invalid flow name: '${name}'` };
  }

  // Validate required fields
  if (!Array.isArray(data.nodes) || data.nodes.length === 0 || !data.edges || !data.limits) {
    return { error: "missing or empty nodes/edges/limits" };
  }

  // Validate edges reference valid nodes
  for (const [src, dests] of Object.entries(data.edges)) {
    if (!data.nodes.includes(src)) {
      return { error: `edge source '${src}' not in nodes` };
    }
    for (const [, target] of Object.entries(dests)) {
      if (target !== null && !data.nodes.includes(target)) {
        return { error: `edge target '${target}' not in nodes` };
      }
    }
  }

  // Validate nodeTypes values if present
  if (data.nodeTypes) {
    for (const [node, type] of Object.entries(data.nodeTypes)) {
      if (!data.nodes.includes(node)) {
        return { error: `nodeTypes key '${node}' not in nodes array` };
      }
      if (!VALID_NODE_TYPES.has(type)) {
        return { error: `nodeType '${type}' for '${node}' is invalid` };
      }
    }
  }

  // Validate contextSchema if present
  if (data.contextSchema) {
    const csErr = validateContextSchema(data);
    if (csErr) return { error: csErr };
  }

  // Validate unitHandlers if present
  if (data.unitHandlers) {
    const uhErr = validateUnitHandlers(data);
    if (uhErr) return { error: uhErr };
  }

  // Validate and resolve rolesDir / protocolDir
  if (data.rolesDir !== undefined) {
    if (typeof data.rolesDir !== "string") return { error: "rolesDir must be a string" };
    const rdErr = validateRelativePath(data.rolesDir, flowDir, "rolesDir");
    if (rdErr) return { error: rdErr };
    data._resolvedRolesDir = resolve(flowDir, data.rolesDir);
  }
  if (data.protocolDir !== undefined) {
    if (typeof data.protocolDir !== "string") return { error: "protocolDir must be a string" };
    const pdErr = validateRelativePath(data.protocolDir, flowDir, "protocolDir");
    if (pdErr) return { error: pdErr };
    data._resolvedProtocolDir = resolve(flowDir, data.protocolDir);
  }

  // Check opc_compat version constraint (REQUIRED field)
  if (!data.opc_compat) {
    return { error: "missing required field: opc_compat" };
  }
  if (!satisfiesVersion(data.opc_compat, HARNESS_VERSION)) {
    return { error: `requires opc_compat ${data.opc_compat} but harness is ${HARNESS_VERSION}` };
  }

  // Guard: --flow-file cannot override built-in template names
  const BUILTIN_NAMES = new Set(["review", "build-verify", "full-stack", "pre-release", "legacy-linear"]);
  if (BUILTIN_NAMES.has(name)) {
    return { error: `cannot override built-in template '${name}' via --flow-file — use a different name` };
  }

  // Store the absolute source path for state persistence
  data._source_file = absPath;

  // Inject into FLOW_TEMPLATES so downstream code works unchanged
  FLOW_TEMPLATES[name] = data;

  return { name, template: data };
}

// ── Path security: reject absolute paths and parent-escaping relative paths ──

function validateRelativePath(relPath, baseDir, fieldName) {
  if (isAbsolute(relPath)) {
    return `${fieldName} must be a relative path, got absolute: '${relPath}'`;
  }
  const resolved = resolve(baseDir, relPath);
  const rel = relative(baseDir, resolved);
  if (rel.startsWith("..")) {
    return `${fieldName} escapes flow directory: '${relPath}' resolves to '${resolved}' which is outside '${baseDir}'`;
  }
  return null; // OK
}

// ── Shared validation helpers (used by both loadExternalFlows and loadFlowFromFile) ──

function validateContextSchema(data) {
  if (typeof data.contextSchema !== "object" || Array.isArray(data.contextSchema)) {
    return "contextSchema must be an object";
  }
  const validRules = new Set(["non-empty-string", "non-empty-array", "non-empty-object", "positive-integer"]);
  for (const [schemaNode, nodeSchema] of Object.entries(data.contextSchema)) {
    if (!data.nodes.includes(schemaNode)) {
      return `contextSchema key '${schemaNode}' not in nodes array`;
    }
    if (nodeSchema.required !== undefined) {
      if (!Array.isArray(nodeSchema.required) || !nodeSchema.required.every((r) => typeof r === "string")) {
        return `contextSchema['${schemaNode}'].required must be an array of strings`;
      }
    }
    if (nodeSchema.rules !== undefined) {
      if (typeof nodeSchema.rules !== "object" || Array.isArray(nodeSchema.rules)) {
        return `contextSchema['${schemaNode}'].rules must be an object`;
      }
      for (const [field, ruleName] of Object.entries(nodeSchema.rules)) {
        if (!validRules.has(ruleName)) {
          return `contextSchema['${schemaNode}'].rules['${field}'] has invalid rule '${ruleName}'`;
        }
      }
    }
  }
  return null;
}

function validateUnitHandlers(data) {
  if (typeof data.unitHandlers !== "object" || Array.isArray(data.unitHandlers)) {
    return "unitHandlers must be an object";
  }
  for (const [unitType, handler] of Object.entries(data.unitHandlers)) {
    if (typeof handler !== "object" || handler === null || Array.isArray(handler)) {
      return `unitHandlers['${unitType}'] must be an object`;
    }
    if (!handler.skill && !handler.command) {
      return `unitHandlers['${unitType}'] must have 'skill' or 'command'`;
    }
    if (handler.skill && handler.command) {
      return `unitHandlers['${unitType}'] has both 'skill' and 'command' — pick one`;
    }
  }
  return null;
}

// ── resolveFlowTemplate: unified template lookup for all commands ──
// Checks: 1) --flow-file flag  2) state._flow_file  3) FLOW_TEMPLATES[name]
// Returns { template, name } or { error }.

export function resolveFlowTemplate(args, state = null) {
  const flowName = getFlag(args, "flow");
  const flowFile = getFlag(args, "flow-file");

  // Priority 1: explicit --flow-file
  if (flowFile) {
    const result = loadFlowFromFile(flowFile);
    if (result.error) return { error: result.error };
    return { template: result.template, name: result.name };
  }

  // Priority 2: _flow_file from persisted state
  if (state && state._flow_file) {
    const result = loadFlowFromFile(state._flow_file);
    if (result.error) {
      // File disappeared — fall through to name lookup
      console.error(`⚠️  _flow_file '${state._flow_file}' failed: ${result.error} — falling back to template name`);
    } else {
      return { template: result.template, name: result.name };
    }
  }

  // Priority 3: lookup by name in FLOW_TEMPLATES
  if (!flowName) return { error: "no --flow or --flow-file specified" };
  const template = Object.hasOwn(FLOW_TEMPLATES, flowName) ? FLOW_TEMPLATES[flowName] : null;
  if (!template) return { error: `unknown flow template: ${flowName}` };
  return { template, name: flowName };
}
