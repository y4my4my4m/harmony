import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@/types'
import { useThreadMessageDecryption } from '../useThreadMessageDecryption'
import { threadService } from '@/services/ThreadService'

vi.mock('@/services/ThreadService', () => ({
  threadService: { readableMessages: vi.fn(), updateMessageInCache: vi.fn() },
}))

const readableMessages = vi.mocked(threadService.readableMessages)

const encrypted = (id = 'reply', userId = 'sender'): Message =>
  ({
    id,
    user_id: userId,
    channel_id: 'parent-channel',
    thread_id: 'thread',
    content: [{ type: 'text', text: 'ciphertext' }],
    encrypted: true,
    encryption_metadata: { session_id: 'session' },
  }) as Message
const plaintext = (message: Message, text = 'readable reply'): Message => ({
  ...message,
  content: [{ type: 'text', text }],
  encrypted: false,
  decrypted: true,
})
const failed = (message: Message): Message => ({ ...message, decrypted: false })

const deferred = () => {
  let resolve!: (rows: Message[]) => void
  const promise = new Promise<Message[]>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const scopes: ReturnType<typeof effectScope>[] = []
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve()
    await nextTick()
  }
}
const keyArrives = (roomId?: string) =>
  window.dispatchEvent(new CustomEvent('megolm-key-received', { detail: roomId ? { roomId } : undefined }))

function setup(initial: Message[] = [], parent?: Message) {
  const messages = ref(initial)
  const thread = ref<{ id: string; channel_id: string; parent_message?: Message }>({
    id: 'thread',
    channel_id: 'parent-channel',
    parent_message: parent,
  })
  const scope = effectScope()
  scopes.push(scope)
  const api = scope.run(() => useThreadMessageDecryption(messages, () => thread.value))!
  return { messages, thread, scope, ...api }
}

beforeEach(() => {
  vi.clearAllMocks()
  readableMessages.mockImplementation(async (rows) => rows.map((row) => plaintext(row)))
})
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop())
})

describe('realtime arrivals', () => {
  it('lands a reply readable', async () => {
    const { readableArrival } = setup()
    const row = await readableArrival(encrypted('live', 'other-reader'))
    expect(row).toMatchObject({ id: 'live', decrypted: true, content: [{ type: 'text', text: 'readable reply' }] })
  })

  it('drops a reply decrypted after the view moved to another thread', async () => {
    const pending = deferred()
    readableMessages.mockReturnValueOnce(pending.promise)
    const { readableArrival, thread } = setup()
    const arrival = readableArrival(encrypted('live'))
    thread.value = { id: 'another-thread', channel_id: 'parent-channel' }
    pending.resolve([plaintext(encrypted('live'))])
    expect(await arrival).toBeNull()
  })

  it('drops a reply decrypted after the view closed', async () => {
    const pending = deferred()
    readableMessages.mockReturnValueOnce(pending.promise)
    const { readableArrival, scope } = setup()
    const arrival = readableArrival(encrypted('live'))
    scope.stop()
    pending.resolve([plaintext(encrypted('live'))])
    expect(await arrival).toBeNull()
  })
})

describe('realtime updates', () => {
  const update = (text: string, extra: Record<string, unknown> = {}) => ({
    id: 'reply',
    channel_id: 'parent-channel',
    content: [{ type: 'text', text }],
    encrypted: true,
    encryption_metadata: { session_id: 'session', message_index: 1 },
    ...extra,
  })

  it('decrypts edited ciphertext', async () => {
    readableMessages.mockImplementationOnce(async (rows) => [plaintext(rows[0], 'edited reply')])
    const { readableUpdate } = setup()
    const fields = await readableUpdate(update('new ciphertext'))
    expect(fields).toMatchObject({
      content: [{ type: 'text', text: 'edited reply' }],
      decrypted: true,
      encryption_metadata: { session_id: 'session', message_index: 1 },
    })
    expect(readableMessages).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'reply', channel_id: 'parent-channel', encrypted: true }),
    ])
  })

  it('clears the decrypted mark when the stored row is plaintext', async () => {
    readableMessages.mockImplementationOnce(async (rows) => rows)
    const { readableUpdate } = setup()
    const fields = await readableUpdate(update('plain now', { encrypted: false, encryption_metadata: null }))
    expect(fields).toMatchObject({ content: [{ type: 'text', text: 'plain now' }], encrypted: false, decrypted: false })
  })

  it('keeps ciphertext marked undecrypted when the key is absent', async () => {
    readableMessages.mockImplementationOnce(async (rows) => [failed(rows[0])])
    const { readableUpdate } = setup()
    const fields = await readableUpdate(update('new ciphertext'))
    expect(fields).toMatchObject({ content: [{ type: 'text', text: 'new ciphertext' }], encrypted: true, decrypted: false })
  })

  it('drops an older update answered after a newer one', async () => {
    const older = deferred()
    readableMessages.mockReturnValueOnce(older.promise)
    readableMessages.mockImplementationOnce(async (rows) => [plaintext(rows[0], 'second edit')])
    const { readableUpdate } = setup()
    const first = readableUpdate(update('first ciphertext'))
    const second = await readableUpdate(update('second ciphertext'))
    older.resolve([plaintext(encrypted(), 'first edit')])
    expect(second?.content).toEqual([{ type: 'text', text: 'second edit' }])
    expect(await first).toBeNull()
  })

  it('drops an older update still pending when a third arrives after the second landed', async () => {
    const older = deferred()
    const third = deferred()
    readableMessages.mockReturnValueOnce(older.promise)
    readableMessages.mockImplementationOnce(async (rows) => [plaintext(rows[0], 'second edit')])
    readableMessages.mockReturnValueOnce(third.promise)
    const { readableUpdate } = setup()
    const first = readableUpdate(update('first ciphertext'))
    await readableUpdate(update('second ciphertext'))
    const last = readableUpdate(update('third ciphertext'))
    older.resolve([plaintext(encrypted(), 'first edit')])
    third.resolve([plaintext(encrypted(), 'third edit')])
    expect(await first).toBeNull()
    expect((await last)?.content).toEqual([{ type: 'text', text: 'third edit' }])
  })

  it('drops an update decrypted after the view moved to another thread', async () => {
    const pending = deferred()
    readableMessages.mockReturnValueOnce(pending.promise)
    const { readableUpdate, thread } = setup()
    const fields = readableUpdate(update('ciphertext'))
    thread.value = { id: 'another-thread', channel_id: 'parent-channel' }
    pending.resolve([plaintext(encrypted())])
    expect(await fields).toBeNull()
  })
})

describe('keys arriving', () => {
  it('decrypts sealed replies and the parent when a key for the parent channel arrives', async () => {
    readableMessages.mockImplementation(async (rows) => rows.map((row) => plaintext(row, `open ${row.id}`)))
    const { messages, thread } = setup(
      [failed(encrypted('a')), plaintext(encrypted('b')), failed(encrypted('c', 'other-reader'))],
      failed(encrypted('parent')),
    )
    keyArrives('parent-channel')
    await settle()
    expect(readableMessages).toHaveBeenCalledTimes(1)
    expect(readableMessages.mock.calls[0][0].map((row) => row.id)).toEqual(['a', 'c', 'parent'])
    expect(messages.value.map((row) => row.decrypted)).toEqual([true, true, true])
    expect(messages.value[0].content).toEqual([{ type: 'text', text: 'open a' }])
    expect(thread.value.parent_message?.content).toEqual([{ type: 'text', text: 'open parent' }])
    expect(threadService.updateMessageInCache).toHaveBeenCalledWith('thread', 'a', expect.objectContaining({ decrypted: true }))
    expect(threadService.updateMessageInCache).toHaveBeenCalledWith('thread', 'c', expect.objectContaining({ decrypted: true }))
  })

  it('retries on an unlock, which names every room', async () => {
    const { messages } = setup([failed(encrypted())])
    keyArrives('*')
    await settle()
    expect(messages.value[0].decrypted).toBe(true)
  })

  it('ignores keys of other rooms', async () => {
    setup([failed(encrypted())])
    keyArrives('another-channel')
    await settle()
    expect(readableMessages).not.toHaveBeenCalled()
  })

  it('leaves rows that still fail in place', async () => {
    readableMessages.mockImplementation(async (rows) => rows.map(failed))
    const row = failed(encrypted())
    const { messages } = setup([row])
    const before = messages.value[0]
    keyArrives('parent-channel')
    await settle()
    expect(messages.value[0]).toBe(before)
    expect(threadService.updateMessageInCache).not.toHaveBeenCalled()
  })

  it('shows a row that became unrecoverable', async () => {
    readableMessages.mockImplementation(async (rows) => rows.map((r) => ({ ...failed(r), decryption_unrecoverable: true })))
    const { messages } = setup([failed(encrypted())])
    keyArrives('parent-channel')
    await settle()
    expect(messages.value[0].decryption_unrecoverable).toBe(true)
  })

  it('does not overwrite a row replaced during the pass', async () => {
    const pending = deferred()
    readableMessages.mockReturnValueOnce(pending.promise)
    const { messages } = setup([failed(encrypted())])
    keyArrives('parent-channel')
    await settle()
    const edited = plaintext(encrypted(), 'newer edit')
    messages.value[0] = edited
    pending.resolve([plaintext(encrypted(), 'stale')])
    await settle()
    expect(messages.value[0].content).toEqual(edited.content)
    expect(threadService.updateMessageInCache).not.toHaveBeenCalled()
  })

  it('does not write a result into another thread', async () => {
    const pending = deferred()
    readableMessages.mockReturnValueOnce(pending.promise)
    const { messages, thread } = setup([failed(encrypted())])
    keyArrives('parent-channel')
    await settle()
    thread.value = { id: 'another-thread', channel_id: 'parent-channel' }
    const other = failed(encrypted('other-thread-reply'))
    messages.value = [other]
    pending.resolve([plaintext(encrypted())])
    await settle()
    expect(messages.value).toEqual([other])
    expect(threadService.updateMessageInCache).not.toHaveBeenCalled()
  })

  it('runs one pass at a time and one more for keys arriving during it', async () => {
    const pending = deferred()
    readableMessages.mockReturnValueOnce(pending.promise)
    readableMessages.mockImplementationOnce(async (rows) => rows.map(failed))
    const { messages } = setup([failed(encrypted())])
    keyArrives('parent-channel')
    keyArrives('parent-channel')
    keyArrives('parent-channel')
    await settle()
    expect(readableMessages).toHaveBeenCalledTimes(1)
    pending.resolve(messages.value.map(failed))
    await settle()
    expect(readableMessages).toHaveBeenCalledTimes(2)
  })

  it('does not decrypt when the list changes', async () => {
    const { messages } = setup([failed(encrypted())])
    messages.value.push(failed(encrypted('another')))
    messages.value = [...messages.value]
    await settle()
    expect(readableMessages).not.toHaveBeenCalled()
  })

  it('stops listening when the view closes', async () => {
    const { messages, scope } = setup([failed(encrypted())])
    scope.stop()
    keyArrives('parent-channel')
    await settle()
    expect(readableMessages).not.toHaveBeenCalled()
    expect(messages.value[0].decrypted).toBe(false)
  })
})
