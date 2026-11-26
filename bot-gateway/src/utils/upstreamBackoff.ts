/**
 * Pause of the gateway's polls while the API is down. Kong answers 502, 503 or 504 when PostgREST,
 * or the database behind it, is unavailable; a fetch that gets no answer throws. Each such failure
 * while no pause runs starts one: 1 s, doubling to UPSTREAM_BACKOFF_MAX_MS. Any other answer ends
 * it. ready() gates poll ticks only; requests made for a bot or a bridge go out regardless.
 *
 * At full rate the polls are 3 to 3.5 requests a second, 4 more with a bot connected; during an
 * outage each one is a Kong access log line and an error line here.
 */

export const UPSTREAM_BACKOFF_BASE_MS = 1_000
export const UPSTREAM_BACKOFF_MAX_MS = 60_000

/** HTTP statuses of an API that is down, not of a request it refused. */
export const UPSTREAM_DOWN_STATUSES = new Set([502, 503, 504])

export class UpstreamBackoff {
  private failures = 0
  private until = 0
  private downSince = 0

  constructor(
    private now: () => number = () => Date.now(),
    private log: Pick<Console, 'warn' | 'log'> = console,
  ) {}

  /** A poll may run now. */
  ready(): boolean {
    return this.now() >= this.until
  }

  /** ms until polls run again; 0 when they run. */
  remainingMs(): number {
    return Math.max(0, this.until - this.now())
  }

  /** The API answered as down. Failures inside a running pause belong to the requests it caught. */
  failed(reason: string): void {
    const now = this.now()
    if (now < this.until) return
    this.failures += 1
    const delay = Math.min(UPSTREAM_BACKOFF_MAX_MS, UPSTREAM_BACKOFF_BASE_MS * 2 ** (this.failures - 1))
    this.until = now + delay
    if (this.failures === 1) {
      this.downSince = now
      this.log.warn(`API unavailable (${reason}); polls pause ${delay / 1000} s, doubling to ${UPSTREAM_BACKOFF_MAX_MS / 1000} s while it stays down`)
    }
  }

  /** The API answered. */
  succeeded(): void {
    if (this.failures === 0) return
    this.log.log(`API available again after ${Math.round((this.now() - this.downSince) / 1000)} s`)
    this.failures = 0
    this.until = 0
  }
}

export const upstream = new UpstreamBackoff()

/** fetch that reports each answer, or its absence, to `gate`. */
export function backoffFetch(inner: typeof fetch, gate: UpstreamBackoff = upstream): typeof fetch {
  return async (input, init) => {
    let res: Response
    try {
      res = await inner(input, init)
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) gate.failed(err instanceof Error ? err.message : String(err))
      throw err
    }
    if (UPSTREAM_DOWN_STATUSES.has(res.status)) gate.failed(`HTTP ${res.status}`)
    else gate.succeeded()
    return res
  }
}
