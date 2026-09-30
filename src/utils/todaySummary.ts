/**
 * Shapes the jsonb returned by public.get_today_summary (migration
 * 20261003000001_today_summary.sql) into typed view data, plus the pure helpers the Today
 * view derives from it: preview parts, routes, headline counts and optimistic removals.
 *
 * Parsing is defensive: a missing or mistyped field reads as empty, never throws.
 */

import type { RouteLocationRaw } from 'vue-router'
import type { Message, MessagePart } from '@/types'

export interface TodayProfile {
  id: string
  username: string | null
  displayName: string | null
  avatarUrl: string | null
  domain: string | null
  isLocal: boolean
}

export interface TodayServerRef {
  id: string
  name: string
  icon: string | null
  isLocal: boolean
}

export type TodayMentionKind = 'mention' | 'reply'

export interface TodayConversationRef {
  id: string
  type: 'direct' | 'group'
  name: string | null
}

export interface TodayMention {
  kind: TodayMentionKind
  unread: boolean
  message: Message
  author: TodayProfile | null
  server: TodayServerRef | null
  channelName: string | null
  threadName: string | null
  conversation: TodayConversationRef | null
}

export interface TodayConversation {
  id: string
  type: 'direct' | 'group'
  name: string | null
  iconUrl: string | null
  unreadMessages: number
  unreadMentions: number
  /** Includes the caller. */
  participantCount: number
  /** Other current participants, first four by join time. */
  participants: TodayProfile[]
  lastMessage: Message | null
}

export interface TodayChannel {
  id: string
  name: string
  /** channels.type: 0 text, 1 voice. */
  type: number
  unreadMessages: number
  unreadMentions: number
}

export interface TodayServerGroup {
  id: string
  name: string
  icon: string | null
  unreadMessages: number
  unreadMentions: number
  /** Unread channels in the server; `channels` holds at most 12 of them. */
  channelCount: number
  lastActivity: string | null
  channels: TodayChannel[]
}

export interface TodayThread {
  id: string
  name: string
  channelId: string
  channelName: string
  server: TodayServerRef
  newReplies: number
  lastReplyAt: string | null
  repliers: TodayProfile[]
}

export interface TodayVoiceChannel {
  channelId: string
  channelName: string
  server: TodayServerRef
  participantCount: number
  startedAt: string | null
  includesMe: boolean
  /** First six by join time. */
  participants: TodayProfile[]
}

export interface TodayFollower extends TodayProfile {
  at: string | null
}

export interface TodayPost {
  id: string
  createdAt: string | null
  content: MessagePart[]
  contentWarning: string | null
  isSensitive: boolean
  mediaCount: number
  repliesCount: number
  reblogsCount: number
  favoritesCount: number
  author: TodayProfile | null
}

export type TodaySocialType = 'activitypub_mention' | 'activitypub_reply'

export interface TodaySocialItem {
  notificationId: string
  type: TodaySocialType
  createdAt: string | null
  post: TodayPost
}

export interface TodayAnnouncement {
  id: string
  title: string
  content: string
  icon: string | null
  imageUrl: string | null
  isPinned: boolean
  createdAt: string | null
}

export interface TodayTotals {
  /** Sum of unread_counts.unread_mentions over visible channels and current conversations. */
  unreadMentions: number
  /** Unread entries among `mentions`. */
  mentionsUnread: number
  conversations: number
  dmMessages: number
  servers: number
  channels: number
  channelMessages: number
  threads: number
  followRequests: number
  newFollowers: number
  announcements: number
}

export interface TodaySocialCounts {
  mention: number
  reply: number
  favorite: number
  reblog: number
  reaction: number
  follow: number
}

export interface TodaySummary {
  generatedAt: string | null
  since: string | null
  mentions: TodayMention[]
  conversations: TodayConversation[]
  servers: TodayServerGroup[]
  threads: TodayThread[]
  voice: TodayVoiceChannel[]
  followRequests: TodayFollower[]
  newFollowers: TodayFollower[]
  socialCounts: TodaySocialCounts
  socialItems: TodaySocialItem[]
  followedPosts: TodayPost[]
  announcements: TodayAnnouncement[]
  totals: TodayTotals
}

type Raw = Record<string, unknown>

const obj = (v: unknown): Raw | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}
const bool = (v: unknown): boolean => v === true

/** Entries lacking an id are dropped. */
function list<T>(v: unknown, shape: (r: Raw) => T | null): T[] {
  const out: T[] = []
  for (const item of arr(v)) {
    const r = obj(item)
    if (!r) continue
    const shaped = shape(r)
    if (shaped) out.push(shaped)
  }
  return out
}

export function shapeProfile(r: Raw | null): TodayProfile | null {
  const id = str(r?.id)
  if (!r || !id) return null
  return {
    id,
    username: str(r.username),
    displayName: str(r.display_name),
    avatarUrl: str(r.avatar_url),
    domain: str(r.domain),
    isLocal: r.is_local !== false,
  }
}

function shapeServer(r: Raw | null): TodayServerRef | null {
  const id = str(r?.id)
  if (!r || !id) return null
  return { id, name: str(r.name) ?? '', icon: str(r.icon), isLocal: r.is_local !== false }
}

export function shapeMessage(r: Raw | null): Message | null {
  const id = str(r?.id)
  if (!r || !id) return null
  const created = str(r.created_at)
  return {
    id,
    created_at: created ? new Date(created) : new Date(0),
    channel_id: str(r.channel_id) ?? undefined,
    conversation_id: str(r.conversation_id) ?? undefined,
    thread_id: str(r.thread_id) ?? undefined,
    user_id: str(r.user_id) ?? undefined,
    bot_id: str(r.bot_id) ?? undefined,
    content: arr(r.content) as MessagePart[],
    encrypted: bool(r.encrypted),
    encryption_metadata: (obj(r.encryption_metadata) as Message['encryption_metadata']) ?? undefined,
    metadata: obj(r.metadata) ?? {},
    reactions: [],
  }
}

function shapeConversationRef(r: Raw | null): TodayConversationRef | null {
  const id = str(r?.id)
  if (!r || !id) return null
  return { id, type: r.type === 'group' ? 'group' : 'direct', name: str(r.name) }
}

function shapePost(r: Raw | null, author: TodayProfile | null): TodayPost | null {
  const id = str(r?.id)
  if (!r || !id) return null
  return {
    id,
    createdAt: str(r.created_at),
    content: arr(r.content) as MessagePart[],
    contentWarning: str(r.content_warning),
    isSensitive: bool(r.is_sensitive),
    mediaCount: num(r.media_count),
    repliesCount: num(r.replies_count),
    reblogsCount: num(r.reblogs_count),
    favoritesCount: num(r.favorites_count),
    author,
  }
}

function shapeFollower(r: Raw, atKey: string): TodayFollower | null {
  const p = shapeProfile(r)
  return p ? { ...p, at: str(r[atKey]) } : null
}

export function emptySummary(): TodaySummary {
  return {
    generatedAt: null,
    since: null,
    mentions: [],
    conversations: [],
    servers: [],
    threads: [],
    voice: [],
    followRequests: [],
    newFollowers: [],
    socialCounts: { mention: 0, reply: 0, favorite: 0, reblog: 0, reaction: 0, follow: 0 },
    socialItems: [],
    followedPosts: [],
    announcements: [],
    totals: {
      unreadMentions: 0,
      mentionsUnread: 0,
      conversations: 0,
      dmMessages: 0,
      servers: 0,
      channels: 0,
      channelMessages: 0,
      threads: 0,
      followRequests: 0,
      newFollowers: 0,
      announcements: 0,
    },
  }
}

export function shapeTodaySummary(raw: unknown): TodaySummary {
  const r = obj(raw)
  const out = emptySummary()
  if (!r) return out

  out.generatedAt = str(r.generated_at)
  out.since = str(r.since)

  out.mentions = list(r.mentions, (m) => {
    const message = shapeMessage(obj(m.message))
    if (!message) return null
    return {
      kind: m.kind === 'reply' ? 'reply' : 'mention',
      unread: bool(m.unread),
      message,
      author: shapeProfile(obj(m.author)),
      server: shapeServer(obj(m.server)),
      channelName: str(m.channel_name),
      threadName: str(m.thread_name),
      conversation: shapeConversationRef(obj(m.conversation)),
    }
  })

  out.conversations = list(r.conversations, (c) => {
    const id = str(c.id)
    if (!id) return null
    return {
      id,
      type: c.type === 'group' ? 'group' : 'direct',
      name: str(c.name),
      iconUrl: str(c.icon_url),
      unreadMessages: num(c.unread_messages),
      unreadMentions: num(c.unread_mentions),
      participantCount: num(c.participant_count),
      participants: list(c.participants, shapeProfile),
      lastMessage: shapeMessage(obj(c.last_message)),
    }
  })

  out.servers = list(r.servers, (s) => {
    const id = str(s.id)
    if (!id) return null
    return {
      id,
      name: str(s.name) ?? '',
      icon: str(s.icon),
      unreadMessages: num(s.unread_messages),
      unreadMentions: num(s.unread_mentions),
      channelCount: num(s.channel_count),
      lastActivity: str(s.last_activity),
      channels: list(s.channels, (c) => {
        const cid = str(c.id)
        if (!cid) return null
        return {
          id: cid,
          name: str(c.name) ?? '',
          type: num(c.type),
          unreadMessages: num(c.unread_messages),
          unreadMentions: num(c.unread_mentions),
        }
      }),
    }
  })

  out.threads = list(r.threads, (t) => {
    const id = str(t.id)
    const server = shapeServer(obj(t.server))
    const channelId = str(t.channel_id)
    if (!id || !server || !channelId) return null
    return {
      id,
      name: str(t.name) ?? '',
      channelId,
      channelName: str(t.channel_name) ?? '',
      server,
      newReplies: num(t.new_replies),
      lastReplyAt: str(t.last_reply_at),
      repliers: list(t.repliers, shapeProfile),
    }
  })

  out.voice = list(r.voice, (v) => {
    const channelId = str(v.channel_id)
    const server = shapeServer(obj(v.server))
    if (!channelId || !server) return null
    return {
      channelId,
      channelName: str(v.channel_name) ?? '',
      server,
      participantCount: num(v.participant_count),
      startedAt: str(v.started_at),
      includesMe: bool(v.includes_me),
      participants: list(v.participants, shapeProfile),
    }
  })

  out.followRequests = list(r.follow_requests, (f) => shapeFollower(f, 'requested_at'))
  out.newFollowers = list(r.new_followers, (f) => shapeFollower(f, 'followed_at'))

  const social = obj(r.social)
  const unread = obj(social?.unread) ?? {}
  out.socialCounts = {
    mention: num(unread.activitypub_mention),
    reply: num(unread.activitypub_reply),
    favorite: num(unread.activitypub_favorite),
    reblog: num(unread.activitypub_reblog),
    reaction: num(unread.activitypub_reaction),
    follow: num(unread.activitypub_follow),
  }
  out.socialItems = list(social?.items, (i) => {
    const notificationId = str(i.notification_id)
    const post = shapePost(obj(i.post), shapeProfile(obj(i.author)))
    if (!notificationId || !post) return null
    return {
      notificationId,
      type: i.type === 'activitypub_reply' ? 'activitypub_reply' : 'activitypub_mention',
      createdAt: str(i.created_at),
      post,
    }
  })

  out.followedPosts = list(r.followed_posts, (p) => shapePost(p, shapeProfile(obj(p.author))))

  out.announcements = list(r.announcements, (a) => {
    const id = str(a.id)
    if (!id) return null
    return {
      id,
      title: str(a.title) ?? '',
      content: str(a.content) ?? '',
      icon: str(a.icon),
      imageUrl: str(a.image_url),
      isPinned: bool(a.is_pinned),
      createdAt: str(a.created_at),
    }
  })

  const t = obj(r.totals) ?? {}
  out.totals = {
    unreadMentions: num(t.unread_mentions),
    mentionsUnread: num(t.mentions_unread),
    conversations: num(t.conversations),
    dmMessages: num(t.dm_messages),
    servers: num(t.servers),
    channels: num(t.channels),
    channelMessages: num(t.channel_messages),
    threads: num(t.threads),
    followRequests: num(t.follow_requests),
    newFollowers: num(t.new_followers),
    announcements: num(t.announcements),
  }

  return out
}

// Previews -------------------------------------------------------------------------------

const INLINE_PART_TYPES = new Set([
  'text', 'url', 'mention', 'role_mention', 'emoji', 'hashtag', 'channel_mention',
])

export interface PreviewParts {
  /** Inline parts only: files, embeds and system parts are dropped. */
  parts: MessagePart[]
  attachments: number
}

export function previewParts(content: readonly MessagePart[] | null | undefined): PreviewParts {
  const parts: MessagePart[] = []
  let attachments = 0
  for (const part of content ?? []) {
    const type = (part as { type?: unknown } | null)?.type
    if (typeof type !== 'string') continue
    if (INLINE_PART_TYPES.has(type)) parts.push(part)
    else if (type === 'file') attachments++
  }
  return { parts, attachments }
}

/** Plain text of the inline parts, whitespace collapsed. */
export function previewText(content: readonly MessagePart[] | null | undefined): string {
  return previewParts(content).parts
    .map((part: any) => {
      switch (part.type) {
        case 'text': return part.text ?? ''
        case 'url': return part.url ?? ''
        case 'mention': return `@${part.displayName || part.username || ''}`
        case 'role_mention': return `@${part.roleName ?? ''}`
        case 'emoji': return part.emoji?.name ? `:${part.emoji.name}:` : ''
        case 'hashtag': return `#${part.name ?? ''}`
        case 'channel_mention': return `#${part.name ?? ''}`
        default: return ''
      }
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

// Routes ---------------------------------------------------------------------------------

export function mentionRoute(m: TodayMention): RouteLocationRaw | null {
  const msg = m.message
  const query = { messageId: msg.id }
  if (msg.thread_id && m.server) {
    return { name: 'ThreadView', params: { serverId: m.server.id, threadId: msg.thread_id }, query }
  }
  if (msg.channel_id && m.server) {
    return { name: 'ChatChannel', params: { serverId: m.server.id, channelId: msg.channel_id }, query }
  }
  if (msg.conversation_id) {
    return { name: 'DMConversation', params: { conversationId: msg.conversation_id }, query }
  }
  return null
}

export function conversationRoute(c: Pick<TodayConversation, 'id'>): RouteLocationRaw {
  return { name: 'DMConversation', params: { conversationId: c.id } }
}

export function channelRoute(serverId: string, channelId: string): RouteLocationRaw {
  return { name: 'ChatChannel', params: { serverId, channelId } }
}

export function threadRoute(t: Pick<TodayThread, 'id' | 'server'>): RouteLocationRaw {
  return { name: 'ThreadView', params: { serverId: t.server.id, threadId: t.id } }
}

export function postRoute(postId: string): RouteLocationRaw {
  return { name: 'PostDetail', params: { postId } }
}

// Headline -------------------------------------------------------------------------------

export type TodaySectionId =
  | 'announcements' | 'mentions' | 'conversations' | 'catch-up' | 'threads' | 'voice' | 'social'
  | 'posts'

export interface HeadlineStat {
  key: 'mentions' | 'conversations' | 'channels' | 'threads' | 'voice' | 'followRequests'
  count: number
  section: TodaySectionId
}

/** Nonzero stats in display order. */
export function headlineStats(s: TodaySummary): HeadlineStat[] {
  const liveVoice = s.voice.reduce((n, v) => n + v.participantCount, 0)
  const stats: HeadlineStat[] = [
    { key: 'mentions', count: s.totals.mentionsUnread, section: 'mentions' },
    { key: 'conversations', count: s.totals.conversations, section: 'conversations' },
    { key: 'channels', count: s.totals.channelMessages, section: 'catch-up' },
    { key: 'threads', count: s.totals.threads, section: 'threads' },
    { key: 'voice', count: liveVoice, section: 'voice' },
    { key: 'followRequests', count: s.totals.followRequests, section: 'social' },
  ]
  return stats.filter(stat => stat.count > 0)
}

// Optimistic updates ---------------------------------------------------------------------

export function withoutServer(s: TodaySummary, serverId: string): TodaySummary {
  const server = s.servers.find(g => g.id === serverId)
  if (!server) return s
  return {
    ...s,
    servers: s.servers.filter(g => g.id !== serverId),
    totals: {
      ...s.totals,
      servers: Math.max(0, s.totals.servers - 1),
      channels: Math.max(0, s.totals.channels - server.channelCount),
      channelMessages: Math.max(0, s.totals.channelMessages - server.unreadMessages),
      unreadMentions: Math.max(0, s.totals.unreadMentions - server.unreadMentions),
    },
  }
}

export function withoutFollowRequest(s: TodaySummary, profileId: string): TodaySummary {
  if (!s.followRequests.some(f => f.id === profileId)) return s
  return {
    ...s,
    followRequests: s.followRequests.filter(f => f.id !== profileId),
    totals: { ...s.totals, followRequests: Math.max(0, s.totals.followRequests - 1) },
  }
}

export function withoutAnnouncement(s: TodaySummary, id: string): TodaySummary {
  if (!s.announcements.some(a => a.id === id)) return s
  return {
    ...s,
    announcements: s.announcements.filter(a => a.id !== id),
    totals: { ...s.totals, announcements: Math.max(0, s.totals.announcements - 1) },
  }
}

/** Replaces messages by id; entries without a replacement are kept. */
export function withMessages(s: TodaySummary, replacements: readonly Message[]): TodaySummary {
  if (replacements.length === 0) return s
  const byId = new Map(replacements.map(m => [m.id, m]))
  return {
    ...s,
    mentions: s.mentions.map(m => byId.has(m.message.id) ? { ...m, message: byId.get(m.message.id)! } : m),
    conversations: s.conversations.map(c =>
      c.lastMessage && byId.has(c.lastMessage.id) ? { ...c, lastMessage: byId.get(c.lastMessage.id)! } : c),
  }
}

/** Encrypted messages carried by the summary. */
export function encryptedMessages(s: TodaySummary): Message[] {
  const out: Message[] = []
  for (const m of s.mentions) if (m.message.encrypted) out.push(m.message)
  for (const c of s.conversations) if (c.lastMessage?.encrypted) out.push(c.lastMessage)
  return out
}

/** Icon for instance_announcements.icon; mirrors AnnouncementPopup. */
export function announcementIcon(icon: string | null): string {
  switch (icon) {
    case 'warning': return 'alert-triangle'
    case 'celebration': return 'megaphone'
    case 'maintenance': return 'wrench'
    case 'update': return 'refresh-cw'
    case 'security': return 'shield'
    default: return 'info'
  }
}

// Visit tracking -------------------------------------------------------------------------

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

/** "4 hours ago", "yesterday"; null under a minute or for unparseable input. */
export function relativePhrase(iso: string, locale = 'en', now = Date.now()): string | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const delta = now - t
  if (delta < 60_000) return null
  const [unit, size] = RELATIVE_UNITS.find(([, ms]) => delta >= ms) ?? RELATIVE_UNITS[RELATIVE_UNITS.length - 1]
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-Math.floor(delta / size), unit)
}

/** A stored visit time, or null when absent, unparseable or in the future. */
export function parseVisit(stored: string | null, now = Date.now()): string | null {
  if (!stored) return null
  const t = Date.parse(stored)
  if (!Number.isFinite(t) || t > now) return null
  return new Date(t).toISOString()
}
