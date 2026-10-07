/**
 * A Discord emoji part sent from Harmony renders like one the bridge relays:
 * an image in the message, `:name:` in previews, replies and notifications.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))
vi.mock('@/utils/avatarUtils', () => ({
  getAvatarUrl: vi.fn((url: string | null) => url || '/default_avatar.webp'),
}))

import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import { NotificationFormatter } from '@/services/NotificationFormatter'
import { waitForInitialLocale } from '@/i18n'
import { isSingleEmojiMessage, messagePartsToPlainText } from '@/utils/messageContentUtils'
import { parseContentToMessageParts } from '@/utils/unifiedContentProcessing'
import type { MessagePart } from '@/types'

const ID = '1376980620600672316'

function render(content: unknown[]) {
  setActivePinia(createPinia())
  return shallowMount(UnifiedMessageContent, {
    props: { content, messageId: 'm1', isEditing: false, editableContent: '' },
    global: { mocks: { $t: (key: string) => key } },
  })
}

let parts: MessagePart[]

beforeAll(async () => {
  await waitForInitialLocale()
  parts = await parseContentToMessageParts(`...factors :discord:heh:${ID}: )`)
})

describe('Discord emoji part rendering', () => {
  it('shows the emoji image in the message', () => {
    const w = render(parts)
    const img = w.get('img.emoji-icon')
    expect(img.attributes('src')).toBe(`https://cdn.discordapp.com/emojis/${ID}.png`)
    expect(img.attributes('alt')).toBe(':heh:')
    expect(w.text()).not.toContain('discord:')
  })

  it('shows an animated emoji as the .gif; alone it is a single-emoji message', async () => {
    const lone = await parseContentToMessageParts(`:discord:a:heh:${ID}: `)
    expect(render(lone).get('img.emoji-icon').attributes('src')).toBe(`https://cdn.discordapp.com/emojis/${ID}.gif`)
    expect(isSingleEmojiMessage(lone)).toBe(true)
  })

  it('reads as :name: in previews and reply references', () => {
    expect(messagePartsToPlainText(parts)).toBe('...factors :heh: )')
  })

  it('reads as :name: in notification text', () => {
    const notif = {
      id: 'n1',
      type: 'dm',
      read: false,
      created_at: new Date().toISOString(),
      user_id: 'u1',
      data: { sender: { username: 'bob', display_name: 'Bob' }, message: { content: parts } },
    } as any
    const { message } = NotificationFormatter.formatNotification(notif)
    expect(message).toContain(':heh:')
    expect(message).not.toContain('discord:')
  })
})
