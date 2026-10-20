import { describe, expect, it } from 'vitest'
import { parseInteractionUri, postPreviewText, profileRouteHandle } from '../authorizeInteraction'

const UUID = 'f0240000-0000-0000-0000-000000000001'

describe('parseInteractionUri', () => {
  it('reads a handle in every spelling, Lemmy communities included', () => {
    for (const raw of ['ann@mastodon.test', '@ann@mastodon.test', 'acct:ann@mastodon.test', ' ann@Mastodon.TEST ']) {
      expect(parseInteractionUri(raw, 'harmony.test')).toEqual({ kind: 'handle', username: 'ann', domain: 'mastodon.test' })
    }
    expect(parseInteractionUri('!tech@lemmy.test', 'harmony.test')).toEqual({ kind: 'handle', username: 'tech', domain: 'lemmy.test' })
  })

  it('reads a handle on this instance as a local profile', () => {
    expect(parseInteractionUri('@alice@harmony.test', 'harmony.test')).toEqual({ kind: 'local-profile', username: 'alice' })
  })

  it('reads this instance\'s post and profile URLs', () => {
    expect(parseInteractionUri(`https://harmony.test/social/post/${UUID}`, 'harmony.test')).toEqual({ kind: 'local-post', postId: UUID })
    expect(parseInteractionUri(`https://harmony.test/posts/${UUID.toUpperCase()}`, 'harmony.test')).toEqual({ kind: 'local-post', postId: UUID })
    for (const path of ['/users/alice', '/social/profile/alice', '/@alice']) {
      expect(parseInteractionUri(`https://harmony.test${path}`, 'harmony.test')).toEqual({ kind: 'local-profile', username: 'alice' })
    }
  })

  it('passes any other http(s) URL on, local paths it does not know included', () => {
    expect(parseInteractionUri('https://mastodon.test/@ann/1', 'harmony.test')).toEqual({ kind: 'url', url: 'https://mastodon.test/@ann/1' })
    expect(parseInteractionUri('https://harmony.test/chat', 'harmony.test')).toEqual({ kind: 'url', url: 'https://harmony.test/chat' })
  })

  it('is null for anything else', () => {
    for (const raw of ['', '   ', 'ann', 'javascript:alert(1)', 'ftp://x.test/a', 'ann@', '@ann@exa mple.test', undefined, 7]) {
      expect(parseInteractionUri(raw, 'harmony.test')).toBeNull()
    }
  })
})

describe('profileRouteHandle', () => {
  it('is the username here and username@domain elsewhere', () => {
    expect(profileRouteHandle({ username: 'alice', domain: 'harmony.test', is_local: true })).toBe('alice')
    expect(profileRouteHandle({ username: 'tech', domain: 'lemmy.test', is_local: false })).toBe('tech@lemmy.test')
    expect(profileRouteHandle({ username: null })).toBeNull()
  })
})

describe('postPreviewText', () => {
  it('joins text, mentions, hashtags and links, collapsed and cut', () => {
    const content = [
      { type: 'text', text: 'Hello ' },
      { type: 'mention', username: 'ann' },
      { type: 'text', text: '\n\nsee ' },
      { type: 'hashtag', name: 'rust' },
      { type: 'emoji', emoji: {} },
    ]
    expect(postPreviewText(content)).toBe('Hello @ann see #rust')
    expect(postPreviewText([{ type: 'text', text: 'x'.repeat(400) }], 10)).toBe(`${'x'.repeat(9)}…`)
    expect(postPreviewText(null)).toBe('')
  })
})
