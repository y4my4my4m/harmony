import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBlockedDomains, parseSignupCap, signupRefusalKey } from '@/utils/signupLimits'
import en from '@/locales/en.json'
import ja from '@/locales/ja.json'

const migration = readFileSync(
  resolve(__dirname, '../../../db_schema/migrations/20261109100001_signup_limits.sql'),
  'utf8',
)

describe('signupRefusalKey', () => {
  const texts = {
    ipCap: 'Too many accounts were created from this network today. Try again tomorrow, or ask this instance\'s admin for an invitation.',
    domainCap: 'Too many accounts were created with this email domain today. Try again tomorrow, or ask this instance\'s admin for an invitation.',
    mailboxCap: 'This email inbox has reached the limit of accounts on this instance.',
    blockedDomain: 'This email provider cannot be used to sign up on this instance. Use another address.',
  } as const

  it.each(Object.entries(texts))('maps the hook text of %s', (name, text) => {
    expect(signupRefusalKey({ message: text, status: 429 })).toBe(`auth.signupRefused.${name}`)
    expect(migration).toContain(`'${text.replace(/'/g, "''")}'`)
  })

  it('has every translation', () => {
    for (const name of Object.keys(texts) as Array<keyof typeof texts>) {
      expect(en.auth.signupRefused[name]).toBe(texts[name])
      expect(ja.auth.signupRefused[name]).toBeTruthy()
      expect(ja.auth.signupRefused[name]).not.toBe(texts[name])
    }
  })

  it('leaves any other error to authErrorMessage', () => {
    expect(signupRefusalKey({ message: 'User already registered', status: 422 })).toBeNull()
    expect(signupRefusalKey(null)).toBeNull()
    expect(signupRefusalKey({})).toBeNull()
  })
})

describe('parseSignupCap', () => {
  it('takes whole numbers from 0 to 1000', () => {
    expect(parseSignupCap(0)).toBe(0)
    expect(parseSignupCap(' 5 ')).toBe(5)
    expect(parseSignupCap('1000')).toBe(1000)
  })

  it('refuses anything else', () => {
    for (const raw of ['', ' ', '-1', '1.5', 'five', '1001', null, undefined]) {
      expect(parseSignupCap(raw)).toBeNull()
    }
  })
})

describe('parseBlockedDomains', () => {
  it('splits, folds and sorts', () => {
    expect(parseBlockedDomains('Spam.Example\n\n@b.example, a.example  a.example')).toEqual({
      domains: ['a.example', 'b.example', 'spam.example'],
      invalid: null,
    })
  })

  it('is empty for blank text', () => {
    expect(parseBlockedDomains(' \n ')).toEqual({ domains: [], invalid: null })
  })

  it('names the first entry that is no domain', () => {
    expect(parseBlockedDomains('ok.example\nno_domain\nalso bad').invalid).toBe('no_domain')
    expect(parseBlockedDomains('someone@example.org').invalid).toBe('someone@example.org')
    expect(parseBlockedDomains('nodot').invalid).toBe('nodot')
  })
})
