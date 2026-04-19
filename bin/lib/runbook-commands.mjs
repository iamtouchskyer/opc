// runbook-commands.mjs — CLI commands for OPC runbook mechanism
//
// Sub-commands:
//   opc-harness runbook list [--dir <path>]
//   opc-harness runbook show <id> [--dir <path>]
//   opc-harness runbook match <task...> [--dir <path>]
//
// --dir (or OPC_RUNBOOKS_DIR env var, or ~/.opc/runbooks/) selects the
// source directory. All output is JSON to stdout.

import { homedir } from "os";
import { join, resolve } from "path";
import { loadRunbooks, matchRunbook } from "./runbooks.mjs";
import { getFlag } from "./util.mjs";

function resolveRunbookDir(args) {
  const fromFlag = getFlag(args, "dir");
  if (fromFlag) return resolve(fromFlag);
  if (process.env.OPC_RUNBOOKS_DIR) return resolve(process.env.OPC_RUNBOOKS_DIR);
  return join(homedir(), ".opc", "runbooks");
}

function summarize(rb) {
  return {
    id: rb.id,
    title: rb.title,
    tags: rb.tags || [],
    match: rb.match || [],
    flow: rb.flow || null,
    tier: rb.tier || null,
    units: rb.units,
    path: rb._path,
  };
}

function printHelp() {
  console.error("Usage:");
  console.error("  opc-harness runbook list [--dir <path>]");
  console.error("  opc-harness runbook show <id> [--dir <path>]");
  console.error("  opc-harness runbook match <task...> [--dir <path>]");
  console.error("");
  console.error("Env: OPC_RUNBOOKS_DIR overrides the default ~/.opc/runbooks/");
}

export function cmdRunbook(args) {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    if (!sub) process.exit(1);
    return;
  }

  if (sub === "list")   return runbookList(rest);
  if (sub === "show")   return runbookShow(rest);
  if (sub === "match")  return runbookMatch(rest);

  console.error(`Unknown runbook sub-command: ${sub}`);
  printHelp();
  process.exit(1);
}

function runbookList(args) {
  const dir = resolveRunbookDir(args);
  const entries = loadRunbooks(dir);
  const payload = {
    dir,
    count: entries.length,
    runbooks: entries.map(e => summarize(e.runbook)),
  };
  console.log(JSON.stringify(payload, null, 2));
}

function runbookShow(args) {
  // Positional id = first non-flag token not preceded by --dir.
  let id = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dir") { i++; continue; }
    if (a.startsWith("--")) continue;
    id = a;
    break;
  }
  if (!id) {
    console.error("Usage: opc-harness runbook show <id> [--dir <path>]");
    process.exit(1);
  }
  const dir = resolveRunbookDir(args);
  const entries = loadRunbooks(dir);
  const entry = entries.find(e => e.runbook.id === id);
  if (!entry) {
    console.error(`No runbook with id '${id}' in ${dir}`);
    process.exit(2);
  }
  console.log(JSON.stringify({
    ...summarize(entry.runbook),
    body: entry.runbook.body || "",
  }, null, 2));
}

function runbookMatch(args) {
  // Task = all positional args joined. Strip --dir and its value.
  const taskParts = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") { i++; continue; }
    if (args[i].startsWith("--")) continue;
    taskParts.push(args[i]);
  }
  const task = taskParts.join(" ").trim();
  if (!task) {
    console.error("Usage: opc-harness runbook match <task...> [--dir <path>]");
    process.exit(1);
  }
  const dir = resolveRunbookDir(args);
  const entries = loadRunbooks(dir);
  const result = matchRunbook(task, entries);
  const payload = {
    task,
    dir,
    matched: !!result.runbook,
    score: result.score,
    patterns: result.matches,
    runbook: result.runbook ? summarize(result.runbook) : null,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (!result.runbook) process.exit(3);
}
