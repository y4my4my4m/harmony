/**
 * ChatComponent hands a message whose attachments are still uploading to the
 * outbox: it shows at once as a pending row and is sent to the channel open at
 * Enter once the uploads finish, wherever the view is by then.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, ref } from 'vue'
import { supabase } from '@/supabase'
import type { Message } from '@/types'

const SERVER = '11111111-0000-4000-8000-000000000001'
const CHANNEL = '66666666-0000-4000-8000-000000000006'
const OTHER_CHANNEL = '66666666-0000-4000-8000-000000000007'
const UID = 'aaaaaaaa-0000-4000-8000-000000000001'
const PROFILE = 'bbbbbbbb-0000-4000-8000-000000000002'

const shared = vi.hoisted(() => ({
  toast: { error: vi.fn(), info: vi.fn() },
  restoreAttachments: vi.fn(),
  drafts: {} as Record<string, string>,
  auth: { session: { user: { id: 'aaaaaaaa-0000-4000-8000-000000000001' } } as { user: { id: string } } | null },
}))

const chatStore = {
  sendMessage: vi.fn(async (..._args: unknown[]): Promise<{ id: string } | undefined> => ({ id: 'real-1' })),
  discardFailedMessage: vi.fn(),
  retryMessage: vi.fn(),
  addReaction: vi.fn(),
}
const dmStore = reactive({
  currentConversationId: null as string | null,
  getCurrentConversation: null,
  sendDMMessage: vi.fn(),
  discardFailedDMMessage: vi.fn(),
  retryDMMessage: vi.fn(),
})
const serverChannelStore = reactive({
  currentServerId: SERVER as string | null,
  currentChannelId: CHANNEL as string | null,
  currentServer: null,
  channels: [
    { id: CHANNEL, server_id: SERVER, name: 'general' },
    { id: OTHER_CHANNEL, server_id: SERVER, name: 'random' },
  ],
})

vi.mock('@/stores/useChat', () => ({ useChatStore: () => chatStore }))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => dmStore }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => serverChannelStore }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => shared.auth }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: PROFILE }) }))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio: vi.fn() }) }))
vi.mock('@/stores/drafts', () => ({
  useDraftsStore: () => ({
    makeKey: (kind: string, id: string) => `${kind}:${id}`,
    getDraft: (key: string) => shared.drafts[key] ?? '',
    saveDraft: (key: string, value: string) => {
      if (value.trim()) shared.drafts[key] = value
      else delete shared.drafts[key]
    },
    clearDraft: (key: string) => { delete shared.drafts[key] },
  }),
}))
vi.mock('@/stores/useServerWelcome', () => ({
  useServerWelcomeStore: () => ({ mustAccept: () => false, open: vi.fn(), handleRulesRejection: vi.fn() }),
}))
vi.mock('@/stores/useThreads', () => ({ useThreadsStore: () => ({ threadForMessage: vi.fn(), upsert: vi.fn() }) }))
vi.mock('@/stores/useChannelEncryption', () => ({ useChannelEncryptionStore: () => ({ applyEffective: vi.fn() }) }))
vi.mock('@/services/ChannelEncryptionService', () => ({
  fetchEffectiveChannelEncryption: vi.fn(async () => null),
  fetchServerForceKeySetup: vi.fn(async () => false),
  invalidateServerForceKeySetup: vi.fn(),
}))
vi.mock('@/services/core/channelMessageEncryption', () => ({ getEncryptionService: vi.fn(async () => null) }))
vi.mock('@/services/core/CoreMessageService', () => ({ coreMessageService: { postThreadCreatedNotice: vi.fn() } }))
vi.mock('@/services/ThreadService', () => ({ threadService: { getThreadForMessage: vi.fn() } }))
vi.mock('@/composables/useEncryptionAction', () => ({ ENCRYPTION_STATE_CHANGED_EVENT: 'harmony:encryption-state-changed' }))
vi.mock('@/composables/useEncryptionFallbackPrompt', () => ({
  useEncryptionFallbackPrompt: () => ({
    runWithEncryptionFallback: async (send: (args: { allowPlaintextFallback: boolean }) => Promise<unknown>) => {
      try {
        return { result: await send({ allowPlaintextFallback: false }), status: 'ok' }
      } catch (error) {
        return { status: 'error', error }
      }
    },
  }),
}))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({ hasCurrentUserPermission: () => true, Permission: {}, isCurrentUserServerOwner: ref(false) }),
}))
vi.mock('@/composables/useReactionLimits', () => ({
  useMessageReactionLimit: () => ({ isEmojiBlocked: () => false, limitNotice: ref(null) }),
}))
vi.mock('@/utils/unifiedContentProcessing', () => ({
  parseContentToMessageParts: vi.fn(async (input: string) => [{ type: 'text', text: input }]),
  resolveMentionsUserData: vi.fn(async () => ({})),
  resolveEmojisData: vi.fn(async () => ({})),
  resolveRoleMentionsData: vi.fn(async () => ({})),
}))
vi.mock('@/utils/chatParseOptions', () => ({ buildChatParseOptions: () => ({}) }))
vi.mock('@/services/emojiService', () => ({ recordEmojiUsage: vi.fn() }))
vi.mock('@/services/emojiShortcodeResolver', () => ({ getEmojiShortcodeForInsert: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn() }))
vi.mock('@/services/instanceConfig', () => ({ isTauriRuntime: () => false }))
vi.mock('@/utils/fileUpload', () => ({ getMimeTypeFromFilename: vi.fn() }))
vi.mock('@/utils/klipyAttribution', () => ({ isVideoMessageUrl: () => false }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-toastification', () => ({ useToast: () => shared.toast }))
vi.mock('@/utils/uploadValidation', () => ({
  validateImageUpload: vi.fn(async () => null),
  humanizeUploadError: (error: { message?: string }) => error?.message || 'Upload failed',
}))
vi.mock('@/services/privateMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/privateMedia')>()),
  preloadRemoteImageSource: vi.fn(async () => true),
}))

async function stub(name: string) {
  const { defineComponent: define, h: render } = await import('vue')
  return { default: define({ name, render: () => render('div') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/moderation/KickBanModal.vue', () => stub('KickBanModal'))
vi.mock('@/components/welcome/RulesAcceptPrompt.vue', () => stub('RulesAcceptPrompt'))
vi.mock('@/components/MediaPickerPopup.vue', () => stub('MediaPickerPopup'))
vi.mock('@/components/EmojiPopup.vue', () => stub('EmojiPopup'))
vi.mock('@/components/threads/ThreadView.vue', () => stub('ThreadView'))
vi.mock('@/components/MessageDisplay.vue', async () => {
  const { defineComponent: define, h: render } = await import('vue')
  return {
    default: define({
      name: 'MessageDisplay',
      props: { messages: { type: Array, default: () => [] } },
      render: () => render('div'),
    }),
  }
})
vi.mock('@/components/MessageInput.vue', async () => {
  const { defineComponent: define, h: render } = await import('vue')
  return {
    default: define({
      name: 'MessageInput',
      props: { backgroundSend: Boolean, modelValue: String },
      emits: ['sendMessage', 'queueVoiceMessage', 'update:modelValue'],
      setup(_props, { expose }) {
        expose({ restoreAttachments: shared.restoreAttachments })
        return () => render('div')
      },
    }),
  }
})

import ChatComponent from '../ChatComponent.vue'
import { startMessageMediaUpload } from '@/services/messageMediaUpload'
import type { FilePreviewData } from '@/components/FilePreview.vue'

class FakeXHR {
  static instances: FakeXHR[] = []
  url = ''
  status = 0
  responseText = ''
  upload: { onprogress: ((event: Partial<ProgressEvent>) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  constructor() { FakeXHR.instances.push(this) }
  open(_method: string, url: string) { this.url = url }
  setRequestHeader() {}
  send() {}
  abort() { this.onabort?.() }
}

const mountChat = () => mount(ChatComponent, {
  props: { messages: [] as Message[], channelId: CHANNEL, isLoading: false },
  global: { stubs: { Teleport: true } },
})

const displayed = (wrapper: ReturnType<typeof mountChat>) =>
  wrapper.findComponent({ name: 'MessageDisplay' }).props('messages') as Message[]

beforeEach(() => {
  setActivePinia(createPinia())
  FakeXHR.instances = []
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  URL.createObjectURL = vi.fn(() => 'blob:created')
  URL.revokeObjectURL = vi.fn()
  vi.mocked(supabase.storage.from).mockReturnValue({
    createSignedUrl: vi.fn(async (path: string) => ({ data: { signedUrl: `https://signed/${path}` }, error: null })),
    createSignedUrls: vi.fn(async () => ({ data: [], error: null })),
  } as never)
  chatStore.sendMessage.mockReset().mockImplementation(async () => ({ id: 'real-1' }))
  serverChannelStore.currentChannelId = CHANNEL
  shared.auth.session = { user: { id: UID } }
  shared.toast.error.mockClear()
  shared.restoreAttachments.mockClear()
  for (const key of Object.keys(shared.drafts)) delete shared.drafts[key]
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ChatComponent send with uploads running', () => {
  it('shows the message as a pending row and sends it to the Enter channel when the upload finishes', async () => {
    const wrapper = mountChat()
    expect(wrapper.findComponent({ name: 'MessageInput' }).props('backgroundSend')).toBe(true)

    const file = new File(['png'], 'cat.png', { type: 'image/png' })
    const upload = startMessageMediaUpload(`c/${CHANNEL}/${UID}/cat.png`, file)
    await flushPromises()
    const uploading: FilePreviewData = {
      file, name: 'cat.png', size: file.size, type: 'image/png',
      preview: 'blob:cat', uploadStatus: 'uploading', uploadProgress: 40, upload,
    }

    wrapper.findComponent({ name: 'MessageInput' }).vm.$emit('sendMessage', 'look', [uploading], undefined)
    await flushPromises()

    const [row] = displayed(wrapper)
    expect(row).toMatchObject({ channel_id: CHANNEL, user_id: PROFILE, sending: true })
    expect(row.id.startsWith('temp-')).toBe(true)
    expect(row.content).toEqual([
      { type: 'text', text: 'look' },
      expect.objectContaining({ type: 'file', url: 'blob:cat', path: upload.path, fileType: 'image' }),
    ])
    expect(chatStore.sendMessage).not.toHaveBeenCalled()

    // The user moves to another channel before the upload ends.
    await wrapper.setProps({ channelId: OTHER_CHANNEL })
    serverChannelStore.currentChannelId = OTHER_CHANNEL
    expect(displayed(wrapper)).toEqual([])

    const xhr = FakeXHR.instances[0]
    xhr.status = 200
    xhr.onload?.()
    await flushPromises()

    expect(chatStore.sendMessage).toHaveBeenCalledTimes(1)
    expect(chatStore.sendMessage).toHaveBeenCalledWith(
      SERVER,
      CHANNEL,
      PROFILE,
      [{ type: 'text', text: 'look' }, expect.objectContaining({ path: upload.path, url: `https://signed/${upload.path}` })],
      '',
      undefined,
      { allowPlaintextFallback: false, tempId: row.id, clientNonce: row.metadata?.client_nonce },
    )
  })

  it('queues a voice recording with its metadata', async () => {
    const wrapper = mountChat()
    const voice = new File(['ogg'], 'voice.webm', { type: 'audio/webm' })
    wrapper.findComponent({ name: 'MessageInput' }).vm.$emit('queueVoiceMessage', {
      file: voice, duration: 2, waveform: [3], mimeType: 'audio/webm',
    })
    await flushPromises()

    const [row] = displayed(wrapper)
    expect(row.metadata).toMatchObject({ voice_message: { duration: 2, waveform: [3] } })
    expect(row.content).toEqual([expect.objectContaining({ type: 'file', fileType: 'audio', fileName: 'Voice message' })])
  })
})

describe('ChatComponent with a failed outbox row', () => {
  it('discards the outbox job when the row is deleted', async () => {
    const wrapper = mountChat()
    const file = new File(['png'], 'bad.png', { type: 'image/png' })
    const attached: FilePreviewData = { file, name: 'bad.png', size: file.size, type: 'image/png', preview: 'blob:bad', uploadStatus: 'pending' }
    wrapper.findComponent({ name: 'MessageInput' }).vm.$emit('sendMessage', '', [attached], undefined)
    await flushPromises()
    const xhr = FakeXHR.instances[0]
    xhr.status = 500
    xhr.responseText = JSON.stringify({ message: 'boom' })
    xhr.onload?.()
    await flushPromises()

    const [row] = displayed(wrapper)
    expect(row).toMatchObject({ failed: true })
    wrapper.findComponent({ name: 'MessageDisplay' }).vm.$emit('discard-message', row)
    await flushPromises()

    expect(displayed(wrapper)).toEqual([])
    expect(chatStore.discardFailedMessage).toHaveBeenCalledWith(row.id)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:bad')
  })
})

describe('ChatComponent with a message it cannot queue', () => {
  it('puts the text and attachments back into the composer when the session is gone', async () => {
    const wrapper = mountChat()
    shared.auth.session = null
    const file = new File(['png'], 'dog.png', { type: 'image/png' })
    const attached: FilePreviewData = { file, name: 'dog.png', size: file.size, type: 'image/png', preview: 'blob:dog', uploadStatus: 'pending' }

    wrapper.findComponent({ name: 'MessageInput' }).vm.$emit('sendMessage', 'woof', [attached], undefined)
    await flushPromises()

    expect(shared.restoreAttachments).toHaveBeenCalledWith([attached])
    expect(wrapper.findComponent({ name: 'MessageInput' }).props('modelValue')).toBe('woof')
    expect(shared.toast.error).toHaveBeenCalledWith('message.upload.notSent')
    expect(displayed(wrapper)).toEqual([])
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
  })

  it('puts the attachments back when there is no channel to send to', async () => {
    const wrapper = mount(ChatComponent, {
      props: { messages: [] as Message[], isLoading: false },
      global: { stubs: { Teleport: true } },
    })
    serverChannelStore.currentChannelId = null
    const file = new File(['png'], 'cow.png', { type: 'image/png' })
    const attached: FilePreviewData = { file, name: 'cow.png', size: file.size, type: 'image/png', uploadStatus: 'pending' }

    wrapper.findComponent({ name: 'MessageInput' }).vm.$emit('sendMessage', '', [attached], undefined)
    await flushPromises()

    expect(shared.restoreAttachments).toHaveBeenCalledWith([attached])
    expect(shared.toast.error).toHaveBeenCalledWith('message.upload.notSent')
  })
})

describe('ChatComponent draft after a send', () => {
  it('keeps text typed into the sent channel while the send was in flight', async () => {
    let finishSend!: (message: { id: string }) => void
    chatStore.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finishSend = resolve }))
    const wrapper = mountChat()
    wrapper.findComponent({ name: 'MessageInput' }).vm.$emit('sendMessage', 'hello', [], undefined)
    await flushPromises()
    expect(chatStore.sendMessage).toHaveBeenCalledTimes(1)

    // The user leaves; the sent channel's draft meanwhile holds newer text.
    await wrapper.setProps({ channelId: OTHER_CHANNEL })
    shared.drafts[`channel:${CHANNEL}`] = 'typed later'

    finishSend({ id: 'real-2' })
    await flushPromises()
    expect(shared.drafts[`channel:${CHANNEL}`]).toBe('typed later')
  })

  it('clears the draft that still holds the sent text', async () => {
    let finishSend!: (message: { id: string }) => void
    chatStore.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finishSend = resolve }))
    const wrapper = mountChat()
    wrapper.findComponent({ name: 'MessageInput' }).vm.$emit('sendMessage', 'hello', [], undefined)
    await flushPromises()
    await wrapper.setProps({ channelId: OTHER_CHANNEL })
    shared.drafts[`channel:${CHANNEL}`] = 'hello'

    finishSend({ id: 'real-3' })
    await flushPromises()
    expect(shared.drafts[`channel:${CHANNEL}`]).toBeUndefined()
  })
})
