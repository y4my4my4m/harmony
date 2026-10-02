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
  newcomer_message: ['newcomer_alerts'],
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
  if (type === 'security') return '/settings/security';
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

export type PushTransport = 'webpush' | 'unifiedpush' | 'fcm';

/** Targets rendered by the Android app rather than a service worker. */
export const APP_TRANSPORTS: readonly PushTransport[] = ['unifiedpush', 'fcm'];

// FCM caps a data message at 4096 bytes; ntfy caps a UnifiedPush body at 4096 bytes after
// RFC 8291 encryption adds 103. The budget leaves room for both.
export const APP_PAYLOAD_MAX_BYTES = 3000;

// 80 uuids with separators are 2959 bytes.
const DISMISS_IDS_PER_MESSAGE = 80;

const FCM_TOKEN_RE = /^[A-Za-z0-9_:.-]{20,4096}$/;

export function isValidFcmToken(token: unknown): token is string {
  return typeof token === 'string' && FCM_TOKEN_RE.test(token);
}

export interface AppPushInput {
  notificationId: string;
  type: string;
  data?: Record<string, any>;
  title: string;
  body: string;
  sender?: string | null;
  avatarUrl?: string | null;
  iconUrl?: string | null;
}

const byteLength = (value: Record<string, string>): number => Buffer.byteLength(JSON.stringify(value));

/**
 * Conversation title the Android app shows above a message: "Server #channel" for server
 * channels, the group name for group DMs, empty for one-to-one DMs. Mirrors
 * showDesktopNotification in src/stores/useNotification.ts.
 */
export function conversationTitle(data: Record<string, any> = {}): string {
  const serverName = data.location?.server_name || data.server_name || '';
  const channelName = data.location?.channel_name || data.channel_name || '';
  if (serverName) return channelName ? `${serverName} #${channelName}` : serverName;
  if (channelName) return `#${channelName}`;
  return typeof data.conversation?.name === 'string' ? data.conversation.name : '';
}

/**
 * Flat string map the Android app renders: an FCM data message, or the JSON body of a
 * UnifiedPush message. Field names match the app's PushPayload. Optional fields are dropped
 * in order (icon, avatar, conversation title) and the body clipped until the map fits
 * APP_PAYLOAD_MAX_BYTES.
 */
export function appPushData(input: AppPushInput): Record<string, string> {
  const data = input.data || {};
  const routing = compactPushData(input.notificationId, input.type, data);
  const out: Record<string, string> = {
    kind: 'notification',
    id: input.notificationId,
    type: input.type,
    title: clip(input.title, 120),
    body: clip(input.body, 240),
    url: routing.url,
  };
  for (const key of ['conversation_id', 'server_id', 'channel_id', 'thread_id', 'message_id', 'post_id']) {
    if (routing[key]) out[key] = routing[key];
  }
  const sender = clip(input.sender || '', 64);
  if (sender) out.sender = sender;
  const conv = clip(conversationTitle(data), 80);
  if (conv) out.conv = conv;
  if (input.avatarUrl && input.avatarUrl.length <= 512) out.avatar = input.avatarUrl;
  if (input.iconUrl && input.iconUrl.length <= 512) out.icon = input.iconUrl;

  for (const key of ['icon', 'avatar', 'conv']) {
    if (byteLength(out) <= APP_PAYLOAD_MAX_BYTES) break;
    delete out[key];
  }
  while (byteLength(out) > APP_PAYLOAD_MAX_BYTES && Array.from(out.body).length > 1) {
    out.body = clip(out.body, Math.floor(Array.from(out.body).length / 2));
  }
  return out;
}

/**
 * "Read" messages that make the Android app cancel notifications. ids null cancels every
 * notification of the account on that device.
 */
export function dismissalMessages(ids: string[] | null): Record<string, string>[] {
  if (ids === null) return [{ kind: 'read', all: '1' }];
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
  const messages: Record<string, string>[] = [];
  for (let i = 0; i < unique.length; i += DISMISS_IDS_PER_MESSAGE) {
    messages.push({ kind: 'read', ids: unique.slice(i, i + DISMISS_IDS_PER_MESSAGE).join(',') });
  }
  return messages;
}

/**
 * Browser and OS named by a User-Agent, e.g. "Firefox on Linux"; null when neither is known.
 * Mirrors describeUserAgent in src/utils/userAgent.ts.
 */
export function describeUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent;
  const os = /Android/.test(ua) ? 'Android'
    : /iPad/.test(ua) ? 'iPadOS'
    : /iPhone|iPod/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux|X11/.test(ua) ? 'Linux'
    : null;
  const linuxWebKit = os === 'Linux' && /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\//.test(ua);
  const browser = /; wv\)/.test(ua) || linuxWebKit ? 'Harmony app'
    : /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|Chromium\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os;
}

/**
 * Push text for a 'security' notification. data.event is written by
 * public.record_security_notice (migration 20261005400001).
 */
export function securityNoticeText(data: Record<string, any> = {}): { title: string; body: string } {
  const device = describeUserAgent(data.user_agent);
  switch (data.event) {
    case 'new_sign_in':
      return {
        title: 'New sign-in to your account',
        body: `${device ? `${device}. ` : ''}Not you? Sign out that session in Settings > Security.`,
      };
    case 'mfa_enabled':
      return { title: 'Two-factor authentication turned on', body: 'Sign-ins now need your authenticator.' };
    case 'mfa_disabled':
      return {
        title: 'Two-factor authentication turned off',
        body: data.reason === 'recovery_code'
          ? 'A recovery code was used to sign in. Set up two-factor authentication again.'
          : 'Your account no longer asks for an authenticator code.',
      };
    case 'recovery_code_used':
      return { title: 'Recovery code used', body: 'One of your recovery codes was used.' };
    case 'recovery_codes_regenerated':
      return { title: 'New recovery codes', body: 'Your previous recovery codes no longer work.' };
    case 'password_changed':
      return { title: 'Password changed', body: 'Your password was changed. Other sessions were signed out.' };
    default:
      return { title: 'Account security', body: 'There was a change to your account security.' };
  }
}
