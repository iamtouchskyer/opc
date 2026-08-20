import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { join, resolve } from "path";
import { appendProvenanceEvent } from "./provenance-ledger.mjs";
import { compareRunIds } from "./run-id.mjs";

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
    .sort((a, b) => compareRunIds(b.name, a.name));
  return runs[0] ? join(nodeDir, runs[0].name) : null;
}

function runDirFor(nodeDir, runId) {
  if (typeof runId !== "string" || !/^run_\d+$/.test(runId)) return null;
  const dir = join(nodeDir, runId);
  return existsSync(dir) ? dir : null;
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

function readRunBoundJson(path, runId) {
  const data = readJson(path);
  if (!data) return null;
  if (runId && data.runId !== runId) return null;
  return data;
}

function sourcePlanHash(sessionDir, nodeId, runId = null) {
  const nodeDir = join(sessionDir, "nodes", nodeId);
  const runDir = runId ? runDirFor(nodeDir, runId) : latestRunDir(nodeDir);
  const handshake = readRunBoundJson(join(nodeDir, "handshake.json"), runId);
  const candidates = runId
    ? [
      runDir ? join(runDir, "test-plan.md") : null,
      planPathFromHandshake(nodeDir, handshake),
    ].filter(Boolean)
    : [
      runDir ? join(runDir, "test-plan.md") : null,
      planPathFromHandshake(nodeDir, handshake),
      join(nodeDir, "test-plan.md"),
    ].filter(Boolean);
  for (const path of candidates) {
    const text = readText(path);
    if (text != null) return sha256(text);
  }
  return null;
}

export function loadTestCommandSpec(sessionDir, nodeId, runId = null) {
  const nodeDir = join(sessionDir, "nodes", nodeId);
  const runDir = runId ? runDirFor(nodeDir, runId) : latestRunDir(nodeDir);
  const candidates = runId
    ? [
      runDir ? join(runDir, "test-execution.json") : null,
      runDir ? join(runDir, "handshake.json") : null,
      join(nodeDir, "test-execution.json"),
      join(nodeDir, "handshake.json"),
    ].filter(Boolean)
    : [
      join(nodeDir, "test-execution.json"),
      runDir ? join(runDir, "test-execution.json") : null,
      runDir ? join(runDir, "handshake.json") : null,
      join(nodeDir, "handshake.json"),
    ].filter(Boolean);
  for (const path of candidates) {
    const spec = commandSpecFrom(readRunBoundJson(path, runId));
    if (spec) return { ...spec, sourcePlanHash: sourcePlanHash(sessionDir, nodeId, runId) };
  }
  return null;
}

export function collectTestCommandBindingReasons(sessionDir, nodeId, runId) {
  if (!runId) return [];
  const nodeDir = join(sessionDir, "nodes", nodeId);
  const reasons = [];
  const spec = loadTestCommandSpec(sessionDir, nodeId, runId);
  if (!spec) {
    reasons.push(`${nodeId}/${runId}: testCommand spec not found`);
  } else if (typeof spec.sourcePlanHash !== "string" || spec.sourcePlanHash.length === 0) {
    reasons.push(`${nodeId}/${runId}: source test-plan hash missing`);
  }
  for (const name of ["test-execution.json", "handshake.json"]) {
    const path = join(nodeDir, name);
    if (!existsSync(path)) continue;
    const data = readJson(path);
    if (!data || !commandSpecFrom(data)) continue;
    if (data.nodeId && data.nodeId !== nodeId) {
      reasons.push(`${nodeId}/${name} nodeId '${data.nodeId}' does not match '${nodeId}'`);
    }
    if (data.runId !== runId) {
      reasons.push(`${nodeId}/${name} runId '${data.runId}' does not match selected source run '${runId}'`);
    }
  }
  return reasons;
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

function writeResultFiles(runDir, spec, result, cwdInfo, sourceNode, sourceRunId) {
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
      sourceNode,
      sourceRunId,
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
  const resultText = JSON.stringify(json, null, 2) + "\n";
  writeFileSync(join(runDir, "test-command-result.json"), resultText);
  writeFileSync(join(runDir, "test-command-output.txt"),
    [`$ ${spec.testCommand}`, `cwd: ${cwdInfo.cwd}`, `cwdSource: ${cwdInfo.source}`, `exitCode: ${exitCode}`, "", stdout, stderr].join("\n"));
  return { exitCode, timedOut: json.timedOut, resultHash: sha256(resultText) };
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

export function executeTestCommand(sessionDir, targetNode, runId, sourceNode, sourceRunId = null) {
  if (!/^run_\d+$/.test(sourceRunId || "")) return null;
  const spec = loadTestCommandSpec(sessionDir, sourceNode, sourceRunId);
  if (!spec) return null;
  const runDir = join(sessionDir, "nodes", targetNode, runId);
  mkdirSync(runDir, { recursive: true });
  const cwdInfo = commandCwd(spec);
  const result = runTestCommand(spec, cwdInfo.cwd);
  const summary = writeResultFiles(runDir, spec, result, cwdInfo, sourceNode, sourceRunId);
  const verdict = summary.exitCode === 0 ? "PASS" : "FAIL";
  const commandHash = testCommandHash(spec.testCommand);
  const ledger = appendProvenanceEvent(sessionDir, {
    eventType: "test-command-result",
    nodeId: targetNode,
    runId,
    sourceNode,
    sourceRunId,
    commandHash,
    sourcePlanHash: spec.sourcePlanHash,
    resultHash: summary.resultHash,
    resultPath: `nodes/${targetNode}/${runId}/test-command-result.json`,
    exitCode: summary.exitCode,
  });
  const testEvidenceProvenance = {
    kind: "opc-test-command",
    sourceNode,
    sourceRunId,
    commandHash,
    sourcePlanHash: spec.sourcePlanHash,
    resultHash: summary.resultHash,
    executionActor: EXECUTION_ACTOR,
    ledger,
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
  writeFileSync(join(runDir, "handshake.json"), JSON.stringify({
    ...handshake,
    artifacts: [
      { type: "test-result", path: "test-command-result.json" },
      { type: "cli-output", path: "test-command-output.txt" },
    ],
  }, null, 2) + "\n");
  return { executed: true, verdict, exitCode: summary.exitCode, cwd: cwdInfo.cwd, cwdSource: cwdInfo.source, resultPath: join(runDir, "test-command-result.json") };
}
