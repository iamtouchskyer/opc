// hook.mjs — starter extension template.
// The loader reads `meta` from THIS file (not ext.json). The extension's
// canonical name is the DIRECTORY NAME on disk — rename the dir to rename
// the extension.
// Every hook returns its graceful-empty value by default so
// `opc-harness extension-test --all-hooks` exits 0 right after copy-paste.
//
// Only node builtins are imported here. Add your own deps in package.json
// inside this directory if you need them.

export const meta = {
  // The capability YOU provide. Nodes with this in `nodeCapabilities` fire your hooks.
  provides: ["my-capability@1"],
  // Older capability generations you still want to match (migration aid).
  // Keep `[]` until you actually need it — a real value like "verification@1"
  // will silently fire this (stub) extension on every verification@1 node
  // in the pipeline. Change this to match the nodes you want to fire on.
  compatibleCapabilities: [],
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
  // TODO(starter): inspect ctx.task / ctx.runDir / ctx.devServerUrl and push
  // findings into the array. For file-scanning hooks you may want to
  // `if (!ctx?.runDir) return [];` early — skip that guard for task-string
  // checks (e.g. scanning ctx.task for "FIXME").
  //
  // Note: pipelines guarantee ctx.task is a string (possibly ""), but
  // `extension-test --context <json>` passes the JSON through verbatim.
  // For any schema-typed field, prefer a `typeof` guard over `?? ""`:
  //   const task = typeof ctx?.task === "string" ? ctx.task : "";
  const findings = [];
  return findings;
}

/**
 * execute.run — fires during the executor phase, BEFORE artifact.emit.
 * Use this for side effects: hit a dev server, run Playwright, scan files.
 * Return value is accepted but not consumed by the pipeline — use this
 * hook for side effects only. Throw → counted as a failure (circuit breaker).
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
 * @returns {Promise<Array<{name:string, content: string|Buffer|ArrayBufferView}>>}
 *   `name` must equal basename(name) — no slashes, no "..", no empty.
 *   `content` must be string | Buffer | ArrayBufferView (Uint8Array, DataView,
 *   other TypedArrays). NOT raw ArrayBuffer, NOT Blob, NOT unawaited Promise.
 *   Core guards name + content and WARNs-and-skips bad entries.
 */
export async function artifactEmit(ctx) {
  if (!ctx?.runDir) return [];
  // TODO(starter): push {name, content} objects here.
  return [];
}
