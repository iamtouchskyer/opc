// runbooks.test.mjs — unit tests for Runbook schema + loader + matcher
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseFrontmatter,
  parseRunbook,
  validateRunbook,
  loadRunbooks,
  matchRunbook,
  RUNBOOK_SCHEMA_VERSION,
} from "./runbooks.mjs";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "opc-runbooks-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ─── parseFrontmatter ────────────────────────────────────────────

test("parseFrontmatter: no frontmatter → empty meta + full body", () => {
  const { meta, body } = parseFrontmatter("# hello\n\nbody text");
  assert.deepEqual(meta, {});
  assert.equal(body, "# hello\n\nbody text");
});

test("parseFrontmatter: string values unquoted and quoted", () => {
  const src = "---\ntitle: Add Feature\nid: \"add-feature\"\nflow: 'build-verify'\n---\nbody";
  const { meta, body } = parseFrontmatter(src);
  assert.equal(meta.title, "Add Feature");
  assert.equal(meta.id, "add-feature");
  assert.equal(meta.flow, "build-verify");
  assert.equal(body, "body");
});

test("parseFrontmatter: flow-style inline list", () => {
  const src = "---\ntags: [a, b, \"c d\"]\n---\n";
  const { meta } = parseFrontmatter(src);
  assert.deepEqual(meta.tags, ["a", "b", "c d"]);
});

test("parseFrontmatter: block-style list", () => {
  const src = "---\nmatch:\n  - add feature\n  - implement\n  - \"new api\"\n---\n";
  const { meta } = parseFrontmatter(src);
  assert.deepEqual(meta.match, ["add feature", "implement", "new api"]);
});

test("parseFrontmatter: numbers parsed as numbers", () => {
  const src = "---\nversion: 1\n---\n";
  const { meta } = parseFrontmatter(src);
  assert.equal(meta.version, 1);
  assert.equal(typeof meta.version, "number");
});

test("parseFrontmatter: unclosed frontmatter → empty meta, body preserved", () => {
  const { meta, body } = parseFrontmatter("---\ntitle: x\nbody without close");
  assert.deepEqual(meta, {});
  assert.equal(body, "---\ntitle: x\nbody without close");
});

test("parseFrontmatter: skips blank and comment lines", () => {
  const src = "---\n# comment\n\ntitle: X\n---\n";
  const { meta } = parseFrontmatter(src);
  assert.equal(meta.title, "X");
});

// ─── validateRunbook ─────────────────────────────────────────────

test("validateRunbook: rejects non-object", () => {
  const { ok, errors } = validateRunbook(null);
  assert.equal(ok, false);
  assert.ok(errors.some(e => /object/i.test(e)));
});

test("validateRunbook: rejects missing required fields", () => {
  const { ok, errors } = validateRunbook({});
  assert.equal(ok, false);
  assert.ok(errors.some(e => /version/.test(e)));
  assert.ok(errors.some(e => /id/.test(e)));
  assert.ok(errors.some(e => /title/.test(e)));
  assert.ok(errors.some(e => /units/.test(e)));
});

test("validateRunbook: rejects wrong version", () => {
  const rb = { version: 2, id: "x", title: "x", units: ["a"] };
  const { ok, errors } = validateRunbook(rb);
  assert.equal(ok, false);
  assert.ok(errors.some(e => /version/.test(e)));
});

test("validateRunbook: rejects non-string id / non-slug id", () => {
  let r = validateRunbook({ version: 1, id: 42, title: "x", units: ["a"] });
  assert.equal(r.ok, false);
  r = validateRunbook({ version: 1, id: "Not A Slug", title: "x", units: ["a"] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /slug/i.test(e) || /id/i.test(e)));
});

test("validateRunbook: rejects empty units", () => {
  const { ok, errors } = validateRunbook({ version: 1, id: "x", title: "x", units: [] });
  assert.equal(ok, false);
  assert.ok(errors.some(e => /units/.test(e)));
});

test("validateRunbook: rejects non-array tags / match", () => {
  const base = { version: 1, id: "x", title: "x", units: ["a"] };
  assert.equal(validateRunbook({ ...base, tags: "not-array" }).ok, false);
  assert.equal(validateRunbook({ ...base, match: "not-array" }).ok, false);
});

test("validateRunbook: accepts minimal valid runbook", () => {
  const rb = { version: 1, id: "add-feature", title: "Add Feature", units: ["plan", "build"] };
  const { ok, errors } = validateRunbook(rb);
  assert.equal(ok, true, `errors: ${errors.join("; ")}`);
});

test("validateRunbook: accepts full runbook with optional fields", () => {
  const rb = {
    version: 1,
    id: "add-feature",
    title: "Add Feature",
    tags: ["build"],
    match: ["add feature", "/^implement /i"],
    flow: "build-verify",
    tier: "polished",
    units: ["plan", "build", "review"],
    protocolRefs: ["implementer-prompt.md"],
    createdAt: "2026-04-19",
    updatedAt: "2026-04-19",
  };
  const { ok } = validateRunbook(rb);
  assert.equal(ok, true);
});

test("validateRunbook: rejects unknown flow value type", () => {
  const rb = { version: 1, id: "x", title: "x", units: ["a"], flow: 42 };
  const { ok } = validateRunbook(rb);
  assert.equal(ok, false);
});

test("validateRunbook: rejects bad regex in match", () => {
  const rb = { version: 1, id: "x", title: "x", units: ["a"], match: ["/[unclosed/"] };
  const { ok, errors } = validateRunbook(rb);
  assert.equal(ok, false);
  assert.ok(errors.some(e => /regex/i.test(e)));
});

// ─── parseRunbook ────────────────────────────────────────────────

test("parseRunbook: wraps validation errors", () => {
  const { ok, errors } = parseRunbook("/tmp/foo.md", "---\nversion: 1\n---\nbody");
  assert.equal(ok, false);
  assert.ok(errors.length > 0);
});

test("parseRunbook: returns runbook with body", () => {
  const src = `---
version: 1
id: add-feature
title: Add Feature
tags: [build]
match:
  - add feature
units:
  - plan
  - build
---
# How this runbook works
body text`;
  const { ok, runbook } = parseRunbook("/tmp/add.md", src);
  assert.equal(ok, true);
  assert.equal(runbook.id, "add-feature");
  assert.ok(runbook.body.includes("How this runbook works"));
  assert.equal(runbook._path, "/tmp/add.md");
});

// ─── loadRunbooks ────────────────────────────────────────────────

test("loadRunbooks: missing dir returns []", () => {
  const { dir, cleanup } = sandbox();
  try {
    const res = loadRunbooks(join(dir, "nope"));
    assert.deepEqual(res, []);
  } finally { cleanup(); }
});

test("loadRunbooks: loads valid runbooks, skips invalid with WARN", () => {
  const { dir, cleanup } = sandbox();
  const origErr = console.error;
  const captured = [];
  console.error = (...args) => captured.push(args.join(" "));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "good.md"), `---
version: 1
id: good
title: Good
units: [plan]
---
body`);
    writeFileSync(join(dir, "bad.md"), `---
version: 99
id: bad
---
broken`);
    writeFileSync(join(dir, "notes.txt"), "ignored (wrong ext)");

    const res = loadRunbooks(dir);
    assert.equal(res.length, 1);
    assert.equal(res[0].runbook.id, "good");
    assert.ok(captured.some(l => /WARN/.test(l) && /bad\.md/.test(l)));
  } finally {
    console.error = origErr;
    cleanup();
  }
});

test("loadRunbooks: ignores non-.md files", () => {
  const { dir, cleanup } = sandbox();
  try {
    writeFileSync(join(dir, "a.json"), "{}");
    writeFileSync(join(dir, "a.md"), `---
version: 1
id: a
title: A
units: [x]
---`);
    const res = loadRunbooks(dir);
    assert.equal(res.length, 1);
    assert.equal(res[0].runbook.id, "a");
  } finally { cleanup(); }
});

test("loadRunbooks: duplicate id → second is skipped with WARN", () => {
  const { dir, cleanup } = sandbox();
  const origErr = console.error;
  const captured = [];
  console.error = (...a) => captured.push(a.join(" "));
  try {
    writeFileSync(join(dir, "a.md"), `---
version: 1
id: dup
title: First
units: [x]
---`);
    writeFileSync(join(dir, "b.md"), `---
version: 1
id: dup
title: Second
units: [x]
---`);
    const res = loadRunbooks(dir);
    assert.equal(res.length, 1);
    assert.ok(captured.some(l => /duplicate/i.test(l)));
  } finally {
    console.error = origErr;
    cleanup();
  }
});

// ─── matchRunbook ────────────────────────────────────────────────

function mkRB(id, match = [], tags = []) {
  return {
    _path: `/tmp/${id}.md`,
    runbook: { version: 1, id, title: id, match, tags, units: ["x"] },
  };
}

test("matchRunbook: empty task → no match", () => {
  const rbs = [mkRB("a", ["add feature"])];
  const { runbook, score } = matchRunbook("", rbs);
  assert.equal(runbook, null);
  assert.equal(score, 0);
});

test("matchRunbook: no runbooks → no match", () => {
  const { runbook } = matchRunbook("add a feature", []);
  assert.equal(runbook, null);
});

test("matchRunbook: whole-word keyword beats substring", () => {
  const rbs = [
    mkRB("sub", ["add"]),                  // substring-ish
    mkRB("whole", ["add a feature"]),      // whole phrase in task
  ];
  const { runbook } = matchRunbook("please add a feature to the app", rbs);
  assert.equal(runbook.id, "whole");
});

test("matchRunbook: 'add' alone should NOT match 'address'", () => {
  const rbs = [mkRB("a", ["add"])];
  const { runbook, score } = matchRunbook("please update the address book", rbs);
  assert.equal(runbook, null, "whole-word 'add' must not match 'address'");
  assert.equal(score, 0);
});

test("matchRunbook: case-insensitive keyword match", () => {
  const rbs = [mkRB("a", ["Add Feature"])];
  const { runbook } = matchRunbook("ADD feature plz", rbs);
  assert.equal(runbook.id, "a");
});

test("matchRunbook: regex pattern /^implement /i matches", () => {
  const rbs = [mkRB("impl", ["/^implement /i"])];
  const { runbook } = matchRunbook("Implement a login flow", rbs);
  assert.equal(runbook.id, "impl");
});

test("matchRunbook: tags contribute when task mentions a tag", () => {
  const rbs = [mkRB("b", [], ["refactor"])];
  const { runbook, score } = matchRunbook("refactor the auth module", rbs);
  assert.equal(runbook.id, "b");
  assert.ok(score > 0);
});

test("matchRunbook: tie-breaker — more patterns matched wins", () => {
  const rbs = [
    mkRB("one", ["foo"]),
    mkRB("two", ["foo", "bar"]),
  ];
  const { runbook } = matchRunbook("do foo and bar", rbs);
  assert.equal(runbook.id, "two");
});

test("matchRunbook: alphabetical tie-break when scores equal", () => {
  const rbs = [
    mkRB("zeta", ["foo"]),
    mkRB("alpha", ["foo"]),
  ];
  const { runbook } = matchRunbook("foo it up", rbs);
  assert.equal(runbook.id, "alpha");
});

test("matchRunbook: no match returns {runbook:null, score:0, matches:[]}", () => {
  const rbs = [mkRB("a", ["xyz"])];
  const res = matchRunbook("nothing relevant here", rbs);
  assert.equal(res.runbook, null);
  assert.equal(res.score, 0);
  assert.deepEqual(res.matches, []);
});

test("matchRunbook: matches[] lists the patterns that fired", () => {
  const rbs = [mkRB("a", ["add feature", "login"])];
  const { matches } = matchRunbook("add feature for login flow", rbs);
  assert.ok(matches.includes("add feature"));
  assert.ok(matches.includes("login"));
});

test("matchRunbook: malformed regex in match is treated as literal (graceful)", () => {
  // validateRunbook rejects bad regex at load time. But if somehow one
  // slipped past, matcher should not throw.
  const rbs = [mkRB("a", ["/[unclosed/"])];
  const res = matchRunbook("nothing", rbs);
  assert.equal(res.runbook, null); // no throw
});

// ─── RUNBOOK_SCHEMA_VERSION constant exported ────────────────────

test("RUNBOOK_SCHEMA_VERSION is 1", () => {
  assert.equal(RUNBOOK_SCHEMA_VERSION, 1);
});
