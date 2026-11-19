/**
 * "Speak message" in the message menu: offered for a readable message, reads
 * the parts the viewer sees with spoilers masked, is hidden while the message
 * is still encrypted, and can stop a playback already under way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'

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

const BOB = '00000000-0000-4000-8000-000000000002'
const THREAD = '00000000-0000-4000-8000-0000000000f1'
// Real i18n, so the spoken wording is the text a reader hears.
const mountI18nMenu = (message: any, extra: Record<string, unknown> = {}) => mount(MessageContextMenu, {
  props: { isVisible: true, position: { x: 0, y: 0 }, message, currentUserId: 'me', ...extra },
  global: {
    plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
    stubs: { teleport: true, Icon: true },
  },
})

const systemMessage = (metadata: Record<string, unknown>, text: string) => ({
  id: 'm1', is_system: true, user_id: null, created_at: new Date(), metadata,
  content: [{ type: 'text', text }],
}) as any

describe('MessageContextMenu Speak message for a system notice', () => {
  it('reads a join from metadata with the member name, not the stored content', async () => {
    wrapper = mountI18nMenu(
      systemMessage({ type: 'member_join', subject_id: BOB }, 'has joined the server'),
      { systemUserName: (id: string) => (id === BOB ? 'Bob' : 'Unknown User') },
    )
    await wrapper.get(speakItem).trigger('click')
    const [{ text }] = speakMock.mock.calls[0]
    expect(text).toBe('Bob joined the server.')
    expect(text).not.toContain(BOB)
    // The event sentence already names the member.
    expect(text).not.toContain('said')
  })

  it('reads a thread notice with its name and reads the link as text, not the thread id', async () => {
    wrapper = mountI18nMenu(
      systemMessage({ type: 'thread_created', actor_id: BOB, thread_id: THREAD, thread_name: 'Plans' }, 'started a thread'),
      { systemUserName: (id: string) => (id === BOB ? 'Bob' : 'Unknown User') },
    )
    await wrapper.get(speakItem).trigger('click')
    const [{ text }] = speakMock.mock.calls[0]
    expect(text).toBe('Bob started a thread: Plans. See all threads.')
    expect(text).not.toContain(THREAD)
  })
})

describe('MessageContextMenu Speak message introduction', () => {
  it('reads a normal message as its displayed author and the text', async () => {
    wrapper = mountI18nMenu(
      { id: 'm1', user_id: 'alice', content: [{ type: 'text', text: 'hello there' }], created_at: new Date() },
      { authorName: 'Alice' },
    )
    await wrapper.get(speakItem).trigger('click')
    expect(speakMock.mock.calls[0][0].text).toBe('Alice said: hello there')
  })

  it('names both displayed authors of a reply and reads only the new body', async () => {
    wrapper = mountI18nMenu(
      {
        id: 'm2', user_id: 'alice', reply_to: 'm1', created_at: new Date(),
        content: [{ type: 'text', text: 'my answer' }],
      },
      { authorName: 'Alice', replyAuthorName: 'Bob' },
    )
    await wrapper.get(speakItem).trigger('click')
    const [{ text }] = speakMock.mock.calls[0]
    expect(text).toBe('Alice replied to Bob: my answer')
    expect(text).not.toContain('m1')
  })

  it('reads a reply whose original author is unreadable without inventing one', async () => {
    wrapper = mountI18nMenu(
      {
        id: 'm2', user_id: 'alice', reply_to: 'm1', created_at: new Date(),
        content: [{ type: 'text', text: 'my answer' }],
      },
      { authorName: 'Alice', replyAuthorName: '' },
    )
    await wrapper.get(speakItem).trigger('click')
    expect(speakMock.mock.calls[0][0].text).toBe('Alice replied: my answer')
  })

  it('falls back to a localized name for an unknown author', async () => {
    wrapper = mountI18nMenu(
      { id: 'm1', content: [{ type: 'text', text: 'hi' }], created_at: new Date() },
      { authorName: '' },
    )
    await wrapper.get(speakItem).trigger('click')
    expect(speakMock.mock.calls[0][0].text).toBe('Someone said: hi')
  })

  it('names a bridged author as the row shows them', async () => {
    wrapper = mountI18nMenu(
      { id: 'm1', content: [{ type: 'text', text: 'hi' }], created_at: new Date() },
      { authorName: 'Bridged Bob' },
    )
    await wrapper.get(speakItem).trigger('click')
    expect(speakMock.mock.calls[0][0].text).toBe('Bridged Bob said: hi')
  })
})

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
