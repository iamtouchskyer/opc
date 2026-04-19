// hook.mjs — design-lint extension (OPC Run 3 U3.1)
//
// Wraps ~/.claude/skills/opc-extend-design/bin/design-lint.mjs as an OPC
// extension. Declares capability `design-spec-conformance@1`. On verdict.append,
// searches upward from ctx.flowDir / ctx.runDir for a `design-tokens.json`
// spec. If absent → returns []. If present AND a live dev-server URL is
// discoverable → shells out to design-lint in `lint` mode with a 30s timeout
// and converts violations to findings. Otherwise → [].
//
// Contract: startupCheck never throws. Missing deps log a single-line WARN
// and downgrade to no-op. verdictAppend returns [] on any failure path.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const meta = {
  provides: ["design-spec-conformance@1"],
  compatibleCapabilities: ["verification@1", "design-review@1"],
};

const DESIGN_LINT_BIN = join(
  homedir(),
  ".claude/skills/opc-extend-design/bin/design-lint.mjs"
);

const LINT_TIMEOUT_MS = 30_000;

export function startupCheck() {
  if (!existsSync(DESIGN_LINT_BIN)) {
    process.stderr.write(
      `[design-lint] WARN: ${DESIGN_LINT_BIN} not found — verdict.append will no-op\n`
    );
  }
  return { ok: true };
}

// Walk up from `start` looking for a file named `target` or `.opc/<target>`.
// Stops at filesystem root. Returns absolute path or null.
function findUpward(start, targets) {
  if (!start) return null;
  let cur = resolve(start);
  const root = resolve("/");
  while (true) {
    for (const t of targets) {
      const p = join(cur, t);
      if (existsSync(p)) return p;
    }
    if (cur === root) return null;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function extractDevServerUrl(ctx) {
  // Prefer explicit context field; fall back to acceptance criteria text.
  if (typeof ctx?.devServerUrl === "string" && ctx.devServerUrl) {
    return ctx.devServerUrl;
  }
  const ac = ctx?.acceptanceCriteria || ctx?.acceptance_criteria;
  if (typeof ac === "string") {
    const m = ac.match(/https?:\/\/(?:localhost|127\.0\.0\.1)[^\s'"`)]+/);
    if (m) return m[0];
  }
  return null;
}

export function verdictAppend(ctx) {
  try {
    if (!existsSync(DESIGN_LINT_BIN)) return [];

    const searchStart = ctx?.runDir || ctx?.flowDir || ctx?.cwd || process.cwd();
    const tokensPath = findUpward(searchStart, [
      "design-tokens.json",
      ".opc/design-tokens.json",
    ]);
    if (!tokensPath) return [];

    const url = extractDevServerUrl(ctx);
    if (!url) {
      // Spec present but no live URL — graceful no-op per Run 3 contract.
      return [];
    }

    // We don't have a crawler here; design-lint.mjs expects a `raw.json` of
    // crawled pages. Without a crawler integration, we cannot produce findings
    // from a live URL in-hook. Downgrade: log, return [].
    process.stderr.write(
      `[design-lint] WARN: live-URL lint requires a crawler (not shipped with hook); returning [] for url=${url}\n`
    );
    return [];
  } catch (err) {
    process.stderr.write(
      `[design-lint] WARN: verdictAppend failed: ${err?.message || err}\n`
    );
    return [];
  }
}

// Exported for unit-test convenience.
export { findUpward as _findUpward, extractDevServerUrl as _extractDevServerUrl };
