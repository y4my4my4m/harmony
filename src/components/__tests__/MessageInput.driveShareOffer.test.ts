/**
 * The composer's Drive share offer belongs to the room it was checked for, and its text names
 * the people Share reaches.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, ref } from 'vue'

const drive = vi.hoisted(() => ({
  driveAvailable: vi.fn(async () => true),
  getDriveShareGap: vi.fn(),
  shareDriveFile: vi.fn(async () => ({})),
  setDriveTemporary: vi.fn(),
}))
const names = vi.hoisted(() => ({} as Record<string, string>))

vi.mock('@/services/drive/driveService', () => drive)
vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({ getUserDisplayName: (id: string) => computed(() => names[id] ?? 'Unknown User') }),
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
      handleInput: vi.fn(),
      handleKeyDown: vi.fn(() => false),
      selectSuggestion: vi.fn(),
      closeSuggestions: vi.fn(),
      dismissActiveCommand: vi.fn(),
    }),
  }
})
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerMessage: vi.fn(), triggerToggle: vi.fn() }) }))
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
  mediaRoom: () => 'c/private',
  messageMediaPath: (room: string, uploader: string, name: string) => `${room}/${uploader}/${name}`,
  uploadMessageMedia: vi.fn(),
  compatUrlFor: vi.fn(),
}))
vi.mock('@/services/messageMediaUpload', () => ({
  UploadAbortedError: class extends Error {},
  forgetMessageMediaUpload: vi.fn(),
  prepareMessageMediaUploads: vi.fn(),
  startMessageMediaUpload: vi.fn(),
}))
vi.mock('@/utils/ephemeralEmoji', () => ({ buildEphemeralEmojiFromGif: vi.fn(), registerEphemeralEmoji: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }) }))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}))

async function stub(name: string, emits: string[] = []) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, emits, render: () => h('div') }) }
}
vi.mock('@/components/TypingIndicator.vue', () => stub('TypingIndicator'))
vi.mock('@/components/MessageReply.vue', () => stub('MessageReply'))
vi.mock('@/components/FilePreview.vue', () => stub('FilePreview', ['remove-file']))
vi.mock('@/components/InlineGifPicker.vue', () => stub('InlineGifPicker'))
vi.mock('@/components/FileUploadMenu.vue', () => stub('FileUploadMenu', ['files-selected', 'close']))
vi.mock('@/components/drive/DrivePickerModal.vue', () => stub('DrivePickerModal'))
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
import { resetDriveShareOffers } from '@/composables/useDriveShareOffer'

const FILE = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b'
const link = () => `${window.location.protocol}//${window.location.host}/drive/file/${FILE}`

const mountInput = async (props: Record<string, unknown>) => {
  const wrapper = mount(MessageInput, { props: { modelValue: '', ...props }, global: { mocks: { $t: (key: string) => key } } })
  await flushPromises()
  return wrapper
}

type Wrapper = Awaited<ReturnType<typeof mountInput>>

const paste = async (wrapper: Wrapper) => {
  const event = new Event('paste', { bubbles: true }) as Event & { clipboardData: unknown }
  event.clipboardData = { getData: () => link() }
  wrapper.find('[data-testid="message-input"]').element.dispatchEvent(event)
  await flushPromises()
}

const offerText = (wrapper: Wrapper) => wrapper.find('[data-testid="drive-share-offer"]').exists()
  ? wrapper.find('[data-testid="drive-share-offer"] p').text()
  : null

beforeEach(() => {
  resetDriveShareOffers()
  drive.getDriveShareGap.mockReset()
  drive.shareDriveFile.mockClear()
  for (const key of Object.keys(names)) delete names[key]
})

describe('MessageInput Drive share offer', () => {
  it('shows no offer in the room switched to while the check for the last room was in flight', async () => {
    let answer!: (gap: unknown) => void
    drive.getDriveShareGap.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const wrapper = await mountInput({ channelId: 'private', channelName: 'private' })
    await paste(wrapper)
    expect(drive.getDriveShareGap).toHaveBeenCalledWith(FILE, { channelId: 'private' })

    await wrapper.setProps({ channelId: 'general', channelName: 'general' })
    answer({ scope: 'channel', target: 'private', missing: true })
    await flushPromises()

    expect(offerText(wrapper)).toBeNull()
    expect(drive.shareDriveFile).not.toHaveBeenCalled()
  })

  it('names the one participant who cannot open the file', async () => {
    names.bob = 'Bob'
    drive.getDriveShareGap.mockResolvedValueOnce({ scope: 'user', targets: ['bob'], missing: true })
    const wrapper = await mountInput({ conversationId: 'dm-1', username: 'Alice' })
    await paste(wrapper)
    expect(offerText(wrapper)).toBe('drive.offer.person {"name":"@Bob"}')
  })

  it('counts the participants of a group conversation Share reaches', async () => {
    names.bob = 'Bob'
    names.carol = 'Carol'
    drive.getDriveShareGap.mockResolvedValueOnce({ scope: 'user', targets: ['bob', 'carol'], missing: true })
    const wrapper = await mountInput({ conversationId: 'group-1', username: 'Alice' })
    await paste(wrapper)
    expect(offerText(wrapper)).toBe('drive.offer.people {"count":2}')

    await wrapper.find('[data-testid="drive-share-offer-share"]').trigger('click')
    await flushPromises()
    expect(drive.shareDriveFile.mock.calls).toEqual([[FILE, 'user', 'bob'], [FILE, 'user', 'carol']])
  })
})
