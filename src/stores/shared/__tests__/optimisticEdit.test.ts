import { describe, it, expect, beforeEach } from 'vitest'
import { reactive } from 'vue'
import { keepPendingEdit, resetOptimisticEdits, saveEditOptimistically } from '@/stores/shared/optimisticEdit'
import { resetSendOrder } from '@/stores/shared/sendOrder'
import type { Message, MessagePart } from '@/types'

const CREATED = '2026-10-01T00:00:00.000Z'
const text = (t: string): MessagePart[] => [{ type: 'text', text: t } as MessagePart]
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function shownMessage(): Message {
  return reactive({
    id: 'm1',
    channel_id: 'c1',
    user_id: 'me',
    content: text('before'),
    created_at: new Date(CREATED),
    reactions: [{ emoji_id: 'e', count: 2 }],
  }) as unknown as Message
}

/** A save the test answers or refuses; records the content each request carried. */
function heldSaves() {
  const requests: Array<{ content: MessagePart[]; answer: (fields?: Partial<Message>) => void; refuse: (e: Error) => void }> = []
  const saveOf = (content: MessagePart[]) => () => new Promise<Message>((resolve, reject) => {
    requests.push({
      content,
      answer: (fields = {}) => resolve({
        id: 'm1', channel_id: 'c1', user_id: 'me', content, created_at: CREATED,
        updated_at: '2026-10-01T00:05:00.000Z', ...fields,
      } as Message),
      refuse: reject,
    })
  })
  return { requests, saveOf }
}

beforeEach(() => {
  resetOptimisticEdits()
  resetSendOrder()
})

describe('optimistic edit', () => {
  it('shows the new content at once, marked edited and pending', async () => {
    const message = shownMessage()
    const { saveOf } = heldSaves()
    void saveEditOptimistically({
      message, content: text('after'), patch: (f) => Object.assign(message, f), save: saveOf(text('after')),
    })
    expect(message.content).toEqual(text('after'))
    expect(message.edit_pending).toBe(true)
    expect(new Date(message.updated_at!).getTime()).toBeGreaterThan(new Date(CREATED).getTime())
    expect(message.reactions).toHaveLength(1)
  })

  it('takes the stored row\'s fields when the server answers', async () => {
    const message = shownMessage()
    const { requests, saveOf } = heldSaves()
    const saved = saveEditOptimistically({
      message, content: text('after'), patch: (f) => Object.assign(message, f), save: saveOf(text('after')),
    })
    await tick()
    requests[0].answer()
    expect(await saved).toMatchObject({ id: 'm1' })
    expect(message.edit_pending).toBe(false)
    expect(message.content).toEqual(text('after'))
    expect(new Date(message.updated_at!).toISOString()).toBe('2026-10-01T00:05:00.000Z')
  })

  it('restores the previous content when the server refuses, and rethrows', async () => {
    const message = shownMessage()
    const { requests, saveOf } = heldSaves()
    const saved = saveEditOptimistically({
      message, content: text('after'), patch: (f) => Object.assign(message, f), save: saveOf(text('after')),
    })
    await tick()
    requests[0].refuse(new Error('500'))
    await expect(saved).rejects.toThrow('500')
    expect(message.content).toEqual(text('before'))
    expect(message.updated_at).toBeUndefined()
    expect(message.edit_pending).toBe(false)
  })

  it('keeps the plaintext of an encrypted edit, marked decrypted', async () => {
    const message = shownMessage()
    const { requests, saveOf } = heldSaves()
    const saved = saveEditOptimistically({
      message, content: text('secret'), patch: (f) => Object.assign(message, f), save: saveOf(text('secret')),
    })
    await tick()
    requests[0].answer({ content: text('CIPHERTEXT'), encrypted: true, encryption_metadata: { algorithm: 'megolm_v3' } as any })
    await saved
    expect(message.content).toEqual(text('secret'))
    expect(message.decrypted).toBe(true)
    expect(message.encrypted).toBe(true)
  })

  it('the last local edit wins: edits are saved in order and an older answer leaves the screen alone', async () => {
    const message = shownMessage()
    const { requests, saveOf } = heldSaves()
    const patch = (f: Partial<Message>) => Object.assign(message, f)
    const first = saveEditOptimistically({ message, content: text('one'), patch, save: saveOf(text('one')) })
    const second = saveEditOptimistically({ message, content: text('two'), patch, save: saveOf(text('two')) })
    await tick()
    expect(message.content).toEqual(text('two'))
    expect(requests.map((r) => r.content)).toEqual([text('one')])

    requests[0].answer()
    expect(await first).toBeNull()
    expect(message.content).toEqual(text('two'))
    expect(message.edit_pending).toBe(true)

    await tick()
    expect(requests.map((r) => r.content)).toEqual([text('one'), text('two')])
    requests[1].answer()
    await second
    expect(message.content).toEqual(text('two'))
    expect(message.edit_pending).toBe(false)
  })

  it('a refused newest edit falls back to the last edit the server confirmed', async () => {
    const message = shownMessage()
    const { requests, saveOf } = heldSaves()
    const patch = (f: Partial<Message>) => Object.assign(message, f)
    const first = saveEditOptimistically({ message, content: text('one'), patch, save: saveOf(text('one')) })
    const second = saveEditOptimistically({ message, content: text('two'), patch, save: saveOf(text('two')) })
    await tick()
    requests[0].answer()
    await first
    await tick()
    requests[1].refuse(new Error('refused'))
    await expect(second).rejects.toThrow('refused')
    expect(message.content).toEqual(text('one'))
    expect(message.edit_pending).toBe(false)
  })

  it('a realtime row for a message with an edit in flight keeps the edit on screen', () => {
    const local = { ...shownMessage(), content: text('mine'), edit_pending: true } as Message
    const incoming = { ...shownMessage(), content: text('older'), is_pinned: true } as Message
    expect(keepPendingEdit(local, incoming)).toMatchObject({ content: text('mine'), is_pinned: true, edit_pending: true })
    expect(keepPendingEdit({ ...local, edit_pending: false }, incoming).content).toEqual(text('older'))
  })
})
