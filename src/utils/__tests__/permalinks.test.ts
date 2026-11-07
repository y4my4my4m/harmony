import { describe, it, expect } from 'vitest'
import { isSocialPath, postPath, postUrl, profileHandleParam, profilePath, profileUrl, tagPath, tagUrl } from '../permalinks'

// tests/setup.ts: VITE_DOMAIN harmony.test.
const alice = { username: 'alice', domain: 'harmony.test', is_local: true }
const bob = { username: 'bob', domain: 'remote.example', is_local: false }
const BASE = 'https://harmony.test/'

describe('permalinks', () => {
  it('addresses a local account at /@user and a remote one at /@user@domain', () => {
    expect(profilePath(alice)).toBe('/@alice')
    expect(profilePath({ username: 'alice', domain: 'harmony.test' })).toBe('/@alice')
    expect(profilePath(bob)).toBe('/@bob@remote.example')
    expect(profilePath({ handle: '@bob@remote.example' })).toBe('/@bob@remote.example')
    expect(profileHandleParam({ username: 'bob', domain: 'remote.example:8443', is_local: false })).toBe('bob@remote.example%3A8443')
    expect(profilePath({})).toBeNull()
    expect(profileUrl(bob, BASE)).toBe('https://harmony.test/@bob@remote.example')
  })

  it('addresses a post under its author, /posts/<id> without one', () => {
    expect(postPath({ id: 'p1', author: alice })).toBe('/@alice/p1')
    expect(postPath({ id: 'p2', author: bob })).toBe('/@bob@remote.example/p2')
    expect(postPath({ id: 'p3' })).toBe('/posts/p3')
    expect(postUrl({ id: 'p1', author: alice }, BASE)).toBe('https://harmony.test/@alice/p1')
  })

  it('addresses a hashtag at /tags/<tag>, encoded, without its #', () => {
    expect(tagPath('art')).toBe('/tags/art')
    expect(tagPath('#日本')).toBe(`/tags/${encodeURIComponent('日本')}`)
    expect(tagUrl('art', BASE)).toBe('https://harmony.test/tags/art')
  })

  it('names the paths SocialLayout serves', () => {
    for (const p of ['/social', '/social/home', '/posts/x', '/@alice', '/@alice/x', '/tags/art']) expect(isSocialPath(p)).toBe(true)
    for (const p of ['/chat', '/dm/x', '/settings', '/socialx', '/tags']) expect(isSocialPath(p)).toBe(false)
  })
})
