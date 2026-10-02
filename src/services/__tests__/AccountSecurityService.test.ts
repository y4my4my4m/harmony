import { describe, it, expect, beforeAll } from 'vitest'
import { retryAfterSeconds, securityErrorMessage, recoveryCodesText } from '@/services/AccountSecurityService'
import { waitForInitialLocale } from '@/i18n'

beforeAll(async () => {
  await waitForInitialLocale()
})

describe('securityErrorMessage', () => {
  it('turns the attempt budget into a wait time', () => {
    const error = { code: 'PT429', message: 'too_many_attempts', details: 'retry_after=600' }
    expect(retryAfterSeconds(error)).toBe(600)
    expect(securityErrorMessage(error)).toBe('Too many incorrect attempts. Try again in 10 minutes.')
  })

  it('explains the export limit', () => {
    expect(securityErrorMessage({ code: 'PT429', message: 'export_rate_limited', details: 'retry_after=30' }))
      .toBe('You can request another export in 1 minute.')
  })

  it('maps GoTrue MFA errors', () => {
    expect(securityErrorMessage({ code: 'mfa_verification_failed', message: 'Invalid TOTP code entered' }))
      .toMatch(/didn't match/)
    expect(securityErrorMessage({ code: 'mfa_challenge_expired', message: 'x' })).toMatch(/expired/)
    expect(securityErrorMessage({ code: 'PT403', message: 'insufficient_aal' })).toMatch(/two-factor/)
    expect(securityErrorMessage({ code: 'PT403', message: 'step_up_required' })).toMatch(/authenticator app first/)
  })

  it('falls back to the auth message for anything else', () => {
    expect(securityErrorMessage({ message: 'Something odd' })).toBe('Something odd')
    expect(securityErrorMessage({}, 'Fallback')).toBe('Fallback')
  })
})

describe('recoveryCodesText', () => {
  it('lists every code with instructions', () => {
    const text = recoveryCodesText(['AAAAA-BBBBB', 'CCCCC-DDDDD'], 'me@test.local')
    expect(text).toContain('me@test.local')
    expect(text).toContain('AAAAA-BBBBB\nCCCCC-DDDDD')
  })
})
