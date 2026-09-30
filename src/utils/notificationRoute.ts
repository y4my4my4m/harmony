/**
 * App route a notification opens. Mirrors notificationUrl in
 * federation-backend/src/services/pushPolicy.ts, which the service worker uses
 * when no window is open.
 */

interface RoutableNotification {
  type: string
  data?: Record<string, any> | null
}

const profileHandle = (user: any): string | null => {
  if (!user?.username) return null
  const handle = user.domain && user.is_local !== true ? `${user.username}@${user.domain}` : user.username
  return encodeURIComponent(handle).replace(/%40/g, '@')
}

export function resolveNotificationRoute(notification: RoutableNotification): string {
  const type = notification.type || ''
  const data = notification.data || {}

  if (type === 'activitypub_follow_request') return '/social/follow-requests'
  if (type === 'activitypub_follow') {
    const handle = profileHandle(data.follower)
    if (handle) return `/social/profile/${handle}`
  }
  if (type === 'activitypub_follow_accepted') {
    const handle = profileHandle(data.sender)
    if (handle) return `/social/profile/${handle}`
  }

  const postId = data.post_id || data.post?.id
  if (type.startsWith('activitypub_') && postId) return `/social/post/${postId}`

  const messageId = data.message?.id || data.message_id
  const query = messageId ? `?messageId=${encodeURIComponent(messageId)}` : ''

  const conversationId = data.conversation?.id || data.conversation_id
  if (conversationId) return `/dm/${conversationId}${query}`

  const serverId = data.location?.server_id || data.server_id
  const channelId = data.location?.channel_id || data.channel_id
  const threadId = data.thread?.id || data.thread_id
  if (serverId && threadId) return `/chat/${serverId}/thread/${threadId}${query}`
  if (serverId && channelId) return `/chat/${serverId}/${channelId}${query}`

  if (type.startsWith('activitypub_')) return '/social/home'
  return '/chat'
}

/** Same-origin path from a notification url; null for anything that leaves the app. */
export function toAppPath(url: string | null | undefined, origin: string): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url, origin)
    if (parsed.origin !== origin) return null
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return null
  }
}
