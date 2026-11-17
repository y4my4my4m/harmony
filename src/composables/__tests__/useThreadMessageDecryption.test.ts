import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@/types'
import { useThreadMessageDecryption } from '../useThreadMessageDecryption'
import { processMessageDecryption } from '@/utils/messageDecryption'
import { threadService } from '@/services/ThreadService'

vi.mock('@/utils/messageDecryption', () => ({ processMessageDecryption: vi.fn() }))
vi.mock('@/services/ThreadService', () => ({ threadService: { updateMessageInCache: vi.fn() } }))

const encrypted = (id = 'reply', userId = 'sender'): Message =>
  ({
    id,
    user_id: userId,
    channel_id: 'parent-channel',
    thread_id: 'thread',
    content: [{ type: 'text', text: 'ciphertext' }],
    encrypted: true,
    encryption_metadata: { session_id: 'session' }
  }) as Message
const plaintext = (message: Message): Message => ({
  ...message,
  content: [{ type: 'text', text: 'readable reply' }],
  encrypted: false,
  decrypted: true
})
const scopes: ReturnType<typeof effectScope>[] = []
const settle = async () => {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function setup(initial: Message[] = []) {
  const messages = ref(initial)
  const id = ref('thread')
  const scope = effectScope()
  scopes.push(scope)
  scope.run(() => useThreadMessageDecryption(messages, () => id.value))
  return { messages, id, scope }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(processMessageDecryption).mockImplementation(async (rows) => rows.map(plaintext))
})
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop())
})

describe('thread message decryption', () => {
  it('decrypts history for the sender and other readers using the parent channel', async () => {
    const { messages } = setup([encrypted(), encrypted('other-reply', 'other-reader')])
    await settle()
    expect(messages.value.every((message) => message.decrypted)).toBe(true)
    expect(processMessageDecryption).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ channel_id: 'parent-channel', thread_id: 'thread' })
      ])
    )
    expect(threadService.updateMessageInCache).toHaveBeenCalledTimes(2)
  })

  it('decrypts send responses, live replies and edited ciphertext', async () => {
    const { messages } = setup()
    messages.value.push(encrypted())
    await settle()
    expect(messages.value[0].content).toEqual(plaintext(encrypted()).content)
    messages.value.push(encrypted('live-reply', 'other-reader'))
    await settle()
    expect(messages.value[1].decrypted).toBe(true)
    messages.value[0] = encrypted()
    await settle()
    expect(messages.value[0].decrypted).toBe(true)
    expect(processMessageDecryption).toHaveBeenCalledTimes(3)
  })

  it('keeps ciphertext on failure without looping, and retries when keys arrive', async () => {
    vi.mocked(processMessageDecryption).mockImplementationOnce(async (rows) =>
      rows.map((row) => ({ ...row, decrypted: false }))
    )
    const { messages } = setup([encrypted()])
    await settle()
    expect(messages.value[0].encrypted).toBe(true)
    expect(processMessageDecryption).toHaveBeenCalledTimes(1)
    window.dispatchEvent(
      new CustomEvent('megolm-key-received', { detail: { roomId: 'parent-channel' } })
    )
    await settle()
    expect(messages.value[0].decrypted).toBe(true)
  })

  it('does not write a decryption result into a different thread', async () => {
    let resolve!: (rows: Message[]) => void
    vi.mocked(processMessageDecryption).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const { messages, id } = setup([encrypted()])
    id.value = 'another-thread'
    const replacement = encrypted('new-reply')
    messages.value = [replacement]
    resolve([plaintext(encrypted())])
    await settle()
    expect(messages.value.map((row) => row.id)).toEqual(['new-reply'])
    expect(threadService.updateMessageInCache).not.toHaveBeenCalledWith(
      'thread',
      'reply',
      expect.anything()
    )
  })

  it('does not overwrite a newer edit while an earlier decryption is pending', async () => {
    let resolve!: (rows: Message[]) => void
    vi.mocked(processMessageDecryption).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const { messages } = setup([encrypted()])
    const edited = {
      ...plaintext(encrypted()),
      content: [{ type: 'text', text: 'newer edit' }]
    } as Message
    messages.value[0] = edited
    resolve([plaintext(encrypted())])
    await settle()
    expect(messages.value[0].content).toEqual(edited.content)
    expect(threadService.updateMessageInCache).not.toHaveBeenCalled()
  })

  it('does not apply a pending result after disposal', async () => {
    let resolve!: (rows: Message[]) => void
    vi.mocked(processMessageDecryption).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const { messages, scope } = setup([encrypted()])
    scope.stop()
    resolve([plaintext(encrypted())])
    await settle()
    expect(messages.value[0].encrypted).toBe(true)
    expect(threadService.updateMessageInCache).not.toHaveBeenCalled()
  })

  it('ignores plaintext and removes its key listener when disposed', async () => {
    const { messages, scope } = setup([plaintext(encrypted())])
    await settle()
    scope.stop()
    messages.value = [encrypted()]
    window.dispatchEvent(new CustomEvent('megolm-key-received'))
    await settle()
    expect(processMessageDecryption).not.toHaveBeenCalled()
  })
})
