#!/usr/bin/env node

// opc-harness — Mechanical verification for OPC evaluations
// This is the CLI entry point. All logic lives in lib/.

import { cmdVerify, cmdSynthesize, cmdReport, cmdDiff } from "./lib/eval-commands.mjs";
import { cmdRoute, cmdInit, cmdValidate, cmdTransition, cmdValidateChain } from "./lib/flow-commands.mjs";
import { cmdInitLoop, cmdCompleteTick, cmdNextTick } from "./lib/loop-commands.mjs";
import { cmdViz, cmdReplayData } from "./lib/viz-commands.mjs";

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "verify":
    cmdVerify(args);
    break;
  case "synthesize":
    cmdSynthesize(args);
    break;
  case "report":
    cmdReport(args);
    break;
  case "diff":
    cmdDiff(args);
    break;
  case "route":
    cmdRoute(args);
    break;
  case "init":
    cmdInit(args);
    break;
  case "validate":
    cmdValidate(args);
    break;
  case "transition":
    cmdTransition(args);
    break;
  case "validate-chain":
    cmdValidateChain(args);
    break;
  case "viz":
    cmdViz(args);
    break;
  case "replay":
    cmdReplayData(args);
    break;
  case "init-loop":
    cmdInitLoop(args);
    break;
  case "complete-tick":
    cmdCompleteTick(args);
    break;
  case "next-tick":
    cmdNextTick(args);
    break;
  default:
    console.log("opc-harness — Mechanical verification for OPC evaluations");
    console.log();
    console.log("Usage:");
    console.log("  opc-harness verify <file>                            Parse evaluation → JSON");
    console.log("  opc-harness synthesize <dir> --wave <N>              Merge wave evaluations → verdict");
    console.log("  opc-harness synthesize <dir> --node <id> [--run N]   Merge node evaluations → verdict");
    console.log("  opc-harness report <dir> --mode <m> --task <t>       Generate full report JSON");
    console.log("  opc-harness diff <file1> <file2>                     Compare two evaluation rounds");
    console.log("  opc-harness route --node <id> --verdict <V> --flow <tpl>    Get next node from graph");
    console.log("  opc-harness init --flow <tpl> [--entry <node>] [--dir <p>]  Init flow state");
    console.log("  opc-harness validate <handshake.json>                Validate handshake schema");
    console.log("  opc-harness transition --from <n> --to <n> --verdict <V> --flow <tpl> --dir <p>");
    console.log("                                                      Execute state transition");
    console.log("  opc-harness validate-chain [--dir <p>]               Validate entire execution path");
    console.log("  opc-harness viz --flow <tpl> [--dir <p>] [--json]     Visualize flow graph (ASCII or JSON)");
    console.log("  opc-harness replay [--dir <p>]                       Export flow replay data as JSON");
    console.log();
    console.log("Loop commands (Layer 2 — zero trust):");
    console.log("  opc-harness init-loop [--plan <file>] [--dir <p>]    Init loop state with plan validation");
    console.log("  opc-harness complete-tick --unit <id> --artifacts <a,b> --description <text> [--dir <p>]");
    console.log("                                                      Complete tick with evidence validation");
    console.log("  opc-harness next-tick [--dir <p>]                    Get next unit or auto-terminate");
    console.log();
    console.log("All output is JSON to stdout. Errors go to stderr.");
    break;
}
