import { describe, expect, it } from 'vitest'
import {
  normalizePollAnswers,
  pollDraftProblem,
  pollPartOf,
  pollPercent,
  pollPreview,
  pollTimeLeft,
} from '@/utils/messagePoll'
import { previewParts, previewText } from '@/utils/todaySummary'
import type { MessagePart } from '@/types'

const POLL_MESSAGE = [
  { type: 'poll', pollId: 'p1', question: 'Lunch?', options: ['Pizza', 'Sushi'], allowMultiple: false },
  { type: 'text', text: '📊 Lunch?\n1. Pizza\n2. Sushi' },
] as MessagePart[]

describe('poll parts', () => {
  it('finds the poll part of a message', () => {
    expect(pollPartOf(POLL_MESSAGE)?.pollId).toBe('p1')
    expect(pollPartOf([{ type: 'text', text: 'hi' }])).toBeNull()
    expect(pollPartOf([{ type: 'poll' }])).toBeNull()
    expect(pollPartOf(null)).toBeNull()
  })

  it('previews a poll by its question', () => {
    expect(pollPreview(POLL_MESSAGE)).toBe('📊 Lunch?')
    expect(pollPreview([{ type: 'text', text: 'hi' }])).toBeNull()
  })

  it('previews a poll in Today by its question, not the spelled-out answers', () => {
    expect(previewText(POLL_MESSAGE)).toBe('📊 Lunch?')
    expect(previewParts(POLL_MESSAGE)).toEqual({ parts: [{ type: 'text', text: '📊 Lunch?' }], attachments: 0 })
  })
})

describe('poll drafts', () => {
  it('trims answers and drops blank ones', () => {
    expect(normalizePollAnswers([' a ', '', '  ', 'b'])).toEqual(['a', 'b'])
  })

  it('names what keeps a draft from being posted', () => {
    expect(pollDraftProblem('  ', ['a', 'b'])).toBe('question')
    expect(pollDraftProblem('q'.repeat(301), ['a', 'b'])).toBe('question')
    expect(pollDraftProblem('Q', ['a', ' '])).toBe('answers')
    expect(pollDraftProblem('Q', Array.from({ length: 11 }, (_, i) => `a${i}`))).toBe('answers')
    expect(pollDraftProblem('Q', ['a', 'b'.repeat(101)])).toBe('answerLength')
    expect(pollDraftProblem('Q', ['Yes', ' yes'])).toBe('duplicate')
    expect(pollDraftProblem('Q', ['a', 'b', ''])).toBeNull()
  })
})

describe('poll results', () => {
  it('shares are of voters, rounded', () => {
    expect(pollPercent(1, 3)).toBe(33)
    expect(pollPercent(2, 3)).toBe(67)
    expect(pollPercent(0, 0)).toBe(0)
    expect(pollPercent(5, 5)).toBe(100)
  })

  it('time left is rounded up in the largest whole unit', () => {
    const now = Date.parse('2026-10-10T12:00:00Z')
    expect(pollTimeLeft('2026-10-10T12:00:30Z', now)).toEqual({ unit: 'minutes', value: 1 })
    expect(pollTimeLeft('2026-10-10T12:59:00Z', now)).toEqual({ unit: 'minutes', value: 59 })
    expect(pollTimeLeft('2026-10-11T12:00:00Z', now)).toEqual({ unit: 'hours', value: 24 })
    expect(pollTimeLeft('2026-10-17T12:00:00Z', now)).toEqual({ unit: 'days', value: 7 })
    expect(pollTimeLeft('2026-10-10T11:00:00Z', now)).toBeNull()
    expect(pollTimeLeft(null, now)).toBeNull()
  })
})
