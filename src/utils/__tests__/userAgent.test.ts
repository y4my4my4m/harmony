import { describe, it, expect, beforeAll } from 'vitest'
import { describeUserAgent } from '@/utils/userAgent'
import { securityNoticeText } from '@/utils/securityNotice'
import { recoveryCodeLength } from '@/utils/mfaConstants'
import { waitForInitialLocale } from '@/i18n'

beforeAll(async () => {
  await waitForInitialLocale()
})

describe('describeUserAgent', () => {
  it('names browser and system', () => {
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'))
      .toEqual({ label: 'Firefox on Linux', kind: 'desktop' })
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'))
      .toEqual({ label: 'Edge on Windows', kind: 'desktop' })
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'))
      .toEqual({ label: 'Safari on iOS', kind: 'phone' })
  })

  it('recognises the native apps by their webview', () => {
    expect(describeUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36').label)
      .toBe('Harmony app on Android')
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15').label)
      .toBe('Harmony app on Linux')
  })

  it('reports unknown agents as such', () => {
    expect(describeUserAgent(null)).toEqual({ label: null, kind: 'unknown' })
    expect(describeUserAgent('curl/8.0')).toEqual({ label: null, kind: 'unknown' })
  })
})

describe('securityNoticeText', () => {
  it('describes a new sign-in with its device and address', () => {
    const text = securityNoticeText({
      event: 'new_sign_in',
      user_agent: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
      ip: '203.0.113.7',
    })
    expect(text.title).toBe('New sign-in to your account')
    expect(text.message.startsWith('Firefox on Linux · 203.0.113.7.')).toBe(true)
  })

  it('explains a recovery-code disable', () => {
    expect(securityNoticeText({ event: 'mfa_disabled', reason: 'recovery_code' }).message).toMatch(/recovery code/)
    expect(securityNoticeText({}).title).toBe('Account security')
  })
})

describe('recoveryCodeLength', () => {
  it('counts letters and digits only', () => {
    expect(recoveryCodeLength('ABCDE-12345')).toBe(10)
    expect(recoveryCodeLength(' abcd 1234 ')).toBe(8)
  })
})
