/**
 * The threads list names a thread's creator by their nickname in this server.
 */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({ canCreateThreads: ref(false) }),
}))
vi.mock('@/composables/useMemberProfile', () => ({
  getMemberDisplayName: (_id: string, serverId: string | null) => ref(serverId ? 'Nick' : 'Account'),
  getMemberAvatarUrl: () => ref(''),
}))
vi.mock('@/stores/useThreads', () => ({
  useThreadsStore: () => ({
    channelThreads: () => [{ id: 't1', name: 'topic', created_by: 'u1', created_at: new Date().toISOString(), message_count: 1 }],
    loadChannelThreads: vi.fn(async () => {}),
    upsert: vi.fn(),
  }),
  isOptimisticThreadId: () => false,
}))
vi.mock('@/services/ThreadService', () => ({ threadService: { createChannelThread: vi.fn(), getThread: vi.fn() } }))

import AllThreadsModal from '../AllThreadsModal.vue'

describe('AllThreadsModal server profiles', () => {
  it('passes its server to the creator name and resolves the nickname fallback', async () => {
    const wrapper = mount(AllThreadsModal, {
      props: { isVisible: true, channelId: 'c1', serverId: 's1' },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: { teleport: true, transition: false, Icon: true, Avatar: true, DisplayName: true, LoadingSpinner: true },
      },
    })
    await flushPromises()
    const name = wrapper.findComponent({ name: 'DisplayName' })
    expect(name.exists()).toBe(true)
    expect(name.props('serverId')).toBe('s1')
    expect(name.props('fallback')).toBe('Nick')
  })
})
