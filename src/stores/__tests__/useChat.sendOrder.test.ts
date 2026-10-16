/**
 * Sends to one channel leave one at a time; the sender's list ends in the server's created_at
 * order, which is what every other member reads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const messages = vi.hoisted(() => ({
  sendChannelMessage: vi.fn(),
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

const CH = 'chan-1'
const T0 = Date.parse('2026-10-01T00:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

interface HeldInsert {
  text: string
  answer: (createdAt: string) => void
  refuse: (error: unknown) => void
}

const held: HeldInsert[] = []
const text = (content: any) => content[0].text as string
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function openStore() {
  const store = useChatStore()
  store.currentChannelId = CH
  store.messages = [{ id: 'old', channel_id: CH, user_id: 'them', content: [{ type: 'text', text: 'old' }], created_at: at(0) } as any]
  return store
}

const shown = (store: ReturnType<typeof useChatStore>) =>
  store.messages.map((m: any) => (String(m.id).startsWith('temp-') ? `pending:${text(m.content)}` : text(m.content)))

beforeEach(() => {
  setActivePinia(createPinia())
  resetSendOrder()
  held.length = 0
  messages.sendChannelMessage.mockReset().mockImplementation((_s: string, channelId: string, content: any, _r: any, metadata: any) =>
    new Promise((resolve, reject) => {
      held.push({
        text: text(content),
        answer: (createdAt) => resolve({
          id: `id-${text(content)}`, channel_id: channelId, user_id: 'me', content, created_at: createdAt, metadata,
        }),
        refuse: reject,
      })
    }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('channel sends in order', () => {
  it('shows every optimistic row at once and starts one insert at a time', async () => {
    const store = openStore()
    const sends = ['1', '2', '3'].map((t) => store.sendMessage('srv', CH, 'me', [{ type: 'text', text: t }], ''))
    await tick()

    expect(shown(store)).toEqual(['old', 'pending:1', 'pending:2', 'pending:3'])
    expect(held.map((h) => h.text)).toEqual(['1'])

    held[0].answer(at(10))
    await tick()
    expect(held.map((h) => h.text)).toEqual(['1', '2'])
    held[1].answer(at(11))
    await tick()
    held[2].answer(at(12))
    await Promise.all(sends)
    expect(shown(store)).toEqual(['old', '1', '2', '3'])
  })

  it('places a sent row by its server created_at among rows that arrived while it was pending', async () => {
    const store = openStore()
    const send = store.sendMessage('srv', CH, 'me', [{ type: 'text', text: 'mine' }], '')
    await tick()
    // Another member's message, stored before ours, arrives while our insert is in flight. The
    // pending row carries this client's clock, behind the server's here, so it sorts first.
    store.messages[1].created_at = new Date(T0 - 5000) as any
    store.addMessageToCache({ id: 'theirs', channel_id: CH, user_id: 'them', content: [{ type: 'text', text: 'theirs' }], created_at: at(15) } as any)
    expect(shown(store)).toEqual(['old', 'pending:mine', 'theirs'])

    held[0].answer(at(20))
    await send
    expect(shown(store)).toEqual(['old', 'theirs', 'mine'])
  })

  it('a failed send stays in place, marked failed; the next one still goes', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const store = openStore()
    const sends = ['1', '2', '3'].map((t) => store.sendMessage('srv', CH, 'me', [{ type: 'text', text: t }], ''))
    await tick()
    held[0].answer(at(10))
    await tick()
    held[1].refuse(new Error('network'))
    await tick()
    expect(held.map((h) => h.text)).toEqual(['1', '2', '3'])
    held[2].answer(at(12))
    await Promise.all(sends)

    expect(shown(store)).toEqual(['old', '1', 'pending:2', '3'])
    expect((store.messages[2] as any).failed).toBe(true)
  })

  it('sends to different channels do not wait on each other', async () => {
    const store = openStore()
    void store.sendMessage('srv', CH, 'me', [{ type: 'text', text: 'here' }], '')
    void store.sendMessage('srv', 'chan-2', 'me', [{ type: 'text', text: 'there' }], '')
    await tick()
    expect(held.map((h) => h.text)).toEqual(['here', 'there'])
  })
})
