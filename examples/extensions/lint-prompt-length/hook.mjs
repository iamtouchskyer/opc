// hook.mjs — lint-prompt-length extension.
//
// Capability: prompt-size-check@1
// Compatible: verification@1, design-review@1, execute@1
//
// Single active hook: verdictAppend. Inspects ctx.task (a string) and emits
// a structured finding when it exceeds the soft/hard length thresholds:
//   > 16000 chars  → severity "error"   (🔴) — "prompt exceeds 16000 chars (<N>)"
//   > 8000  chars  → severity "warning" (🟡) — "prompt large (<N> chars), consider splitting"
//   otherwise      → []  (no finding)
//
// If ctx.task is missing or not a string, we return [] gracefully — per the
// graceful-degrade rule in the authoring guide §6.

export const meta = {
  provides: ["prompt-size-check@1"],
  compatibleCapabilities: ["verification@1", "design-review@1", "execute@1"],
  description:
    "verdict.append hook that flags oversized ctx.task prompts (🟡 > 8000 chars, 🔴 > 16000 chars).",
};

const SOFT_LIMIT = 8000;
const HARD_LIMIT = 16000;
const CATEGORY = "prompt-size-check";

/**
 * startup.check — no prerequisites; never throw.
 * Kept explicit so the extension-test CLI prints a ✅ startup.check line.
 */
export function startupCheck() {
  return undefined;
}

/**
 * verdict.append — the one hook this extension actually uses.
 * @param {{ task?: unknown }} ctx
 * @returns {Array<{severity:string, category:string, message:string}>}
 */
export function verdictAppend(ctx) {
  try {
    const task = ctx?.task;
    if (typeof task !== "string") return [];
    const n = task.length;

    if (n > HARD_LIMIT) {
      return [
        {
          severity: "error",
          category: CATEGORY,
          message: `prompt exceeds 16000 chars (${n})`,
        },
      ];
    }
    if (n > SOFT_LIMIT) {
      return [
        {
          severity: "warning",
          category: CATEGORY,
          message: `prompt large (${n} chars), consider splitting`,
        },
      ];
    }
    return [];
  } catch (err) {
    process.stderr.write(
      `[lint-prompt-length] WARN: verdictAppend degraded: ${err?.message || err}\n`,
    );
    return [];
  }
}
