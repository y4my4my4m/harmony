import { describe, it, expect } from 'vitest'
import { FrameEncryptor } from '../WebRTCEncryptionService'

async function newKey(): Promise<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32)).buffer
}

describe('WebRTCEncryptionService.FrameEncryptor - fail-closed crypto', () => {
  it('round-trips frame data when key matches', async () => {
    const key = await newKey()
    const enc = new FrameEncryptor()
    const dec = new FrameEncryptor()
    await enc.initialize(key)
    await dec.initialize(key)

    const frame = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const encrypted = await enc.encrypt(frame)
    const decrypted = await dec.decrypt(encrypted)
    expect(Array.from(decrypted)).toEqual(Array.from(frame))
  })

  it('encrypt() output is longer than input (IV + AES-GCM tag) and not equal to plaintext', async () => {
    const enc = new FrameEncryptor()
    await enc.initialize(await newKey())

    const frame = new Uint8Array([10, 20, 30])
    const encrypted = await enc.encrypt(frame)
    expect(encrypted.byteLength).toBeGreaterThan(frame.byteLength)
    // Frame bytes start after the 12-byte IV; ensure they differ from plaintext.
    expect(Array.from(encrypted).slice(12, 15)).not.toEqual(Array.from(frame))
  })

  it('decrypt() throws on tampered ciphertext (fail-closed; no silent passthrough)', async () => {
    const key = await newKey()
    const enc = new FrameEncryptor()
    const dec = new FrameEncryptor()
    await enc.initialize(key)
    await dec.initialize(key)

    const frame = new Uint8Array([99, 100, 101])
    const encrypted = await enc.encrypt(frame)
    // Flip a bit in the AES-GCM tag region to break authentication.
    encrypted[encrypted.length - 1] ^= 0xff

    await expect(dec.decrypt(encrypted)).rejects.toBeDefined()
  })

  it('decrypt() throws when the wrong key is used', async () => {
    const enc = new FrameEncryptor()
    const dec = new FrameEncryptor()
    await enc.initialize(await newKey())
    await dec.initialize(await newKey()) // different key

    const frame = new Uint8Array([1, 1, 1])
    const encrypted = await enc.encrypt(frame)
    await expect(dec.decrypt(encrypted)).rejects.toBeDefined()
  })

  it('throws when used before initialize()', async () => {
    const enc = new FrameEncryptor()
    await expect(enc.encrypt(new Uint8Array([1]))).rejects.toThrow('not initialized')
    await expect(enc.decrypt(new Uint8Array(16))).rejects.toThrow('not initialized')
  })
})
