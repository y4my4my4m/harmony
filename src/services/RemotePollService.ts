/**
 * Votes on fediverse polls (posts stored from an ActivityPub Question): vote_remote_poll and
 * the caller's rows of post_poll_votes (20261022100001_remote_poll_votes.sql). A vote is final.
 */
import { supabase } from '@/supabase'

/** The poll error a vote_remote_poll failure names (POLL_CLOSED, POLL_ALREADY_VOTED, ...), or null. */
export function remotePollErrorCode(error: unknown): string | null {
  const message = (error as { message?: unknown } | null)?.message
  const match = typeof message === 'string' ? /\b(POLL_[A-Z_]+)\b/.exec(message) : null
  return match ? match[1] : null
}

/** Records the caller's answers (indexes into poll_options); the post's metadata after the vote. */
export async function voteRemotePoll(postId: string, choices: number[]): Promise<Record<string, any>> {
  const { data, error } = await supabase.rpc('vote_remote_poll', { p_post_id: postId, p_choices: choices })
  if (error) throw error
  return (data as Record<string, any>) ?? {}
}

// Reads requested in the same task share one query.
let pending: Map<string, Array<(choices: number[]) => void>> | null = null

async function flush(batch: Map<string, Array<(choices: number[]) => void>>): Promise<void> {
  const ids = [...batch.keys()]
  const found = new Map<string, number[]>(ids.map((id) => [id, []]))
  try {
    const { data } = await supabase.from('post_poll_votes').select('post_id, choice').in('post_id', ids)
    for (const row of data ?? []) found.get(row.post_id)?.push(Number(row.choice))
  } catch {
    // Read as not voted; the vote itself reports POLL_ALREADY_VOTED.
  }
  for (const [id, waiters] of batch) {
    const choices = (found.get(id) ?? []).sort((a, b) => a - b)
    for (const resolve of waiters) resolve(choices)
  }
}

/** The caller's answers on the poll of `postId`; empty when the caller has not voted. */
export function myRemotePollChoices(postId: string): Promise<number[]> {
  return new Promise((resolve) => {
    if (!pending) {
      pending = new Map()
      const batch = pending
      setTimeout(() => {
        pending = null
        void flush(batch)
      }, 0)
    }
    const waiters = pending.get(postId) ?? []
    waiters.push(resolve)
    pending.set(postId, waiters)
  })
}
