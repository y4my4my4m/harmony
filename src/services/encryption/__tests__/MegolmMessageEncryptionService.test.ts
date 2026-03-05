import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { indexedDB } from 'fake-indexeddb'

import { MegolmService } from '../MegolmService'
import { RecoveryKeyService } from '../RecoveryKeyService'
import { MegolmMessageEncryptionService } from '../MegolmMessageEncryptionService'
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
    it('encrypts and decrypts a text message', async () => {
      const content: MessagePart[] = [{ type: 'text', text: 'Hello encrypted world!' }]

      const encrypted = await messageService.encryptMessage(content, TEST_ROOM_ID, [])
      expect(encrypted.encrypted).toBe(true)
      expect(encrypted.encryption_metadata.algorithm).toBe('megolm_v1')
      expect(encrypted.encryption_metadata.sender_user_id).toBe(TEST_USER_ID)
      expect(encrypted.encryption_metadata.session_id).toBeTruthy()

      const decrypted = await messageService.decryptMessage({
        content: encrypted.content,
        channel_id: TEST_ROOM_ID,
        encryption_metadata: encrypted.encryption_metadata,
      })

      expect(decrypted).toEqual(content)
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

      expect(decrypted).toEqual(content)
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

      expect(decrypted).toEqual(content)
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
        expect(decrypted).toEqual(messages[i])
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
})
