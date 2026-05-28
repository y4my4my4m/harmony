import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { indexedDB } from 'fake-indexeddb'

import { MegolmService } from '../MegolmService'
import { RecoveryKeyService } from '../RecoveryKeyService'
import { MegolmMessageEncryptionService } from '../MegolmMessageEncryptionService'
import { signingKeyStore } from '../SecureSessionKeyStore'
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

describe('MegolmMessageEncryptionService', () => {
  let megolm: MegolmService
  let recovery: RecoveryKeyService
  let messageService: MegolmMessageEncryptionService

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

    messageService = MegolmMessageEncryptionService.getInstance()

    const keys = await recovery.deriveKeysFromMnemonic(TEST_MNEMONIC)
    await megolm.initialize(TEST_USER_ID, keys.encryptionKey)

    // Set currentUserId via reflection since constructor is private
    ;(messageService as any).currentUserId = TEST_USER_ID
    ;(messageService as any).initialized = true
  })

  afterEach(() => {
    megolm.close()
    recovery.clear()
    ;(messageService as any).currentUserId = null
    ;(messageService as any).initialized = false
  })

  // ─── Full message encrypt → decrypt round-trip ────────────

  describe('encryptMessage / decryptMessage round-trip', () => {
    // NOTE: These tests bypass the normal setup flow (which would create a
    // signing keypair from `ensureSigningKeyPair`) and inject the user id
    // directly. Without a signing key in IndexedDB the service falls back to
    // emitting legacy `megolm_v1` (unsigned), and decrypt reports
    // `senderVerified: false`. That's the correct legacy path - separate
    // tests below exercise the v2 signed path.
    it('encrypts and decrypts a text message', async () => {
      const content: MessagePart[] = [{ type: 'text', text: 'Hello encrypted world!' }]

      const encrypted = await messageService.encryptMessage(content, TEST_ROOM_ID, [])
      expect(encrypted.encrypted).toBe(true)
      expect(['megolm_v1', 'megolm_v2_signed']).toContain(encrypted.encryption_metadata.algorithm)
      expect(encrypted.encryption_metadata.sender_user_id).toBe(TEST_USER_ID)
      expect(encrypted.encryption_metadata.session_id).toBeTruthy()

      const decrypted = await messageService.decryptMessage({
        content: encrypted.content,
        channel_id: TEST_ROOM_ID,
        encryption_metadata: encrypted.encryption_metadata,
      })

      expect(decrypted.content).toEqual(content)
      // No signing key was set up → emit v1 → unverified.
      expect(decrypted.senderVerified).toBe(false)
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

    it('still decrypts legacy megolm_v1 messages but flags senderVerified: false', async () => {
      // Encrypt with the underlying MegolmService directly so we bypass
      // the v2-signing wrapper and produce a true legacy ciphertext.
      const raw = JSON.stringify([{ type: 'text', text: 'legacy hi' }])
      const legacy = await megolm.encryptMessage(TEST_ROOM_ID, raw)

      const decrypted = await messageService.decryptMessage({
        content: [{ type: 'text', text: legacy.ciphertext }],
        channel_id: TEST_ROOM_ID,
        encryption_metadata: {
          algorithm: 'megolm_v1',
          session_id: legacy.sessionId,
          message_index: legacy.messageIndex,
          sender_user_id: TEST_USER_ID,
        },
      })

      expect(decrypted.content).toEqual([{ type: 'text', text: 'legacy hi' }])
      expect(decrypted.senderVerified).toBe(false)
    })
  })
})
