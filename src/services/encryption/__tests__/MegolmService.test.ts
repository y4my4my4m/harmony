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
      const userBId = 'bbbb-user-b-id'
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
})
