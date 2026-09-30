/**
 * Pure push decisions: quiet hours, per-type preference gates, deep links and the
 * compact payload data the service worker reads.
 */

/** profiles.status value for Busy (Do Not Disturb). Mirrors UserStatus.Busy in src/types/chat.ts. */
export const PROFILE_STATUS_BUSY = 3;

export type NotificationPrefs = Record<string, unknown> | null | undefined;

const minutesOf = (value: unknown, fallback: string): number => {
  const [h, m] = String(value || fallback).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

/**
 * Quiet hours from notification_preferences. Start and end are UTC times of day,
 * inclusive; start > end wraps midnight. Mirrors useNotification.isQuietHours.
 */
export function isWithinQuietHours(prefs: NotificationPrefs, now: Date = new Date()): boolean {
  if (!prefs || prefs.dnd_enabled !== true) return false;
  const start = minutesOf(prefs.dnd_start_time, '22:00');
  const end = minutesOf(prefs.dnd_end_time, '08:00');
  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  return start > end ? current >= start || current <= end : current >= start && current <= end;
}

// Every column named here must hold true for the type to push. The desktop/activitypub
// columns are the per-type alert toggles in Settings; push_mentions and push_dms are the
// push-only toggles. A missing column (no preferences row) reads as enabled.
const TYPE_GATES: Record<string, string[]> = {
  mention: ['push_mentions', 'desktop_mentions'],
  dm: ['push_dms', 'desktop_dms'],
  chat_message: ['push_dms', 'desktop_chat_messages'],
  reply: ['desktop_replies'],
  thread_reply: ['desktop_replies'],
  reaction: ['desktop_reactions'],
  voice_channel_activity: ['sound_voice_activity'],
  activitypub_mention: ['push_mentions', 'activitypub_desktop_mentions'],
  activitypub_reply: ['activitypub_desktop_replies'],
  activitypub_follow: ['activitypub_desktop_follows'],
  activitypub_follow_request: ['activitypub_desktop_follows'],
  activitypub_follow_accepted: ['activitypub_desktop_follows'],
  activitypub_favorite: ['activitypub_desktop_favorites'],
  activitypub_reaction: ['activitypub_desktop_favorites'],
  activitypub_reblog: ['activitypub_desktop_reblogs'],
};

export function pushAllowedForType(type: string, prefs: NotificationPrefs): boolean {
  if (!prefs) return true;
  if (prefs.push_notifications === false) return false;
  if (type.startsWith('activitypub_') && prefs.activitypub_desktop_notifications === false) return false;
  return (TYPE_GATES[type] ?? []).every((column) => prefs[column] !== false);
}

const profileHandle = (user: any): string | null => {
  if (!user?.username) return null;
  const handle = user.domain && user.is_local !== true ? `${user.username}@${user.domain}` : user.username;
  return encodeURIComponent(handle).replace(/%40/g, '@');
};

/**
 * App route a notification opens. Mirrors resolveNotificationRoute in
 * src/utils/notificationRoute.ts; the service worker opens it when no window exists.
 */
export function notificationUrl(type: string, data: Record<string, any> = {}): string {
  if (type === 'activitypub_follow_request') return '/social/follow-requests';
  if (type === 'activitypub_follow') {
    const handle = profileHandle(data.follower);
    if (handle) return `/social/profile/${handle}`;
  }
  if (type === 'activitypub_follow_accepted') {
    const handle = profileHandle(data.sender);
    if (handle) return `/social/profile/${handle}`;
  }

  const postId = data.post_id || data.post?.id;
  if (type.startsWith('activitypub_') && postId) return `/social/post/${postId}`;

  const messageId = data.message?.id || data.message_id;
  const query = messageId ? `?messageId=${encodeURIComponent(messageId)}` : '';

  const conversationId = data.conversation?.id || data.conversation_id;
  if (conversationId) return `/dm/${conversationId}${query}`;

  const serverId = data.location?.server_id || data.server_id;
  const channelId = data.location?.channel_id || data.channel_id;
  const threadId = data.thread?.id || data.thread_id;
  if (serverId && threadId) return `/chat/${serverId}/thread/${threadId}${query}`;
  if (serverId && channelId) return `/chat/${serverId}/${channelId}${query}`;

  if (type.startsWith('activitypub_')) return '/social/home';
  return '/chat';
}

/**
 * Fields the service worker reads: notification id for dedupe and click-through,
 * routing ids for the tag, quick reply and dismissal. The full notification data can
 * exceed the 4 KB Web Push payload limit.
 */
export function compactPushData(
  notificationId: string,
  type: string,
  data: Record<string, any> = {},
  avatarUrl?: string | null,
): Record<string, string> {
  const out: Record<string, string> = {
    notification_id: notificationId,
    type,
    url: notificationUrl(type, data),
  };
  const put = (key: string, value: unknown) => {
    if (typeof value === 'string' && value) out[key] = value;
  };
  put('conversation_id', data.conversation?.id || data.conversation_id);
  put('server_id', data.location?.server_id || data.server_id);
  put('channel_id', data.location?.channel_id || data.channel_id);
  put('thread_id', data.thread?.id || data.thread_id);
  put('message_id', data.message?.id || data.message_id);
  put('post_id', data.post_id || data.post?.id);
  if (avatarUrl && avatarUrl.length <= 512) out.avatar_url = avatarUrl;
  return out;
}

/** Truncates to max code points, appending an ellipsis. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text || '');
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}
