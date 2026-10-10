/**
 * Chat message polls: create_message_poll, get_message_polls, vote_message_poll and
 * end_message_poll (20261010700001_message_polls.sql).
 */
import { supabase } from '@/supabase'

export interface MessagePollOption {
  id: string
  position: number
  text: string
  votes: number
}

export interface MessagePollState {
  pollId: string
  messageId: string
  question: string
  allowMultiple: boolean
  expiresAt: string | null
  closed: boolean
  totalVoters: number
  options: MessagePollOption[]
  myOptionIds: string[]
  /** The caller wrote the poll and may end it. */
  isAuthor: boolean
}

export interface CreateMessagePollInput {
  channelId?: string | null
  conversationId?: string | null
  question: string
  answers: string[]
  allowMultiple: boolean
  durationHours: number
  replyTo?: string | null
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** A get_message_polls row. */
export function pollStateFromRow(row: any): MessagePollState {
  const options: MessagePollOption[] = (Array.isArray(row?.options) ? row.options : [])
    .map((o: any) => ({ id: String(o?.id ?? ''), position: num(o?.position), text: String(o?.text ?? ''), votes: num(o?.votes) }))
    .filter((o: MessagePollOption) => o.id)
    .sort((a: MessagePollOption, b: MessagePollOption) => a.position - b.position)
  return {
    pollId: String(row?.poll_id ?? ''),
    messageId: String(row?.message_id ?? ''),
    question: String(row?.question ?? ''),
    allowMultiple: row?.allow_multiple === true,
    expiresAt: row?.expires_at ?? null,
    closed: row?.closed === true,
    totalVoters: num(row?.total_voters),
    options,
    myOptionIds: Array.isArray(row?.my_option_ids) ? row.my_option_ids.map(String) : [],
    isAuthor: row?.is_author === true,
  }
}

/**
 * Posts a poll. Returns the message row, or null when AutoMod dropped it (the block notice is
 * read with get_automod_block_notice). Throws the database error otherwise.
 */
export async function createMessagePoll(input: CreateMessagePollInput): Promise<Record<string, any> | null> {
  const { data, error } = await supabase.rpc('create_message_poll', {
    p_channel_id: input.channelId ?? null,
    p_conversation_id: input.conversationId ?? null,
    p_question: input.question,
    p_options: input.answers,
    p_allow_multiple: input.allowMultiple,
    p_duration_hours: input.durationHours,
    p_reply_to: input.replyTo || null,
  })
  if (error) throw error
  return (data as Record<string, any> | null) ?? null
}

/** Polls the caller can view, among pollIds. Absent ids are unavailable. */
export async function fetchMessagePolls(pollIds: string[]): Promise<MessagePollState[]> {
  if (pollIds.length === 0) return []
  const { data, error } = await supabase.rpc('get_message_polls', { p_poll_ids: pollIds })
  if (error) throw error
  return (Array.isArray(data) ? data : []).map(pollStateFromRow)
}

/** Sets the caller's answers; an empty list removes the vote. */
export async function voteMessagePoll(pollId: string, optionIds: string[]): Promise<MessagePollState | null> {
  const { data, error } = await supabase.rpc('vote_message_poll', { p_poll_id: pollId, p_option_ids: optionIds })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return row ? pollStateFromRow(row) : null
}

/** The author closes the poll now. */
export async function endMessagePoll(pollId: string): Promise<MessagePollState | null> {
  const { data, error } = await supabase.rpc('end_message_poll', { p_poll_id: pollId })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return row ? pollStateFromRow(row) : null
}

const POLL_ERROR_CODES = [
  'POLL_ENCRYPTED', 'POLL_CLOSED', 'POLL_NOT_FOUND', 'POLL_SINGLE_CHOICE', 'POLL_OPTION_INVALID',
  'POLL_QUESTION_INVALID', 'POLL_OPTIONS_INVALID', 'POLL_DURATION_INVALID',
] as const
export type PollErrorCode = (typeof POLL_ERROR_CODES)[number]

/** The POLL_* code a poll RPC raised, or null. */
export function pollErrorCode(error: unknown): PollErrorCode | null {
  const e = error as { message?: unknown; details?: unknown; hint?: unknown } | null
  const text = [e?.message, e?.details, e?.hint].filter((v) => typeof v === 'string').join(' ')
  return POLL_ERROR_CODES.find((code) => text.includes(code)) ?? null
}
