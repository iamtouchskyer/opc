// Flow graph definitions — nodes, edges, limits per template
// Built-in templates + external flow loading from ~/.claude/flows/

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { VALID_NODE_TYPES } from "./util.mjs";

// Harness version — used for opc_compat checking
export const HARNESS_VERSION = "0.7.0";

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
      "gate-test":         { PASS: "acceptance", FAIL: "discuss", ITERATE: "discuss" },
      acceptance:          { PASS: "gate-acceptance" },
      "gate-acceptance":   { PASS: "audit", FAIL: "discuss", ITERATE: "discuss" },
      audit:               { PASS: "gate-audit" },
      "gate-audit":        { PASS: "e2e-user", FAIL: "discuss", ITERATE: "discuss" },
      "e2e-user":          { PASS: "gate-e2e" },
      "gate-e2e":          { PASS: "post-launch-sim", FAIL: "discuss", ITERATE: "discuss" },
      "post-launch-sim":   { PASS: "gate-final" },
      "gate-final":        { PASS: null, FAIL: "discuss", ITERATE: "discuss" },
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
