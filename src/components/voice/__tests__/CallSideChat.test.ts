import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { computed, reactive, ref } from 'vue'

// The side chat panel: a named region with the routed list, a keyboard
// operable width separator, the call chat's own list while the main window
// shows another chat, and focus on request.

const h = vi.hoisted(() => ({ chat: null as any, width: null as any, setWidth: null as any, feed: null as any }))
const { stub } = vi.hoisted(() => ({
  stub: (name: string) => ({
    __esModule: true,
    default: { name, props: ['chatMessages', 'channelId', 'serverId', 'listState', 'isLoading'], render: () => null },
  }),
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string, args?: Record<string, unknown>) => (args ? `${key}:${JSON.stringify(args)}` : key) }) }))
vi.mock('@/components/common/UnifiedContentArea.vue', () => stub('UnifiedContentArea'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/stores/useChat', () => ({ useChatStore: () => ({ messages: [{ id: 'm1' }] }) }))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => ({ currentDMMessages: [] }) }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ channels: [{ id: 'lounge', name: 'lounge' }] }) }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => ({ dmOtherUserId: null, effectiveChannelName: 'lounge' }) }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({ getUserDisplayName: () => ({ value: '' }) }) }))
vi.mock('@/composables/chatPaging', () => ({
  channelListLoading: { value: false },
  conversationListLoading: { value: false },
  loadOlderChannelMessages: vi.fn(),
  loadOlderConversationMessages: vi.fn(),
}))
vi.mock('../callChat', () => ({
  CALL_CHAT_WIDTH: { min: 280, initial: 360, max: 640 },
  setCallChatWidth: (px: number) => h.setWidth(px),
  useCallChat: () => h.chat,
}))
vi.mock('../callChatFeed', () => ({ useCallChatFeed: () => h.feed }))

import CallSideChat from '../CallSideChat.vue'

let wrapper: VueWrapper | null = null

beforeEach(() => {
  h.width = ref(360)
  h.setWidth = vi.fn((px: number) => { h.width.value = Math.min(640, Math.max(280, px)) })
  const state = reactive({ routed: true })
  h.chat = {
    state,
    target: computed(() => ({ kind: 'channel', serverId: 's1', channelId: 'lounge' })),
    width: h.width,
    routed: computed(() => state.routed),
  }
  h.feed = {
    messages: computed(() => [{ id: 'own-1' }]),
    loading: ref(false),
    listState: computed(() => ({ loadingOlder: false, allLoaded: true })),
    loadOlder: vi.fn(),
  }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

const mountPanel = async (props: Record<string, unknown> = {}) => {
  wrapper = mount(CallSideChat, { props: { id: 'chat-1', ...props }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('CallSideChat', () => {
  it('is a region named for the chat, showing the routed list', async () => {
    const panel = await mountPanel()
    const region = panel.find('section')
    expect(region.attributes('id')).toBe('chat-1')
    expect(region.attributes('aria-label')).toBe('voice.callChat.region:{"name":"lounge"}')
    const list = panel.findComponent({ name: 'UnifiedContentArea' })
    expect(list.props('channelId')).toBe('lounge')
    expect(list.props('chatMessages')).toEqual([{ id: 'm1' }])
    expect(list.props('listState')).toBeUndefined()
  })

  it('resizes from the keyboard through its separator', async () => {
    const panel = await mountPanel()
    const separator = panel.find('[role="separator"]')
    expect(separator.attributes('aria-orientation')).toBe('vertical')
    expect(separator.attributes('aria-valuenow')).toBe('360')
    expect(separator.attributes('aria-valuemin')).toBe('280')
    expect(separator.attributes('aria-valuemax')).toBe('640')
    expect(separator.attributes('tabindex')).toBe('0')

    await separator.trigger('keydown', { key: 'ArrowLeft' })
    expect(separator.attributes('aria-valuenow')).toBe('376')
    await separator.trigger('keydown', { key: 'ArrowRight' })
    await separator.trigger('keydown', { key: 'ArrowRight' })
    expect(separator.attributes('aria-valuenow')).toBe('344')
    await separator.trigger('keydown', { key: 'End' })
    expect(separator.attributes('aria-valuenow')).toBe('640')
    await separator.trigger('keydown', { key: 'Home' })
    expect(separator.attributes('aria-valuenow')).toBe('280')
  })

  it("shows the call chat's own list while the main window shows another chat", async () => {
    h.chat.state.routed = false
    const panel = await mountPanel()
    const list = panel.findComponent({ name: 'UnifiedContentArea' })
    expect(list.props('chatMessages')).toEqual([{ id: 'own-1' }])
    expect(list.props('channelId')).toBe('lounge')
    expect(list.props('serverId')).toBe('s1')
    expect(list.props('listState')).toEqual({ loadingOlder: false, allLoaded: true })
    list.vm.$emit('load-more-messages')
    expect(h.feed.loadOlder).toHaveBeenCalledTimes(1)
  })

  it('takes focus when asked, and closes from its close button', async () => {
    const panel = await mountPanel({ autofocus: true })
    expect(document.activeElement).toBe(panel.find('[data-testid="call-chat-close"]').element)
    await panel.find('[data-testid="call-chat-close"]').trigger('click')
    expect(panel.emitted('close')).toHaveLength(1)
  })
})
