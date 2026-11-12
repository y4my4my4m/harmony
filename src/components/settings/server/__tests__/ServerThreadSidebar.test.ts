/**
 * ServerThreadSidebar.vue: three choices (all, joined, follow the instance), written through
 * set_server_thread_sidebar; a save applies the effective mode on this device right away.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import ServerThreadSidebar from '../ServerThreadSidebar.vue'

const { toast, api } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  api: {
    getServerThreadSidebar: vi.fn(),
    setServerThreadSidebar: vi.fn(),
    setCached: vi.fn(),
  },
}))

vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/services/ThreadSidebarService', () => api)

const SERVER_ID = 'server-1'
const warn = vi.fn()

function mountIt() {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en }, missingWarn: true })
  return mount(ServerThreadSidebar, { props: { serverId: SERVER_ID }, global: { plugins: [i18n] } })
}

const radio = (wrapper: ReturnType<typeof mount>, value: string) =>
  wrapper.find(`input[type="radio"][value="${value}"]`)
const checked = (wrapper: ReturnType<typeof mount>, value: string) =>
  (radio(wrapper, value).element as HTMLInputElement).checked

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(warn)
})

describe('ServerThreadSidebar', () => {
  it('offers three choices and names the instance default mode', async () => {
    api.getServerThreadSidebar.mockResolvedValue({ mode: 'joined', server_value: null, instance_default: 'joined' })
    const wrapper = mountIt()
    await flushPromises()

    expect(api.getServerThreadSidebar).toHaveBeenCalledWith(SERVER_ID)
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(3)
    expect(wrapper.text()).toContain('All active threads')
    expect(wrapper.text()).toContain('Joined threads only')
    expect(wrapper.text()).toContain('Instance default (Joined threads only)')
    expect(checked(wrapper, 'instance')).toBe(true)
  })

  it('returns the server to the instance default', async () => {
    api.getServerThreadSidebar.mockResolvedValue({ mode: 'all', server_value: 'all', instance_default: 'joined' })
    api.setServerThreadSidebar.mockResolvedValue({ mode: 'joined', server_value: null, instance_default: 'joined' })
    const wrapper = mountIt()
    await flushPromises()
    expect(checked(wrapper, 'all')).toBe(true)

    await radio(wrapper, 'instance').setValue(true)
    await flushPromises()
    expect(api.setServerThreadSidebar).toHaveBeenCalledWith(SERVER_ID, null)
    expect(api.setCached).toHaveBeenCalledWith(SERVER_ID, 'joined')
    expect(checked(wrapper, 'instance')).toBe(true)
  })

  it('saves joined only and updates the cache', async () => {
    api.getServerThreadSidebar.mockResolvedValue({ mode: 'all', server_value: null, instance_default: 'all' })
    api.setServerThreadSidebar.mockResolvedValue({ mode: 'joined', server_value: 'joined', instance_default: 'all' })
    const wrapper = mountIt()
    await flushPromises()

    await radio(wrapper, 'joined').setValue(true)
    await flushPromises()
    expect(api.setServerThreadSidebar).toHaveBeenCalledWith(SERVER_ID, 'joined')
    expect(api.setCached).toHaveBeenCalledWith(SERVER_ID, 'joined')
    expect(checked(wrapper, 'joined')).toBe(true)
  })

  it('restores the saved choice and reports a failed save', async () => {
    api.getServerThreadSidebar.mockResolvedValue({ mode: 'all', server_value: 'all', instance_default: 'all' })
    api.setServerThreadSidebar.mockRejectedValueOnce(new Error('Missing permission: MANAGE_SERVER'))
    const wrapper = mountIt()
    await flushPromises()

    await radio(wrapper, 'joined').setValue(true)
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the thread setting")
    expect(api.setCached).not.toHaveBeenCalled()
    expect(checked(wrapper, 'all')).toBe(true)
    expect(checked(wrapper, 'joined')).toBe(false)
  })

  it('keeps the focused radio in place after a failed save', async () => {
    api.getServerThreadSidebar.mockResolvedValue({ mode: 'all', server_value: 'all', instance_default: 'all' })
    api.setServerThreadSidebar.mockRejectedValueOnce(new Error('nope'))
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
    const wrapper = mount(ServerThreadSidebar, {
      props: { serverId: SERVER_ID },
      global: { plugins: [i18n] },
      attachTo: document.body,
    })
    await flushPromises()

    const joined = radio(wrapper, 'joined').element as HTMLInputElement
    joined.focus()
    await radio(wrapper, 'joined').setValue(true)
    await flushPromises()
    expect(checked(wrapper, 'all')).toBe(true)
    expect(document.activeElement).toBe(joined)
    expect(wrapper.find('fieldset').element.contains(document.activeElement)).toBe(true)
    wrapper.unmount()
  })

  it('discards a save that resolves after the server changed', async () => {
    api.getServerThreadSidebar.mockResolvedValue({ mode: 'all', server_value: 'all', instance_default: 'all' })
    let finish!: (value: unknown) => void
    api.setServerThreadSidebar.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const wrapper = mountIt()
    await flushPromises()

    await radio(wrapper, 'joined').setValue(true)
    api.getServerThreadSidebar.mockResolvedValue({ mode: 'all', server_value: null, instance_default: 'all' })
    await wrapper.setProps({ serverId: 'server-2' })
    await flushPromises()
    finish({ mode: 'joined', server_value: 'joined', instance_default: 'all' })
    await flushPromises()

    expect(api.setCached).not.toHaveBeenCalledWith('server-2', expect.anything())
    expect(checked(wrapper, 'instance')).toBe(true)
  })

  it('renders nothing and makes no lookup for a remote server', async () => {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
    const wrapper = mount(ServerThreadSidebar, {
      props: { serverId: SERVER_ID, isLocalServer: false },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="thread-sidebar"]').exists()).toBe(false)
    expect(api.getServerThreadSidebar).not.toHaveBeenCalled()
  })

  it('uses no missing i18n keys', async () => {
    api.getServerThreadSidebar.mockResolvedValue({ mode: 'all', server_value: null, instance_default: 'joined' })
    mountIt()
    await flushPromises()

    const missing = warn.mock.calls.filter(call => String(call[0]).includes('Not found'))
    expect(missing).toEqual([])
  })
})
