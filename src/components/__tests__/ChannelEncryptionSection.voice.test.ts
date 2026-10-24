/**
 * Channel encryption settings, voice row: a voice channel decides its own voice encryption
 * whatever the server's message mode; a server requiring encrypted voice locks it on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { EffectiveChannelEncryption } from '@/utils/channelEncryption'

const fetchEffective = vi.hoisted(() => vi.fn())
const setEncryption = vi.hoisted(() => vi.fn())
const confirm = vi.hoisted(() => vi.fn(async () => true))

vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    return typeof message === 'string' ? message : key
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t }) }
})
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/services/ChannelEncryptionService', () => ({
  fetchEffectiveChannelEncryption: fetchEffective,
  setChannelEncryption: setEncryption,
}))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm }) }))
vi.mock('@/components/common/Icon.vue', () => ({ default: { name: 'Icon', render: () => null } }))

import ChannelEncryptionSection from '../ChannelEncryptionSection.vue'
import { useChannelEncryptionStore } from '@/stores/useChannelEncryption'

enableAutoUnmount(afterEach)

function state(over: Partial<EffectiveChannelEncryption> = {}): EffectiveChannelEncryption {
  return {
    channelId: 'v1', serverId: 's1', serverMode: 'disabled', voiceMode: 'disabled',
    messagesEncrypted: false, voiceEncrypted: false, messagesLocked: true, voiceLocked: false,
    historyVisibility: 'all', enabledAt: null, enabledBy: null, botCount: 0, bridgeCount: 0,
    ...over,
  }
}

async function mountSection(type = 1) {
  const wrapper = mount(ChannelEncryptionSection, {
    props: { channel: { id: 'v1', name: 'lounge', type } as any, canManage: true },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  fetchEffective.mockReset()
  setEncryption.mockReset()
  confirm.mockClear()
})

describe('ChannelEncryptionSection voice row', () => {
  it('lets a manager turn voice on while message encryption is disabled', async () => {
    fetchEffective.mockResolvedValue(state())
    setEncryption.mockResolvedValue(state({ voiceEncrypted: true }))
    const wrapper = await mountSection()

    const messages = wrapper.get('[data-testid="channel-messages-encryption"]')
    const voice = wrapper.get('[data-testid="channel-voice-encryption"]')
    expect(messages.attributes('aria-disabled')).toBe('true')
    expect(voice.attributes('aria-disabled')).toBe('false')
    expect(voice.attributes('aria-checked')).toBe('false')
    expect(wrapper.text()).toContain('Calls are encrypted before they reach the media server.')

    await voice.trigger('click')
    await flushPromises()

    expect(setEncryption).toHaveBeenCalledWith('v1', { voiceEncrypted: true })
    expect(wrapper.get('[data-testid="channel-voice-encryption"]').attributes('aria-checked')).toBe('true')
    expect(useChannelEncryptionStore().isVoiceEncrypted('v1')).toBe(true)
    expect(useChannelEncryptionStore().isMessagesEncrypted('v1')).toBe(false)
  })

  it('confirms before turning voice off', async () => {
    fetchEffective.mockResolvedValue(state({ voiceEncrypted: true }))
    setEncryption.mockResolvedValue(state())
    const wrapper = await mountSection()

    await wrapper.get('[data-testid="channel-voice-encryption"]').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(setEncryption).toHaveBeenCalledWith('v1', { voiceEncrypted: false })
  })

  it('locks voice on when the server requires encrypted voice', async () => {
    fetchEffective.mockResolvedValue(state({ voiceMode: 'required', voiceEncrypted: true, voiceLocked: true }))
    const wrapper = await mountSection()

    const voice = wrapper.get('[data-testid="channel-voice-encryption"]')
    expect(voice.attributes('aria-checked')).toBe('true')
    expect(voice.attributes('aria-disabled')).toBe('true')
    expect(wrapper.text()).toContain('This server requires encrypted voice and video in every voice channel.')
    await voice.trigger('click')
    await flushPromises()
    expect(setEncryption).not.toHaveBeenCalled()
  })

  it('has no voice row for a text channel', async () => {
    fetchEffective.mockResolvedValue(state())
    const wrapper = await mountSection(0)
    expect(wrapper.find('[data-testid="channel-voice-encryption"]').exists()).toBe(false)
  })
})

describe('ChannelEncryptionSection history row', () => {
  const encrypted = (over: Partial<EffectiveChannelEncryption> = {}) =>
    state({ serverMode: 'optional', messagesLocked: false, messagesEncrypted: true, ...over })

  it('offers all, pinned only and none for an encrypted channel', async () => {
    fetchEffective.mockResolvedValue(encrypted())
    setEncryption.mockResolvedValue(encrypted({ historyVisibility: 'pinned' }))
    const wrapper = await mountSection(0)

    const select = wrapper.get('[data-testid="channel-history-visibility"]')
    expect(select.findAll('option').map((o) => o.attributes('value'))).toEqual(['all', 'pinned', 'none'])
    expect((select.element as HTMLSelectElement).value).toBe('all')
    expect(wrapper.text()).toContain('New members can read earlier messages')

    await select.setValue('pinned')
    await flushPromises()
    expect(setEncryption).toHaveBeenCalledWith('v1', { historyVisibility: 'pinned' })
    expect(wrapper.text()).toContain('can read pinned messages sent before they joined')
  })

  it('puts the select back when the server refuses the change', async () => {
    fetchEffective.mockResolvedValue(encrypted())
    setEncryption.mockRejectedValue(Object.assign(new Error('Could not find the function'), { code: 'PGRST202' }))
    const wrapper = await mountSection(0)
    const select = wrapper.get('[data-testid="channel-history-visibility"]')

    await select.setValue('none')
    await flushPromises()
    expect((select.element as HTMLSelectElement).value).toBe('all')
  })

  it('has no history row while messages are not encrypted', async () => {
    fetchEffective.mockResolvedValue(state())
    const wrapper = await mountSection(0)
    expect(wrapper.find('[data-testid="channel-history-visibility"]').exists()).toBe(false)
  })

  it('is read-only for a member who cannot manage the channel', async () => {
    fetchEffective.mockResolvedValue(encrypted({ historyVisibility: 'none' }))
    const wrapper = mount(ChannelEncryptionSection, {
      props: { channel: { id: 'v1', name: 'general', type: 0 } as any, canManage: false },
    })
    await flushPromises()
    const select = wrapper.get('[data-testid="channel-history-visibility"]')
    expect(select.attributes('disabled')).toBeDefined()
    expect((select.element as HTMLSelectElement).value).toBe('none')
  })
})
