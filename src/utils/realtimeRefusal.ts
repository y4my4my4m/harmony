/**
 * Realtime refuses a private channel the caller may not read with a join error reading
 * "Unauthorized: You do not have permissions to read from this Channel topic: <topic>"
 * (realtime-js passes it to the subscribe callback with CHANNEL_ERROR). Retrying cannot succeed
 * until membership or policy changes.
 */
export function isChannelRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /\bUnauthorized\b/.test(message)
}

/** Delay, ms, before retry `attempt` (0-based) of a channel that failed otherwise: 5 s doubling to 60 s. */
export function channelRetryDelay(attempt: number): number {
  return Math.min(5000 * 2 ** Math.max(0, attempt), 60_000)
}
