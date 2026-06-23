import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { join, resolve } from "path";

const EXECUTION_ACTOR = "opc-harness:test-command";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function latestRunDir(nodeDir) {
  if (!existsSync(nodeDir)) return null;
  const runs = readdirSync(nodeDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^run_\d+$/.test(entry.name))
    .sort((a, b) => Number(b.name.slice(4)) - Number(a.name.slice(4)));
  return runs[0] ? join(nodeDir, runs[0].name) : null;
}

function commandSpecFrom(data) {
  if (!data || typeof data.testCommand !== "string" || data.testCommand.trim() === "") return null;
  return {
    testCommand: data.testCommand.trim(),
    prerequisites: Array.isArray(data.prerequisites) ? data.prerequisites : [],
    allowVacuousChecks: Array.isArray(data.allowVacuousChecks) ? data.allowVacuousChecks : [],
    cwd: typeof data.cwd === "string" && data.cwd ? data.cwd : null,
    timeoutMs: Number.isInteger(data.timeoutMs) ? data.timeoutMs : 120000,
  };
}

export function testCommandHash(command) {
  return createHash("sha256").update(command).digest("hex");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function planPathFromHandshake(nodeDir, handshake) {
  if (!Array.isArray(handshake?.artifacts)) return null;
  const art = handshake.artifacts.find(a => a?.type === "test-plan" && typeof a.path === "string");
  return art ? join(nodeDir, art.path) : null;
}

function sourcePlanHash(sessionDir, nodeId) {
  const nodeDir = join(sessionDir, "nodes", nodeId);
  const runDir = latestRunDir(nodeDir);
  const handshake = readJson(join(nodeDir, "handshake.json"));
  const candidates = [
    planPathFromHandshake(nodeDir, handshake),
    runDir ? join(runDir, "test-plan.md") : null,
    join(nodeDir, "test-plan.md"),
  ].filter(Boolean);
  for (const path of candidates) {
    const text = readText(path);
    if (text != null) return sha256(text);
  }
  return null;
}

export function loadTestCommandSpec(sessionDir, nodeId) {
  const nodeDir = join(sessionDir, "nodes", nodeId);
  const runDir = latestRunDir(nodeDir);
  const candidates = [
    join(nodeDir, "test-execution.json"),
    join(nodeDir, "handshake.json"),
    runDir ? join(runDir, "test-execution.json") : null,
    runDir ? join(runDir, "handshake.json") : null,
  ].filter(Boolean);
  for (const path of candidates) {
    const spec = commandSpecFrom(readJson(path));
    if (spec) return { ...spec, sourcePlanHash: sourcePlanHash(sessionDir, nodeId) };
  }
  return null;
}

function trimOutput(value) {
  const text = String(value || "");
  return text.length > 20000 ? text.slice(-20000) : text;
}

function commandNeedsJsProject(command) {
  return /\b(npm|npx|pnpm|yarn|node|vitest|jest|playwright)\b/i.test(command);
}

function packageMentions(path, pattern) {
  const data = readJson(path);
  const sections = ["dependencies", "devDependencies", "optionalDependencies"];
  return sections.some(section => Object.keys(data?.[section] || {}).some(name => pattern.test(name)));
}

function hasJsProjectSupport(dir, command) {
  if (/playwright/i.test(command)) {
    return existsSync(join(dir, "playwright.config.js"))
      || existsSync(join(dir, "playwright.config.ts"))
      || existsSync(join(dir, "node_modules", ".bin", "playwright"))
      || packageMentions(join(dir, "package.json"), /playwright/i);
  }
  return existsSync(join(dir, "package.json")) || existsSync(join(dir, "node_modules"));
}

function findJsProjectDirs(root, depth = 3) {
  if (depth < 0 || !existsSync(root)) return [];
  const found = hasJsProjectSupport(root, "") ? [root] : [];
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory() || /^(\.git|node_modules|\.opc|\.harness)/.test(entry.name)) continue;
    found.push(...findJsProjectDirs(join(root, entry.name), depth - 1));
  }
  return found;
}

function commandCwd(spec) {
  if (spec.cwd) {
    const cwd = spec.cwd.startsWith("/") ? spec.cwd : resolve(process.cwd(), spec.cwd);
    return { cwd, source: "explicit" };
  }
  const base = process.cwd();
  if (!commandNeedsJsProject(spec.testCommand) || hasJsProjectSupport(base, spec.testCommand)) {
    return { cwd: base, source: "process-cwd" };
  }
  const matches = findJsProjectDirs(base).filter(dir => hasJsProjectSupport(dir, spec.testCommand));
  return matches.length === 1
    ? { cwd: matches[0], source: "auto-js-project" }
    : { cwd: base, source: "process-cwd" };
}

function writeResultFiles(runDir, spec, result, cwdInfo) {
  const stdout = trimOutput(result.stdout);
  const stderrText = result.error?.message ? `${result.stderr || ""}\n${result.error.message}` : result.stderr;
  const stderr = trimOutput(stderrText);
  const exitCode = result.status == null ? 1 : result.status;
  const commandHash = testCommandHash(spec.testCommand);
  const json = {
    testCommand: spec.testCommand,
    prerequisites: spec.prerequisites,
    cwd: cwdInfo.cwd,
    cwdSource: cwdInfo.source,
    provenance: {
      kind: "opc-test-command",
      commandHash,
      sourcePlanHash: spec.sourcePlanHash,
      executionActor: EXECUTION_ACTOR,
    },
    exitCode,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    stdout,
    stderr,
    test_fail_count: exitCode === 0 ? 0 : 1,
  };
  writeFileSync(join(runDir, "test-command-result.json"), JSON.stringify(json, null, 2) + "\n");
  writeFileSync(join(runDir, "test-command-output.txt"),
    [`$ ${spec.testCommand}`, `cwd: ${cwdInfo.cwd}`, `cwdSource: ${cwdInfo.source}`, `exitCode: ${exitCode}`, "", stdout, stderr].join("\n"));
  return { exitCode, timedOut: json.timedOut };
}

function runTestCommand(spec, cwd) {
  try {
    return spawnSync("sh", ["-c", spec.testCommand], {
      cwd, encoding: "utf8", timeout: spec.timeoutMs,
    });
  } catch (err) {
    return {
      status: 1,
      stdout: "",
      stderr: `testCommand spawn failed: ${err.message}`,
      error: { code: err.code || "SPAWN_ERROR" },
    };
  }
}

export function executeTestCommand(sessionDir, targetNode, runId, sourceNode) {
  const spec = loadTestCommandSpec(sessionDir, sourceNode);
  if (!spec) return null;
  const runDir = join(sessionDir, "nodes", targetNode, runId);
  mkdirSync(runDir, { recursive: true });
  const cwdInfo = commandCwd(spec);
  const result = runTestCommand(spec, cwdInfo.cwd);
  const summary = writeResultFiles(runDir, spec, result, cwdInfo);
  const verdict = summary.exitCode === 0 ? "PASS" : "FAIL";
  const testEvidenceProvenance = {
    kind: "opc-test-command",
    sourceNode,
    commandHash: testCommandHash(spec.testCommand),
    sourcePlanHash: spec.sourcePlanHash,
    executionActor: EXECUTION_ACTOR,
  };
  const handshake = {
    nodeId: targetNode,
    nodeType: "execute",
    runId,
    status: "completed",
    verdict,
    summary: `testCommand exitCode=${summary.exitCode}`,
    timestamp: new Date().toISOString(),
    artifacts: [
      { type: "test-result", path: `${runId}/test-command-result.json` },
      { type: "cli-output", path: `${runId}/test-command-output.txt` },
    ],
    testCommand: spec.testCommand,
    testCommandCwd: cwdInfo.cwd,
    testCommandCwdSource: cwdInfo.source,
    prerequisites: spec.prerequisites,
    testEvidenceProvenance,
    testEvidencePolicy: {
      allowVacuousChecks: spec.allowVacuousChecks,
    },
  };
  writeFileSync(join(sessionDir, "nodes", targetNode, "handshake.json"), JSON.stringify(handshake, null, 2) + "\n");
  return { executed: true, verdict, exitCode: summary.exitCode, cwd: cwdInfo.cwd, cwdSource: cwdInfo.source, resultPath: join(runDir, "test-command-result.json") };
}
