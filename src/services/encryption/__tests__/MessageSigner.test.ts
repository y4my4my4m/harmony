import { describe, it, expect } from 'vitest'
import {
  canonicalizeForSigning,
  hashCiphertextB64,
  generateSigningKeyPair,
  exportPublicSigningKey,
  exportPrivateSigningKey,
  importPublicSigningKey,
  importPrivateSigningKey,
  signMessage,
  verifyMessageSignature,
  type SignedMessageFields,
} from '../MessageSigner'

const sampleFields = (overrides: Partial<SignedMessageFields> = {}): SignedMessageFields => ({
  algorithm: 'megolm_v2_signed',
  room_id: 'room-123',
  session_id: 'session-abc',
  message_index: 0,
  sender_user_id: 'alice',
  ciphertext_hash_b64: 'aGFzaA==',
  timestamp: 1700000000000,
  ...overrides,
})

describe('canonicalizeForSigning', () => {
  it('produces the same output regardless of field declaration order', () => {
    const a = canonicalizeForSigning({
      algorithm: 'megolm_v2_signed',
      room_id: 'r',
      session_id: 's',
      message_index: 1,
      sender_user_id: 'u',
      ciphertext_hash_b64: 'h',
      timestamp: 1,
    })
    const b = canonicalizeForSigning({
      timestamp: 1,
      ciphertext_hash_b64: 'h',
      sender_user_id: 'u',
      message_index: 1,
      session_id: 's',
      room_id: 'r',
      algorithm: 'megolm_v2_signed',
    })
    expect(a).toBe(b)
  })

  it('changes when any field changes', () => {
    const base = canonicalizeForSigning(sampleFields())
    expect(canonicalizeForSigning(sampleFields({ message_index: 1 }))).not.toBe(base)
    expect(canonicalizeForSigning(sampleFields({ sender_user_id: 'bob' }))).not.toBe(base)
    expect(canonicalizeForSigning(sampleFields({ session_id: 'other' }))).not.toBe(base)
    expect(canonicalizeForSigning(sampleFields({ timestamp: 1 }))).not.toBe(base)
  })
})

describe('hashCiphertextB64', () => {
  it('is stable for the same input', async () => {
    const a = await hashCiphertextB64('SGVsbG8gV29ybGQ=')
    const b = await hashCiphertextB64('SGVsbG8gV29ybGQ=')
    expect(a).toBe(b)
  })

  it('differs for different inputs', async () => {
    const a = await hashCiphertextB64('SGVsbG8gV29ybGQ=')
    const b = await hashCiphertextB64('aGVsbG8gV29ybGQ=')
    expect(a).not.toBe(b)
  })

  it('falls back to utf-8 hashing when given non-base64 text', async () => {
    // Should not throw; just produces a hash of the literal string bytes.
    const hash = await hashCiphertextB64('not base64 at all!!!')
    expect(hash).toMatch(/^[A-Za-z0-9+/=]+$/)
  })
})

describe('sign/verify round-trip', () => {
  it('produces a signature that verifies with the matching public key', async () => {
    const keyPair = await generateSigningKeyPair()
    const fields = sampleFields()

    const signature = await signMessage(fields, keyPair.privateKey)
    const ok = await verifyMessageSignature(fields, signature, keyPair.publicKey)
    expect(ok).toBe(true)
  })

  it('fails verification with the wrong key', async () => {
    const alice = await generateSigningKeyPair()
    const bob = await generateSigningKeyPair()
    const fields = sampleFields()

    const signature = await signMessage(fields, alice.privateKey)
    const ok = await verifyMessageSignature(fields, signature, bob.publicKey)
    expect(ok).toBe(false)
  })

  it('fails verification when sender_user_id is tampered (reattribution attack)', async () => {
    const keyPair = await generateSigningKeyPair()
    const aliceFields = sampleFields({ sender_user_id: 'alice' })

    const signature = await signMessage(aliceFields, keyPair.privateKey)
    // Server swaps the metadata to Bob - verify should reject.
    const bobFields = sampleFields({ sender_user_id: 'bob' })
    const ok = await verifyMessageSignature(bobFields, signature, keyPair.publicKey)
    expect(ok).toBe(false)
  })

  it('fails verification when ciphertext hash is tampered', async () => {
    const keyPair = await generateSigningKeyPair()
    const fields = sampleFields({ ciphertext_hash_b64: 'AAAA' })

    const signature = await signMessage(fields, keyPair.privateKey)
    const tampered = sampleFields({ ciphertext_hash_b64: 'BBBB' })
    const ok = await verifyMessageSignature(tampered, signature, keyPair.publicKey)
    expect(ok).toBe(false)
  })

  it('fails verification on a corrupted signature', async () => {
    const keyPair = await generateSigningKeyPair()
    const fields = sampleFields()

    const signature = await signMessage(fields, keyPair.privateKey)
    // Flip a base64 byte deterministically by swapping the first char.
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)
    const ok = await verifyMessageSignature(fields, flipped, keyPair.publicKey)
    expect(ok).toBe(false)
  })

  it('does not throw on totally invalid base64 signature', async () => {
    const keyPair = await generateSigningKeyPair()
    const fields = sampleFields()
    const ok = await verifyMessageSignature(fields, '!!!not base64!!!', keyPair.publicKey)
    expect(ok).toBe(false)
  })
})

describe('export/import round-trip', () => {
  it('preserves verify capability through SPKI export/import', async () => {
    const keyPair = await generateSigningKeyPair()
    const fields = sampleFields()
    const signature = await signMessage(fields, keyPair.privateKey)

    const spki = await exportPublicSigningKey(keyPair.publicKey)
    const reimported = await importPublicSigningKey(spki)
    const ok = await verifyMessageSignature(fields, signature, reimported)
    expect(ok).toBe(true)
  })

  it('preserves sign capability through PKCS#8 export/import (extractable=true)', async () => {
    const keyPair = await generateSigningKeyPair()
    const fields = sampleFields()

    const pkcs8 = await exportPrivateSigningKey(keyPair.privateKey)
    const reimported = await importPrivateSigningKey(pkcs8, true)
    const signature = await signMessage(fields, reimported)
    const ok = await verifyMessageSignature(fields, signature, keyPair.publicKey)
    expect(ok).toBe(true)
  })

  it('makes the imported private key non-extractable when requested', async () => {
    const keyPair = await generateSigningKeyPair()
    const pkcs8 = await exportPrivateSigningKey(keyPair.privateKey)
    const reimported = await importPrivateSigningKey(pkcs8) // default: non-extractable

    await expect(crypto.subtle.exportKey('pkcs8', reimported)).rejects.toBeDefined()
  })
})
