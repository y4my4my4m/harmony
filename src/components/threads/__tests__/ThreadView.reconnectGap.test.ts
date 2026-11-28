import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'

// A reply sent while the thread topic was down reaches the open thread once the topic is back.

const state = vi.hoisted(() => ({
  thread: null as any,
  subscriptions: [] as Array<{ channelName: string; onReconnected?: () => unknown; broadcasts: any[] }>,
  reads: [] as Array<Record<string, unknown>>,
  page: { messages: [] as any[], has_more: false },
}))
vi.mock('vue-i18n', async original => ({ ...await original<typeof import('vue-i18n')>(), useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }) }))
vi.mock('vue-router', async original => ({ ...await original<typeof import('vue-router')>(), useRouter: () => ({ push: vi.fn(), back: vi.fn() }), useRoute: () => ({ query: {}, params: {}, path: '/channels/server/thread' }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'viewer' }) }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ currentServerId: 'server', channels: [{ id: 'channel', name: 'general' }], servers: [] }) }))
vi.mock('@/stores/useChat', () => ({ useChatStore: () => ({ messages: [], addReaction: vi.fn() }) }))
vi.mock('@/composables/useServerPermissions', async () => { const { ref } = await import('vue'); return { useServerPermissions: () => ({ canManageChannels: ref(false) }) } })
vi.mock('@/composables/useInstanceMediaHidden', async () => { const { ref } = await import('vue'); return { useServerMediaHidden: () => ref(false) } })
vi.mock('@/services/RealtimeConnectionManager', () => ({
  realtimeConnectionManager: {
    subscribeBroadcast: (config: any) => { state.subscriptions.push(config); return vi.fn() },
    hasSubscription: () => false,
  },
}))
vi.mock('@/composables/useUserData', async () => {
  const { ref } = await import('vue')
  return { DEFAULT_USER_COLOR: '#fff', useUserData: () => ({ getUserDisplayName: () => ref('Name'), getUserAvatarUrl: () => ref('/a.png'), getUserColor: () => ref('#fff') }) }
})
vi.mock('@/stores/useThreads', async original => ({
  ...await original<typeof import('@/stores/useThreads')>(),
  useThreadsStore: () => ({ byId: {}, upsert: (thread: any) => thread, remove: vi.fn() }),
}))
vi.mock('@/services/ThreadService', async original => ({
  ...await original<typeof import('@/services/ThreadService')>(),
  threadService: {
    getCachedMessages: () => null,
    getThread: async () => state.thread,
    getThreadMessages: async (_id: string, options: Record<string, unknown> = {}) => {
      state.reads.push(options)
      return state.page
    },
    addMessageToCache: vi.fn(),
  },
}))

import ThreadView from '../ThreadView.vue'
import ThreadFullView from '@/views/ThreadFullView.vue'

const shown: { messages: any[] } = { messages: [] }
const Display = defineComponent({
  name: 'MessageDisplay',
  props: { messages: { type: Array, default: () => [] } },
  setup(props, { expose }) {
    expose({ scrollToStart: vi.fn(), scrollToBottom: vi.fn() })
    return () => { shown.messages = props.messages as any[]; return h('div') }
  },
})

const reply = (id: string, at: string) => ({
  id, thread_id: 'thread', channel_id: 'channel', user_id: 'author', content: [{ type: 'text', text: id }], created_at: at,
})
const ids = () => shown.messages.map((m) => m.id)

let wrapper: VueWrapper
beforeEach(() => {
  setActivePinia(createPinia())
  state.subscriptions.length = 0
  state.reads.length = 0
  shown.messages = []
})
afterEach(() => { wrapper?.unmount() })

async function open(kind: 'panel' | 'full') {
  state.thread = { id: 'thread', channel_id: 'channel', name: 'Plans', parent_message_id: 'parent', parent_message: { id: 'parent', channel_id: 'channel', user_id: 'author', content: [], created_at: '2026-11-01T00:00:00Z' }, message_count: 1, is_member: true }
  state.page = { messages: [reply('r1', '2026-11-01T00:01:00.000123+00:00')], has_more: false }
  wrapper = shallowMount(kind === 'panel' ? ThreadView : ThreadFullView, {
    props: kind === 'panel' ? { isVisible: true, initialThread: state.thread } : { serverId: 'server', threadId: 'thread' },
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key }, directives: { 'click-outside': {} }, stubs: { Teleport: true, Transition: false, MessageDisplay: Display } },
  })
  await flushPromises()
  const topic = state.subscriptions.filter((s) => s.channelName === 'thread-messages-thread').at(-1)
  expect(topic).toBeDefined()
  return topic!
}

for (const kind of ['panel', 'full'] as const) describe(`${kind} thread after a Realtime gap`, () => {
  it('reads the replies newer than the last one shown and adds them', async () => {
    const topic = await open(kind)
    expect(ids()).toEqual(['r1'])
    expect(topic.onReconnected).toBeTypeOf('function')

    state.reads.length = 0
    state.page = { messages: [reply('r1', '2026-11-01T00:01:00.000123+00:00'), reply('r2', '2026-11-01T00:02:00Z')], has_more: false }
    await topic.onReconnected!()
    await flushPromises()
    expect(state.reads).toEqual([{ after: '2026-11-01T00:01:00.000123+00:00' }])
    expect(ids()).toEqual(['r1', 'r2'])
  })

  it('shows the newest page in place of the list when more replies were missed than a page holds', async () => {
    const topic = await open(kind)
    const page = Array.from({ length: 50 }, (_, i) => reply(`n${i}`, new Date(Date.UTC(2026, 10, 2, 0, i)).toISOString()))
    state.page = { messages: page, has_more: true }
    await topic.onReconnected!()
    await flushPromises()
    expect(ids()).toEqual(page.map((m) => m.id))
  })
})
