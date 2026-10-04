/**
 * A Cognito refresh captures the epoch when it starts.
 * Logout increments the epoch in the same turn that clears tokens.
 * A refresh that already resolved saw equal epochs and was stored.
 * One that resolves after that clear must not sign the user back in,
 * and its token must not authorize a later DayPlan write.
 */
export function mayApplyRefreshedTokens(startedEpoch: number, currentEpoch: number): boolean {
  return startedEpoch === currentEpoch;
}

/** Token for a request that waited on refresh. Throws once logout has cleared the session. */
export function idTokenAfterRefresh(startedEpoch: number, currentEpoch: number, idToken: string): string {
  if (!mayApplyRefreshedTokens(startedEpoch, currentEpoch)) {
    throw new Error("ログアウトしました");
  }
  return idToken;
}
