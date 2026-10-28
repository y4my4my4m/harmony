import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { indexedDB } from 'fake-indexeddb'

import { MegolmService } from '../MegolmService'
import { RecoveryKeyService } from '../RecoveryKeyService'
import { MegolmMessageEncryptionService } from '../MegolmMessageEncryptionService'
import { megolmKeyBackupService } from '../MegolmKeyBackupService'
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
      // claimPendingSessionShares() does not run on the v2 fast path; stub the
      // RPC anyway so any incidental supabase call resolves.
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

      // The server pretends Alice's ciphertext was sent by Mallory. Mallory's
      // (different) signing key is published so the verifier can attempt the
      // check at all; it must still fail because the signature covers
      // `sender_user_id: alice`.
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

      // Local ECDH identity keypair - repair seals the session key with
      // ECDH(local private, recipient public), loaded from identityKeyStore.
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

  describe('session sharing recipients', () => {
    const MEMBER_ID = 'eeeeeeee-1111-2222-3333-444444444444'
    const BANNED_ID = 'ffffffff-1111-2222-3333-444444444444'
    let upserted: any[]
    // (session id, recipient) pairs skip_share_hidden_history drops.
    let withheld: Set<string>
    let rpcResult: { data: unknown; error: unknown }

    beforeEach(async () => {
      upserted = []
      withheld = new Set()
      ;(messageService as any).roomMemberCache.clear()
      const myKp = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits'],
      ) as CryptoKeyPair
      const { identityKeyStore } = await import('../SecureSessionKeyStore')
      await identityKeyStore.store(TEST_USER_ID, myKp.privateKey)

      const publicKeys = new Map<string, string>()
      for (const id of [MEMBER_ID, BANNED_ID]) {
        const kp = await crypto.subtle.generateKey(
          { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits'],
        ) as CryptoKeyPair
        const raw = await crypto.subtle.exportKey('raw', kp.publicKey)
        publicKeys.set(id, btoa(String.fromCharCode(...new Uint8Array(raw))))
      }

      ;(supabase.from as any).mockImplementation((table: string) => {
        if (table === 'user_key_pairs') {
          let ids: string[] = []
          let userId: string | null = null
          const builder: any = {
            select: () => builder,
            in: (_field: string, values: string[]) => { ids = values; return builder },
            eq: (field: string, value: string) => { if (field === 'user_id') userId = value; return builder },
            maybeSingle: () => Promise.resolve({
              data: userId && topPublicLookup.has(userId) ? { identity_signing_public_key: topPublicLookup.get(userId) } : null,
              error: null,
            }),
            then: (resolve: any) => resolve({
              data: ids.filter((id) => publicKeys.has(id))
                .map((id) => ({ user_id: id, identity_public_key: publicKeys.get(id) })),
              error: null,
            }),
          }
          return builder
        }
        if (table === 'megolm_session_shares') {
          return {
            upsert: (rows: any[]) => {
              upserted.push(...rows)
              const kept = rows.filter((r) => !withheld.has(`${r.session_id}:${r.recipient_user_id}`))
              return { select: () => Promise.resolve({ data: kept.map((r) => ({ recipient_user_id: r.recipient_user_id })), error: null }) }
            },
          }
        }
        return userKeyPairsFromMock(topPublicLookup)(table)
      })
      ;(supabase.rpc as any).mockImplementation(async (fn: string) =>
        fn === 'get_room_member_ids' ? rpcResult : { data: [], error: null })

      await megolm.getOrCreateOutboundSession(TEST_ROOM_ID)
    })

    afterEach(async () => {
      const { identityKeyStore } = await import('../SecureSessionKeyStore')
      await identityKeyStore.clear(TEST_USER_ID).catch(() => {})
    })

    function sessionId(): string {
      return megolm.getSessionKeyForSharing(TEST_ROOM_ID)!.sessionId
    }

    it('shares only with recipients the room admits', async () => {
      rpcResult = { data: [TEST_USER_ID, MEMBER_ID], error: null }
      await (messageService as any).ensureSessionShared(TEST_ROOM_ID, sessionId(), [MEMBER_ID, BANNED_ID])
      expect(upserted.map((r) => r.recipient_user_id)).toEqual([MEMBER_ID])
    })

    it('shares with every recipient when the member list is unavailable', async () => {
      rpcResult = { data: null, error: { message: 'function does not exist' } }
      await (messageService as any).ensureSessionShared(TEST_ROOM_ID, sessionId(), [MEMBER_ID, BANNED_ID])
      expect(upserted.map((r) => r.recipient_user_id).sort()).toEqual([MEMBER_ID, BANNED_ID].sort())
    })

    it('reports a member whose row the server withheld and keeps them unshared', async () => {
      rpcResult = { data: [TEST_USER_ID, MEMBER_ID], error: null }
      withheld.add(`${sessionId()}:${MEMBER_ID}`)
      const refused = await (messageService as any).ensureSessionShared(TEST_ROOM_ID, sessionId(), [MEMBER_ID])
      expect(refused).toEqual([MEMBER_ID])
      expect(megolm.getUsersNeedingSession(TEST_ROOM_ID, [MEMBER_ID], sessionId())).toEqual([MEMBER_ID])
    })

    it('reports nothing without the member list: a skipped row may be a non-member', async () => {
      rpcResult = { data: null, error: { message: 'function does not exist' } }
      withheld.add(`${sessionId()}:${BANNED_ID}`)
      expect(await (messageService as any).ensureSessionShared(TEST_ROOM_ID, sessionId(), [MEMBER_ID, BANNED_ID])).toEqual([])
    })

    it('sends under a new session when the server withholds the current one from a member', async () => {
      rpcResult = { data: [TEST_USER_ID, MEMBER_ID], error: null }
      const first = sessionId()
      withheld.add(`${first}:${MEMBER_ID}`)
      const content: MessagePart[] = [{ type: 'text', text: 'after you joined' }]

      const sent = await messageService.encryptMessage(content, TEST_ROOM_ID, [MEMBER_ID])

      expect(sent.encryption_metadata.session_id).not.toBe(first)
      expect(upserted.map((r) => r.session_id)).toEqual([first, sent.encryption_metadata.session_id])
      expect(megolm.getUsersNeedingSession(TEST_ROOM_ID, [MEMBER_ID], sent.encryption_metadata.session_id)).toEqual([])
      const decrypted = await messageService.decryptMessage({
        content: sent.content,
        channel_id: TEST_ROOM_ID,
        encryption_metadata: sent.encryption_metadata,
      })
      expect(decrypted.content).toEqual(content)
    })

    it('rotates once: a second withheld session is sent as is', async () => {
      rpcResult = { data: [TEST_USER_ID, MEMBER_ID], error: null }
      const shareSpy = vi.spyOn(messageService as any, 'ensureSessionShared').mockResolvedValue([MEMBER_ID])
      const first = sessionId()
      const sent = await messageService.encryptMessage([{ type: 'text', text: 'x' }], TEST_ROOM_ID, [MEMBER_ID])
      expect(shareSpy).toHaveBeenCalledTimes(2)
      expect(sent.encryption_metadata.session_id).not.toBe(first)
    })
  })

  // ─── Keys relayed by a member other than the sender ──────

  describe('relayed session keys', () => {
    const OTHER_SENDER = 'eeeeeeee-1111-2222-3333-444444444444'
    const content: MessagePart[] = [{ type: 'text', text: 'before you joined' }]

    let encrypted: Awaited<ReturnType<MegolmService['encryptMessage']>>
    let sessionKey: string
    let settle: ReturnType<typeof vi.spyOn>

    function relayed(key: string, requestId: string, scope: 'session' | 'message' = 'session', messageId: string | null = null) {
      return { requestId, roomId: TEST_ROOM_ID, senderUserId: OTHER_SENDER, sessionId: encrypted.sessionId, sessionKey: key, scope, messageId }
    }

    function offer(...keys: ReturnType<typeof relayed>[]) {
      vi.spyOn(megolmKeyBackupService, 'relayedKeysFor').mockImplementation(() => [...keys])
    }

    beforeEach(async () => {
      encrypted = await megolm.encryptMessage(TEST_ROOM_ID, JSON.stringify(content))
      sessionKey = megolm.getSessionKeyForSharing(TEST_ROOM_ID, encrypted.sessionId)!.sessionKey
      settle = vi.spyOn(megolmKeyBackupService, 'settleRelayedKey').mockResolvedValue()
    })

    const wrongKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))

    it('imports a relayed key once it decrypts the message', async () => {
      const key = relayed(sessionKey, 'r1')
      offer(key)
      const plaintext = await (messageService as any).decryptWithRelayedKey(TEST_ROOM_ID, OTHER_SENDER, encrypted)
      expect(JSON.parse(plaintext)).toEqual(content)
      expect(megolm.getInboundSession(TEST_ROOM_ID, OTHER_SENDER, encrypted.sessionId)?.sessionKey).toBe(sessionKey)
      expect(settle).toHaveBeenCalledWith(key, true)
    })

    it('refuses a relayed key that does not decrypt the message', async () => {
      const key = relayed(wrongKey(), 'r1')
      offer(key)
      expect(await (messageService as any).decryptWithRelayedKey(TEST_ROOM_ID, OTHER_SENDER, encrypted)).toBeNull()
      expect(megolm.hasInboundSession(TEST_ROOM_ID, OTHER_SENDER, encrypted.sessionId)).toBe(false)
      expect(settle).toHaveBeenCalledWith(key, false)
    })

    it('tries every relayed key and keeps the one that decrypts', async () => {
      const bad = relayed(wrongKey(), 'r1')
      const good = relayed(sessionKey, 'r2')
      offer(bad, good)
      const plaintext = await (messageService as any).decryptWithRelayedKey(TEST_ROOM_ID, OTHER_SENDER, encrypted)
      expect(JSON.parse(plaintext)).toEqual(content)
      expect(settle.mock.calls).toEqual([[bad, false], [good, true]])
    })

    it('settles once for messages of the session decrypted together', async () => {
      offer(relayed(sessionKey, 'r1'))
      const second = await megolm.encryptMessage(TEST_ROOM_ID, JSON.stringify(content))
      const trial = vi.spyOn(megolm, 'decryptWithSessionKey')
      const results = await Promise.all([
        (messageService as any).decryptWithRelayedKey(TEST_ROOM_ID, OTHER_SENDER, encrypted),
        (messageService as any).decryptWithRelayedKey(TEST_ROOM_ID, OTHER_SENDER, second),
      ])
      expect(results.map((r: string) => JSON.parse(r))).toEqual([content, content])
      expect(trial).toHaveBeenCalledTimes(1)
      expect(settle).toHaveBeenCalledTimes(1)
    })

    it('is null without a relayed key', async () => {
      offer()
      expect(await (messageService as any).decryptWithRelayedKey(TEST_ROOM_ID, OTHER_SENDER, encrypted)).toBeNull()
      expect(settle).not.toHaveBeenCalled()
    })

    it('a decrypt miss reads the message through a relayed key before asking anyone', async () => {
      offer(relayed(sessionKey, 'r1'))
      const request = vi.spyOn(megolmKeyBackupService, 'createKeyRequest')
      const parts = await (messageService as any).decryptMegolmMessage({
        content: [{ type: 'text', text: encrypted.ciphertext }],
        encryption_metadata: {
          session_id: encrypted.sessionId,
          message_index: encrypted.messageIndex,
          sender_user_id: OTHER_SENDER,
        },
      }, TEST_ROOM_ID)
      expect(parts).toEqual(content)
      expect(request).not.toHaveBeenCalled()
    })

    it('keeps the key of a pinned message once it decrypts that message, and nothing else of the session', async () => {
      const second = await megolm.encryptMessage(TEST_ROOM_ID, JSON.stringify(content))
      const messageKey = await megolm.deriveMessageKey(sessionKey, encrypted.messageIndex)
      const key = relayed(messageKey, 'r1', 'message', 'm1')
      offer(key)

      const plaintext = await (messageService as any).decryptWithRelayedKey(TEST_ROOM_ID, OTHER_SENDER, encrypted, undefined, 'm1')

      expect(JSON.parse(plaintext)).toEqual(content)
      expect(settle).toHaveBeenCalledWith(key, true)
      expect(megolm.getMessageKey(TEST_ROOM_ID, OTHER_SENDER, encrypted.sessionId, encrypted.messageIndex)).toBe(messageKey)
      expect(megolm.hasInboundSession(TEST_ROOM_ID, OTHER_SENDER, encrypted.sessionId)).toBe(false)
      await expect(megolm.decryptMessage(TEST_ROOM_ID, OTHER_SENDER, second)).rejects.toThrow(/No inbound session/)
    })

    it('does not try the key of another message', async () => {
      offer(relayed(await megolm.deriveMessageKey(sessionKey, encrypted.messageIndex), 'r1', 'message', 'm2'))
      expect(await (messageService as any).decryptWithRelayedKey(TEST_ROOM_ID, OTHER_SENDER, encrypted, undefined, 'm1')).toBeNull()
      expect(settle).not.toHaveBeenCalled()
    })

    it('refuses a message key that does not decrypt its message', async () => {
      const key = relayed(await megolm.deriveMessageKey(sessionKey, encrypted.messageIndex + 1), 'r1', 'message', 'm1')
      offer(key)
      expect(await (messageService as any).decryptWithRelayedKey(TEST_ROOM_ID, OTHER_SENDER, encrypted, undefined, 'm1')).toBeNull()
      expect(settle).toHaveBeenCalledWith(key, false)
      expect(megolm.getMessageKey(TEST_ROOM_ID, OTHER_SENDER, encrypted.sessionId, encrypted.messageIndex)).toBeUndefined()
    })

    describe('while the unlock sweep of fulfilled requests runs', () => {
      const missed = () => ({
        content: [{ type: 'text' as const, text: encrypted.ciphertext }],
        encryption_metadata: {
          session_id: encrypted.sessionId,
          message_index: encrypted.messageIndex,
          sender_user_id: OTHER_SENDER,
        },
      })

      let request: ReturnType<typeof vi.spyOn>
      let endSweep: (takeIn: () => Promise<void> | void) => Promise<void>

      beforeEach(() => {
        offer()
        vi.spyOn(messageService as any, 'recoverMissingSession').mockResolvedValue(false)
        request = vi.spyOn(megolmKeyBackupService, 'createKeyRequest').mockResolvedValue('req')
        let resolveSweep!: (count: number) => void
        vi.spyOn(megolmKeyBackupService as any, 'sweepMyFulfilledRequests').mockImplementation(
          () => new Promise<number>(resolve => { resolveSweep = resolve }),
        )
        endSweep = async (takeIn) => {
          await takeIn()
          resolveSweep(1)
        }
      })

      // The miss reaches its key request before the sweep takes the key in.
      async function missDuringSweep() {
        const fastPath = vi.spyOn(megolm, 'decryptMessage')
        void megolmKeyBackupService.processMyFulfilledRequests()
        const decrypting = (messageService as any).decryptMegolmMessage(missed(), TEST_ROOM_ID) as Promise<MessagePart[]>
        decrypting.catch(() => {})
        await vi.waitFor(() => expect(fastPath).toHaveBeenCalled())
        await new Promise(resolve => setTimeout(resolve, 0))
        return { decrypting }
      }

      it('a miss reads the message through the relayed key the sweep holds', async () => {
        const { decrypting } = await missDuringSweep()
        await endSweep(() => offer(relayed(sessionKey, 'r1')))
        expect(await decrypting).toEqual(content)
        expect(settle).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r1' }), true)
        expect(request).not.toHaveBeenCalled()
      })

      it("a miss reads the message through the sender's key the sweep imports", async () => {
        const { decrypting } = await missDuringSweep()
        await endSweep(() => megolm.importInboundSession(TEST_ROOM_ID, OTHER_SENDER, encrypted.sessionId, sessionKey, 0))
        expect(await decrypting).toEqual(content)
        expect(request).not.toHaveBeenCalled()
      })

      it('a miss the sweep does not answer asks for the key once the sweep ends', async () => {
        const { decrypting } = await missDuringSweep()
        expect(request).not.toHaveBeenCalled()
        await endSweep(() => {})
        await expect(decrypting).rejects.toThrow(/key request sent/)
        expect(request).toHaveBeenCalledTimes(1)
      })
    })

    it('a decrypt miss names the message and its pin in the key request', async () => {
      offer()
      vi.spyOn(messageService as any, 'recoverMissingSession').mockResolvedValue(false)
      const request = vi.spyOn(megolmKeyBackupService, 'createKeyRequest').mockResolvedValue('req')
      await expect((messageService as any).decryptMegolmMessage({
        id: 'm1',
        is_pinned: true,
        content: [{ type: 'text', text: encrypted.ciphertext }],
        encryption_metadata: {
          session_id: encrypted.sessionId,
          message_index: encrypted.messageIndex,
          sender_user_id: OTHER_SENDER,
        },
      }, TEST_ROOM_ID)).rejects.toThrow(/key request sent/)
      expect(request).toHaveBeenCalledWith(TEST_ROOM_ID, encrypted.sessionId, OTHER_SENDER, { id: 'm1', pinned: true })
    })
  })
})
