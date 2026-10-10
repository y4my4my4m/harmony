import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('@/utils/avatarUtils', () => ({
  getAvatarUrl: vi.fn((url: string | null) => url || '/default_avatar.webp'),
}))

import { NotificationFormatter } from '@/services/NotificationFormatter'
import { waitForInitialLocale } from '@/i18n'

function makeNotification(type: string, data: Record<string, any> = {}) {
  return {
    id: 'notif-1',
    type,
    data,
    read: false,
    created_at: new Date().toISOString(),
    user_id: 'user-1',
    ...data,
  } as any
}

describe('NotificationFormatter', () => {
  beforeAll(async () => {
    await waitForInitialLocale()
  })

  describe('formatNotification', () => {
    it('formats a mention notification', () => {
      const notif = makeNotification('mention', {
        data: {
          sender: { username: 'alice', display_name: 'Alice' },
          location: { channel_name: 'general' },
          message: { content_preview: 'Hey @you!' },
        },
      })
      const result = NotificationFormatter.formatNotification(notif)
      expect(result.title).toContain('Alice')
      expect(result.title).toContain('general')
      expect(result.message).toContain('Hey @you!')
    })

    it('formats a channel message for a channel at level all', () => {
      const notif = makeNotification('channel_message', {
        data: {
          sender: { username: 'alice', display_name: 'Alice' },
          location: { channel_name: 'general' },
          message: { content_preview: 'lunch?' },
        },
      })
      const result = NotificationFormatter.formatNotification(notif)
      expect(result.title).toBe('Alice sent a message in #general')
      expect(result.message).toBe('lunch?')
      expect(result.shortTitle).toBe('Message in #general')
    })

    it('formats a moderation warning with its text and no moderator', () => {
      const notif = makeNotification('moderation_warning', { data: { text: 'Keep it civil.' } })
      const result = NotificationFormatter.formatNotification(notif)
      expect(result.title).toBe('Warning from the moderators')
      expect(result.message).toBe('Keep it civil.')
      expect(NotificationFormatter.getAvatarUrl(notif)).toBe('/default_avatar.webp')
    })

    it('names no moderator on a report update unless the moderator chose to', () => {
      const hidden = makeNotification('report_update', {
        data: { status: 'resolved', report_type: 'post', show_resolver: false, resolver_username: 'mod' },
      })
      expect(NotificationFormatter.formatNotification(hidden).title).toBe('Your report has been resolved')
      expect(NotificationFormatter.getAvatarUrl(hidden)).toBe('/default_avatar.webp')
    })

    it('previews an encrypted mention generically, never its stored content', () => {
      const notif = makeNotification('mention', {
        data: {
          sender: { username: 'alice', display_name: 'Alice' },
          location: { channel_name: 'general' },
          encrypted: true,
          message: { content: [{ type: 'text', text: 'Q2lwaGVydGV4dA==' }], content_preview: 'Q2lwaGVydGV4dA==' },
          preview: 'Q2lwaGVydGV4dA==',
        },
      })
      const result = NotificationFormatter.formatNotification(notif)
      expect(result.title).toContain('Alice')
      expect(result.message).toBe('Encrypted message')
    })

    it('formats a DM notification', () => {
      const notif = makeNotification('dm', {
        data: {
          sender: { username: 'bob', display_name: 'Bob' },
          message: { content_preview: 'Hello there' },
        },
      })
      const result = NotificationFormatter.formatNotification(notif)
      expect(result.title).toContain('Bob')
      expect(result.message).toContain('Hello there')
    })

    it('handles unknown notification type gracefully', () => {
      const notif = makeNotification('unknown_type', { data: {} })
      const result = NotificationFormatter.formatNotification(notif)
      expect(result.title).toBeTruthy()
      expect(typeof result.message).toBe('string')
    })
  })

  describe('newcomer_message', () => {
    beforeAll(async () => {
      await waitForInitialLocale()
    })

    const newcomer = (extra: Record<string, any> = {}) => makeNotification('newcomer_message', {
      data: {
        sender: { user_id: 'u-alice', username: 'alice', display_name: 'Alice', avatar_url: 'a.webp' },
        message: { id: 'm-1', content_preview: 'hi all, just joined' },
        location: { server_id: 's-1', server_name: 'Garden', channel_id: 'c-1', channel_name: 'general' },
        message_id: 'm-1',
        server_id: 's-1',
        channel_id: 'c-1',
        preview: 'hi all, just joined',
        ...extra,
      },
    })

    it('names the new member and the channel and previews the message', () => {
      const result = NotificationFormatter.formatNotification(newcomer())
      expect(result.title).toBe('Alice is new here and posted in #general')
      expect(result.titleAction).toBe(' is new here and posted in #general')
      expect(result.message).toBe('hi all, just joined')
      expect(result.shortTitle).toBe('New member in #general')
    })

    it('suggests a greeting when the message has no text', () => {
      const notif = newcomer({ message: { id: 'm-1' }, preview: undefined })
      expect(NotificationFormatter.formatNotification(notif).message).toBe('Say hello')
    })

    it('shows no content for an encrypted message', () => {
      const notif = newcomer({ encrypted: true, message: { id: 'm-1', content_preview: 'Encrypted message' }, preview: undefined })
      expect(NotificationFormatter.formatNotification(notif).message).toBe('Encrypted message')
    })

    it('gives the toast the author and the text after their name', () => {
      expect(NotificationFormatter.getActorInfo(newcomer())).toEqual({
        actorUserId: 'u-alice',
        titleSuffix: ' is new here and posted in #general',
      })
      expect(NotificationFormatter.getAvatarUrl(newcomer())).toBe('a.webp')
    })

    it('opens the message in its channel', () => {
      expect(NotificationFormatter.getNavigationData(newcomer())).toEqual({
        type: 'channel',
        serverId: 's-1',
        channelId: 'c-1',
        messageId: 'm-1',
      })
    })
  })

  describe('getUsername', () => {
    it('extracts username from sender object', () => {
      const notif = makeNotification('mention', {
        data: { sender: { username: 'alice', display_name: 'Alice' } },
      })
      const username = NotificationFormatter.getUsername(notif)
      expect(username.toLowerCase()).toContain('alice')
    })

    it('returns fallback for missing data', () => {
      const notif = makeNotification('mention', { data: {} })
      const username = NotificationFormatter.getUsername(notif)
      expect(typeof username).toBe('string')
    })
  })

  describe('getPreviewText', () => {
    it('returns the message portion', () => {
      const notif = makeNotification('dm', {
        data: {
          sender: { username: 'test' },
          message: { content_preview: 'Preview text' },
        },
      })
      const preview = NotificationFormatter.getPreviewText(notif)
      expect(typeof preview).toBe('string')
    })
  })

  describe('isClickable', () => {
    it('returns true for notification with conversation_id', () => {
      const notif = makeNotification('dm', {
        data: { conversation_id: 'conv-1' },
      })
      expect(NotificationFormatter.isClickable(notif)).toBe(true)
    })

    it('returns false for notification with no navigation target', () => {
      const notif = makeNotification('system', { data: {} })
      expect(NotificationFormatter.isClickable(notif)).toBe(false)
    })
  })

  describe('getNavigationData', () => {
    it('returns conversation navigation for DM', () => {
      const notif = makeNotification('dm', {
        data: { conversation_id: 'conv-1' },
      })
      const nav = NotificationFormatter.getNavigationData(notif)
      expect(nav).not.toBeNull()
      expect(nav!.type).toBe('conversation')
    })

    it('returns channel navigation for mention with channel data', () => {
      const notif = makeNotification('mention', {
        data: {
          location: { server_id: 'srv-1', channel_id: 'ch-1' },
        },
      })
      const nav = NotificationFormatter.getNavigationData(notif)
      expect(nav).not.toBeNull()
      expect(nav!.type).toBe('channel')
    })

    it('returns null for notification without navigation', () => {
      const notif = makeNotification('system', { data: {} })
      const nav = NotificationFormatter.getNavigationData(notif)
      expect(nav).toBeNull()
    })
  })
})
