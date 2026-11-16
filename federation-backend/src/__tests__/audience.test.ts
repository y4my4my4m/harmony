import { describe, it, expect } from 'vitest'
import {
  AS_PUBLIC,
  addresses,
  audienceOf,
  authorActorUrl,
  isFollowersAddress,
  recipientsOf,
  visibilityOf,
} from '../activitypub/audience.js'

// Addressing of incoming objects, read once: audience properties as one value or an array, IRI
// strings or link objects, compact Public forms; visibility as Mastodon's visibility_from_audience,
// with the author's declared followers collection.

const ALICE = 'https://mastodon.test/users/alice'
const FOLLOWERS = `${ALICE}/followers`

describe('addresses', () => {
  it('reads one value or an array, IRIs or objects by id, in order and once each', () => {
    expect(addresses(ALICE)).toEqual([ALICE])
    expect(addresses([ALICE, { id: FOLLOWERS, type: 'Collection' }, 'https://x.test/u/b', ALICE]))
      .toEqual([ALICE, FOLLOWERS, 'https://x.test/u/b'])
  })

  it('stops at `limit` distinct addresses', () => {
    const many = Array.from({ length: 50_000 }, (_, i) => `https://x.test/u/${i % 25_000}`)
    expect(addresses(many)).toHaveLength(25_000)
    expect(addresses(many, 10)).toEqual(many.slice(0, 10))
  })

  it('reads an object by its id and never a Link href, as Mastodon, Misskey and Pleroma', () => {
    expect(addresses([{ type: 'Link', href: ALICE }])).toEqual([])
    expect(addresses([{ type: 'Mention', href: ALICE }])).toEqual([])
    expect(addresses([{ type: 'Link', id: 'https://x.test/link/1', href: ALICE }])).toEqual(['https://x.test/link/1'])
    expect(addresses([{ type: 'Person', id: ALICE, href: 'https://x.test/profile' }])).toEqual([ALICE])
  })

  it('expands the compact Public forms and drops what is not an address', () => {
    expect(addresses(['as:Public', 'Public', AS_PUBLIC])).toEqual([AS_PUBLIC])
    expect(addresses([null, undefined, '', 42, {}, { id: 7 }])).toEqual([])
    expect(addresses(undefined)).toEqual([])
  })
})

describe('audienceOf', () => {
  it('takes each property from the activity when the object does not state it', () => {
    const activity = { to: [FOLLOWERS], cc: ['https://x.test/u/b'] }
    expect(audienceOf({ cc: [AS_PUBLIC] }, activity)).toEqual({ to: [FOLLOWERS], cc: [AS_PUBLIC] })
    expect(audienceOf({}, activity)).toEqual({ to: [FOLLOWERS], cc: ['https://x.test/u/b'] })
  })

  it('keeps an empty list the object states', () => {
    expect(audienceOf({ to: [], cc: [] }, { to: [AS_PUBLIC] })).toEqual({ to: [], cc: [] })
  })

  it('lists every recipient once', () => {
    expect(recipientsOf({ to: [ALICE, FOLLOWERS], cc: [FOLLOWERS] })).toEqual([ALICE, FOLLOWERS])
  })
})

describe('isFollowersAddress', () => {
  it('is the stored followers collection when the author declares one', () => {
    const author = { actorUrl: ALICE, followersUrl: FOLLOWERS }
    expect(isFollowersAddress(`${FOLLOWERS}/`, author)).toBe(true)
    expect(isFollowersAddress('https://MASTODON.test:443/users/alice/followers', author)).toBe(true)
    expect(isFollowersAddress('https://mastodon.test/users/bob/followers', author)).toBe(false)
    expect(isFollowersAddress(`${ALICE}/fans`, { actorUrl: ALICE, followersUrl: `${ALICE}/fans` })).toBe(true)
  })

  it('takes a stored followers value that is no IRI for unknown', () => {
    const stored = { actorUrl: ALICE, followersUrl: '[object Object]' }
    expect(isFollowersAddress(FOLLOWERS, stored)).toBe(true)
    expect(isFollowersAddress('https://other.test/users/alice/followers', stored)).toBe(false)
  })

  it('is <actor>/followers when none is declared, as Misskey, and nothing without an author', () => {
    expect(isFollowersAddress(FOLLOWERS, { actorUrl: ALICE })).toBe(true)
    expect(isFollowersAddress(`${FOLLOWERS}/`, { actorUrl: `${ALICE}/` })).toBe(true)
    expect(isFollowersAddress('https://mastodon.test/followers/alice', { actorUrl: ALICE })).toBe(false)
    expect(isFollowersAddress('https://mastodon.test/users/bob/followers', { actorUrl: ALICE })).toBe(false)
    expect(isFollowersAddress('https://mastodon.test/users/followers_club', { actorUrl: ALICE })).toBe(false)
    expect(isFollowersAddress(FOLLOWERS)).toBe(false)
    expect(isFollowersAddress(FOLLOWERS, { actorUrl: 'urn:x:alice' })).toBe(false)
    expect(isFollowersAddress('not a url', { actorUrl: ALICE })).toBe(false)
  })

})

describe('visibilityOf', () => {
  const author = { actorUrl: ALICE, followersUrl: FOLLOWERS }
  it.each([
    [{ to: [AS_PUBLIC], cc: [FOLLOWERS] }, 'public'],
    [{ to: [FOLLOWERS], cc: [AS_PUBLIC] }, 'unlisted'],
    [{ to: [FOLLOWERS, 'https://x.test/u/b'], cc: [] }, 'followers'],
    [{ to: [], cc: [FOLLOWERS] }, 'followers'],
    [{ to: ['https://x.test/u/b'], cc: [] }, 'direct'],
    [{ to: ['https://mastodon.test/users/followers_club'], cc: [] }, 'direct'],
    [{ to: ['https://other.test/users/bob/followers'], cc: [] }, 'direct'],
    [{ to: [], cc: [] }, 'direct'],
  ])('%j is %s', (audience, visibility) => {
    expect(visibilityOf(audience, author)).toBe(visibility)
  })
})

describe('authorActorUrl', () => {
  it('reads attributedTo as a string, an object or a list, then the activity actor', () => {
    expect(authorActorUrl({ attributedTo: ALICE })).toBe(ALICE)
    expect(authorActorUrl({ attributedTo: { id: ALICE, type: 'Person' } })).toBe(ALICE)
    expect(authorActorUrl({ attributedTo: [ALICE, 'https://x.test/g'] })).toBe(ALICE)
    expect(authorActorUrl({}, { actor: { id: ALICE } })).toBe(ALICE)
    expect(authorActorUrl({})).toBeNull()
  })

  it('skips a Group and an entry without id in attributedTo, then falls back to the actor', () => {
    expect(authorActorUrl({ attributedTo: [{ type: 'Group', id: 'https://x.test/c/tv' }, { type: 'Person', id: ALICE }] })).toBe(ALICE)
    expect(authorActorUrl({ attributedTo: [{ type: 'Person' }] }, { actor: ALICE })).toBe(ALICE)
    expect(authorActorUrl({ attributedTo: [{ type: 'Group', id: 'https://x.test/c/tv' }] })).toBe('https://x.test/c/tv')
  })
})
