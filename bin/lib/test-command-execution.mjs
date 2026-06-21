import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { join, resolve } from "path";

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
    cwd: typeof data.cwd === "string" && data.cwd ? data.cwd : null,
    timeoutMs: Number.isInteger(data.timeoutMs) ? data.timeoutMs : 120000,
  };
}

function commandHash(command) {
  return createHash("sha256").update(command).digest("hex");
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
    if (spec) return spec;
  }
  return null;
}

function trimOutput(value) {
  const text = String(value || "");
  return text.length > 20000 ? text.slice(-20000) : text;
}

function commandCwd(spec) {
  if (!spec.cwd) return process.cwd();
  return spec.cwd.startsWith("/") ? spec.cwd : resolve(process.cwd(), spec.cwd);
}

function writeResultFiles(runDir, spec, result, cwd) {
  const stdout = trimOutput(result.stdout);
  const stderrText = result.error?.message ? `${result.stderr || ""}\n${result.error.message}` : result.stderr;
  const stderr = trimOutput(stderrText);
  const exitCode = result.status == null ? 1 : result.status;
  const json = {
    testCommand: spec.testCommand,
    prerequisites: spec.prerequisites,
    cwd,
    provenance: {
      kind: "opc-test-command",
      commandHash: commandHash(spec.testCommand),
    },
    exitCode,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    stdout,
    stderr,
    test_fail_count: exitCode === 0 ? 0 : 1,
  };
  writeFileSync(join(runDir, "test-command-result.json"), JSON.stringify(json, null, 2) + "\n");
  writeFileSync(join(runDir, "test-command-output.txt"),
    [`$ ${spec.testCommand}`, `cwd: ${cwd}`, `exitCode: ${exitCode}`, "", stdout, stderr].join("\n"));
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
  const cwd = commandCwd(spec);
  const result = runTestCommand(spec, cwd);
  const summary = writeResultFiles(runDir, spec, result, cwd);
  const verdict = summary.exitCode === 0 ? "PASS" : "FAIL";
  const testEvidenceProvenance = {
    kind: "opc-test-command",
    sourceNode,
    commandHash: commandHash(spec.testCommand),
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
    prerequisites: spec.prerequisites,
    testEvidenceProvenance,
  };
  writeFileSync(join(sessionDir, "nodes", targetNode, "handshake.json"), JSON.stringify(handshake, null, 2) + "\n");
  return { executed: true, verdict, exitCode: summary.exitCode, resultPath: join(runDir, "test-command-result.json") };
}
