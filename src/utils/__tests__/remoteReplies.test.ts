import { describe, it, expect, vi } from 'vitest'
import {
  followRepliesFetch,
  forcedRepliesRefreshWait,
  noteForcedRepliesRefresh,
  originDomain,
  repliesCrawlInterval,
  repliesFetchDue,
  repliesFetchNotice,
  repliesFetchView,
} from '@/utils/remoteReplies'
import type { RemoteRepliesResult, RemoteRepliesCrawl } from '@/services/activityPubService'

const crawl = (extra: Partial<RemoteRepliesCrawl> = {}): RemoteRepliesCrawl => ({
  outcome: 'ok', found: 0, stored: 0, existing: 0, skipped: 0, truncated: false, complete: true, ...extra,
})
const done = (extra: Partial<RemoteRepliesCrawl> = {}, top: Partial<RemoteRepliesResult> = {}): RemoteRepliesResult => ({
  success: true, status: 'done', result: crawl(extra), ...top,
})

describe('repliesFetchView', () => {
  it('reads a running crawl as fetching', () => {
    expect(repliesFetchView({ success: true, status: 'started', result: null })).toEqual({ kind: 'fetching' })
    expect(repliesFetchView({ success: true, status: 'running', result: null })).toEqual({ kind: 'fetching' })
  })

  it('counts the replies a complete walk listed and holds', () => {
    expect(repliesFetchView(done({ found: 37, stored: 30, existing: 7 }))).toEqual({ kind: 'fetched', count: 37 })
  })

  it('says so when the origin lists no replies or publishes none', () => {
    expect(repliesFetchView(done({ found: 0 }))).toEqual({ kind: 'none' })
    expect(repliesFetchView(done({ outcome: 'no_collection', complete: false }))).toEqual({ kind: 'none' })
  })

  it('shows part of the replies with the larger known total', () => {
    expect(repliesFetchView(done({ found: 200, stored: 150, existing: 50, truncated: true, complete: false }), 340))
      .toEqual({ kind: 'partial', shown: 200, total: 340 })
    expect(repliesFetchView(done({ found: 5, stored: 3, skipped: 2 })))
      .toEqual({ kind: 'partial', shown: 3, total: 5 })
    expect(repliesFetchView(done({ found: 2, stored: 2, complete: false })))
      .toEqual({ kind: 'partial', shown: 2, total: null })
  })

  it('reads a 429 as rate limited with its seconds, and a busy backend the same way', () => {
    expect(repliesFetchView({ success: false, status: 'rate_limited', retry_after: 42 })).toEqual({ kind: 'rate_limited', seconds: 42 })
    expect(repliesFetchView({ success: false, status: 'busy', retry_after: 5 })).toEqual({ kind: 'rate_limited', seconds: 5 })
    expect(repliesFetchView({ success: false, status: 'rate_limited' })).toEqual({ kind: 'rate_limited', seconds: 60 })
  })

  it('reports an unreachable or refusing origin and a failed request', () => {
    expect(repliesFetchView(done({ outcome: 'unavailable', complete: false }))).toEqual({ kind: 'unreachable' })
    expect(repliesFetchView(done({ outcome: 'unauthorized', complete: false }))).toEqual({ kind: 'unauthorized' })
    expect(repliesFetchView({ success: false, status: 'failed' })).toEqual({ kind: 'failed' })
  })

  it('tells a skipped crawl from one that ended out of sight', () => {
    expect(repliesFetchView({ success: true, status: 'recent', result: null })).toEqual({ kind: 'recent' })
    expect(repliesFetchView({ success: true, status: 'idle', result: null })).toEqual({ kind: 'finished' })
    expect(repliesFetchView({ success: true, status: 'recent', result: crawl({ found: 0 }) })).toEqual({ kind: 'none' })
  })
})

describe('repliesFetchNotice', () => {
  it('names the origin and the counts', () => {
    expect(repliesFetchNotice({ kind: 'fetched', count: 3 }, 'mastodon.test'))
      .toEqual({ kind: 'success', key: 'activitypub.repliesFetched', params: { count: 3, domain: 'mastodon.test' }, count: 3 })
    expect(repliesFetchNotice({ kind: 'partial', shown: 2, total: 9 }, 'mastodon.test'))
      .toEqual({ kind: 'info', key: 'activitypub.repliesPartial', params: { shown: 2, total: 9, domain: 'mastodon.test' }, count: 9 })
    expect(repliesFetchNotice({ kind: 'partial', shown: 2, total: null }, 'mastodon.test')?.key).toBe('activitypub.repliesMoreOnOrigin')
    expect(repliesFetchNotice({ kind: 'none' }, 'mastodon.test')?.key).toBe('activitypub.noRepliesFromSource')
  })

  it('makes errors of a refused, unreachable or failed fetch', () => {
    expect(repliesFetchNotice({ kind: 'rate_limited', seconds: 12 }, 'x.test'))
      .toEqual({ kind: 'error', key: 'activitypub.repliesRateLimited', params: { seconds: 12 }, count: 12 })
    expect(repliesFetchNotice({ kind: 'unreachable' }, 'x.test')).toMatchObject({ kind: 'error', key: 'activitypub.fetchOlderFailed' })
    expect(repliesFetchNotice({ kind: 'unauthorized' }, 'x.test')).toMatchObject({ kind: 'error', key: 'activitypub.repliesUnauthorized' })
    expect(repliesFetchNotice({ kind: 'failed' }, 'x.test')).toMatchObject({ kind: 'error', key: 'activitypub.repliesFetchFailed' })
    expect(repliesFetchNotice({ kind: 'fetching' }, 'x.test')).toBeNull()
  })
})

describe('followRepliesFetch', () => {
  const noWait = () => Promise.resolve()

  it('reads the status until the crawl ends', async () => {
    const poll = vi.fn<() => Promise<RemoteRepliesResult>>()
      .mockResolvedValueOnce({ success: true, status: 'running', result: null })
      .mockResolvedValueOnce(done({ found: 2, stored: 2 }))
    const answer = await followRepliesFetch(async () => ({ success: true, status: 'started', result: null }), poll, { wait: noWait })
    expect(answer).toMatchObject({ status: 'done', result: { stored: 2 } })
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it('does not poll when no crawl runs', async () => {
    const poll = vi.fn()
    expect(await followRepliesFetch(async () => ({ success: true, status: 'recent', result: null }), poll, { wait: noWait }))
      .toMatchObject({ status: 'recent' })
    expect(await followRepliesFetch(async () => ({ success: false, status: 'rate_limited', retry_after: 9 }), poll, { wait: noWait }))
      .toMatchObject({ status: 'rate_limited', retry_after: 9 })
    expect(poll).not.toHaveBeenCalled()
  })

  it('keeps polling through a refused status read', async () => {
    const poll = vi.fn<() => Promise<RemoteRepliesResult>>()
      .mockResolvedValueOnce({ success: false, status: 'rate_limited', retry_after: 3 })
      .mockResolvedValueOnce({ success: true, status: 'idle', result: null })
    const answer = await followRepliesFetch(async () => ({ success: true, status: 'started', result: null }), poll, { wait: noWait })
    expect(answer?.status).toBe('idle')
  })

  it('gives up after the timeout and stops when cancelled', async () => {
    let clock = 0
    const running = async (): Promise<RemoteRepliesResult> => ({ success: true, status: 'running', result: null })
    const timedOut = await followRepliesFetch(running, running, {
      wait: async (ms) => { clock += ms },
      now: () => clock,
      timeoutMs: 10_000,
    })
    expect(timedOut).toEqual({ success: false, status: 'failed' })

    let cancelled = false
    const poll = vi.fn(async () => { cancelled = true; return running() })
    expect(await followRepliesFetch(running, poll, { wait: noWait, cancelled: () => cancelled })).toBeNull()
    expect(poll).toHaveBeenCalledTimes(1)
  })
})

describe('crawl timing', () => {
  const now = Date.parse('2026-10-11T12:00:00Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it('mirrors the backend interval by post age', () => {
    expect(repliesCrawlInterval(ago(30 * 60_000), now)).toBe(2 * 60_000)
    expect(repliesCrawlInterval(ago(3 * 60 * 60_000), now)).toBe(15 * 60_000)
    expect(repliesCrawlInterval(ago(48 * 60 * 60_000), now)).toBe(6 * 60 * 60_000)
  })

  it('is due when never crawled or past the interval', () => {
    expect(repliesFetchDue({ created_at: ago(30 * 60_000) }, now)).toBe(true)
    expect(repliesFetchDue({ created_at: ago(30 * 60_000), replies_fetched_at: ago(60_000) }, now)).toBe(false)
    expect(repliesFetchDue({ created_at: ago(30 * 60_000), replies_fetched_at: ago(3 * 60_000) }, now)).toBe(true)
    expect(repliesFetchDue({ created_at: ago(48 * 60 * 60_000), replies_fetched_at: ago(60 * 60_000) }, now)).toBe(false)
  })

  it('holds a forced refresh of one post for a minute', () => {
    const apId = 'https://mastodon.test/users/a/statuses/cooldown'
    expect(forcedRepliesRefreshWait(apId, now)).toBe(0)
    noteForcedRepliesRefresh(apId, now)
    expect(forcedRepliesRefreshWait(apId, now + 20_000)).toBe(40_000)
    expect(forcedRepliesRefreshWait(apId, now + 60_000)).toBe(0)
    expect(forcedRepliesRefreshWait('https://mastodon.test/users/a/statuses/other', now)).toBe(0)
  })

  it('names the origin host', () => {
    expect(originDomain('https://mastodon.test/users/a/statuses/1')).toBe('mastodon.test')
    expect(originDomain('not a url', 'fallback.test')).toBe('fallback.test')
  })
})
