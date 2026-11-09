import { afterEach, describe, expect, it, vi } from 'vitest'
import { configSchema } from './config.js'
import { Store } from './Store.js'
import { Relay, type MatrixEvent } from './Relay.js'
import { HttpError } from './http.js'

const channelId = '22222222-2222-4222-8222-222222222222'
const userId = '11111111-1111-4111-8111-111111111111'
const roomId = '!test:matrix.test'
const stores: Store[] = []
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.useRealTimers() })
function setup() {
  const config = configSchema.parse({
    harmony: { apiUrl: 'https://harmony.test/bot-gateway', gatewayUrl: 'wss://harmony.test/gateway', allowedUserIds: [userId] },
    matrix: { homeserverUrl: 'https://matrix.test', serverName: 'matrix.test', applicationServiceUrl: 'http://127.0.0.1:9009', allowedUserIds: ['@alice:matrix.test'] },
    pairs: [{ harmonyChannelId: channelId, matrixRoomId: roomId }],
  })
  const store = new Store(':memory:')
  stores.push(store)
  const harmony = { sendMessage: vi.fn().mockResolvedValue({ id: 'h-copy' }), channelIsPlaintext: vi.fn().mockResolvedValue(true) }
  const matrix = { sendMessage: vi.fn().mockResolvedValue({ event_id: '$m-copy' }), roomIsPlaintext: vi.fn().mockResolvedValue(true) }
  const relay = new Relay(config, store, harmony, matrix)
  return { config, store, harmony, matrix, relay }
}
function event(overrides: Partial<MatrixEvent> = {}): MatrixEvent {
  return { type: 'm.room.message', event_id: '$one', room_id: roomId, sender: '@alice:matrix.test', content: { msgtype: 'm.text', body: 'hello' }, ...overrides }
}
function message(overrides: Record<string, unknown> = {}) {
  return { id: 'h-one', channel_id: channelId, author: { id: userId, username: 'Alice' }, content: 'hello', metadata: {}, ...overrides }
}

describe('Relay', () => {
  it('durably deduplicates transactions/events and attributes Matrix senders without Discord impersonation', async () => {
    const { relay, harmony, store } = setup()
    expect(relay.acceptTransaction('one', [event()])).toBe(true)
    expect(relay.acceptTransaction('one', [event()])).toBe(false)
    relay.acceptTransaction('another', [event()])
    expect(store.counts().pending).toBe(1)
    await relay.tick()
    expect(harmony.sendMessage).toHaveBeenCalledExactlyOnceWith(channelId, '[@alice:matrix.test · Matrix] hello', {
      matrix_relay: { room_id: roomId, event_id: '$one', sender: '@alice:matrix.test' },
    })
    expect(store.findMapping('to_harmony', '$one', channelId, roomId)).toBe('h-copy')
  })
  it('does not relay unknown users, other rooms, encrypted events, edits, threads or its own Matrix sender', () => {
    const { relay, store } = setup()
    relay.acceptTransaction('ignored', [
      event({ sender: '@other:matrix.test' }), event({ sender: '@harmony_relay:matrix.test' }),
      event({ room_id: '!private:matrix.test' }), event({ type: 'm.room.encrypted' }),
      event({ content: { msgtype: 'm.text', body: 'edit', 'm.relates_to': { rel_type: 'm.replace' } } }),
      event({ content: { msgtype: 'm.image', body: 'photo' } }),
    ])
    expect(store.counts().pending).toBe(0)
  })
  it('posts native Harmony text only, with a deterministic Matrix transaction ID', async () => {
    const { relay, matrix, store } = setup()
    expect(relay.acceptHarmonyMessage(message())).toBe(true)
    expect(relay.acceptHarmonyMessage(message())).toBe(false)
    await relay.tick()
    const [room, transaction, body] = matrix.sendMessage.mock.calls[0]
    expect(room).toBe(roomId)
    expect(transaction).toMatch(/^[a-f0-9]{64}$/)
    expect(body).toBe('[Alice · Harmony] hello')
    expect(store.findMapping('to_matrix', 'h-one', channelId, roomId)).toBe('$m-copy')
  })
  it('does not forward bots, external bridges, system notices, thread messages or unapproved Harmony users', () => {
    const { relay } = setup()
    for (const override of [
      { author: { id: userId, bot: true } }, { author: { id: 'other' } }, { encrypted: true },
      { metadata: { discord_user: { id: '42' } } }, { metadata: { bridge_source: 'matrix' } },
      { metadata: { matrix_relay: {} } }, { is_system: true }, { thread_id: 'thread' },
      { content_raw: [{ type: 'file', url: 'https://private.test/file' }] },
    ]) expect(relay.acceptHarmonyMessage(message(override))).toBe(false)
  })
  it('honors pair directions and rechecks consent/pairing before draining persisted jobs', async () => {
    const { relay, config, harmony, matrix, store } = setup()
    config.pairs[0].direction = 'to_harmony'
    expect(relay.acceptHarmonyMessage(message())).toBe(false)
    relay.acceptTransaction('one', [event()])
    config.matrix.allowedUserIds = []
    await relay.tick()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
    expect(matrix.sendMessage).not.toHaveBeenCalled()
    expect(store.counts().failed).toBe(1)
  })
  it('fails closed for encrypted or unknown encryption policies on either side', async () => {
    for (const failure of ['matrix', 'harmony', 'unknown']) {
      const { relay, harmony, matrix, store } = setup()
      relay.acceptTransaction('one', [event()])
      if (failure === 'matrix') matrix.roomIsPlaintext.mockResolvedValue(false)
      if (failure === 'harmony') harmony.channelIsPlaintext.mockResolvedValue(false)
      if (failure === 'unknown') harmony.channelIsPlaintext.mockRejectedValue(new HttpError('unavailable', false, 404))
      await relay.tick()
      expect(harmony.sendMessage).not.toHaveBeenCalled()
      expect(store.counts().failed).toBe(1)
    }
  })
  it('retries transient failures with the same mapping key, without leaking errors into storage', async () => {
    vi.useFakeTimers()
    const { relay, matrix, store } = setup()
    relay.acceptHarmonyMessage(message())
    matrix.sendMessage.mockRejectedValueOnce(new HttpError('secret-token', true, 503))
    await relay.tick()
    expect(store.nextJob()).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(store.nextJob()!.attempts).toBe(1)
    await relay.tick()
    expect(matrix.sendMessage.mock.calls[0][1]).toBe(matrix.sendMessage.mock.calls[1][1])
    expect(store.counts().pending).toBe(0)
  })
  it('does not blindly retry an ambiguous non-idempotent Harmony POST', async () => {
    const { relay, harmony, store } = setup()
    relay.acceptTransaction('one', [event()])
    harmony.sendMessage.mockRejectedValue(new HttpError('transport failed', true))
    await relay.tick()
    await relay.tick()
    expect(harmony.sendMessage).toHaveBeenCalledOnce()
    expect(store.counts()).toEqual({ pending: 0, failed: 1 })
  })
  it('honors an explicit Harmony rate limit without treating its rejected POST as ambiguous', async () => {
    vi.useFakeTimers()
    const { relay, harmony, store } = setup()
    relay.acceptTransaction('one', [event()])
    harmony.sendMessage.mockRejectedValueOnce(new HttpError('limited', true, 429, undefined, 120_000))
    await relay.tick()
    vi.advanceTimersByTime(119_999)
    expect(store.nextJob()).toBeNull()
    vi.advanceTimersByTime(1)
    await relay.tick()
    expect(harmony.sendMessage).toHaveBeenCalledTimes(2)
    expect(store.counts()).toEqual({ pending: 0, failed: 0 })
  })
  it.each(['retry', 'fail'] as const)('pauses when storage %s fails while handling a delivery failure', async method => {
    const { relay, harmony, store } = setup()
    relay.acceptTransaction('one', [event()])
    harmony.channelIsPlaintext.mockRejectedValue(new HttpError('unavailable', method === 'retry', 503))
    vi.spyOn(store, method).mockImplementation(() => { throw new Error('disk failure') })
    await expect(relay.tick()).resolves.toBeUndefined()
    expect(relay.isHealthy).toBe(false)
    expect(store.counts().pending).toBe(1)
  })
  it('fences encryption events received during a preflight and across pending jobs', async () => {
    const { relay, harmony, matrix, store } = setup()
    let finish!: (value: boolean) => void
    harmony.channelIsPlaintext.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    relay.acceptHarmonyMessage(message())
    const delivering = relay.tick()
    await vi.waitFor(() => expect(harmony.channelIsPlaintext).toHaveBeenCalledOnce())
    relay.acceptTransaction('encryption', [{ type: 'm.room.encryption', room_id: roomId, content: { algorithm: 'm.megolm.v1.aes-sha2' } }])
    finish(true)
    await delivering
    expect(matrix.sendMessage).not.toHaveBeenCalled()
    expect(store.isRoomBlocked(roomId)).toBe(true)
    expect(store.counts().failed).toBe(1)
  })
  it('pauses rather than creating unhandled rejections when storage fails', async () => {
    const { relay, store } = setup()
    vi.spyOn(store, 'nextJob').mockImplementation(() => { throw new Error('disk failure') })
    await expect(relay.tick()).resolves.toBeUndefined()
    expect(relay.isHealthy).toBe(false)
    expect(() => relay.acceptTransaction('one', [event()])).toThrow(/restart/)
    await relay.stop()
  })
  it.each(['isRoomBlocked', 'complete'] as const)('preserves pending jobs and pauses on storage %s faults', async method => {
    const { relay, harmony, store } = setup()
    relay.acceptTransaction('one', [event()])
    vi.spyOn(store, method).mockImplementation(() => { throw new Error('disk failure') })
    await relay.tick()
    expect(relay.isHealthy).toBe(false)
    expect(store.counts()).toEqual({ pending: 1, failed: 0 })
    expect(harmony.sendMessage).toHaveBeenCalledTimes(method === 'complete' ? 1 : 0)
  })
  it('uses only a single in-flight worker and waits for delivery at shutdown', async () => {
    const { relay, harmony } = setup()
    let finish!: (value: { id: string }) => void
    harmony.sendMessage.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    relay.acceptTransaction('one', [event()])
    const first = relay.tick()
    await vi.waitFor(() => expect(harmony.sendMessage).toHaveBeenCalledOnce())
    const second = relay.tick()
    const stopping = relay.stop()
    finish({ id: 'done' })
    await Promise.all([first, second, stopping])
    expect(harmony.sendMessage).toHaveBeenCalledOnce()
  })
})
