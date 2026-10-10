/**
 * "New thread" in the threads modal: shown with the permission, creates a
 * standalone thread through create_channel_thread and opens it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

const state = vi.hoisted(() => ({
  canCreate: true,
  createChannelThread: vi.fn(),
  getThread: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({ canCreateThreads: ref(state.canCreate) }),
}))
vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({ getUserDisplayName: () => ref(''), getUserAvatarUrl: () => ref('') }),
}))
vi.mock('@/stores/useThreads', () => ({
  useThreadsStore: () => ({
    channelThreads: () => [],
    loadChannelThreads: vi.fn(async () => {}),
    upsert: state.upsert,
  }),
  isOptimisticThreadId: () => false,
}))
vi.mock('@/services/ThreadService', () => ({
  threadService: { createChannelThread: state.createChannelThread, getThread: state.getThread },
}))

import AllThreadsModal from '../AllThreadsModal.vue'

const mountModal = () => mount(AllThreadsModal, {
  props: { isVisible: true, channelId: 'c1', serverId: 's1' },
  global: {
    mocks: { $t: (key: string) => key },
    stubs: { teleport: true, transition: false, Icon: true, Avatar: true, DisplayName: true, LoadingSpinner: true },
  },
})

beforeEach(() => {
  state.canCreate = true
  state.createChannelThread.mockReset()
  state.getThread.mockReset()
  state.upsert.mockReset()
})

describe('AllThreadsModal New thread', () => {
  it('is hidden without permission to create threads', () => {
    state.canCreate = false
    const wrapper = mountModal()
    expect(wrapper.find('.new-thread-btn').exists()).toBe(false)
  })

  it('creates a standalone thread and opens it', async () => {
    const thread = { id: 't1', name: 'Plans', channel_id: 'c1' }
    state.createChannelThread.mockResolvedValue('t1')
    state.getThread.mockResolvedValue(thread)
    const wrapper = mountModal()

    await wrapper.find('.new-thread-btn').trigger('click')
    await wrapper.find('#new-thread-name').setValue('  Plans  ')
    await wrapper.find('.new-thread-form').trigger('submit')
    await flushPromises()

    expect(state.createChannelThread).toHaveBeenCalledWith('c1', 'Plans')
    expect(state.getThread).toHaveBeenCalledWith('t1', true)
    expect(state.upsert).toHaveBeenCalledWith(thread)
    expect(wrapper.emitted('select-thread')?.[0]).toEqual([thread])
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('keeps the form open with an error when creation fails', async () => {
    state.createChannelThread.mockRejectedValue(new Error('nope'))
    const wrapper = mountModal()

    await wrapper.find('.new-thread-btn').trigger('click')
    await wrapper.find('#new-thread-name').setValue('Plans')
    await wrapper.find('.new-thread-form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.new-thread-error').text()).toBe('threadCreate.failed')
    expect(wrapper.emitted('select-thread')).toBeUndefined()
  })

  it('does not submit a blank name', async () => {
    const wrapper = mountModal()
    await wrapper.find('.new-thread-btn').trigger('click')
    await wrapper.find('#new-thread-name').setValue('   ')
    await wrapper.find('.new-thread-form').trigger('submit')
    await flushPromises()
    expect(state.createChannelThread).not.toHaveBeenCalled()
  })
})
