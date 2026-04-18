// Run 2 fixture: ok-ext — clean baseline
// Purpose: Prove all 5 hooks fire cleanly when the extension is well-behaved.

export const meta = {
  provides: ["verification@1"],
  compatibleCapabilities: [],
};

export function startupCheck() {
  return true;
}

export function promptAppend(/* ctx */) {
  return "## From ok-ext\nCheck that ok-ext ran.\n";
}

export function verdictAppend(/* ctx */) {
  return [
    {
      severity: "info",
      category: "verification",
      message: "ok-ext verdict ran",
    },
  ];
}

export function executeRun(/* ctx */) {
  // side-effect hook; return value is ignored per spec §10
  return undefined;
}

export function artifactEmit(/* ctx */) {
  return [
    {
      name: "ok-ext-marker.txt",
      content: "ok",
    },
  ];
}
