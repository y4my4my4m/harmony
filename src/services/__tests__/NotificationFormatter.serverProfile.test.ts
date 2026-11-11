/**
 * Notifications raised in a server channel name the sender by their server nickname and show
 * their server avatar; DMs and fediverse notifications keep the account profile.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/services/userDataService', () => {
  const fields = new Map<string, { nickname: string | null; avatar_url: string | null }>()
  return {
    userDataService: { getMemberServerFields: (s: string, u: string) => fields.get(`${s}:${u}`) ?? null, __fields: fields },
  }
})

import { userDataService } from '@/services/userDataService'
import { NotificationFormatter } from '../NotificationFormatter'
import type { Notification } from '@/types'

const fields = (userDataService as any).__fields as Map<string, unknown>

const channelMessage = (extra: Record<string, unknown> = {}) => ({
  id: 'n1',
  type: 'channel_message',
  data: {
    server_id: 'srv', channel_id: 'chan',
    sender: { user_id: 'u1', display_name: 'Account Name', username: 'acct', avatar_url: 'account.png' },
    message: { content_preview: 'hello' },
    ...extra,
  },
}) as unknown as Notification

describe('NotificationFormatter server profiles', () => {
  beforeEach(() => {
    fields.clear()
    fields.set('srv:u1', { nickname: 'Nick', avatar_url: 'https://cdn.test/server.png' })
  })

  it('swaps the sender name for the nickname in a server notification', () => {
    const n = channelMessage()
    const formatted = NotificationFormatter.formatNotification(n)
    expect(formatted.title).toContain('Account Name')
    expect(NotificationFormatter.withServerNickname(n, formatted).title).toBe('Nick sent a message')
  })

  it('uses the server avatar and reports the server for the toast', () => {
    const n = channelMessage()
    expect(NotificationFormatter.getAvatarUrl(n)).toContain('cdn.test/server.png')
    expect(NotificationFormatter.getActorInfo(n)?.serverId).toBe('srv')
  })

  it('changes only the actor part when the account name also appears elsewhere in the text', () => {
    const n = channelMessage({ sender: { user_id: 'u1', display_name: 'Ann', username: 'ann' } })
    const formatted = { title: 'Ann mentioned you in #Ann-chat', message: 'x', shortTitle: 'Mention in #Ann-chat from Ann' }
    const out = NotificationFormatter.withServerNickname(n, formatted)
    expect(out.title).toBe('Nick mentioned you in #Ann-chat')
    expect(out.shortTitle).toBe('Mention in #Ann-chat from Nick')
  })

  it('leaves DMs alone', () => {
    const n = channelMessage({ server_id: undefined, channel_id: undefined, conversation_id: 'conv' })
    const formatted = NotificationFormatter.formatNotification(n)
    expect(NotificationFormatter.withServerNickname(n, formatted)).toBe(formatted)
    expect(NotificationFormatter.getAvatarUrl(n)).not.toContain('server.png')
  })
})
