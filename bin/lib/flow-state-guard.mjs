import { validateMission } from "./mission-gate.mjs";

export function stoppedFlowError(state, command) {
  if (state && Object.hasOwn(state, "mission")) {
    try { validateMission(state); }
    catch (error) { return error.message; }
  }
  if (state && Object.hasOwn(state, "mission") && ["skip", "pass", "goto"].includes(command)) {
    return `Mission does not allow ${command}; use mission decide or stop`;
  }
  if (state?.status !== "stopped") return null;
  return `flow is stopped - ${command} cannot mutate state`;
}

export function assertFlowMutable(state, command) {
  const error = stoppedFlowError(state, command);
  if (error) throw new Error(error);
}
