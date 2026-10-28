import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { indexedDB } from 'fake-indexeddb'

import { MegolmService } from '../MegolmService'
import { RecoveryKeyService } from '../RecoveryKeyService'
import { megolmKeyBackupService, type KeyRequest } from '../MegolmKeyBackupService'
import { identityKeyStore, signingKeyStore } from '../SecureSessionKeyStore'
import {
  generateSigningKeyPair,
  exportPublicSigningKey,
  exportPrivateSigningKey,
  importPrivateSigningKey,
  signKeyRequest,
} from '../MessageSigner'
import { supabase } from '@/supabase'

const repairSessionShareForUser = vi.fn(async () => true)
vi.mock('../MegolmMessageEncryptionService', () => ({
  megolmMessageEncryptionService: { repairSessionShareForUser },
}))

const TEST_MNEMONIC = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent',
  'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'
]
const ME = 'aaaaaaaa-1111-2222-3333-444444444444'
const SENDER = 'bbbbbbbb-1111-2222-3333-444444444444'
const RELAY = 'cccccccc-1111-2222-3333-444444444444'
const REQUESTER = 'dddddddd-1111-2222-3333-444444444444'
const ROOM = 'eeeeeeee-1111-2222-3333-444444444444'
const SESSION = 'c2Vzc2lvbi1pZC0xMjM0NQ=='
const SESSION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))

interface Call {
  table: string
  op: 'select' | 'insert' | 'update' | 'upsert'
  payload?: any
  filters: Array<[string, string, unknown]>
  single?: boolean
}

interface Published { identity_public_key: string; identity_signing_public_key?: string }

const service = megolmKeyBackupService as any

let megolm: MegolmService
let calls: Call[]
let rpcCalls: Array<{ name: string; args: any }>
let published: Map<string, Published>
let privateKeys: Map<string, CryptoKey>
let insertResults: Array<{ error: any }>
let fulfilledRows: any[]
let messageRow: any
let rpcHandler: (name: string, args: any) => { data: any; error: any }

function eqFilter(call: Call, field: string): unknown {
  return call.filters.find(([op, f]) => op === 'eq' && f === field)?.[2]
}

function respond(call: Call): { data: any; error: any } {
  if (call.table === 'user_key_pairs') {
    const inFilter = call.filters.find(([op, f]) => op === 'in' && f === 'user_id')
    if (inFilter) {
      const ids = inFilter[2] as string[]
      return {
        data: ids.filter(id => published.has(id)).map(id => ({ user_id: id, ...published.get(id)! })),
        error: null,
      }
    }
    const row = published.get(eqFilter(call, 'user_id') as string)
    return { data: row ?? null, error: null }
  }
  if (call.table === 'messages') return { data: messageRow, error: null }
  if (call.table === 'megolm_key_requests') {
    if (call.op === 'insert') return insertResults.shift() ?? { error: null, data: null }
    if (call.op === 'select') return { data: fulfilledRows, error: null }
  }
  return { data: null, error: null }
}

function fromMock(table: string) {
  const call: Call = { table, op: 'select', filters: [] }
  calls.push(call)
  const builder: any = {
    select: () => builder,
    insert: (payload: any) => { call.op = 'insert'; call.payload = payload; return builder },
    update: (payload: any) => { call.op = 'update'; call.payload = payload; return builder },
    upsert: (payload: any) => { call.op = 'upsert'; call.payload = payload; return builder },
    eq: (f: string, v: unknown) => { call.filters.push(['eq', f, v]); return builder },
    in: (f: string, v: unknown) => { call.filters.push(['in', f, v]); return builder },
    not: (f: string, _o: string, v: unknown) => { call.filters.push(['not', f, v]); return builder },
    order: () => builder,
    maybeSingle: () => { call.single = true; return Promise.resolve(respond(call)) },
    single: () => { call.single = true; return Promise.resolve(respond(call)) },
    then: (resolve: any, reject: any) => Promise.resolve(respond(call)).then(resolve, reject),
  }
  return builder
}

async function addIdentity(userId: string): Promise<void> {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits'],
  ) as CryptoKeyPair
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey)
  published.set(userId, { identity_public_key: btoa(String.fromCharCode(...new Uint8Array(raw))) })
  privateKeys.set(userId, kp.privateKey)
}

/** Wraps a session key from `wrapper` to `recipient` with the service's own ECDH wrap. */
async function wrapAs(wrapper: string, recipient: string, sessionKey: string): Promise<string> {
  const previous = service.userId
  await identityKeyStore.store(wrapper, privateKeys.get(wrapper)!)
  service.userId = wrapper
  try {
    return await service.encryptSessionKeyForUser(sessionKey, published.get(recipient)!.identity_public_key)
  } finally {
    service.userId = previous
  }
}

async function unwrapAs(recipient: string, wrapper: string, wrapped: string): Promise<string> {
  const previous = service.userId
  await identityKeyStore.store(recipient, privateKeys.get(recipient)!)
  service.userId = recipient
  try {
    return await service.decryptSessionKeyFromSender(wrapped, published.get(wrapper)!.identity_public_key)
  } finally {
    service.userId = previous
  }
}

async function signedRequest(overrides: Partial<KeyRequest>): Promise<KeyRequest> {
  const kp = await generateSigningKeyPair()
  published.set(REQUESTER, {
    ...published.get(REQUESTER)!,
    identity_signing_public_key: await exportPublicSigningKey(kp.publicKey),
  })
  const request: KeyRequest = {
    id: 'ffffffff-1111-2222-3333-444444444444',
    requester_user_id: REQUESTER,
    sender_user_id: SENDER,
    room_id: ROOM,
    session_id: SESSION,
    status: 'pending',
    created_at: new Date().toISOString(),
    accepts_relay: true,
    key_scope: 'session',
    ...overrides,
  }
  request.request_signature = await signKeyRequest(
    { room_id: request.room_id, session_id: request.session_id, requester_user_id: request.requester_user_id },
    kp.privateKey,
  )
  return request
}

const rpcNamed = (name: string) => rpcCalls.filter(c => c.name === name)
const updatesOf = (table: string) => calls.filter(c => c.table === table && c.op === 'update')

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`harmony_megolm_sessions_${ME}`)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
  const recovery = RecoveryKeyService.getInstance()
  recovery.clear()
  megolm = MegolmService.getInstance()
  megolm.close()
  const keys = await recovery.deriveKeysFromMnemonic(TEST_MNEMONIC)
  await megolm.initialize(ME, keys.encryptionKey)

  calls = []
  rpcCalls = []
  published = new Map()
  privateKeys = new Map()
  insertResults = []
  fulfilledRows = []
  messageRow = null
  rpcHandler = (name) => name === 'fulfill_megolm_key_request'
    ? { data: true, error: null }
    : { data: [], error: null }

  for (const id of [ME, SENDER, RELAY, REQUESTER]) await addIdentity(id)
  await identityKeyStore.store(ME, privateKeys.get(ME)!)

  service.cleanup()
  service.userId = ME
  service.requesterKeyCache.clear()
  service.myFingerprintCache = null
  repairSessionShareForUser.mockClear()

  ;(supabase.from as any).mockImplementation(fromMock)
  ;(supabase.rpc as any).mockImplementation(async (name: string, args: any) => {
    rpcCalls.push({ name, args })
    return rpcHandler(name, args)
  })
})

afterEach(async () => {
  service.cleanup()
  service.userId = null
  megolm.close()
  for (const id of [ME, SENDER, RELAY, REQUESTER]) await identityKeyStore.clear(id).catch(() => {})
  await signingKeyStore.clear(ME).catch(() => {})
})

describe('a key request', () => {
  beforeEach(async () => {
    const kp = await generateSigningKeyPair()
    published.set(ME, { ...published.get(ME)!, identity_signing_public_key: await exportPublicSigningKey(kp.publicKey) })
    await signingKeyStore.store(ME, await importPrivateSigningKey(await exportPrivateSigningKey(kp.privateKey), false))
  })

  it('names the sender and accepts relayed keys', async () => {
    await megolmKeyBackupService.createKeyRequest(ROOM, SESSION, SENDER)
    const inserts = calls.filter(c => c.table === 'megolm_key_requests' && c.op === 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].payload).toMatchObject({
      requester_user_id: ME,
      sender_user_id: SENDER,
      room_id: ROOM,
      session_id: SESSION,
      accepts_relay: true,
    })
    expect(inserts[0].payload.request_signature).toBeTruthy()
  })

  it('names the message, and a pinned message gets a request of its own', async () => {
    await megolmKeyBackupService.createKeyRequest(ROOM, SESSION, SENDER, { id: 'm-unpinned-1', pinned: false })
    await megolmKeyBackupService.createKeyRequest(ROOM, SESSION, SENDER, { id: 'm-unpinned-2', pinned: false })
    await megolmKeyBackupService.createKeyRequest(ROOM, SESSION, SENDER, { id: 'm-pinned-1', pinned: true })
    await megolmKeyBackupService.createKeyRequest(ROOM, SESSION, SENDER, { id: 'm-pinned-1', pinned: true })
    await megolmKeyBackupService.createKeyRequest(ROOM, SESSION, SENDER, { id: 'm-pinned-2', pinned: true })
    const inserts = calls.filter(c => c.table === 'megolm_key_requests' && c.op === 'insert')
    expect(inserts.map(c => c.payload.message_id)).toEqual(['m-unpinned-1', 'm-pinned-1', 'm-pinned-2'])
  })

  it('goes out without accepts_relay to a server that lacks the column', async () => {
    insertResults = [{ error: { code: 'PGRST204', message: "Could not find the 'accepts_relay' column" } }]
    await megolmKeyBackupService.createKeyRequest(ROOM, SESSION, SENDER)
    const inserts = calls.filter(c => c.table === 'megolm_key_requests' && c.op === 'insert')
    expect(inserts).toHaveLength(2)
    expect(inserts[1].payload).not.toHaveProperty('accepts_relay')
    expect(inserts[1].payload).not.toHaveProperty('message_id')
    expect(inserts[1].payload.sender_user_id).toBe(SENDER)
  })
})

describe('answering a key request', () => {
  it('the sender answers through fulfill_megolm_key_request and repairs the share', async () => {
    const outbound = await megolm.getOrCreateOutboundSession(ROOM)
    const request = await signedRequest({ sender_user_id: ME, session_id: outbound.sessionId, accepts_relay: false })

    expect(await service.handleIncomingKeyRequest(request)).toBe(true)

    const [fulfil] = rpcNamed('fulfill_megolm_key_request')
    expect(fulfil.args.p_request_id).toBe(request.id)
    expect(fulfil.args.p_key_scope).toBe('session')
    expect(await unwrapAs(REQUESTER, ME, fulfil.args.p_encrypted_key)).toBe(outbound.sessionKey)
    expect(repairSessionShareForUser).toHaveBeenCalledWith(ROOM, outbound.sessionId, REQUESTER, outbound.sessionKey)
    expect(updatesOf('megolm_key_requests')).toHaveLength(0)
  })

  it("the sender's other device answers its own request and writes no share", async () => {
    const outbound = await megolm.getOrCreateOutboundSession(ROOM)
    const kp = await generateSigningKeyPair()
    published.set(ME, { ...published.get(ME)!, identity_signing_public_key: await exportPublicSigningKey(kp.publicKey) })
    const request: KeyRequest = {
      id: 'f0f0f0f0-1111-2222-3333-444444444444', requester_user_id: ME, sender_user_id: ME, room_id: ROOM,
      session_id: outbound.sessionId, status: 'pending', created_at: new Date().toISOString(), accepts_relay: true, key_scope: 'session',
    }
    request.request_signature = await signKeyRequest(
      { room_id: ROOM, session_id: outbound.sessionId, requester_user_id: ME }, kp.privateKey)

    expect(await service.handleIncomingKeyRequest(request)).toBe(true)

    const [fulfil] = rpcNamed('fulfill_megolm_key_request')
    expect(await unwrapAs(ME, ME, fulfil.args.p_encrypted_key)).toBe(outbound.sessionKey)
    expect(repairSessionShareForUser).not.toHaveBeenCalled()
  })

  it('a member holding the session relays it when the request accepts relays', async () => {
    await megolm.importInboundSession(ROOM, SENDER, SESSION, SESSION_KEY, 0)
    const request = await signedRequest({})

    expect(await service.handleIncomingKeyRequest(request)).toBe(true)

    const [fulfil] = rpcNamed('fulfill_megolm_key_request')
    expect(await unwrapAs(REQUESTER, ME, fulfil.args.p_encrypted_key)).toBe(SESSION_KEY)
    expect(repairSessionShareForUser).not.toHaveBeenCalled()
  })

  it('a member does not relay for a request addressed to its sender only', async () => {
    await megolm.importInboundSession(ROOM, SENDER, SESSION, SESSION_KEY, 0)
    const request = await signedRequest({ accepts_relay: false })

    expect(await service.handleIncomingKeyRequest(request)).toBe(false)
    expect(rpcNamed('fulfill_megolm_key_request')).toHaveLength(0)
  })

  it('a session filed under another sender is not relayed', async () => {
    await megolm.importInboundSession(ROOM, RELAY, SESSION, SESSION_KEY, 0)
    const request = await signedRequest({})

    expect(await service.handleIncomingKeyRequest(request)).toBe(false)
    expect(rpcNamed('fulfill_megolm_key_request')).toHaveLength(0)
  })

  it('an unsigned request is not answered', async () => {
    await megolm.importInboundSession(ROOM, SENDER, SESSION, SESSION_KEY, 0)
    const request = await signedRequest({})
    delete request.request_signature

    expect(await service.handleIncomingKeyRequest(request)).toBe(false)
    expect(rpcNamed('fulfill_megolm_key_request')).toHaveLength(0)
  })

  it('a lost race reports not fulfilled', async () => {
    await megolm.importInboundSession(ROOM, SENDER, SESSION, SESSION_KEY, 0)
    rpcHandler = () => ({ data: false, error: null })

    expect(await service.handleIncomingKeyRequest(await signedRequest({}))).toBe(false)
  })

  it('on a server without the RPC the sender answers directly once the requester is in the room', async () => {
    const outbound = await megolm.getOrCreateOutboundSession(ROOM)
    rpcHandler = (name) => name === 'is_room_member'
      ? { data: true, error: null }
      : { data: null, error: { code: 'PGRST202', message: 'not found' } }
    const request = await signedRequest({ sender_user_id: ME, session_id: outbound.sessionId })
    delete request.key_scope
    delete request.accepts_relay

    expect(await service.handleIncomingKeyRequest(request)).toBe(true)

    expect(rpcNamed('is_room_member')[0].args).toEqual({ p_room_id: ROOM, p_user_id: REQUESTER })
    const [update] = updatesOf('megolm_key_requests')
    expect(update.payload.status).toBe('fulfilled')
    expect(eqFilter(update, 'id')).toBe(request.id)
  })

  it('on a server without the RPC a member does not relay', async () => {
    await megolm.importInboundSession(ROOM, SENDER, SESSION, SESSION_KEY, 0)
    rpcHandler = () => ({ data: null, error: { code: 'PGRST202', message: 'not found' } })
    const request = await signedRequest({})
    delete request.key_scope

    expect(await service.handleIncomingKeyRequest(request)).toBe(false)
    expect(rpcCalls).toHaveLength(0)
    expect(updatesOf('megolm_key_requests')).toHaveLength(0)
  })

  it('never answers a request the server gives no scope, even as its sender', async () => {
    const outbound = await megolm.getOrCreateOutboundSession(ROOM)
    const request = await signedRequest({ sender_user_id: ME, session_id: outbound.sessionId, key_scope: null })

    expect(await service.handleIncomingKeyRequest(request)).toBe(false)
    expect(rpcNamed('fulfill_megolm_key_request')).toHaveLength(0)
  })

  describe('pinned only', () => {
    const MESSAGE = '45454545-1111-2222-3333-444444444444'
    const pinnedRow = (over: Record<string, unknown> = {}) => ({
      user_id: SENDER, channel_id: ROOM, conversation_id: null, is_pinned: true, is_deleted: false,
      encryption_metadata: { session_id: SESSION, message_index: 3 },
      ...over,
    })
    const messageRequest = () => signedRequest({ key_scope: 'message', message_id: MESSAGE, message_index: 3 })

    it('hands over the key of the pinned message alone', async () => {
      await megolm.importInboundSession(ROOM, SENDER, SESSION, SESSION_KEY, 0)
      messageRow = pinnedRow()

      expect(await service.handleIncomingKeyRequest(await messageRequest())).toBe(true)

      const [fulfil] = rpcNamed('fulfill_megolm_key_request')
      expect(fulfil.args.p_key_scope).toBe('message')
      const handed = await unwrapAs(REQUESTER, ME, fulfil.args.p_encrypted_key)
      expect(handed).toBe(await megolm.deriveMessageKey(SESSION_KEY, 3))
      expect(handed).not.toBe(SESSION_KEY)
      expect(eqFilter(calls.find(c => c.table === 'messages')!, 'id')).toBe(MESSAGE)
    })

    it('relays a single message key it holds without the session', async () => {
      const messageKey = await megolm.deriveMessageKey(SESSION_KEY, 3)
      await megolm.importMessageKey(ROOM, SENDER, SESSION, 3, messageKey)
      messageRow = pinnedRow()

      expect(await service.handleIncomingKeyRequest(await messageRequest())).toBe(true)
      expect(await unwrapAs(REQUESTER, ME, rpcNamed('fulfill_megolm_key_request')[0].args.p_encrypted_key)).toBe(messageKey)
    })

    it.each([
      ['a message that is not pinned', { is_pinned: false }],
      ['a deleted message', { is_deleted: true }],
      ['another sender\'s message', { user_id: RELAY }],
      ['a message of another session', { encryption_metadata: { session_id: 'b3RoZXI=', message_index: 3 } }],
      ['a message at another index', { encryption_metadata: { session_id: SESSION, message_index: 4 } }],
    ])('does not answer for %s', async (_name, over) => {
      await megolm.importInboundSession(ROOM, SENDER, SESSION, SESSION_KEY, 0)
      messageRow = pinnedRow(over)

      expect(await service.handleIncomingKeyRequest(await messageRequest())).toBe(false)
      expect(rpcNamed('fulfill_megolm_key_request')).toHaveLength(0)
    })

    it('holds only message keys of other indices: no answer', async () => {
      await megolm.importMessageKey(ROOM, SENDER, SESSION, 5, 'a2V5')
      messageRow = pinnedRow()
      expect(await service.handleIncomingKeyRequest(await messageRequest())).toBe(false)
    })
  })

  it('the unlock sweep answers listed requests for sessions held here', async () => {
    await megolm.importInboundSession(ROOM, SENDER, SESSION, SESSION_KEY, 0)
    const held = await signedRequest({})
    const notHeld = { ...held, id: '99999999-1111-2222-3333-444444444444', session_id: 'b3RoZXI=' }
    rpcHandler = (name) => name === 'get_relayable_key_requests'
      ? { data: [held, notHeld], error: null }
      : { data: true, error: null }

    expect(await megolmKeyBackupService.processPendingRequestsToMe()).toBe(1)
    expect(rpcNamed('fulfill_megolm_key_request').map(c => c.args.p_request_id)).toEqual([held.id])
  })
})

describe('receiving a fulfilled key', () => {
  const fulfilled = (overrides: Partial<KeyRequest>): KeyRequest => ({
    id: '12121212-1111-2222-3333-444444444444',
    requester_user_id: ME,
    sender_user_id: SENDER,
    room_id: ROOM,
    session_id: SESSION,
    status: 'fulfilled',
    created_at: new Date().toISOString(),
    ...overrides,
  })

  it("imports the sender's key", async () => {
    const request = fulfilled({ encrypted_key: await wrapAs(SENDER, ME, SESSION_KEY), fulfilled_by_user_id: null })

    expect(await service.handleFulfilledRequest(request)).toBe('imported')
    expect(megolm.getInboundSession(ROOM, SENDER, SESSION)?.sessionKey).toBe(SESSION_KEY)
    expect(updatesOf('megolm_key_requests')[0].payload).toEqual({ status: 'received' })
  })

  it('holds a relayed key without importing it and asks the UI to retry', async () => {
    const received = vi.fn()
    megolmKeyBackupService.onKeyReceived(received)
    const request = fulfilled({ encrypted_key: await wrapAs(RELAY, ME, SESSION_KEY), fulfilled_by_user_id: RELAY })

    expect(await service.handleFulfilledRequest(request)).toBe('relayed')
    expect(megolm.hasInboundSession(ROOM, SENDER, SESSION)).toBe(false)
    expect(megolmKeyBackupService.relayedKeysFor(ROOM, SENDER, SESSION)).toEqual([
      { requestId: request.id, roomId: ROOM, senderUserId: SENDER, sessionId: SESSION, sessionKey: SESSION_KEY, scope: 'session', messageId: null },
    ])
    expect(received).toHaveBeenCalledWith(ROOM, SESSION)
    expect(updatesOf('megolm_key_requests')).toHaveLength(0)
  })

  it("holds the sender's key of a single message for verification", async () => {
    const messageKey = await megolm.deriveMessageKey(SESSION_KEY, 3)
    const request = fulfilled({
      encrypted_key: await wrapAs(SENDER, ME, messageKey), fulfilled_by_user_id: SENDER,
      key_scope: 'message', message_id: 'm-pinned',
    })

    expect(await service.handleFulfilledRequest(request)).toBe('relayed')
    expect(megolm.getMessageKey(ROOM, SENDER, SESSION, 3)).toBeUndefined()
    expect(megolmKeyBackupService.relayedKeysFor(ROOM, SENDER, SESSION)).toEqual([
      { requestId: request.id, roomId: ROOM, senderUserId: SENDER, sessionId: SESSION, sessionKey: messageKey, scope: 'message', messageId: 'm-pinned' },
    ])
  })

  it('an accepted message key cancels only the pending requests for that message', async () => {
    await service.handleFulfilledRequest(fulfilled({
      encrypted_key: await wrapAs(RELAY, ME, await megolm.deriveMessageKey(SESSION_KEY, 3)), fulfilled_by_user_id: RELAY,
      key_scope: 'message', message_id: 'm-pinned',
    }))
    await service.handleFulfilledRequest(fulfilled({
      id: '78787878-1111-2222-3333-444444444444',
      encrypted_key: await wrapAs(RELAY, ME, SESSION_KEY), fulfilled_by_user_id: RELAY,
    }))
    const [messageKey, sessionKey] = megolmKeyBackupService.relayedKeysFor(ROOM, SENDER, SESSION)

    await megolmKeyBackupService.settleRelayedKey(messageKey, true)

    const cancel = updatesOf('megolm_key_requests').find(u => u.payload.status === 'cancelled')!
    expect(eqFilter(cancel, 'message_id')).toBe('m-pinned')
    expect(megolmKeyBackupService.relayedKeysFor(ROOM, SENDER, SESSION)).toEqual([sessionKey])
  })

  it('a relayed key does not unwrap under the sender identity', async () => {
    const request = fulfilled({ encrypted_key: await wrapAs(RELAY, ME, SESSION_KEY), fulfilled_by_user_id: null })
    expect(await service.handleFulfilledRequest(request)).toBe('failed')
  })

  it('a relayed key for a session already held is consumed', async () => {
    await megolm.importInboundSession(ROOM, SENDER, SESSION, SESSION_KEY, 0)
    const request = fulfilled({ encrypted_key: 'v2:unused', fulfilled_by_user_id: RELAY })

    expect(await service.handleFulfilledRequest(request)).toBe('imported')
    expect(updatesOf('megolm_key_requests')[0].payload).toEqual({ status: 'received' })
  })

  it('an accepted relayed key consumes its request and cancels the other pending ones', async () => {
    await service.handleFulfilledRequest(
      fulfilled({ encrypted_key: await wrapAs(RELAY, ME, SESSION_KEY), fulfilled_by_user_id: RELAY }),
    )
    const [key] = megolmKeyBackupService.relayedKeysFor(ROOM, SENDER, SESSION)

    await megolmKeyBackupService.settleRelayedKey(key, true)

    const updates = updatesOf('megolm_key_requests')
    expect(updates.map(u => u.payload.status)).toEqual(['received', 'cancelled'])
    expect(eqFilter(updates[0], 'id')).toBe(key.requestId)
    expect(eqFilter(updates[1], 'session_id')).toBe(SESSION)
    expect(eqFilter(updates[1], 'status')).toBe('pending')
    expect(eqFilter(updates[1], 'requester_user_id')).toBe(ME)
    expect(megolmKeyBackupService.relayedKeysFor(ROOM, SENDER, SESSION)).toEqual([])
  })

  it('a refused relayed key expires its request and leaves the others held', async () => {
    await service.handleFulfilledRequest(
      fulfilled({ encrypted_key: await wrapAs(RELAY, ME, SESSION_KEY), fulfilled_by_user_id: RELAY }),
    )
    await service.handleFulfilledRequest(
      fulfilled({ id: '34343434-1111-2222-3333-444444444444', encrypted_key: await wrapAs(RELAY, ME, SESSION_KEY), fulfilled_by_user_id: RELAY }),
    )
    const [first, second] = megolmKeyBackupService.relayedKeysFor(ROOM, SENDER, SESSION)

    await megolmKeyBackupService.settleRelayedKey(first, false)

    const [update] = updatesOf('megolm_key_requests')
    expect(update.payload).toEqual({ status: 'expired' })
    expect(eqFilter(update, 'id')).toBe(first.requestId)
    expect(megolmKeyBackupService.relayedKeysFor(ROOM, SENDER, SESSION)).toEqual([second])
  })

  it('after a refused relayed key the next miss asks again at once; after a second, it waits', async () => {
    service.pendingRequests.clear()
    service.refusals.clear()
    const inserts = () => calls.filter(c => c.table === 'megolm_key_requests' && c.op === 'insert')
    await service.handleFulfilledRequest(
      fulfilled({ encrypted_key: await wrapAs(RELAY, ME, SESSION_KEY), fulfilled_by_user_id: RELAY }),
    )
    let [held] = megolmKeyBackupService.relayedKeysFor(ROOM, SENDER, SESSION)
    await megolmKeyBackupService.settleRelayedKey(held, false)
    await megolmKeyBackupService.createKeyRequest(ROOM, SESSION, SENDER)
    expect(inserts()).toHaveLength(1)

    await service.handleFulfilledRequest(fulfilled({
      id: '56565656-1111-2222-3333-444444444444', encrypted_key: await wrapAs(RELAY, ME, SESSION_KEY), fulfilled_by_user_id: RELAY,
    }))
    ;[held] = megolmKeyBackupService.relayedKeysFor(ROOM, SENDER, SESSION)
    await megolmKeyBackupService.settleRelayedKey(held, false)
    await megolmKeyBackupService.createKeyRequest(ROOM, SESSION, SENDER)
    expect(inserts()).toHaveLength(1)
  })

  it('a second refused session key answering a pinned message holds off that message\'s request too', async () => {
    service.pendingRequests.clear()
    service.refusals.set(SESSION, { count: 1, at: Date.now() })
    await service.handleFulfilledRequest(fulfilled({
      encrypted_key: await wrapAs(RELAY, ME, SESSION_KEY), fulfilled_by_user_id: RELAY, message_id: 'm-pinned-9',
    }))
    const [held] = megolmKeyBackupService.relayedKeysFor(ROOM, SENDER, SESSION)
    await megolmKeyBackupService.settleRelayedKey(held, false)

    await megolmKeyBackupService.createKeyRequest(ROOM, SESSION, SENDER, { id: 'm-pinned-9', pinned: true })
    expect(calls.filter(c => c.table === 'megolm_key_requests' && c.op === 'insert')).toHaveLength(0)
  })

  it('the unlock sweep fetches every wrapper key at once and leaves relayed rows fulfilled', async () => {
    const OTHER_SESSION = 'b3RoZXItc2Vzc2lvbg=='
    fulfilledRows = [
      fulfilled({ id: '56565656-1111-2222-3333-444444444444', session_id: OTHER_SESSION, encrypted_key: await wrapAs(SENDER, ME, SESSION_KEY), fulfilled_by_user_id: null }),
      fulfilled({ encrypted_key: await wrapAs(RELAY, ME, SESSION_KEY), fulfilled_by_user_id: RELAY }),
    ]

    expect(await megolmKeyBackupService.processMyFulfilledRequests()).toBe(2)

    const keyLookups = calls.filter(c => c.table === 'user_key_pairs')
    expect(keyLookups).toHaveLength(1)
    expect([...(keyLookups[0].filters.find(([op]) => op === 'in')![2] as string[])].sort()).toEqual([RELAY, SENDER].sort())
    const [flip] = updatesOf('megolm_key_requests')
    expect(flip.payload).toEqual({ status: 'received' })
    expect(flip.filters.find(([op]) => op === 'in')![2]).toEqual(['56565656-1111-2222-3333-444444444444'])
    expect(megolm.hasInboundSession(ROOM, SENDER, OTHER_SESSION)).toBe(true)
    expect(megolmKeyBackupService.relayedKeysFor(ROOM, SENDER, SESSION)).toHaveLength(1)
  })
})
