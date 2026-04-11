// Evaluation analysis commands: verify, synthesize
// Depends on: eval-parser.mjs, util.mjs

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseEvaluation } from "./eval-parser.mjs";
import { getFlag } from "./util.mjs";

export function cmdVerify(args) {
  const file = args[0];
  if (!file) {
    console.error("Usage: opc-harness verify <file>");
    process.exit(1);
  }

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`File not found: ${file}`);
    } else {
      console.error(`Cannot read ${file}: ${err.message}`);
    }
    process.exit(1);
  }
  const result = parseEvaluation(text);

  const findingsWithoutRefs = [];
  const criticalWithoutFix = [];
  const findingsWithoutReasoning = [];

  for (let i = 0; i < result.findings.length; i++) {
    const f = result.findings[i];
    const label = `#${i + 1} [${f.severity}] ${f.file || "no-file"}:${f.line || "?"} \u2014 ${(f.issue || "").slice(0, 60)}`;

    if (!f.file) {
      findingsWithoutRefs.push(label);
    }
    if (f.severity === "critical" && !f.fix) {
      criticalWithoutFix.push(label);
    }
    if (!f.reasoning) {
      findingsWithoutReasoning.push(label);
    }
  }

  const evidenceComplete =
    findingsWithoutRefs.length === 0 &&
    criticalWithoutFix.length === 0 &&
    findingsWithoutReasoning.length === 0;

  const { findings, ...output } = result;
  output.findings_without_refs = findingsWithoutRefs;
  output.critical_without_fix = criticalWithoutFix;
  output.findings_without_reasoning = findingsWithoutReasoning;
  output.evidence_complete = evidenceComplete;
  console.log(JSON.stringify(output, null, 2));
}

// Note: synthesize assumes findings are bugs/issues (review use case).
export function cmdSynthesize(args) {
  const dir = args[0];
  const waveIdx = args.indexOf("--wave");
  const nodeIdx = args.indexOf("--node");

  if (!dir || (waveIdx === -1 && nodeIdx === -1)) {
    console.error("Usage: opc-harness synthesize <dir> --wave <N>           (legacy: dir = project root)");
    console.error("       opc-harness synthesize <dir> --node <nodeId> [--run <N>]  (dir = .harness/ path)");
    process.exit(1);
  }

  let files;

  if (nodeIdx !== -1) {
    const nodeId = args[nodeIdx + 1];
    if (!nodeId) {
      console.error("--node requires a nodeId");
      process.exit(1);
    }

    const runFlag = args.indexOf("--run");
    let targetRunDir;

    if (runFlag !== -1 && args[runFlag + 1]) {
      targetRunDir = join(dir, "nodes", nodeId, `run_${args[runFlag + 1]}`);
    } else {
      const nodeDir = join(dir, "nodes", nodeId);
      try {
        const runs = readdirSync(nodeDir)
          .filter((d) => d.startsWith("run_"))
          .sort((a, b) => {
            const na = parseInt(a.replace("run_", ""), 10);
            const nb = parseInt(b.replace("run_", ""), 10);
            return nb - na;
          });
        if (runs.length === 0) {
          console.error(`No runs found for node '${nodeId}' in ${nodeDir}`);
          process.exit(1);
        }
        targetRunDir = join(nodeDir, runs[0]);
      } catch (err) {
        console.error(`Cannot read node dir ${nodeDir}: ${err.message}`);
        process.exit(1);
      }
    }

    try {
      files = readdirSync(targetRunDir)
        .filter((f) => f.startsWith("eval") && f.endsWith(".md"))
        .map((f) => ({ name: f, path: join(targetRunDir, f) }));
    } catch (err) {
      console.error(`Cannot read ${targetRunDir}: ${err.message}`);
      process.exit(1);
    }

    if (files.length === 0) {
      console.error(`No eval-*.md files in ${targetRunDir}`);
      process.exit(1);
    }
  } else {
    const wave = args[waveIdx + 1];
    if (!wave) {
      console.error("--wave requires a wave number");
      process.exit(1);
    }

    const prefix = `evaluation-wave-${wave}-`;
    const mergedName = `evaluation-wave-${wave}.md`;
    const harnessDir = join(dir, ".harness");

    const ROUND_RE = /^evaluation-wave-\d+-round\d+/;
    try {
      files = readdirSync(harnessDir)
        .filter(
          (f) => f.startsWith(prefix) && f.endsWith(".md") && f !== mergedName && !ROUND_RE.test(f)
        )
        .map((f) => ({ name: f, path: join(harnessDir, f) }));
    } catch (err) {
      console.error(`Cannot read ${harnessDir}: ${err.message}`);
      process.exit(1);
    }

    if (files.length === 0) {
      console.error(`No evaluation files matching ${prefix}*.md in ${harnessDir}`);
      process.exit(1);
    }
  }

  const roles = [];
  const totals = { critical: 0, warning: 0, suggestion: 0 };

  for (const f of files) {
    let roleName;
    if (f.name.startsWith("eval-")) {
      roleName = f.name.replace("eval-", "").replace(/\.md$/, "");
    } else if (f.name === "eval.md") {
      roleName = "evaluator";
    } else {
      const prefix = f.name.match(/^evaluation-wave-\d+-(.+)\.md$/);
      roleName = prefix ? prefix[1] : f.name.replace(/\.md$/, "");
    }

    let text;
    try {
      text = readFileSync(f.path, "utf8");
    } catch (readErr) {
      console.error(`⚠️  Cannot read ${f.path}: ${readErr.message}`);
      continue;
    }
    const parsed = parseEvaluation(text);

    const blocked = /BLOCKED/i.test(parsed.verdict);
    roles.push({
      role: roleName,
      critical: parsed.critical,
      warning: parsed.warning,
      suggestion: parsed.suggestion,
      blocked,
    });

    totals.critical += parsed.critical;
    totals.warning += parsed.warning;
    totals.suggestion += parsed.suggestion;
  }

  let verdict, reason;
  const blockedRoles = roles.filter((r) => r.blocked);
  if (blockedRoles.length > 0) {
    verdict = "BLOCKED";
    reason = `blocked by ${blockedRoles.map((r) => r.role).join(", ")}`;
  } else if (totals.critical > 0) {
    verdict = "FAIL";
    reason = `${totals.critical} validated critical finding(s)`;
  } else if (totals.warning > 0) {
    verdict = "ITERATE";
    reason = `${totals.warning} warning finding(s)`;
  } else {
    verdict = "PASS";
    reason = "all roles LGTM or suggestions only";
  }

  console.log(JSON.stringify({ roles, totals, verdict, reason }, null, 2));
}
