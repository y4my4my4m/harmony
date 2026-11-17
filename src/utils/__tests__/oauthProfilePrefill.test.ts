import { describe, it, expect } from 'vitest'
import { oauthProfilePrefill } from '@/utils/oauthProfilePrefill'

describe('oauthProfilePrefill', () => {
  it('reads a Discord identity: display name from global_name, username from full_name', () => {
    // user_metadata as GoTrue 2.197.0's discord provider writes it (provider/discord.go).
    const metadata = {
      iss: 'https://discord.com/api',
      sub: '80351110224678912',
      name: 'nelly#0',
      full_name: 'nelly',
      avatar_url: 'https://cdn.discordapp.com/avatars/80351110224678912/8342729096ea3675442027381ff50dfe.png',
      picture: 'https://cdn.discordapp.com/avatars/80351110224678912/8342729096ea3675442027381ff50dfe.png',
      provider_id: '80351110224678912',
      custom_claims: { global_name: 'Nelly' },
      email: 'nelly@discord.test',
    }
    expect(oauthProfilePrefill(metadata, [{ provider: 'discord' }], 'nelly@discord.test')).toEqual({
      avatar: metadata.avatar_url,
      displayName: 'Nelly',
      bio: '',
      username: 'nelly',
    })
  })

  it('falls back to the username when Discord has no display name', () => {
    const p = oauthProfilePrefill({ name: 'nelly#0', full_name: 'nelly', custom_claims: { global_name: null } }, [{ provider: 'discord' }])
    expect(p.displayName).toBe('nelly')
    expect(p.username).toBe('nelly')
  })

  it('keeps the other providers as before', () => {
    expect(oauthProfilePrefill({ full_name: 'Ada L', user_name: 'ada', avatar_url: 'https://x.test/a.png', bio: 'hi' }, [{ provider: 'github' }])).toEqual({
      avatar: 'https://x.test/a.png', displayName: 'Ada L', bio: 'hi', username: 'ada',
    })
    // full_name is a person's name elsewhere, never a username.
    expect(oauthProfilePrefill({ full_name: 'Ada Lovelace' }, [{ provider: 'google' }], 'ada@x.test').username).toBe('ada')
  })

  it('takes nothing but the address-based username without an OAuth identity', () => {
    expect(oauthProfilePrefill({ full_name: 'X', avatar_url: 'https://x.test/a.png' }, [{ provider: 'email' }], 'bob@x.test')).toEqual({
      avatar: null, displayName: '', bio: '', username: 'bob',
    })
  })
})
