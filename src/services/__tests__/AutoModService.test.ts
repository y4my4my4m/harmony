import { describe, it, expect, vi, beforeAll } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: toastError }) }))

import {
  isLastingRejectionCode,
  cleanDbMessage,
  describeBlockNotice,
  formatRetryWait,
  isModerationRejectionCode,
  moderationRejectionFromError,
  notifyModerationRejection,
} from '@/services/AutoModService'
import { i18n } from '@/i18n'
import en from '@/locales/en.json'

describe('moderationRejectionFromError', () => {
  it('reads AUTOMOD_BLOCKED from a singular-request error with its JSON detail', () => {
    const r = moderationRejectionFromError({
      code: 'P0001',
      message: 'AUTOMOD_BLOCKED:mention_spam',
      details: '{"rule_type":"mention_spam","rule_name":"Block mention spam","message":"Too many pings"}',
    })
    expect(r).toMatchObject({ code: 'AUTOMOD_BLOCKED', message: 'Too many pings' })
  })

  it('reads the code from a wrapped INSERT_FAILED message', () => {
    const r = moderationRejectionFromError({ code: 'INSERT_FAILED', message: 'MEMBER_TIMED_OUT:1790000000' })
    expect(r?.code).toBe('MEMBER_TIMED_OUT')
    expect(r?.details).toEqual({ until: '1790000000' })
  })

  it('maps the anti-spam limits', () => {
    expect(moderationRejectionFromError({ message: 'ANTISPAM_RATE_LIMITED:42' })?.code).toBe('ANTISPAM_RATE_LIMITED')
    expect(moderationRejectionFromError({ message: 'ANTISPAM_LINKS_BLOCKED' })?.code).toBe('ANTISPAM_LINKS_BLOCKED')
    expect(moderationRejectionFromError({ message: 'ANTISPAM_STRANGER_MENTIONS:3' })?.code).toBe('ANTISPAM_STRANGER_MENTIONS')
  })

  it('maps a rules rejection with its server id', () => {
    const r = moderationRejectionFromError({
      code: 'P0001',
      message: 'RULES_NOT_ACCEPTED:55555555-0000-0000-0000-000000000005',
    })
    expect(r?.code).toBe('RULES_NOT_ACCEPTED')
    expect(r?.details).toEqual({ serverId: '55555555-0000-0000-0000-000000000005' })
    expect(isModerationRejectionCode('INSERT_FAILED RULES_NOT_ACCEPTED')).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(moderationRejectionFromError({ message: 'new row violates row-level security policy' })).toBeNull()
    expect(moderationRejectionFromError(null)).toBeNull()
  })
})

describe('instance limit refusals', () => {
  it('reads each code from a database error, with its number', () => {
    expect(moderationRejectionFromError({ message: 'SERVER_LIMIT_REACHED:100' })?.code).toBe('SERVER_LIMIT_REACHED')
    expect(moderationRejectionFromError({ message: 'BOT_LIMIT_REACHED:25' })?.code).toBe('BOT_LIMIT_REACHED')
    expect(moderationRejectionFromError({ message: 'DM_NOT_ALLOWED' })?.code).toBe('DM_NOT_ALLOWED')
    expect(moderationRejectionFromError({ code: 'P0001', message: 'DM_UNDELIVERABLE' })).toEqual({
      code: 'DM_UNDELIVERABLE', message: i18n.global.t('dm.undeliverable'),
    })
    expect(isModerationRejectionCode('DM_UNDELIVERABLE')).toBe(true)
    expect(moderationRejectionFromError({ code: 'P0001', message: 'GROUP_CONVERSATION_FULL:10' })).toEqual({
      code: 'GROUP_CONVERSATION_FULL', message: i18n.global.t('dm.groupFull', { count: '10' }),
    })
  })

  it('reads a code a wrapper kept inside its own message', () => {
    expect(moderationRejectionFromError(new Error('Server creation failed: SERVER_LIMIT_REACHED:2'))?.code)
      .toBe('SERVER_LIMIT_REACHED')
  })

  it('shows a refusal once and reports any other error as not one', () => {
    toastError.mockClear()
    expect(notifyModerationRejection({ message: 'ANTISPAM_RATE_LIMITED:12' })).toBe(true)
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(notifyModerationRejection({ message: 'something else' })).toBe(false)
    expect(notifyModerationRejection(null)).toBe(false)
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})

describe('rate limit refusals', () => {
  beforeAll(() => {
    i18n.global.setLocaleMessage('en', en as any)
    i18n.global.locale.value = 'en'
  })

  it('words the wait in one rounded-up unit', () => {
    expect(formatRetryWait(1, 'en')).toBe('1 second')
    expect(formatRetryWait(45, 'en')).toBe('45 seconds')
    expect(formatRetryWait(61, 'en')).toBe('2 minutes')
    expect(formatRetryWait(3540, 'en')).toBe('59 minutes')
    expect(formatRetryWait(3599, 'en')).toBe('1 hour')
    expect(formatRetryWait(3600, 'en')).toBe('1 hour')
    expect(formatRetryWait(Number.NaN, 'en')).toBe('1 minute')
    expect(formatRetryWait(3540, 'ja')).toBe('59 分')
  })

  it('names new conversations with strangers, with their limit, from the PostgREST details', () => {
    const r = moderationRejectionFromError({
      code: 'P0001',
      message: 'ANTISPAM_RATE_LIMITED:3600',
      details: '{"kind" : "stranger_dm", "limit" : 5, "window_seconds" : 3600}',
      hint: 'An account can start a limited number of new conversations per hour.',
    })
    expect(r).toEqual({
      code: 'ANTISPAM_RATE_LIMITED',
      message: "New conversations with people you don't know are limited to 5 per hour. Try again in 1 hour.",
      details: { kind: 'stranger_dm', limit: 5, window_seconds: 3600 },
    })
  })

  it('says any other limit is reached too quickly, in minutes past a minute', () => {
    expect(moderationRejectionFromError({
      code: 'P0001',
      message: 'ANTISPAM_RATE_LIMITED:1790',
      details: '{"kind" : "follow", "limit" : 200, "window_seconds" : 3600}',
    })?.message).toBe("You're doing that too quickly. Try again in 30 minutes.")
  })

  it('reads a refusal without details, as an older server sends it', () => {
    expect(moderationRejectionFromError({ code: 'P0001', message: 'ANTISPAM_RATE_LIMITED:12', details: null }))
      .toEqual({ code: 'ANTISPAM_RATE_LIMITED', message: "You're doing that too quickly. Try again in 12 seconds." })
    expect(moderationRejectionFromError({ message: 'ANTISPAM_RATE_LIMITED:12', details: 'not json' })?.message)
      .toBe("You're doing that too quickly. Try again in 12 seconds.")
  })
})

describe('describeBlockNotice', () => {
  it('prefers the server\'s custom message', () => {
    expect(describeBlockNotice({ rule_type: 'keyword', message: 'No.' })).toBe('No.')
  })

  it('falls back to a rule-type sentence', () => {
    const text = describeBlockNotice({ rule_type: 'message_flood', message: null })
    expect(text).toBeTruthy()
    expect(text).not.toBe(describeBlockNotice({ rule_type: 'unknown-type', message: null }))
  })
})

describe('helpers', () => {
  it('recognises rejection codes inside longer strings', () => {
    expect(isModerationRejectionCode('INSERT_FAILED AUTOMOD_BLOCKED:keyword')).toBe(true)
    expect(isModerationRejectionCode('SLOWMODE_ACTIVE:5')).toBe(false)
    expect(isModerationRejectionCode(undefined)).toBe(false)
  })

  it('strips validation prefixes', () => {
    expect(cleanDbMessage('AUTOMOD_INVALID_RULE: at most 25 rules per server')).toBe('at most 25 rules per server')
  })
})

describe('isLastingRejectionCode', () => {
  // A queued quick reply is dropped only for a refusal that answers the same on every retry.
  it('names refusals that answer the same on every retry', () => {
    expect(isLastingRejectionCode('AUTOMOD_BLOCKED')).toBe(true)
    expect(isLastingRejectionCode('DM_NOT_ALLOWED')).toBe(true)
    expect(isLastingRejectionCode('RULES_NOT_ACCEPTED')).toBe(true)
  })

  it('counts a timeout as lasting: it may run for days, and the reply would post long after', () => {
    expect(isLastingRejectionCode('MEMBER_TIMED_OUT:1790000000')).toBe(true)
  })

  it('leaves out a rate limit, which passes in seconds', () => {
    expect(isLastingRejectionCode('ANTISPAM_RATE_LIMITED:30')).toBe(false)
    expect(isLastingRejectionCode('23505')).toBe(false)
    expect(isLastingRejectionCode(null)).toBe(false)
  })
})
