/**
 * MessageSigner
 *
 * Per-message sender binding for Megolm v2.
 *
 * Without this, `messages.encryption_metadata.sender_user_id` is just plain
 * JSON on the row - any DB writer can re-attribute a ciphertext to another
 * user. Clients trust that field for display AND for public-key lookup
 * during decrypt, so reattribution is silent and undetectable.
 *
 * With this, each encrypted message carries an ECDSA P-256 signature over a
 * canonical encoding of the message's identifying fields. Recipients verify
 * the signature against the claimed sender's published signing key BEFORE
 * decrypting. A mismatch is treated as a forgery.
 *
 * Why ECDSA P-256 (and not Ed25519):
 * - Universally supported by Web Crypto (`crypto.subtle.sign` with name
 *   'ECDSA'). Ed25519 support is still gated by feature flags in some
 *   browsers and the SubtleCrypto interface lacks first-class support.
 * - Same curve already used for the ECDH identity key, so we keep one
 *   crypto stack.
 * - 256-bit security level is more than enough for messaging signatures.
 *
 * Canonical encoding:
 * - JSON with a deterministic, sorted-key serialization (see
 *   `canonicalizeForSigning`). We deliberately do NOT use general JSON
 *   serialization because key ordering would diverge across runtimes and
 *   break signatures.
 * - UTF-8 bytes of that string are the "to-be-signed" (TBS) payload.
 */

import { debug } from '@/utils/debug'

/** Fields of a Megolm message that the signature binds together. */
export interface SignedMessageFields {
  algorithm: string
  room_id: string
  session_id: string
  message_index: number
  sender_user_id: string
  // SHA-256(ciphertext) as base64, NOT the ciphertext itself, to keep the
  // TBS short and to avoid the temptation to "re-encode" ciphertext bytes.
  ciphertext_hash_b64: string
  timestamp: number
}

const SIGNING_ALG: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' }
const SIGNING_KEY_PARAMS: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' }
const KEY_GEN_PARAMS: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' }

// =====================================================
// CANONICAL ENCODING
// =====================================================

/**
 * Deterministic JSON encoding with sorted keys. Numbers are encoded as JSON
 * numbers (no Date.toJSON or BigInt surprises - caller must pass primitives).
 *
 * Why we don't use a 3rd-party canonicalizer: this is the only canonical
 * encoding consumed in the codebase, and the shape we sign is small and
 * fully under our control.
 */
export function canonicalizeForSigning(fields: SignedMessageFields): string {
  // Sort keys lexicographically; only emit fields explicitly declared.
  const ordered: Record<string, string | number> = {
    algorithm: fields.algorithm,
    ciphertext_hash_b64: fields.ciphertext_hash_b64,
    message_index: fields.message_index,
    room_id: fields.room_id,
    sender_user_id: fields.sender_user_id,
    session_id: fields.session_id,
    timestamp: fields.timestamp,
  }
  // Belt-and-suspenders: re-sort just in case the object literal above
  // is reordered by a future edit.
  const sortedKeys = Object.keys(ordered).sort()
  const sorted: Record<string, string | number> = {}
  for (const k of sortedKeys) sorted[k] = ordered[k]
  return JSON.stringify(sorted)
}

/**
 * Hash the ciphertext (base64 text) and base64-encode the digest.
 * We hash the BYTES of the ciphertext after base64-decoding so that
 * formatting differences (whitespace, padding) cannot change the hash.
 */
export async function hashCiphertextB64(ciphertextBase64: string): Promise<string> {
  // Decode the ciphertext base64 → raw bytes
  let raw: Uint8Array
  try {
    raw = Uint8Array.from(atob(ciphertextBase64), c => c.charCodeAt(0))
  } catch {
    // If for some reason the ciphertext isn't valid base64, hash the
    // utf-8 of the raw string. Better than throwing and breaking the
    // sign/verify symmetry.
    raw = new TextEncoder().encode(ciphertextBase64)
  }
  const digest = await crypto.subtle.digest('SHA-256', raw)
  const bytes = new Uint8Array(digest)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// =====================================================
// KEY MGMT
// =====================================================

/**
 * Generate a fresh ECDSA P-256 signing keypair. The private key is
 * created `extractable: true` so the caller can wrap it for storage;
 * the non-extractable cache copy is created separately.
 */
export async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(KEY_GEN_PARAMS, true, ['sign', 'verify']) as Promise<CryptoKeyPair>
}

/**
 * Import a SPKI-encoded public signing key from base64.
 */
export async function importPublicSigningKey(spkiBase64: string): Promise<CryptoKey> {
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(spkiBase64), c => c.charCodeAt(0))
  } catch {
    throw new Error('Invalid base64 for signing public key')
  }
  return crypto.subtle.importKey('spki', bytes, SIGNING_KEY_PARAMS, false, ['verify'])
}

/**
 * Import a PKCS#8-encoded private signing key from base64.
 * `extractable` defaults to false (recommended for IndexedDB caching).
 */
export async function importPrivateSigningKey(
  pkcs8Base64: string,
  extractable = false,
): Promise<CryptoKey> {
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(pkcs8Base64), c => c.charCodeAt(0))
  } catch {
    throw new Error('Invalid base64 for signing private key')
  }
  return crypto.subtle.importKey('pkcs8', bytes, SIGNING_KEY_PARAMS, extractable, ['sign'])
}

export async function exportPublicSigningKey(publicKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('spki', publicKey)
  const bytes = new Uint8Array(raw)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export async function exportPrivateSigningKey(privateKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('pkcs8', privateKey)
  const bytes = new Uint8Array(raw)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// =====================================================
// SIGN / VERIFY
// =====================================================

export async function signMessage(
  fields: SignedMessageFields,
  privateKey: CryptoKey,
): Promise<string> {
  const tbs = canonicalizeForSigning(fields)
  const signature = await crypto.subtle.sign(SIGNING_ALG, privateKey, new TextEncoder().encode(tbs))
  const bytes = new Uint8Array(signature)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export async function verifyMessageSignature(
  fields: SignedMessageFields,
  signatureBase64: string,
  publicKey: CryptoKey,
): Promise<boolean> {
  let signature: Uint8Array
  try {
    signature = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0))
  } catch {
    debug.warn('⚠️ Invalid signature base64')
    return false
  }
  const tbs = canonicalizeForSigning(fields)
  try {
    return await crypto.subtle.verify(
      SIGNING_ALG,
      publicKey,
      signature,
      new TextEncoder().encode(tbs),
    )
  } catch (err) {
    debug.warn('⚠️ verifyMessageSignature threw:', err)
    return false
  }
}
