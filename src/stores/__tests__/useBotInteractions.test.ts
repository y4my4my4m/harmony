/**
 * The invoker's slash command lines: rows from an invoke answer, timers from respond_in_ms and
 * expires_in_ms, 'bot_interaction:update' pushes, public replies resolving their row, and the
 * resync through get_my_bot_interactions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

type Handler = (payload: Record<string, any>) => void
const handlers = vi.hoisted(() => new Map<string, Set<(payload: Record<string, any>) => void>>())
vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: {
    on: (type: string, handler: Handler) => {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(handler)
      return () => handlers.get(type)?.delete(handler)
    },
  },
}))

const getMine = vi.hoisted(() => vi.fn())
vi.mock('@/services/botCommandService', () => ({ getMyBotInteractions: getMine }))

const chat = vi.hoisted(() => ({ currentChannelId: '', revalidateRecentMessages: vi.fn() }))
vi.mock('@/stores/useChat', () => ({ useChatStore: () => chat }))

import { interactionPhase, interactionStatusAttr, useBotInteractionsStore } from '@/stores/useBotInteractions'

const push = (payload: Record<string, any>) => {
  for (const handler of handlers.get('bot_interaction:update') ?? []) handler({ type: 'bot_interaction:update', ...payload })
}
const reconnect = () => {
  for (const handler of handlers.get('_reconnected') ?? []) handler({ type: '_reconnected' })
}

const ID = 'a0000000-0000-4000-8000-000000000001'
const ID2 = 'a0000000-0000-4000-8000-000000000002'
const CHANNEL = '11111111-1111-4111-8111-111111111111'
const THREAD = '22222222-2222-4222-8222-222222222222'
const bot = { id: 'b0000000-0000-4000-8000-000000000001', username: 'weatherbot', display_name: 'Weatherbot', avatar_url: null }

function invoke(store: ReturnType<typeof useBotInteractionsStore>, id = ID, threadId: string | null = null) {
  store.addInvoked({
    result: { id, respond_in_ms: 5000, expires_in_ms: 900000 },
    bot,
    channelId: CHANNEL,
    threadId,
    commandName: 'weather',
  })
  return store.rows[id]
}

const reply = (id: string, text: string) => ({
  id, content: [{ type: 'text', text }], created_at: '2026-11-10T00:00:00Z', edited_at: null,
})

beforeEach(() => {
  handlers.clear()
  getMine.mockReset()
  chat.currentChannelId = CHANNEL
  chat.revalidateRecentMessages.mockReset()
  setActivePinia(createPinia())
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useBotInteractions', () => {
  it('a new row thinks until respond_in_ms passes, then did not respond', async () => {
    const store = useBotInteractionsStore()
    const row = invoke(store)
    expect(row).toMatchObject({ status: 'pending', channelId: CHANNEL, threadId: null, commandName: 'weather', bot })
    expect(interactionPhase(row)).toBe('thinking')
    expect(store.rowsFor(CHANNEL, null)).toHaveLength(1)
    expect(store.rowsFor(CHANNEL, THREAD)).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(interactionPhase(store.rows[ID])).toBe('thinking')
    await vi.advanceTimersByTimeAsync(1)
    expect(interactionPhase(store.rows[ID])).toBe('timed_out')
    expect(interactionStatusAttr(store.rows[ID])).toBe('timed_out')
  })

  it('a defer moves the deadline to expires_in_ms', async () => {
    const store = useBotInteractionsStore()
    invoke(store)
    await vi.advanceTimersByTimeAsync(1_000)
    push({ id: ID, status: 'delivered', expires_in_ms: 899_000 })
    push({ id: ID, status: 'deferred', ephemeral: true, expires_in_ms: 898_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(interactionPhase(store.rows[ID])).toBe('thinking')
    await vi.advanceTimersByTimeAsync(888_000)
    expect(interactionPhase(store.rows[ID])).toBe('timed_out')
  })

  it('a private reply shows; edits and follow-ups merge by reply id', async () => {
    const store = useBotInteractionsStore()
    invoke(store)
    push({ id: ID, status: 'responded', ephemeral: true, reply: reply('r1', 'Sunny'), reply_count: 1, expires_in_ms: 899_000 })
    expect(interactionPhase(store.rows[ID])).toBe('replied')
    expect(interactionStatusAttr(store.rows[ID])).toBe('responded')
    push({ id: ID, status: 'responded', reply: { ...reply('r1', 'Rain'), edited_at: '2026-11-10T00:01:00Z' }, reply_count: 1 })
    push({ id: ID, status: 'responded', reply: reply('r2', 'Wind'), reply_count: 2 })
    expect(store.rows[ID].replies.map((r) => (r.content[0] as any).text)).toEqual(['Rain', 'Wind'])
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(interactionPhase(store.rows[ID])).toBe('replied')
    expect(getMine).not.toHaveBeenCalled()
  })

  it('a public reply removes the row, by push or by the message', async () => {
    const store = useBotInteractionsStore()
    invoke(store, ID)
    push({ id: ID, status: 'responding', ephemeral: false })
    expect(interactionPhase(store.rows[ID])).toBe('thinking')
    store.noteMessage({ metadata: { interaction: { id: ID, name: 'weather', user_id: 'u1' } } })
    expect(store.rows[ID]).toBeUndefined()

    invoke(store, ID2)
    push({ id: ID2, status: 'responded', ephemeral: false, response_message_id: 'm2' })
    expect(store.rows[ID2]).toBeUndefined()
  })

  it('a follow-up message does not answer the original', async () => {
    const store = useBotInteractionsStore()
    invoke(store)
    push({ id: ID, status: 'deferred', ephemeral: false })
    store.noteMessage({ metadata: { interaction: { id: ID, name: 'weather', user_id: 'u1', followup: true } } })
    expect(interactionPhase(store.rows[ID])).toBe('thinking')
  })

  it('a public reply seen before the invoke answer resolves the row it creates', async () => {
    const store = useBotInteractionsStore()
    store.noteMessage({ metadata: { interaction: { id: ID, name: 'weather', user_id: 'u1' } } })
    invoke(store)
    expect(store.rows[ID]).toBeUndefined()
  })

  it('failures name their cause', async () => {
    const store = useBotInteractionsStore()
    invoke(store)
    push({ id: ID, status: 'failed', error: 'offline' })
    expect(interactionPhase(store.rows[ID])).toBe('offline')
    expect(interactionStatusAttr(store.rows[ID])).toBe('offline')
    push({ id: ID, status: 'failed', error: 'bot_cannot_post' })
    expect(interactionPhase(store.rows[ID])).toBe('cannot_post')
    push({ id: ID, status: 'expired', error: null })
    expect(interactionPhase(store.rows[ID])).toBe('timed_out')
  })

  it('a push for a row of another tab adds it, with the respond window from expires_in_ms', async () => {
    const store = useBotInteractionsStore()
    push({ id: ID, bot_id: bot.id, channel_id: CHANNEL, thread_id: THREAD, command_name: 'weather', status: 'delivered', expires_in_ms: 898_000 })
    const row = store.rowsFor(CHANNEL, THREAD)[0]
    expect(row).toMatchObject({ id: ID, status: 'delivered', commandName: 'weather' })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(interactionPhase(store.rows[ID])).toBe('thinking')
    await vi.advanceTimersByTimeAsync(1)
    expect(interactionPhase(store.rows[ID])).toBe('timed_out')
  })

  it('at the deadline the row is read again before it times out', async () => {
    const store = useBotInteractionsStore()
    invoke(store)
    getMine.mockResolvedValueOnce([{
      id: ID, bot_id: bot.id, channel_id: CHANNEL, thread_id: null, command_name: 'weather',
      status: 'deferred', error: null, ephemeral: true, response_message_id: null, replies: [],
      respond_in_ms: 0, expires_in_ms: 895_000,
    }])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(getMine).toHaveBeenCalledWith([ID])
    expect(store.rows[ID].status).toBe('deferred')
    expect(interactionPhase(store.rows[ID])).toBe('thinking')
  })

  it('a public reply whose push was missed is fetched into the channel at the deadline', async () => {
    const store = useBotInteractionsStore()
    invoke(store)
    getMine.mockResolvedValueOnce([{
      id: ID, bot_id: bot.id, channel_id: CHANNEL, thread_id: null, command_name: 'weather',
      status: 'responded', error: null, ephemeral: false, response_message_id: 'm1', replies: [],
      respond_in_ms: 0, expires_in_ms: 895_000,
    }])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.rows[ID]).toBeUndefined()
    expect(chat.revalidateRecentMessages).toHaveBeenCalledWith(CHANNEL)
  })

  it('a late acknowledgement clears did not respond', async () => {
    const store = useBotInteractionsStore()
    invoke(store)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(interactionPhase(store.rows[ID])).toBe('timed_out')
    push({ id: ID, status: 'responded', ephemeral: true, reply: reply('r1', 'Late'), reply_count: 1 })
    expect(interactionPhase(store.rows[ID])).toBe('replied')
  })

  it('resyncs on reconnect: applies the rows and drops those the server no longer has', async () => {
    const store = useBotInteractionsStore()
    invoke(store, ID)
    invoke(store, ID2)
    getMine.mockResolvedValueOnce([{
      id: ID, bot_id: bot.id, channel_id: CHANNEL, thread_id: null, command_name: 'weather',
      status: 'responded', error: null, ephemeral: true, response_message_id: null,
      replies: [reply('r1', 'Sunny')], respond_in_ms: 0, expires_in_ms: 600_000,
    }])
    reconnect()
    await vi.runAllTicks()
    await Promise.resolve()
    expect(getMine).toHaveBeenCalledWith([ID, ID2])
    expect(interactionPhase(store.rows[ID])).toBe('replied')
    expect(store.rows[ID2]).toBeUndefined()
  })

  it('a failed resync keeps the rows', async () => {
    const store = useBotInteractionsStore()
    invoke(store)
    getMine.mockResolvedValueOnce(null)
    await store.resync()
    expect(store.rows[ID]).toBeDefined()
  })

  it('resyncs one channel or thread when it opens', async () => {
    const store = useBotInteractionsStore()
    invoke(store, ID, null)
    invoke(store, ID2, THREAD)
    getMine.mockResolvedValueOnce([{
      id: ID2, bot_id: bot.id, channel_id: CHANNEL, thread_id: THREAD, command_name: 'weather',
      status: 'deferred', error: null, ephemeral: false, response_message_id: null, replies: [],
      respond_in_ms: 0, expires_in_ms: 1_000,
    }])
    await store.resync({ channelId: CHANNEL, threadId: THREAD })
    expect(getMine).toHaveBeenCalledWith([ID2])
    expect(store.rows[ID2].status).toBe('deferred')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(interactionPhase(store.rows[ID2])).toBe('timed_out')
    expect(interactionPhase(store.rows[ID])).toBe('thinking')
  })

  it('a lost push leaves replies short; the row is read again', async () => {
    const store = useBotInteractionsStore()
    invoke(store)
    getMine.mockResolvedValueOnce([])
    push({ id: ID, status: 'responded', ephemeral: true, reply: reply('r2', 'Second'), reply_count: 2 })
    expect(getMine).toHaveBeenCalledWith([ID])
  })

  it('an offline refusal is a local line; dismiss removes rows', async () => {
    const store = useBotInteractionsStore()
    store.addLocalFailure({ bot, channelId: CHANNEL, threadId: null, commandName: 'weather', error: 'offline' })
    const [row] = store.rowsFor(CHANNEL, null)
    expect(interactionPhase(row)).toBe('offline')
    store.dismiss(row.id)
    expect(store.rowsFor(CHANNEL, null)).toHaveLength(0)
  })

  it('reset drops rows and handlers', async () => {
    const store = useBotInteractionsStore()
    invoke(store)
    store.reset()
    expect(store.rowsFor(CHANNEL, null)).toHaveLength(0)
    expect(handlers.get('bot_interaction:update')?.size ?? 0).toBe(0)
    store.listen()
    expect(handlers.get('bot_interaction:update')?.size).toBe(1)
  })
})
