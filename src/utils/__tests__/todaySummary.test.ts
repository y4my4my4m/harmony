import { describe, it, expect } from 'vitest'
import {
  announcementIcon,
  emptySummary,
  encryptedMessages,
  headlineStats,
  mentionRoute,
  parseVisit,
  previewParts,
  previewText,
  relativePhrase,
  shapeTodaySummary,
  withMessages,
  withoutAnnouncement,
  withoutFollowRequest,
  withoutServer,
} from '@/utils/todaySummary'
import type { Message, MessagePart } from '@/types'

const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

const raw = {
  generated_at: '2026-09-30T12:00:00Z',
  since: '2026-09-29T12:00:00Z',
  mentions: [
    {
      kind: 'mention',
      unread: true,
      message: {
        id: U(1), channel_id: U(10), thread_id: null, conversation_id: null, user_id: U(2),
        content: [{ type: 'text', text: 'hi ' }, { type: 'mention', userId: U(3), username: 'me' }],
        encrypted: false, created_at: '2026-09-30T11:00:00Z', metadata: {},
      },
      author: { id: U(2), username: 'bob', display_name: 'Bob', avatar_url: '/b.png', domain: 'x', is_local: true },
      server: { id: U(20), name: 'Srv', icon: null },
      channel_name: 'general',
      thread_name: null,
      conversation: null,
    },
    {
      kind: 'reply',
      unread: false,
      message: {
        id: U(4), conversation_id: U(30), user_id: U(2), content: [{ type: 'text', text: 'ct' }],
        encrypted: true, encryption_metadata: { algorithm: 'megolm' }, created_at: '2026-09-30T10:00:00Z',
      },
      server: null,
      conversation: { id: U(30), type: 'group', name: 'Crew' },
    },
    { kind: 'mention', message: { content: [] } },
    'garbage',
  ],
  conversations: [
    {
      id: U(30), type: 'group', name: null, icon_url: 'g.png', unread_messages: '3',
      unread_mentions: 1, participant_count: 5,
      participants: [{ id: U(2), username: 'bob' }, { username: 'no-id' }],
      last_message: { id: U(4), user_id: U(2), content: [], encrypted: true, created_at: '2026-09-30T10:00:00Z' },
    },
  ],
  servers: [
    {
      id: U(20), name: 'Srv', icon: 'i.png', unread_messages: 12, unread_mentions: 2, channel_count: 3,
      last_activity: '2026-09-30T11:00:00Z',
      channels: [{ id: U(10), name: 'general', type: 0, unread_messages: 10, unread_mentions: 2 }],
    },
  ],
  threads: [
    {
      id: U(40), name: 'Plans', channel_id: U(10), channel_name: 'general',
      server: { id: U(20), name: 'Srv', icon: null }, new_replies: 4, last_reply_at: '2026-09-30T11:30:00Z',
      repliers: [{ id: U(2), username: 'bob', avatar_url: null }],
    },
    { id: U(41), name: 'No server', channel_id: U(10) },
  ],
  voice: [
    {
      channel_id: U(50), channel_name: 'Lounge', server: { id: U(20), name: 'Srv', icon: null, is_local: false },
      participant_count: 7, started_at: '2026-09-30T11:00:00Z', includes_me: false,
      participants: [{ id: U(2), username: 'bob' }],
    },
  ],
  follow_requests: [{ id: U(5), username: 'carol', requested_at: '2026-09-30T09:00:00Z', is_local: false, domain: 'remote.tld' }],
  new_followers: [{ id: U(6), username: 'dave', followed_at: '2026-09-30T08:00:00Z' }],
  social: {
    unread: { activitypub_favorite: 3, activitypub_reblog: '2', activitypub_bogus: 9 },
    items: [
      {
        notification_id: U(70), type: 'activitypub_reply', created_at: '2026-09-30T07:00:00Z',
        post: { id: U(71), content: [{ type: 'text', text: 'nice' }], content_warning: 'spoilers' },
        author: { id: U(6), username: 'dave' },
      },
      { notification_id: U(72), type: 'activitypub_mention', post: null },
    ],
  },
  followed_posts: [
    {
      id: U(80), created_at: '2026-09-30T06:00:00Z', content: [{ type: 'text', text: 'post' }],
      media_count: 2, replies_count: 1, reblogs_count: 0, favorites_count: 5,
      author: { id: U(7), username: 'erin', domain: 'far.tld', is_local: false },
    },
  ],
  announcements: [{ id: U(90), title: 'Maintenance', content: 'Tonight', icon: 'maintenance', is_pinned: true }],
  totals: {
    unread_mentions: 3, mentions_unread: 1, conversations: 9, dm_messages: 20, servers: 4, channels: 7,
    channel_messages: 40, threads: 1, follow_requests: 1, new_followers: 1, announcements: 1,
  },
}

describe('shapeTodaySummary', () => {
  it('returns the empty summary for null and non-objects', () => {
    expect(shapeTodaySummary(null)).toEqual(emptySummary())
    expect(shapeTodaySummary([1, 2])).toEqual(emptySummary())
    expect(shapeTodaySummary('x')).toEqual(emptySummary())
  })

  it('shapes mentions and drops entries without a message id', () => {
    const s = shapeTodaySummary(raw)
    expect(s.mentions).toHaveLength(2)
    const [first, second] = s.mentions
    expect(first.kind).toBe('mention')
    expect(first.unread).toBe(true)
    expect(first.message.created_at.toISOString()).toBe('2026-09-30T11:00:00.000Z')
    expect(first.message.channel_id).toBe(U(10))
    expect(first.message.thread_id).toBeUndefined()
    expect(first.author?.displayName).toBe('Bob')
    expect(first.server).toEqual({ id: U(20), name: 'Srv', icon: null, isLocal: true })
    expect(second.kind).toBe('reply')
    expect(second.message.encrypted).toBe(true)
    expect(second.message.encryption_metadata).toEqual({ algorithm: 'megolm' })
    expect(second.message.content).toEqual([{ type: 'text', text: 'ct' }])
    expect(second.conversation).toEqual({ id: U(30), type: 'group', name: 'Crew' })
  })

  it('coerces numeric strings and drops participants without ids', () => {
    const [c] = shapeTodaySummary(raw).conversations
    expect(c.unreadMessages).toBe(3)
    expect(c.participants.map(p => p.id)).toEqual([U(2)])
    expect(c.iconUrl).toBe('g.png')
    expect(c.lastMessage?.encrypted).toBe(true)
  })

  it('drops threads and social items missing a required reference', () => {
    const s = shapeTodaySummary(raw)
    expect(s.threads.map(t => t.id)).toEqual([U(40)])
    expect(s.socialItems.map(i => i.notificationId)).toEqual([U(70)])
    expect(s.socialItems[0].post.contentWarning).toBe('spoilers')
    expect(s.socialItems[0].post.author?.username).toBe('dave')
  })

  it('maps social counts by type and ignores unknown types', () => {
    const { socialCounts } = shapeTodaySummary(raw)
    expect(socialCounts).toEqual({ mention: 0, reply: 0, favorite: 3, reblog: 2, reaction: 0, follow: 0 })
  })

  it('carries server locality, follower times and totals', () => {
    const s = shapeTodaySummary(raw)
    expect(s.voice[0].server.isLocal).toBe(false)
    expect(s.followRequests[0]).toMatchObject({ id: U(5), at: '2026-09-30T09:00:00Z', isLocal: false })
    expect(s.newFollowers[0].at).toBe('2026-09-30T08:00:00Z')
    expect(s.followedPosts[0].mediaCount).toBe(2)
    expect(s.totals.channelMessages).toBe(40)
    expect(s.announcements[0].isPinned).toBe(true)
  })
})

describe('previewParts / previewText', () => {
  const content = [
    { type: 'text', text: 'see  ' },
    { type: 'mention', userId: U(1), username: 'bob', displayName: 'Bob' },
    { type: 'file', url: 'https://cdn/a.png', fileType: 'image' },
    { type: 'embed', url: 'https://x', provider: 'generic', previewId: 'p' },
    { type: 'file', url: 'https://cdn/b.zip', fileType: 'file' },
    { type: 'emoji', emoji: { name: 'wave' } },
    { type: 'system', event_type: 'join' },
    null,
  ] as unknown as MessagePart[]

  it('keeps inline parts and counts file parts', () => {
    const { parts, attachments } = previewParts(content)
    expect(parts.map(p => p.type)).toEqual(['text', 'mention', 'emoji'])
    expect(attachments).toBe(2)
  })

  it('flattens inline parts to text', () => {
    expect(previewText(content)).toBe('see @Bob:wave:')
    expect(previewText(null)).toBe('')
  })
})

describe('mentionRoute', () => {
  const s = shapeTodaySummary(raw)

  it('routes a channel message to its channel with the message id', () => {
    expect(mentionRoute(s.mentions[0])).toEqual({
      name: 'ChatChannel',
      params: { serverId: U(20), channelId: U(10) },
      query: { messageId: U(1) },
    })
  })

  it('routes a conversation message to the conversation', () => {
    expect(mentionRoute(s.mentions[1])).toEqual({
      name: 'DMConversation',
      params: { conversationId: U(30) },
      query: { messageId: U(4) },
    })
  })

  it('routes a thread message to the thread view', () => {
    const m = { ...s.mentions[0], message: { ...s.mentions[0].message, thread_id: U(40) } }
    expect(mentionRoute(m)).toEqual({
      name: 'ThreadView',
      params: { serverId: U(20), threadId: U(40) },
      query: { messageId: U(1) },
    })
  })

  it('returns null without a server for a channel message', () => {
    expect(mentionRoute({ ...s.mentions[0], server: null })).toBeNull()
  })
})

describe('headlineStats', () => {
  it('lists nonzero counts in display order with voice people summed', () => {
    const stats = headlineStats(shapeTodaySummary(raw))
    expect(stats.map(s => [s.key, s.count])).toEqual([
      ['mentions', 1], ['conversations', 9], ['channels', 40], ['threads', 1], ['voice', 7], ['followRequests', 1],
    ])
  })

  it('is empty when nothing is waiting', () => {
    expect(headlineStats(emptySummary())).toEqual([])
  })
})

describe('optimistic updates', () => {
  const s = shapeTodaySummary(raw)

  it('removes a server and subtracts its counts', () => {
    const next = withoutServer(s, U(20))
    expect(next.servers).toEqual([])
    expect(next.totals).toMatchObject({ servers: 3, channels: 4, channelMessages: 28, unreadMentions: 1 })
    expect(withoutServer(s, U(99))).toBe(s)
  })

  it('removes a follow request and an announcement', () => {
    expect(withoutFollowRequest(s, U(5)).totals.followRequests).toBe(0)
    expect(withoutFollowRequest(s, U(99))).toBe(s)
    expect(withoutAnnouncement(s, U(90)).announcements).toEqual([])
    expect(withoutAnnouncement(s, U(99))).toBe(s)
  })

  it('collects encrypted messages and swaps in decrypted copies', () => {
    const encrypted = encryptedMessages(s)
    expect(encrypted.map(m => m.id)).toEqual([U(4), U(4)])
    const decrypted: Message = { ...encrypted[0], content: [{ type: 'text', text: 'plain' }], decrypted: true }
    const next = withMessages(s, [decrypted])
    expect(next.mentions[1].message.decrypted).toBe(true)
    expect(next.conversations[0].lastMessage?.content).toEqual([{ type: 'text', text: 'plain' }])
    expect(next.mentions[0]).toBe(s.mentions[0])
    expect(withMessages(s, [])).toBe(s)
  })
})

describe('visit time', () => {
  const NOW = Date.parse('2026-09-30T12:00:00Z')

  it('accepts a past ISO time and rejects missing, garbage and future values', () => {
    expect(parseVisit('2026-09-30T08:00:00Z', NOW)).toBe('2026-09-30T08:00:00.000Z')
    expect(parseVisit(null, NOW)).toBeNull()
    expect(parseVisit('soon', NOW)).toBeNull()
    expect(parseVisit('2026-10-01T00:00:00Z', NOW)).toBeNull()
  })

  it('phrases the gap in the largest whole unit', () => {
    expect(relativePhrase('2026-09-30T11:59:30Z', 'en', NOW)).toBeNull()
    expect(relativePhrase('2026-09-30T11:55:00Z', 'en', NOW)).toBe('5 minutes ago')
    expect(relativePhrase('2026-09-30T08:00:00Z', 'en', NOW)).toBe('4 hours ago')
    expect(relativePhrase('2026-09-29T10:00:00Z', 'en', NOW)).toBe('yesterday')
    expect(relativePhrase('2026-09-16T12:00:00Z', 'en', NOW)).toBe('2 weeks ago')
    expect(relativePhrase('nope', 'en', NOW)).toBeNull()
  })
})

describe('announcementIcon', () => {
  it('maps known icons and falls back to info', () => {
    expect(announcementIcon('maintenance')).toBe('wrench')
    expect(announcementIcon('warning')).toBe('alert-triangle')
    expect(announcementIcon(null)).toBe('info')
    expect(announcementIcon('unknown')).toBe('info')
  })
})
