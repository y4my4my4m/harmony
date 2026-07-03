import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { indexedDB } from 'fake-indexeddb'

import { MegolmService } from '../MegolmService'
import { RecoveryKeyService } from '../RecoveryKeyService'
import { MegolmMessageEncryptionService } from '../MegolmMessageEncryptionService'
import { deviceIdentityService } from '../DeviceIdentityService'
import { deviceKeyStore, signingKeyStore } from '../SecureSessionKeyStore'
import {
  generateSigningKeyPair,
  exportPublicSigningKey,
  exportPrivateSigningKey,
  importPrivateSigningKey,
} from '../MessageSigner'
import { supabase } from '@/supabase'
import type { MessagePart } from '@/types'

const TEST_MNEMONIC = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent',
  'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'
]
const TEST_USER_ID = 'aaaaaaaa-1111-2222-3333-444444444444'
const TEST_ROOM_ID = 'bbbbbbbb-1111-2222-3333-444444444444'

// Builds a supabase.from mock whose `user_key_pairs` lookups resolve signing
// public keys from the given map. The lookup chain is
// `.select('identity_signing_public_key').eq('user_id', id).eq('is_active', true).maybeSingle()`.
function userKeyPairsFromMock(lookup: Map<string, string>) {
  return (table: string) => {
    if (table !== 'user_key_pairs') {
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
        }),
      }
    }
    const filters: Record<string, any> = {}
    const builder: any = {
      select: () => builder,
      eq: (field: string, value: any) => {
        filters[field] = value
        return builder
      },
      maybeSingle: () => {
        const userId = filters['user_id']
        if (userId && lookup.has(userId)) {
          return Promise.resolve({
            data: { identity_signing_public_key: lookup.get(userId) },
            error: null,
          })
        }
        return Promise.resolve({ data: null, error: null })
      },
    }
    return builder
  }
}

describe('MegolmMessageEncryptionService', () => {
  let megolm: MegolmService
  let recovery: RecoveryKeyService
  let messageService: MegolmMessageEncryptionService
  // Default signing-key harness shared by all blocks. v1 send was removed, so
  // every encrypt now needs a usable signing key; this provides one for
  // TEST_USER_ID and answers the verification lookup on decrypt.
  let topPublicLookup: Map<string, string>

  beforeEach(async () => {
    recovery = RecoveryKeyService.getInstance()
    recovery.clear()
    megolm = MegolmService.getInstance()
    megolm.close()

    // Clear IndexedDB between tests to avoid leaking state
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(`harmony_megolm_sessions_${TEST_USER_ID}`)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
    })

    // v2 harness: keep device enrollment out of the default path so these
    // tests exercise user-level signing keys (megolm_v2_signed).
    vi.spyOn(deviceIdentityService, 'ensureRegistered').mockResolvedValue(null)

    messageService = MegolmMessageEncryptionService.getInstance()

    const keys = await recovery.deriveKeysFromMnemonic(TEST_MNEMONIC)
    await megolm.initialize(TEST_USER_ID, keys.encryptionKey)

    // Set currentUserId via reflection since constructor is private
    ;(messageService as any).currentUserId = TEST_USER_ID
    ;(messageService as any).initialized = true

    // Default signing-key harness: mint a key for TEST_USER_ID, publish its
    // public part to the mocked DB, and cache the private in IndexedDB so
    // encrypt emits megolm_v2_signed and decrypt can verify.
    topPublicLookup = new Map()
    ;(messageService as any).signingKeyCache?.clear?.()
    ;(supabase.from as any).mockImplementation(userKeyPairsFromMock(topPublicLookup))
    ;(supabase.rpc as any).mockResolvedValue({ data: [], error: null })

    const topKp = await generateSigningKeyPair()
    topPublicLookup.set(TEST_USER_ID, await exportPublicSigningKey(topKp.publicKey))
    const topPkcs8 = await exportPrivateSigningKey(topKp.privateKey)
    await signingKeyStore.store(TEST_USER_ID, await importPrivateSigningKey(topPkcs8, false))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    deviceKeyStore.close()
    megolm.close()
    recovery.clear()
    ;(messageService as any).currentUserId = null
    ;(messageService as any).initialized = false
    await signingKeyStore.clear(TEST_USER_ID).catch(() => {})
  })

  // ─── Full message encrypt → decrypt round-trip ────────────

  describe('encryptMessage / decryptMessage round-trip', () => {
    // The shared harness sets up a signing key, so encrypt always emits the
    // current `megolm_v2_signed` format (v1 send was removed) and decrypt
    // reports `senderVerified: true`. Legacy v1 is exercised on the decrypt
    // side only, in a dedicated test below.
    it('encrypts and decrypts a text message', async () => {
      const content: MessagePart[] = [{ type: 'text', text: 'Hello encrypted world!' }]

      const encrypted = await messageService.encryptMessage(content, TEST_ROOM_ID, [])
      expect(encrypted.encrypted).toBe(true)
      expect(encrypted.encryption_metadata.algorithm).toBe('megolm_v2_signed')
      expect(encrypted.encryption_metadata.sender_user_id).toBe(TEST_USER_ID)
      expect(encrypted.encryption_metadata.session_id).toBeTruthy()

      const decrypted = await messageService.decryptMessage({
        content: encrypted.content,
        channel_id: TEST_ROOM_ID,
        encryption_metadata: encrypted.encryption_metadata,
      })

      expect(decrypted.content).toEqual(content)
      expect(decrypted.senderVerified).toBe(true)
    })

    it('refuses to send when no signing key can be obtained', async () => {
      // Drop the signing key and make enrollment impossible (no recovery key).
      await signingKeyStore.clear(TEST_USER_ID).catch(() => {})
      ;(messageService as any).signingKeyCache?.clear?.()
      recovery.clear()

      await expect(
        messageService.encryptMessage([{ type: 'text', text: 'no key' }], TEST_ROOM_ID, [])
      ).rejects.toThrow(/no signing key available/i)
    })

    it('encrypts and decrypts multi-part content', async () => {
      const content: MessagePart[] = [
        { type: 'text', text: 'Look at this: ' },
        { type: 'text', text: 'https://example.com' },
      ]

      const encrypted = await messageService.encryptMessage(content, TEST_ROOM_ID, [])
      const decrypted = await messageService.decryptMessage({
        content: encrypted.content,
        channel_id: TEST_ROOM_ID,
        encryption_metadata: encrypted.encryption_metadata,
      })

      expect(decrypted.content).toEqual(content)
    })

    it('handles conversation_id context (DMs)', async () => {
      const content: MessagePart[] = [{ type: 'text', text: 'DM content' }]
      const convId = 'conv-12345'

      const encrypted = await messageService.encryptMessage(content, convId, [])
      const decrypted = await messageService.decryptMessage({
        content: encrypted.content,
        conversation_id: convId,
        encryption_metadata: encrypted.encryption_metadata,
      })

      expect(decrypted.content).toEqual(content)
    })

    it('increments message index across messages', async () => {
      const content: MessagePart[] = [{ type: 'text', text: 'msg' }]

      const e1 = await messageService.encryptMessage(content, TEST_ROOM_ID, [])
      const e2 = await messageService.encryptMessage(content, TEST_ROOM_ID, [])

      expect(e1.encryption_metadata.message_index).toBe(0)
      expect(e2.encryption_metadata.message_index).toBe(1)
      expect(e1.encryption_metadata.session_id).toBe(e2.encryption_metadata.session_id)
    })

    it('can decrypt messages in any order', async () => {
      const messages: MessagePart[][] = [
        [{ type: 'text', text: 'first' }],
        [{ type: 'text', text: 'second' }],
        [{ type: 'text', text: 'third' }],
      ]

      const encrypted = []
      for (const content of messages) {
        encrypted.push(await messageService.encryptMessage(content, TEST_ROOM_ID, []))
      }

      // Decrypt in reverse order
      for (let i = messages.length - 1; i >= 0; i--) {
        const decrypted = await messageService.decryptMessage({
          content: encrypted[i].content,
          channel_id: TEST_ROOM_ID,
          encryption_metadata: encrypted[i].encryption_metadata,
        })
        expect(decrypted.content).toEqual(messages[i])
      }
    })
  })

  // ─── Error handling ───────────────────────────────────────

  describe('error handling', () => {
    it('throws on missing encryption metadata', async () => {
      await expect(
        messageService.decryptMessage({
          content: [{ type: 'text', text: 'test' }],
          channel_id: TEST_ROOM_ID,
        })
      ).rejects.toThrow('No encryption metadata')
    })

    it('throws on unsupported algorithm', async () => {
      await expect(
        messageService.decryptMessage({
          content: [{ type: 'text', text: 'test' }],
          channel_id: TEST_ROOM_ID,
          encryption_metadata: {
            algorithm: 'unknown_v99' as any,
            session_id: 'x',
            message_index: 0,
            sender_user_id: TEST_USER_ID,
          },
        })
      ).rejects.toThrow('Unsupported encryption algorithm')
    })

    it('throws on legacy signal protocol messages', async () => {
      await expect(
        messageService.decryptMessage({
          content: [{ type: 'text', text: 'test' }],
          channel_id: TEST_ROOM_ID,
          encryption_metadata: {
            algorithm: 'signal_protocol_v1_hybrid' as any,
            session_id: 'x',
            message_index: 0,
            sender_user_id: TEST_USER_ID,
          },
        })
      ).rejects.toThrow('Legacy encrypted message')
    })
  })

  // ─── Status checks ────────────────────────────────────────

  describe('status', () => {
    it('isUnlocked returns true when Megolm is initialized', () => {
      expect(messageService.isUnlocked()).toBe(true)
    })

    it('isUnlocked returns false after megolm close', () => {
      megolm.close()
      expect(messageService.isUnlocked()).toBe(false)
    })

    it('getCurrentUserId returns the user ID', () => {
      expect(messageService.getCurrentUserId()).toBe(TEST_USER_ID)
    })
  })

  // ─── Megolm v2 signed: sender binding round-trip and attacks ──

  describe('v2 sender binding (signed)', () => {
    let aliceSpki: string
    let publicLookup: Map<string, string>

    // Set up a working signing key for TEST_USER_ID and stub the public-key
    // lookup so verification can pull keys back during decrypt.
    beforeEach(async () => {
      publicLookup = new Map()

      // Clear the per-test cache and reset supabase.from to a builder that
      // can answer the signing-key lookup. The lookup chain is
      // `.select('identity_signing_public_key').eq('user_id', id).eq('is_active', true).maybeSingle()`,
      // so the builder collects every `.eq` filter and only matches on user_id.
      ;(messageService as any).signingKeyCache?.clear?.()
      ;(supabase.from as any).mockImplementation((table: string) => {
        if (table !== 'user_key_pairs') {
          return {
            select: () => ({
              eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
            }),
          }
        }

        const filters: Record<string, any> = {}
        const builder: any = {
          select: () => builder,
          eq: (field: string, value: any) => {
            filters[field] = value
            return builder
          },
          maybeSingle: () => {
            const userId = filters['user_id']
            if (userId && publicLookup.has(userId)) {
              return Promise.resolve({
                data: { identity_signing_public_key: publicLookup.get(userId) },
                error: null,
              })
            }
            return Promise.resolve({ data: null, error: null })
          },
        }
        return builder
      })
      // Make sure RPC and any other supabase calls don't blow up the test -
      // claimPendingSessionShares() should never run on the v2 fast path, but
      // we're defensive in case a future code change starts touching it.
      ;(supabase.rpc as any).mockResolvedValue({ data: [], error: null })

      // Mint a real signing keypair, push the public key into the "DB"
      // lookup, and cache the non-extractable private in the IndexedDB
      // store the service reads from.
      const kp = await generateSigningKeyPair()
      aliceSpki = await exportPublicSigningKey(kp.publicKey)
      publicLookup.set(TEST_USER_ID, aliceSpki)

      const pkcs8 = await exportPrivateSigningKey(kp.privateKey)
      const nonExtractable = await importPrivateSigningKey(pkcs8, false)
      await signingKeyStore.store(TEST_USER_ID, nonExtractable)
    })

    afterEach(async () => {
      await signingKeyStore.clear(TEST_USER_ID).catch(() => {})
    })

    it('emits megolm_v2_signed with a signature when a signing key is available', async () => {
      const content: MessagePart[] = [{ type: 'text', text: 'signed hi' }]
      const encrypted = await messageService.encryptMessage(content, TEST_ROOM_ID, [])

      expect(encrypted.encryption_metadata.algorithm).toBe('megolm_v2_signed')
      expect(typeof encrypted.encryption_metadata.signature).toBe('string')
      expect(encrypted.encryption_metadata.signature!.length).toBeGreaterThan(0)
    })

    it('verifies the signature on decrypt → senderVerified true', async () => {
      const content: MessagePart[] = [{ type: 'text', text: 'verified hi' }]
      const encrypted = await messageService.encryptMessage(content, TEST_ROOM_ID, [])

      const decrypted = await messageService.decryptMessage({
        content: encrypted.content,
        channel_id: TEST_ROOM_ID,
        encryption_metadata: encrypted.encryption_metadata,
      })

      expect(decrypted.content).toEqual(content)
      expect(decrypted.senderVerified).toBe(true)
    })

    it('rejects a reattribution attack (swap sender_user_id)', async () => {
      const content: MessagePart[] = [{ type: 'text', text: 'this is from alice' }]
      const encrypted = await messageService.encryptMessage(content, TEST_ROOM_ID, [])

      // The server pretends Alice's ciphertext was actually sent by Mallory.
      // We publish Mallory's (different) signing key so the verifier can
      // even attempt the check - it must still fail because the signature
      // was over `sender_user_id: alice`.
      const malloryId = '00000000-0000-0000-0000-cafecafecafe'
      const mallory = await generateSigningKeyPair()
      publicLookup.set(malloryId, await exportPublicSigningKey(mallory.publicKey))

      await expect(
        messageService.decryptMessage({
          content: encrypted.content,
          channel_id: TEST_ROOM_ID,
          encryption_metadata: {
            ...encrypted.encryption_metadata,
            sender_user_id: malloryId,
          },
        })
      ).rejects.toThrow(/Sender signature invalid/)
    })

    it('rejects when the signature is tampered', async () => {
      const content: MessagePart[] = [{ type: 'text', text: 'integrity check' }]
      const encrypted = await messageService.encryptMessage(content, TEST_ROOM_ID, [])

      // Flip a byte in the base64 signature.
      const sig = encrypted.encryption_metadata.signature!
      const tampered = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)

      await expect(
        messageService.decryptMessage({
          content: encrypted.content,
          channel_id: TEST_ROOM_ID,
          encryption_metadata: {
            ...encrypted.encryption_metadata,
            signature: tampered,
          },
        })
      ).rejects.toThrow(/Sender signature invalid/)
    })

    it('rejects v2 messages with a stripped signature', async () => {
      const content: MessagePart[] = [{ type: 'text', text: 'sig was here' }]
      const encrypted = await messageService.encryptMessage(content, TEST_ROOM_ID, [])

      await expect(
        messageService.decryptMessage({
          content: encrypted.content,
          channel_id: TEST_ROOM_ID,
          encryption_metadata: {
            ...encrypted.encryption_metadata,
            signature: undefined,
          },
        })
      ).rejects.toThrow(/Sender signature invalid/)
    })

    it('rejects v2 messages when the sender has no signing key on file', async () => {
      const content: MessagePart[] = [{ type: 'text', text: 'who?' }]
      const encrypted = await messageService.encryptMessage(content, TEST_ROOM_ID, [])
      publicLookup.clear() // sender's signing public key disappears

      // Also clear the in-memory cache to force a DB lookup.
      ;(messageService as any).signingKeyCache?.clear?.()

      await expect(
        messageService.decryptMessage({
          content: encrypted.content,
          channel_id: TEST_ROOM_ID,
          encryption_metadata: encrypted.encryption_metadata,
        })
      ).rejects.toThrow(/Sender signature invalid/)
    })

    it('refuses to decrypt legacy unsigned megolm_v1 messages', async () => {
      // v1 had no per-message sender binding, so it can be forged/reattributed.
      // Support was dropped: decryptMessage must reject rather than render
      // unverifiable content.
      const raw = JSON.stringify([{ type: 'text', text: 'legacy hi' }])
      const legacy = await megolm.encryptMessage(TEST_ROOM_ID, raw)

      await expect(
        messageService.decryptMessage({
          content: [{ type: 'text', text: legacy.ciphertext }],
          channel_id: TEST_ROOM_ID,
          encryption_metadata: {
            algorithm: 'megolm_v1',
            session_id: legacy.sessionId,
            message_index: legacy.messageIndex,
            sender_user_id: TEST_USER_ID,
          },
        })
      ).rejects.toThrow(/megolm_v1|Unsupported legacy/)
    })
  })

  describe('v3 device signing (megolm_v3)', () => {
    const TEST_DEVICE_ID = 'dddddddd-1111-2222-3333-444444444444'
    let devicePublicSpki: string

    beforeEach(async () => {
      vi.restoreAllMocks()
      deviceKeyStore.close()

      const kp = await generateSigningKeyPair()
      devicePublicSpki = await exportPublicSigningKey(kp.publicKey)
      const pkcs8 = await exportPrivateSigningKey(kp.privateKey)
      const privateKey = await importPrivateSigningKey(pkcs8, false)
      await deviceKeyStore.storeSigningKey(TEST_DEVICE_ID, privateKey, devicePublicSpki)

      vi.spyOn(deviceIdentityService, 'getDeviceId').mockReturnValue(TEST_DEVICE_ID)
      vi.spyOn(deviceIdentityService, 'getMyDeviceSigningKey').mockResolvedValue(privateKey)
      vi.spyOn(deviceIdentityService, 'ensureRegistered').mockImplementation(async () => ({
        id: 'device-row',
        user_id: TEST_USER_ID,
        device_id: TEST_DEVICE_ID,
        device_ecdh_public_key: null,
        device_signing_public_key: devicePublicSpki,
        trust_state: 'account',
        platform: 'web',
        label: 'test',
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        revoked_at: null,
      }))

      ;(supabase.rpc as any).mockImplementation(async (fn: string, args: any) => {
        if (fn === 'get_device_signing_key' && args?.p_user_id === TEST_USER_ID) {
          return {
            data: [{ device_signing_public_key: devicePublicSpki, revoked_at: null }],
            error: null,
          }
        }
        if (fn === 'get_room_epoch') {
          return { data: 1, error: null }
        }
        return { data: [], error: null }
      })
    })

    it('encrypts and decrypts with device-bound v3 signatures', async () => {
      const content: MessagePart[] = [{ type: 'text', text: 'v3 hello' }]
      const encrypted = await messageService.encryptMessage(content, TEST_ROOM_ID, [])

      expect(encrypted.encryption_metadata.algorithm).toBe('megolm_v3')
      expect(encrypted.encryption_metadata.sender_device_id).toBe(TEST_DEVICE_ID)

      const decrypted = await messageService.decryptMessage({
        content: encrypted.content,
        channel_id: TEST_ROOM_ID,
        encryption_metadata: encrypted.encryption_metadata,
      })

      expect(decrypted.content).toEqual(content)
      expect(decrypted.senderVerified).toBe(true)
    })
  })

  // ─── Session share repair (key-request fulfillment side effect) ──

  describe('repairSessionShareForUser', () => {
    const RECIPIENT_ID = 'cccccccc-1111-2222-3333-444444444444'
    const SESSION_ID = 'dddddddd-1111-2222-3333-444444444444'
    const SESSION_KEY = 'dGVzdC1zZXNzaW9uLWtleQ=='

    let recipientPublicB64: string | null
    let upsertedRows: any[]
    let upsertOptions: any

    beforeEach(async () => {
      upsertedRows = []
      upsertOptions = null
      recipientPublicB64 = null

      // Our own ECDH identity keypair - repair seals the session key with
      // ECDH(our private, recipient public), loaded from identityKeyStore.
      const myKp = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits'],
      ) as CryptoKeyPair
      const { identityKeyStore } = await import('../SecureSessionKeyStore')
      await identityKeyStore.store(TEST_USER_ID, myKp.privateKey)

      // Recipient's CURRENT identity public key, as the DB would return it.
      const recipientKp = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits'],
      ) as CryptoKeyPair
      const raw = await crypto.subtle.exportKey('raw', recipientKp.publicKey)
      recipientPublicB64 = btoa(String.fromCharCode(...new Uint8Array(raw)))

      ;(supabase.from as any).mockImplementation((table: string) => {
        if (table === 'user_key_pairs') {
          const filters: Record<string, any> = {}
          const builder: any = {
            select: () => builder,
            eq: (field: string, value: any) => { filters[field] = value; return builder },
            maybeSingle: () => Promise.resolve(
              filters['user_id'] === RECIPIENT_ID && recipientPublicB64
                ? { data: { identity_public_key: recipientPublicB64 }, error: null }
                : { data: null, error: null },
            ),
          }
          return builder
        }
        if (table === 'megolm_session_shares') {
          return {
            upsert: (rows: any, options: any) => {
              upsertedRows.push(rows)
              upsertOptions = options
              return Promise.resolve({ error: null })
            },
          }
        }
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
          }),
        }
      })
    })

    afterEach(async () => {
      const { identityKeyStore } = await import('../SecureSessionKeyStore')
      await identityKeyStore.clear(TEST_USER_ID).catch(() => {})
    })

    it('writes a fresh v3 share sealed to the recipient current key and re-arms the claim', async () => {
      const ok = await messageService.repairSessionShareForUser(
        TEST_ROOM_ID, SESSION_ID, RECIPIENT_ID, SESSION_KEY,
      )

      expect(ok).toBe(true)
      expect(upsertedRows).toHaveLength(1)
      const row = upsertedRows[0]
      expect(row.room_id).toBe(TEST_ROOM_ID)
      expect(row.session_id).toBe(SESSION_ID)
      expect(row.sender_user_id).toBe(TEST_USER_ID)
      expect(row.recipient_user_id).toBe(RECIPIENT_ID)
      // AAD-bound v3 sealing, never plaintext
      expect(row.encrypted_session_key.startsWith('v3:')).toBe(true)
      expect(row.encrypted_session_key).not.toContain(SESSION_KEY)
      // Claim must be re-armed so get_unclaimed_session_shares surfaces it
      expect(row.is_claimed).toBe(false)
      expect(row.claimed_at).toBeNull()
      expect(upsertOptions?.onConflict).toBe('room_id,session_id,recipient_user_id')
    })

    it('returns false and writes nothing when the recipient has no active identity key', async () => {
      recipientPublicB64 = null // simulate: no active user_key_pairs row

      const ok = await messageService.repairSessionShareForUser(
        TEST_ROOM_ID, SESSION_ID, RECIPIENT_ID, SESSION_KEY,
      )

      expect(ok).toBe(false)
      expect(upsertedRows).toHaveLength(0)
    })
  })
})
