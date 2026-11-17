/** BridgePrivacyModal.vue and useBridgePrivacy: Server menu → Bridge privacy, the member's own relay preference. */
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
const translate = (key: string, params?: Record<string, string>) => {
  const text: string = key.split('.').reduce((value: any, part) => value?.[part], en) || key
  return text.replace(/\{(\w+)\}/g, (_, name) => params?.[name] ?? `{${name}}`)
}
vi.mock('vue-i18n', async original => ({ ...await original<typeof import('vue-i18n')>(), useI18n: () => ({ t: translate, locale: ref('en') }) }))

import BridgePrivacyModal from '@/components/BridgePrivacyModal.vue'
import { useBridgePrivacyStore } from '@/stores/useBridgePrivacy'
import { useProfileStore } from '@/stores/useProfile'

type Flags = { bridged: boolean; opted_out: boolean }
const flags = (bridged: boolean, opted_out = false): Flags => ({ bridged, opted_out })
const state = (discord: Flags, matrix: Flags) => ({ data: { discord, matrix }, error: null })
const switches = () => wrapper.findAll('[role="switch"]')

let wrapper: VueWrapper
beforeEach(() => {
  setActivePinia(createPinia())
  rpc.mockReset()
  useProfileStore().profileId = 'member'
  wrapper = mount(BridgePrivacyModal, { attachTo: document.body, global: { stubs: { Teleport: true, LoadingSpinner: true } } })
})
afterEach(() => wrapper.unmount())

describe('member bridge privacy', () => {
  it('reads the member state afresh and saves each bridged platform on its own', async () => {
    rpc.mockResolvedValueOnce(state(flags(true), flags(true, true)))
    const store = useBridgePrivacyStore()
    await store.open('server')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('bridge_member_privacy', { p_server_id: 'server' })
    expect(switches().map(s => s.attributes('aria-checked'))).toEqual(['false', 'true'])
    expect(wrapper.text()).toContain('Do not forward my messages to Discord')
    expect(wrapper.text()).toContain('Do not forward my messages to Matrix')
    expect(wrapper.text()).toContain('future messages')
    expect(wrapper.text()).toContain('does not remove existing remote copies')

    rpc.mockResolvedValueOnce(state(flags(true, true), flags(true, true)))
    await switches()[0].trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenLastCalledWith('set_bridge_member_optout', { p_server_id: 'server', p_platform: 'discord', p_opted_out: true })
    expect(store.privacy).toEqual({ discord: flags(true, true), matrix: flags(true, true) })
    const label = switches()[0].attributes('aria-labelledby')!
    expect(wrapper.get(`#${label}`).text()).toBe('Do not forward my messages to Discord')

    rpc.mockResolvedValueOnce(state(flags(true, true), flags(true, false)))
    await switches()[1].trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenLastCalledWith('set_bridge_member_optout', { p_server_id: 'server', p_platform: 'matrix', p_opted_out: false })
    expect(store.privacy?.matrix).toEqual(flags(true, false))
    expect(store.hasBridge('server')).toBe(true)
  })

  it.each([
    ['Discord', flags(true), flags(false, true), ['discord']],
    ['Matrix', flags(false), flags(true), ['matrix']],
  ])('offers a switch for %s alone when only it bridges the server', async (_name, discord, matrix, shown) => {
    rpc.mockResolvedValueOnce(state(discord, matrix))
    await useBridgePrivacyStore().open('server')
    await flushPromises()
    expect(wrapper.findAll('.privacy-row').map(row => row.attributes('data-platform'))).toEqual(shown)
    expect(switches()).toHaveLength(1)
  })

  it('says so when no bridge relays the server any more', async () => {
    rpc.mockResolvedValueOnce(state(flags(false, true), flags(false)))
    const store = useBridgePrivacyStore()
    await store.open('server')
    await flushPromises()
    expect(switches()).toHaveLength(0)
    expect(wrapper.get('[data-testid="bridge-privacy-none"]').text()).toBe(en.bridgePrivacy.none)
    expect(store.hasBridge('server')).toBe(false)
  })

  it.each([
    null,
    false,
    { discord: false, matrix: false },
    { discord: { bridged: true, opted_out: false } },
    { discord: { bridged: true, opted_out: false }, matrix: { bridged: 'yes', opted_out: false } },
    { discord: { bridged: true }, matrix: { bridged: false, opted_out: false } },
  ])('does not assume bridging is allowed for invalid state %j', async data => {
    rpc.mockResolvedValueOnce({ data, error: null })
    await useBridgePrivacyStore().open('server')
    await flushPromises()
    expect(switches()).toHaveLength(0)
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not load')
    rpc.mockResolvedValueOnce(state(flags(true, true), flags(false)))
    await wrapper.get('button.btn').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('true')
  })

  it('keeps the last confirmed choice if saving fails, without exposing exception text', async () => {
    rpc.mockResolvedValueOnce(state(flags(true, true), flags(true)))
    const store = useBridgePrivacyStore()
    await store.open('server')
    rpc.mockRejectedValueOnce(new Error('private credentials'))
    await store.setOptOut('discord', false)
    await flushPromises()
    expect(store.privacy).toEqual({ discord: flags(true, true), matrix: flags(true) })
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not confirm the change')
    expect(switches().every(s => s.attributes('aria-disabled') === 'true')).toBe(true)
    expect(wrapper.get('button.btn').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('private credentials')
  })

  it('refuses to save a platform the server does not bridge', async () => {
    rpc.mockResolvedValueOnce(state(flags(true), flags(false)))
    const store = useBridgePrivacyStore()
    await store.open('server')
    rpc.mockClear()
    await store.setOptOut('matrix', true)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('discards pending state and the menu cache when the signed-in member changes', async () => {
    const store = useBridgePrivacyStore()
    rpc.mockResolvedValueOnce(state(flags(true), flags(false)))
    await store.prefetch('other-server')
    expect(store.hasBridge('other-server')).toBe(true)

    let finish!: (value: unknown) => void
    rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = store.open('server')
    useProfileStore().profileId = 'another-member'
    await flushPromises()
    finish(state(flags(true, true), flags(true, true)))
    await pending
    expect(store.serverId).toBeNull()
    expect(store.privacy).toBeNull()
    expect(store.hasBridge('other-server')).toBe(false)
    expect(store.hasBridge('server')).toBe(false)
  })

  it('disables a pending save and ignores late responses after closing/reopening', async () => {
    rpc.mockResolvedValueOnce(state(flags(true), flags(true)))
    const store = useBridgePrivacyStore()
    await store.open('server')
    let finish!: (value: unknown) => void
    rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const saving = store.setOptOut('matrix', true)
    await flushPromises()
    expect(wrapper.get('[role="switch"]').attributes('aria-disabled')).toBe('true')
    store.close()
    rpc.mockResolvedValueOnce(state(flags(true), flags(false)))
    await store.open('another-server')
    finish(state(flags(true), flags(true, true)))
    await saving
    expect(store.serverId).toBe('another-server')
    expect(store.privacy).toEqual({ discord: flags(true), matrix: flags(false) })
  })
})

describe('bridge privacy menu cache', () => {
  it('reads a server once for every menu; a failed read offers no entry', async () => {
    const store = useBridgePrivacyStore()
    rpc.mockResolvedValueOnce(state(flags(false), flags(true)))
    await Promise.all([store.prefetch('server'), store.prefetch('server')])
    await store.prefetch('server')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(store.hasBridge('server')).toBe(true)

    rpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } })
    await store.prefetch('quiet-server')
    expect(store.hasBridge('quiet-server')).toBe(false)
  })
})
