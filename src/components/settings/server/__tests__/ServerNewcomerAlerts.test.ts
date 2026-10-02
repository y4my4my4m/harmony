/**
 * ServerNewcomerAlerts.vue: shows the effective switch, writes through set_server_newcomer_alerts,
 * and offers the instance default once the server has its own choice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ServerNewcomerAlerts from '../ServerNewcomerAlerts.vue'

const { toast, api } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  api: {
    getServerNewcomerAlerts: vi.fn(),
    setServerNewcomerAlerts: vi.fn(),
  },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/services/NewcomerAlertService', () => api)

const SERVER_ID = 'server-1'

const toggle = (wrapper: ReturnType<typeof mount>) => wrapper.find('[role="switch"]')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ServerNewcomerAlerts', () => {
  it('shows the instance default for a server that has not chosen', async () => {
    api.getServerNewcomerAlerts.mockResolvedValue({ enabled: true, server_value: null, instance_default: true })
    const wrapper = mount(ServerNewcomerAlerts, { props: { serverId: SERVER_ID } })
    await flushPromises()

    expect(api.getServerNewcomerAlerts).toHaveBeenCalledWith(SERVER_ID)
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true')
    expect(wrapper.text()).toContain('newcomerAlerts.server.followsDefault')
    expect(wrapper.find('.link-btn').exists()).toBe(false)
  })

  it('turns alerts off for the server and then offers the instance default', async () => {
    api.getServerNewcomerAlerts.mockResolvedValue({ enabled: true, server_value: null, instance_default: true })
    api.setServerNewcomerAlerts.mockResolvedValueOnce({ enabled: false, server_value: false, instance_default: true })
    const wrapper = mount(ServerNewcomerAlerts, { props: { serverId: SERVER_ID } })
    await flushPromises()

    await toggle(wrapper).trigger('click')
    await flushPromises()
    expect(api.setServerNewcomerAlerts).toHaveBeenCalledWith(SERVER_ID, false)
    expect(toggle(wrapper).attributes('aria-checked')).toBe('false')

    api.setServerNewcomerAlerts.mockResolvedValueOnce({ enabled: true, server_value: null, instance_default: true })
    await wrapper.find('.link-btn').trigger('click')
    await flushPromises()
    expect(api.setServerNewcomerAlerts).toHaveBeenLastCalledWith(SERVER_ID, null)
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true')
  })

  it('keeps the shown state and reports a failed save', async () => {
    api.getServerNewcomerAlerts.mockResolvedValue({ enabled: true, server_value: true, instance_default: false })
    api.setServerNewcomerAlerts.mockRejectedValueOnce(new Error('Missing permission: MANAGE_SERVER'))
    const wrapper = mount(ServerNewcomerAlerts, { props: { serverId: SERVER_ID } })
    await flushPromises()

    await toggle(wrapper).trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('newcomerAlerts.server.saveFailed')
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true')
  })

  it('disables the switch when the setting cannot be read', async () => {
    api.getServerNewcomerAlerts.mockRejectedValue(new Error('Missing permission: MANAGE_SERVER'))
    const wrapper = mount(ServerNewcomerAlerts, { props: { serverId: SERVER_ID } })
    await flushPromises()

    expect(wrapper.find('[role="alert"]').text()).toBe('newcomerAlerts.server.loadFailed')
    expect(toggle(wrapper).attributes('aria-disabled')).toBe('true')
    await toggle(wrapper).trigger('click')
    expect(api.setServerNewcomerAlerts).not.toHaveBeenCalled()
  })
})
