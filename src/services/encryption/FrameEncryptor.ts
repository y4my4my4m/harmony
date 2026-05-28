/**
 * Frame encryption using AES-GCM
 * Uses WebCrypto API for fast encryption.
 *
 * Extracted from `WebRTCEncryptionService.ts` (PC3, BUGS.md) so that the
 * implementation can be imported by a DedicatedWorker without pulling in
 * the rest of the encryption service stack (Signal Protocol, message
 * encryption, etc.). The unit-test suite imports this class directly to
 * verify fail-closed behaviour on encrypt/decrypt errors.
 *
 * IMPORTANT: this file must remain free of dependencies that are unavailable
 * inside a Worker context (`window`, `document`, DOM, Vue stores, etc.).
 */

export class FrameEncryptor {
  private key: CryptoKey | null = null
  private counter = 0

  async initialize(keyMaterial: ArrayBuffer): Promise<void> {
    this.key = await crypto.subtle.importKey(
      'raw',
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
    this.counter = 0
  }

  async encrypt(frame: Uint8Array): Promise<Uint8Array> {
    if (!this.key) {
      throw new Error('Frame encryptor not initialized')
    }

    const iv = new Uint8Array(12)
    const counterBytes = new DataView(iv.buffer, 4, 8)
    counterBytes.setBigUint64(0, BigInt(this.counter++), false)

    // Fail closed: if AES-GCM rejects we MUST NOT forward the cleartext on
    // the wire - that silently downgrades the call to plaintext while the
    // UI still claims E2EE is active.
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      this.key,
      frame
    )

    const result = new Uint8Array(iv.length + encrypted.byteLength)
    result.set(iv, 0)
    result.set(new Uint8Array(encrypted), iv.length)

    return result
  }

  async decrypt(encryptedFrame: Uint8Array): Promise<Uint8Array> {
    if (!this.key) {
      throw new Error('Frame decryptor not initialized')
    }

    const iv = encryptedFrame.slice(0, 12)
    const data = encryptedFrame.slice(12)

    // Throw on decryption failure rather than passing the ciphertext back as
    // "audio/video data". The transform stream drops the frame on throw,
    // which is the right behavior for tampered or unauthenticated frames.
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      this.key,
      data
    )

    return new Uint8Array(decrypted)
  }

  reset(): void {
    this.counter = 0
  }
}
