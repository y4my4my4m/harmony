/**
 * Fediverse polls (ActivityPub Question) stored on posts.metadata by the federation backend:
 *   is_poll, poll_options [{ name, votes }], poll_multiple_choice, poll_end_time,
 *   poll_voters_count, poll_closed
 */

export interface RemotePollOption {
  name: string
  votes: number
  percent: number
}

export interface RemotePoll {
  multiple: boolean
  options: RemotePollOption[]
  /** People who voted; the sum of votes when the origin does not report it. */
  voters: number
  votersReported: boolean
  endTime: string | null
  closed: boolean
}

const count = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** The poll on a post's metadata, or null. Shares are of voters for multiple choice, of votes otherwise. */
export function remotePollFromMetadata(metadata: unknown, now: number = Date.now()): RemotePoll | null {
  const m = metadata as Record<string, unknown> | null
  if (!m || typeof m !== 'object' || m.is_poll !== true || !Array.isArray(m.poll_options)) return null
  const raw = (m.poll_options as unknown[])
    .map((o) => ({ name: String((o as any)?.name ?? ''), votes: count((o as any)?.votes) }))
    .filter((o) => o.name)
  if (raw.length === 0) return null

  const multiple = m.poll_multiple_choice === true
  const sum = raw.reduce((acc, o) => acc + o.votes, 0)
  const reported = count(m.poll_voters_count)
  const votersReported = reported > 0
  const voters = votersReported ? reported : sum
  const denominator = multiple ? voters : sum
  const endTime = typeof m.poll_end_time === 'string' && m.poll_end_time ? m.poll_end_time : null
  const end = endTime ? Date.parse(endTime) : NaN
  const closed = m.poll_closed === true || (!Number.isNaN(end) && end <= now)

  return {
    multiple,
    options: raw.map((o) => ({
      ...o,
      percent: denominator > 0 ? Math.min(100, Math.round((o.votes / denominator) * 100)) : 0,
    })),
    voters,
    votersReported,
    endTime,
    closed,
  }
}
