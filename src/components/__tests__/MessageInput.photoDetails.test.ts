/**
 * "Keep photo details" in the chat composer: a picked photo starts with the account's default,
 * its upload strips or keeps metadata accordingly, and the other choice uploads it again and
 * deletes the object of the first.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

const toast = { error: vi.fn(), info: vi.fn() }
const settings = vi.hoisted(() => ({ keepByDefault: false, ready: async () => {} }))
const discarded = vi.hoisted(() => [] as string[])
const { UploadAbortedError } = vi.hoisted(() => ({ UploadAbortedError: class extends Error {} }))
const handles: Array<{
  path: string
  options: { keepMetadata?: boolean }
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
vi.mock('@/stores/photoDetailsSettings', () => ({ usePhotoDetailsSettingsStore: () => settings }))
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
    UploadAbortedError,
    discardMessageMediaUpload: (path: string) => discarded.push(path),
    forgetMessageMediaUpload: vi.fn(),
    prepareMessageMediaUploads: vi.fn(),
    startMessageMediaUpload: vi.fn((path: string, _file: File, options: { keepMetadata?: boolean }) => {
      let resolve!: (value: { path: string; url: string }) => void
      let reject!: (error: Error) => void
      const result = new Promise<{ path: string; url: string }>((res, rej) => { resolve = res; reject = rej })
      result.catch(() => {})
      const handle = { path, options, state: vueReactive({ progress: 0, status: 'uploading', error: null }), result, abort: vi.fn(), resolve, reject }
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
vi.mock('@/components/FilePreview.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'FilePreview',
      props: { files: { type: Array, default: () => [] } },
      emits: ['remove-file', 'set-keep-details'],
      render: () => h('div'),
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
import type { FilePreviewData } from '../FilePreview.vue'

const JPEG = readFileSync(resolve(__dirname, '../../../tests/fixtures/media-metadata/gps-rotated.jpg'))

const mountInput = () => mount(MessageInput, {
  props: { modelValue: '', channelId: '66666666-0000-4000-8000-000000000006' },
  global: { mocks: { $t: (key: string) => key } },
})

type Wrapper = ReturnType<typeof mountInput>

const attach = async (wrapper: Wrapper, file: File) => {
  URL.createObjectURL = vi.fn(() => `blob:${file.name}`)
  wrapper.findComponent({ name: 'FileUploadMenu' }).vm.$emit('files-selected', [file])
  await flushPromises()
}

const previews = (wrapper: Wrapper) => wrapper.findComponent({ name: 'FilePreview' }).props('files') as FilePreviewData[]
const photo = () => new File([JPEG], 'IMG_0001.jpg', { type: 'image/jpeg' })

beforeEach(() => {
  handles.length = 0
  discarded.length = 0
  settings.keepByDefault = false
  URL.revokeObjectURL = vi.fn()
})

describe('MessageInput photo details', () => {
  it('starts a photo with Keep photo details off and uploads it stripped', async () => {
    const wrapper = mountInput()
    await attach(wrapper, photo())
    const [file] = previews(wrapper)
    expect(file.keepDetails).toBe(false)
    expect(file.photoDetails).toEqual({ container: 'jpeg', location: true, details: true })
    expect(handles).toHaveLength(1)
    expect(handles[0].options.keepMetadata).toBe(false)
    wrapper.unmount()
  })

  it('starts with Keep photo details on when the account keeps them by default', async () => {
    settings.keepByDefault = true
    const wrapper = mountInput()
    await attach(wrapper, photo())
    expect(previews(wrapper)[0].keepDetails).toBe(true)
    expect(handles[0].options.keepMetadata).toBe(true)
    wrapper.unmount()
  })

  it('uploads a finished photo again with the other choice and deletes the first object', async () => {
    const wrapper = mountInput()
    await attach(wrapper, photo())
    handles[0].resolve({ path: handles[0].path, url: 'https://signed/first' })
    await flushPromises()
    expect(previews(wrapper)[0].uploadStatus).toBe('completed')

    wrapper.findComponent({ name: 'FilePreview' }).vm.$emit('set-keep-details', 0, true)
    await flushPromises()
    expect(discarded).toEqual([handles[0].path])
    expect(handles).toHaveLength(2)
    expect(handles[1].options.keepMetadata).toBe(true)
    const [file] = previews(wrapper)
    expect(file.keepDetails).toBe(true)
    expect(file.uploadStatus).toBe('uploading')
    expect(file.uploadedPath).toBeUndefined()
    wrapper.unmount()
  })

  it('aborts a running upload for the other choice; its late answer changes nothing', async () => {
    const wrapper = mountInput()
    await attach(wrapper, photo())
    wrapper.findComponent({ name: 'FilePreview' }).vm.$emit('set-keep-details', 0, true)
    await flushPromises()
    expect(handles[0].abort).toHaveBeenCalled()
    expect(discarded).toEqual([])

    handles[0].reject(new UploadAbortedError())
    await flushPromises()
    expect(previews(wrapper)).toHaveLength(1)
    expect(previews(wrapper)[0].uploadStatus).toBe('uploading')

    handles[1].resolve({ path: handles[1].path, url: 'https://signed/second' })
    await flushPromises()
    expect(previews(wrapper)[0]).toMatchObject({ uploadStatus: 'completed', uploadedUrl: 'https://signed/second' })
    wrapper.unmount()
  })

  it('leaves other files without the choice', async () => {
    const wrapper = mountInput()
    await attach(wrapper, new File(['%PDF-1.7'], 'notes.pdf', { type: 'application/pdf' }))
    await flushPromises()
    const [file] = previews(wrapper)
    expect(file.keepDetails).toBeUndefined()
    expect(file.photoDetails).toBeUndefined()
    expect(handles[0].options.keepMetadata).toBe(false)
    wrapper.unmount()
  })
})
