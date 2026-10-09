/**
 * "Remove embeds" / "Show embeds": offered to the author, and to MANAGE_MESSAGES in a server
 * channel, on a message with link or embed parts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

const perms = vi.hoisted(() => ({ manage: false }))
const setEmbedsSuppressed = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@/stores/useReactions', () => ({ useReactionsStore: () => ({ getMessageReactions: () => [] }) }))
vi.mock('@/composables/useFrequentEmojis', () => ({
  useFrequentEmojis: () => ({ topEmojisForContextMenu: ref([]), hasFrequentEmojis: ref(false), recordEmojiUsage: vi.fn() }),
}))
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerReaction: vi.fn() }) }))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({ canPinMessages: ref(false), canManageMessages: ref(perms.manage) }),
}))
vi.mock('@/composables/useDeveloperTools', () => ({ useDeveloperTools: () => ({ developerToolsEnabled: ref(false) }) }))
vi.mock('@/composables/usePinActions', () => ({ usePinActions: () => ({ setPinned: vi.fn() }) }))
vi.mock('@/services/privateMedia', () => ({ resolveMediaPartUrl: vi.fn(async () => null) }))
vi.mock('@/utils/downloadMedia', () => ({ downloadMediaFromUrl: vi.fn(), filenameFromUrl: vi.fn() }))
vi.mock('@/services/messageEmbeds', async (orig) => ({
  ...(await orig<typeof import('@/services/messageEmbeds')>()),
  setEmbedsSuppressed,
}))

import MessageContextMenu from '../MessageContextMenu.vue'

const linkMessage = (userId: string, metadata: Record<string, unknown> = {}) => ({
  id: 'm1', user_id: userId, metadata, created_at: new Date(),
  content: [{ type: 'url', url: 'https://example.com' }],
}) as any

const mountMenu = (message: any, extra: Record<string, unknown> = {}) => mount(MessageContextMenu, {
  props: { isVisible: true, position: { x: 0, y: 0 }, message, currentUserId: 'me', ...extra },
  global: {
    mocks: { $t: (key: string) => key },
    stubs: { teleport: true, Icon: true },
    directives: { clickOutside: {} },
  },
})

const item = '[data-testid="context-menu-toggle-embeds"]'

beforeEach(() => {
  perms.manage = false
  setEmbedsSuppressed.mockClear()
})

describe('MessageContextMenu embeds', () => {
  it('offers the author Remove embeds and calls the service', async () => {
    const message = linkMessage('me')
    const wrapper = mountMenu(message, { channelId: 'c1' })
    const el = wrapper.get(item)
    expect(el.text()).toBe('message.embeds.remove')
    await el.trigger('click')
    expect(setEmbedsSuppressed).toHaveBeenCalledWith(message, true)
  })

  it('offers Show embeds on a suppressed message', () => {
    const wrapper = mountMenu(linkMessage('me', { suppress_embeds: true }), { channelId: 'c1' })
    expect(wrapper.get(item).text()).toBe('message.embeds.show')
  })

  it('offers it to MANAGE_MESSAGES in a channel, not in a DM, and not to other members', () => {
    expect(mountMenu(linkMessage('them'), { channelId: 'c1' }).find(item).exists()).toBe(false)
    perms.manage = true
    expect(mountMenu(linkMessage('them'), { channelId: 'c1' }).find(item).exists()).toBe(true)
    expect(mountMenu(linkMessage('them'), { conversationId: 'd1' }).find(item).exists()).toBe(false)
  })

  it('is absent on a message without links', () => {
    const wrapper = mountMenu({ id: 'm2', user_id: 'me', content: [{ type: 'text', text: 'hi' }], created_at: new Date() })
    expect(wrapper.find(item).exists()).toBe(false)
  })
})
