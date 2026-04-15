#!/usr/bin/env node

// opc-harness — Mechanical verification for OPC evaluations
// This is the CLI entry point. All logic lives in lib/.

import { cmdVerify, cmdSynthesize, cmdTierBaseline } from "./lib/eval-commands.mjs";
import { cmdReport, cmdDiff } from "./lib/eval-report.mjs";
import { cmdRoute, cmdInit, cmdValidate, cmdValidateContext } from "./lib/flow-core.mjs";
import { cmdTransition, cmdValidateChain, cmdFinalize } from "./lib/flow-transition.mjs";
import { cmdSkip, cmdPass, cmdStop, cmdGoto, cmdLs } from "./lib/flow-escape.mjs";
import { cmdInitLoop } from "./lib/loop-init.mjs";
import { cmdCompleteTick } from "./lib/loop-tick.mjs";
import { cmdNextTick } from "./lib/loop-advance.mjs";
import { cmdReinitLoop } from "./lib/loop-reinit.mjs";
import { cmdViz, cmdReplayData } from "./lib/viz-commands.mjs";
import { cmdUxVerdict, cmdUxFrictionAggregate } from "./lib/ux-verdict.mjs";
import { cmdCriteriaLint } from "./lib/criteria-lint.mjs";

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "verify":       cmdVerify(args);        break;
  case "synthesize":   cmdSynthesize(args);    break;
  case "report":       cmdReport(args);        break;
  case "diff":         cmdDiff(args);          break;
  case "route":        cmdRoute(args);         break;
  case "init":         cmdInit(args);          break;
  case "validate":     cmdValidate(args);      break;
  case "transition":   cmdTransition(args);    break;
  case "validate-chain": cmdValidateChain(args); break;
  case "finalize":     cmdFinalize(args);      break;
  case "validate-context": cmdValidateContext(args); break;
  case "viz":          cmdViz(args);           break;
  case "replay":       cmdReplayData(args);    break;
  case "init-loop":    cmdInitLoop(args);      break;
  case "reinit-loop":  cmdReinitLoop(args);    break;
  case "complete-tick": cmdCompleteTick(args);  break;
  case "next-tick":    cmdNextTick(args);      break;
  case "skip":         cmdSkip(args);          break;
  case "pass":         cmdPass(args);          break;
  case "stop":         cmdStop(args);          break;
  case "goto":         cmdGoto(args);          break;
  case "ls":           cmdLs(args);            break;
  case "tier-baseline": cmdTierBaseline(args);  break;
  case "ux-verdict":            cmdUxVerdict(args);            break;
  case "ux-friction-aggregate": cmdUxFrictionAggregate(args);  break;
  case "criteria-lint":         cmdCriteriaLint(args);         break;
  default:
    console.log("opc-harness — Mechanical verification for OPC evaluations");
    console.log();
    console.log("Flow commands:");
    console.log("  init --flow <tpl> [--flow-file <p>] [--entry <node>] [--dir <p>]");
    console.log("                                                     Init flow state");
    console.log("  route --node <id> --verdict <V> --flow <tpl> [--flow-file <p>]");
    console.log("                                                     Get next node from graph");
    console.log("  transition --from <n> --to <n> --verdict <V> --flow <tpl> [--flow-file <p>] --dir <p>");
    console.log("                                                     Execute state transition");
    console.log("  validate <handshake.json>                          Validate handshake schema");
    console.log("  validate-chain [--dir <p>]                         Validate entire execution path");
    console.log("  validate-context --flow <tpl> [--flow-file <p>] --node <id> [--dir <p>]");
    console.log("                                                     Validate flow-context.json");
    console.log("  finalize [--dir <p>] [--strict]                    Finalize terminal node");
    console.log("  viz --flow <tpl> [--flow-file <p>] [--dir <p>] [--json]");
    console.log("                                                     Visualize flow graph");
    console.log("  replay [--dir <p>]                                 Export replay data as JSON");
    console.log();
    console.log("Escape hatches:");
    console.log("  skip [--dir <p>]                                   Skip current node via PASS");
    console.log("  pass [--dir <p>]                                   Force-pass current gate");
    console.log("  stop [--dir <p>]                                   Terminate flow, preserve state");
    console.log("  goto <nodeId> [--dir <p>]                          Jump to a node");
    console.log("  ls [--base <p>]                                    List active flows");
    console.log();
    console.log("Eval commands:");
    console.log("  verify <file>                                      Parse evaluation → JSON");
    console.log("  synthesize <dir> --node <id> [--run N]             Merge evaluations → verdict");
    console.log("  report <dir> --mode <m> --task <t>                 Generate full report JSON");
    console.log("  diff <file1> <file2>                               Compare two evaluation rounds");
    console.log("  tier-baseline --tier <functional|polished|delightful>");
    console.log("                                                     Generate P0 test cases for tier");
    console.log();
    console.log("UX simulation:");
    console.log("  ux-verdict --dir <p> --run <N>                     Compute UX verdict from observers");
    console.log("  ux-friction-aggregate --dir <p> --run <N> --output <p>");
    console.log("                                                     Aggregate friction points");
    console.log("  criteria-lint <file> [--tier <t>]                  Lint acceptance criteria DoD");
    console.log();
    console.log("Loop commands (Layer 2 — zero trust):");
    console.log("  init-loop [--plan <file>] [--flow-template <name>] [--flow-file <p>] [--handlers <json>] [--dir <p>]");
    console.log("                                                     Init loop state");
    console.log("  reinit-loop --unit <id> --sub-units <csv> [--dir <p>]");
    console.log("                                                     Decompose stalled unit into sub-units");
    console.log("  complete-tick --unit <id> --artifacts <a,b> --description <text> [--dir <p>]");
    console.log("                                                     Complete tick with evidence");
    console.log("  next-tick [--dir <p>]                              Get next unit or terminate");
    console.log();
    console.log("All output is JSON to stdout. Errors go to stderr.");
    break;
}
