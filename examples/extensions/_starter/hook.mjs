// hook.mjs — starter extension template.
// Replace the name + capability in ext.json, then edit each hook below.
// Every hook returns its graceful-empty value by default so
// `opc-harness extension-test --all-hooks` exits 0 right after copy-paste.
//
// Only node builtins are imported here. Add your own deps in package.json
// inside this directory if you need them.

import { basename } from "node:path";

export const meta = {
  provides: ["my-capability@1"],
  compatibleCapabilities: ["verification@1"],
  description: "Starter template — replace this string.",
};

/**
 * startup.check — runs ONCE at extension load time.
 * A throw here disables this extension for the whole process (FATAL if the
 * extension is listed in config.requiredExtensions). Keep it < 100 ms,
 * no network, no heavy I/O.
 * @returns {void}
 */
export function startupCheck() {
  // TODO(starter): probe prerequisites (env vars, CLI binaries on PATH, files).
  // Missing prerequisites → write ONE stderr WARN line and return — DO NOT throw.
  return undefined;
}

/**
 * prompt.append — fires while building a node's role prompt.
 * Core calls this when the current node's `nodeCapabilities` intersects
 * `meta.provides ∪ meta.compatibleCapabilities`.
 * @param {{
 *   task?: string,            // task description (may be empty)
 *   role?: string,            // "builder" | "evaluator" | "executor"
 *   node?: string,            // current node id
 *   flowDir?: string,         // absolute .harness root
 *   runDir?: string,          // absolute current run dir (may be undefined)
 *   devServerUrl?: string,    // "" if none configured
 *   nodeCapabilities?: string[],
 * }} ctx
 * @returns {Promise<string>|string} markdown to append, or "" for no-op.
 */
export async function promptAppend(ctx) {
  const task = ctx?.task ?? "";
  if (!task) return "";
  // TODO(starter): build a markdown section from ctx.task / ctx.role / ctx.flowDir
  // and return it. Return "" when there is nothing useful to contribute.
  return "";
}

/**
 * verdict.append — fires during the evaluator phase.
 * Return an array of findings; each finding renders into eval-extensions.md.
 * Finding shape: { severity: "error"|"warning"|"info", category: string,
 *                  message: string, file?: string }.
 * Wrong-shaped findings are silently dropped.
 * @param {{
 *   task?: string,
 *   node?: string,
 *   runDir?: string,
 *   devServerUrl?: string,
 *   nodeCapabilities?: string[],
 * }} ctx
 * @returns {Promise<Array<{severity:string,category:string,message:string,file?:string}>>}
 */
export async function verdictAppend(ctx) {
  if (!ctx?.runDir) return [];
  // TODO(starter): inspect runDir / devServerUrl, push findings into the array.
  const findings = [];
  return findings;
}

/**
 * execute.run — fires during the executor phase, BEFORE artifact.emit.
 * Use this for side effects: hit a dev server, run Playwright, scan files.
 * Return value is not consumed. Throw → counted as a failure (circuit breaker).
 * @param {{
 *   runDir?: string,
 *   devServerUrl?: string,
 *   nodeCapabilities?: string[],
 * }} ctx
 * @returns {Promise<void>}
 */
export async function executeRun(ctx) {
  if (!ctx?.devServerUrl) return;
  // TODO(starter): perform side-effectful checks. Always pipe AbortSignal.timeout()
  // into spawn / fetch / Playwright so they clean themselves up on the core's
  // 60 s safety-net timeout.
  return;
}

/**
 * artifact.emit — fires during the executor phase, AFTER execute.run.
 * Each item lands at <runDir>/ext-<extname>/<name>.
 * @param {{ runDir?: string, devServerUrl?: string, nodeCapabilities?: string[] }} ctx
 * @returns {Promise<Array<{name:string, content: string|Buffer|Uint8Array}>>}
 */
export async function artifactEmit(ctx) {
  if (!ctx?.runDir) return [];
  // TODO(starter): produce files. `name` must equal basename(name) — no slashes,
  // no "..", no empty strings. `content` must be string | Buffer | TypedArray
  // (NOT raw ArrayBuffer, NOT Blob, NOT unawaited Promise).
  const items = [];
  for (const it of items) {
    if (it && typeof it.name === "string" && basename(it.name) !== it.name) {
      // Defensive: skip anything that wouldn't survive the loader's name guard.
      continue;
    }
  }
  return items;
}
