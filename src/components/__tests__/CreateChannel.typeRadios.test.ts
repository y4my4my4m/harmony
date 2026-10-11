/**
 * Create channel: the channel type is a native radio group in a fieldset
 * named by its legend; each radio is named by its title and described by its
 * description, and the checked one decides the created type.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const rpc = vi.hoisted(() => vi.fn(async () => ({ data: { id: 'ch1' }, error: null })))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/supabase', () => {
  const head = { eq: async () => ({ count: 0, error: null }) }
  return { supabase: { rpc, from: () => ({ select: () => head }) } }
})
vi.mock('@/services/ChannelEncryptionService', () => ({ setChannelEncryption: vi.fn() }))
vi.mock('@/services/RoleService', () => ({ roleService: { getRolesForServer: vi.fn(async () => []) } }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: 's1', channels: [], privateChannels: {}, servers: [] }),
}))

import CreateChannel from '../CreateChannel.vue'

const global = {
  mocks: { $t: (key: string) => key },
  stubs: { transition: false, Icon: true, ToggleSwitch: true },
}

afterEach(() => {
  document.body.innerHTML = ''
})

const radios = () => Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
const byId = (id: string | null) => (id ? document.getElementById(id)?.textContent?.trim() : undefined)

describe('Create channel type', () => {
  it('is a radio group under a legend, Text checked first', async () => {
    const wrapper = mount(CreateChannel, { props: { show: true, serverId: 's1' }, global, attachTo: document.body })
    await flushPromises()
    const fieldset = document.body.querySelector('fieldset')!
    expect(fieldset.querySelector('legend')?.textContent?.trim()).toBe('channel.channelType')
    const [text, voice] = radios()
    expect(radios()).toHaveLength(2)
    expect(text.name).toBe(voice.name)
    expect(text.checked).toBe(true)
    expect(voice.checked).toBe(false)
    expect(byId(text.getAttribute('aria-labelledby'))).toBe('channel.text')
    expect(byId(voice.getAttribute('aria-labelledby'))).toBe('channel.voice')
    expect(byId(voice.getAttribute('aria-describedby'))).toBe('channel.voiceDesc')
    wrapper.unmount()
  })

  it('creates the checked type', async () => {
    const wrapper = mount(CreateChannel, { props: { show: true, serverId: 's1' }, global, attachTo: document.body })
    await flushPromises()
    const [, voice] = radios()
    voice.checked = true
    voice.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('input.modern-input')!
    input.value = 'Lounge'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('create_channel', expect.objectContaining({ p_name: 'Lounge', p_type: 1 }))
    wrapper.unmount()
  })
})
