/**
 * Typing into the new channel and new category forms: a space becomes '-' and
 * stays, '-' and '_' are kept, and the created name has no trailing '-'.
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
vi.mock('@/services/RoleService', () => ({ roleService: { getServerRoles: vi.fn(async () => []) } }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: 's1', channels: [], privateChannels: {}, servers: [] }),
}))

import CreateChannel from '../CreateChannel.vue'
import CategoryCreator from '../CategoryCreator.vue'

const global = {
  mocks: { $t: (key: string) => key },
  stubs: { transition: false, Icon: true, ToggleSwitch: true },
}

// BaseModal teleports to body: the form is read from the document.
const field = () => document.body.querySelector<HTMLInputElement>('input.modern-input')!
const form = () => document.body.querySelector<HTMLFormElement>('form')!

afterEach(() => {
  document.body.innerHTML = ''
})

async function type(text: string) {
  for (const ch of text) {
    const input = field()
    input.value += ch
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
  }
}

describe('new channel name', () => {
  it('keeps a typed space as a hyphen, keeps underscores, trims on create', async () => {
    const wrapper = mount(CreateChannel, { props: { show: true, serverId: 's1' }, global, attachTo: document.body })
    await type('Off Topic_chat ')
    expect(field().value).toBe('off-topic_chat-')

    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('create_channel', expect.objectContaining({ p_name: 'off-topic_chat' }))
    wrapper.unmount()
  })
})

describe('new category name', () => {
  it('keeps a typed space as a hyphen and emits the trimmed name', async () => {
    const wrapper = mount(CategoryCreator, { global, attachTo: document.body })
    await flushPromises()
    await type('Voice Rooms ')
    expect(field().value).toBe('Voice-Rooms-')

    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(wrapper.emitted('createCategory')?.[0]).toEqual(['Voice-Rooms'])
    wrapper.unmount()
  })
})
