// hook.mjs — visual-eval extension (OPC Run 3 U3.2)
//
// Declares capability `visual-consistency-check@1`. Wraps the Python
// opc-extend-visual-eval CLI (~/.claude/skills/opc-extend-visual-eval/lib/).
//
// This is an **execute-time** tool that emits evidence, not a review agent
// emitting findings — so it implements `executeRun` (side-effect) rather
// than `verdictAppend`. In OPC Run 2 the equivalent was `ok-ext-execute-marker.txt`.
//
// Behavior:
//   startupCheck: verify python3 + the skill's __main__.py exist. If either
//     missing, log a single-line WARN (no throw).
//   executeRun(ctx): scan ctx.runDir/artifacts/ for image files (png/jpg/jpeg).
//     If none, no-op. If 1+, spawn `python3 -m vlm_eval <images...> --prompt ui-quality
//     --json --output-dir <runDir>/ext-visual-eval/` with a 60s timeout.
//     Failures degrade to stderr WARN — never throw.
//
// Contract: both startupCheck and executeRun are crash-proof. Missing
// DASHSCOPE_API_KEY or network failure → WARN + marker file indicating
// skipped run; never blocks downstream.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

export const meta = {
  provides: ["visual-consistency-check@1"],
  compatibleCapabilities: ["execute@1", "verification@1"],
};

const SKILL_ROOT = join(homedir(), ".claude/skills/opc-extend-visual-eval");
const MAIN_PY = join(SKILL_ROOT, "lib/__main__.py");
const PYTHON = "python3";
const TIMEOUT_MS = 60_000;
const IMG_RE = /\.(png|jpe?g)$/i;

function hasBin(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000 });
  return r.status === 0;
}

export function startupCheck() {
  if (!existsSync(MAIN_PY)) {
    process.stderr.write(
      `[visual-eval] WARN: ${MAIN_PY} not found — executeRun will no-op\n`
    );
    return { ok: true, available: false };
  }
  if (!hasBin(PYTHON)) {
    process.stderr.write(
      `[visual-eval] WARN: python3 not in PATH — executeRun will no-op\n`
    );
    return { ok: true, available: false };
  }
  return { ok: true, available: true };
}

function findImages(dir) {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => IMG_RE.test(f))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export function executeRun(ctx) {
  try {
    const runDir = ctx?.runDir;
    if (!runDir) return;
    const artifactsDir = join(runDir, "artifacts");
    const images = findImages(artifactsDir);
    if (images.length === 0) return;

    if (!existsSync(MAIN_PY) || !hasBin(PYTHON)) {
      process.stderr.write(
        `[visual-eval] WARN: skill/python unavailable — skipping ${images.length} image(s)\n`
      );
      return;
    }

    const outDir = join(runDir, "ext-visual-eval");
    mkdirSync(outDir, { recursive: true });

    const args = [
      "-m",
      "lib",
      ...images,
      "--prompt",
      "ui-quality",
      "--json",
      "--output-dir",
      outDir,
    ];
    const env = { ...process.env, PYTHONPATH: SKILL_ROOT };
    const r = spawnSync(PYTHON, args, {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env,
    });
    // Always write a marker so presence can be audited even on failure.
    const marker = {
      status: r.status === null ? "timeout" : r.status === 0 ? "ok" : "error",
      exitCode: r.status,
      signal: r.signal ?? null,
      imageCount: images.length,
      stderrTail: (r.stderr || "").slice(-500),
      at: new Date().toISOString(),
    };
    writeFileSync(
      join(outDir, "visual-eval-marker.json"),
      JSON.stringify(marker, null, 2)
    );
    if (r.status !== 0) {
      process.stderr.write(
        `[visual-eval] WARN: vlm_eval exited with status=${r.status}, signal=${r.signal}\n`
      );
    }
  } catch (err) {
    process.stderr.write(
      `[visual-eval] WARN: executeRun failed: ${err?.message || err}\n`
    );
  }
}
