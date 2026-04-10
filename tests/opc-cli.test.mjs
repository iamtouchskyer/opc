// tests/opc-cli.test.mjs — T851-T900 (50 tests)
// Tests for opc.mjs CLI behavior via child process spawning

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, symlinkSync, lstatSync } from "fs";
import { join, dirname } from "path";
import { tmpdir, homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPC_BIN = join(__dirname, "..", "bin", "opc.mjs");
const SRC_DIR = join(__dirname, "..");
const PKG = JSON.parse(readFileSync(join(SRC_DIR, "package.json"), "utf8"));

function run(args, opts = {}) {
  try {
    const result = execFileSync("node", [OPC_BIN, ...args], {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, HOME: opts.home || tmpdir() },
      ...opts,
    });
    return { stdout: result, code: 0 };
  } catch (e) {
    return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status };
  }
}

let tmp;
let fakeHome;
let fakeSkillsDir;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "opc-cli-"));
  fakeHome = mkdtempSync(join(tmpdir(), "opc-home-"));
  fakeSkillsDir = join(fakeHome, ".claude", "skills", "opc");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// Version (T851-T855)
// ══════════════════════════════════════════════════════════════════
describe("Version", () => {
  it("T851 — opc version outputs version string", () => {
    const r = run(["version"]);
    assert.ok(r.stdout.trim() === PKG.version);
  });

  it("T852 — opc -v outputs version string", () => {
    const r = run(["-v"]);
    assert.ok(r.stdout.trim() === PKG.version);
  });

  it("T853 — opc --version outputs version string", () => {
    const r = run(["--version"]);
    assert.ok(r.stdout.trim() === PKG.version);
  });

  it("T854 — version matches package.json", () => {
    const r = run(["version"]);
    assert.equal(r.stdout.trim(), PKG.version);
  });

  it("T855 — version is semver format", () => {
    const r = run(["version"]);
    assert.ok(/^\d+\.\d+\.\d+/.test(r.stdout.trim()));
  });
});

// ══════════════════════════════════════════════════════════════════
// Help (T856-T860)
// ══════════════════════════════════════════════════════════════════
describe("Help", () => {
  it("T856 — no args shows help with Usage", () => {
    const r = run([]);
    assert.ok(r.stdout.includes("Usage"));
  });

  it("T857 — no args shows install command", () => {
    const r = run([]);
    assert.ok(r.stdout.includes("install"));
  });

  it("T858 — no args shows uninstall command", () => {
    const r = run([]);
    assert.ok(r.stdout.includes("uninstall"));
  });

  it("T859 — unknown command shows help", () => {
    const r = run(["foobar"]);
    assert.ok(r.stdout.includes("Usage"));
  });

  it("T860 — help shows version", () => {
    const r = run([]);
    assert.ok(r.stdout.includes(PKG.version));
  });
});

// ══════════════════════════════════════════════════════════════════
// Install (T861-T880)
// ══════════════════════════════════════════════════════════════════
describe("Install", () => {
  it("T861 — creates skill dir", () => {
    run(["install"], { home: fakeHome });
    assert.ok(existsSync(fakeSkillsDir));
  });

  it("T862 — copies skill.md", () => {
    run(["install"], { home: fakeHome });
    assert.ok(existsSync(join(fakeSkillsDir, "skill.md")));
  });

  it("T863 — copies package.json", () => {
    run(["install"], { home: fakeHome });
    assert.ok(existsSync(join(fakeSkillsDir, "package.json")));
  });

  it("T864 — copies bin directory", () => {
    run(["install"], { home: fakeHome });
    assert.ok(existsSync(join(fakeSkillsDir, "bin")));
  });

  it("T865 — copies roles directory", () => {
    run(["install"], { home: fakeHome });
    assert.ok(existsSync(join(fakeSkillsDir, "roles")));
  });

  it("T866 — copies pipeline directory", () => {
    run(["install"], { home: fakeHome });
    assert.ok(existsSync(join(fakeSkillsDir, "pipeline")));
  });

  it("T867 — outputs success message", () => {
    const r = run(["install"], { home: fakeHome });
    assert.ok(r.stdout.includes("installed") || r.stdout.includes("✓"));
  });

  it("T868 — outputs version in success message", () => {
    const r = run(["install"], { home: fakeHome });
    assert.ok(r.stdout.includes(PKG.version));
  });

  it("T869 — re-install updates existing files", () => {
    run(["install"], { home: fakeHome });
    // Modify a file
    writeFileSync(join(fakeSkillsDir, "skill.md"), "old content");
    run(["install"], { home: fakeHome });
    const content = readFileSync(join(fakeSkillsDir, "skill.md"), "utf8");
    assert.notEqual(content, "old content");
  });

  it("T870 — preserves non-managed files", () => {
    run(["install"], { home: fakeHome });
    writeFileSync(join(fakeSkillsDir, "custom.md"), "user file");
    run(["install"], { home: fakeHome });
    assert.ok(existsSync(join(fakeSkillsDir, "custom.md")));
  });

  it("T871 — stale files cleaned up", () => {
    // Create stale file before install
    mkdirSync(join(fakeSkillsDir, "pipeline"), { recursive: true });
    writeFileSync(join(fakeSkillsDir, "pipeline", "verification-gate.md"), "stale");
    run(["install"], { home: fakeHome });
    assert.ok(!existsSync(join(fakeSkillsDir, "pipeline", "verification-gate.md")));
  });

  it("T872 — symlink detection (already linked)", () => {
    mkdirSync(join(fakeHome, ".claude", "skills"), { recursive: true });
    symlinkSync(SRC_DIR, fakeSkillsDir);
    const r = run(["install"], { home: fakeHome });
    assert.ok(r.stdout.includes("linked") || r.stdout.includes("✓"));
  });

  it("T873 — copies replay.md if exists", () => {
    run(["install"], { home: fakeHome });
    if (existsSync(join(SRC_DIR, "replay.md"))) {
      assert.ok(existsSync(join(fakeSkillsDir, "replay.md")));
    }
  });

  it("T874 — managed entries constant covers key files", () => {
    // Verify critical managed entries are installed
    run(["install"], { home: fakeHome });
    assert.ok(existsSync(join(fakeSkillsDir, "skill.md")));
    assert.ok(existsSync(join(fakeSkillsDir, "bin")));
  });

  it("T875 — nested dir structure preserved in roles", () => {
    run(["install"], { home: fakeHome });
    const roles = readdirSync(join(fakeSkillsDir, "roles"));
    assert.ok(roles.length > 0);
  });

  it("T876 — roles include security.md", () => {
    run(["install"], { home: fakeHome });
    assert.ok(existsSync(join(fakeSkillsDir, "roles", "security.md")));
  });

  it("T877 — roles include engineer.md", () => {
    run(["install"], { home: fakeHome });
    assert.ok(existsSync(join(fakeSkillsDir, "roles", "engineer.md")));
  });

  it("T878 — install idempotent (second run succeeds)", () => {
    run(["install"], { home: fakeHome });
    const r = run(["install"], { home: fakeHome });
    assert.equal(r.code, 0);
  });

  it("T879 — mentions /opc usage in output", () => {
    const r = run(["install"], { home: fakeHome });
    assert.ok(r.stdout.includes("/opc"));
  });

  it("T880 — skill dir created recursively", () => {
    // fakeHome doesn't have .claude yet
    assert.ok(!existsSync(join(fakeHome, ".claude")));
    run(["install"], { home: fakeHome });
    assert.ok(existsSync(fakeSkillsDir));
  });
});

// ══════════════════════════════════════════════════════════════════
// Uninstall (T881-T900)
// ══════════════════════════════════════════════════════════════════
describe("Uninstall", () => {
  it("T881 — removes managed files after install", () => {
    run(["install"], { home: fakeHome });
    run(["uninstall"], { home: fakeHome });
    assert.ok(!existsSync(join(fakeSkillsDir, "skill.md")));
  });

  it("T882 — removes bin directory", () => {
    run(["install"], { home: fakeHome });
    run(["uninstall"], { home: fakeHome });
    assert.ok(!existsSync(join(fakeSkillsDir, "bin")));
  });

  it("T883 — removes pipeline directory", () => {
    run(["install"], { home: fakeHome });
    run(["uninstall"], { home: fakeHome });
    assert.ok(!existsSync(join(fakeSkillsDir, "pipeline")));
  });

  it("T884 — preserves custom roles", () => {
    run(["install"], { home: fakeHome });
    writeFileSync(join(fakeSkillsDir, "roles", "custom-role.md"), "custom");
    run(["uninstall"], { home: fakeHome });
    assert.ok(existsSync(join(fakeSkillsDir, "roles", "custom-role.md")));
  });

  it("T885 — removes managed roles", () => {
    run(["install"], { home: fakeHome });
    run(["uninstall"], { home: fakeHome });
    assert.ok(!existsSync(join(fakeSkillsDir, "roles", "security.md")));
  });

  it("T886 — missing dir shows nothing to remove", () => {
    const r = run(["uninstall"], { home: fakeHome });
    assert.ok(r.stdout.includes("Nothing to remove") || r.stdout.includes("does not exist"));
  });

  it("T887 — outputs success message", () => {
    run(["install"], { home: fakeHome });
    const r = run(["uninstall"], { home: fakeHome });
    assert.ok(r.stdout.includes("removed") || r.stdout.includes("✓"));
  });

  it("T888 — removes package.json", () => {
    run(["install"], { home: fakeHome });
    run(["uninstall"], { home: fakeHome });
    assert.ok(!existsSync(join(fakeSkillsDir, "package.json")));
  });

  it("T889 — empty skill dir removed after uninstall (or only roles remnant)", () => {
    run(["install"], { home: fakeHome });
    run(["uninstall"], { home: fakeHome });
    // skill.md and other flat files should be gone
    assert.ok(!existsSync(join(fakeSkillsDir, "skill.md")));
    assert.ok(!existsSync(join(fakeSkillsDir, "package.json")));
    assert.ok(!existsSync(join(fakeSkillsDir, "bin")));
  });

  it("T890 — skill dir kept if custom files remain", () => {
    run(["install"], { home: fakeHome });
    writeFileSync(join(fakeSkillsDir, "custom.md"), "user file");
    run(["uninstall"], { home: fakeHome });
    assert.ok(existsSync(fakeSkillsDir));
    assert.ok(existsSync(join(fakeSkillsDir, "custom.md")));
  });

  it("T891 — symlink removed on uninstall", () => {
    mkdirSync(join(fakeHome, ".claude", "skills"), { recursive: true });
    symlinkSync(SRC_DIR, fakeSkillsDir);
    run(["uninstall"], { home: fakeHome });
    assert.ok(!existsSync(fakeSkillsDir));
  });

  it("T892 — uninstall idempotent", () => {
    run(["install"], { home: fakeHome });
    run(["uninstall"], { home: fakeHome });
    const r = run(["uninstall"], { home: fakeHome });
    assert.equal(r.code, 0);
  });

  it("T893 — uninstall then install works", () => {
    run(["install"], { home: fakeHome });
    run(["uninstall"], { home: fakeHome });
    run(["install"], { home: fakeHome });
    assert.ok(existsSync(join(fakeSkillsDir, "skill.md")));
  });

  it("T894 — custom roles dir with only custom roles kept", () => {
    run(["install"], { home: fakeHome });
    writeFileSync(join(fakeSkillsDir, "roles", "my-special-role.md"), "mine");
    run(["uninstall"], { home: fakeHome });
    const remaining = readdirSync(join(fakeSkillsDir, "roles"));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0], "my-special-role.md");
  });

  it("T895 — managed role files removed after uninstall", () => {
    run(["install"], { home: fakeHome });
    run(["uninstall"], { home: fakeHome });
    // Individual managed role files should be gone
    assert.ok(!existsSync(join(fakeSkillsDir, "roles", "security.md")));
    assert.ok(!existsSync(join(fakeSkillsDir, "roles", "engineer.md")));
  });

  it("T896 — uninstall removes replay.md", () => {
    run(["install"], { home: fakeHome });
    run(["uninstall"], { home: fakeHome });
    assert.ok(!existsSync(join(fakeSkillsDir, "replay.md")));
  });

  it("T897 — partial install still uninstalls cleanly", () => {
    // Only create some managed files
    mkdirSync(fakeSkillsDir, { recursive: true });
    writeFileSync(join(fakeSkillsDir, "skill.md"), "partial");
    writeFileSync(join(fakeSkillsDir, "package.json"), "{}");
    const r = run(["uninstall"], { home: fakeHome });
    assert.ok(r.stdout.includes("removed") || r.stdout.includes("✓"));
  });

  it("T898 — uninstall preserves parent .claude/skills dir", () => {
    run(["install"], { home: fakeHome });
    run(["uninstall"], { home: fakeHome });
    assert.ok(existsSync(join(fakeHome, ".claude", "skills")));
  });

  it("T899 — install after symlink-uninstall works", () => {
    mkdirSync(join(fakeHome, ".claude", "skills"), { recursive: true });
    symlinkSync(SRC_DIR, fakeSkillsDir);
    run(["uninstall"], { home: fakeHome });
    run(["install"], { home: fakeHome });
    assert.ok(existsSync(join(fakeSkillsDir, "skill.md")));
  });

  it("T900 — managed entries count matches source", () => {
    run(["install"], { home: fakeHome });
    // Check that MANAGED_ENTRIES are all present
    const managed = ["skill.md", "roles", "pipeline", "bin", "package.json"];
    for (const entry of managed) {
      assert.ok(existsSync(join(fakeSkillsDir, entry)), `Missing: ${entry}`);
    }
  });
});
