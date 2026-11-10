import { describe, it, expect, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: toastError }) }))

import {
  cleanDbMessage,
  describeBlockNotice,
  isModerationRejectionCode,
  moderationRejectionFromError,
  notifyModerationRejection,
} from '@/services/AutoModService'
import { i18n } from '@/i18n'

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
