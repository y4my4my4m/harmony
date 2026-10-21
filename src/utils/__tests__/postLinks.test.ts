import { describe, it, expect } from 'vitest'
import { boostLinkTarget, postLinks } from '../postLinks'

const BASE = 'https://har.mony.lol/'

describe('postLinks', () => {
  it('gives a local post its page here only', () => {
    expect(postLinks({ id: 'p1', is_local: true, url: 'https://har.mony.lol/posts/p1' }, BASE)).toEqual({
      here: { url: 'https://har.mony.lol/posts/p1', host: 'har.mony.lol' },
      original: null,
    })
  })

  it('gives a remote post its page here and its page on its own server', () => {
    const links = postLinks({ id: 'p2', is_local: false, url: 'https://mastodon.social/@ann/1', ap_id: 'https://mastodon.social/users/ann/statuses/1' }, BASE)
    expect(links.here).toEqual({ url: 'https://har.mony.lol/posts/p2', host: 'har.mony.lol' })
    expect(links.original).toEqual({ url: 'https://mastodon.social/@ann/1', host: 'mastodon.social' })
  })

  it('falls back to the ActivityPub id when the remote post names no page', () => {
    expect(postLinks({ id: 'p3', is_local: false, url: null, ap_id: 'https://lemmy.example/post/9' }, BASE).original)
      .toEqual({ url: 'https://lemmy.example/post/9', host: 'lemmy.example' })
  })

  it('offers no original for a remote post without a web address', () => {
    expect(postLinks({ id: 'p4', is_local: false, url: null, ap_id: null }, BASE).original).toBeNull()
    expect(postLinks({ id: 'p5', is_local: false, url: 'urn:uuid:x' }, BASE).original).toBeNull()
  })

  // The reblog snapshot (jsonb_build_object in 20261011800001_remote_reply_crawls.sql) has no is_local.
  it('decides a boost snapshot without is_local by the host of its address', () => {
    expect(postLinks({ id: 'p6', url: 'https://mastodon.social/@ann/2', ap_id: 'https://mastodon.social/users/ann/statuses/2' }, BASE).original)
      .toEqual({ url: 'https://mastodon.social/@ann/2', host: 'mastodon.social' })
    expect(postLinks({ id: 'p7', is_local: null, url: null, ap_id: 'https://lemmy.example/post/3' }, BASE).original)
      .toEqual({ url: 'https://lemmy.example/post/3', host: 'lemmy.example' })
    expect(postLinks({ id: 'p8', url: 'https://har.mony.lol/posts/p8' }, BASE).original).toBeNull()
    expect(postLinks({ id: 'p9' }, BASE).original).toBeNull()
  })
})

describe('boostLinkTarget', () => {
  it('names the boosted post from its snapshot', () => {
    const reblog = { id: 'orig', url: 'https://mastodon.social/@ann/2' }
    expect(boostLinkTarget({ id: 'wrap', url: 'https://mastodon.social/users/bob/statuses/9/activity', reblog })).toBe(reblog)
  })

  it('names an unhydrated boost by the ids in its metadata', () => {
    const target = boostLinkTarget({
      id: 'wrap',
      url: 'https://mastodon.social/users/bob/statuses/9/activity',
      metadata: { reblog_of: 'orig', reblog_of_ap_url: 'https://mastodon.social/users/ann/statuses/2' },
    })
    expect(postLinks(target, BASE)).toEqual({
      here: { url: 'https://har.mony.lol/posts/orig', host: 'har.mony.lol' },
      original: { url: 'https://mastodon.social/users/ann/statuses/2', host: 'mastodon.social' },
    })
  })

  it("falls back to the wrapper's id and offers no original without metadata", () => {
    const target = boostLinkTarget({ id: 'wrap', url: 'https://mastodon.social/users/bob/statuses/9/activity', metadata: {} })
    expect(postLinks(target, BASE)).toEqual({
      here: { url: 'https://har.mony.lol/posts/wrap', host: 'har.mony.lol' },
      original: null,
    })
  })
})
