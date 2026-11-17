import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'

const state = vi.hoisted(() => ({ thread: null as any, nativeName: vi.fn(), nativeAvatar: vi.fn(), nativeColor: vi.fn(), scrollStart: vi.fn(), push: vi.fn() }))
vi.mock('vue-i18n', async original => ({ ...await original<typeof import('vue-i18n')>(), useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }) }))
vi.mock('vue-router', async original => ({ ...await original<typeof import('vue-router')>(), useRouter: () => ({ push: state.push, back: vi.fn() }), useRoute: () => ({ query: {}, params: {}, path: '/channels/server/thread' }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'viewer' }) }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ currentServerId: 'server', channels: [{ id: 'channel', name: 'general' }], servers: [] }) }))
vi.mock('@/stores/useChat', () => ({ useChatStore: () => ({ messages: [], addReaction: vi.fn() }) }))
vi.mock('@/composables/useServerPermissions', async () => { const { ref } = await import('vue'); return { useServerPermissions: () => ({ canManageChannels: ref(false) }) } })
vi.mock('@/composables/useInstanceMediaHidden', async () => { const { ref } = await import('vue'); return { useServerMediaHidden: () => ref(false) } })
vi.mock('@/services/RealtimeConnectionManager', () => ({ realtimeConnectionManager: { subscribeBroadcast: () => vi.fn(), hasSubscription: () => false } }))
vi.mock('@/composables/useUserData', async () => {
  const { ref } = await import('vue')
  return { DEFAULT_USER_COLOR: '#fff', useUserData: () => ({
    getUserDisplayName: (id: string) => { state.nativeName(id); return ref('Native name') },
    getUserAvatarUrl: (id: string) => { state.nativeAvatar(id); return ref('/native.png') },
    getUserColor: (id: string) => { state.nativeColor(id); return ref('#fff') },
  }) }
})
vi.mock('@/stores/useThreads', async original => ({
  ...await original<typeof import('@/stores/useThreads')>(),
  useThreadsStore: () => ({ byId: {}, upsert: (thread: any) => thread, remove: vi.fn() }),
}))
vi.mock('@/services/ThreadService', async original => ({
  ...await original<typeof import('@/services/ThreadService')>(),
  threadService: { getCachedMessages: () => ({ messages: [], has_more: false }), getThread: async () => state.thread, getThreadMessages: async () => ({ messages: [], has_more: false }) },
}))

import ThreadView from '../ThreadView.vue'
import ThreadFullView from '@/views/ThreadFullView.vue'
import { useDraftsStore } from '@/stores/drafts'

const Display = defineComponent({ name: 'MessageDisplay', setup(_, { slots, expose }) {
  expose({ scrollToStart: state.scrollStart, scrollToBottom: vi.fn() })
  return () => h('div', { class: 'message-display-slot' }, slots['list-start']?.())
} })
const baseParent = { id: 'parent', channel_id: 'channel', user_id: null, bot_id: null, content: [{ type: 'text', text: 'starter' }], created_at: '2026-11-01T00:00:00Z' }
const parents = [
  { label: 'local Matrix', name: 'Matrix Sam', source: 'matrix', row: { ...baseParent, bot_id: 'relay-bot', metadata: { bridge_author: { platform: 'matrix', id: '@sam:hs', username: 'sam', display_name: 'Matrix Sam' } } } },
  { label: 'federated Matrix', name: 'Remote Sam', source: 'matrix', row: { ...baseParent, metadata: { bridge_source: 'matrix', remote_author: { kind: 'bridge', id: 'matrix:@sam:hs', name: 'Remote Sam', avatar_url: null } } } },
  { label: 'legacy Discord', name: 'Discord Sam', source: 'discord', row: { ...baseParent, bot_id: 'relay-bot', metadata: { discord_user: { id: '123', username: 'sam', display_name: 'Discord Sam' } } } },
]
let wrapper: VueWrapper
beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })
afterEach(() => { wrapper?.unmount(); vi.useRealTimers() })
async function open(kind: 'panel' | 'full', parent: any, draft = false) {
  state.thread = { id: 'thread', channel_id: 'channel', name: 'Plans', parent_message_id: parent.id, parent_message: parent, message_count: 0, is_member: true }
  wrapper = shallowMount(kind === 'panel' ? ThreadView : ThreadFullView, {
    props: kind === 'panel' ? draft ? { isVisible: true, draftParentMessage: parent, channelId: 'channel' } : { isVisible: true, initialThread: state.thread } : { serverId: 'server', threadId: 'thread' },
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key }, directives: { 'click-outside': {} }, stubs: { Teleport: true, Transition: false, MessageDisplay: Display } },
  })
  await flushPromises()
  return wrapper.get('[data-testid="thread-parent-message"]')
}
for (const kind of ['panel', 'full'] as const) describe(`${kind} thread parent list-start`, () => {
  for (const parent of parents) it(`renders ${parent.label} once with a source badge and no backing native profile lookup`, async () => {
    const row = await open(kind, parent.row)
    expect(wrapper.findAll('.parent-message')).toHaveLength(1)
    expect(row.element.closest('.message-display-slot')).not.toBeNull()
    expect(row.text()).toContain(parent.name)
    expect(row.getComponent({ name: 'BridgeSourceBadge' }).props('source')).toBe(parent.source)
    expect(row.getComponent({ name: 'Avatar' }).props('interactive')).toBe(false)
    expect(row.getComponent({ name: 'Avatar' }).props('src')).toBe('/default_avatar.webp')
    expect(row.findComponent({ name: 'DisplayName' }).exists()).toBe(false)
    expect(state.nativeName).not.toHaveBeenCalled()
    expect(state.nativeAvatar).not.toHaveBeenCalled()
    expect(state.nativeColor).not.toHaveBeenCalled()
  })
  it('keeps native parent profile presentation and the upstream draft key', async () => {
    const row = await open(kind, { ...baseParent, user_id: 'native-user' })
    expect(row.getComponent({ name: 'Avatar' }).props('interactive')).toBe(true)
    expect(row.getComponent({ name: 'DisplayName' }).props('userId')).toBe('native-user')
    expect(row.findComponent({ name: 'BridgeSourceBadge' }).exists()).toBe(false)
    expect(wrapper.getComponent({ name: 'MessageInput' }).props('draftKey')).toBe('thread:thread')
  })
  it('keeps go-to-start scrolling, focus and highlighting on the new slot parent', async () => {
    const row = await open(kind, parents[0].row)
    vi.useFakeTimers()
    await wrapper.get(kind === 'panel' ? '[aria-haspopup="menu"]' : '.options-btn').trigger('click')
    await wrapper.get('[data-testid="thread-go-to-start"]').trigger('click')
    expect(state.scrollStart).toHaveBeenCalled()
    expect(document.activeElement).toBe(row.element)
    expect(row.classes()).toContain('highlighted')
    await vi.advanceTimersByTimeAsync(1501)
    expect(row.classes()).not.toContain('highlighted')
  })
})
it('keeps a Matrix draft parent in list-start and restores the upstream starter draft', async () => {
  useDraftsStore().saveDraft('thread:new:parent', 'unsent words')
  const row = await open('panel', parents[0].row, true)
  expect(row.text()).toContain('Matrix Sam')
  expect(wrapper.findAll('.parent-message')).toHaveLength(1)
  expect(wrapper.getComponent({ name: 'MessageInput' }).props()).toMatchObject({ draftKey: 'thread:new:parent', modelValue: 'unsent words' })
})
