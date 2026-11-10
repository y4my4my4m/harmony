import { afterEach, describe, expect, it, vi } from 'vitest'
import { configSchema, ghostUserId } from './config.js'
import { Store, StorageError } from './Store.js'
import { Relay, type MatrixEvent } from './Relay.js'
import { HttpError } from './http.js'
import { MAX_MEDIA_BYTES } from './Media.js'

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
  const harmony = { sendMessage: vi.fn().mockResolvedValue({ id: 'h-copy' }), canReplyTo: vi.fn().mockResolvedValue(true), channelIsPlaintext: vi.fn().mockResolvedValue(true),
    requireMatrixBridge: vi.fn().mockResolvedValue(undefined), relayAllowed: vi.fn().mockResolvedValue(true),
    uploadBridgeAvatar: vi.fn().mockResolvedValue('https://storage.test/avatar.png'),
    bridgeRoom: vi.fn().mockResolvedValue({ room_id: roomId, sender_mode: 'relay' }),
    bridgeMembers: vi.fn().mockResolvedValue([{ id: userId, username: 'Alice', display_name: 'Room Alice', avatar_url: null, domain: 'harmony.test' }]),
    nativeAvatar: vi.fn().mockResolvedValue({ data: 'aW1hZ2U=', content_type: 'image/png' }), publishMatrixMembers: vi.fn(),
    downloadFile: vi.fn().mockResolvedValue({ bytes: Buffer.from('document bytes'), name: 'report.txt', contentType: 'text/plain' }),
    uploadFile: vi.fn().mockResolvedValue({ type: 'file', path: 'bridge/upload/report.txt', url: 'https://storage.test/private?token=temporary', fileName: 'report.txt', fileSize: 14, mimeType: 'text/plain' }) }
  const matrix = { sendMessage: vi.fn().mockResolvedValue({ event_id: '$m-copy' }), roomIsPlaintext: vi.fn().mockResolvedValue(true),
    roomMember: vi.fn().mockResolvedValue({ display_name: 'Room Alice' }),
    avatarThumbnail: vi.fn().mockResolvedValue({ data: 'aW1hZ2U=', content_type: 'image/png' }),
    registerGhost: vi.fn().mockResolvedValue(undefined), joinGhost: vi.fn().mockResolvedValue(undefined), leaveGhost: vi.fn().mockResolvedValue(undefined),
    uploadAvatar: vi.fn().mockResolvedValue('mxc://matrix.test/native'), roomMembers: vi.fn().mockResolvedValue([{ id: '@alice:matrix.test', display_name: 'Matrix Alice' }]),
    downloadFile: vi.fn().mockResolvedValue({ bytes: Buffer.from('document bytes'), name: 'report.txt', contentType: 'text/plain' }),
    uploadFile: vi.fn().mockResolvedValue('mxc://matrix.test/uploaded'), sendFile: vi.fn().mockResolvedValue({ event_id: '$file-copy' }) }
  const relay = new Relay(config, store, harmony, matrix)
  return { config, store, harmony, matrix, relay }
}
function event(overrides: Partial<MatrixEvent> = {}): MatrixEvent {
  return { type: 'm.room.message', event_id: '$one', room_id: roomId, sender: '@alice:matrix.test', content: { msgtype: 'm.text', body: 'hello' }, ...overrides }
}
function message(overrides: Record<string, unknown> = {}) {
  return { id: 'h-one', channel_id: channelId, author: { id: userId, username: 'Alice' }, content: 'hello', metadata: {}, ...overrides }
}

function fileEvent(content: Record<string, unknown> = {}): MatrixEvent {
  return event({ content: { msgtype: 'm.file', body: 'report.txt', filename: 'report.txt', url: 'mxc://matrix.test/report', info: { size: 14 }, ...content } })
}
function nativeFile(extra: Record<string, unknown> = {}) {
  return { type: 'file', fileName: 'report.txt', fileSize: 14, url: 'https://private.test/file?token=SECRET', path: 'c/private/report.txt', ...extra }
}

describe('Relay', () => {
  it('keeps the existing atomic job mapping for text-only Matrix delivery', async () => {
    const { relay, store } = setup()
    const pieces = vi.spyOn(store, 'recordDestination')
    relay.acceptHarmonyMessage(message())
    await relay.tick()
    expect(pieces).not.toHaveBeenCalled()
    expect(store.findSource('to_matrix', '$m-copy', channelId, roomId)).toBe('h-one')
  })
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
    }, undefined)
    expect(store.findMapping('to_harmony', '$one', channelId, roomId)).toBe('h-copy')
  })
  it.each(['to_matrix', 'to_harmony'] as const)('maps a Matrix reply to its %s parent without copying quoted text', async direction => {
    const { relay, harmony, store } = setup()
    store.enqueue({ direction, sourceId: direction === 'to_matrix' ? 'h-parent' : '$parent', channelId, roomId, payload: { body: 'old' } })
    store.complete(store.nextJob()!.id, direction === 'to_matrix' ? '$parent' : 'h-parent')
    relay.acceptTransaction('reply', [event({ content: { msgtype: 'm.text',
      body: '> <@author:matrix.test> old quoted text\n> another line\n\nThat\'s a wave :)',
      format: 'org.matrix.custom.html', formatted_body: '<mx-reply><blockquote>old quoted text</blockquote></mx-reply>That\'s a wave :)',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$parent' } } } })])
    expect(store.nextJob()!.payload).toMatchObject({ body: "That's a wave :)", formatted_body: "That's a wave :)", reply_to_event_id: '$parent' })
    await relay.tick()
    expect(harmony.canReplyTo).toHaveBeenCalledExactlyOnceWith(channelId, 'h-parent')
    expect(harmony.sendMessage.mock.calls[0][1]).toBe("That's a wave :)")
    expect(harmony.sendMessage.mock.calls[0][3]).toBe('h-parent')
  })
  it('keeps modern replies and unmapped/other-pair parents as clean text without guessing a native target', async () => {
    const { relay, harmony, store } = setup()
    store.enqueue({ direction: 'to_matrix', sourceId: 'h-private', channelId: 'other-channel', roomId, payload: { body: 'old' } })
    store.complete(store.nextJob()!.id, '$unmapped')
    relay.acceptTransaction('reply', [event({ content: { msgtype: 'm.text', body: 'Modern reply without fallback',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$unmapped' } } } })])
    await relay.tick()
    expect(harmony.canReplyTo).not.toHaveBeenCalled()
    expect(harmony.sendMessage.mock.calls[0][1]).toBe('Modern reply without fallback')
    expect(harmony.sendMessage.mock.calls[0][3]).toBeUndefined()
  })
  it('does not attach a deleted or now-private parent, but still delivers the reply text', async () => {
    const { relay, harmony, store } = setup()
    store.enqueue({ direction: 'to_matrix', sourceId: 'h-parent', channelId, roomId, payload: { body: 'old' } })
    store.complete(store.nextJob()!.id, '$parent')
    harmony.canReplyTo.mockResolvedValue(false)
    relay.acceptTransaction('reply', [event({ content: { msgtype: 'm.text', body: '> old\r\n\r\nNew text',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$parent' } } } })])
    await relay.tick()
    expect(harmony.sendMessage.mock.calls[0][1]).toBe('New text')
    expect(harmony.sendMessage.mock.calls[0][3]).toBeUndefined()
  })
  it('parses actual mentions after removing reply HTML, without copying quoted pills', async () => {
    const { relay, harmony, store, config } = setup()
    const ghost = ghostUserId(config, userId)
    store.reserveGhost(ghost, userId); store.registerGhost(ghost)
    relay.acceptTransaction('reply-mention', [event({ content: { msgtype: 'm.text',
      body: '> <@old:matrix.test> old content\n\nHi Alice',
      formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${encodeURIComponent(ghost)}">old content</a></blockquote></mx-reply>Hi <a href="https://matrix.to/#/${encodeURIComponent(ghost)}">Alice</a>`,
      'm.mentions': { user_ids: [ghost] }, 'm.relates_to': { 'm.in_reply_to': { event_id: '$parent' } } } })])
    await relay.tick()
    expect(harmony.sendMessage.mock.calls[0][1]).toEqual([{ type: 'text', text: 'Hi ' },
      { type: 'mention', userId, username: 'Alice', domain: 'harmony.test', isLocal: true, isBridged: false }])
  })
  it('pauses rather than losing a reply if its durable mapping cannot be read', async () => {
    const { relay, harmony, store } = setup()
    relay.acceptTransaction('reply', [event({ content: { msgtype: 'm.text', body: 'Reply',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$parent' } } } })])
    vi.spyOn(store, 'findMapping').mockImplementation(() => { throw new Error('disk failure') })
    await relay.tick()
    expect(relay.isHealthy).toBe(false)
    expect(store.counts().pending).toBe(1)
    expect(harmony.sendMessage).not.toHaveBeenCalled()
  })
  it('strips a large quoted fallback before applying the new-message text limit', async () => {
    const { relay, store } = setup()
    relay.acceptTransaction('reply', [event({ content: { msgtype: 'm.text', body: '> ' + 'old'.repeat(6000) + '\n\nNew text',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$parent' } } } })])
    expect(store.nextJob()!.payload.body).toBe('New text')
  })
  it.each([null, {}, { 'm.in_reply_to': { event_id: 42 } }, { 'm.in_reply_to': { event_id: '$bad id' } },
    { rel_type: 'm.thread', 'm.in_reply_to': { event_id: '$parent' } },
    { rel_type: 'm.replace', 'm.in_reply_to': { event_id: '$parent' } }])('rejects malformed or non-reply relations: %j', relation => {
    const { relay, store } = setup()
    relay.acceptTransaction('bad-reply', [event({ content: { msgtype: 'm.text', body: 'not a plain reply', 'm.relates_to': relation } })])
    expect(store.counts().pending).toBe(0)
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
      event({ content: { msgtype: 'm.sticker', body: 'sticker' } }),
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
      { content_raw: [{ type: 'sticker', url: 'https://private.test/file' }] },
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
  it.each(['m.image', 'm.file', 'm.audio', 'm.video'])('relays file-only Matrix %s as one native POST without queuing bytes or URLs', async msgtype => {
    const { relay, harmony, matrix, store } = setup()
    relay.acceptTransaction('file', [fileEvent({ msgtype, info: { size: 14, metadata: 'SECRET' } })])
    const queued = store.nextJob()!.payload
    expect(queued.body).toBe('')
    expect(queued.files).toEqual([{ index: 0, name: 'report.txt', mxc: 'mxc://matrix.test/report' }])
    expect(JSON.stringify(queued)).not.toContain('SECRET')
    expect(JSON.stringify(queued)).not.toContain('bytes')
    await relay.tick()
    expect(matrix.downloadFile).toHaveBeenCalledExactlyOnceWith('mxc://matrix.test/report', 'report.txt')
    expect(harmony.uploadFile).toHaveBeenCalledOnce()
    expect(harmony.sendMessage).toHaveBeenCalledOnce()
    expect(harmony.sendMessage.mock.calls[0][1]).toEqual([await harmony.uploadFile.mock.results[0].value])
    expect(store.findMapping('to_harmony', '$one', channelId, roomId)).toBe('h-copy')
  })
  it('keeps a Matrix file caption, actual mentions, and mapped native reply context in one POST', async () => {
    const { relay, harmony, config, store } = setup()
    const ghost = ghostUserId(config, userId)
    store.reserveGhost(ghost, userId); store.registerGhost(ghost)
    store.enqueue({ direction: 'to_matrix', sourceId: 'native-parent', channelId, roomId, payload: {} })
    store.complete(store.nextJob()!.id, '$parent')
    relay.acceptTransaction('caption', [fileEvent({ body: '> quoted parent\n\nHi Alice',
      formatted_body: `<mx-reply><blockquote>quoted parent</blockquote></mx-reply>Hi <a href="https://matrix.to/#/${ghost}">Alice</a>`,
      'm.mentions': { user_ids: [ghost] }, 'm.relates_to': { 'm.in_reply_to': { event_id: '$parent' } } })])
    expect(store.nextJob()!.payload.body).toBe('Hi Alice')
    await relay.tick()
    expect(harmony.sendMessage).toHaveBeenCalledOnce()
    const parts = harmony.sendMessage.mock.calls[0][1]
    expect(parts[0]).toEqual({ type: 'text', text: 'Hi ' })
    expect(parts[1]).toMatchObject({ type: 'mention', userId })
    expect(parts[2]).toMatchObject({ type: 'file', fileName: 'report.txt' })
    expect(harmony.sendMessage.mock.calls[0][3]).toBe('native-parent')
  })
  it.each([
    { url: 'https://evil.test/private?token=SECRET' }, { url: 'mxc://bad/../SECRET' },
    { file: { url: 'mxc://matrix.test/encrypted', key: { k: 'SECRET' } } }, { file: null }, { file: false },
    { info: { size: MAX_MEDIA_BYTES + 1 } }, { info: { size: 'oversized SECRET' } },
  ])('gives a safe visible notice for unsupported Matrix attachments %#', async content => {
    const { relay, harmony, matrix, store } = setup()
    relay.acceptTransaction('bad-file', [fileEvent(content)])
    expect(JSON.stringify(store.nextJob()!.payload)).not.toContain('SECRET')
    await relay.tick()
    expect(matrix.downloadFile).not.toHaveBeenCalled()
    expect(harmony.uploadFile).not.toHaveBeenCalled()
    expect(harmony.sendMessage.mock.calls[0][1]).toEqual([{ type: 'text', text: '[Attachment unavailable: report.txt]' }])
  })
  it('separates a failed attachment notice from its retained caption', async () => {
    const { relay, harmony } = setup()
    relay.acceptTransaction('bad-caption-file', [fileEvent({ body: 'Caption.', file: {} })])
    await relay.tick()
    expect(harmony.sendMessage.mock.calls[0][1]).toEqual([{ type: 'text', text: 'Caption.' },
      { type: 'text', text: '\n[Attachment unavailable: report.txt]' }])
  })
  it.each(['relay', 'ghost'])('supports native file-only messages with the %s frozen sender and first-event mapping', async senderMode => {
    const { relay, harmony, matrix, config, store } = setup()
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: senderMode })
    expect(relay.acceptHarmonyMessage(message({ content_raw: [nativeFile()] }))).toBe(true)
    const queued = JSON.stringify(store.nextJob()!.payload)
    expect(queued).not.toContain('SECRET')
    expect(queued).not.toContain('private')
    await relay.tick()
    const sender = senderMode === 'ghost' ? ghostUserId(config, userId) : '@harmony_relay:matrix.test'
    expect(harmony.downloadFile).toHaveBeenCalledExactlyOnceWith(channelId, 'h-one', 0)
    expect(matrix.sendFile.mock.calls[0][2]).toEqual({ mxc: 'mxc://matrix.test/uploaded', name: 'report.txt', contentType: 'text/plain', size: 14 })
    expect(matrix.sendFile.mock.calls[0][3]).toEqual({ sender })
    if (senderMode === 'relay') {
      expect(matrix.sendMessage.mock.calls[0][2]).toContain('[Alice · Harmony]')
      expect(store.findMapping('to_matrix', 'h-one', channelId, roomId)).toBe('$m-copy')
    } else {
      expect(matrix.sendMessage).not.toHaveBeenCalled()
      expect(store.findMapping('to_matrix', 'h-one', channelId, roomId)).toBe('$file-copy')
    }
  })
  it('keeps native text/mentions first and uses raw file indices, not filtered part positions', async () => {
    const { relay, harmony, matrix, store } = setup()
    relay.acceptHarmonyMessage(message({ content_raw: [{ type: 'text', text: 'Hi ' }, nativeFile(),
      { type: 'mention', userId: '@alice:matrix.test', username: 'alice', bridgeSource: 'matrix', isBridged: true },
      { type: 'file', fileName: 'second.pdf' }] }))
    expect(store.nextJob()!.payload.files).toEqual([{ index: 1, name: 'report.txt' }, { index: 3, name: 'second.pdf' }])
    await relay.tick()
    expect(matrix.sendMessage.mock.calls[0][2]).toBe('[Alice · Harmony] Hi @alice')
    expect(matrix.sendMessage.mock.calls[0][3].userIds).toEqual(['@alice:matrix.test'])
    expect(harmony.downloadFile.mock.calls.map(call => call[2])).toEqual([1, 3])
    expect(matrix.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(matrix.sendFile.mock.invocationCallOrder[0])
    expect(matrix.sendFile.mock.calls.map(call => call[1])).toEqual([
      matrix.sendMessage.mock.calls[0][1] + '.file-1', matrix.sendMessage.mock.calls[0][1] + '.file-3',
    ])
    expect(store.findMapping('to_matrix', 'h-one', channelId, roomId)).toBe('$m-copy')
  })
  it('retries multiple Matrix pieces with identical sender/transaction IDs and preserves the first mapping', async () => {
    vi.useFakeTimers()
    const { relay, harmony, matrix, store } = setup()
    let failSecond = true
    harmony.downloadFile.mockImplementation(async (_channel, _message, index) => {
      if (index === 2 && failSecond) { failSecond = false; throw new HttpError('SECRET', true, 503) }
      return { bytes: Buffer.from('data'), name: 'report.txt', contentType: 'text/plain' }
    })
    relay.acceptHarmonyMessage(message({ content_raw: [{ type: 'text', text: 'Files' }, nativeFile(), nativeFile()] }))
    await relay.tick()
    expect(store.counts()).toEqual({ pending: 1, failed: 0 })
    vi.advanceTimersByTime(1000)
    await relay.tick()
    expect(matrix.sendMessage.mock.calls[0]).toEqual(matrix.sendMessage.mock.calls[1])
    expect(matrix.sendFile.mock.calls[0]).toEqual(matrix.sendFile.mock.calls[1])
    expect(matrix.sendFile.mock.calls[2][1]).toMatch(/\.file-2$/)
    expect(store.findMapping('to_matrix', 'h-one', channelId, roomId)).toBe('$m-copy')
  })
  it.each(['download', 'upload', 'send'])('shows permanent native %s failures using the frozen ghost and stable file transaction', async step => {
    const { relay, harmony, matrix, config, store } = setup()
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'ghost' })
    const error = new HttpError('https://evil.test/?token=SECRET', false, 400)
    if (step === 'download') harmony.downloadFile.mockRejectedValue(error)
    if (step === 'upload') matrix.uploadFile.mockRejectedValue(error)
    if (step === 'send') matrix.sendFile.mockRejectedValue(error)
    relay.acceptHarmonyMessage(message({ content_raw: [nativeFile()] }))
    await relay.tick()
    const [, transaction, body, options] = matrix.sendMessage.mock.calls[0]
    expect(transaction).toMatch(/^[a-f0-9]{64}\.file-0$/)
    expect(body).toBe('[Attachment unavailable: report.txt]')
    expect(options).toEqual({ sender: ghostUserId(config, userId) })
    expect(store.counts()).toEqual({ pending: 0, failed: 0 })
  })
  it('turns exhausted transient media failure into a visible notice, without retrying forever', async () => {
    const { relay, harmony, matrix, store } = setup()
    relay.acceptHarmonyMessage(message({ content_raw: [nativeFile()] }))
    for (let attempt = 0; attempt < 7; attempt++) store.retry(store.nextJob()!.id, 'retry', 0)
    harmony.downloadFile.mockRejectedValue(new HttpError('SECRET', true, 503))
    await relay.tick()
    expect(matrix.sendMessage.mock.calls.at(-1)![2]).toBe('[Attachment unavailable: report.txt]')
    expect(store.counts()).toEqual({ pending: 0, failed: 0 })
  })
  it('bounds native transfers to twenty files and one extra visible notice', async () => {
    const { relay, harmony, matrix, store } = setup()
    relay.acceptHarmonyMessage(message({ content_raw: Array.from({ length: 30 }, () => nativeFile()) }))
    expect((store.nextJob()!.payload.files as unknown[]).length).toBe(21)
    await relay.tick()
    expect(harmony.downloadFile).toHaveBeenCalledTimes(20)
    expect(matrix.sendFile).toHaveBeenCalledTimes(20)
    expect(matrix.sendMessage.mock.calls.at(-1)![2]).toBe('[Attachment unavailable: Additional attachments (limit 20)]')
  })
  it('finishes twenty native files below the default 100-request budget per policy route', async () => {
    const { relay, harmony, matrix, store } = setup()
    relay.acceptHarmonyMessage(message({ content_raw: Array.from({ length: 20 }, () => nativeFile()) }))
    await relay.tick()
    expect(matrix.sendFile).toHaveBeenCalledTimes(20)
    expect(store.counts()).toEqual({ pending: 0, failed: 0 })
    for (const method of [harmony.requireMatrixBridge, harmony.bridgeRoom, harmony.channelIsPlaintext, harmony.relayAllowed]) {
      expect(method.mock.calls.length).toBeLessThan(100)
    }
  })
  it('blocks the upload if consent changes during a successful native download', async () => {
    const { relay, harmony, matrix, store } = setup()
    harmony.downloadFile.mockImplementation(async () => {
      harmony.relayAllowed.mockResolvedValue(false)
      return { bytes: Buffer.from('bytes'), name: 'report.txt', contentType: 'text/plain' }
    })
    relay.acceptHarmonyMessage(message({ content_raw: [nativeFile()] }))
    await relay.tick()
    expect(matrix.uploadFile).not.toHaveBeenCalled()
    expect(matrix.sendFile).not.toHaveBeenCalled()
    expect(matrix.sendMessage).toHaveBeenCalledOnce()
    expect(matrix.sendMessage.mock.calls[0][2]).not.toContain('Attachment unavailable')
    expect(store.counts().failed).toBe(1)
  })
  it('does not download an oversized native file and gives a visible notice', async () => {
    const { relay, harmony, matrix } = setup()
    relay.acceptHarmonyMessage(message({ content_raw: [nativeFile({ fileSize: MAX_MEDIA_BYTES + 1 })] }))
    await relay.tick()
    expect(harmony.downloadFile).not.toHaveBeenCalled()
    expect(matrix.uploadFile).not.toHaveBeenCalled()
    expect(matrix.sendMessage.mock.calls.at(-1)![2]).toBe('[Attachment unavailable: report.txt]')
  })
  it('retries Matrix-to-Harmony media before its single POST, but never blindly retries an ambiguous final POST', async () => {
    vi.useFakeTimers()
    const { relay, harmony, matrix, store } = setup()
    matrix.downloadFile.mockRejectedValueOnce(new HttpError('temporary', true, 503))
    relay.acceptTransaction('file', [fileEvent({ body: 'Caption', filename: 'report.txt' })])
    await relay.tick()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
    expect(store.counts().pending).toBe(1)
    vi.advanceTimersByTime(1000)
    harmony.sendMessage.mockRejectedValue(new HttpError('ambiguous POST', true, 503))
    await relay.tick()
    await relay.tick()
    expect(harmony.sendMessage).toHaveBeenCalledOnce()
    expect(store.counts()).toEqual({ pending: 0, failed: 1 })
  })
  it.each(['unpair', 'consent', 'encryption', 'mode'])('does not turn a native media failure into a notice after late %s change', async change => {
    const { relay, harmony, matrix, store } = setup()
    harmony.downloadFile.mockImplementation(async () => {
      if (change === 'unpair') harmony.requireMatrixBridge.mockRejectedValue(new HttpError('revoked', false, 403))
      if (change === 'consent') harmony.relayAllowed.mockResolvedValue(false)
      if (change === 'encryption') matrix.roomIsPlaintext.mockResolvedValue(false)
      if (change === 'mode') harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'ghost' })
      throw new HttpError('transfer failed SECRET', false, 400)
    })
    relay.acceptHarmonyMessage(message({ content_raw: [nativeFile()] }))
    await relay.tick()
    expect(matrix.uploadFile).not.toHaveBeenCalled()
    expect(matrix.sendFile).not.toHaveBeenCalled()
    expect(matrix.sendMessage).toHaveBeenCalledOnce() // The authorized attribution text preceded the change.
    expect(matrix.sendMessage.mock.calls[0][2]).not.toContain('Attachment unavailable')
    expect(store.counts().failed).toBe(1)
  })
  it('honors a durable encryption event received during Matrix media download before uploading any bytes', async () => {
    const { relay, harmony, matrix, store } = setup()
    matrix.downloadFile.mockImplementation(async () => {
      relay.acceptTransaction('encrypt', [{ type: 'm.room.encryption', room_id: roomId }])
      return { bytes: Buffer.from('bytes'), name: 'report.txt', contentType: 'text/plain' }
    })
    relay.acceptTransaction('file', [fileEvent()])
    await relay.tick()
    expect(harmony.uploadFile).not.toHaveBeenCalled()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
    expect(store.counts().failed).toBe(1)
  })
  it('rechecks destination encryption after an upload failure rather than posting a fallback', async () => {
    const { relay, harmony, store } = setup()
    harmony.uploadFile.mockImplementation(async () => {
      harmony.channelIsPlaintext.mockResolvedValue(false)
      throw new HttpError('invalid bytes SECRET', false, 400)
    })
    relay.acceptTransaction('file', [fileEvent()])
    await relay.tick()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
    expect(store.counts().failed).toBe(1)
  })
  it.each(['download', 'upload'])('uses one safe native POST for a permanent Matrix media %s failure', async step => {
    const { relay, harmony, matrix } = setup()
    if (step === 'download') matrix.downloadFile.mockRejectedValue(new HttpError('https://evil.test/?token=SECRET', false, 404))
    else harmony.uploadFile.mockRejectedValue(new HttpError('https://evil.test/?token=SECRET', false, 400))
    relay.acceptTransaction('file', [fileEvent({ body: 'Keep caption', filename: 'report.txt' })])
    await relay.tick()
    expect(harmony.sendMessage).toHaveBeenCalledOnce()
    expect(harmony.sendMessage.mock.calls[0][1]).toEqual([{ type: 'text', text: 'Keep caption' }, { type: 'text', text: '\n[Attachment unavailable: report.txt]' }])
  })
  it.each([
    { index: 1.5, name: 'report.txt' }, { index: -1, name: 'report.txt' }, { index: 1000, name: 'report.txt' },
    { index: 0, name: 'report.txt', unavailable: 'true' },
    { index: 0, name: 'report.txt', mxc: 'https://private.test/?token=SECRET' },
    { index: 0, name: 'report.txt' },
  ])('rejects malformed persisted Matrix file descriptors without downloading or emitting a notice: %j', async descriptor => {
    const { relay, harmony, matrix, store } = setup()
    store.enqueue({ direction: 'to_harmony', sourceId: '$bad', channelId, roomId,
      payload: { sender: '@alice:matrix.test', body: '', files: [descriptor] } })
    await relay.tick()
    expect(matrix.downloadFile).not.toHaveBeenCalled()
    expect(harmony.uploadFile).not.toHaveBeenCalled()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
    expect(store.counts()).toEqual({ pending: 0, failed: 1 })
  })
  it('blocks file send if native consent is withdrawn during a successful Matrix upload', async () => {
    const { relay, harmony, matrix, store } = setup()
    matrix.uploadFile.mockImplementation(async () => { harmony.relayAllowed.mockResolvedValue(false); return 'mxc://matrix.test/uploaded' })
    relay.acceptHarmonyMessage(message({ content_raw: [nativeFile()] }))
    await relay.tick()
    expect(matrix.uploadFile).toHaveBeenCalledOnce()
    expect(matrix.sendFile).not.toHaveBeenCalled()
    expect(matrix.sendMessage).toHaveBeenCalledOnce()
    expect(matrix.sendMessage.mock.calls[0][2]).not.toContain('Attachment unavailable')
    expect(store.counts().failed).toBe(1)
  })
  it('does not turn a failed Matrix file send into a fallback after binding revocation', async () => {
    const { relay, harmony, matrix } = setup()
    matrix.sendFile.mockImplementation(async () => {
      harmony.requireMatrixBridge.mockRejectedValue(new HttpError('revoked', false, 403))
      throw new HttpError('bad request', false, 400)
    })
    relay.acceptHarmonyMessage(message({ content_raw: [nativeFile()] }))
    await relay.tick()
    expect(matrix.sendFile).toHaveBeenCalledOnce()
    expect(matrix.sendMessage).toHaveBeenCalledOnce()
  })
  it('retains the attachment and emits a bounded notice when native caption text is malformed or too long', async () => {
    const { relay, matrix, store } = setup()
    relay.acceptHarmonyMessage(message({ content_raw: [{ type: 'text', text: 'x'.repeat(20_000) }, nativeFile()] }))
    expect(JSON.stringify(store.nextJob()!.payload)).not.toContain('x'.repeat(100))
    expect(store.nextJob()!.payload.parts).toEqual([{ type: 'text', text: '[Message text unavailable]' }])
    await relay.tick()
    expect(matrix.sendFile).toHaveBeenCalledOnce()
    expect(matrix.sendMessage.mock.calls[0][2]).toContain('[Message text unavailable]')
  })
  it('never downloads a file-only message after opt-out while queued', async () => {
    const { relay, harmony, matrix } = setup()
    relay.acceptHarmonyMessage(message({ content_raw: [nativeFile()] }))
    harmony.relayAllowed.mockResolvedValue(false)
    await relay.tick()
    expect(harmony.downloadFile).not.toHaveBeenCalled()
    expect(matrix.uploadFile).not.toHaveBeenCalled()
    expect(matrix.sendMessage).not.toHaveBeenCalled()
    expect(matrix.sendFile).not.toHaveBeenCalled()
  })
  it('does not accept unrelated Discord-bot or legacy Discord bridge attachments', () => {
    const { relay, store } = setup()
    for (const override of [{ author: { id: userId, discord_user: { id: '123' } } }, { metadata: { discord_user: { id: '123' } } },
      { author: { id: userId, bot: true } }]) {
      expect(relay.acceptHarmonyMessage(message({ content_raw: [nativeFile()], ...override }))).toBe(false)
    }
    expect(store.counts().pending).toBe(0)
  })
  it('does not upload actual downloaded bytes beyond the limit even when advertised size was small', async () => {
    const { relay, harmony, matrix } = setup()
    harmony.downloadFile.mockResolvedValue({ bytes: Buffer.allocUnsafe(MAX_MEDIA_BYTES + 1), name: 'huge.bin', contentType: 'application/octet-stream' })
    relay.acceptHarmonyMessage(message({ content_raw: [nativeFile({ fileSize: 1 })] }))
    await relay.tick()
    expect(matrix.uploadFile).not.toHaveBeenCalled()
    expect(matrix.sendFile).not.toHaveBeenCalled()
    expect(matrix.sendMessage.mock.calls.at(-1)![2]).toBe('[Attachment unavailable: report.txt]')
  })
  it.each(['to_matrix', 'to_harmony'])('does not transfer or emit attachment notices into encrypted rooms (%s)', async direction => {
    const { relay, harmony, matrix } = setup()
    if (direction === 'to_matrix') relay.acceptHarmonyMessage(message({ content_raw: [nativeFile()] }))
    else relay.acceptTransaction('file', [fileEvent({ file: { url: 'mxc://matrix.test/encrypted', key: 'SECRET' } })])
    matrix.roomIsPlaintext.mockResolvedValue(false)
    await relay.tick()
    expect(harmony.downloadFile).not.toHaveBeenCalled()
    expect(matrix.downloadFile).not.toHaveBeenCalled()
    expect(harmony.uploadFile).not.toHaveBeenCalled()
    expect(matrix.uploadFile).not.toHaveBeenCalled()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
    expect(matrix.sendMessage).not.toHaveBeenCalled()
    expect(matrix.sendFile).not.toHaveBeenCalled()
  })
  it('maps a reply to a later Matrix file event back to the native original, not just the first text event', async () => {
    const { relay, harmony, matrix, store } = setup()
    matrix.sendFile.mockResolvedValue({ event_id: '$later-file' })
    relay.acceptHarmonyMessage(message({ content_raw: [{ type: 'text', text: 'Caption' }, nativeFile()] }))
    await relay.tick()
    expect(store.findMapping('to_matrix', 'h-one', channelId, roomId)).toBe('$m-copy')
    expect(store.findSource('to_matrix', '$later-file', channelId, roomId)).toBe('h-one')
    expect(store.findSource('to_matrix', '$later-file', 'other-channel', roomId)).toBeNull()
    relay.acceptTransaction('reply-to-file', [event({ content: { msgtype: 'm.text', body: 'File reply',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$later-file' } } } })])
    await relay.tick()
    expect(harmony.canReplyTo).toHaveBeenCalledWith(channelId, 'h-one')
    expect(harmony.sendMessage.mock.calls[0][3]).toBe('h-one')
  })
  it.each(['text', 'file', 'notice'])('pauses with the job intact if recording an acknowledged Matrix %s fails', async piece => {
    const { relay, harmony, matrix, store } = setup()
    harmony.bridgeRoom.mockResolvedValue({ room_id: roomId, sender_mode: 'ghost' })
    if (piece === 'notice') harmony.downloadFile.mockRejectedValue(new HttpError('gone', false, 404))
    vi.spyOn(store, 'recordDestination').mockImplementation(() => { throw new StorageError('disk') })
    relay.acceptHarmonyMessage(message({ content_raw: piece === 'text' ? [{ type: 'text', text: 'Caption' }, nativeFile()] : [nativeFile()] }))
    await relay.tick()
    expect(relay.isHealthy).toBe(false)
    expect(store.counts()).toEqual({ pending: 1, failed: 0 })
    expect(store.recordDestination).toHaveBeenCalledOnce()
    if (piece === 'file') {
      expect(matrix.sendFile).toHaveBeenCalledOnce()
      expect(matrix.sendMessage).not.toHaveBeenCalled()
    } else {
      expect(matrix.sendMessage).toHaveBeenCalledOnce()
      expect(matrix.sendFile).not.toHaveBeenCalled()
    }
  })
  it('pauses with media work intact on a storage fault after download instead of sending a fallback', async () => {
    const { relay, harmony, matrix, store } = setup()
    matrix.downloadFile.mockImplementation(async () => {
      vi.spyOn(store, 'isRoomBlocked').mockImplementation(() => { throw new Error('disk') })
      return { bytes: Buffer.from('bytes'), name: 'report.txt', contentType: 'text/plain' }
    })
    relay.acceptTransaction('file', [fileEvent()])
    await relay.tick()
    expect(relay.isHealthy).toBe(false)
    expect(store.counts()).toEqual({ pending: 1, failed: 0 })
    expect(harmony.uploadFile).not.toHaveBeenCalled()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
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
