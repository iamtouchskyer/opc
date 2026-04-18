// Run 2 fixture: ok-ext — clean baseline
// Purpose: Prove all 5 hooks fire cleanly when the extension is well-behaved.

import { writeFileSync } from "fs";
import { join } from "path";

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

export function executeRun(ctx) {
  // G4 fix: write a marker so e2e can prove executeRun actually fired.
  // Return value still ignored per spec §10 — the side-effect IS the test.
  try {
    if (ctx && ctx.runDir) {
      writeFileSync(
        join(ctx.runDir, "ok-ext-execute-marker.txt"),
        "ok-ext executeRun fired\n"
      );
    }
  } catch { /* best effort, don't fail the hook */ }
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
