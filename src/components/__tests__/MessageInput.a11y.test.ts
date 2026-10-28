/**
 * The composer for screen-reader and keyboard users: image descriptions set in
 * the attachment preview travel with the files at Enter; attaching, uploads and
 * the character limit are announced at their thresholds only; the attach button
 * is a menu button.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { THROTTLE_MS, WRITE_DELAY_MS, announcerRegions, resetAnnouncer } from '@/composables/useAnnouncer'

const toast = { error: vi.fn(), info: vi.fn() }
const handles: Array<{
  path: string
  state: { progress: number; status: string; error: string | null }
  result: Promise<{ path: string; url: string }>
  abort: ReturnType<typeof vi.fn>
  resolve: (value: { path: string; url: string }) => void
  reject: (error: Error) => void
}> = []

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
      handleInput: vi.fn(),
      handleKeyDown: vi.fn(() => false),
      selectSuggestion: vi.fn(),
      closeSuggestions: vi.fn(),
      dismissActiveCommand: vi.fn(),
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
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ channels: [], currentServerId: null, currentChannelId: null }),
}))
vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => ({ settings: { maxMessageLength: 2000, maxMediaAttachmentsPerPost: 10 } }),
}))
vi.mock('@/services/RoleService', () => ({
  roleService: { hasPermission: vi.fn(async () => true) },
  Permission: { SEND_MESSAGES: 'SEND_MESSAGES', MANAGE_MESSAGES: 'MANAGE_MESSAGES' },
}))
vi.mock('@/services/privateMedia', () => ({
  mediaRoom: () => 'c/66666666-0000-4000-8000-000000000006',
  messageMediaPath: (room: string, uploader: string, name: string) => `${room}/${uploader}/${name}`,
  uploadMessageMedia: vi.fn(),
}))
vi.mock('@/services/messageMediaUpload', async () => {
  const { reactive: vueReactive } = await import('vue')
  return {
    UploadAbortedError: class extends Error {},
    forgetMessageMediaUpload: vi.fn(),
    prepareMessageMediaUploads: vi.fn(),
    startMessageMediaUpload: vi.fn((path: string) => {
      let resolve!: (value: { path: string; url: string }) => void
      let reject!: (error: Error) => void
      const result = new Promise<{ path: string; url: string }>((res, rej) => { resolve = res; reject = rej })
      const handle = { path, state: vueReactive({ progress: 0, status: 'uploading', error: null }), result, abort: vi.fn(), resolve, reject }
      handles.push(handle)
      return handle
    }),
  }
})
vi.mock('@/utils/ephemeralEmoji', () => ({ buildEphemeralEmojiFromGif: vi.fn(), registerEphemeralEmoji: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

async function stub(name: string, emits: string[] = [], props: string[] = []) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, emits, props, render: () => h('div') }) }
}
vi.mock('@/components/TypingIndicator.vue', () => stub('TypingIndicator'))
vi.mock('@/components/MessageReply.vue', () => stub('MessageReply'))
vi.mock('@/components/FilePreview.vue', () => stub('FilePreview', ['remove-file', 'update-alt'], ['files']))
vi.mock('@/components/InlineGifPicker.vue', () => stub('InlineGifPicker'))
vi.mock('@/components/FileUploadMenu.vue', () =>
  stub('FileUploadMenu', ['files-selected', 'close', 'create-poll'], ['isVisible', 'allowPoll', 'anchor', 'menuId', 'initialFocus']))
vi.mock('@/components/AutoSuggest.vue', () => stub('AutoSuggest'))
vi.mock('@/components/EmojiUI.vue', () => stub('EmojiUI'))
vi.mock('@/components/icons/Gif.vue', () => stub('GifIcon'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/icons/Plus.vue', () => stub('PlusIcon', ['click']))
vi.mock('@/components/VoiceRecorder.vue', () => stub('VoiceRecorder', ['recording-complete', 'recording-started', 'recording-cancelled']))
vi.mock('@/components/RichTextEditor.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'RichTextEditor',
      props: { modelValue: { type: String, default: '' } },
      emits: ['update:modelValue', 'input', 'keydown', 'focus', 'blur', 'cursor-position-changed', 'paste'],
      setup(props, { expose }) {
        expose({ focus: vi.fn(), clear: vi.fn(), getPlainText: () => props.modelValue })
        return () => h('div')
      },
    }),
  }
})

import MessageInput from '../MessageInput.vue'

const mountInput = (props: Record<string, unknown> = {}) => mount(MessageInput, {
  props: { modelValue: 'caption', channelId: '66666666-0000-4000-8000-000000000006', ...props },
  global: { mocks: { $t: (key: string) => key } },
})

type Wrapper = ReturnType<typeof mountInput>

const attach = async (wrapper: Wrapper, name = 'a.png') => {
  URL.createObjectURL = vi.fn(() => `blob:${name}`)
  wrapper.findComponent({ name: 'FileUploadMenu' }).vm.$emit('files-selected', [new File(['x'], name, { type: 'image/png' })])
  await flushPromises()
}

const pressEnter = async (wrapper: Wrapper) => {
  wrapper.findComponent({ name: 'RichTextEditor' }).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
  await flushPromises()
}

const { politeText, assertiveText } = announcerRegions()

/** Runs the announcer's flush and its clear-then-write. */
const settle = () => vi.advanceTimersByTime(THROTTLE_MS + WRITE_DELAY_MS + 1)

beforeEach(() => {
  handles.length = 0
  toast.error.mockClear()
  toast.info.mockClear()
  URL.revokeObjectURL = vi.fn()
  resetAnnouncer()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  resetAnnouncer()
})

describe('MessageInput image descriptions', () => {
  it('stores the description from the preview and sends it with the file', async () => {
    const wrapper = mountInput({ backgroundSend: true })
    await attach(wrapper, 'sunset.png')
    wrapper.findComponent({ name: 'FilePreview' }).vm.$emit('update-alt', 0, '  A red sunset  ')
    await flushPromises()
    settle()
    expect(politeText.value).toContain('messageA11y.alt.saved')
    expect(wrapper.findComponent({ name: 'FilePreview' }).props('files')[0].altText).toBe('A red sunset')

    await pressEnter(wrapper)
    const [, files] = wrapper.emitted('sendMessage')![0] as [string, Array<{ name: string; altText?: string }>]
    expect(files[0]).toMatchObject({ name: 'sunset.png', altText: 'A red sunset' })
  })

  it('clears a description saved empty', async () => {
    const wrapper = mountInput({ backgroundSend: true })
    await attach(wrapper, 'a.png')
    const preview = wrapper.findComponent({ name: 'FilePreview' })
    preview.vm.$emit('update-alt', 0, 'something')
    preview.vm.$emit('update-alt', 0, '   ')
    await flushPromises()
    expect(preview.props('files')[0].altText).toBeUndefined()
  })
})

describe('MessageInput announcements', () => {
  it('says files were attached, and how each upload ended', async () => {
    const wrapper = mountInput()
    await attach(wrapper, 'a.png')
    settle()
    expect(politeText.value).toBe('messageA11y.upload.attached')

    handles[0].resolve({ path: handles[0].path, url: 'https://x/a.png' })
    await flushPromises()
    settle()
    expect(politeText.value).toBe('messageA11y.upload.done')

    await attach(wrapper, 'b.png')
    handles[1].reject(new Error('boom'))
    await flushPromises()
    settle()
    expect(assertiveText.value).toBe('message.upload.failedToast')
  })

  it('announces the character limit at its thresholds, not per keystroke', async () => {
    const wrapper = mountInput({ modelValue: '' })
    const spoken: string[] = []
    const record = () => {
      settle()
      if (politeText.value) spoken.push(`polite:${politeText.value}`)
      if (assertiveText.value) spoken.push(`assertive:${assertiveText.value}`)
      resetAnnouncer()
    }
    for (const length of [1000, 1800, 1801, 1802, 2001, 2002, 1990]) {
      await wrapper.setProps({ modelValue: 'x'.repeat(length) })
      record()
    }
    expect(spoken).toEqual([
      'polite:messageA11y.composer.nearLimit',
      'assertive:messageA11y.composer.overLimit',
      'polite:messageA11y.composer.backUnderLimit',
    ])
    expect(wrapper.get('.message-char-count').attributes('aria-live')).toBeUndefined()
  })
})

describe('MessageInput attach button', () => {
  it('is a menu button that opens the upload menu anchored to it', async () => {
    const wrapper = mountInput()
    const button = wrapper.get('[data-testid="composer-attach"]')
    expect(button.element.tagName).toBe('BUTTON')
    expect(button.attributes('aria-label')).toBe('messageA11y.composer.attach')
    expect(button.attributes('aria-haspopup')).toBe('menu')
    expect(button.attributes('aria-expanded')).toBe('false')

    await button.trigger('keydown', { key: 'ArrowUp' })
    expect(button.attributes('aria-expanded')).toBe('true')
    const menu = wrapper.findComponent({ name: 'FileUploadMenu' })
    expect(menu.props('isVisible')).toBe(true)
    expect(menu.props('anchor')).toBe(button.element)
    expect(menu.props('initialFocus')).toBe('last')
    expect(button.attributes('aria-controls')).toBe(menu.props('menuId'))

    menu.vm.$emit('close', 'escape')
    await flushPromises()
    expect(button.attributes('aria-expanded')).toBe('false')
  })

  it('names the GIF button from its visible text', () => {
    const wrapper = mountInput()
    const gif = wrapper.get('[data-testid="composer-gif"]')
    expect(gif.attributes('aria-label')).toBe('messageA11y.composer.gif')
    expect(gif.attributes('aria-haspopup')).toBe('dialog')
  })
})
