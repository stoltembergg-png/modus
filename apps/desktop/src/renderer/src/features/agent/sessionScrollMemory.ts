/**
 * Remember chat scroll positions across ChatPane remounts (session switches).
 * Module-scoped so `key={sessionId}` teardown does not lose the user's place.
 */

const positions = new Map<string, number>();

export function rememberSessionScroll(sessionId: string, scrollTop: number): void {
  if (!sessionId) {
    return;
  }
  positions.set(sessionId, Math.max(0, scrollTop));
}

export function readSessionScroll(sessionId: string): number | undefined {
  return positions.get(sessionId);
}
