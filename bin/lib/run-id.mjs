export function parseRunOrdinal(value) {
  const match = /^(?:run_)?(\d+)$/.exec(String(value ?? ""));
  return match ? BigInt(match[1]) : null;
}

export function compareRunIds(left, right) {
  const leftOrdinal = parseRunOrdinal(left);
  const rightOrdinal = parseRunOrdinal(right);
  if (leftOrdinal === null || rightOrdinal === null) {
    return String(left).localeCompare(String(right));
  }
  return leftOrdinal === rightOrdinal ? 0 : leftOrdinal < rightOrdinal ? -1 : 1;
}
