import type { PollContent } from '@/types'

// Limits enforced by create_message_poll (20261010700001_message_polls.sql).
export const POLL_QUESTION_MAX = 300
export const POLL_ANSWER_MAX = 100
export const POLL_MIN_ANSWERS = 2
export const POLL_MAX_ANSWERS = 10
/** Durations offered, in hours: 1 hour to 7 days. */
export const POLL_DURATION_HOURS = [1, 4, 8, 24, 72, 168] as const
export const POLL_DEFAULT_DURATION_HOURS = 24

/** The poll part of a message, or null. */
export function pollPartOf(content: readonly unknown[] | null | undefined): PollContent | null {
  if (!Array.isArray(content)) return null
  for (const part of content) {
    const p = part as Partial<PollContent> | null
    if (p && p.type === 'poll' && typeof p.pollId === 'string' && typeof p.question === 'string') {
      return p as PollContent
    }
  }
  return null
}

/** One-line preview of a poll message ("📊 question"), or null for any other message. */
export function pollPreview(content: readonly unknown[] | null | undefined): string | null {
  const poll = pollPartOf(content)
  return poll ? `📊 ${poll.question}` : null
}

/** Trimmed, non-empty answers in order. */
export function normalizePollAnswers(answers: readonly string[]): string[] {
  return answers.map((a) => a.trim()).filter((a) => a.length > 0)
}

export type PollDraftProblem = 'question' | 'answers' | 'answerLength' | 'duplicate'

/** What keeps a draft from being posted, or null. Mirrors create_message_poll's checks. */
export function pollDraftProblem(question: string, answers: readonly string[]): PollDraftProblem | null {
  const q = question.trim()
  if (q.length < 1 || q.length > POLL_QUESTION_MAX) return 'question'
  const list = normalizePollAnswers(answers)
  if (list.length < POLL_MIN_ANSWERS || list.length > POLL_MAX_ANSWERS) return 'answers'
  if (list.some((a) => a.length > POLL_ANSWER_MAX)) return 'answerLength'
  if (new Set(list.map((a) => a.toLowerCase())).size !== list.length) return 'duplicate'
  return null
}

/** Share of voters who chose an answer, 0-100. A multiple-choice poll's shares sum past 100. */
export function pollPercent(votes: number, totalVoters: number): number {
  if (!totalVoters || totalVoters <= 0 || !votes || votes <= 0) return 0
  return Math.min(100, Math.round((votes / totalVoters) * 100))
}

export interface PollTimeLeft {
  unit: 'days' | 'hours' | 'minutes'
  value: number
}

/** Time until expiresAt, rounded up, in the largest whole unit; null once passed or with no end. */
export function pollTimeLeft(expiresAt: string | null | undefined, now: number = Date.now()): PollTimeLeft | null {
  if (!expiresAt) return null
  const end = Date.parse(expiresAt)
  if (Number.isNaN(end)) return null
  const ms = end - now
  if (ms <= 0) return null
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return { unit: 'minutes', value: minutes }
  const hours = Math.ceil(ms / 3_600_000)
  if (hours < 48) return { unit: 'hours', value: hours }
  return { unit: 'days', value: Math.ceil(ms / 86_400_000) }
}
