export function stoppedFlowError(state, command) {
  if (state?.status !== "stopped") return null;
  return `flow is stopped - ${command} cannot mutate state`;
}

export function assertFlowMutable(state, command) {
  const error = stoppedFlowError(state, command);
  if (error) throw new Error(error);
}
