/**
 * The composer's typing context. A thread started from a message has no row until its first
 * reply: ThreadView hands the composer draftThreadId(message), Realtime refuses
 * `typing:thread:draft:<id>`, and nobody else can open that thread. Such a composer announces no
 * typing, in the thread or in its parent channel.
 */

import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

const CHANNEL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const THREAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const typing = vi.hoisted(() => ({ context: null as null | (() => unknown) }))

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
  return {
    useTypingIndicator: (context: () => unknown) => {
      typing.context = context
      return { typingUsers: vueRef([]), startTyping: vi.fn(), stopTyping: vi.fn() }
    },
  }
})
vi.mock('@/composables/useFrequentEmojis', () => ({ useFrequentEmojis: () => ({ recordEmojiUsage: vi.fn() }) }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({ getUserDisplayName: () => ({ value: 'Unknown User' }) }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'uid-1' } } }) }))
vi.mock('@/stores/photoDetailsSettings', () => ({ usePhotoDetailsSettingsStore: () => ({ keepByDefault: false, ready: async () => {} }) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ channels: [{ id: CHANNEL, server_id: 'server-1', type: 0, name: 'general' }], currentServerId: 'server-1', currentChannelId: CHANNEL }),
}))
vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => ({ settings: { maxMessageLength: 2000, maxMediaAttachmentsPerPost: 10 } }),
}))
vi.mock('@/services/RoleService', () => ({
  roleService: { hasPermission: vi.fn(async () => true) },
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
import { draftThreadId } from '@/utils/draftThreadId'

const contextFor = async (props: Record<string, unknown>) => {
  typing.context = null
  mount(MessageInput, { props: { modelValue: '', ...props }, global: { mocks: { $t: (key: string) => key } } })
  await flushPromises()
  return typing.context!()
}

describe('MessageInput typing context', () => {
  it('announces typing in an existing thread', async () => {
    expect(await contextFor({ threadId: THREAD, threadChannelId: CHANNEL })).toEqual({ type: 'thread', threadId: THREAD })
  })

  it('announces nothing for a draft thread, in the thread or its channel', async () => {
    expect(await contextFor({ threadId: draftThreadId('m1'), threadChannelId: CHANNEL, channelId: CHANNEL })).toBeNull()
  })

  it('announces typing in a channel', async () => {
    expect(await contextFor({ channelId: CHANNEL })).toEqual({ type: 'channel', channelId: CHANNEL })
  })
})
