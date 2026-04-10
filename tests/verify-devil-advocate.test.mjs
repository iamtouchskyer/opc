// tests/verify-devil-advocate.test.mjs — T901-T950 (50 tests)
// Tests for verify_devil_advocate.py via python3 spawning

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "verify_devil_advocate.py");

function runPy(filePath) {
  try {
    const stdout = execFileSync("python3", [SCRIPT, filePath], {
      encoding: "utf8",
      timeout: 10000,
    });
    return { stdout, code: 0 };
  } catch (e) {
    return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status };
  }
}

function makeDoc({ challenges = [], verdict = "", extra = "" } = {}) {
  let md = "# Devil's Advocate Evaluation\n\n## Challenges\n\n";
  for (const c of challenges) {
    const status = c.status || "OPEN";
    md += `### [${status}] Challenge ${c.number}: ${c.title}\n\n`;
    if (c.assumption) md += `**Assumption under attack:** ${c.assumption}\n\n`;
    if (c.failure) md += `**Failure scenario:** ${c.failure}\n\n`;
    if (c.convince) md += `**What would convince me:** ${c.convince}\n\n`;
    if (c.alternative) md += `**If I'm right:** ${c.alternative}\n\n`;
    md += "\n";
  }
  md += "---\n\n## Verdict\n\n";
  if (verdict) md += `VERDICT: ${verdict}\n`;
  md += extra;
  return md;
}

function makeChallenge(num, overrides = {}) {
  return {
    number: num,
    status: "OPEN",
    title: `Test challenge ${num}`,
    assumption: "The system assumes X",
    failure: "When load exceeds 1000 rps, the queue will overflow",
    convince: "Show me load test results at 1500 rps",
    alternative: "Use a bounded queue with backpressure",
    ...overrides,
  };
}

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "opc-devil-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// ══════════════════════════════════════════════════════════════════
// Challenge parsing (T901-T915)
// ══════════════════════════════════════════════════════════════════
describe("Challenge parsing", () => {
  it("T901 — valid challenge parsed", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1)],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("Challenge"));
    assert.ok(r.stdout.includes("#1"));
  });

  it("T902 — multiple challenges parsed", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1), makeChallenge(2), makeChallenge(3)],
      verdict: "UNCONVINCED [3]",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("#1"));
    assert.ok(r.stdout.includes("#2"));
    assert.ok(r.stdout.includes("#3"));
  });

  it("T903 — SEALED status recognized", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { status: "SEALED" })],
      verdict: "CONVINCED",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("sealed"));
  });

  it("T904 — status transition OPEN to SEALED in header", () => {
    const p = join(tmp, "eval.md");
    const md = `# Devil's Advocate Evaluation\n\n## Challenges\n\n### [OPEN → SEALED] Challenge 1: Test\n\n**Assumption under attack:** X\n\n---\n\n## Verdict\n\nVERDICT: CONVINCED\n`;
    writeFileSync(p, md);
    const r = runPy(p);
    assert.ok(r.stdout.includes("sealed"));
  });

  it("T905 — missing challenge sections flagged as errors", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [{ number: 1, status: "OPEN", title: "Missing sections" }],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("MISSING"));
  });

  it("T906 — no challenges at all flagged", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "# Devil's Advocate\n\nNo challenges here.\n\nVERDICT: CONVINCED\n");
    const r = runPy(p);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("NO_CHALLENGES"));
  });

  it("T907 — challenge missing assumption flagged", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { assumption: null })],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("MISSING_ASSUMPTION"));
  });

  it("T908 — challenge missing failure scenario flagged", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { failure: null })],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("MISSING_FAILURE_SCENARIO"));
  });

  it("T909 — challenge missing convince-me flagged", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { convince: null })],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("MISSING_DEFEAT_CONDITIONS"));
  });

  it("T910 — challenge missing alternative flagged", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { alternative: null })],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("MISSING_ALTERNATIVE"));
  });

  it("T911 — SEALED challenges skip section checks", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [{ number: 1, status: "SEALED", title: "Resolved" }],
      verdict: "CONVINCED",
    }));
    const r = runPy(p);
    // SEALED without sections should not produce MISSING errors
    assert.ok(!r.stdout.includes("MISSING_ASSUMPTION"));
  });

  it("T912 — challenge title extracted", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { title: "Memory leak in worker pool" })],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("Memory leak"));
  });

  it("T913 — 5 challenges all parsed", () => {
    const p = join(tmp, "eval.md");
    const challenges = Array.from({ length: 5 }, (_, i) => makeChallenge(i + 1));
    writeFileSync(p, makeDoc({ challenges, verdict: "UNCONVINCED [5]" }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("#5"));
  });

  it("T914 — ESCALATED status recognized", () => {
    const p = join(tmp, "eval.md");
    const md = `# Eval\n\n## Challenges\n\n### [ESCALATED] Challenge 1: Critical flaw\n\n**Assumption under attack:** X\n**Failure scenario:** When X happens\n**What would convince me:** Y\n**If I'm right:** Z\n\n---\n\n## Verdict\n\nVERDICT: FATAL\n`;
    writeFileSync(p, md);
    const r = runPy(p);
    assert.equal(r.code, 0);
  });

  it("T915 — OPEN → NARROWED treated as OPEN", () => {
    const p = join(tmp, "eval.md");
    const md = `# Eval\n\n## Challenges\n\n### [OPEN → NARROWED] Challenge 1: Scoped down\n\n**Assumption under attack:** X\n**Failure scenario:** When Y happens\n**What would convince me:** Z\n**If I'm right:** W\n\n---\n\n## Verdict\n\nVERDICT: UNCONVINCED [1]\n`;
    writeFileSync(p, md);
    const r = runPy(p);
    assert.ok(r.stdout.includes("open"));
  });
});

// ══════════════════════════════════════════════════════════════════
// Verdict parsing (T916-T925)
// ══════════════════════════════════════════════════════════════════
describe("Verdict parsing", () => {
  it("T916 — UNCONVINCED[N] parsed", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1), makeChallenge(2)],
      verdict: "UNCONVINCED [2]",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("UNCONVINCED"));
    assert.ok(r.stdout.includes("[2]"));
  });

  it("T917 — CONVINCED parsed", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { status: "SEALED" })],
      verdict: "CONVINCED",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("CONVINCED"));
  });

  it("T918 — FATAL parsed", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1)],
      verdict: "FATAL",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("FATAL"));
  });

  it("T919 — missing verdict flagged", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1)],
      verdict: "",
    }));
    const r = runPy(p);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("NO_VERDICT"));
  });

  it("T920 — UNCONVINCED count mismatch flagged", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1), makeChallenge(2)],
      verdict: "UNCONVINCED [5]",
    }));
    const r = runPy(p);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("VERDICT_MISMATCH"));
  });

  it("T921 — CONVINCED with open challenges flagged", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { status: "OPEN" })],
      verdict: "CONVINCED",
    }));
    const r = runPy(p);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("VERDICT_INCONSISTENT"));
  });

  it("T922 — UNCONVINCED [0] with 0 open passes", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { status: "SEALED" })],
      verdict: "UNCONVINCED [0]",
    }));
    const r = runPy(p);
    // Count matches (0 open, 0 stated)
    assert.ok(!r.stdout.includes("VERDICT_MISMATCH"));
  });

  it("T923 — UNCONVINCED [1] with 1 open passes", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1), makeChallenge(2, { status: "SEALED" })],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.ok(!r.stdout.includes("VERDICT_MISMATCH"));
  });

  it("T924 — verdict count 0 for CONVINCED", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { status: "SEALED" })],
      verdict: "CONVINCED",
    }));
    const r = runPy(p);
    // Should pass
    assert.equal(r.code, 0);
  });

  it("T925 — verdict count 0 for FATAL", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1)],
      verdict: "FATAL",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("FATAL"));
  });
});

// ══════════════════════════════════════════════════════════════════
// Quality checks (T926-T940)
// ══════════════════════════════════════════════════════════════════
describe("Quality checks", () => {
  it("T926 — hedging/vague scenario warned", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { failure: "The system might break eventually" })],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("VAGUE_SCENARIO"));
  });

  it("T927 — specific scenario no warning", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { failure: "When the queue exceeds 1000 items, OOM kills the worker" })],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.ok(!r.stdout.includes("VAGUE_SCENARIO"));
  });

  it("T928 — low challenge count warned", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1)],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("LOW_CHALLENGE_COUNT"));
  });

  it("T929 — 3+ challenges no low count warning", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1), makeChallenge(2), makeChallenge(3)],
      verdict: "UNCONVINCED [3]",
    }));
    const r = runPy(p);
    assert.ok(!r.stdout.includes("LOW_CHALLENGE_COUNT"));
  });

  it("T930 — all SEALED rubber stamp flagged if verdict not CONVINCED", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [
        makeChallenge(1, { status: "SEALED" }),
        makeChallenge(2, { status: "SEALED" }),
        makeChallenge(3, { status: "SEALED" }),
      ],
      verdict: "UNCONVINCED [0]",
    }));
    const r = runPy(p);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("INCONSISTENT"));
  });

  it("T931 — all SEALED with CONVINCED passes", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [
        makeChallenge(1, { status: "SEALED" }),
        makeChallenge(2, { status: "SEALED" }),
        makeChallenge(3, { status: "SEALED" }),
      ],
      verdict: "CONVINCED",
    }));
    const r = runPy(p);
    assert.equal(r.code, 0);
  });

  it("T932 — trolling pattern: 6+ all OPEN warned", () => {
    const p = join(tmp, "eval.md");
    const challenges = Array.from({ length: 6 }, (_, i) => makeChallenge(i + 1));
    writeFileSync(p, makeDoc({ challenges, verdict: "UNCONVINCED [6]" }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("POSSIBLE_TROLLING"));
  });

  it("T933 — 5 all OPEN not flagged as trolling", () => {
    const p = join(tmp, "eval.md");
    const challenges = Array.from({ length: 5 }, (_, i) => makeChallenge(i + 1));
    writeFileSync(p, makeDoc({ challenges, verdict: "UNCONVINCED [5]" }));
    const r = runPy(p);
    assert.ok(!r.stdout.includes("POSSIBLE_TROLLING"));
  });

  it("T934 — 6 with one SEALED not flagged as trolling", () => {
    const p = join(tmp, "eval.md");
    const challenges = [
      ...Array.from({ length: 5 }, (_, i) => makeChallenge(i + 1)),
      makeChallenge(6, { status: "SEALED" }),
    ];
    writeFileSync(p, makeDoc({ challenges, verdict: "UNCONVINCED [5]" }));
    const r = runPy(p);
    assert.ok(!r.stdout.includes("POSSIBLE_TROLLING"));
  });

  it("T935 — failure scenario with 'if' is specific", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { failure: "If the database connection drops mid-transaction, data is lost" })],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.ok(!r.stdout.includes("VAGUE_SCENARIO"));
  });

  it("T936 — failure scenario with 'when' is specific", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { failure: "When concurrent users exceed 500, the mutex contention causes deadlock" })],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.ok(!r.stdout.includes("VAGUE_SCENARIO"));
  });

  it("T937 — failure scenario with 'could potentially' is vague", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1, { failure: "The service could potentially fail" })],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("VAGUE_SCENARIO"));
  });

  it("T938 — sections listed in output", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1)],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("assumption"));
    assert.ok(r.stdout.includes("scenario"));
  });

  it("T939 — PASSED output for valid doc", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1), makeChallenge(2), makeChallenge(3)],
      verdict: "UNCONVINCED [3]",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("PASSED"));
  });

  it("T940 — FAILED output for invalid doc", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [{ number: 1, status: "OPEN", title: "Incomplete" }],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("FAILED"));
  });
});

// ══════════════════════════════════════════════════════════════════
// Integration (T941-T950)
// ══════════════════════════════════════════════════════════════════
describe("Integration", () => {
  it("T941 — full valid document passes", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1), makeChallenge(2), makeChallenge(3)],
      verdict: "UNCONVINCED [3]",
    }));
    const r = runPy(p);
    assert.equal(r.code, 0);
  });

  it("T942 — full invalid document fails", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, "# Nothing useful here\n");
    const r = runPy(p);
    assert.equal(r.code, 1);
  });

  it("T943 — no args exits 2", () => {
    try {
      execFileSync("python3", [SCRIPT], { encoding: "utf8", timeout: 10000 });
      assert.fail("Should have exited");
    } catch (e) {
      assert.equal(e.status, 2);
    }
  });

  it("T944 — nonexistent file exits 2", () => {
    try {
      execFileSync("python3", [SCRIPT, "/tmp/nonexistent.md"], { encoding: "utf8", timeout: 10000 });
      assert.fail("Should have exited");
    } catch (e) {
      assert.equal(e.status, 2);
    }
  });

  it("T945 — mixed open and sealed challenges", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [
        makeChallenge(1),
        makeChallenge(2, { status: "SEALED" }),
        makeChallenge(3),
      ],
      verdict: "UNCONVINCED [2]",
    }));
    const r = runPy(p);
    assert.equal(r.code, 0);
  });

  it("T946 — output includes report header", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1), makeChallenge(2), makeChallenge(3)],
      verdict: "UNCONVINCED [3]",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("Devil's Advocate Verification Report"));
  });

  it("T947 — output includes file path", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1), makeChallenge(2), makeChallenge(3)],
      verdict: "UNCONVINCED [3]",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes(p));
  });

  it("T948 — CONVINCED with all SEALED passes", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [
        makeChallenge(1, { status: "SEALED" }),
        makeChallenge(2, { status: "SEALED" }),
        makeChallenge(3, { status: "SEALED" }),
      ],
      verdict: "CONVINCED",
    }));
    const r = runPy(p);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("PASSED"));
  });

  it("T949 — FATAL with open challenges passes format check", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [makeChallenge(1), makeChallenge(2), makeChallenge(3)],
      verdict: "FATAL",
    }));
    const r = runPy(p);
    // FATAL doesn't require challenges to be sealed
    assert.equal(r.code, 0);
  });

  it("T950 — output shows error and warning counts", () => {
    const p = join(tmp, "eval.md");
    writeFileSync(p, makeDoc({
      challenges: [{ number: 1, status: "OPEN", title: "Incomplete" }],
      verdict: "UNCONVINCED [1]",
    }));
    const r = runPy(p);
    assert.ok(r.stdout.includes("ERRORS"));
  });
});
