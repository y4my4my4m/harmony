/**
 * Composer attachments belong to the draft of their context. A keyed composer that unmounts
 * or shows another draft leaves them with their draft: previews, alt text, spoiler names and
 * running uploads come back with it, progress included. Sending empties the draft; a
 * composer without a key discards its attachments with it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

const ROOM_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ROOM_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const DRAFT_A = `channel:${ROOM_A}`
const DRAFT_B = `channel:${ROOM_B}`

const toast = { error: vi.fn(), info: vi.fn() }
const handles: Array<{
  path: string
  state: { progress: number; status: string; error: string | null }
  result: Promise<{ path: string; url: string }>
  abort: ReturnType<typeof vi.fn>
  resolve: (value: { path: string; url: string }) => void
  progress: (fraction: number) => void
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
  mediaRoom: ({ channelId }: { channelId?: string }) => (channelId ? `c/${channelId}` : null),
  messageMediaPath: (room: string, uploader: string, name: string) => `${room}/${uploader}/${name}`,
  uploadMessageMedia: vi.fn(),
  compatUrlFor: vi.fn(async (path: string) => `https://signed/${path}`),
  messageMediaReferenceUrl: (path: string) => `https://ref/${path}`,
}))
vi.mock('@/services/messageMediaUpload', async () => {
  const { reactive: vueReactive } = await import('vue')
  return {
    UploadAbortedError: class extends Error {},
    forgetMessageMediaUpload: vi.fn(),
    prepareMessageMediaUploads: vi.fn(),
    startMessageMediaUpload: vi.fn((path: string, _file: File, options: { onProgress?: (fraction: number) => void }) => {
      let resolve!: (value: { path: string; url: string }) => void
      const result = new Promise<{ path: string; url: string }>((res) => { resolve = res })
      handles.push({
        path,
        state: vueReactive({ progress: 0, status: 'uploading', error: null }),
        result,
        abort: vi.fn(),
        resolve,
        progress: (fraction) => options.onProgress?.(fraction),
      })
      return handles[handles.length - 1]
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
// Renders what the composer shows of each file, so a test sees re-renders.
vi.mock('@/components/FilePreview.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'FilePreview',
      props: { files: { type: Array, default: () => [] } },
      emits: ['remove-file', 'toggle-spoiler', 'update-alt', 'toggle-temporary'],
      setup(props) {
        return () => h('ul', (props.files as Array<Record<string, unknown>>).map((file) =>
          h('li', `${file.name}|${file.uploadStatus}|${Math.round(Number(file.uploadProgress ?? 0))}|${file.altText ?? ''}`)))
      },
    }),
  }
})
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
import { resetDraftAttachments } from '@/stores/draftAttachments'
import { userStorage } from '@/utils/userScopedStorage'

const mountInput = (props: Record<string, unknown> = {}) => mount(MessageInput, {
  props: { modelValue: 'caption', channelId: ROOM_A, draftKey: DRAFT_A, ...props },
  global: { mocks: { $t: (key: string) => key } },
})

type Wrapper = ReturnType<typeof mountInput>

const shownFiles = (wrapper: Wrapper) => wrapper.findComponent({ name: 'FilePreview' }).findAll('li').map((li) => li.text())

const attach = async (wrapper: Wrapper, name = 'a.png') => {
  wrapper.findComponent({ name: 'FileUploadMenu' }).vm.$emit('files-selected', [new File(['x'], name, { type: 'image/png' })])
  await flushPromises()
}

const pressEnter = async (wrapper: Wrapper) => {
  wrapper.findComponent({ name: 'RichTextEditor' }).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
  await flushPromises()
}

beforeEach(() => {
  resetDraftAttachments()
  localStorage.clear()
  userStorage.setCurrentUser('uid-1')
  handles.length = 0
  toast.error.mockClear()
  toast.info.mockClear()
  URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`)
  URL.revokeObjectURL = vi.fn()
})

describe('MessageInput attachments in the draft', () => {
  it('brings back previews, alt text, spoiler names and a running upload when the composer comes back', async () => {
    const first = mountInput({ backgroundSend: true })
    await attach(first)
    const preview = first.findComponent({ name: 'FilePreview' })
    preview.vm.$emit('update-alt', 0, 'a cat')
    preview.vm.$emit('toggle-spoiler', 0)
    handles[0].progress(0.4)
    await flushPromises()
    expect(shownFiles(first)).toEqual(['SPOILER_a.png|uploading|40|a cat'])

    first.unmount()
    expect(handles[0].abort).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    handles[0].progress(0.7)

    const second = mountInput({ backgroundSend: true })
    await flushPromises()
    expect(shownFiles(second)).toEqual(['SPOILER_a.png|uploading|70|a cat'])
    expect(second.findComponent({ name: 'FilePreview' }).props('files')).toMatchObject([{ preview: 'blob:a.png' }])
    expect(second.emitted('upload-status-changed')?.at(-1)).toEqual([true])

    handles[0].progress(0.9)
    await flushPromises()
    expect(shownFiles(second)).toEqual(['SPOILER_a.png|uploading|90|a cat'])

    handles[0].resolve({ path: handles[0].path, url: 'https://signed/a' })
    await flushPromises()
    expect(shownFiles(second)).toEqual(['SPOILER_a.png|completed|100|a cat'])
    expect(second.emitted('upload-status-changed')?.at(-1)).toEqual([false])

    await pressEnter(second)
    const [[, files]] = second.emitted('sendMessage') as [[string, Array<Record<string, unknown>>]]
    expect(files).toMatchObject([{ name: 'SPOILER_a.png', altText: 'a cat', uploadedUrl: 'https://signed/a' }])
  })

  it('shows each draft its own attachments and uploads them to its room', async () => {
    const wrapper = mountInput()
    await attach(wrapper, 'a.png')

    await wrapper.setProps({ draftKey: DRAFT_B, channelId: ROOM_B })
    expect(shownFiles(wrapper)).toEqual([])
    await attach(wrapper, 'b.png')
    expect(handles[1].path.startsWith(`c/${ROOM_B}/`)).toBe(true)

    await wrapper.setProps({ draftKey: DRAFT_A, channelId: ROOM_A })
    expect(shownFiles(wrapper)).toEqual(['a.png|uploading|0|'])
    expect(handles[0].path.startsWith(`c/${ROOM_A}/`)).toBe(true)

    await wrapper.setProps({ draftKey: DRAFT_B, channelId: ROOM_B })
    expect(shownFiles(wrapper)).toEqual(['b.png|uploading|0|'])
    expect(handles.every((handle) => !handle.abort.mock.calls.length)).toBe(true)
  })

  it('empties the draft on send, so it comes back without the sent attachments', async () => {
    const first = mountInput({ backgroundSend: true })
    await attach(first)
    await pressEnter(first)
    expect(first.emitted('sendMessage')).toHaveLength(1)
    expect(shownFiles(first)).toEqual([])
    first.unmount()

    const second = mountInput({ backgroundSend: true })
    await flushPromises()
    expect(shownFiles(second)).toEqual([])
    expect(handles[0].abort).not.toHaveBeenCalled()
  })

  it('frees a removed attachment', async () => {
    const wrapper = mountInput()
    await attach(wrapper)
    wrapper.findComponent({ name: 'FilePreview' }).vm.$emit('remove-file', 0)
    await flushPromises()

    expect(shownFiles(wrapper)).toEqual([])
    expect(handles[0].abort).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a.png')
  })

  it('discards the attachments of a composer without a draft key with it', async () => {
    const first = mountInput({ draftKey: undefined })
    await attach(first)
    first.unmount()
    expect(handles[0].abort).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a.png')

    const second = mountInput({ draftKey: undefined })
    expect(shownFiles(second)).toEqual([])
  })

  it('drops a send held for uploads when the composer shows another draft', async () => {
    const wrapper = mountInput()
    await attach(wrapper)
    await pressEnter(wrapper)
    expect(toast.info).toHaveBeenCalledWith('message.upload.sendWhenDone')

    await wrapper.setProps({ draftKey: DRAFT_B, channelId: ROOM_B, modelValue: 'other text' })
    handles[0].resolve({ path: handles[0].path, url: 'https://signed/a' })
    await flushPromises()
    await wrapper.setProps({ draftKey: DRAFT_A, channelId: ROOM_A, modelValue: 'caption' })
    await flushPromises()

    expect(wrapper.emitted('sendMessage')).toBeUndefined()
    expect(shownFiles(wrapper)).toEqual(['a.png|completed|100|'])
  })
})
