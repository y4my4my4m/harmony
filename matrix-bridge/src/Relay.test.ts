import { afterEach, describe, expect, it, vi } from 'vitest'
import { configSchema, ghostUserId } from './config.js'
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
  const harmony = { sendMessage: vi.fn().mockResolvedValue({ id: 'h-copy' }), channelIsPlaintext: vi.fn().mockResolvedValue(true),
    requireMatrixBridge: vi.fn().mockResolvedValue(undefined), relayAllowed: vi.fn().mockResolvedValue(true),
    uploadBridgeAvatar: vi.fn().mockResolvedValue('https://storage.test/avatar.png'),
    bridgeRoom: vi.fn().mockResolvedValue({ room_id: roomId, sender_mode: 'relay' }),
    bridgeMembers: vi.fn().mockResolvedValue([{ id: userId, username: 'Alice', display_name: 'Room Alice', avatar_url: null, domain: 'harmony.test' }]),
    nativeAvatar: vi.fn().mockResolvedValue({ data: 'aW1hZ2U=', content_type: 'image/png' }), publishMatrixMembers: vi.fn() }
  const matrix = { sendMessage: vi.fn().mockResolvedValue({ event_id: '$m-copy' }), roomIsPlaintext: vi.fn().mockResolvedValue(true),
    roomMember: vi.fn().mockResolvedValue({ display_name: 'Room Alice' }),
    avatarThumbnail: vi.fn().mockResolvedValue({ data: 'aW1hZ2U=', content_type: 'image/png' }),
    registerGhost: vi.fn().mockResolvedValue(undefined), joinGhost: vi.fn().mockResolvedValue(undefined), leaveGhost: vi.fn().mockResolvedValue(undefined),
    uploadAvatar: vi.fn().mockResolvedValue('mxc://matrix.test/native'), roomMembers: vi.fn().mockResolvedValue([{ id: '@alice:matrix.test', display_name: 'Matrix Alice' }]) }
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
    expect(harmony.sendMessage).toHaveBeenCalledExactlyOnceWith(channelId, 'hello', {
      bridge_author: { platform: 'matrix', id: '@alice:matrix.test', username: 'alice', display_name: 'Room Alice' },
      matrix_relay: { room_id: roomId, event_id: '$one', sender: '@alice:matrix.test' },
    })
    expect(store.findMapping('to_harmony', '$one', channelId, roomId)).toBe('h-copy')
  })
  it('accepts new events and encryption fences when the homeserver reuses an AS transaction ID', async () => {
    const { relay, harmony, store } = setup()
    relay.acceptTransaction('1', [event()])
    await relay.tick()
    expect(relay.acceptTransaction('1', [event({ event_id: '$after-hs-restart' })])).toBe(true)
    expect(store.counts().pending).toBe(1)
    expect(relay.acceptTransaction('1', [{ type: 'm.room.encryption', room_id: roomId }])).toBe(true)
    await relay.tick()
    expect(harmony.sendMessage).toHaveBeenCalledOnce()
    expect(store.isRoomBlocked(roomId)).toBe(true)
    expect(store.counts()).toEqual({ pending: 0, failed: 1 })
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
      { metadata: { matrix_relay: {} } }, { metadata: { bridge_author: { platform: 'matrix', id: '@a:test' } } }, { is_system: true }, { thread_id: 'thread' },
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
  it('ignores forged event author metadata and fetches the actual room membership', async () => {
    const { relay, harmony, matrix } = setup()
    relay.acceptTransaction('one', [event({ content: { msgtype: 'm.text', body: 'hello', displayname: 'Forged',
      avatar_url: 'https://evil.test/a', 'bridge_author': { id: '@admin:test' } } })])
    await relay.tick()
    expect(matrix.roomMember).toHaveBeenCalledExactlyOnceWith(roomId, '@alice:matrix.test')
    expect(harmony.sendMessage.mock.calls[0][2].bridge_author).toEqual({ platform: 'matrix', id: '@alice:matrix.test', username: 'alice', display_name: 'Room Alice' })
  })
  it('checks destination encryption after the consent request, immediately before sending', async () => {
    const { relay, harmony, matrix, store } = setup()
    harmony.relayAllowed.mockImplementation(async () => { matrix.roomIsPlaintext.mockResolvedValue(false); return true })
    relay.acceptHarmonyMessage(message())
    await relay.tick()
    expect(matrix.sendMessage).not.toHaveBeenCalled()
    expect(store.counts().failed).toBe(1)
  })
  it('rechecks member consent after enqueue and on every retry', async () => {
    vi.useFakeTimers()
    const { relay, harmony, matrix, store } = setup()
    relay.acceptHarmonyMessage(message())
    matrix.sendMessage.mockRejectedValueOnce(new HttpError('unavailable', true, 503))
    await relay.tick()
    harmony.relayAllowed.mockResolvedValue(false)
    vi.advanceTimersByTime(1000)
    await relay.tick()
    expect(harmony.relayAllowed).toHaveBeenCalledTimes(3)
    expect(matrix.sendMessage).toHaveBeenCalledOnce()
    expect(store.counts()).toEqual({ pending: 0, failed: 1 })
  })
  it.each([false, undefined, null])('blocks queued messages when consent is %s', async consent => {
    const { relay, harmony, matrix, store } = setup()
    relay.acceptHarmonyMessage(message())
    harmony.relayAllowed.mockResolvedValue(consent)
    await relay.tick()
    expect(matrix.sendMessage).not.toHaveBeenCalled()
    expect(store.counts().failed).toBe(1)
  })
  it.each(['registration', 'consent', 'profile'])('fails closed on unavailable %s without sending', async check => {
    const { relay, harmony, matrix, store } = setup()
    if (check === 'consent') {
      relay.acceptHarmonyMessage(message())
      harmony.relayAllowed.mockRejectedValue(new HttpError('unavailable', true, 503))
    } else {
      relay.acceptTransaction('one', [event()])
      if (check === 'registration') harmony.requireMatrixBridge.mockRejectedValue(new HttpError('unavailable', true, 503))
      else matrix.roomMember.mockRejectedValue(new HttpError('unavailable', true, 503))
    }
    await relay.tick()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
    expect(matrix.sendMessage).not.toHaveBeenCalled()
    expect(store.counts().pending).toBe(1)
  })
  it('uploads and caches avatars only after plaintext checks, then rechecks destination policy', async () => {
    const { relay, harmony, matrix } = setup()
    const order: string[] = []
    harmony.channelIsPlaintext.mockImplementation(async () => { order.push('harmony'); return true })
    matrix.roomIsPlaintext.mockImplementation(async () => { order.push('matrix'); return true })
    matrix.roomMember.mockImplementation(async () => { order.push('profile'); return { display_name: 'Alice', avatar_mxc: 'mxc://test/a' } })
    harmony.uploadBridgeAvatar.mockImplementation(async () => { order.push('upload'); return 'https://storage.test/avatar.png' })
    relay.acceptTransaction('one', [event()])
    await relay.tick()
    expect(order).toEqual(['matrix', 'harmony', 'profile', 'upload', 'harmony'])
    expect(harmony.sendMessage.mock.calls[0][2].bridge_author.avatar_url).toBe('https://storage.test/avatar.png')
    relay.acceptTransaction('two', [event({ event_id: '$two' })])
    await relay.tick()
    expect(matrix.avatarThumbnail).toHaveBeenCalledOnce()
    expect(harmony.uploadBridgeAvatar).toHaveBeenCalledOnce()
  })
  it('bounds the successful avatar cache and refetches evicted MXC references', async () => {
    const { relay, harmony, matrix } = setup()
    for (let index = 0; index <= 256; index++) {
      matrix.roomMember.mockResolvedValue({ avatar_mxc: `mxc://test/image${index}` })
      relay.acceptTransaction(`txn${index}`, [event({ event_id: `$event${index}` })])
      await relay.tick()
    }
    matrix.roomMember.mockResolvedValue({ avatar_mxc: 'mxc://test/image0' })
    relay.acceptTransaction('again', [event({ event_id: '$again' })])
    await relay.tick()
    expect(matrix.avatarThumbnail).toHaveBeenCalledTimes(258)
    expect(harmony.uploadBridgeAvatar).toHaveBeenCalledTimes(258)
  })
  it.each(['fetch', 'upload'])('still sends text when optional avatar %s fails', async failure => {
    const { relay, harmony, matrix } = setup()
    matrix.roomMember.mockResolvedValue({ avatar_mxc: 'mxc://test/a' })
    if (failure === 'fetch') matrix.avatarThumbnail.mockRejectedValue(new Error('private'))
    else harmony.uploadBridgeAvatar.mockRejectedValue(new Error('private'))
    relay.acceptTransaction('one', [event()])
    await relay.tick()
    expect(harmony.sendMessage.mock.calls[0][1]).toBe('hello')
    expect(harmony.sendMessage.mock.calls[0][2].bridge_author).toEqual({ platform: 'matrix', id: '@alice:matrix.test', username: 'alice' })
  })
  it.each(['matrix', 'harmony'])('never fetches profiles or avatars for encrypted %s', async side => {
    const { relay, harmony, matrix } = setup()
    matrix.roomMember.mockResolvedValue({ avatar_mxc: 'mxc://test/a' })
    if (side === 'matrix') matrix.roomIsPlaintext.mockResolvedValue(false)
    else harmony.channelIsPlaintext.mockResolvedValue(false)
    relay.acceptTransaction('one', [event()])
    await relay.tick()
    expect(matrix.roomMember).not.toHaveBeenCalled()
    expect(matrix.avatarThumbnail).not.toHaveBeenCalled()
    expect(harmony.uploadBridgeAvatar).not.toHaveBeenCalled()
  })
  it('blocks a message if destination becomes encrypted during avatar upload', async () => {
    const { relay, harmony, matrix } = setup()
    matrix.roomMember.mockResolvedValue({ avatar_mxc: 'mxc://test/a' })
    harmony.uploadBridgeAvatar.mockImplementation(async () => {
      harmony.channelIsPlaintext.mockResolvedValue(false)
      return 'https://storage.test/avatar.png'
    })
    relay.acceptTransaction('one', [event()])
    await relay.tick()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
  })
  it('provisions two eligible ghosts before speech and publishes only allowlisted Matrix members', async () => {
    const { relay, harmony, matrix, config, store } = setup()
    const second = '33333333-3333-4333-8333-333333333333'
    config.harmony.allowedUserIds.push(second)
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'ghost' })
    harmony.bridgeMembers.mockResolvedValue([
      { id: userId, username: 'Alice', display_name: 'Room Alice', avatar_url: 'https://harmony.test/a.png', domain: 'harmony.test' },
      { id: second, username: 'Bob', display_name: 'Room Bob', avatar_url: null, domain: 'harmony.test' },
      { id: '44444444-4444-4444-8444-444444444444', username: 'Hidden', display_name: 'Hidden', avatar_url: null, domain: null },
    ])
    matrix.roomMembers.mockResolvedValue([{ id: '@alice:matrix.test' }, { id: '@unapproved:matrix.test' }, { id: ghostUserId(config, userId) }])
    relay.requestMemberSync()
    await relay.tick()
    expect(matrix.registerGhost).toHaveBeenCalledTimes(2)
    expect(matrix.joinGhost).toHaveBeenCalledWith(roomId, ghostUserId(config, userId), { displayname: 'Room Alice', avatar_url: 'mxc://matrix.test/native' })
    expect(harmony.nativeAvatar).toHaveBeenCalledExactlyOnceWith(channelId, userId)
    expect(harmony.publishMatrixMembers.mock.calls[0][1].map((member: { id: string }) => member.id)).toEqual(['@alice:matrix.test'])
    expect(store.roomGhosts(roomId)).toHaveLength(2)
    relay.acceptHarmonyMessage(message())
    await relay.tick()
    expect(matrix.sendMessage.mock.calls[0][2]).toBe('hello')
    expect(matrix.sendMessage.mock.calls[0][3].sender).toBe(ghostUserId(config, userId))
  })
  it('never provisions opted-out ghosts and leaves ghosts on opt-out or relay mode', async () => {
    const { relay, harmony, matrix, config, store } = setup()
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'ghost' })
    harmony.relayAllowed.mockResolvedValue(false)
    relay.requestMemberSync()
    await relay.tick()
    expect(matrix.registerGhost).not.toHaveBeenCalled()
    expect(matrix.joinGhost).not.toHaveBeenCalled()
    harmony.relayAllowed.mockResolvedValue(true)
    relay.requestMemberSync()
    await relay.tick()
    const ghost = ghostUserId(config, userId)
    expect(store.roomGhosts(roomId)).toEqual([ghost])
    harmony.bridgeMembers.mockResolvedValue([])
    relay.requestMemberSync()
    await relay.tick()
    expect(matrix.leaveGhost).toHaveBeenCalledWith(roomId, ghost)
    harmony.bridgeMembers.mockResolvedValue([{ id: userId, username: 'Alice', display_name: 'Alice', avatar_url: null, domain: null }])
    relay.requestMemberSync()
    await relay.tick()
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'relay' })
    relay.requestMemberSync()
    await relay.tick()
    expect(matrix.leaveGhost).toHaveBeenCalledTimes(2)
    expect(store.roomGhosts(roomId)).toEqual([])
  })
  it.each([403, 404])('leaves tracked ghosts when a live binding is revoked (%s)', async status => {
    const { relay, harmony, matrix, config, store } = setup()
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'ghost' })
    relay.requestMemberSync()
    await relay.tick()
    const ghost = ghostUserId(config, userId)
    expect(store.roomGhosts(roomId)).toEqual([ghost])
    harmony.bridgeRoom.mockRejectedValue(new HttpError('revoked', false, status))
    relay.requestMemberSync()
    await relay.tick()
    expect(matrix.leaveGhost).toHaveBeenCalledExactlyOnceWith(roomId, ghost)
    expect(store.roomGhosts(roomId)).toEqual([])
    expect(relay.isHealthy).toBe(true)
  })
  it('does not provision on transient binding failures or swallow ghost-cleanup storage faults', async () => {
    const { relay, harmony, matrix, store } = setup()
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'ghost' })
    relay.requestMemberSync()
    await relay.tick()
    matrix.registerGhost.mockClear()
    harmony.bridgeRoom.mockRejectedValue(new HttpError('unknown', true, 503))
    relay.requestMemberSync()
    await relay.tick()
    expect(matrix.leaveGhost).not.toHaveBeenCalled()
    expect(matrix.registerGhost).not.toHaveBeenCalled()
    expect(store.roomGhosts(roomId)).toHaveLength(1)
    const { StorageError } = await import('./Store.js')
    vi.spyOn(store, 'forgetGhostRoom').mockImplementation(() => { throw new StorageError('disk') })
    harmony.bridgeRoom.mockRejectedValue(new HttpError('revoked', false, 403))
    relay.requestMemberSync()
    await relay.tick()
    expect(relay.isHealthy).toBe(false)
  })
  it('preserves avatars on optional failure, clears actual removal, and uses fresh room names before exposure', async () => {
    const { relay, harmony, matrix } = setup()
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'ghost' })
    const member = { id: userId, username: 'Alice', display_name: 'Old Nick', avatar_url: 'https://harmony.test/new.png', domain: 'harmony.test' }
    harmony.bridgeMembers.mockResolvedValue([member])
    matrix.registerGhost.mockImplementation(async () => { harmony.bridgeMembers.mockResolvedValue([{ ...member, display_name: 'Current Nick' }]) })
    harmony.nativeAvatar.mockRejectedValue(new HttpError('unavailable', true, 503))
    relay.acceptHarmonyMessage(message())
    await relay.tick()
    expect(matrix.joinGhost.mock.calls[0][2]).toEqual({ displayname: 'Current Nick' })
    expect(matrix.sendMessage).toHaveBeenCalledOnce()
    harmony.bridgeMembers.mockResolvedValue([{ ...member, display_name: 'Current Nick', avatar_url: null }])
    relay.acceptHarmonyMessage(message({ id: 'second' }))
    await relay.tick()
    expect(matrix.joinGhost.mock.calls[1][2]).toEqual({ displayname: 'Current Nick', avatar_url: '' })
  })
  it('does not expose a profile if consent is withdrawn during ghost registration', async () => {
    const { relay, harmony, matrix } = setup()
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'ghost' })
    matrix.registerGhost.mockImplementation(async () => { harmony.relayAllowed.mockResolvedValue(false) })
    relay.acceptHarmonyMessage(message())
    await relay.tick()
    expect(matrix.joinGhost).not.toHaveBeenCalled()
    expect(harmony.nativeAvatar).not.toHaveBeenCalled()
    expect(matrix.sendMessage).not.toHaveBeenCalled()
  })
  it('bounds published names but preserves the full canonical Matrix ID', async () => {
    const { relay, harmony, matrix, config } = setup()
    const id = '@' + 'a'.repeat(150) + ':matrix.test'
    config.matrix.allowedUserIds = [id]
    matrix.roomMembers.mockResolvedValue([{ id }])
    relay.requestMemberSync()
    await relay.tick()
    expect(harmony.publishMatrixMembers.mock.calls[0][1]).toEqual([{ id, username: 'a'.repeat(100), displayName: 'a'.repeat(100), avatarUrl: null, source: 'matrix' }])
  })
  it('leaves tracked ghosts from removed configuration pairs at startup', async () => {
    const { relay, matrix, config, store } = setup()
    const ghost = ghostUserId(config, userId)
    store.reserveGhost(ghost, userId)
    store.registerGhost(ghost)
    store.trackGhostRoom('!removed:matrix.test', ghost)
    await relay.cleanupUnpairedGhosts()
    expect(matrix.leaveGhost).toHaveBeenCalledExactlyOnceWith('!removed:matrix.test', ghost)
    expect(store.ghostRooms()).toEqual([])
  })
  it('freezes the Matrix sender durably and refuses retries under another mode', async () => {
    vi.useFakeTimers()
    const { relay, harmony, matrix, config, store } = setup()
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'ghost' })
    matrix.sendMessage.mockRejectedValue(new HttpError('outcome uncertain', true, 503))
    relay.acceptHarmonyMessage(message())
    await relay.tick()
    vi.advanceTimersByTime(1000)
    expect(store.nextJob()!.payload.matrix_sender).toBe(ghostUserId(config, userId))
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'relay' })
    const restarted = new Relay(config, store, harmony, matrix)
    await restarted.tick()
    expect(matrix.sendMessage).toHaveBeenCalledOnce()
    expect(store.counts()).toEqual({ pending: 0, failed: 1 })
  })
  it('never silently falls back when ghost registration is refused', async () => {
    const { relay, harmony, matrix, store } = setup()
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'ghost' })
    matrix.registerGhost.mockRejectedValue(new HttpError('collision or missing namespace', false, 400))
    relay.acceptHarmonyMessage(message())
    await relay.tick()
    expect(matrix.sendMessage).not.toHaveBeenCalled()
    expect(store.counts().failed).toBe(1)
  })
  it('excludes every owned ghost from inbound echo even if explicitly allowlisted', () => {
    const { relay, config, store } = setup()
    const ghost = ghostUserId(config, userId)
    config.matrix.allowedUserIds.push(ghost)
    relay.acceptTransaction('echo', [event({ sender: ghost })])
    expect(store.counts().pending).toBe(0)
  })
  it('uses the DB mode instead of the config default and resolves structured Matrix mentions', async () => {
    const { relay, harmony, matrix, config } = setup()
    config.pairs[0].senderMode = 'ghost'
    relay.acceptHarmonyMessage(message({ content_raw: [{ type: 'text', text: 'Hi ' },
      { type: 'mention', userId: '@alice:matrix.test', username: 'alice', isBridged: true, bridgeSource: 'matrix' }] }))
    await relay.tick()
    expect(matrix.registerGhost).not.toHaveBeenCalled()
    expect(matrix.sendMessage.mock.calls[0][2]).toBe('[Alice · Harmony] Hi @alice')
    expect(matrix.sendMessage.mock.calls[0][3]).toMatchObject({ sender: '@harmony_relay:matrix.test', userIds: ['@alice:matrix.test'], formattedBody: expect.stringContaining('https://matrix.to/#/%40alice%3Amatrix.test') })
    expect(harmony.bridgeRoom).toHaveBeenCalled()
  })
  it('resolves annotated Matrix ghost pills only against currently eligible native members', async () => {
    const { relay, harmony, config, store } = setup()
    const ghost = ghostUserId(config, userId)
    store.reserveGhost(ghost, userId)
    store.registerGhost(ghost)
    relay.acceptTransaction('mention', [event({ content: { msgtype: 'm.text', body: 'Hello Alice', 'm.mentions': { user_ids: [ghost] },
      formatted_body: `Hello <a href="https://matrix.to/#/${ghost}">Alice</a>` } })])
    await relay.tick()
    expect(harmony.sendMessage.mock.calls[0][1]).toEqual([{ type: 'text', text: 'Hello ' }, { type: 'mention', userId, username: 'Alice', domain: 'harmony.test', isLocal: true, isBridged: false }])
  })
  it('does not ping an unknown colliding ghost in either direction, while relay !mention still works', async () => {
    const { relay, harmony, matrix, config } = setup()
    const other = '33333333-3333-4333-8333-333333333333'
    config.harmony.allowedUserIds.push(other)
    const unknownGhost = ghostUserId(config, other)
    harmony.bridgeMembers.mockResolvedValue([
      { id: userId, username: 'Alice', display_name: 'Alice', avatar_url: null, domain: 'harmony.test' },
      { id: other, username: 'Bob', display_name: 'Bob', avatar_url: null, domain: 'harmony.test' },
    ])
    relay.acceptTransaction('collision', [event({ content: { msgtype: 'm.text', body: 'Hello Bob', 'm.mentions': { user_ids: [unknownGhost] },
      formatted_body: `Hello <a href="https://matrix.to/#/${unknownGhost}">Bob</a>` } })])
    await relay.tick()
    expect(harmony.sendMessage.mock.calls[0][1]).toEqual([{ type: 'text', text: 'Hello Bob' }])
    relay.acceptTransaction('command', [event({ event_id: '$command', content: { msgtype: 'm.text', body: '!mention Bob hello' } })])
    await relay.tick()
    expect(harmony.sendMessage.mock.calls[1][1][0]).toMatchObject({ type: 'mention', userId: other })
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'ghost' })
    matrix.roomMembers.mockResolvedValue([{ id: unknownGhost }])
    relay.acceptHarmonyMessage(message({ content_raw: [{ type: 'mention', userId: other, username: 'Bob' }] }))
    await relay.tick()
    expect(matrix.sendMessage.mock.calls[0][3].userIds).toEqual([])
  })
  it.each(['matrix', 'harmony', 'unknown'])('does not expose ghost profiles or member imports when %s policy is encrypted/unknown', async side => {
    const { relay, harmony, matrix } = setup()
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'ghost' })
    if (side === 'matrix') matrix.roomIsPlaintext.mockResolvedValue(false)
    else if (side === 'harmony') harmony.channelIsPlaintext.mockResolvedValue(false)
    else harmony.channelIsPlaintext.mockRejectedValue(new HttpError('unknown', true, 503))
    relay.requestMemberSync()
    await relay.tick()
    expect(harmony.bridgeMembers).not.toHaveBeenCalled()
    expect(matrix.roomMembers).not.toHaveBeenCalled()
    expect(matrix.registerGhost).not.toHaveBeenCalled()
    expect(harmony.nativeAvatar).not.toHaveBeenCalled()
  })
  it('pauses on frozen-sender storage failure instead of attempting a send', async () => {
    const { relay, matrix, store } = setup()
    const { StorageError } = await import('./Store.js')
    vi.spyOn(store, 'freezeSender').mockImplementation(() => { throw new StorageError('disk') })
    relay.acceptHarmonyMessage(message())
    await relay.tick()
    expect(relay.isHealthy).toBe(false)
    expect(matrix.sendMessage).not.toHaveBeenCalled()
    expect(store.counts().pending).toBe(1)
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
