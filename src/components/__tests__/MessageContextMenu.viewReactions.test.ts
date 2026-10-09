/**
 * "View reactions" appears in the message context menu only while the message
 * has reactions, and hands the message to the parent before closing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

const state = vi.hoisted(() => ({ groups: {} as Record<string, any[]> }))

vi.mock('@/stores/useReactions', () => ({
  useReactionsStore: () => ({ getMessageReactions: (id: string) => state.groups[id] ?? [] }),
}))
vi.mock('@/composables/useFrequentEmojis', () => ({
  useFrequentEmojis: () => ({ topEmojisForContextMenu: ref([]), hasFrequentEmojis: ref(false), recordEmojiUsage: vi.fn() }),
}))
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerReaction: vi.fn() }) }))
vi.mock('@/composables/useServerPermissions', () => ({ useServerPermissions: () => ({ canPinMessages: ref(false) }) }))
vi.mock('@/composables/useDeveloperTools', () => ({ useDeveloperTools: () => ({ developerToolsEnabled: ref(false) }) }))
vi.mock('@/composables/usePinActions', () => ({ usePinActions: () => ({ setPinned: vi.fn() }) }))
vi.mock('@/services/privateMedia', () => ({ resolveMediaPartUrl: vi.fn(async () => null) }))
vi.mock('@/utils/downloadMedia', () => ({ downloadMediaFromUrl: vi.fn(), filenameFromUrl: vi.fn() }))

import MessageContextMenu from '../MessageContextMenu.vue'

const message = { id: 'm1', user_id: 'them', content: [{ type: 'text', text: 'hi' }], created_at: new Date() } as any

const mountMenu = () => mount(MessageContextMenu, {
  props: { isVisible: true, position: { x: 0, y: 0 }, message, currentUserId: 'me' },
  global: {
    mocks: { $t: (key: string) => key },
    stubs: { teleport: true, Icon: true },
    directives: { clickOutside: {} },
  },
})

const viewItem = '[data-testid="context-menu-view-reactions"]'

beforeEach(() => {
  state.groups = {}
})

describe('MessageContextMenu View reactions', () => {
  it('is absent on a message without reactions', () => {
    const wrapper = mountMenu()
    expect(wrapper.find(viewItem).exists()).toBe(false)
  })

  it('emits the message and closes on a message with reactions', async () => {
    state.groups = { m1: [{ emoji_id: null, emoji: { name: '👍' }, count: 1, reactions: [] }] }
    const wrapper = mountMenu()
    const item = wrapper.get(viewItem)
    expect(item.text()).toBe('message.reactions.view')
    await item.trigger('click')
    expect(wrapper.emitted('view-reactions')).toEqual([[message]])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
