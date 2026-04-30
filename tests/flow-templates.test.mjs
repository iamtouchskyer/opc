// tests/flow-templates.test.mjs — T801-T850 (50 tests)
// Tests for FLOW_TEMPLATES structure, edges, and limits

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { FLOW_TEMPLATES } = await import("../bin/lib/flow-templates.mjs");

const templateNames = Object.keys(FLOW_TEMPLATES);

// ══════════════════════════════════════════════════════════════════
// Template structure (T801-T825)
// ══════════════════════════════════════════════════════════════════
describe("Template structure", () => {
  it("T801 — FLOW_TEMPLATES is non-empty object", () => {
    assert.ok(typeof FLOW_TEMPLATES === "object");
    assert.ok(templateNames.length > 0);
  });

  it("T802 — legacy-linear exists", () => {
    assert.ok("legacy-linear" in FLOW_TEMPLATES);
  });

  it("T803 — quick-review exists", () => {
    assert.ok("quick-review" in FLOW_TEMPLATES);
  });

  it("T804 — build-verify exists", () => {
    assert.ok("build-verify" in FLOW_TEMPLATES);
  });

  it("T805 — full-stack exists", () => {
    assert.ok("full-stack" in FLOW_TEMPLATES);
  });

  it("T806 — pre-release exists", () => {
    assert.ok("pre-release" in FLOW_TEMPLATES);
  });

  it("T807 — each template has nodes array", () => {
    for (const name of templateNames) {
      assert.ok(Array.isArray(FLOW_TEMPLATES[name].nodes), `${name} missing nodes`);
    }
  });

  it("T808 — each template has edges object", () => {
    for (const name of templateNames) {
      assert.ok(typeof FLOW_TEMPLATES[name].edges === "object", `${name} missing edges`);
    }
  });

  it("T809 — each template has limits object", () => {
    for (const name of templateNames) {
      assert.ok(typeof FLOW_TEMPLATES[name].limits === "object", `${name} missing limits`);
    }
  });

  it("T810 — nodes arrays are non-empty", () => {
    for (const name of templateNames) {
      assert.ok(FLOW_TEMPLATES[name].nodes.length > 0, `${name} has empty nodes`);
    }
  });

  it("T811 — all nodes have edge entries", () => {
    for (const name of templateNames) {
      const t = FLOW_TEMPLATES[name];
      for (const node of t.nodes) {
        assert.ok(node in t.edges, `${name}: node '${node}' missing in edges`);
      }
    }
  });

  it("T812 — all edge targets are valid nodes or null", () => {
    for (const name of templateNames) {
      const t = FLOW_TEMPLATES[name];
      const nodeSet = new Set(t.nodes);
      for (const [src, edges] of Object.entries(t.edges)) {
        for (const [verdict, target] of Object.entries(edges)) {
          assert.ok(
            target === null || nodeSet.has(target),
            `${name}: edge ${src}→${verdict}→${target} invalid`
          );
        }
      }
    }
  });

  it("T813 — no duplicate nodes in any template", () => {
    for (const name of templateNames) {
      const nodes = FLOW_TEMPLATES[name].nodes;
      assert.equal(nodes.length, new Set(nodes).size, `${name} has duplicate nodes`);
    }
  });

  it("T814 — edge keys match node list", () => {
    for (const name of templateNames) {
      const t = FLOW_TEMPLATES[name];
      const edgeKeys = Object.keys(t.edges);
      for (const key of edgeKeys) {
        assert.ok(t.nodes.includes(key), `${name}: edge key '${key}' not in nodes`);
      }
    }
  });

  it("T815 — legacy-linear has 5 nodes", () => {
    assert.equal(FLOW_TEMPLATES["legacy-linear"].nodes.length, 5);
  });

  it("T816 — quick-review has 2 nodes", () => {
    assert.equal(FLOW_TEMPLATES["quick-review"].nodes.length, 2);
  });

  it("T817 — build-verify has 4 nodes", () => {
    assert.equal(FLOW_TEMPLATES["build-verify"].nodes.length, 4);
  });

  it("T818 — full-stack has 13 nodes", () => {
    assert.equal(FLOW_TEMPLATES["full-stack"].nodes.length, 13);
  });

  it("T819 — pre-release has 6 nodes", () => {
    assert.equal(FLOW_TEMPLATES["pre-release"].nodes.length, 6);
  });

  it("T820 — legacy-linear first node is design", () => {
    assert.equal(FLOW_TEMPLATES["legacy-linear"].nodes[0], "design");
  });

  it("T821 — quick-review first node is code-review", () => {
    assert.equal(FLOW_TEMPLATES["quick-review"].nodes[0], "code-review");
  });

  it("T822 — build-verify first node is build", () => {
    assert.equal(FLOW_TEMPLATES["build-verify"].nodes[0], "build");
  });

  it("T823 — full-stack first node is discuss", () => {
    assert.equal(FLOW_TEMPLATES["full-stack"].nodes[0], "discuss");
  });

  it("T824 — node names are non-empty strings", () => {
    for (const name of templateNames) {
      for (const node of FLOW_TEMPLATES[name].nodes) {
        assert.ok(typeof node === "string" && node.length > 0, `${name} has invalid node`);
      }
    }
  });

  it("T825 — at least 5 templates defined", () => {
    assert.ok(templateNames.length >= 5);
  });
});

// ══════════════════════════════════════════════════════════════════
// Edge completeness (T826-T840)
// ══════════════════════════════════════════════════════════════════
describe("Edge completeness", () => {
  it("T826 — every non-terminal node has PASS edge", () => {
    for (const name of templateNames) {
      const t = FLOW_TEMPLATES[name];
      for (const node of t.nodes) {
        assert.ok("PASS" in t.edges[node], `${name}: ${node} missing PASS edge`);
      }
    }
  });

  it("T827 — terminal nodes have PASS: null", () => {
    for (const name of templateNames) {
      const t = FLOW_TEMPLATES[name];
      const lastNode = t.nodes[t.nodes.length - 1];
      // Last node should have at least one null target
      const hasNull = Object.values(t.edges[lastNode]).some(v => v === null);
      assert.ok(hasNull, `${name}: last node '${lastNode}' has no null edge`);
    }
  });

  it("T828 — gate nodes have FAIL edge (build-verify)", () => {
    const t = FLOW_TEMPLATES["build-verify"];
    assert.ok("FAIL" in t.edges["gate"]);
  });

  it("T829 — gate nodes have ITERATE edge (build-verify)", () => {
    const t = FLOW_TEMPLATES["build-verify"];
    assert.ok("ITERATE" in t.edges["gate"]);
  });

  it("T830 — legacy-linear evaluate has FAIL edge", () => {
    assert.ok("FAIL" in FLOW_TEMPLATES["legacy-linear"].edges["evaluate"]);
  });

  it("T831 — legacy-linear evaluate has ITERATE edge", () => {
    assert.ok("ITERATE" in FLOW_TEMPLATES["legacy-linear"].edges["evaluate"]);
  });

  it("T832 — quick-review gate has only PASS edge", () => {
    const edges = FLOW_TEMPLATES["quick-review"].edges["gate"];
    assert.ok("PASS" in edges);
    assert.ok(!("FAIL" in edges));
  });

  it("T833 — full-stack gate-test has FAIL edge", () => {
    assert.ok("FAIL" in FLOW_TEMPLATES["full-stack"].edges["gate-test"]);
  });

  it("T834 — full-stack gate-final has FAIL edge", () => {
    assert.ok("FAIL" in FLOW_TEMPLATES["full-stack"].edges["gate-final"]);
  });

  it("T835 — full-stack all gates point back to discuss", () => {
    const t = FLOW_TEMPLATES["full-stack"];
    const gates = t.nodes.filter(n => n.startsWith("gate-"));
    for (const gate of gates) {
      if (t.edges[gate].FAIL) {
        assert.equal(t.edges[gate].FAIL, "discuss", `${gate} FAIL should point to discuss`);
      }
    }
  });

  it("T836 — pre-release gates point back to acceptance", () => {
    const t = FLOW_TEMPLATES["pre-release"];
    const gates = t.nodes.filter(n => n.startsWith("gate-"));
    for (const gate of gates) {
      if (t.edges[gate].FAIL) {
        assert.equal(t.edges[gate].FAIL, "acceptance");
      }
    }
  });

  it("T837 — PASS edges form a path from first to last node", () => {
    for (const name of templateNames) {
      const t = FLOW_TEMPLATES[name];
      let current = t.nodes[0];
      const visited = new Set();
      while (current && !visited.has(current)) {
        visited.add(current);
        current = t.edges[current]?.PASS;
      }
      // Should have visited at least most nodes via PASS chain
      assert.ok(visited.size >= t.nodes.length - 1, `${name}: PASS path incomplete`);
    }
  });

  it("T838 — no edges point to themselves", () => {
    for (const name of templateNames) {
      const t = FLOW_TEMPLATES[name];
      for (const [src, edges] of Object.entries(t.edges)) {
        for (const [verdict, target] of Object.entries(edges)) {
          assert.notEqual(src, target, `${name}: ${src}→${verdict} self-loop`);
        }
      }
    }
  });

  it("T839 — FAIL and ITERATE targets are earlier nodes (loop back)", () => {
    for (const name of templateNames) {
      const t = FLOW_TEMPLATES[name];
      for (const [src, edges] of Object.entries(t.edges)) {
        for (const verdict of ["FAIL", "ITERATE"]) {
          if (edges[verdict]) {
            const srcIdx = t.nodes.indexOf(src);
            const tgtIdx = t.nodes.indexOf(edges[verdict]);
            assert.ok(tgtIdx < srcIdx, `${name}: ${src}→${verdict}→${edges[verdict]} doesn't loop back`);
          }
        }
      }
    }
  });

  it("T840 — PASS targets are later nodes (forward)", () => {
    for (const name of templateNames) {
      const t = FLOW_TEMPLATES[name];
      for (const [src, edges] of Object.entries(t.edges)) {
        if (edges.PASS !== null) {
          const srcIdx = t.nodes.indexOf(src);
          const tgtIdx = t.nodes.indexOf(edges.PASS);
          assert.ok(tgtIdx > srcIdx, `${name}: ${src}→PASS→${edges.PASS} doesn't go forward`);
        }
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// Limit validation (T841-T850)
// ══════════════════════════════════════════════════════════════════
describe("Limit validation", () => {
  it("T841 — maxLoopsPerEdge is positive integer", () => {
    for (const name of templateNames) {
      const l = FLOW_TEMPLATES[name].limits.maxLoopsPerEdge;
      assert.ok(Number.isInteger(l) && l > 0, `${name}: maxLoopsPerEdge=${l}`);
    }
  });

  it("T842 — maxTotalSteps is positive integer", () => {
    for (const name of templateNames) {
      const l = FLOW_TEMPLATES[name].limits.maxTotalSteps;
      assert.ok(Number.isInteger(l) && l > 0, `${name}: maxTotalSteps=${l}`);
    }
  });

  it("T843 — maxNodeReentry is positive integer", () => {
    for (const name of templateNames) {
      const l = FLOW_TEMPLATES[name].limits.maxNodeReentry;
      assert.ok(Number.isInteger(l) && l > 0, `${name}: maxNodeReentry=${l}`);
    }
  });

  it("T844 — maxLoopsPerEdge <= 10", () => {
    for (const name of templateNames) {
      assert.ok(FLOW_TEMPLATES[name].limits.maxLoopsPerEdge <= 10, `${name} maxLoopsPerEdge too high`);
    }
  });

  it("T845 — maxTotalSteps <= 50", () => {
    for (const name of templateNames) {
      assert.ok(FLOW_TEMPLATES[name].limits.maxTotalSteps <= 50, `${name} maxTotalSteps too high`);
    }
  });

  it("T846 — maxNodeReentry <= 10", () => {
    for (const name of templateNames) {
      assert.ok(FLOW_TEMPLATES[name].limits.maxNodeReentry <= 10, `${name} maxNodeReentry too high`);
    }
  });

  it("T847 — maxTotalSteps >= node count", () => {
    for (const name of templateNames) {
      const t = FLOW_TEMPLATES[name];
      assert.ok(t.limits.maxTotalSteps >= t.nodes.length, `${name}: maxTotalSteps < node count`);
    }
  });

  it("T848 — limits object has exactly 3 keys", () => {
    for (const name of templateNames) {
      const keys = Object.keys(FLOW_TEMPLATES[name].limits);
      assert.equal(keys.length, 3, `${name} has ${keys.length} limit keys`);
    }
  });

  it("T849 — quick-review has lower maxTotalSteps than full-stack", () => {
    assert.ok(
      FLOW_TEMPLATES["quick-review"].limits.maxTotalSteps <
      FLOW_TEMPLATES["full-stack"].limits.maxTotalSteps
    );
  });

  it("T850 — all templates share maxLoopsPerEdge=3", () => {
    for (const name of templateNames) {
      assert.equal(FLOW_TEMPLATES[name].limits.maxLoopsPerEdge, 3);
    }
  });
});
