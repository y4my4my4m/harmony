/**
 * ThreadSidebarDefault.vue: shows the instance default for which threads the sidebar lists and
 * writes it through setInstanceThreadSidebarDefault.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import ThreadSidebarDefault from '../ThreadSidebarDefault.vue'

const { toast, api } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  api: {
    getInstanceThreadSidebarDefault: vi.fn(),
    setInstanceThreadSidebarDefault: vi.fn(),
  },
}))

vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/services/ThreadSidebarService', () => api)

const warn = vi.fn()

function mountIt() {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en }, missingWarn: true, warnHtmlMessage: false })
  return mount(ThreadSidebarDefault, { global: { plugins: [i18n] } })
}

const radio = (wrapper: ReturnType<typeof mount>, value: string) =>
  wrapper.find(`input[type="radio"][value="${value}"]`)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(warn)
})

describe('ThreadSidebarDefault', () => {
  it('shows the current instance default', async () => {
    api.getInstanceThreadSidebarDefault.mockResolvedValue('joined')
    const wrapper = mountIt()
    await flushPromises()

    expect((radio(wrapper, 'joined').element as HTMLInputElement).checked).toBe(true)
    expect((radio(wrapper, 'all').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('Threads in the sidebar')
    expect(wrapper.text()).toContain('Joined threads only')
  })

  it('saves the chosen mode', async () => {
    api.getInstanceThreadSidebarDefault.mockResolvedValue('all')
    api.setInstanceThreadSidebarDefault.mockResolvedValue(undefined)
    const wrapper = mountIt()
    await flushPromises()

    await radio(wrapper, 'joined').setValue(true)
    await flushPromises()
    expect(api.setInstanceThreadSidebarDefault).toHaveBeenCalledWith('joined')
    expect((radio(wrapper, 'joined').element as HTMLInputElement).checked).toBe(true)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('restores the previous choice and reports a failed save', async () => {
    api.getInstanceThreadSidebarDefault.mockResolvedValue('all')
    api.setInstanceThreadSidebarDefault.mockRejectedValueOnce(new Error('not an instance admin'))
    const wrapper = mountIt()
    await flushPromises()

    await radio(wrapper, 'joined').setValue(true)
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the thread setting")
    expect((radio(wrapper, 'all').element as HTMLInputElement).checked).toBe(true)
    expect((radio(wrapper, 'joined').element as HTMLInputElement).checked).toBe(false)
  })

  it('uses no missing i18n keys', async () => {
    api.getInstanceThreadSidebarDefault.mockResolvedValue('all')
    mountIt()
    await flushPromises()

    const missing = warn.mock.calls.filter(call => String(call[0]).includes('Not found'))
    expect(missing).toEqual([])
  })
})
