// Run 2 fixture: throw-ext — synchronous error isolation
// Purpose: Prove synchronous throws in one hook isolate the failing extension
// without crashing the process. promptAppend returns cleanly so it does NOT
// trip the breaker — only verdictAppend throws.

export const meta = {
  provides: ["verification@1"],
  compatibleCapabilities: [],
};

export function startupCheck() {
  return true;
}

export function promptAppend(/* ctx */) {
  return "## From throw-ext\n";
}

export function verdictAppend(/* ctx */) {
  throw new Error("throw-ext: intentional failure");
}
