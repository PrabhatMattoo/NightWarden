// Blocked by something the page cannot change: disabled, and marked so the component can dim.
export function unavailableProps(
  unavailable: boolean,
  disabled: boolean | undefined,
): { "data-unavailable": true | undefined; disabled: boolean } {
  return {
    "data-unavailable": unavailable || undefined,
    disabled: disabled === true || unavailable,
  };
}
