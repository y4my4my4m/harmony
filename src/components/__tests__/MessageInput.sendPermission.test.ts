/**
 * The composer's send permission across a server switch. currentServerId changes before the
 * channel does, so one question names the new server with the old channel, and
 * get_user_permissions answers a channel outside its server with no permission (20261109600001).
 * The answers arrive in any order.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

type Deferred = { promise: Promise<boolean>; resolve: (value: boolean) => void }
type Store = {
  channels: Array<{ id: string; server_id: string; type: number; name: string }>
  currentServerId: string | null
  currentChannelId: string | null
}

const perm = vi.hoisted(() => ({
  asked: [] as Array<{ server: string; channel: string }>,
  pending: new Map<string, Deferred>(),
  store: null as unknown as Store,
}))

vi.mock('@/composables/useViewport', () => ({
  useViewport: () => ({ isMobileViewport: ref(false), isTouchOnly: false }),
}))
vi.mock('@/composables/useAutoSuggest', async () => {
  const { ref: vueRef } = await import('vue')
  return {
    useAutoSuggest: () => ({
      state: vueRef({ isActive: false, selectedIndex: 0, position: { top: 0, left: 0 } }),
      suggestions: vueRef([]),
      headerText: vueRef(''),
      activeCommand: vueRef(null),
      activeBotCommand: vueRef(null),
      handleInput: vi.fn(),
      handleKeyDown: vi.fn(() => false),
      selectSuggestion: vi.fn(),
      closeSuggestions: vi.fn(),
      dismissActiveCommand: vi.fn(),
      dismissBotCommand: vi.fn(),
    }),
  }
})
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerMessage: vi.fn() }) }))
vi.mock('@/composables/useTypingIndicator', async () => {
  const { ref: vueRef } = await import('vue')
  return { useTypingIndicator: () => ({ typingUsers: vueRef([]), startTyping: vi.fn(), stopTyping: vi.fn() }) }
})
vi.mock('@/composables/useFrequentEmojis', () => ({ useFrequentEmojis: () => ({ recordEmojiUsage: vi.fn() }) }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({ getUserDisplayName: () => ({ value: 'Unknown User' }) }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'uid-1' } } }) }))
vi.mock('@/stores/photoDetailsSettings', () => ({ usePhotoDetailsSettingsStore: () => ({ keepByDefault: false, ready: async () => {} }) }))
vi.mock('@/stores/useServerChannel', async () => {
  const { reactive } = await import('vue')
  perm.store = reactive<Store>({ channels: [], currentServerId: null, currentChannelId: null })
  return { useServerChannelStore: () => perm.store }
})
vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => ({ settings: { maxMessageLength: 2000, maxMediaAttachmentsPerPost: 10 } }),
}))
// SEND and MANAGE of one server and channel share an answer.
vi.mock('@/services/RoleService', () => ({
  roleService: {
    hasPermission: vi.fn((_user: string, server: string, _permission: string, channel: string) => {
      const key = `${server}|${channel}`
      perm.asked.push({ server, channel })
      let deferred = perm.pending.get(key)
      if (!deferred) {
        let resolve!: (value: boolean) => void
        const promise = new Promise<boolean>((r) => { resolve = r })
        deferred = { promise, resolve }
        perm.pending.set(key, deferred)
      }
      return deferred.promise
    }),
  },
  Permission: { SEND_MESSAGES: 'SEND_MESSAGES', MANAGE_MESSAGES: 'MANAGE_MESSAGES', SEND_MESSAGES_IN_THREADS: 'SEND_MESSAGES_IN_THREADS' },
}))
vi.mock('@/services/privateMedia', () => ({ mediaRoom: () => 'c/x', messageMediaPath: vi.fn(), uploadMessageMedia: vi.fn() }))
vi.mock('@/services/messageMediaUpload', () => ({
  UploadAbortedError: class extends Error {},
  forgetMessageMediaUpload: vi.fn(),
  prepareMessageMediaUploads: vi.fn(),
  startMessageMediaUpload: vi.fn(),
}))
vi.mock('@/utils/ephemeralEmoji', () => ({ buildEphemeralEmojiFromGif: vi.fn(), registerEphemeralEmoji: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn(), info: vi.fn() }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

async function stub(name: string, emits: string[] = [], props: string[] = []) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, emits, props, render: () => h('div') }) }
}
vi.mock('@/components/TypingIndicator.vue', () => stub('TypingIndicator'))
vi.mock('@/components/MessageReply.vue', () => stub('MessageReply'))
vi.mock('@/components/FilePreview.vue', () => stub('FilePreview', [], ['files']))
vi.mock('@/components/InlineGifPicker.vue', () => stub('InlineGifPicker'))
vi.mock('@/components/FileUploadMenu.vue', () => stub('FileUploadMenu'))
vi.mock('@/components/AutoSuggest.vue', () => stub('AutoSuggest'))
vi.mock('@/components/EmojiUI.vue', () => stub('EmojiUI'))
vi.mock('@/components/icons/Gif.vue', () => stub('GifIcon'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/icons/Plus.vue', () => stub('PlusIcon'))
vi.mock('@/components/VoiceRecorder.vue', () => stub('VoiceRecorder'))
vi.mock('@/components/BotCommandBar.vue', async () => ({
  __esModule: true,
  ...(await stub('BotCommandBar', ['close', 'invoked'], ['command', 'serverId'])),
}))
vi.mock('@/components/RichTextEditor.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'RichTextEditor',
      props: { modelValue: { type: String, default: '' } },
      emits: ['update:modelValue', 'keydown'],
      setup(props, { expose }) {
        expose({ focus: vi.fn(), clear: vi.fn(), getPlainText: () => props.modelValue })
        return () => h('div', { class: 'rte' })
      },
    }),
  }
})

import MessageInput from '../MessageInput.vue'

const SERVER_A = 'server-a'
const SERVER_B = 'server-b'
const CHANNEL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CHANNEL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const THREAD_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const row = (id: string, server_id: string) => ({ id, server_id, type: 0, name: 'general' })

const mountInput = (props: Record<string, unknown>) => mount(MessageInput, {
  props: { modelValue: '', ...props },
  global: { mocks: { $t: (key: string) => key } },
})

const answer = async (server: string, channel: string, value: boolean) => {
  const key = `${server}|${channel}`
  perm.pending.get(key)!.resolve(value)
  perm.pending.delete(key)
  await flushPromises()
}
const refused = (wrapper: ReturnType<typeof mountInput>) => wrapper.find('.message-readonly-banner').exists()
const askedAbout = (server: string, channel: string) =>
  perm.asked.some((q) => q.server === server && q.channel === channel)

/** In server A's channel, permission resolved. */
async function inChannelA() {
  perm.store.channels = [row(CHANNEL_A, SERVER_A)]
  perm.store.currentServerId = SERVER_A
  const wrapper = mountInput({ channelId: CHANNEL_A })
  await flushPromises()
  await answer(SERVER_A, CHANNEL_A, true)
  expect(refused(wrapper)).toBe(false)
  perm.asked.length = 0
  return wrapper
}

beforeEach(() => {
  perm.asked.length = 0
  perm.pending.clear()
  perm.store.channels = []
  perm.store.currentServerId = null
})

describe('MessageInput send permission on a server switch', () => {
  it('keeps the field when the answer for the new server and the old channel arrives last', async () => {
    const wrapper = await inChannelA()

    // The store moves to server B; the route still shows A's channel.
    perm.store.channels = [row(CHANNEL_B, SERVER_B)]
    perm.store.currentServerId = SERVER_B
    await flushPromises()
    expect(askedAbout(SERVER_B, CHANNEL_A)).toBe(true)

    await wrapper.setProps({ channelId: CHANNEL_B })
    await flushPromises()
    expect(askedAbout(SERVER_B, CHANNEL_B)).toBe(true)

    await answer(SERVER_B, CHANNEL_B, true)
    await answer(SERVER_B, CHANNEL_A, false)
    expect(refused(wrapper)).toBe(false)
  })

  it('keeps the field when that answer arrives first', async () => {
    const wrapper = await inChannelA()
    perm.store.channels = [row(CHANNEL_B, SERVER_B)]
    perm.store.currentServerId = SERVER_B
    await flushPromises()
    await wrapper.setProps({ channelId: CHANNEL_B })
    await flushPromises()

    await answer(SERVER_B, CHANNEL_A, false)
    expect(refused(wrapper)).toBe(false)
    await answer(SERVER_B, CHANNEL_B, true)
    expect(refused(wrapper)).toBe(false)
  })

  it('asks about the channel\'s own server while the store still holds its row', async () => {
    const wrapper = await inChannelA()

    perm.store.channels = [row(CHANNEL_A, SERVER_A), row(CHANNEL_B, SERVER_B)]
    perm.store.currentServerId = SERVER_B
    await flushPromises()
    expect(askedAbout(SERVER_B, CHANNEL_A)).toBe(false)

    await wrapper.setProps({ channelId: CHANNEL_B })
    await flushPromises()
    await answer(SERVER_B, CHANNEL_B, true)
    expect(refused(wrapper)).toBe(false)
  })

  it('refuses when the newest question is answered no', async () => {
    const wrapper = await inChannelA()
    perm.store.channels = [row(CHANNEL_B, SERVER_B)]
    perm.store.currentServerId = SERVER_B
    await flushPromises()
    await wrapper.setProps({ channelId: CHANNEL_B })
    await flushPromises()

    await answer(SERVER_B, CHANNEL_A, true)
    await answer(SERVER_B, CHANNEL_B, false)
    expect(refused(wrapper)).toBe(true)
  })

  it('holds for a thread: the question names the thread\'s channel', async () => {
    const wrapper = await inChannelA()
    perm.store.channels = [row(CHANNEL_B, SERVER_B)]
    perm.store.currentServerId = SERVER_B
    await flushPromises()
    await wrapper.setProps({ channelId: undefined, threadId: THREAD_B, threadChannelId: CHANNEL_B })
    await flushPromises()

    await answer(SERVER_B, CHANNEL_B, true)
    await answer(SERVER_B, CHANNEL_A, false)
    expect(refused(wrapper)).toBe(false)
  })
})
