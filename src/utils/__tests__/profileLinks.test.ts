import { describe, it, expect } from 'vitest'
import { profileLinkFromPath, profileLinkFromUrl } from '../profileLinks'

// tests/setup.ts: VITE_DOMAIN harmony.test.
describe('profileLinkFromUrl', () => {
  it('reads every address of a local account', () => {
    for (const path of ['/@alice', '/@alice/', '/@alice@harmony.test', '/social/profile/alice', '/social/profile/@alice', '/profile/alice', '/users/alice', '/@alice?before=x']) {
      expect(profileLinkFromUrl(`https://harmony.test${path}`), path).toEqual({ username: 'alice', domain: null })
    }
  })

  it('reads a remote account, its domain in lower case', () => {
    expect(profileLinkFromUrl('https://harmony.test/@bob@Remote.Example')).toEqual({ username: 'bob', domain: 'remote.example' })
    expect(profileLinkFromUrl('https://harmony.test/social/profile/bob@remote.example')).toEqual({ username: 'bob', domain: 'remote.example' })
    expect(profileLinkFromUrl('https://harmony.test/@bob%40remote.example')).toEqual({ username: 'bob', domain: 'remote.example' })
  })

  it('leaves posts, other paths and other hosts alone', () => {
    expect(profileLinkFromUrl('https://harmony.test/@alice/0b0e0000-0000-4000-8000-000000000001')).toBeNull()
    expect(profileLinkFromUrl('https://harmony.test/users/alice/outbox')).toBeNull()
    expect(profileLinkFromUrl('https://harmony.test/users/bob@remote.example')).toBeNull()
    expect(profileLinkFromUrl('https://harmony.test/chat')).toBeNull()
    expect(profileLinkFromUrl('https://mastodon.social/@alice')).toBeNull()
    expect(profileLinkFromUrl('ftp://harmony.test/@alice')).toBeNull()
    expect(profileLinkFromUrl('not a url')).toBeNull()
  })

  it('refuses a local name no account here can have', () => {
    expect(profileLinkFromPath('/@al.ice')).toBeNull()
    expect(profileLinkFromPath('/@al.ice@remote.example')).toEqual({ username: 'al.ice', domain: 'remote.example' })
  })
})
