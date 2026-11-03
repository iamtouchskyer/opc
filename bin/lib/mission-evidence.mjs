// Freshness bindings, not a security boundary against a process with write access.
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync, existsSync } from "fs";
import { join, resolve, relative, isAbsolute, sep } from "path";
import { validateMission, nonempty } from "./mission-gate.mjs";

export const digest = value => createHash("sha256").update(value).digest("hex");
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export function evidenceFiles(paths, state, dir) {
  if (!Array.isArray(paths) || !paths.length || paths.some(path => !nonempty(path))) throw new Error("non-empty evidence paths are required");
  return paths.map(path => {
    const absolute = realpathSync(resolve(dir, path));
    if (![realpathSync(state.projectRoot), realpathSync(dir)].some(root => inside(root, absolute))) throw new Error("evidence escapes project/session scope");
    if (absolute === join(realpathSync(dir), "flow-state.json")) throw new Error("flow-state is not outcome evidence");
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size === 0) throw new Error("evidence must be a non-empty regular file");
    return { path: absolute, sha256: digest(readFileSync(absolute)) };
  });
}

export function validateEvidence(receipts, state, dir) {
  if (!Array.isArray(receipts) || !receipts.length) throw new Error("evidence receipts are required; use mission evidence --file PATH before review");
  return receipts.map(receipt => {
    if (!nonempty(receipt?.path) || !/^[a-f0-9]{64}$/.test(receipt.sha256 || "")) throw new Error("evidence requires {path, sha256} from before review");
    const current = evidenceFiles([receipt.path], state, dir)[0];
    if (current.sha256 !== receipt.sha256) throw new Error("review evidence changed; obtain a fresh review");
    return current;
  });
}

export function missionBinding(state, dir, edge) {
  // ponytail: hash the working set at review boundaries; optimize only if large-repo measurements warrant it.
  const m = validateMission(state);
  const root = realpathSync(state.projectRoot);
  const session = realpathSync(dir);
  if (root === session) throw new Error("Mission session must not be the project root");
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const head = git(["rev-parse", "--verify", "HEAD"]).trim();
  const names = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))].sort();
  const files = [];
  for (const name of names) {
    const path = join(root, name);
    if (inside(session, path)) continue;
    if (!existsSync(path)) { files.push([name, "missing"]); continue; }
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("Mission binding does not support submodules or special tracked files");
    if (stat.isFile() && !inside(root, realpathSync(path))) throw new Error("tracked file escapes project scope");
    files.push([name, stat.mode, digest(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path))]);
  }
  const artifacts = [];
  function walk(path) {
    if (!existsSync(path)) return;
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) artifacts.push([relative(session, file), digest(readFileSync(file))]);
      else throw new Error("Mission node evidence must not contain symlinks or special files");
    }
  }
  walk(join(session, "nodes"));
  return digest(JSON.stringify({ session, head, files, artifacts, edge, contract: m.contract,
    flowFile: state._flow_file ? digest(readFileSync(state._flow_file)) : null,
    startedAt: m.startedAt, signal: m.signal, decisions: m.decisions, grant: m.grant,
    nonce: state._write_nonce, history: state.history, step: state.totalSteps,
    currentNode: state.currentNode, repairs: state.repairEdgeCounts, producedCommits: state.producedCommits }));
}

export function validateReviewer(review, binding) {
  if (!review || review.binding !== binding) throw new Error("stale or missing Mission review binding; get a fresh mission status");
  if (!nonempty(review.reviewer?.id) || review.reviewer.contextMode !== "cold") throw new Error("a fresh reviewer id and contextMode:cold are required");
}

export function missionFinalizationError(state, dir) {
  if (!Object.hasOwn(state, "mission")) return null;
  try {
    validateMission(state);
    const a = state.mission.acceptance;
    if (!a) return "Mission outcome review is missing; run mission accept";
    const edge = { from: state.currentNode, to: null, verdict: "PASS" };
    if (a.binding !== missionBinding(state, dir, edge)) return "Mission outcome review is stale";
    for (const evidence of a.evidence) {
      const current = evidenceFiles([evidence.path], state, dir)[0];
      if (current.sha256 !== evidence.sha256) return "Mission outcome evidence changed";
    }
    return null;
  } catch (error) { return `Mission evidence check failed: ${error.message}`; }
}
