import type { RemoteRepliesResult } from '@/services/activityPubService'

/** A /fetch-replies answer as the reader is told it: a toast kind and its locale key. */
export interface RepliesFetchNotice {
  kind: 'success' | 'info' | 'error'
  key: string
  count?: number
}

export function repliesFetchNotice(result: RemoteRepliesResult | null): RepliesFetchNotice {
  if (!result) return { kind: 'error', key: 'activitypub.repliesFetchFailed' }
  switch (result.status) {
    case 'unavailable':
      return { kind: 'error', key: 'activitypub.fetchOlderFailed' }
    case 'recent':
      return { kind: 'info', key: 'activitypub.repliesFetchedRecently' }
    case 'no_collection':
      return { kind: 'info', key: 'activitypub.noRepliesFromSource' }
    default:
      return result.count > 0
        ? { kind: 'success', key: 'activitypub.repliesFetched', count: result.count }
        : { kind: 'info', key: 'activitypub.noRepliesFromSource' }
  }
}
