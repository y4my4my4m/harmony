import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { supabase } from '@/supabase'
import type { Message } from '@/types'

const chatStore = {
  sendMessage: vi.fn(),
  discardFailedMessage: vi.fn(),
}
const dmStore = {
  sendDMMessage: vi.fn(),
  discardFailedDMMessage: vi.fn(),
}
const toast = { error: vi.fn(), info: vi.fn() }
const authState: { session: { user: { id: string } } | null } = { session: null }

vi.mock('@/stores/useChat', () => ({ useChatStore: () => chatStore }))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => dmStore }))
vi.mock('@/stores/useServerWelcome', () => ({ useServerWelcomeStore: () => ({ handleRulesRejection: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => authState }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('@/utils/uploadValidation', () => ({
  validateImageUpload: vi.fn(async () => null),
  humanizeUploadError: (error: { message?: string }) => error?.message || 'Upload failed',
}))
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
vi.mock('@/services/privateMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/privateMedia')>()),
  preloadRemoteImageSource: vi.fn(async () => true),
}))

import { useOutboxStore, withPendingRows, type OutboxAttachment } from '@/stores/useOutbox'
import { messageMediaUploadState, startMessageMediaUpload } from '@/services/messageMediaUpload'
import { localMediaSource, resetMediaPartSources } from '@/services/privateMedia'

const SERVER = '11111111-0000-4000-8000-000000000001'
const CHANNEL = '66666666-0000-4000-8000-000000000006'
const OTHER_CHANNEL = '66666666-0000-4000-8000-000000000007'
const CONVERSATION = '77777777-0000-4000-8000-000000000007'
const UID = 'aaaaaaaa-0000-4000-8000-000000000001'
const PROFILE = 'bbbbbbbb-0000-4000-8000-000000000002'
const channelTarget = { kind: 'channel' as const, serverId: SERVER, channelId: CHANNEL }
const CHANNEL_KEY = `channel:${CHANNEL}`

class FakeXHR {
  static instances: FakeXHR[] = []
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: FormData | null = null
  status = 0
  responseText = ''
  aborted = false
  upload: { onprogress: ((event: Partial<ProgressEvent>) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  constructor() { FakeXHR.instances.push(this) }
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(name: string, value: string) { this.headers[name] = value }
  send(body: FormData) { this.body = body }
  abort() { this.aborted = true; this.onabort?.() }
  progress(loaded: number, total: number) { this.upload.onprogress?.({ lengthComputable: true, loaded, total }) }
  respond(status: number, body: object = {}) {
    this.status = status
    this.responseText = JSON.stringify(body)
    this.onload?.()
  }
}

const xhrFor = (path: string) => {
  const xhr = FakeXHR.instances.find((x) => x.url.endsWith(`/message_media/${path}`))
  if (!xhr) throw new Error(`no request for ${path}`)
  return xhr
}

const bucket = {
  createSignedUrl: vi.fn(async (path: string) => ({ data: { signedUrl: `https://signed/${path}` }, error: null })),
  createSignedUrls: vi.fn(async () => ({ data: [], error: null })),
  remove: vi.fn(async () => ({ data: [], error: null })),
  copy: vi.fn(async (_from: string, to: string) => ({ data: { path: to }, error: null })),
}

let objectUrls = 0
const attachment = (name: string, type = 'image/png'): OutboxAttachment => {
  const file = new File(['bytes'], name, { type })
  return { file, name, type, size: file.size, previewUrl: `blob:preview-${name}` }
}

const filePaths = (message: Message) =>
  message.content.filter((part) => part.type === 'file').map((part) => (part as { path: string }).path)

beforeEach(() => {
  setActivePinia(createPinia())
  FakeXHR.instances = []
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  vi.mocked(supabase.storage.from).mockReturnValue(bucket as never)
  URL.createObjectURL = vi.fn(() => `blob:created-${++objectUrls}`)
  URL.revokeObjectURL = vi.fn()
  resetMediaPartSources()
  chatStore.sendMessage.mockReset().mockImplementation(async () => ({ id: 'real-1' }))
  chatStore.discardFailedMessage.mockReset()
  dmStore.sendDMMessage.mockReset().mockResolvedValue(true)
  dmStore.discardFailedDMMessage.mockReset()
  bucket.remove.mockClear()
  toast.error.mockClear()
  toast.info.mockClear()
  authState.session = { user: { id: UID } }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('outbox job lifecycle', () => {
  it('shows a pending row at Enter, reports real progress and sends with the row id and nonce', async () => {
    const outbox = useOutboxStore()
    const composerUpload = startMessageMediaUpload(`c/${CHANNEL}/${UID}/a.png`, attachment('a.png').file)
    await flushPromises()
    const xhr = xhrFor(composerUpload.path)
    xhr.progress(30, 100)

    const id = outbox.enqueue({
      target: channelTarget,
      authorId: PROFILE,
      uploaderId: UID,
      textParts: [{ type: 'text', text: 'hi' }],
      attachments: [{ ...attachment('a.png'), upload: composerUpload }],
    })

    const [row] = outbox.rowsFor(CHANNEL_KEY)
    expect(row).toMatchObject({ id, channel_id: CHANNEL, user_id: PROFILE, sending: true, failed: false })
    expect(row.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'file', url: 'blob:preview-a.png', path: composerUpload.path, fileType: 'image', fileName: 'a.png', fileSize: 5 },
    ])
    expect(localMediaSource(composerUpload.path)).toBe('blob:preview-a.png')
    expect(messageMediaUploadState(composerUpload.path)?.progress).toBeCloseTo(0.3)

    xhr.progress(80, 100)
    expect(messageMediaUploadState(composerUpload.path)?.progress).toBeCloseTo(0.8)
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    // One upload: the composer's request is adopted, not repeated.
    expect(FakeXHR.instances).toHaveLength(1)

    xhr.respond(200, { Key: `message_media/${composerUpload.path}` })
    await flushPromises()

    expect(chatStore.sendMessage).toHaveBeenCalledTimes(1)
    expect(chatStore.sendMessage).toHaveBeenCalledWith(
      SERVER,
      CHANNEL,
      PROFILE,
      [
        { type: 'text', text: 'hi' },
        {
          type: 'file',
          url: `https://signed/${composerUpload.path}`,
          path: composerUpload.path,
          fileType: 'image',
          fileName: 'a.png',
          fileSize: 5,
        },
      ],
      '',
      undefined,
      { allowPlaintextFallback: false, tempId: id, clientNonce: row.metadata?.client_nonce },
    )
    expect(outbox.rowsFor(CHANNEL_KEY)).toEqual([])
    expect(outbox.jobs).toHaveLength(0)
    expect(messageMediaUploadState(composerUpload.path)).toBeUndefined()
  })

  it('reserves new uploads in the target room and sends the parsed text', async () => {
    const outbox = useOutboxStore()
    let resolveParse!: (parts: Message['content']) => void
    const parsed = new Promise<Message['content']>((resolve) => { resolveParse = resolve })
    outbox.enqueue({
      target: channelTarget,
      authorId: PROFILE,
      uploaderId: UID,
      textParts: [{ type: 'text', text: ':wave:' }],
      parsedTextParts: parsed,
      attachments: [attachment('b.pdf', 'application/pdf')],
    })
    await flushPromises()

    const [row] = outbox.rowsFor(CHANNEL_KEY)
    const [path] = filePaths(row)
    expect(path).toMatch(new RegExp(`^c/${CHANNEL}/${UID}/[0-9a-f-]{36}\\.pdf$`))
    const xhr = xhrFor(path)
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe(`http://localhost:54321/storage/v1/object/message_media/${path}`)
    expect(xhr.headers).toMatchObject({ 'x-upsert': 'false', apikey: 'test-anon-key', Authorization: 'Bearer test-anon-key' })

    xhr.respond(200)
    await flushPromises()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()

    resolveParse([{ type: 'emoji', emoji: { id: 'e1', name: 'wave', url: 'u' } } as never])
    await flushPromises()
    expect(chatStore.sendMessage.mock.calls[0][3][0]).toMatchObject({ type: 'emoji' })
  })

  it('sends a DM with its voice metadata', async () => {
    const outbox = useOutboxStore()
    const voice = new File(['ogg'], 'voice.webm', { type: 'audio/webm' })
    const id = outbox.enqueue({
      target: { kind: 'dm', conversationId: CONVERSATION },
      authorId: PROFILE,
      uploaderId: UID,
      textParts: [],
      attachments: [{ file: voice, name: 'Voice message', type: 'audio/webm', size: voice.size }],
      extraMetadata: { voice_message: { duration: 3, waveform: [1, 2] } },
    })
    const [row] = outbox.rowsFor(`dm:${CONVERSATION}`)
    expect(row).toMatchObject({ conversation_id: CONVERSATION, metadata: { voice_message: { duration: 3 } } })
    const [path] = filePaths(row)
    expect(path).toMatch(new RegExp(`^d/${CONVERSATION}/${UID}/.+\\.webm$`))
    await flushPromises()

    xhrFor(path).respond(200)
    await flushPromises()
    expect(dmStore.sendDMMessage).toHaveBeenCalledWith(
      CONVERSATION,
      PROFILE,
      [expect.objectContaining({ type: 'file', path, fileType: 'audio', fileName: 'Voice message' })],
      undefined,
      {
        allowPlaintextFallback: false,
        tempId: id,
        clientNonce: row.metadata?.client_nonce,
        extraMetadata: { voice_message: { duration: 3, waveform: [1, 2] } },
      },
    )
    expect(outbox.jobs).toHaveLength(0)
  })

  it('sends to one target in Enter order', async () => {
    const outbox = useOutboxStore()
    outbox.enqueue({ target: channelTarget, authorId: PROFILE, uploaderId: UID, textParts: [{ type: 'text', text: 'first' }], attachments: [attachment('1.png')] })
    outbox.enqueue({ target: channelTarget, authorId: PROFILE, uploaderId: UID, textParts: [{ type: 'text', text: 'second' }], attachments: [attachment('2.png')] })
    await flushPromises()
    const [first, second] = outbox.rowsFor(CHANNEL_KEY)

    xhrFor(filePaths(second)[0]).respond(200)
    await flushPromises()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()

    xhrFor(filePaths(first)[0]).respond(200)
    await flushPromises()
    expect(chatStore.sendMessage.mock.calls.map((call) => call[3][0].text)).toEqual(['first', 'second'])
  })
})

describe('outbox independence from the view', () => {
  it('keeps uploading and sends to the Enter target after the composer unmounts', async () => {
    const outbox = useOutboxStore()
    const Composer = defineComponent({
      setup() {
        outbox.enqueue({ target: channelTarget, authorId: PROFILE, uploaderId: UID, textParts: [], attachments: [attachment('c.png')] })
        return () => h('div')
      },
    })
    const wrapper = mount(Composer)
    await flushPromises()
    wrapper.unmount()

    expect(outbox.rowsFor(CHANNEL_KEY)).toHaveLength(1)
    expect(outbox.rowsFor(`channel:${OTHER_CHANNEL}`)).toHaveLength(0)
    const [path] = filePaths(outbox.rowsFor(CHANNEL_KEY)[0])
    const xhr = xhrFor(path)
    expect(xhr.aborted).toBe(false)

    xhr.progress(50, 100)
    expect(messageMediaUploadState(path)?.progress).toBeCloseTo(0.5)
    xhr.respond(200)
    await flushPromises()
    expect(chatStore.sendMessage).toHaveBeenCalledWith(SERVER, CHANNEL, PROFILE, expect.any(Array), '', undefined, expect.any(Object))
  })

  it('prompts before unload only while a message is uploading or sending', async () => {
    const outbox = useOutboxStore()
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(unload()).toBe(false)

    outbox.enqueue({ target: channelTarget, authorId: PROFILE, uploaderId: UID, textParts: [], attachments: [attachment('d.png')] })
    await flushPromises()
    expect(unload()).toBe(true)

    xhrFor(filePaths(outbox.rowsFor(CHANNEL_KEY)[0])[0]).respond(200)
    await flushPromises()
    expect(unload()).toBe(false)
  })
})

describe('outbox failure, retry and discard', () => {
  it('fails the row on an upload error and retries only the attachments that did not complete', async () => {
    const outbox = useOutboxStore()
    const id = outbox.enqueue({
      target: channelTarget,
      authorId: PROFILE,
      uploaderId: UID,
      textParts: [],
      attachments: [attachment('ok.png'), attachment('bad.png')],
    })
    await flushPromises()
    const [okPath, badPath] = filePaths(outbox.rowsFor(CHANNEL_KEY)[0])

    xhrFor(okPath).respond(200)
    xhrFor(badPath).respond(500, { statusCode: '500', message: 'internal error' })
    await flushPromises()

    expect(outbox.rowsFor(CHANNEL_KEY)[0]).toMatchObject({ id, sending: false, failed: true })
    expect(messageMediaUploadState(badPath)).toMatchObject({ status: 'error', error: 'internal error' })
    expect(toast.error).toHaveBeenCalledWith('message.upload.failedToast')
    expect(chatStore.sendMessage).not.toHaveBeenCalled()

    outbox.retry(id)
    await flushPromises()
    expect(FakeXHR.instances).toHaveLength(3)
    const [keptPath, retriedPath] = filePaths(outbox.rowsFor(CHANNEL_KEY)[0])
    expect(keptPath).toBe(okPath)
    expect(retriedPath).not.toBe(badPath)
    expect(localMediaSource(retriedPath)).toBe('blob:preview-bad.png')
    expect(localMediaSource(badPath)).toBeUndefined()

    xhrFor(retriedPath).respond(200)
    await flushPromises()
    expect(chatStore.sendMessage).toHaveBeenCalledTimes(1)
    expect(chatStore.sendMessage.mock.calls[0][3].map((part: { path: string }) => part.path)).toEqual([okPath, retriedPath])
  })

  it('keeps the row, its id and nonce when the send fails', async () => {
    const outbox = useOutboxStore()
    chatStore.sendMessage.mockResolvedValueOnce(undefined)
    const id = outbox.enqueue({ target: channelTarget, authorId: PROFILE, uploaderId: UID, textParts: [], attachments: [attachment('e.png')] })
    await flushPromises()
    const [row] = outbox.rowsFor(CHANNEL_KEY)
    xhrFor(filePaths(row)[0]).respond(200)
    await flushPromises()

    expect(chatStore.discardFailedMessage).toHaveBeenCalledWith(id)
    expect(outbox.rowsFor(CHANNEL_KEY)[0]).toMatchObject({ id, failed: true })

    outbox.retry(id)
    await flushPromises()
    expect(FakeXHR.instances).toHaveLength(1)
    expect(chatStore.sendMessage).toHaveBeenCalledTimes(2)
    const [, second] = chatStore.sendMessage.mock.calls
    expect(second[6]).toEqual({ allowPlaintextFallback: false, tempId: id, clientNonce: row.metadata?.client_nonce })
    expect(outbox.jobs).toHaveLength(0)
  })

  it('surfaces a rejected send and leaves the row failed', async () => {
    const outbox = useOutboxStore()
    chatStore.sendMessage.mockRejectedValueOnce(Object.assign(new Error('Blocked by AutoMod'), { code: 'AUTOMOD_BLOCKED' }))
    const id = outbox.enqueue({ target: channelTarget, authorId: PROFILE, uploaderId: UID, textParts: [], attachments: [attachment('f.png')] })
    await flushPromises()
    xhrFor(filePaths(outbox.rowsFor(CHANNEL_KEY)[0])[0]).respond(200)
    await flushPromises()

    expect(toast.error).toHaveBeenCalledWith('Blocked by AutoMod')
    expect(chatStore.discardFailedMessage).toHaveBeenCalledWith(id)
    expect(outbox.rowsFor(CHANNEL_KEY)[0]).toMatchObject({ id, failed: true })
  })

  it('discard aborts running uploads, deletes stored objects and revokes object URLs', async () => {
    const outbox = useOutboxStore()
    const id = outbox.enqueue({
      target: channelTarget,
      authorId: PROFILE,
      uploaderId: UID,
      textParts: [],
      attachments: [attachment('done.png'), attachment('running.png')],
    })
    await flushPromises()
    const [donePath, runningPath] = filePaths(outbox.rowsFor(CHANNEL_KEY)[0])
    xhrFor(donePath).respond(200)
    await flushPromises()

    outbox.discard(id)
    await flushPromises()

    expect(xhrFor(runningPath).aborted).toBe(true)
    expect(bucket.remove).toHaveBeenCalledWith([donePath])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-done.png')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-running.png')
    expect(localMediaSource(donePath)).toBeUndefined()
    expect(messageMediaUploadState(runningPath)).toBeUndefined()
    expect(outbox.rowsFor(CHANNEL_KEY)).toEqual([])
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
  })
})

describe('withPendingRows', () => {
  const row = (id: string, nonce: string) => ({ id, created_at: new Date(), content: [], metadata: { client_nonce: nonce } }) as Message

  it('appends pending rows the store does not hold', () => {
    const stored = [row('m1', 'n1')]
    expect(withPendingRows(stored, [])).toBe(stored)
    expect(withPendingRows(stored, [row('temp-2', 'n2')]).map((m) => m.id)).toEqual(['m1', 'temp-2'])
  })

  it('leaves out a row held as the optimistic copy or as the persisted message', () => {
    const stored = [row('temp-2', 'n2'), row('real-3', 'n3')]
    expect(withPendingRows(stored, [row('temp-2', 'n2'), row('temp-3', 'n3')])).toBe(stored)
  })
})

describe('outbox and the session', () => {
  it('reset aborts uploads, revokes object URLs and clears every registry', async () => {
    const outbox = useOutboxStore()
    outbox.enqueue({ target: channelTarget, authorId: PROFILE, uploaderId: UID, textParts: [], attachments: [attachment('clip.mp4', 'video/mp4')] })
    await flushPromises()
    const [videoPath] = filePaths(outbox.rowsFor(CHANNEL_KEY)[0])
    xhrFor(videoPath).respond(200)
    await flushPromises()
    // A sent video keeps its object URL while its row may be on screen.
    expect(outbox.jobs).toHaveLength(0)
    expect(localMediaSource(videoPath)).toBe('blob:preview-clip.mp4')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:preview-clip.mp4')

    outbox.enqueue({ target: channelTarget, authorId: PROFILE, uploaderId: UID, textParts: [], attachments: [attachment('running.png')] })
    await flushPromises()
    const [runningPath] = filePaths(outbox.rowsFor(CHANNEL_KEY)[0])

    outbox.reset()
    await flushPromises()

    expect(xhrFor(runningPath).aborted).toBe(true)
    expect(outbox.jobs).toEqual([])
    expect(outbox.rowsFor(CHANNEL_KEY)).toEqual([])
    expect(outbox.hasPendingUploads).toBe(false)
    expect(messageMediaUploadState(runningPath)).toBeUndefined()
    expect(localMediaSource(runningPath)).toBeUndefined()
    expect(localMediaSource(videoPath)).toBeUndefined()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-running.png')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-clip.mp4')
    expect(chatStore.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('does not send a job once its uploader is signed out', async () => {
    const outbox = useOutboxStore()
    const id = outbox.enqueue({ target: channelTarget, authorId: PROFILE, uploaderId: UID, textParts: [], attachments: [attachment('g.png')] })
    await flushPromises()
    authState.session = { user: { id: 'cccccccc-0000-4000-8000-000000000003' } }
    xhrFor(filePaths(outbox.rowsFor(CHANNEL_KEY)[0])[0]).respond(200)
    await flushPromises()

    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    expect(outbox.rowsFor(CHANNEL_KEY)[0]).toMatchObject({ id, failed: true })
  })
})

describe('outbox cancel', () => {
  it('offers cancel on running uploads, adopted ones included; cancel discards the message', async () => {
    const outbox = useOutboxStore()
    const composerUpload = startMessageMediaUpload(`c/${CHANNEL}/${UID}/adopted.png`, attachment('adopted.png').file)
    await flushPromises()
    const id = outbox.enqueue({
      target: channelTarget,
      authorId: PROFILE,
      uploaderId: UID,
      textParts: [],
      attachments: [attachment('done.png'), { ...attachment('adopted.png'), upload: composerUpload }],
    })
    await flushPromises()
    const [donePath, adoptedPath] = filePaths(outbox.rowsFor(CHANNEL_KEY)[0])
    expect(adoptedPath).toBe(composerUpload.path)
    xhrFor(donePath).respond(200)
    await flushPromises()

    const cancel = messageMediaUploadState(adoptedPath)?.cancel
    expect(cancel).toBeTypeOf('function')
    cancel!()
    await flushPromises()

    expect(outbox.has(id)).toBe(false)
    expect(composerUpload.state.status).toBe('aborted')
    expect(bucket.remove).toHaveBeenCalledWith([donePath])
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
  })

  it('cannot discard while the insert is in flight', async () => {
    const outbox = useOutboxStore()
    let finishSend!: (message: { id: string }) => void
    chatStore.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finishSend = resolve }))
    const id = outbox.enqueue({ target: channelTarget, authorId: PROFILE, uploaderId: UID, textParts: [], attachments: [attachment('i.png')] })
    await flushPromises()
    xhrFor(filePaths(outbox.rowsFor(CHANNEL_KEY)[0])[0]).respond(200)
    await flushPromises()
    expect(chatStore.sendMessage).toHaveBeenCalledTimes(1)

    outbox.discard(id)
    expect(outbox.has(id)).toBe(true)

    finishSend({ id: 'real-9' })
    await flushPromises()
    expect(outbox.has(id)).toBe(false)
    expect(bucket.remove).not.toHaveBeenCalled()
  })
})

describe('outbox slowmode', () => {
  const slowmode = (seconds: number) => Object.assign(
    new Error(`Slowmode is on - you can send again in ${seconds}s`),
    { code: 'SLOWMODE_ACTIVE', retryAfterSeconds: seconds },
  )

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits out a slowmode rejection and sends again with the same row id and nonce', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const outbox = useOutboxStore()
    chatStore.sendMessage.mockRejectedValueOnce(slowmode(2))
    const id = outbox.enqueue({ target: channelTarget, authorId: PROFILE, uploaderId: UID, textParts: [], attachments: [attachment('j.png')] })
    await flushPromises()
    const [row] = outbox.rowsFor(CHANNEL_KEY)
    xhrFor(filePaths(row)[0]).respond(200)
    await flushPromises()

    expect(chatStore.sendMessage).toHaveBeenCalledTimes(1)
    expect(toast.info).toHaveBeenCalledWith('Slowmode is on - you can send again in 2s')
    expect(outbox.rowsFor(CHANNEL_KEY)[0]).toMatchObject({ id, sending: true, failed: false })

    await vi.advanceTimersByTimeAsync(2000)
    expect(chatStore.sendMessage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(600)
    expect(chatStore.sendMessage).toHaveBeenCalledTimes(2)
    expect(chatStore.sendMessage.mock.calls[1][6]).toEqual({ allowPlaintextFallback: false, tempId: id, clientNonce: row.metadata?.client_nonce })
    expect(outbox.has(id)).toBe(false)
  })

  it('fails the row after a bounded number of slowmode retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const outbox = useOutboxStore()
    chatStore.sendMessage.mockRejectedValue(slowmode(1))
    const id = outbox.enqueue({ target: channelTarget, authorId: PROFILE, uploaderId: UID, textParts: [], attachments: [attachment('k.png')] })
    await flushPromises()
    xhrFor(filePaths(outbox.rowsFor(CHANNEL_KEY)[0])[0]).respond(200)
    await flushPromises()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(chatStore.sendMessage).toHaveBeenCalledTimes(4)
    expect(outbox.rowsFor(CHANNEL_KEY)[0]).toMatchObject({ id, failed: true })
  })
})

describe('outbox text parsing', () => {
  it('shows the parsed text on the pending row as soon as parsing resolves', async () => {
    const outbox = useOutboxStore()
    let resolveParse!: (parts: Message['content']) => void
    outbox.enqueue({
      target: channelTarget,
      authorId: PROFILE,
      uploaderId: UID,
      textParts: [{ type: 'text', text: ':wave:' }],
      parsedTextParts: new Promise((resolve) => { resolveParse = resolve }),
      attachments: [attachment('l.png')],
    })
    await flushPromises()
    expect(outbox.rowsFor(CHANNEL_KEY)[0].content[0]).toEqual({ type: 'text', text: ':wave:' })

    resolveParse([{ type: 'emoji', emoji: { id: 'e1', name: 'wave', url: 'u' } } as never])
    await flushPromises()

    expect(outbox.rowsFor(CHANNEL_KEY)[0].content[0]).toMatchObject({ type: 'emoji' })
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
  })
})
