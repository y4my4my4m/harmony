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

// A close after holding the channel this long, ms, starts the backoff over. The events limit holds
// for up to 60 s and closes a channel on its next delivery, so a rejoin can close again at once.
const CHANNEL_STABLE_MS = 30_000
// Fraction of the delay added at random. One flood closes the channel on every viewer's socket.
const CHANNEL_CLOSE_JITTER = 0.5

/** Rebuild delays of one closed topic: channelRetryDelay plus jitter. */
export class ChannelCloseBackoff {
  private attempt = 0
  private joinedAt: number | null = null

  joined(now: number = Date.now()): void {
    this.joinedAt = now
  }

  next(now: number = Date.now()): number {
    if (this.joinedAt !== null && now - this.joinedAt >= CHANNEL_STABLE_MS) this.attempt = 0
    this.joinedAt = null
    const delay = channelRetryDelay(this.attempt++)
    return delay + delay * CHANNEL_CLOSE_JITTER * Math.random()
  }
}
