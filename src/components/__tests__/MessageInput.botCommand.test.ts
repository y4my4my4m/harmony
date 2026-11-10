/**
 * The composer and bot slash commands: '/' asks for the bots of the server channel or thread the
 * composer writes to, never a DM or a draft thread; while a bot command is open its options bar
 * replaces the text field, and closing it brings the field back.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

const suggest = vi.hoisted(() => ({
  config: null as null | { botCommandTarget?: () => unknown },
  active: null as null | { value: unknown },
  dismissBotCommand: vi.fn(),
}))

vi.mock('@/composables/useViewport', () => ({
  useViewport: () => ({ isMobileViewport: ref(false), isTouchOnly: false }),
}))
vi.mock('@/composables/useAutoSuggest', async () => {
  const { ref: vueRef } = await import('vue')
  return {
    useAutoSuggest: (_input: unknown, _get: unknown, _update: unknown, config: { botCommandTarget?: () => unknown }) => {
      suggest.config = config
      const activeBotCommand = vueRef<unknown>(null)
      suggest.active = activeBotCommand
      return {
        state: vueRef({ isActive: false, selectedIndex: 0, position: { top: 0, left: 0 } }),
        suggestions: vueRef([]),
        headerText: vueRef(''),
        activeCommand: vueRef(null),
        activeBotCommand,
        handleInput: vi.fn(),
        handleKeyDown: vi.fn(() => false),
        selectSuggestion: vi.fn(),
        closeSuggestions: vi.fn(),
        dismissActiveCommand: vi.fn(),
        dismissBotCommand: () => {
          suggest.dismissBotCommand()
          activeBotCommand.value = null
        },
      }
    },
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
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({
    channels: [{ id: '11111111-1111-4111-8111-111111111111', server_id: 'server-1', type: 0, name: 'general' }],
    currentServerId: 'server-1',
    currentChannelId: null,
  }),
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
// MessageInput loads the bar with defineAsyncComponent, which unwraps a module by __esModule.
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

const CHANNEL = '11111111-1111-4111-8111-111111111111'
const THREAD = '22222222-2222-4222-8222-222222222222'

const mountInput = (props: Record<string, unknown>) => mount(MessageInput, {
  props: { modelValue: '', ...props },
  global: { mocks: { $t: (key: string) => key } },
})

const target = () => suggest.config!.botCommandTarget!() as { channelId: string; threadId: string | null } | null

beforeEach(() => {
  suggest.config = null
  suggest.dismissBotCommand.mockClear()
})

describe('MessageInput bot commands', () => {
  // useAutoSuggest.isBotCommandTarget refuses the draft id ('draft:<parent>').
  it('names the channel, or the thread and its channel, and nothing in a DM', () => {
    mountInput({ channelId: CHANNEL })
    expect(target()).toEqual({ channelId: CHANNEL, threadId: null })

    mountInput({ threadId: THREAD, threadChannelId: CHANNEL })
    expect(target()).toEqual({ channelId: CHANNEL, threadId: THREAD })

    mountInput({ conversationId: '33333333-3333-4333-8333-333333333333' })
    expect(target()).toBeNull()

    mountInput({ threadId: `draft:${THREAD}`, threadChannelId: CHANNEL })
    expect(target()).toEqual({ channelId: CHANNEL, threadId: `draft:${THREAD}` })
  })

  it('swaps the text field for the options bar while a bot command is open', async () => {
    const wrapper = mountInput({ channelId: CHANNEL })
    await flushPromises()
    expect(wrapper.findComponent({ name: 'BotCommandBar' }).exists()).toBe(false)
    expect(wrapper.find('.message-container').isVisible()).toBe(true)

    const command = { fullName: 'weather', channelId: CHANNEL, threadId: null, options: [], bot: { id: 'b1' } }
    suggest.active!.value = command
    await flushPromises()
    const bar = wrapper.findComponent({ name: 'BotCommandBar' })
    expect(bar.exists()).toBe(true)
    expect(bar.props()).toMatchObject({ command, serverId: 'server-1' })
    expect((wrapper.find('.message-container').element as HTMLElement).style.display).toBe('none')

    bar.vm.$emit('invoked', 'i-1')
    await flushPromises()
    expect(suggest.dismissBotCommand).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent({ name: 'BotCommandBar' }).exists()).toBe(false)
    expect((wrapper.find('.message-container').element as HTMLElement).style.display).toBe('')
  })

  it('closes the options bar on a channel change', async () => {
    const wrapper = mountInput({ channelId: CHANNEL })
    suggest.active!.value = { fullName: 'weather', channelId: CHANNEL, threadId: null, options: [], bot: { id: 'b1' } }
    await flushPromises()
    await wrapper.setProps({ channelId: '44444444-4444-4444-8444-444444444444' })
    await flushPromises()
    expect(suggest.dismissBotCommand).toHaveBeenCalled()
    expect(wrapper.findComponent({ name: 'BotCommandBar' }).exists()).toBe(false)
  })
})
