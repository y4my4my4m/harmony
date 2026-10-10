import { describe, it, expect } from 'vitest'
import { repliesFetchNotice } from '@/utils/remoteReplies'

describe('repliesFetchNotice', () => {
  const answer = (extra: Record<string, unknown>) => ({ success: true, status: 'ok', count: 0, ...extra }) as any

  it('counts the replies now held', () => {
    expect(repliesFetchNotice(answer({ count: 37, new: 30 })))
      .toEqual({ kind: 'success', key: 'activitypub.repliesFetched', count: 37 })
  })

  it('says so when the source lists no replies or publishes none', () => {
    expect(repliesFetchNotice(answer({ count: 0 }))).toEqual({ kind: 'info', key: 'activitypub.noRepliesFromSource' })
    expect(repliesFetchNotice(answer({ status: 'no_collection' })))
      .toEqual({ kind: 'info', key: 'activitypub.noRepliesFromSource' })
  })

  it('reports a recent crawl, an unreachable source and a failed request', () => {
    expect(repliesFetchNotice(answer({ status: 'recent' }))).toEqual({ kind: 'info', key: 'activitypub.repliesFetchedRecently' })
    expect(repliesFetchNotice(answer({ status: 'unavailable' }))).toEqual({ kind: 'error', key: 'activitypub.fetchOlderFailed' })
    expect(repliesFetchNotice(null)).toEqual({ kind: 'error', key: 'activitypub.repliesFetchFailed' })
  })
})
