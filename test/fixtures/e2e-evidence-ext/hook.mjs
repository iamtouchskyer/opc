// e2e-evidence extension — verdict.append hook
// Scans upstream eval files for E2E evidence. If only proxy evidence found
// (no trigger-to-artifact trace, no explicit exemption), emits a 🟡 finding.
//
// Install: copy to ~/.opc/extensions/e2e-evidence/
// Requires: nodeCapabilities includes "e2e-check@1" on the target node.

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export const meta = {
  name: "e2e-evidence",
  provides: ["e2e-check@1"],
  description: "Checks eval files for E2E trigger-to-artifact evidence",
};

// Patterns that indicate real E2E evidence
const E2E_PATTERNS = [
  /e2e[_-]?evidence/i,
  /trigger.*artifact/i,
  /before[/-]?after/i,
  /\$ .+&&.+/,                    // shell command chains
  /exit code [0-9]/i,
  /command[_-]?output/i,
  /screenshot-?\d/i,
  /poll.*artifact|artifact.*changed/i,
  /mtime|stat\s/i,
  /curl\s|wget\s|http[s]?:\/\//,
];

// Patterns that indicate explicit E2E exemption
const EXEMPTION_PATTERNS = [
  /no e2e path/i,
  /e2e not applicable/i,
  /unit\/integration evidence only/i,
  /no end-to-end/i,
];

// Patterns that indicate proxy-only evidence (not sufficient)
const PROXY_PATTERNS = [
  /tests pass/i,
  /all.*pass/i,
  /looks good/i,
  /should work/i,
  /lgtm/i,
];

export function startupCheck() {
  // No external deps needed
  return true;
}

export function verdictAppend(ctx) {
  if (!ctx || !ctx.runDir) return null;

  // Read all eval-*.md files in runDir
  let evalFiles;
  try {
    evalFiles = readdirSync(ctx.runDir)
      .filter(f => f.startsWith("eval-") && f.endsWith(".md") && f !== "eval-extensions.md");
  } catch {
    return null;
  }

  if (evalFiles.length === 0) return null;

  let hasE2E = false;
  let hasExemption = false;
  let hasProxy = false;

  for (const file of evalFiles) {
    let content;
    try {
      content = readFileSync(join(ctx.runDir, file), "utf8");
    } catch {
      continue;
    }

    for (const pat of E2E_PATTERNS) {
      if (pat.test(content)) { hasE2E = true; break; }
    }
    for (const pat of EXEMPTION_PATTERNS) {
      if (pat.test(content)) { hasExemption = true; break; }
    }
    for (const pat of PROXY_PATTERNS) {
      if (pat.test(content)) { hasProxy = true; break; }
    }
  }

  // E2E evidence found or explicit exemption → no finding
  if (hasE2E || hasExemption) return [];

  // No E2E and no exemption → emit warning
  if (hasProxy) {
    return [{
      severity: "warning",
      category: "e2e-evidence",
      message: "Eval contains only proxy evidence (tests pass / LGTM) without E2E trigger-to-artifact verification. Add E2E evidence or annotate 'No E2E path — unit/integration evidence only' with justification.",
    }];
  }

  // No evidence at all — still flag
  return [{
    severity: "warning",
    category: "e2e-evidence",
    message: "No E2E evidence found in eval files. If E2E is not applicable, annotate explicitly with 'No E2E path' and justification.",
  }];
}
