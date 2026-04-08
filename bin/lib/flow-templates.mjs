// Flow graph definitions — nodes, edges, limits per template
// Pure data, no dependencies.

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
  },
  "quick-review": {
    nodes: ["code-review", "gate"],
    edges: {
      "code-review": { PASS: "gate" },
      gate:          { PASS: null },
    },
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 10, maxNodeReentry: 5 },
  },
  "build-verify": {
    nodes: ["build", "code-review", "test-verify", "gate"],
    edges: {
      build:         { PASS: "code-review" },
      "code-review": { PASS: "test-verify" },
      "test-verify": { PASS: "gate" },
      gate:          { PASS: null, FAIL: "build", ITERATE: "build" },
    },
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 20, maxNodeReentry: 5 },
  },
  "full-stack": {
    nodes: [
      "discuss", "build", "code-review", "test-verify", "gate-test",
      "acceptance", "gate-acceptance",
      "audit", "gate-audit",
      "e2e-user", "gate-e2e",
      "post-launch-sim", "gate-final",
    ],
    edges: {
      discuss:             { PASS: "build" },
      build:               { PASS: "code-review" },
      "code-review":       { PASS: "test-verify" },
      "test-verify":       { PASS: "gate-test" },
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
    limits: { maxLoopsPerEdge: 3, maxTotalSteps: 30, maxNodeReentry: 5 },
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
  },
};
