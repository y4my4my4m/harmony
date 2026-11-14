/**
 * src/utils/signupCaptcha.ts: the hook's 428 ask, the public settings, the widget page's address
 * and the messages it sends.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const stored = vi.hoisted(() => ({ value: null as null | { origin: string } }))
vi.mock('@/services/instanceConfig', () => ({ getStoredInstance: () => stored.value }))
vi.mock('@/supabase', () => ({ supabase: {} }))

import {
  CAPTCHA_ASK_STATUS,
  captchaFrameSrc,
  captchaPageOrigin,
  isCaptchaAsk,
  parseSignupCaptchaConfig,
  readCaptchaEvent,
} from '@/utils/signupCaptcha'

const rows = (provider: unknown, siteKey: unknown) => [
  { config_key: 'signup_captcha_provider', config_value: provider },
  { config_key: 'signup_captcha_site_key', config_value: siteKey },
]

describe('signup captcha', () => {
  beforeEach(() => {
    stored.value = null
  })

  it('reads the hook ask from the status GoTrue relays', () => {
    expect(CAPTCHA_ASK_STATUS).toBe(428)
    expect(isCaptchaAsk({ status: 428, message: 'Complete the check to finish signing up.' })).toBe(true)
    expect(isCaptchaAsk({ status: 429, message: 'x' })).toBe(false)
    expect(isCaptchaAsk({ status: '428' })).toBe(false)
    expect(isCaptchaAsk(null)).toBe(false)
  })

  it('takes a known provider with a site key, and nothing else', () => {
    expect(parseSignupCaptchaConfig(rows('turnstile', '0x4AAAAAAAB-c_d'))).toEqual({ provider: 'turnstile', siteKey: '0x4AAAAAAAB-c_d' })
    expect(parseSignupCaptchaConfig(rows('hcaptcha', ' 10000000-ffff-ffff-ffff-000000000001 '))).toEqual({
      provider: 'hcaptcha',
      siteKey: '10000000-ffff-ffff-ffff-000000000001',
    })
    expect(parseSignupCaptchaConfig(rows('off', '0x4AAAAAAAB'))).toBeNull()
    expect(parseSignupCaptchaConfig(rows('recaptcha', '0x4AAAAAAAB'))).toBeNull()
    expect(parseSignupCaptchaConfig(rows('turnstile', ''))).toBeNull()
    expect(parseSignupCaptchaConfig(rows('turnstile', 'a"><script>'))).toBeNull()
    expect(parseSignupCaptchaConfig(rows(true, '0x4AAAAAAAB'))).toBeNull()
    expect(parseSignupCaptchaConfig([])).toBeNull()
  })

  it('frames the widget page of this page in a browser', () => {
    expect(captchaPageOrigin()).toBe(window.location.origin)
    const src = new URL(captchaFrameSrc({ provider: 'turnstile', siteKey: 'k1' }, { theme: 'dark', lang: 'ja' }))
    expect(src.origin).toBe(window.location.origin)
    expect(src.pathname).toBe('/embed-player.html')
    expect(Object.fromEntries(src.searchParams)).toEqual({ captcha: 'turnstile', sitekey: 'k1', theme: 'dark', lang: 'ja' })
  })

  it('frames the stored instance in the native apps, whose hostname the site key names', () => {
    stored.value = { origin: 'https://har.mony.lol/' }
    expect(captchaPageOrigin()).toBe('https://har.mony.lol')
    expect(captchaFrameSrc({ provider: 'hcaptcha', siteKey: 'k2' })).toBe('https://har.mony.lol/embed-player.html?captcha=hcaptcha&sitekey=k2')
    stored.value = { origin: 'http://insecure.example' }
    expect(captchaPageOrigin()).toBe(window.location.origin)
    stored.value = { origin: 'not a url' }
    expect(captchaPageOrigin()).toBe(window.location.origin)
  })

  describe('widget page messages', () => {
    const frame = {} as Window
    const origin = 'https://har.mony.lol'
    const msg = (data: unknown, source: unknown = frame, from = origin) =>
      ({ data, source, origin: from }) as unknown as MessageEvent

    it('reads the token and the other events', () => {
      expect(readCaptchaEvent(msg({ harmonyPlayer: 1, ev: 'captcha', token: 'tok' }), frame, origin)).toEqual({ ev: 'captcha', token: 'tok' })
      expect(readCaptchaEvent(msg({ harmonyPlayer: 1, ev: 'captcha-ready' }), frame, origin)).toEqual({ ev: 'captcha-ready' })
      expect(readCaptchaEvent(msg({ harmonyPlayer: 1, ev: 'captcha-expired' }), frame, origin)).toEqual({ ev: 'captcha-expired' })
      expect(readCaptchaEvent(msg({ harmonyPlayer: 1, ev: 'captcha-error', message: '110200' }), frame, origin)).toEqual({
        ev: 'captcha-error',
        message: '110200',
      })
      expect(readCaptchaEvent(msg({ harmonyPlayer: 1, ev: 'captcha-size', height: 600.4 }), frame, origin)).toEqual({ ev: 'captcha-size', height: 600 })
      expect(readCaptchaEvent(msg({ harmonyPlayer: 1, ev: 'captcha-size', height: 5000 }), frame, origin)).toEqual({ ev: 'captcha-size', height: 800 })
    })

    it('ignores other windows, other origins and malformed data', () => {
      const token = { harmonyPlayer: 1, ev: 'captcha', token: 'tok' }
      expect(readCaptchaEvent(msg(token, {}), frame, origin)).toBeNull()
      expect(readCaptchaEvent(msg(token, frame, 'https://evil.example'), frame, origin)).toBeNull()
      expect(readCaptchaEvent(msg(token), null, origin)).toBeNull()
      expect(readCaptchaEvent(msg({ ev: 'captcha', token: 'tok' }), frame, origin)).toBeNull()
      expect(readCaptchaEvent(msg({ harmonyPlayer: 1, ev: 'captcha', token: '' }), frame, origin)).toBeNull()
      expect(readCaptchaEvent(msg({ harmonyPlayer: 1, ev: 'captcha', token: 'x'.repeat(4097) }), frame, origin)).toBeNull()
      expect(readCaptchaEvent(msg({ harmonyPlayer: 1, ev: 'captcha-size', height: -1 }), frame, origin)).toBeNull()
      expect(readCaptchaEvent(msg({ harmonyPlayer: 1, ev: 'state' }), frame, origin)).toBeNull()
      expect(readCaptchaEvent(msg('captcha'), frame, origin)).toBeNull()
    })
  })
})
