/**
 * The spoken-messages settings row: pick the voice source, see the external
 * fields and its disclosure, have a change persist for this device/user, and
 * never carry one account's settings (or key) into another.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

import { userStorage } from '@/utils/userScopedStorage'
import { useAuthStore } from '@/stores/auth'
import {
  isSpeaking,
  loadMessageTtsSettings,
  saveMessageTtsSettings,
  type MessageTtsSettings,
} from '@/services/messageTts'
import SpeakMessageSettings from '../SpeakMessageSettings.vue'

let wrapper: VueWrapper | null = null

const external = (over: Partial<MessageTtsSettings> = {}): MessageTtsSettings => ({
  provider: 'elevenlabs',
  baseUrl: 'https://api.elevenlabs.io',
  voiceId: 'u1-voice',
  modelId: '',
  apiKey: 'key-A',
  ...over,
})

function mountSettings(): VueWrapper {
  const pinia = createPinia()
  setActivePinia(pinia)
  wrapper = mount(SpeakMessageSettings, { global: { plugins: [pinia] } })
  return wrapper
}

/** Every localStorage value, so a leftover key string can be spotted. */
function storedValues(): string {
  let all = ''
  for (let i = 0; i < localStorage.length; i++) all += localStorage.getItem(localStorage.key(i)!) ?? ''
  return all
}

beforeEach(() => {
  localStorage.clear()
  userStorage.clearCurrentUser()
  userStorage.setCurrentUser('u1')
  isSpeaking.value = false
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  userStorage.clearCurrentUser()
  vi.restoreAllMocks()
})

describe('SpeakMessageSettings', () => {
  it('shows the provider choice and keeps it for this device and user', async () => {
    mountSettings()
    expect(wrapper!.text()).toContain('messageTts.settings.label')
    expect(wrapper!.find('[data-testid="speak-external-disclosure"]').exists()).toBe(false)

    await wrapper!.get('select').setValue('elevenlabs')
    expect(wrapper!.find('[data-testid="speak-external-disclosure"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="speak-base-url"]').exists()).toBe(true)

    await wrapper!.get('[data-testid="speak-voice-id"]').setValue('my-voice')
    await flushPromises()
    expect(loadMessageTtsSettings()).toMatchObject({ provider: 'elevenlabs', voiceId: 'my-voice' })
  })

  it('offers Stop only while a message is being spoken', async () => {
    mountSettings()
    expect(wrapper!.find('[data-testid="speak-stop"]').exists()).toBe(false)
    isSpeaking.value = true
    await flushPromises()
    expect(wrapper!.find('[data-testid="speak-stop"]').exists()).toBe(true)
  })

  it('drops the previous account key when the account switches while mounted', async () => {
    saveMessageTtsSettings(external())
    mountSettings()
    const auth = useAuthStore()
    expect((wrapper!.get('[data-testid="speak-api-key"]').element as HTMLInputElement).value).toBe('key-A')

    // What the auth store does on a switch: new user scoped storage with its
    // own stored config, then the new session.
    userStorage.setCurrentUser('u2')
    saveMessageTtsSettings(external({ voiceId: 'u2-voice', apiKey: 'key-B' }))
    auth.session = { user: { id: 'u2' } } as never
    await nextTick()
    await flushPromises()

    // Account B keeps its own config; nothing from account A was copied to B or
    // left on screen.
    expect(loadMessageTtsSettings()).toMatchObject({ voiceId: 'u2-voice', apiKey: 'key-B' })
    expect(storedValues()).not.toContain('key-A')
    expect((wrapper!.get('[data-testid="speak-api-key"]').element as HTMLInputElement).value).toBe('key-B')
    expect(wrapper!.text()).not.toContain('key-A')
  })

  it('clears the previous account key when the account signs out while mounted', async () => {
    saveMessageTtsSettings(external())
    mountSettings()
    const auth = useAuthStore()
    auth.session = { user: { id: 'u1' } } as never
    await nextTick()
    expect((wrapper!.get('[data-testid="speak-api-key"]').element as HTMLInputElement).value).toBe('key-A')

    auth.session = null
    userStorage.clearCurrentUser()
    await nextTick()
    await flushPromises()

    expect(loadMessageTtsSettings().apiKey).toBe('')
    expect(storedValues()).not.toContain('key-A')
    expect(wrapper!.find('[data-testid="speak-api-key"]').exists()).toBe(false)
  })

  it('shows a localized status when a change cannot be saved', async () => {
    mountSettings()
    vi.spyOn(userStorage, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })

    await wrapper!.get('select').setValue('elevenlabs')
    await flushPromises()

    const status = wrapper!.get('[data-testid="speak-save-error"]')
    expect(status.text()).toBe('messageTts.settings.saveError')
  })
})
