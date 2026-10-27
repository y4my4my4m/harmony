/**
 * Create channel's More options: collapsed at first; a description for every channel and
 * slowmode for a text channel, sent in the create_channel call. An instance without
 * 'channel-create-options' shows no More options and receives the six arguments of 1.9.0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const rpc = vi.hoisted(() => vi.fn(async () => ({ data: { id: 'ch1' }, error: null })))
const capabilities = vi.hoisted(() => ({ createOptions: true }))

vi.mock('@/services/instanceCapabilities', () => ({
  hasCapability: (name: string) => name !== 'channel-create-options' || capabilities.createOptions,
}))
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
          ? { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }
          : counted,
      }),
    },
  }
})
vi.mock('@/services/ChannelEncryptionService', () => ({ setChannelEncryption: vi.fn() }))
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

const more = () => document.body.querySelector<HTMLButtonElement>('[data-testid="create-channel-more"]')
const byLabel = (key: string) => {
  const label = Array.from(document.body.querySelectorAll('label')).find((l) => l.textContent?.trim() === key)
  return label ? document.getElementById(label.getAttribute('for')!) as HTMLInputElement | HTMLTextAreaElement : null
}

async function name(value: string) {
  const input = document.body.querySelector<HTMLInputElement>('input.modern-input')!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

async function submit() {
  document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flushPromises()
}

beforeEach(() => {
  document.body.innerHTML = ''
  rpc.mockClear()
  capabilities.createOptions = true
})

describe('Create channel More options', () => {
  it('opens on demand and sends the description and slowmode with the creation', async () => {
    mount(CreateChannel, { props: { show: true, serverId: 's1' }, global, attachTo: document.body })
    await flushPromises()

    expect(more()!.getAttribute('aria-expanded')).toBe('false')
    expect((byLabel('channel.edit.description') as HTMLElement).closest('.more-options-body')!.getAttribute('style')).toContain('display: none')
    more()!.click()
    await flushPromises()
    expect(more()!.getAttribute('aria-expanded')).toBe('true')

    await name('announcements')
    const description = byLabel('channel.edit.description')!
    description.value = '  Release notes  '
    description.dispatchEvent(new Event('input', { bubbles: true }))
    const slowmode = byLabel('channel.edit.slowmode')!
    slowmode.value = '4'
    slowmode.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    await submit()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('create_channel', expect.objectContaining({
      p_name: 'announcements',
      p_description: 'Release notes',
      p_slowmode_seconds: 30,
      p_messages_encrypted: null,
      p_voice_encrypted: null,
      p_history_visibility: null,
    }))
  })

  it('offers no slowmode for a voice channel', async () => {
    mount(CreateChannel, { props: { show: true, serverId: 's1' }, global, attachTo: document.body })
    const voice = document.body.querySelector<HTMLInputElement>('[data-testid="channel-type-voice"]')!
    voice.checked = true
    voice.dispatchEvent(new Event('change', { bubbles: true }))
    more()!.click()
    await flushPromises()

    expect(byLabel('channel.edit.description')).not.toBeNull()
    expect(byLabel('channel.edit.slowmode')).toBeNull()
  })

  it('sends the six arguments of 1.9.0 to an instance without creation options', async () => {
    capabilities.createOptions = false
    mount(CreateChannel, { props: { show: true, serverId: 's1' }, global, attachTo: document.body })
    await flushPromises()
    expect(more()).toBeNull()

    await name('general-two')
    await submit()
    expect(Object.keys(rpc.mock.calls[0][1] as object).sort()).toEqual(
      ['p_allowed_role_ids', 'p_category', 'p_name', 'p_private', 'p_server_id', 'p_type'])
  })
})
