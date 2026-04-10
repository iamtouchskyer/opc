// tests/viz-commands.test.mjs — T751-T800 (50 tests)
// Tests for getMarker, cmdViz, cmdReplayData

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const { getMarker, cmdViz, cmdReplayData } = await import(
  "../bin/lib/viz-commands.mjs"
);

function capture(fn) {
  const logs = [];
  const errs = [];
  let exitCode = null;
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  process.exit = (code) => { exitCode = code; throw new Error(`EXIT_${code}`); };
  let result;
  try { result = fn(); } catch (e) { if (!e.message.startsWith("EXIT_")) throw e; }
  finally { console.log = origLog; console.error = origErr; process.exit = origExit; }
  return { logs, errs, exitCode, output: logs.join("\n") };
}

function parseOutput(c) { return c.logs.length ? JSON.parse(c.output) : null; }

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "opc-viz-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// ══════════════════════════════════════════════════════════════════
// getMarker (T751-T765)
// ══════════════════════════════════════════════════════════════════
describe("getMarker", () => {
  it("T751 — current node returns ▶", () => {
    assert.equal(getMarker("build", { currentNode: "build", history: [] }), "▶");
  });

  it("T752 — history node returns ✅", () => {
    assert.equal(getMarker("build", { currentNode: "gate", history: [{ nodeId: "build" }] }), "✅");
  });

  it("T753 — unvisited node returns ○", () => {
    assert.equal(getMarker("deliver", { currentNode: "build", history: [] }), "○");
  });

  it("T754 — null state returns ○", () => {
    assert.equal(getMarker("build", null), "○");
  });

  it("T755 — undefined state returns ○", () => {
    assert.equal(getMarker("build", undefined), "○");
  });

  it("T756 — entry node visited returns ✅", () => {
    assert.equal(getMarker("design", { currentNode: "build", entryNode: "design", history: [] }), "✅");
  });

  it("T757 — entry node that is current returns ▶", () => {
    assert.equal(getMarker("design", { currentNode: "design", entryNode: "design", history: [] }), "▶");
  });

  it("T758 — node in history and is entry returns ✅", () => {
    assert.equal(getMarker("design", { currentNode: "gate", entryNode: "design", history: [{ nodeId: "design" }] }), "✅");
  });

  it("T759 — empty history array unvisited returns ○", () => {
    assert.equal(getMarker("test", { currentNode: "build", history: [] }), "○");
  });

  it("T760 — multiple history entries", () => {
    const state = { currentNode: "gate", history: [{ nodeId: "build" }, { nodeId: "review" }] };
    assert.equal(getMarker("review", state), "✅");
  });

  it("T761 — node not matching anything returns ○", () => {
    const state = { currentNode: "build", history: [{ nodeId: "plan" }] };
    assert.equal(getMarker("deliver", state), "○");
  });

  it("T762 — state with no history property returns ○ for non-current", () => {
    assert.equal(getMarker("build", { currentNode: "gate" }), "○");
  });

  it("T763 — state with no currentNode, node in history returns ✅", () => {
    assert.equal(getMarker("build", { history: [{ nodeId: "build" }] }), "✅");
  });

  it("T764 — empty string nodeId", () => {
    assert.equal(getMarker("", { currentNode: "", history: [] }), "▶");
  });

  it("T765 — state with entryNode but node not entry and not visited returns ○", () => {
    assert.equal(getMarker("gate", { currentNode: "build", entryNode: "design", history: [] }), "○");
  });
});

// ══════════════════════════════════════════════════════════════════
// cmdViz (T766-T785)
// ══════════════════════════════════════════════════════════════════
describe("cmdViz", () => {
  it("T766 — quick-review JSON output has nodes", () => {
    const c = capture(() => cmdViz(["--flow", "quick-review", "--json"]));
    const out = parseOutput(c);
    assert.ok(out.nodes.length === 2);
  });

  it("T767 — build-verify JSON output has 4 nodes", () => {
    const c = capture(() => cmdViz(["--flow", "build-verify", "--json"]));
    const out = parseOutput(c);
    assert.equal(out.nodes.length, 4);
  });

  it("T768 — full-stack JSON output has 13 nodes", () => {
    const c = capture(() => cmdViz(["--flow", "full-stack", "--json"]));
    const out = parseOutput(c);
    assert.equal(out.nodes.length, 13);
  });

  it("T769 — legacy-linear JSON output", () => {
    const c = capture(() => cmdViz(["--flow", "legacy-linear", "--json"]));
    const out = parseOutput(c);
    assert.equal(out.nodes.length, 5);
  });

  it("T770 — pre-release JSON output", () => {
    const c = capture(() => cmdViz(["--flow", "pre-release", "--json"]));
    const out = parseOutput(c);
    assert.equal(out.nodes.length, 6);
  });

  it("T771 — unknown template exits 1", () => {
    const c = capture(() => cmdViz(["--flow", "nonexistent", "--json"]));
    assert.equal(c.exitCode, 1);
  });

  it("T772 — missing --flow exits 1", () => {
    const c = capture(() => cmdViz([]));
    assert.equal(c.exitCode, 1);
  });

  it("T773 — JSON mode with state shows markers", () => {
    writeFileSync(join(tmp, "flow-state.json"), JSON.stringify({
      currentNode: "gate", history: [{ nodeId: "code-review" }],
    }));
    const c = capture(() => cmdViz(["--flow", "quick-review", "--dir", tmp, "--json"]));
    const out = parseOutput(c);
    const gate = out.nodes.find(n => n.id === "gate");
    assert.equal(gate.status, "▶");
    const cr = out.nodes.find(n => n.id === "code-review");
    assert.equal(cr.status, "✅");
  });

  it("T774 — JSON mode without state all ○", () => {
    const c = capture(() => cmdViz(["--flow", "quick-review", "--json"]));
    const out = parseOutput(c);
    assert.ok(out.nodes.every(n => n.status === "○"));
  });

  it("T775 — ASCII mode produces text output", () => {
    const c = capture(() => cmdViz(["--flow", "quick-review"]));
    assert.ok(c.output.includes("code-review"));
    assert.ok(c.output.includes("gate"));
  });

  it("T776 — ASCII mode with state shows markers", () => {
    writeFileSync(join(tmp, "flow-state.json"), JSON.stringify({
      currentNode: "code-review", history: [],
    }));
    const c = capture(() => cmdViz(["--flow", "quick-review", "--dir", tmp]));
    assert.ok(c.output.includes("▶"));
  });

  it("T777 — loopbacks in JSON output for build-verify", () => {
    const c = capture(() => cmdViz(["--flow", "build-verify", "--json"]));
    const out = parseOutput(c);
    assert.ok(out.loopbacks.length > 0);
    assert.ok(out.loopbacks.some(lb => lb.gate === "gate"));
  });

  it("T778 — quick-review has no loopbacks", () => {
    const c = capture(() => cmdViz(["--flow", "quick-review", "--json"]));
    const out = parseOutput(c);
    assert.equal(out.loopbacks.length, 0);
  });

  it("T779 — ASCII mode shows loopback arrows", () => {
    const c = capture(() => cmdViz(["--flow", "build-verify"]));
    assert.ok(c.output.includes("←"));
  });

  it("T780 — dir with invalid JSON state ignores it", () => {
    writeFileSync(join(tmp, "flow-state.json"), "not json");
    const c = capture(() => cmdViz(["--flow", "quick-review", "--dir", tmp, "--json"]));
    const out = parseOutput(c);
    assert.ok(out.nodes.every(n => n.status === "○"));
  });

  it("T781 — dir without flow-state.json uses null state", () => {
    const c = capture(() => cmdViz(["--flow", "quick-review", "--dir", tmp, "--json"]));
    const out = parseOutput(c);
    assert.ok(out.nodes.every(n => n.status === "○"));
  });

  it("T782 — ASCII mode shows │ connectors", () => {
    const c = capture(() => cmdViz(["--flow", "legacy-linear"]));
    assert.ok(c.output.includes("│"));
  });

  it("T783 — full-stack loopbacks include all gates", () => {
    const c = capture(() => cmdViz(["--flow", "full-stack", "--json"]));
    const out = parseOutput(c);
    const gates = out.loopbacks.map(lb => lb.gate);
    assert.ok(gates.includes("gate-test"));
    assert.ok(gates.includes("gate-final"));
  });

  it("T784 — loopback target is valid node", () => {
    const c = capture(() => cmdViz(["--flow", "build-verify", "--json"]));
    const out = parseOutput(c);
    const nodeIds = out.nodes.map(n => n.id);
    for (const lb of out.loopbacks) {
      assert.ok(nodeIds.includes(lb.target));
    }
  });

  it("T785 — node status objects have id and status fields", () => {
    const c = capture(() => cmdViz(["--flow", "quick-review", "--json"]));
    const out = parseOutput(c);
    for (const n of out.nodes) {
      assert.ok("id" in n);
      assert.ok("status" in n);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// cmdReplayData (T786-T800)
// ══════════════════════════════════════════════════════════════════
describe("cmdReplayData", () => {
  function setupReplay(dir, state, handshakes = {}, runFiles = {}) {
    writeFileSync(join(dir, "flow-state.json"), JSON.stringify(state));
    const nodesDir = join(dir, "nodes");
    mkdirSync(nodesDir, { recursive: true });
    for (const [nodeId, hs] of Object.entries(handshakes)) {
      const nodeDir = join(nodesDir, nodeId);
      mkdirSync(nodeDir, { recursive: true });
      writeFileSync(join(nodeDir, "handshake.json"), JSON.stringify(hs));
      if (runFiles[nodeId]) {
        for (const [runName, files] of Object.entries(runFiles[nodeId])) {
          const runDir = join(nodeDir, runName);
          mkdirSync(runDir, { recursive: true });
          for (const [fname, content] of Object.entries(files)) {
            writeFileSync(join(runDir, fname), content);
          }
        }
      }
    }
  }

  it("T786 — valid replay data output", () => {
    setupReplay(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 2,
      history: [{ nodeId: "code-review" }],
    });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.equal(out.flowTemplate, "quick-review");
    assert.equal(out.currentNode, "gate");
  });

  it("T787 — missing flow-state.json exits 1", () => {
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(c.exitCode, 1);
  });

  it("T788 — invalid JSON in flow-state.json exits 1", () => {
    writeFileSync(join(tmp, "flow-state.json"), "not json");
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(c.exitCode, 1);
  });

  it("T789 — unknown flow template exits 1", () => {
    writeFileSync(join(tmp, "flow-state.json"), JSON.stringify({ flowTemplate: "nonexistent" }));
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    assert.equal(c.exitCode, 1);
  });

  it("T790 — handshakes collected per node", () => {
    setupReplay(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 2,
      history: [{ nodeId: "code-review" }],
    }, {
      "code-review": { status: "done", verdict: "PASS" },
    });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.ok("code-review" in out.handshakes);
    assert.equal(out.handshakes["code-review"].status, "done");
  });

  it("T791 — run files included in handshake details", () => {
    setupReplay(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 2,
      history: [{ nodeId: "code-review" }],
    }, {
      "code-review": { status: "done" },
    }, {
      "code-review": { run_1: { "eval.md": "# Eval content" } },
    });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    const details = out.handshakes["code-review"].details;
    assert.ok(details.length > 0);
    assert.equal(details[0].file, "eval.md");
    assert.equal(details[0].run, "run_1");
  });

  it("T792 — nodes array matches template", () => {
    setupReplay(tmp, {
      flowTemplate: "build-verify",
      currentNode: "build",
      entryNode: "build",
      totalSteps: 0,
      history: [],
    });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.deepEqual(out.nodes, ["build", "code-review", "test-verify", "gate"]);
  });

  it("T793 — edges included in output", () => {
    setupReplay(tmp, {
      flowTemplate: "quick-review",
      currentNode: "code-review",
      entryNode: "code-review",
      totalSteps: 0,
      history: [],
    });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.ok("edges" in out);
    assert.ok("code-review" in out.edges);
  });

  it("T794 — loopbacks in output", () => {
    setupReplay(tmp, {
      flowTemplate: "build-verify",
      currentNode: "build",
      entryNode: "build",
      totalSteps: 0,
      history: [],
    });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.ok(out.loopbacks.length > 0);
  });

  it("T795 — totalSteps propagated", () => {
    setupReplay(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 5,
      history: [],
    });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.equal(out.totalSteps, 5);
  });

  it("T796 — history propagated", () => {
    const history = [{ nodeId: "code-review", ts: "2025-01-01" }, { nodeId: "gate", ts: "2025-01-02" }];
    setupReplay(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 2,
      history,
    });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.equal(out.history.length, 2);
  });

  it("T797 — empty handshakes when no handshake.json files", () => {
    setupReplay(tmp, {
      flowTemplate: "quick-review",
      currentNode: "code-review",
      entryNode: "code-review",
      totalSteps: 0,
      history: [],
    });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.deepEqual(out.handshakes, {});
  });

  it("T798 — default dir is .harness", () => {
    const hd = join(tmp, ".harness");
    mkdirSync(hd);
    writeFileSync(join(hd, "flow-state.json"), JSON.stringify({
      flowTemplate: "quick-review",
      currentNode: "code-review",
      entryNode: "code-review",
      totalSteps: 0,
      history: [],
    }));
    mkdirSync(join(hd, "nodes"), { recursive: true });
    // cmdReplayData defaults to --dir .harness — need to be in tmp for that
    const origCwd = process.cwd();
    try {
      process.chdir(tmp);
      const c = capture(() => cmdReplayData([]));
      const out = parseOutput(c);
      assert.equal(out.flowTemplate, "quick-review");
    } finally {
      process.chdir(origCwd);
    }
  });

  it("T799 — only .md and .txt run files included", () => {
    setupReplay(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 1,
      history: [{ nodeId: "code-review" }],
    }, {
      "code-review": { status: "done" },
    }, {
      "code-review": { run_1: { "eval.md": "content", "data.json": "{}", "notes.txt": "text" } },
    });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    const files = out.handshakes["code-review"].details.map(d => d.file);
    assert.ok(files.includes("eval.md"));
    assert.ok(files.includes("notes.txt"));
    assert.ok(!files.includes("data.json"));
  });

  it("T800 — entryNode included in output", () => {
    setupReplay(tmp, {
      flowTemplate: "quick-review",
      currentNode: "gate",
      entryNode: "code-review",
      totalSteps: 1,
      history: [],
    });
    const c = capture(() => cmdReplayData(["--dir", tmp]));
    const out = parseOutput(c);
    assert.equal(out.entryNode, "code-review");
  });
});
