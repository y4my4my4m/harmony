/**
 * A message in a copy of a server hosted on another instance: no Pin and no Remove embeds for
 * another member's message, and instance staff's Delete is "Hide on {instance}". A conversation
 * viewed after a copy keeps Pin: its rules are the conversation's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

const state = vi.hoisted(() => ({ local: false }))

vi.mock('@/stores/useReactions', () => ({ useReactionsStore: () => ({ getMessageReactions: () => [] }) }))
vi.mock('@/composables/useFrequentEmojis', () => ({
  useFrequentEmojis: () => ({ topEmojisForContextMenu: ref([]), hasFrequentEmojis: ref(false), recordEmojiUsage: vi.fn() }),
}))
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerReaction: vi.fn() }) }))
vi.mock('@/composables/useServerPermissions', () => ({
  // The last server viewed is the copy: no server-wide pin right.
  useServerPermissions: () => ({ canPinMessages: ref(false), isLocalServer: ref(state.local) }),
}))
// A stale answer granting the moderation bits: the copy check alone hides the actions.
vi.mock('@/composables/useChannelMessagePermissions', () => ({
  useChannelMessagePermissions: () => ({
    canPinMessages: ref(true), canManageMessages: ref(true), canCreateThreads: ref(true), canEmbedLinks: ref(true),
  }),
}))
vi.mock('@/composables/useDeveloperTools', () => ({ useDeveloperTools: () => ({ developerToolsEnabled: ref(false) }) }))
vi.mock('@/composables/usePinActions', () => ({ usePinActions: () => ({ setPinned: vi.fn() }) }))
vi.mock('@/services/privateMedia', () => ({ resolveMediaPartUrl: vi.fn(async () => null) }))
vi.mock('@/utils/downloadMedia', () => ({ downloadMediaFromUrl: vi.fn(), filenameFromUrl: vi.fn() }))
vi.mock('@/services/instanceConfig', async (orig) => ({
  ...(await orig<typeof import('@/services/instanceConfig')>()),
  getInstanceDomain: () => 'home.test',
}))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('@/composables/useT', () => ({
  useT: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key) }),
}))

import MessageContextMenu from '../MessageContextMenu.vue'

const linkMessage = (userId: string) => ({
  id: 'm1', user_id: userId, metadata: {}, created_at: new Date(),
  content: [{ type: 'url', url: 'https://example.com' }],
}) as any

const mountMenu = (message: any, extra: Record<string, unknown> = {}) => mount(MessageContextMenu, {
  props: { isVisible: true, position: { x: 0, y: 0 }, message, currentUserId: 'me', channelId: 'c1', serverId: 's1', ...extra },
  global: {
    mocks: { $t: (key: string) => key },
    stubs: { teleport: true, Icon: true },
    directives: { clickOutside: {} },
  },
})

beforeEach(() => {
  state.local = false
})

describe('MessageContextMenu in a copy', () => {
  it('offers no Pin', () => {
    expect(mountMenu(linkMessage('them')).text()).not.toContain('message.pinMessage')
  })

  it('offers no Remove embeds on another member\'s message, but the author keeps theirs', () => {
    const item = '[data-testid="context-menu-toggle-embeds"]'
    expect(mountMenu(linkMessage('them')).find(item).exists()).toBe(false)
    expect(mountMenu(linkMessage('me')).find(item).exists()).toBe(true)
  })

  it('names instance staff\'s Delete for the instance it hides on', () => {
    const wrapper = mountMenu(linkMessage('them'), { canDelete: true, hidesOnInstance: true })
    const del = wrapper.get('[data-testid="context-menu-delete"]')
    expect(del.text()).toBe('serverCopy.hide.action {"instance":"home.test"}')
  })

  it('keeps Delete for the author\'s own message', () => {
    const wrapper = mountMenu(linkMessage('me'), { canDelete: true })
    expect(wrapper.get('[data-testid="context-menu-delete"]').text()).toBe('message.deleteMessage')
  })

  it('offers Pin on a server hosted here', () => {
    state.local = true
    expect(mountMenu(linkMessage('them')).text()).toContain('message.pinMessage')
  })

  it('offers Pin in a conversation opened after the copy', () => {
    const wrapper = mountMenu(linkMessage('them'), { conversationId: 'dm-1', channelId: undefined, serverId: undefined })
    expect(wrapper.text()).toContain('message.pinMessage')
  })
})
