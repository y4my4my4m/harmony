import { describe, it, expect } from 'vitest'
import {
  cleanDbMessage,
  describeBlockNotice,
  isModerationRejectionCode,
  moderationRejectionFromError,
} from '@/services/AutoModService'

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

  it('ignores unrelated errors', () => {
    expect(moderationRejectionFromError({ message: 'new row violates row-level security policy' })).toBeNull()
    expect(moderationRejectionFromError(null)).toBeNull()
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
