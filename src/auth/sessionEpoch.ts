/**
 * A Cognito refresh captures the epoch when it starts.
 * Logout increments the epoch in the same turn that clears tokens.
 * A refresh that already resolved saw equal epochs and was stored.
 * One that resolves after that clear must not sign the user back in.
 */
export function mayApplyRefreshedTokens(startedEpoch: number, currentEpoch: number): boolean {
  return startedEpoch === currentEpoch;
}
