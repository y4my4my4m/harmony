/**
 * Join activities whose POST /servers/join has not answered yet. A Harmony Group refuses a Join
 * before it answers the delivery, so its Reject is processed inside that request, which reports
 * it (403 join_rejected); processReject then does not also notify the user. Per process: the
 * inbox and /servers/join run in the same federation-server.
 */
const inFlight = new Set<string>();

export function markJoinInFlight(joinId: string): void {
  inFlight.add(joinId);
}

export function clearJoinInFlight(joinId: string): void {
  inFlight.delete(joinId);
}

export function isJoinInFlight(joinId: string): boolean {
  return inFlight.has(joinId);
}
