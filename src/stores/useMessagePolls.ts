import { defineStore } from 'pinia'
import { shallowReactive } from 'vue'
import {
  endMessagePoll,
  fetchMessagePolls,
  voteMessagePoll,
  type MessagePollState,
} from '@/services/MessagePollService'
import { debug } from '@/utils/debug'

/** get_message_polls reads at most 100 ids per call. */
const FETCH_BATCH = 100
/** A held poll is read again when a card asks for it after this long; broadcasts missed while offline are not replayed. */
const STALE_MS = 60_000

/** state with the caller's answers replaced by optionIds, counts adjusted to match. */
export function withPollChoice(state: MessagePollState, optionIds: readonly string[]): MessagePollState {
  const before = new Set(state.myOptionIds)
  const after = new Set(optionIds)
  return {
    ...state,
    options: state.options.map((o) => ({
      ...o,
      votes: Math.max(0, o.votes + (after.has(o.id) ? 1 : 0) - (before.has(o.id) ? 1 : 0)),
    })),
    totalVoters: Math.max(0, state.totalVoters + (after.size > 0 ? 1 : 0) - (before.size > 0 ? 1 : 0)),
    myOptionIds: [...after],
  }
}

/**
 * Poll state by poll id. Cards request their poll; requests made in the same tick share one
 * get_message_polls call. 'poll_event' broadcasts carry counts, applied without a refetch; the
 * caller's own answers come from its votes.
 */
export const useMessagePollsStore = defineStore('messagePolls', () => {
  const polls = shallowReactive(new Map<string, MessagePollState>())
  /** Ids get_message_polls did not return: deleted, from another instance, or not visible. */
  const unavailable = shallowReactive(new Set<string>())
  const fetchedAt = new Map<string, number>()
  const queued = new Set<string>()
  const inFlight = new Set<string>()
  /** Latest vote sequence per poll while a vote is unanswered. */
  const pendingVotes = new Map<string, number>()
  let voteSeq = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleFlush() {
    if (flushTimer === null) flushTimer = setTimeout(() => void flush(), 0)
  }

  async function flush() {
    flushTimer = null
    const ids = [...queued].slice(0, FETCH_BATCH)
    if (ids.length === 0) return
    for (const id of ids) {
      queued.delete(id)
      inFlight.add(id)
    }
    if (queued.size > 0) scheduleFlush()
    try {
      const rows = await fetchMessagePolls(ids)
      const found = new Set<string>()
      for (const row of rows) {
        found.add(row.pollId)
        unavailable.delete(row.pollId)
        fetchedAt.set(row.pollId, Date.now())
        if (!pendingVotes.has(row.pollId)) polls.set(row.pollId, row)
      }
      for (const id of ids) {
        if (!found.has(id)) {
          polls.delete(id)
          unavailable.add(id)
        }
      }
    } catch (error) {
      debug.warn('Failed to load polls:', error)
    } finally {
      for (const id of ids) inFlight.delete(id)
    }
  }

  /** Loads a poll unless it is held and fresh, known unavailable or loading; force reloads it. */
  function request(pollId: string, force = false) {
    if (!pollId || inFlight.has(pollId)) return
    const fresh = polls.has(pollId) && Date.now() - (fetchedAt.get(pollId) ?? 0) < STALE_MS
    if (!force && (fresh || unavailable.has(pollId))) return
    queued.add(pollId)
    scheduleFlush()
  }

  function get(pollId: string): MessagePollState | undefined {
    return polls.get(pollId)
  }

  function isUnavailable(pollId: string): boolean {
    return unavailable.has(pollId)
  }

  /** Optimistic. The newest vote's answer wins; a failure restores the state before it and rethrows. */
  async function vote(pollId: string, optionIds: string[]): Promise<void> {
    const before = polls.get(pollId)
    const seq = ++voteSeq
    pendingVotes.set(pollId, seq)
    if (before) polls.set(pollId, withPollChoice(before, optionIds))
    try {
      const result = await voteMessagePoll(pollId, optionIds)
      if (pendingVotes.get(pollId) === seq && result) {
        polls.set(pollId, result)
        fetchedAt.set(pollId, Date.now())
      }
    } catch (error) {
      if (pendingVotes.get(pollId) === seq) {
        if (before) polls.set(pollId, before)
        pendingVotes.delete(pollId)
        request(pollId, true)
      }
      throw error
    } finally {
      if (pendingVotes.get(pollId) === seq) pendingVotes.delete(pollId)
    }
  }

  async function end(pollId: string): Promise<void> {
    const result = await endMessagePoll(pollId)
    if (result) {
      polls.set(pollId, result)
      fetchedAt.set(pollId, Date.now())
    }
  }

  /** A 'poll_event' broadcast: { type, poll_id, message_id, expires_at, total_voters, options: [{ id, votes }] }. */
  function applyRealtime(payload: any) {
    const pollId = payload?.poll_id
    if (typeof pollId !== 'string') return
    const state = polls.get(pollId)
    if (!state || pendingVotes.has(pollId)) return
    const votes = new Map<string, number>()
    for (const o of Array.isArray(payload.options) ? payload.options : []) {
      const n = Number(o?.votes)
      if (o?.id) votes.set(String(o.id), Number.isFinite(n) ? n : 0)
    }
    const expiresAt: string | null = payload.expires_at ?? state.expiresAt
    const total = Number(payload.total_voters)
    polls.set(pollId, {
      ...state,
      totalVoters: Number.isFinite(total) ? total : state.totalVoters,
      options: state.options.map((o) => (votes.has(o.id) ? { ...o, votes: votes.get(o.id)! } : o)),
      expiresAt,
      closed: state.closed || payload.type === 'poll:ended'
        || (expiresAt !== null && Date.parse(expiresAt) <= Date.now()),
    })
  }

  return { request, get, isUnavailable, vote, end, applyRealtime }
})
