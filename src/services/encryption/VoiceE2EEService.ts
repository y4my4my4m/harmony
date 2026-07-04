/**
 * Voice/Video E2EE - shared room key distribution (Model S)
 *
 * LiveKit's `ExternalE2EEKeyProvider` encrypts media frames with ONE shared key
 * for the whole room, but it does NOT solve key distribution. This service is
 * the distribution layer: it agrees on a single random 256-bit voice key and
 * ships it to every participant **server-blind**, by piggybacking on the
 * existing Megolm message-encryption channel (the SFU/server only ever sees
 * Megolm ciphertext).
 *
 * Design:
 *  - A deterministic "key coordinator" (smallest member id) mints the room key
 *    and distributes it; everyone else applies what they receive. This avoids
 *    races where multiple participants generate conflicting keys.
 *  - The key itself is a freshly random 32 bytes (NOT derived from a message
 *    key), so there is strict domain separation from message E2EE.
 *  - Transport: the key is wrapped with `MegolmMessageEncryptionService` to the
 *    current voice members and the resulting ciphertext is sent over LiveKit's
 *    data channel. Members decrypt with their Megolm session (shared via the
 *    normal `megolm_session_shares` path), then feed raw bytes to LiveKit.
 *
 * Capability requirement: to participate a user must have message E2EE unlocked
 * (recovery key set up + keys loaded this session). Callers gate on
 * `canParticipate()` before joining a `required` voice channel.
 */

import { megolmMessageEncryptionService, type MegolmEncryptedMessageData } from './MegolmMessageEncryptionService'
import type { MessagePart } from '@/types'
import { debug } from '@/utils/debug'

/**
 * Deterministically pick the participant responsible for minting/distributing
 * the room key. Pure function - same input yields the same coordinator on every
 * client, so all participants agree without negotiation.
 *
 * @param memberIds profile ids (or stable identities) currently in the room
 * @returns the coordinator id, or null if the room is empty
 */
export function electKeyCoordinator(memberIds: string[]): string | null {
  if (!memberIds || memberIds.length === 0) return null
  return [...memberIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]
}

/** Wire payloads exchanged over the LiveKit data channel for key distribution. */
export type VoiceKeyEnvelope =
  | {
      t: 'voice-key'
      /** Monotonic-ish id so receivers can ignore stale/duplicate keys. */
      keyId: string
      /** Megolm-encrypted room key blob (server can't read it). */
      cipher: MegolmEncryptedMessageData
    }
  | {
      /** Sent by a fresh joiner to ask the coordinator to (re)broadcast the key. */
      t: 'voice-key-request'
    }

const VOICE_KEY_BYTES = 32

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

class VoiceE2EEService {
  /**
   * Whether this client can take part in an E2E-encrypted call right now.
   * Mirrors the message-encryption gate: keys must be set up AND unlocked.
   */
  canParticipate(): boolean {
    return (
      megolmMessageEncryptionService.isInitialized() &&
      megolmMessageEncryptionService.isUnlocked()
    )
  }

  /** Generate a fresh random shared room key. */
  generateRoomKey(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(VOICE_KEY_BYTES))
  }

  /** Stable, collision-resistant id for a given key broadcast. */
  newKeyId(): string {
    return bytesToBase64(crypto.getRandomValues(new Uint8Array(9)))
  }

  /**
   * Wrap the room key for the given recipients using Megolm. The returned blob
   * is safe to send over an untrusted transport (LiveKit data channel).
   */
  async wrapKey(
    key: Uint8Array,
    roomId: string,
    recipientIds: string[]
  ): Promise<MegolmEncryptedMessageData> {
    const part: MessagePart = { type: 'text', text: bytesToBase64(key) }
    return megolmMessageEncryptionService.encryptMessage([part], roomId, recipientIds)
  }

  /**
   * Decrypt a wrapped room key. Returns the raw 32 bytes, or null if the blob
   * can't be decrypted yet (e.g. the Megolm session hasn't arrived - caller
   * should retry on the `megolm-key-received` event).
   */
  async unwrapKey(
    cipher: MegolmEncryptedMessageData,
    roomId: string
  ): Promise<Uint8Array | null> {
    try {
      const { content } = await megolmMessageEncryptionService.decryptMessage({
        content: cipher.content,
        channel_id: roomId,
        encryption_metadata: cipher.encryption_metadata,
      })
      const textPart = content.find((p): p is { type: 'text'; text: string } => p.type === 'text')
      if (!textPart) return null
      const bytes = base64ToBytes(textPart.text)
      if (bytes.length !== VOICE_KEY_BYTES) {
        debug.warn(`⚠️ [VoiceE2EE] Unwrapped key has unexpected length ${bytes.length}`)
        return null
      }
      return bytes
    } catch (err) {
      debug.warn('⚠️ [VoiceE2EE] Failed to unwrap room key (session may be pending):', err)
      return null
    }
  }
}

export const voiceE2EEService = new VoiceE2EEService()
export { bytesToBase64 as __voiceKeyBytesToBase64, base64ToBytes as __voiceKeyBase64ToBytes }
