import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import en from '@/locales/en.json'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/supabase', () => ({ supabase: { rpc } }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ servers: [{ id: 'server', name: 'Club' }] }) }))
vi.mock('@/stores/useProfile', async () => {
  const { reactive } = await import('vue')
  const profile = reactive({ profileId: 'member' })
  return { useProfileStore: () => profile }
})
vi.mock('vue-i18n', async original => ({ ...await original<typeof import('vue-i18n')>(), useI18n: () => ({
  t: (key: string) => key.split('.').reduce((value: any, part) => value?.[part], en) || key, locale: ref('en'),
}) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn() }) }))

import BridgePrivacyModal from '@/components/BridgePrivacyModal.vue'
import { useBridgePrivacyStore } from '@/stores/useBridgePrivacy'
import { useProfileStore } from '@/stores/useProfile'

let wrapper: VueWrapper
beforeEach(() => {
  setActivePinia(createPinia())
  rpc.mockReset()
  useProfileStore().profileId = 'member'
  wrapper = mount(BridgePrivacyModal, { attachTo: document.body, global: { stubs: { Teleport: true, LoadingSpinner: true } } })
})
afterEach(() => wrapper.unmount())

describe('member bridge privacy', () => {
  it('loads self state and saves through the self-only RPC, with explicit limited scope', async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null })
    const store = useBridgePrivacyStore()
    await store.open('server')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('get_server_bridge_opt_out', { p_server_id: 'server' })
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('false')
    expect(wrapper.text()).toContain('future messages')
    expect(wrapper.text()).toContain('does not remove existing remote copies')
    expect(wrapper.text()).toContain('other bots')
    rpc.mockResolvedValueOnce({ data: true, error: null })
    await wrapper.get('[role="switch"]').trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenLastCalledWith('set_server_bridge_opt_out', { p_server_id: 'server', p_opt_out: true })
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[role="switch"]').attributes('aria-labelledby')).toBe('bridge-privacy-label')
  })

  it('does not assume bridging is allowed when loading fails or returns an invalid boolean', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null })
    await useBridgePrivacyStore().open('server')
    await flushPromises()
    expect(wrapper.find('[role="switch"]').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not load')
    rpc.mockResolvedValueOnce({ data: true, error: null })
    await wrapper.get('button.btn').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('true')
  })

  it('keeps the last confirmed choice if saving fails, without exposing exception text', async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null })
    const store = useBridgePrivacyStore()
    await store.open('server')
    rpc.mockRejectedValueOnce(new Error('private credentials'))
    await store.setOptOut(false)
    await flushPromises()
    expect(store.optOut).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not confirm the change')
    expect(wrapper.get('[role="switch"]').attributes('aria-disabled')).toBe('true')
    expect(wrapper.get('button.btn').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('private credentials')
  })

  it('discards pending state when the signed-in member changes', async () => {
    let finish!: (value: unknown) => void
    rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const store = useBridgePrivacyStore()
    const pending = store.open('server')
    useProfileStore().profileId = 'another-member'
    await flushPromises()
    finish({ data: true, error: null })
    await pending
    expect(store.serverId).toBeNull()
    expect(store.optOut).toBeNull()
  })

  it('disables a pending save and ignores late responses after closing/reopening', async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null })
    const store = useBridgePrivacyStore()
    await store.open('server')
    let finish!: (value: unknown) => void
    rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const saving = store.setOptOut(true)
    await flushPromises()
    expect(wrapper.get('[role="switch"]').attributes('aria-disabled')).toBe('true')
    store.close()
    rpc.mockResolvedValueOnce({ data: false, error: null })
    await store.open('another-server')
    finish({ data: true, error: null })
    await saving
    expect(store.serverId).toBe('another-server')
    expect(store.optOut).toBe(false)
  })
})
