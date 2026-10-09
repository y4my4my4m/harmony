/**
 * MessageInput with attachments uploading at Enter. With backgroundSend the files,
 * previews and running uploads go to the parent and the composer clears. Without
 * it the send waits for the uploads with the composer intact. A failed attachment
 * blocks the send.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

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
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'uid-1' } } }) }))
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

async function stub(name: string, emits: string[] = []) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, emits, render: () => h('div') }) }
}
vi.mock('@/components/TypingIndicator.vue', () => stub('TypingIndicator'))
vi.mock('@/components/MessageReply.vue', () => stub('MessageReply'))
vi.mock('@/components/FilePreview.vue', () => stub('FilePreview', ['remove-file']))
vi.mock('@/components/InlineGifPicker.vue', () => stub('InlineGifPicker'))
vi.mock('@/components/FileUploadMenu.vue', () => stub('FileUploadMenu', ['files-selected', 'close']))
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

beforeEach(() => {
  handles.length = 0
  toast.error.mockClear()
  toast.info.mockClear()
  URL.revokeObjectURL = vi.fn()
})

describe('MessageInput send with uploads running', () => {
  it('hands running uploads to a backgroundSend parent and clears the composer', async () => {
    const wrapper = mountInput({ backgroundSend: true })
    await attach(wrapper)
    expect(handles).toHaveLength(1)

    await pressEnter(wrapper)

    const [[content, files]] = wrapper.emitted('sendMessage') as [[string, Array<Record<string, unknown>>]]
    expect(content).toBe('caption')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ name: 'a.png', preview: 'blob:a.png', uploadStatus: 'uploading' })
    expect(files[0].upload).toBe(handles[0])
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([''])
    expect(handles[0].abort).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('waits for running uploads without backgroundSend, then sends', async () => {
    const wrapper = mountInput()
    await attach(wrapper)

    await pressEnter(wrapper)
    expect(wrapper.emitted('sendMessage')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(toast.info).toHaveBeenCalledWith('message.upload.sendWhenDone')

    handles[0].resolve({ path: handles[0].path, url: 'https://signed/a' })
    await flushPromises()

    const [[content, files]] = wrapper.emitted('sendMessage') as [[string, Array<Record<string, unknown>>]]
    expect(content).toBe('caption')
    expect(files[0]).toMatchObject({ uploadStatus: 'completed', uploadedPath: handles[0].path, uploadedUrl: 'https://signed/a' })
  })

  it('refuses a send with a failed attachment and keeps the draft', async () => {
    const wrapper = mountInput({ backgroundSend: true })
    await attach(wrapper)
    handles[0].reject(new Error('too large'))
    await flushPromises()

    await pressEnter(wrapper)
    expect(wrapper.emitted('sendMessage')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(toast.error).toHaveBeenCalledWith('message.upload.removeFailed')
  })

  it('queues a recording with backgroundSend instead of uploading it', async () => {
    const wrapper = mountInput({ backgroundSend: true, modelValue: '' })
    const blob = new Blob(['ogg'], { type: 'audio/webm' })
    wrapper.findAllComponents({ name: 'VoiceRecorder' })[0].vm.$emit('recording-complete', {
      blob, duration: 4, waveform: [1, 2], mimeType: 'audio/webm',
    })
    await flushPromises()

    const [[queued]] = wrapper.emitted('queueVoiceMessage') as [[{ file: File; duration: number }]]
    expect(queued.file.name).toBe('voice.webm')
    expect(queued.file.type).toBe('audio/webm')
    expect(queued.duration).toBe(4)
    expect(wrapper.emitted('sendVoiceMessage')).toBeUndefined()
  })

  it('takes back attachments the parent could not queue, with their running uploads', async () => {
    const wrapper = mountInput({ backgroundSend: true })
    await attach(wrapper)
    await pressEnter(wrapper)
    const [[, files]] = wrapper.emitted('sendMessage') as [[string, Array<Record<string, unknown>>]]

    ;(wrapper.vm as unknown as { restoreAttachments: (f: unknown[]) => void }).restoreAttachments(files)
    await flushPromises()
    handles[0].resolve({ path: handles[0].path, url: 'https://signed/a' })
    await flushPromises()

    await wrapper.setProps({ modelValue: 'again' })
    await pressEnter(wrapper)
    const resent = (wrapper.emitted('sendMessage') as Array<[string, Array<Record<string, unknown>>]>)[1]
    expect(resent[0]).toBe('again')
    expect(resent[1][0]).toMatchObject({ name: 'a.png', uploadStatus: 'completed', uploadedUrl: 'https://signed/a' })
  })
})
