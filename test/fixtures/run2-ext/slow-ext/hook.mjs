// Run 2 fixture: slow-ext — timeout isolation
// Purpose: Prove HOOK_TIMEOUT_MS isolates one slow hook; circuit-breaker trips;
// siblings keep firing. Only startupCheck + promptAppend are defined — once the
// breaker trips on promptAppend, there are no further hooks on this extension
// to skip, but downstream extensions continue normally.

export const meta = {
  provides: ["verification@1"],
  compatibleCapabilities: [],
};

export function startupCheck() {
  // must be fast — we need this extension to LOAD so the slow hook is the thing
  // that trips the breaker, not the load path.
  return true;
}

export async function promptAppend(/* ctx */) {
  // 10s sleep — far exceeds the test-pinned OPC_HOOK_TIMEOUT_MS=500.
  // Timer is intentionally ref'd (no .unref()): extension-test runs the hook
  // to completion with no timeout race, so unref'ing would cause the process
  // to exit with an unsettled-await warning. In the full pipeline, firePrompt
  // -Append uses Promise.race against HOOK_TIMEOUT_MS and the orchestrator
  // calls process.exit() at the end, so the dangling timer is collected.
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  return "## From slow-ext\n(should never reach here under pinned timeout)\n";
}
