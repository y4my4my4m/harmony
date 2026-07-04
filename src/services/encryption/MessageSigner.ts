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
  // v3-only fields. Omitted (undefined) for v2 so v2 canonicalization - and
  // therefore existing v2 signatures - stay byte-identical.
  epoch_id?: number
  sender_device_id?: string
}

const SIGNING_ALG: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' }
const SIGNING_KEY_PARAMS: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' }
const KEY_GEN_PARAMS: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' }

/**
 * Fields of a Megolm key REQUEST that the requester signs.
 *
 * A key request asks a session holder to hand over a room session key. Without
 * a signature, any DB writer could forge a request "from" a victim and have an
 * honest holder wrap the session key for an attacker-controlled device. Signing
 * binds the request to the requester's identity so the fulfiller can verify the
 * request actually came from the claimed requester before fulfilling.
 */
export interface KeyRequestFields {
  room_id: string
  session_id: string
  requester_user_id: string
}

/**
 * Deterministic, sorted-key encoding of a key-request TBS payload.
 *
 * Note: intentionally no timestamp/nonce. The fulfiller reconstructs this from
 * the stored row's (room_id, session_id, requester_user_id), all of which are
 * stable. Replay of an authorized request is harmless - the fulfiller re-checks
 * current room membership before handing over the key, so a stale/duplicate
 * request from a since-removed member is rejected on the membership gate.
 */
export function canonicalizeKeyRequest(fields: KeyRequestFields): string {
  const ordered: Record<string, string | number> = {
    purpose: 'megolm_key_request',
    requester_user_id: fields.requester_user_id,
    room_id: fields.room_id,
    session_id: fields.session_id,
  }
  const sortedKeys = Object.keys(ordered).sort()
  const sorted: Record<string, string | number> = {}
  for (const k of sortedKeys) sorted[k] = ordered[k]
  return JSON.stringify(sorted)
}

// CANONICAL ENCODING

/**
 * Deterministic JSON encoding with sorted keys. Numbers are encoded as JSON
 * numbers (no Date.toJSON or BigInt surprises - caller must pass primitives).
 *
 * Why we don't use a 3rd-party canonicalizer: this is the only canonical
 * encoding consumed in the codebase, and the shape we sign is small and
 * fully under our control.
 */
export function canonicalizeForSigning(fields: SignedMessageFields): string {
  const ordered: Record<string, string | number> = {
    algorithm: fields.algorithm,
    ciphertext_hash_b64: fields.ciphertext_hash_b64,
    message_index: fields.message_index,
    room_id: fields.room_id,
    sender_user_id: fields.sender_user_id,
    session_id: fields.session_id,
    timestamp: fields.timestamp,
  }
  // v3 additions: only included when present, so v2 TBS is unchanged.
  if (typeof fields.epoch_id === 'number') ordered.epoch_id = fields.epoch_id
  if (typeof fields.sender_device_id === 'string') ordered.sender_device_id = fields.sender_device_id
  // Belt-and-suspenders: re-sort just in case the object literal above
  // is reordered by a future edit.
  const sortedKeys = Object.keys(ordered).sort()
  const sorted: Record<string, string | number> = {}
  for (const k of sortedKeys) sorted[k] = ordered[k]
  return JSON.stringify(sorted)
}

/**
 * Canonical AES-GCM Additional Authenticated Data for v3 messages. Binds the
 * metadata that is known BEFORE encryption (algorithm, content type, epoch,
 * room, sender) into the AEAD tag. session_id / message_index / ciphertext are
 * covered by the ECDSA signature instead, so together the two cover the full
 * metadata set without an ordering dependency at encrypt time.
 */
export interface AadFieldsV3 {
  algorithm: string
  content_type: string
  epoch_id: number
  room_id: string
  sender_user_id: string
}

export function canonicalizeAadV3(fields: AadFieldsV3): string {
  const ordered: Record<string, string | number> = {
    algorithm: fields.algorithm,
    content_type: fields.content_type,
    epoch_id: fields.epoch_id,
    room_id: fields.room_id,
    sender_user_id: fields.sender_user_id,
  }
  const sortedKeys = Object.keys(ordered).sort()
  const sorted: Record<string, string | number> = {}
  for (const k of sortedKeys) sorted[k] = ordered[k]
  return JSON.stringify(sorted)
}

/** UTF-8 bytes of the canonical v3 AAD (what AES-GCM consumes). */
export function buildAadBytesV3(fields: AadFieldsV3): Uint8Array {
  return new TextEncoder().encode(canonicalizeAadV3(fields))
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

// KEY MGMT

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

// SIGN / VERIFY

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

/** Sign a key-request TBS payload with the requester's signing private key. */
export async function signKeyRequest(
  fields: KeyRequestFields,
  privateKey: CryptoKey,
): Promise<string> {
  const tbs = canonicalizeKeyRequest(fields)
  const signature = await crypto.subtle.sign(SIGNING_ALG, privateKey, new TextEncoder().encode(tbs))
  const bytes = new Uint8Array(signature)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** Verify a key-request signature against the requester's signing public key. */
export async function verifyKeyRequestSignature(
  fields: KeyRequestFields,
  signatureBase64: string,
  publicKey: CryptoKey,
): Promise<boolean> {
  let signature: Uint8Array
  try {
    signature = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0))
  } catch {
    debug.warn('⚠️ Invalid key-request signature base64')
    return false
  }
  const tbs = canonicalizeKeyRequest(fields)
  try {
    return await crypto.subtle.verify(
      SIGNING_ALG,
      publicKey,
      signature,
      new TextEncoder().encode(tbs),
    )
  } catch (err) {
    debug.warn('⚠️ verifyKeyRequestSignature threw:', err)
    return false
  }
}
