/**
 * A channel insert with no answer fails its row after SEND_STALL_MS, with no automatic re-send.
 * Its message, stored later, becomes the row; a second copy is deleted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const messages = vi.hoisted(() => ({
  sendChannelMessage: vi.fn(),
  findSentMessage: vi.fn(),
  deleteMessage: vi.fn(async () => {}),
}))

vi.mock('@/services', () => ({ services: { messages } }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ fetchMultipleUserProfiles: vi.fn(async () => {}) }) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ channels: [], servers: [], _structureCacheByServer: {} }),
}))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))
vi.mock('@/stores/useReactions', () => ({ useReactionsStore: () => ({}), seedNoReactions: vi.fn() }))
vi.mock('@/utils/messageEmbedUtils', () => ({ ensureMessageEmbeds: vi.fn() }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { useChatStore } from '@/stores/useChat'
import { resetSendOrder } from '@/stores/shared/sendOrder'
import { SEND_STALL_MS, discardStalledRow, resetStalledSends } from '@/stores/shared/stalledSends'

const CH = 'chan-1'
const T0 = Date.parse('2026-10-01T00:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const text = (content: any) => content[0].text as string

interface HeldInsert {
  answer: (id: string, createdAt: string) => void
}
const held: HeldInsert[] = []

function openStore() {
  const store = useChatStore()
  store.currentChannelId = CH
  store.messages = [{ id: 'old', channel_id: CH, user_id: 'them', content: [{ type: 'text', text: 'old' }], created_at: at(0) } as any]
  return store
}

const shown = (store: ReturnType<typeof useChatStore>) =>
  store.messages.map((m: any) => {
    if (String(m.id).startsWith('temp-')) return `${m.failed ? 'failed' : 'pending'}:${text(m.content)}`
    return `${m.id}:${text(m.content)}`
  })

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  resetSendOrder()
  resetStalledSends()
  held.length = 0
  messages.findSentMessage.mockReset().mockResolvedValue(null)
  messages.deleteMessage.mockClear()
  messages.sendChannelMessage.mockReset().mockImplementation((_s: string, channelId: string, content: any, _r: any, metadata: any) =>
    new Promise((resolve) => {
      held.push({
        answer: (id, createdAt) => resolve({ id, channel_id: channelId, user_id: 'me', content, created_at: createdAt, metadata }),
      })
    }))
})

afterEach(() => {
  vi.useRealTimers()
})

async function stall(store: ReturnType<typeof useChatStore>, body: string) {
  const send = store.sendMessage('srv', CH, 'me', [{ type: 'text', text: body }], '')
  await vi.advanceTimersByTimeAsync(SEND_STALL_MS)
  await send
}

describe('a channel send with no answer', () => {
  it('fails its row at the deadline and is not sent again on its own', async () => {
    const store = openStore()
    await stall(store, 'hung')
    expect(shown(store)).toEqual(['old:old', 'failed:hung'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(messages.sendChannelMessage).toHaveBeenCalledTimes(1)
  })

  it('a late answer turns the failed row into the stored message', async () => {
    const store = openStore()
    await stall(store, 'hung')
    held[0].answer('stored', at(5))
    await vi.waitFor(() => expect(shown(store)).toEqual(['old:old', 'stored:hung']))
    expect(messages.deleteMessage).not.toHaveBeenCalled()
  })

  it('Retry looks the row up first and keeps a message stored meanwhile, sending nothing', async () => {
    const store = openStore()
    await stall(store, 'hung')
    const row = store.messages[1] as any
    messages.findSentMessage.mockResolvedValueOnce({
      id: 'stored', channel_id: CH, user_id: 'me', content: row.content, created_at: at(5), metadata: row.metadata,
    })
    await store.retryMessage(row.id, 'srv', CH, 'me', row.content, '')
    expect(messages.findSentMessage).toHaveBeenCalledWith({ channelId: CH }, 'me', row.metadata.client_nonce)
    expect(messages.sendChannelMessage).toHaveBeenCalledTimes(1)
    expect(shown(store)).toEqual(['old:old', 'stored:hung'])
  })

  it('a stalled copy landing after Retry stored the message is deleted', async () => {
    const store = openStore()
    await stall(store, 'hung')
    const row = store.messages[1] as any
    const retry = store.retryMessage(row.id, 'srv', CH, 'me', row.content, '')
    await vi.waitFor(() => expect(held).toHaveLength(2))
    held[1].answer('second', at(6))
    await retry
    expect(shown(store)).toEqual(['old:old', 'second:hung'])

    held[0].answer('first', at(5))
    await vi.waitFor(() => expect(messages.deleteMessage).toHaveBeenCalledWith('first'))
    expect(shown(store)).toEqual(['old:old', 'second:hung'])
  })

  it('a stalled send landing after its row was deleted is deleted', async () => {
    const store = openStore()
    await stall(store, 'hung')
    const row = store.messages[1] as any
    discardStalledRow(row.id)
    store.discardFailedMessage(row.id)
    held[0].answer('late', at(5))
    await vi.waitFor(() => expect(messages.deleteMessage).toHaveBeenCalledWith('late'))
    expect(shown(store)).toEqual(['old:old'])
  })

  it('an outbox re-send whose lookup fails leaves the row failed, sending nothing', async () => {
    const store = openStore()
    await stall(store, 'hung')
    const row = store.messages[1] as any
    store.discardFailedMessage(row.id)
    messages.findSentMessage.mockRejectedValueOnce(new Error('fetch failed'))
    const resend = store.sendMessage('srv', CH, 'me', row.content, '', undefined, {
      tempId: row.id, clientNonce: row.metadata.client_nonce,
    })
    await vi.advanceTimersByTimeAsync(10_000 + 2 * SEND_STALL_MS)
    await resend
    expect(messages.sendChannelMessage).toHaveBeenCalledTimes(1)
    expect(shown(store)).toEqual(['old:old', 'failed:hung'])
  })

  it('an automatic retry of a stalled row looks it up first and keeps a message stored meanwhile', async () => {
    const store = openStore()
    await stall(store, 'hung')
    const row = store.messages[1] as any
    store.discardFailedMessage(row.id)
    messages.sendChannelMessage.mockRejectedValueOnce(new Error('502'))
    messages.findSentMessage.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'stored', channel_id: CH, user_id: 'me', content: row.content, created_at: at(5), metadata: row.metadata,
    })
    const resend = store.sendMessage('srv', CH, 'me', row.content, '', undefined, {
      tempId: row.id, clientNonce: row.metadata.client_nonce,
    })
    await vi.advanceTimersByTimeAsync(10_000 + SEND_STALL_MS)
    await resend
    expect(messages.findSentMessage).toHaveBeenCalledTimes(2)
    expect(messages.sendChannelMessage).toHaveBeenCalledTimes(2)
    expect(shown(store)).toEqual(['old:old', 'stored:hung'])
  })

  it('a stalled outbox row, removed from the store at its failure, lands as a stored row', async () => {
    const store = openStore()
    await stall(store, 'with file')
    store.discardFailedMessage((store.messages[1] as any).id)
    held[0].answer('stored', at(5))
    await vi.waitFor(() => expect(shown(store)).toEqual(['old:old', 'stored:with file']))
  })
})
