// runbook-commands.mjs — CLI commands for OPC runbook mechanism
//
// Sub-commands:
//   opc-harness runbook list [--dir <path>]
//   opc-harness runbook show <id> [--dir <path>]
//   opc-harness runbook match <task...> [--dir <path>]
//
// --dir (or OPC_RUNBOOKS_DIR env var, or ~/.opc/runbooks/) selects the
// source directory. All output is JSON to stdout.
//
// Note: cmdRunbook is sync — no I/O awaits. Peer commands like
// cmdExtensionTest are async because they read fixtures / invoke extension
// handlers; runbook commands only do readFileSync. Don't "fix" to async.

import { homedir } from "os";
import { join, resolve } from "path";
import { loadRunbooks, matchRunbook } from "./runbooks.mjs";
import { getFlag } from "./util.mjs";

const KNOWN_FLAGS = new Set(["--dir", "--help", "-h"]);

function resolveRunbookDir(args) {
  const fromFlag = getFlag(args, "dir");
  if (fromFlag) return { dir: resolve(fromFlag), explicit: true };
  if (process.env.OPC_RUNBOOKS_DIR) return { dir: resolve(process.env.OPC_RUNBOOKS_DIR), explicit: true };
  return { dir: join(homedir(), ".opc", "runbooks"), explicit: false };
}

function summarize(rb) {
  // Emit every scalar/array field except the loader-internal _path and
  // the large body string. Keeping this full-fidelity so `runbook show`
  // reports everything the schema defines (version, protocolRefs,
  // createdAt, updatedAt included).
  const out = {};
  for (const [k, v] of Object.entries(rb)) {
    if (k === "_path" || k === "body") continue;
    out[k] = v;
  }
  out.path = rb._path;
  return out;
}

function printHelp() {
  console.error("Usage:");
  console.error("  opc-harness runbook list [--dir <path>]");
  console.error("  opc-harness runbook show <id> [--dir <path>]");
  console.error("  opc-harness runbook match <task...> [--dir <path>]");
  console.error("");
  console.error("Env:");
  console.error("  OPC_RUNBOOKS_DIR        override the default ~/.opc/runbooks/");
  console.error("  OPC_DISABLE_RUNBOOKS=1  force `match` to miss without scanning disk");
  console.error("Exit codes: 0 ok, 1 usage, 2 show-not-found, 3 match-miss");
}

function checkUnknownFlags(args, allowed = KNOWN_FLAGS) {
  // Mirrors the unknown-flag guard added in U5.6r (ext-commands.mjs).
  // Silently dropped flags are a footgun — typos like `--dri` silently
  // produced empty results, which is exactly what `match` is supposed
  // to diagnose. Fail loudly.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const name = a.split("=")[0];
    if (!allowed.has(name)) {
      console.error(`Unknown flag: ${a}`);
      printHelp();
      process.exit(1);
    }
    // Skip the value of a flag that takes one.
    if (a === "--dir" && !a.includes("=")) i++;
  }
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
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  checkUnknownFlags(args);
  const { dir, explicit } = resolveRunbookDir(args);
  const entries = loadRunbooks(dir, { explicit });
  const payload = {
    dir,
    count: entries.length,
    runbooks: entries.map(e => summarize(e.runbook)),
  };
  console.log(JSON.stringify(payload, null, 2));
}

function runbookShow(args) {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  checkUnknownFlags(args);
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
  const { dir, explicit } = resolveRunbookDir(args);
  const entries = loadRunbooks(dir, { explicit });
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
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  // OPC_DISABLE_RUNBOOKS=1 short-circuits to match-miss without scanning
  // disk. Documented escape hatch (loop-protocol Step 0 / docs/runbooks.md)
  // for users who want to force fresh decomposition. Any other value
  // (including "0", empty, or unset) leaves matching enabled — strict "1"
  // gate matches how OPC_DISABLE_EXTENSIONS works.
  if (process.env.OPC_DISABLE_RUNBOOKS === "1") {
    const taskParts = [];
    let sawEoO = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!sawEoO && a === "--") { sawEoO = true; continue; }
      if (!sawEoO && a === "--dir") { i++; continue; }
      if (!sawEoO && a.startsWith("--")) continue;
      taskParts.push(a);
    }
    console.log(JSON.stringify({
      task: taskParts.join(" ").trim(),
      dir: null,
      matched: false,
      score: 0,
      patterns: [],
      runbook: null,
      disabled: true,
    }, null, 2));
    process.exit(3);
  }
  // `match` reserves --dir and --help as flags. Everything else, including
  // --foo tokens, is rejected loudly (not swallowed into the task). Users
  // who literally want `--foo` as task text can use `--` end-of-options.
  let sawEndOfOpts = false;
  const taskParts = [];
  const flagArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!sawEndOfOpts && a === "--") { sawEndOfOpts = true; continue; }
    if (!sawEndOfOpts && a === "--dir") {
      flagArgs.push(a);
      if (i + 1 < args.length) flagArgs.push(args[++i]);
      continue;
    }
    if (!sawEndOfOpts && a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      printHelp();
      process.exit(1);
    }
    taskParts.push(a);
  }
  const task = taskParts.join(" ").trim();
  if (!task) {
    console.error("Usage: opc-harness runbook match <task...> [--dir <path>]");
    process.exit(1);
  }
  const { dir, explicit } = resolveRunbookDir(flagArgs);
  const entries = loadRunbooks(dir, { explicit });
  const result = matchRunbook(task, entries);
  const payload = {
    task,
    dir,
    matched: !!result.runbook,
    score: result.score,
    // Note: internally `matchRunbook` returns `matches: [...]`; we expose
    // it as `patterns` because that's the user-facing vocabulary (match
    // entries from the runbook frontmatter). Keep both names in sync if
    // adjusting either side.
    patterns: result.matches,
    runbook: result.runbook ? summarize(result.runbook) : null,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (!result.runbook) process.exit(3);
}
