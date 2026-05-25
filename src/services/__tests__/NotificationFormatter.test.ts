import { describe, it, expect, vi } from 'vitest'

vi.mock('@/utils/avatarUtils', () => ({
  getAvatarUrl: vi.fn((url: string | null) => url || '/default_avatar.webp'),
}))

import { NotificationFormatter } from '@/services/NotificationFormatter'

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
