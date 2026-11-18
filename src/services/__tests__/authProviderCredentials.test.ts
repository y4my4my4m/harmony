import { describe, it, expect, vi } from 'vitest'

vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/services/runtimeConfig', () => ({ runtimeConfig: {} }))

import { credentialProblem, parseButtonList } from '@/services/authProviderCredentials'

const stored = { provider: 'google' as const, clientId: 'abc', hasSecret: true, updatedAt: null }

describe('credentialProblem', () => {
  it('accepts the shapes providers issue', () => {
    expect(credentialProblem('google', '1234-abc.apps.googleusercontent.com', 'GOCSPX-abc_DEF123', undefined)).toBeNull()
    expect(credentialProblem('github', 'Ov23liAbCdEf', '0123456789abcdef0123456789abcdef01234567', undefined)).toBeNull()
    expect(credentialProblem('discord', '123456789012345678', 'aBcD_eFgH-1234567890', undefined)).toBeNull()
  })

  it('names what the database would refuse', () => {
    expect(credentialProblem('discord', 'abc', 'secret-123', undefined)).toBe('discordId')
    expect(credentialProblem('google', 'a b', 'secret-123', undefined)).toBe('clientId')
    expect(credentialProblem('google', 'a,b', 'secret-123', undefined)).toBe('clientId')
    expect(credentialProblem('google', 'abc', 'short', undefined)).toBe('secret')
    expect(credentialProblem('google', 'abc', 'abc\nGOTRUE_JWT_SECRET=x', undefined)).toBe('secret')
    expect(credentialProblem('google', 'abc', '#comment-1', undefined)).toBe('secret')
  })

  it('needs both for a new provider, either for a stored one', () => {
    expect(credentialProblem('google', 'abc', '', undefined)).toBe('needBoth')
    expect(credentialProblem('google', '', 'secret-123', undefined)).toBe('needBoth')
    expect(credentialProblem('google', '', 'secret-123', stored)).toBeNull()
    expect(credentialProblem('google', 'xyz', '', stored)).toBeNull()
  })
})

describe('parseButtonList', () => {
  it('reads every form AuthComponent reads, in built-in order', () => {
    expect(parseButtonList(['discord', 'google', 'custom:x'])).toEqual(['google', 'discord'])
    expect(parseButtonList({ github: true, twitch: 'true', google: false })).toEqual(['twitch', 'github'])
    expect(parseButtonList('google, Discord')).toEqual(['google', 'discord'])
    expect(parseButtonList('["twitch"]')).toEqual(['twitch'])
    expect(parseButtonList('[broken')).toEqual([])
    expect(parseButtonList(null)).toEqual([])
  })
})
