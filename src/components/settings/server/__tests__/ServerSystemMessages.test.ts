/**
 * ServerSystemMessages.vue: shows the stored switch and channel, writes both through
 * set_server_system_channel, and keeps the shown state when a save is refused.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ServerSystemMessages from '../ServerSystemMessages.vue'

const { toast, api } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  api: {
    getSystemMessageSettings: vi.fn(),
    getSystemChannelChoices: vi.fn(),
    setServerSystemChannel: vi.fn(),
  },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/services/permissionsService', () => api)

const SERVER_ID = 'server-1'
const CHANNELS = [
  { id: 'c-general', name: 'general' },
  { id: 'c-welcome', name: 'welcome' },
]

const toggle = (wrapper: ReturnType<typeof mount>) => wrapper.find('[role="switch"]')
const select = (wrapper: ReturnType<typeof mount>) => wrapper.find('select')

beforeEach(() => {
  vi.clearAllMocks()
  api.getSystemChannelChoices.mockResolvedValue(CHANNELS)
})

describe('ServerSystemMessages', () => {
  it('shows the automatic channel for a server that has not chosen', async () => {
    api.getSystemMessageSettings.mockResolvedValue({ system_channel_id: null, system_messages_enabled: true })
    const wrapper = mount(ServerSystemMessages, { props: { serverId: SERVER_ID } })
    await flushPromises()

    expect(api.getSystemMessageSettings).toHaveBeenCalledWith(SERVER_ID)
    expect(api.getSystemChannelChoices).toHaveBeenCalledWith(SERVER_ID)
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true')
    const options = select(wrapper).findAll('option')
    expect(options.map(o => o.attributes('value'))).toEqual(['', 'c-general', 'c-welcome'])
    expect(options[0].text()).toBe('systemMessages.server.automatic')
    expect((select(wrapper).element as HTMLSelectElement).value).toBe('')
  })

  it('saves a chosen channel and turning messages off', async () => {
    api.getSystemMessageSettings.mockResolvedValue({ system_channel_id: null, system_messages_enabled: true })
    api.setServerSystemChannel.mockResolvedValueOnce({ system_channel_id: 'c-welcome', system_messages_enabled: true })
    const wrapper = mount(ServerSystemMessages, { props: { serverId: SERVER_ID } })
    await flushPromises()

    await select(wrapper).setValue('c-welcome')
    await flushPromises()
    expect(api.setServerSystemChannel).toHaveBeenCalledWith(SERVER_ID, 'c-welcome', true)
    expect((select(wrapper).element as HTMLSelectElement).value).toBe('c-welcome')

    api.setServerSystemChannel.mockResolvedValueOnce({ system_channel_id: 'c-welcome', system_messages_enabled: false })
    await toggle(wrapper).trigger('click')
    await flushPromises()
    expect(api.setServerSystemChannel).toHaveBeenLastCalledWith(SERVER_ID, 'c-welcome', false)
    expect(toggle(wrapper).attributes('aria-checked')).toBe('false')
    expect(select(wrapper).attributes('disabled')).toBeDefined()
  })

  it('keeps the shown channel and reports a refused save', async () => {
    api.getSystemMessageSettings.mockResolvedValue({ system_channel_id: 'c-general', system_messages_enabled: true })
    api.setServerSystemChannel.mockRejectedValueOnce(new Error('Missing permission: MANAGE_SERVER'))
    const wrapper = mount(ServerSystemMessages, { props: { serverId: SERVER_ID } })
    await flushPromises()

    await select(wrapper).setValue('')
    await flushPromises()
    expect(api.setServerSystemChannel).toHaveBeenCalledWith(SERVER_ID, null, true)
    expect(toast.error).toHaveBeenCalledWith('systemMessages.server.saveFailed')
    expect((select(wrapper).element as HTMLSelectElement).value).toBe('c-general')
  })

  it('lists a stored channel the caller cannot see', async () => {
    api.getSystemMessageSettings.mockResolvedValue({ system_channel_id: 'c-hidden', system_messages_enabled: true })
    const wrapper = mount(ServerSystemMessages, { props: { serverId: SERVER_ID } })
    await flushPromises()

    const hidden = select(wrapper).find('option[value="c-hidden"]')
    expect(hidden.text()).toBe('systemMessages.server.unavailableChannel')
    expect((select(wrapper).element as HTMLSelectElement).value).toBe('c-hidden')
  })

  it('disables the controls when the settings cannot be read', async () => {
    api.getSystemMessageSettings.mockRejectedValue(new Error('permission denied'))
    const wrapper = mount(ServerSystemMessages, { props: { serverId: SERVER_ID } })
    await flushPromises()

    expect(wrapper.find('[role="alert"]').text()).toBe('systemMessages.server.loadFailed')
    expect(toggle(wrapper).attributes('aria-disabled')).toBe('true')
    expect(select(wrapper).attributes('disabled')).toBeDefined()
    await toggle(wrapper).trigger('click')
    expect(api.setServerSystemChannel).not.toHaveBeenCalled()
  })
})
