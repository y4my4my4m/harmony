/**
 * Create channel: a voice channel offers "Encrypt voice and video" whatever the server's message
 * encryption mode, applied through set_channel_encryption after create_channel; a server
 * requiring encrypted voice shows it on and locked and sends nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const rpc = vi.hoisted(() => vi.fn(async () => ({ data: { id: 'ch1' }, error: null })))
const setEncryption = vi.hoisted(() => vi.fn(async () => null))
const policy = vi.hoisted(() => ({ value: null as Record<string, string> | null }))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/supabase', () => {
  const counted = { eq: () => counted, then: (resolve: (v: unknown) => unknown) => resolve({ count: 0, error: null }) }
  return {
    supabase: {
      rpc,
      from: (table: string) => ({
        select: () => table === 'server_encryption_settings'
          ? { eq: () => ({ maybeSingle: async () => ({ data: policy.value, error: null }) }) }
          : counted,
      }),
    },
  }
})
vi.mock('@/services/ChannelEncryptionService', () => ({ setChannelEncryption: setEncryption }))
vi.mock('@/services/RoleService', () => ({ roleService: { getRolesForServer: vi.fn(async () => []) } }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: 's1', channels: [], privateChannels: {}, servers: [] }),
}))
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerToggle: vi.fn() }) }))

import CreateChannel from '../CreateChannel.vue'

enableAutoUnmount(afterEach)

const global = {
  mocks: { $t: (key: string) => key },
  stubs: { transition: false, Icon: true },
}

async function open(type: 'text' | 'voice') {
  const wrapper = mount(CreateChannel, { props: { show: true, serverId: 's1' }, global, attachTo: document.body })
  await flushPromises()
  if (type === 'voice') {
    const voice = document.body.querySelector<HTMLInputElement>('[data-testid="channel-type-voice"]')!
    voice.checked = true
    voice.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
  }
  return wrapper
}

async function submit(name: string) {
  const input = document.body.querySelector<HTMLInputElement>('input.modern-input')!
  input.value = name
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
  document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flushPromises()
}

const voiceSwitch = () =>
  document.body.querySelector<HTMLButtonElement>('[data-testid="create-voice-encryption"] [role="switch"]')

beforeEach(() => {
  document.body.innerHTML = ''
  rpc.mockClear()
  setEncryption.mockClear()
  policy.value = null
})

describe('Create channel voice encryption', () => {
  it('is offered for a voice channel on a server with message encryption disabled', async () => {
    policy.value = { encryption_mode: 'disabled', voice_encryption_mode: 'disabled' }
    await open('voice')

    expect(voiceSwitch()).not.toBeNull()
    expect(voiceSwitch()!.getAttribute('aria-label')).toBe('channelEncryption.create.voiceLabel')
    expect(voiceSwitch()!.getAttribute('aria-checked')).toBe('false')
    expect(document.body.textContent).toContain('channelEncryption.create.voiceHint')
    expect(document.body.textContent).not.toContain('channelEncryption.create.label')

    voiceSwitch()!.click()
    await flushPromises()
    expect(voiceSwitch()!.getAttribute('aria-checked')).toBe('true')

    await submit('Lounge')
    expect(rpc).toHaveBeenCalledWith('create_channel', expect.objectContaining({ p_type: 1 }))
    expect(setEncryption).toHaveBeenCalledWith('ch1', { voiceEncrypted: true })
  })

  it('creates an unencrypted voice channel when left off', async () => {
    await open('voice')
    await submit('Lounge')
    expect(rpc).toHaveBeenCalled()
    expect(setEncryption).not.toHaveBeenCalled()
  })

  it('applies message and voice encryption in one change under an optional server', async () => {
    policy.value = { encryption_mode: 'optional', voice_encryption_mode: 'disabled' }
    await open('voice')
    const messages = document.body.querySelectorAll<HTMLButtonElement>('[role="switch"]')
    const messageSwitch = Array.from(messages).find((el) => el.getAttribute('aria-label') === 'channelEncryption.create.label')!
    messageSwitch.click()
    voiceSwitch()!.click()
    await flushPromises()

    await submit('Lounge')
    expect(setEncryption).toHaveBeenCalledTimes(1)
    expect(setEncryption).toHaveBeenCalledWith('ch1', { messagesEncrypted: true, voiceEncrypted: true })
  })

  it('is on and locked when the server requires encrypted voice, and sends nothing', async () => {
    policy.value = { encryption_mode: 'disabled', voice_encryption_mode: 'required' }
    await open('voice')

    expect(voiceSwitch()!.getAttribute('aria-checked')).toBe('true')
    expect(voiceSwitch()!.getAttribute('aria-disabled')).toBe('true')
    expect(document.body.textContent).toContain('channelEncryption.settings.voiceRequired')
    voiceSwitch()!.click()
    await flushPromises()
    expect(voiceSwitch()!.getAttribute('aria-checked')).toBe('true')

    await submit('Lounge')
    expect(setEncryption).not.toHaveBeenCalled()
  })

  it('is not offered for a text channel', async () => {
    policy.value = { encryption_mode: 'disabled', voice_encryption_mode: 'disabled' }
    await open('text')
    expect(voiceSwitch()).toBeNull()
  })
})
