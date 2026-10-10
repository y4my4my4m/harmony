/**
 * The Mentions feed lists the posts of activitypub_mention notifications and marks
 * a notification read when its post comes into view.
 */

export interface MentionNotificationRow {
  id: string
  is_read: boolean | null
  data: { post_id?: string; post?: { id?: string } } | null
}

export function mentionPostId(row: MentionNotificationRow): string | undefined {
  return row.data?.post_id || row.data?.post?.id || undefined
}

/**
 * Unread rows whose post the feed does not show (deleted, by a suspended author,
 * not visible to the caller, or absent from the payload). Their post never comes
 * into view, so nothing else marks them read.
 */
export function strandedMentionIds(rows: readonly MentionNotificationRow[], shownPostIds: ReadonlySet<string>): string[] {
  const ids: string[] = []
  for (const row of rows) {
    if (row.is_read) continue
    const postId = mentionPostId(row)
    if (!postId || !shownPostIds.has(postId)) ids.push(row.id)
  }
  return ids
}
