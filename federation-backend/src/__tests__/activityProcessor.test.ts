import { describe, it, expect } from 'vitest'
import { determineVisibility, extractMessageId } from '../activitypub/ActivityProcessor.js'

describe('determineVisibility (ActivityPub audience targeting)', () => {
  const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
  const FOLLOWERS = 'https://mastodon.social/users/alice/followers'
  const USER = 'https://mastodon.social/users/bob'

  describe('public posts', () => {
    it('detects public when as:Public is in "to"', () => {
      const note = { to: [PUBLIC], cc: [FOLLOWERS] }
      expect(determineVisibility(note)).toBe('public')
    })

    it('detects public from Mastodon Create activity', () => {
      const note = {
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: ['https://mastodon.social/users/alice/followers'],
      }
      expect(determineVisibility(note)).toBe('public')
    })
  })

  describe('unlisted posts', () => {
    it('detects unlisted when Public is in "cc" only', () => {
      const note = { to: [FOLLOWERS], cc: [PUBLIC] }
      expect(determineVisibility(note)).toBe('unlisted')
    })

    it('defaults to unlisted when no recipients at all', () => {
      expect(determineVisibility({})).toBe('unlisted')
    })

    it('defaults to unlisted when to/cc are undefined', () => {
      expect(determineVisibility({ to: undefined, cc: undefined })).toBe('unlisted')
    })
  })

  describe('followers-only posts', () => {
    it('detects followers-only when only followers collection is addressed', () => {
      const note = { to: [FOLLOWERS], cc: [] }
      expect(determineVisibility(note)).toBe('followers')
    })

    it('detects followers-only with multiple follower collections', () => {
      const note = {
        to: [FOLLOWERS, 'https://other.server/users/bob/followers'],
        cc: [],
      }
      expect(determineVisibility(note)).toBe('followers')
    })
  })

  describe('direct messages', () => {
    it('detects direct when only specific users are addressed', () => {
      const note = {
        to: ['https://harmony.test/users/bob'],
        cc: [],
      }
      expect(determineVisibility(note)).toBe('direct')
    })

    it('detects direct with multiple user recipients', () => {
      const note = {
        to: [USER, 'https://harmony.test/users/charlie'],
        cc: [],
      }
      expect(determineVisibility(note)).toBe('direct')
    })

    it('detects direct from Mastodon DM format', () => {
      const note = {
        to: ['https://harmony.test/users/bob'],
        cc: [],
        // No Public URL, no followers collection
      }
      expect(determineVisibility(note)).toBe('direct')
    })
  })

  describe('edge cases', () => {
    it('handles non-array "to" field (single string)', () => {
      const note = { to: PUBLIC, cc: FOLLOWERS }
      expect(determineVisibility(note)).toBe('public')
    })

    it('handles null in to/cc arrays', () => {
      const note = { to: [null, PUBLIC], cc: [null] }
      expect(determineVisibility(note)).toBe('public')
    })

    it('Public in "to" takes precedence over followers in "cc"', () => {
      const note = { to: [PUBLIC], cc: [FOLLOWERS] }
      expect(determineVisibility(note)).toBe('public')
    })

    it('Misskey-style addressing with user groups', () => {
      const note = {
        to: ['https://misskey.io/users/alice/followers'],
        cc: [],
      }
      expect(determineVisibility(note)).toBe('followers')
    })
  })
})

describe('ActivityPub extractMessageId', () => {
  it('extracts UUID from valid message URL', () => {
    expect(extractMessageId('https://harmony.test/messages/550e8400-e29b-41d4-a716-446655440000'))
      .toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('returns null for post URL', () => {
    expect(extractMessageId('https://harmony.test/posts/550e8400-e29b-41d4-a716-446655440000'))
      .toBeNull()
  })

  it('returns null for empty string', () => {
    expect(extractMessageId('')).toBeNull()
  })

  it('returns null for null', () => {
    expect(extractMessageId(null as any)).toBeNull()
  })

  it('returns null for invalid UUID format', () => {
    expect(extractMessageId('https://harmony.test/messages/not-a-uuid')).toBeNull()
  })
})
