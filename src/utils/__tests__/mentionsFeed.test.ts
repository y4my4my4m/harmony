import { describe, expect, it } from 'vitest'
import { strandedMentionIds, type MentionNotificationRow } from '../mentionsFeed'

const row = (id: string, isRead: boolean, data: MentionNotificationRow['data']): MentionNotificationRow =>
  ({ id, is_read: isRead, data })

describe('strandedMentionIds', () => {
  it('names unread rows whose post the feed does not show', () => {
    const rows = [
      row('shown', false, { post_id: 'p1' }),
      row('nested-shown', false, { post: { id: 'p2' } }),
      row('deleted-post', false, { post_id: 'gone' }),
      row('no-post', false, {}),
      row('no-data', false, null),
      row('already-read', true, { post_id: 'gone' }),
    ]
    expect(strandedMentionIds(rows, new Set(['p1', 'p2']))).toEqual(['deleted-post', 'no-post', 'no-data'])
  })

  it('names every unread row when no post is shown', () => {
    expect(strandedMentionIds([row('a', false, { post_id: 'p1' }), row('b', null as any, { post_id: 'p2' })], new Set()))
      .toEqual(['a', 'b'])
  })
})
