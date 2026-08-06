/**
 * MessageSigner
 *
 * Per-message sender binding for Megolm v2.
 *
 * `messages.encryption_metadata.sender_user_id` is plain JSON on the row; any
 * DB writer can re-attribute a ciphertext to another user. Clients trust that
 * field both for display and for public-key lookup during decrypt, so
 * reattribution is otherwise silent.
 *
 * Each encrypted message carries an ECDSA P-256 signature over a canonical
 * encoding of the message's identifying fields. Recipients verify against the
 * claimed sender's published signing key before decrypting. A mismatch is a
 * forgery.
 *
 * ECDSA P-256 rather than Ed25519:
 * - Web Crypto supports it everywhere (`crypto.subtle.sign`, name 'ECDSA').
 *   Ed25519 remains feature-flagged in some browsers and lacks first-class
 *   SubtleCrypto support.
 * - Same curve as the ECDH identity key, so one crypto stack.
 * - 256-bit security level suffices for messaging signatures.
 *
 * Canonical encoding:
 * - Deterministic sorted-key JSON (see `canonicalizeForSigning`). General JSON
 *   serialization is unusable: key ordering diverges across runtimes and
 *   breaks signatures.
 * - UTF-8 bytes of that string are the to-be-signed (TBS) payload.
 */

import { debug } from '@/utils/debug'

/** Fields of a Megolm message that the signature binds together. */
export interface SignedMessageFields {
  algorithm: string
  room_id: string
  session_id: string
  message_index: number
  sender_user_id: string
  // SHA-256(ciphertext) as base64, not the ciphertext itself. Keeps the TBS
  // short and avoids re-encoding ciphertext bytes.
  ciphertext_hash_b64: string
  timestamp: number
  // v3-only fields. Undefined for v2 so v2 canonicalization - and therefore
  // existing v2 signatures - stay byte-identical.
  epoch_id?: number
  sender_device_id?: string
}

const SIGNING_ALG: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' }
const SIGNING_KEY_PARAMS: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' }
const KEY_GEN_PARAMS: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' }

/**
 * Fields of a Megolm key request that the requester signs.
 *
 * A key request asks a session holder to hand over a room session key. Unsigned,
 * any DB writer could forge a request "from" a victim and have an honest holder
 * wrap the session key for an attacker-controlled device. The signature binds
 * the request to the requester's identity for the fulfiller to check.
 */
export interface KeyRequestFields {
  room_id: string
  session_id: string
  requester_user_id: string
}

/**
 * Deterministic, sorted-key encoding of a key-request TBS payload.
 *
 * NOTE: no timestamp/nonce. The fulfiller reconstructs the payload from the
 * stored row's (room_id, session_id, requester_user_id), all stable. Replay of
 * an authorized request is harmless: the fulfiller re-checks current room
 * membership before handing over the key, so a request from a since-removed
 * member fails the membership gate.
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
 * Deterministic JSON encoding with sorted keys. Numbers encode as JSON numbers;
 * caller must pass primitives (no Date.toJSON or BigInt).
 *
 * No third-party canonicalizer: this is the only canonical encoding in the
 * codebase and the signed shape is small and fixed.
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
  // v3 additions: included only when present, so v2 TBS is unchanged.
  if (typeof fields.epoch_id === 'number') ordered.epoch_id = fields.epoch_id
  if (typeof fields.sender_device_id === 'string') ordered.sender_device_id = fields.sender_device_id
  // Re-sort: the literal above carries no ordering guarantee across edits.
  const sortedKeys = Object.keys(ordered).sort()
  const sorted: Record<string, string | number> = {}
  for (const k of sortedKeys) sorted[k] = ordered[k]
  return JSON.stringify(sorted)
}

/**
 * Canonical AES-GCM Additional Authenticated Data for v3 messages. Binds the
 * metadata known before encryption (algorithm, content type, epoch, room,
 * sender) into the AEAD tag. session_id / message_index / ciphertext are
 * covered by the ECDSA signature instead, so the two together cover the full
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
 * SHA-256 of the ciphertext bytes, base64-encoded. Hashing the decoded bytes
 * rather than the base64 text keeps whitespace and padding differences out of
 * the digest.
 */
export async function hashCiphertextB64(ciphertextBase64: string): Promise<string> {
  let raw: Uint8Array
  try {
    raw = Uint8Array.from(atob(ciphertextBase64), c => c.charCodeAt(0))
  } catch {
    // Non-base64 input: hash its UTF-8 bytes. Throwing here would break
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
 * ECDSA P-256 signing keypair. Private key is `extractable: true` so the caller
 * can wrap it for storage; the non-extractable cache copy is created separately.
 */
export async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(KEY_GEN_PARAMS, true, ['sign', 'verify']) as Promise<CryptoKeyPair>
}

export async function importPublicSigningKey(spkiBase64: string): Promise<CryptoKey> {
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(spkiBase64), c => c.charCodeAt(0))
  } catch {
    throw new Error('Invalid base64 for signing public key')
  }
  return crypto.subtle.importKey('spki', bytes, SIGNING_KEY_PARAMS, false, ['verify'])
}

/** `extractable` defaults to false, the form used for IndexedDB caching. */
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
    debug.warn('Invalid signature base64')
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
    debug.warn('verifyMessageSignature threw:', err)
    return false
  }
}

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

export async function verifyKeyRequestSignature(
  fields: KeyRequestFields,
  signatureBase64: string,
  publicKey: CryptoKey,
): Promise<boolean> {
  let signature: Uint8Array
  try {
    signature = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0))
  } catch {
    debug.warn('Invalid key-request signature base64')
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
    debug.warn('verifyKeyRequestSignature threw:', err)
    return false
  }
}
