import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { indexedDB } from 'fake-indexeddb'
import { MegolmService } from '../MegolmService'
import { RecoveryKeyService } from '../RecoveryKeyService'

const TEST_MNEMONIC = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent',
  'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'
]

const TEST_USER_ID = 'aaaaaaaa-1111-2222-3333-444444444444'
const TEST_ROOM_ID = 'bbbbbbbb-1111-2222-3333-444444444444'

async function deriveEncryptionKey(): Promise<CryptoKey> {
  const recovery = RecoveryKeyService.getInstance()
  recovery.clear()
  const keys = await recovery.deriveKeysFromMnemonic(TEST_MNEMONIC)
  return keys.encryptionKey
}

function clearAllDatabases(): Promise<void> {
  return new Promise((resolve) => {
    const dbName = `harmony_megolm_sessions_${TEST_USER_ID}`
    const req = indexedDB.deleteDatabase(dbName)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

describe('MegolmService', () => {
  let service: MegolmService
  let encryptionKey: CryptoKey

  beforeEach(async () => {
    encryptionKey = await deriveEncryptionKey()
    service = MegolmService.getInstance()
    service.close()
    await clearAllDatabases()
    await service.initialize(TEST_USER_ID, encryptionKey)
  })

  afterEach(() => {
    service.close()
  })

  // ─── Session creation ─────────────────────────────────────

  describe('session creation', () => {
    it('creates an outbound session for a room', async () => {
      const session = await service.getOrCreateOutboundSession(TEST_ROOM_ID)
      expect(session.roomId).toBe(TEST_ROOM_ID)
      expect(session.sessionId).toBeTruthy()
      expect(session.sessionKey).toBeTruthy()
      expect(session.messageIndex).toBe(0)
    })

    it('reuses existing session on second call', async () => {
      const s1 = await service.getOrCreateOutboundSession(TEST_ROOM_ID)
      const s2 = await service.getOrCreateOutboundSession(TEST_ROOM_ID)
      expect(s1.sessionId).toBe(s2.sessionId)
    })

    it('creates separate sessions for different rooms', async () => {
      const s1 = await service.getOrCreateOutboundSession(TEST_ROOM_ID)
      const s2 = await service.getOrCreateOutboundSession('cccccccc-1111-2222-3333-444444444444')
      expect(s1.sessionId).not.toBe(s2.sessionId)
    })

    it('also stores an inbound copy of outbound session', async () => {
      const outbound = await service.getOrCreateOutboundSession(TEST_ROOM_ID)
      const inbound = service.getInboundSession(TEST_ROOM_ID, TEST_USER_ID, outbound.sessionId)
      expect(inbound).toBeDefined()
      expect(inbound!.sessionKey).toBe(outbound.sessionKey)
    })
  })

  // ─── Encrypt / decrypt round-trip (real AES-GCM + HKDF) ──

  describe('encrypt / decrypt', () => {
    it('round-trips a simple string', async () => {
      const plaintext = 'Hello, Megolm!'
      const encrypted = await service.encryptMessage(TEST_ROOM_ID, plaintext)

      expect(encrypted.sessionId).toBeTruthy()
      expect(encrypted.ciphertext).toBeTruthy()
      expect(encrypted.messageIndex).toBe(0)

      const decrypted = await service.decryptMessage(TEST_ROOM_ID, TEST_USER_ID, encrypted)
      expect(decrypted).toBe(plaintext)
    })

    it('round-trips JSON content (message parts)', async () => {
      const content = JSON.stringify([{ type: 'text', text: 'Hello world' }])
      const encrypted = await service.encryptMessage(TEST_ROOM_ID, content)
      const decrypted = await service.decryptMessage(TEST_ROOM_ID, TEST_USER_ID, encrypted)
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(content))
    })

    it('round-trips unicode and emoji content', async () => {
      const content = '日本語テスト 🎉🔐 مرحبا'
      const encrypted = await service.encryptMessage(TEST_ROOM_ID, content)
      const decrypted = await service.decryptMessage(TEST_ROOM_ID, TEST_USER_ID, encrypted)
      expect(decrypted).toBe(content)
    })

    it('produces different ciphertext for same plaintext (different message index)', async () => {
      const plaintext = 'same message'
      const e1 = await service.encryptMessage(TEST_ROOM_ID, plaintext)
      const e2 = await service.encryptMessage(TEST_ROOM_ID, plaintext)
      expect(e1.ciphertext).not.toBe(e2.ciphertext)
      expect(e1.messageIndex).toBe(0)
      expect(e2.messageIndex).toBe(1)
    })

    it('v3 encrypt pins the outbound session resolved before AAD is built', async () => {
      const outbound = await service.getOrCreateOutboundSession(TEST_ROOM_ID, 2)
      const epoch = outbound.epoch ?? 2
      const aad = new TextEncoder().encode(JSON.stringify({ epoch_id: epoch, room_id: TEST_ROOM_ID }))

      const encrypted = await service.encryptMessage(TEST_ROOM_ID, 'v3 pinned', {
        epoch,
        additionalData: aad,
      })

      expect(encrypted.sessionId).toBe(outbound.sessionId)
      expect(encrypted.epoch).toBe(epoch)
      expect(encrypted.messageIndex).toBe(0)
    })

    it('v3 encrypt rejects AAD epoch that does not match the outbound session', async () => {
      const outbound = await service.getOrCreateOutboundSession(TEST_ROOM_ID, 2)
      const aad = new TextEncoder().encode(JSON.stringify({ epoch_id: 99 }))

      await expect(
        service.encryptMessage(TEST_ROOM_ID, 'bad epoch', {
          epoch: 99,
          additionalData: aad,
        }),
      ).rejects.toThrow(/epoch/)
      expect(outbound.sessionId).toBeTruthy()
    })

    it('concurrent encrypts in the same room get distinct message indexes', async () => {
      const results = await Promise.all([
        service.encryptMessage(TEST_ROOM_ID, 'concurrent-a'),
        service.encryptMessage(TEST_ROOM_ID, 'concurrent-b'),
        service.encryptMessage(TEST_ROOM_ID, 'concurrent-c'),
      ])

      const indexes = results.map(r => r.messageIndex).sort((a, b) => a - b)
      expect(indexes).toEqual([0, 1, 2])
      expect(new Set(results.map(r => r.sessionId)).size).toBe(1)
    })

    it('decrypts messages at different indices correctly', async () => {
      const messages = ['first', 'second', 'third']
      const encrypted = []
      for (const msg of messages) {
        encrypted.push(await service.encryptMessage(TEST_ROOM_ID, msg))
      }

      for (let i = 0; i < messages.length; i++) {
        const decrypted = await service.decryptMessage(TEST_ROOM_ID, TEST_USER_ID, encrypted[i])
        expect(decrypted).toBe(messages[i])
      }
    })
  })

  // ─── Message index ratcheting ─────────────────────────────

  describe('message index ratcheting', () => {
    it('increments message index after each encryption', async () => {
      await service.encryptMessage(TEST_ROOM_ID, 'msg1')
      const session = await service.getOrCreateOutboundSession(TEST_ROOM_ID)
      expect(session.messageIndex).toBe(1)

      await service.encryptMessage(TEST_ROOM_ID, 'msg2')
      const session2 = await service.getOrCreateOutboundSession(TEST_ROOM_ID)
      expect(session2.messageIndex).toBe(2)
    })
  })

  // ─── Inbound session management ───────────────────────────

  describe('inbound sessions', () => {
    const OTHER_USER = 'dddddddd-1111-2222-3333-444444444444'

    it('imports and retrieves an inbound session', async () => {
      await service.importInboundSession(TEST_ROOM_ID, OTHER_USER, 'sess-123', 'fakekey', 0)
      const session = service.getInboundSession(TEST_ROOM_ID, OTHER_USER, 'sess-123')
      expect(session).toBeDefined()
      expect(session!.senderUserId).toBe(OTHER_USER)
    })

    it('hasInboundSession returns correct status', async () => {
      expect(service.hasInboundSession(TEST_ROOM_ID, OTHER_USER, 'sess-123')).toBe(false)
      await service.importInboundSession(TEST_ROOM_ID, OTHER_USER, 'sess-123', 'fakekey', 0)
      expect(service.hasInboundSession(TEST_ROOM_ID, OTHER_USER, 'sess-123')).toBe(true)
    })

    it('findInboundSessionBySessionId searches across senders', async () => {
      await service.importInboundSession(TEST_ROOM_ID, OTHER_USER, 'sess-xyz', 'key1', 0)
      const found = service.findInboundSessionBySessionId(TEST_ROOM_ID, 'sess-xyz')
      expect(found).toBeDefined()
      expect(found!.senderUserId).toBe(OTHER_USER)
    })

    it('getInboundSessionsForRoom returns all room sessions', async () => {
      await service.importInboundSession(TEST_ROOM_ID, OTHER_USER, 'sess-1', 'key1', 0)
      await service.importInboundSession(TEST_ROOM_ID, 'eeeeeeee-0000-0000-0000-000000000000', 'sess-2', 'key2', 0)
      const sessions = service.getInboundSessionsForRoom(TEST_ROOM_ID)
      // At least 2 imported + 1 from outbound creation (if any outbound was created)
      expect(sessions.length).toBeGreaterThanOrEqual(2)
    })
  })

  // ─── Cross-user encrypt / decrypt ─────────────────────────

  describe('cross-user decryption', () => {
    it('user B can decrypt user A message with shared session key', async () => {
      const plaintext = 'secret from A'
      const encrypted = await service.encryptMessage(TEST_ROOM_ID, plaintext)

      // Get the session key data that would be shared
      const shareData = service.getSessionKeyForSharing(TEST_ROOM_ID)
      expect(shareData).not.toBeNull()

      // Simulate user B receiving the session key
      // eslint-disable-next-line unused-imports/no-unused-vars
      const userBId = 'bbbb-user-b-id'
      // eslint-disable-next-line unused-imports/no-unused-vars
      const serviceB = MegolmService.getInstance()
      // (serviceB is the same singleton, but the inbound session import simulates user B)
      await service.importInboundSession(
        TEST_ROOM_ID,
        TEST_USER_ID,
        shareData!.sessionId,
        shareData!.sessionKey,
        0
      )

      // "User B" decrypts using the imported inbound session
      const decrypted = await service.decryptMessage(TEST_ROOM_ID, TEST_USER_ID, encrypted)
      expect(decrypted).toBe(plaintext)
    })
  })

  // ─── Session sharing helpers ──────────────────────────────

  describe('session sharing', () => {
    it('getSessionKeyForSharing returns null for unknown room', () => {
      expect(service.getSessionKeyForSharing('unknown-room')).toBeNull()
    })

    it('getSessionKeyForSharing returns session data', async () => {
      await service.getOrCreateOutboundSession(TEST_ROOM_ID)
      const data = service.getSessionKeyForSharing(TEST_ROOM_ID)
      expect(data).not.toBeNull()
      expect(data!.sessionId).toBeTruthy()
      expect(data!.sessionKey).toBeTruthy()
    })

    // Regression: key-request fulfillment (MegolmKeyBackupService.handleIncoming-
    // KeyRequest) resolves the key it hands back via getSessionKeyForSharing(
    // roomId, sessionId). The SENDER of a message holds that session in its
    // OUTBOUND map, so an explicit-sessionId lookup against the current outbound
    // session must succeed - otherwise the sender can never answer a request for
    // a message it sent, and the request sits 'pending' forever.
    it('getSessionKeyForSharing resolves the current outbound session by explicit sessionId', async () => {
      const outbound = await service.getOrCreateOutboundSession(TEST_ROOM_ID)

      const data = service.getSessionKeyForSharing(TEST_ROOM_ID, outbound.sessionId)

      expect(data).not.toBeNull()
      expect(data!.sessionId).toBe(outbound.sessionId)
      expect(data!.sessionKey).toBe(outbound.sessionKey)
    })

    it('getSessionKeyForSharing returns null for a session id we do not hold', async () => {
      await service.getOrCreateOutboundSession(TEST_ROOM_ID)

      // A foreign session id must not resolve to our outbound key - fulfillment
      // would otherwise hand the wrong key to a requester.
      expect(service.getSessionKeyForSharing(TEST_ROOM_ID, 'some-other-session-id')).toBeNull()
    })

    it('tracks shared-with users', async () => {
      await service.getOrCreateOutboundSession(TEST_ROOM_ID)
      const otherUser = 'other-user-id'

      let needed = service.getUsersNeedingSession(TEST_ROOM_ID, [otherUser, TEST_USER_ID])
      expect(needed).toContain(otherUser)
      expect(needed).not.toContain(TEST_USER_ID)

      await service.markSessionSharedWith(TEST_ROOM_ID, otherUser)
      needed = service.getUsersNeedingSession(TEST_ROOM_ID, [otherUser, TEST_USER_ID])
      expect(needed).not.toContain(otherUser)
    })
  })

  // ─── Export / import ──────────────────────────────────────

  describe('export / import', () => {
    it('exports all sessions', async () => {
      await service.encryptMessage(TEST_ROOM_ID, 'test')
      const exported = await service.exportAllSessions()
      expect(exported.outbound.length).toBeGreaterThanOrEqual(1)
      expect(exported.inbound.length).toBeGreaterThanOrEqual(1)
    })

    it('restores sessions after close + import', async () => {
      const plaintext = 'message to restore'
      const encrypted = await service.encryptMessage(TEST_ROOM_ID, plaintext)
      const exported = await service.exportAllSessions()

      // Close and reinitialize
      service.close()
      await service.initialize(TEST_USER_ID, encryptionKey)

      // Import backed-up sessions
      await service.importAllSessions(exported)

      // Decrypt should work
      const decrypted = await service.decryptMessage(TEST_ROOM_ID, TEST_USER_ID, encrypted)
      expect(decrypted).toBe(plaintext)
    })
  })

  // ─── Keys of single messages ─────────────────────────────

  describe('single message keys', () => {
    const SENDER = 'cccccccc-1111-2222-3333-444444444444'

    async function sessionOfThree() {
      const messages = [
        await service.encryptMessage(TEST_ROOM_ID, 'zero'),
        await service.encryptMessage(TEST_ROOM_ID, 'one'),
        await service.encryptMessage(TEST_ROOM_ID, 'two'),
      ]
      const { sessionKey } = service.getSessionKeyForSharing(TEST_ROOM_ID, messages[0].sessionId)!
      return { messages, sessionKey }
    }

    it("derives the key that decrypts one message and no other", async () => {
      const { messages, sessionKey } = await sessionOfThree()
      const key = await service.deriveMessageKey(sessionKey, messages[1].messageIndex)
      expect(await service.decryptWithMessageKey(key, messages[1])).toBe('one')
      await expect(service.decryptWithMessageKey(key, messages[0])).rejects.toThrow()
      await expect(service.decryptWithMessageKey(key, messages[2])).rejects.toThrow()
      expect(key).not.toBe(sessionKey)
    })

    it('decrypts a message whose key alone is held, and misses its neighbours', async () => {
      const { messages, sessionKey } = await sessionOfThree()
      const sessionId = messages[0].sessionId
      await service.importMessageKey(TEST_ROOM_ID, SENDER, sessionId, 1, await service.deriveMessageKey(sessionKey, 1))

      expect(service.hasInboundSession(TEST_ROOM_ID, SENDER, sessionId)).toBe(false)
      expect(await service.decryptMessage(TEST_ROOM_ID, SENDER, messages[1])).toBe('one')
      await expect(service.decryptMessage(TEST_ROOM_ID, SENDER, messages[2])).rejects.toThrow(/No inbound session/)
    })

    it('keeps message keys across a restart, encrypted at rest', async () => {
      const { messages, sessionKey } = await sessionOfThree()
      const sessionId = messages[0].sessionId
      const key = await service.deriveMessageKey(sessionKey, 2)
      // A newcomer's store: no copy of the session.
      service.close()
      await clearAllDatabases()
      await service.initialize(TEST_USER_ID, encryptionKey)
      await service.importMessageKey(TEST_ROOM_ID, SENDER, sessionId, 2, key)

      const stored = await new Promise<any>((resolve, reject) => {
        const open = indexedDB.open(`harmony_megolm_sessions_${TEST_USER_ID}`)
        open.onsuccess = () => {
          const get = open.result.transaction('inbound_sessions', 'readonly').objectStore('inbound_sessions').get(sessionId)
          get.onsuccess = () => { resolve(get.result); open.result.close() }
          get.onerror = () => reject(get.error)
        }
        open.onerror = () => reject(open.error)
      })
      expect(JSON.stringify(stored)).not.toContain(key)

      service.close()
      await service.initialize(TEST_USER_ID, encryptionKey)
      expect(await service.decryptMessage(TEST_ROOM_ID, SENDER, messages[2])).toBe('two')
    })

    it('a session key supersedes message keys; a message key never replaces a session key', async () => {
      const { messages, sessionKey } = await sessionOfThree()
      const sessionId = messages[0].sessionId
      await service.importMessageKey(TEST_ROOM_ID, SENDER, sessionId, 1, await service.deriveMessageKey(sessionKey, 1))
      await service.importInboundSession(TEST_ROOM_ID, SENDER, sessionId, sessionKey, 0)
      await service.importMessageKey(TEST_ROOM_ID, SENDER, sessionId, 2, 'aWdub3JlZA==')

      expect(service.hasInboundSession(TEST_ROOM_ID, SENDER, sessionId)).toBe(true)
      expect(service.getMessageKey(TEST_ROOM_ID, SENDER, sessionId, 2)).toBeUndefined()
      expect(await service.decryptMessage(TEST_ROOM_ID, SENDER, messages[0])).toBe('zero')
    })

    it('a backup merges message keys and upgrades them to a session key', async () => {
      const { messages, sessionKey } = await sessionOfThree()
      const sessionId = messages[0].sessionId
      const base = { sessionId, roomId: TEST_ROOM_ID, senderUserId: SENDER, firstKnownIndex: 0, createdAt: 1 }
      await service.importMessageKey(TEST_ROOM_ID, SENDER, sessionId, 1, await service.deriveMessageKey(sessionKey, 1))

      await service.importAllSessions({
        outbound: [],
        inbound: [{ ...base, sessionKey: '', messageKeys: { 2: await service.deriveMessageKey(sessionKey, 2) } }],
      })
      expect(await service.decryptMessage(TEST_ROOM_ID, SENDER, messages[1])).toBe('one')
      expect(await service.decryptMessage(TEST_ROOM_ID, SENDER, messages[2])).toBe('two')

      await service.importAllSessions({ outbound: [], inbound: [{ ...base, sessionKey }] })
      expect(service.hasInboundSession(TEST_ROOM_ID, SENDER, sessionId)).toBe(true)
      expect(await service.decryptMessage(TEST_ROOM_ID, SENDER, messages[0])).toBe('zero')
    })

    it('does not share an inbound entry that holds message keys only', async () => {
      const { messages, sessionKey } = await sessionOfThree()
      await service.importMessageKey(TEST_ROOM_ID, TEST_USER_ID, 'c29sbw==', 0, await service.deriveMessageKey(sessionKey, 0))
      expect(service.getSessionKeyForSharing(TEST_ROOM_ID, 'c29sbw==')).toBeNull()
      expect(service.getSessionKeyForSharing(TEST_ROOM_ID, messages[0].sessionId)?.sessionKey).toBe(sessionKey)
    })
  })

  describe('retiring the outbound session', () => {
    it('opens a new session on the next encrypt', async () => {
      const first = await service.encryptMessage(TEST_ROOM_ID, 'before')
      await service.retireOutboundSession(TEST_ROOM_ID, first.sessionId)
      const second = await service.encryptMessage(TEST_ROOM_ID, 'after')
      expect(second.sessionId).not.toBe(first.sessionId)
      expect(await service.decryptMessage(TEST_ROOM_ID, TEST_USER_ID, first)).toBe('before')
    })

    it('leaves a newer session alone', async () => {
      const first = await service.encryptMessage(TEST_ROOM_ID, 'a')
      await service.retireOutboundSession(TEST_ROOM_ID, 'bm90LWN1cnJlbnQ=')
      const second = await service.encryptMessage(TEST_ROOM_ID, 'b')
      expect(second.sessionId).toBe(first.sessionId)
    })
  })
})
