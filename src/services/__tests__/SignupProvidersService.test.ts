import { describe, expect, it } from 'vitest'
import { parseSignupProviders, serializeSignupProviders } from '@/services/SignupProvidersService'

// The hook's reading of instance_config.signup_providers (20261126500001): an object of objects,
// mode read without case; anything else follows registration.
describe('parseSignupProviders', () => {
  it('reads open and domains entries', () => {
    expect(parseSignupProviders({
      'custom:school': { mode: 'Domains', domains: ['myschool.edu', 7, 'corp.example'] },
      discord: { mode: 'open', domains: ['ignored.example'] },
    })).toEqual({
      'custom:school': { mode: 'domains', domains: ['myschool.edu', 'corp.example'] },
      discord: { mode: 'open', domains: [] },
    })
  })

  it('leaves out what follows registration', () => {
    expect(parseSignupProviders({ a: { mode: 'everyone' }, b: 'open', c: ['open'], d: null, e: {} })).toEqual({})
    for (const raw of [null, undefined, 'x', [], 3]) expect(parseSignupProviders(raw)).toEqual({})
  })

  it('keeps a domains entry without a list, which the hook reads as admitting no one', () => {
    expect(parseSignupProviders({ a: { mode: 'domains', domains: 'myschool.edu' } })).toEqual({ a: { mode: 'domains', domains: [] } })
  })
})

describe('serializeSignupProviders', () => {
  it('stores open and domains, drops follow, in id order', () => {
    const out = serializeSignupProviders({
      'custom:school': { mode: 'domains', domains: ['myschool.edu'] },
      discord: { mode: 'follow', domains: ['left.example'] },
      'custom:aa': { mode: 'open', domains: ['left.example'] },
    })
    expect(out).toEqual({ 'custom:aa': { mode: 'open' }, 'custom:school': { mode: 'domains', domains: ['myschool.edu'] } })
    expect(Object.keys(out)).toEqual(['custom:aa', 'custom:school'])
  })

  it('reads back what it stores', () => {
    const entries = { x: { mode: 'domains' as const, domains: ['a.example'] }, y: { mode: 'open' as const, domains: [] } }
    expect(parseSignupProviders(serializeSignupProviders(entries))).toEqual(entries)
  })
})
