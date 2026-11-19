/**
 * "Speak message" in the message menu: offered for a readable message, reads
 * the parts the viewer sees with spoilers masked, is hidden while the message
 * is still encrypted, and can stop a playback already under way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'

const speakMock = vi.hoisted(() => vi.fn(async () => undefined))
const stopMock = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())

vi.mock('@/stores/useReactions', () => ({ useReactionsStore: () => ({ getMessageReactions: () => [] }) }))
vi.mock('@/composables/useFrequentEmojis', () => ({
  useFrequentEmojis: () => ({ topEmojisForContextMenu: ref([]), hasFrequentEmojis: ref(false), recordEmojiUsage: vi.fn() }),
}))
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerReaction: vi.fn() }) }))
vi.mock('@/composables/useServerPermissions', () => ({ useServerPermissions: () => ({ canPinMessages: ref(false), isLocalServer: ref(true) }) }))
vi.mock('@/composables/useChannelMessagePermissions', () => ({
  useChannelMessagePermissions: () => ({ canPinMessages: ref(false), canManageMessages: ref(false), canCreateThreads: ref(true) }),
}))
vi.mock('@/composables/useDeveloperTools', () => ({ useDeveloperTools: () => ({ developerToolsEnabled: ref(false) }) }))
vi.mock('@/composables/usePinActions', () => ({ usePinActions: () => ({ setPinned: vi.fn() }) }))
vi.mock('@/services/privateMedia', () => ({ resolveMediaPartUrl: vi.fn(async () => null) }))
vi.mock('@/utils/downloadMedia', () => ({ downloadMediaFromUrl: vi.fn(), filenameFromUrl: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: toastError }) }))
vi.mock('@/services/messageTts', async () => {
  const { ref } = await import('vue')
  class MessageTtsError extends Error {
    code: string
    status?: number
    constructor(code: string, status?: number) {
      super(code)
      this.code = code
      this.status = status
    }
  }
  return {
    isSpeaking: ref(false),
    speakingMessageId: ref(null),
    MessageTtsError,
    speakMessage: speakMock,
    stopMessageSpeech: stopMock,
    loadMessageTtsSettings: vi.fn(() => ({})),
  }
})

import MessageContextMenu from '../MessageContextMenu.vue'
import { isSpeaking, MessageTtsError } from '@/services/messageTts'

const mountMenu = (message: any) => mount(MessageContextMenu, {
  props: { isVisible: true, position: { x: 0, y: 0 }, message, currentUserId: 'me' },
  global: { mocks: { $t: (key: string) => key }, stubs: { teleport: true, Icon: true } },
})

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

beforeEach(() => {
  speakMock.mockClear()
  stopMock.mockClear()
  toastError.mockClear()
  speakMock.mockResolvedValue(undefined)
  isSpeaking.value = false
})

const speakItem = '[data-testid="context-menu-speak"]'

describe('MessageContextMenu Speak message', () => {
  it('reads the visible text with spoilers masked', async () => {
    wrapper = mountMenu({ id: 'm1', user_id: 'them', content: [{ type: 'text', text: 'hello ||secret|| world' }], created_at: new Date() })
    const item = wrapper.get(speakItem)
    expect(item.text()).toBe('messageTts.menu.speak')
    await item.trigger('click')
    expect(speakMock).toHaveBeenCalledTimes(1)
    const [{ messageId, text }] = speakMock.mock.calls[0]
    expect(messageId).toBe('m1')
    expect(text).toContain('hello')
    expect(text).toContain('world')
    expect(text).toContain('messageA11y.speech.spoiler')
    expect(text).not.toContain('secret')
  })

  it('speaks a decrypted message', async () => {
    wrapper = mountMenu({
      id: 'm1', user_id: 'them', encrypted: true, decrypted: true,
      content: [{ type: 'text', text: 'unlocked body' }], created_at: new Date(),
    })
    expect(wrapper.find(speakItem).exists()).toBe(true)
    await wrapper.get(speakItem).trigger('click')
    expect(speakMock.mock.calls[0][0].text).toContain('unlocked body')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('reads a decrypted message with its spoilers still masked', async () => {
    wrapper = mountMenu({
      id: 'm1', user_id: 'them', encrypted: true, decrypted: true,
      content: [{ type: 'text', text: 'unlocked ||secret|| body' }], created_at: new Date(),
    })
    await wrapper.get(speakItem).trigger('click')
    const [{ text }] = speakMock.mock.calls[0]
    expect(text).toContain('unlocked')
    expect(text).toContain('messageA11y.speech.spoiler')
    expect(text).not.toContain('secret')
  })

  it('shows the missing-key error for the official API', async () => {
    speakMock.mockRejectedValue(new MessageTtsError('missing-key'))
    wrapper = mountMenu({ id: 'm1', user_id: 'them', content: [{ type: 'text', text: 'hi' }], created_at: new Date() })
    await wrapper.get(speakItem).trigger('click')
    await flushPromises()
    expect(toastError).toHaveBeenCalledWith('messageTts.errors.missingKey')
  })

  it('hides the action while the message is still encrypted', () => {
    wrapper = mountMenu({
      id: 'm1', user_id: 'them', encrypted: true, decrypted: false,
      content: [{ type: 'text', text: 'ciphertext' }], created_at: new Date(),
    })
    expect(wrapper.find(speakItem).exists()).toBe(false)
  })

  it('offers Stop while a message is already being spoken', async () => {
    isSpeaking.value = true
    wrapper = mountMenu({ id: 'm1', user_id: 'them', content: [{ type: 'text', text: 'hi' }], created_at: new Date() })
    const stop = wrapper.get('[data-testid="context-menu-stop-speaking"]')
    await stop.trigger('click')
    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('shows a localized error when the voice service fails', async () => {
    speakMock.mockRejectedValue(new MessageTtsError('network'))
    wrapper = mountMenu({ id: 'm1', user_id: 'them', content: [{ type: 'text', text: 'hi' }], created_at: new Date() })
    await wrapper.get(speakItem).trigger('click')
    await flushPromises()
    expect(toastError).toHaveBeenCalledWith('messageTts.errors.network')
  })
})
