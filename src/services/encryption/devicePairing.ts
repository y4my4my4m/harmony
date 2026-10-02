/**
 * QR device pairing: codes, derivations and the sealed key bundle. No I/O; the flows that
 * talk to the server are in DevicePairingService.
 *
 * A new device (B) receives the account's recovery-derived encryption and backup keys from
 * a signed-in device (A). With them B unlocks as a recovery-phrase unlock does. Both
 * directions use one device_approval_requests row and one sealed bundle, delivered through
 * approve_device_request.
 *
 * B shows the QR:
 *   B  ephemeral P-256 key pair P_B, 16-byte secret s; request row {P_B, H(token(s))}
 *   B  QR = mode 1 | request id | SHA-256(P_B) | s | expiry
 *   A  scans, reads the row, refuses unless SHA-256(row.P_B) is the QR fingerprint and
 *      row.H equals H(token(s)); seals the keys to row.P_B; approves with token(s)
 *   B  opens the bundle with its private key and s
 *
 * A shows the QR:
 *   A  16-byte secret s; QR = mode 2 | account tag | s | expiry
 *   B  scans; opens a request {P_B, H(token(s)), proof = HMAC(k_proof, P_B)}
 *   A  refuses unless the proof verifies against row.P_B; seals and approves as above
 *
 * Derivations: HKDF-SHA-256 over s, salt "harmony-device-pairing-v1", 32 bytes each.
 *   info "approval-token"  token; the server stores hex SHA-256 of its base64url text
 *   info "proof"           HMAC-SHA-256 key for the reverse-direction proof
 *   info "bundle"          mixed into the bundle key
 * Bundle key: HKDF-SHA-256(ECDH(E, P_B) || k_bundle, same salt, info "bundle-key:" + request
 * id), E an ephemeral key pair of A. AES-256-GCM, AAD = "harmony-pair-bundle-v1:" + request
 * id || P_B || E. Wire form: "pb1." + base64url(E (65) || iv (12) || ciphertext).
 * Points are uncompressed (65 bytes). The QR text is "HMP:" + base64url(binary code).
 *
 * Key custody. Stored keys are non-extractable (SecureSessionKeyStore). An approver exports
 * the encryption and backup keys while it holds them in memory as derived (after a
 * recovery-phrase unlock, a setup or a pairing in the same page session) or from its
 * pairing copy: extractable copies of those two keys, kept only on a device whose user
 * ticked "link devices from here later" when approving, and removable in Encryption
 * settings. Without a copy, an approver asks for the recovery phrase after a reload. Script
 * in an unlocked page can use the keys while the page is open, and through them decrypt
 * the server-held identity keys and the current backup; on a device with a pairing copy it
 * can also read both keys out and decrypt later backups offline until encryption is reset.
 *
 * Device trust is server-controlled (20261007100001). 'verified' is set only when an
 * approval carries keys sealed after the QR check; a one-tap approval changes no trust and
 * sends nothing. A device signed out or removed from another device clears its stored keys
 * on its next start.
 *
 * Threat model.
 * Protects against:
 *  - Key substitution by the server, its database or the realtime path: the approver checks
 *    the requesting key against the fingerprint (B shows) or the proof (A shows) it read off
 *    the other screen, and seals nothing on a mismatch.
 *  - A forged or replaced bundle: the bundle key mixes in s, which the server never sees.
 *    The server sees the token and the proof, both one-way functions of s.
 *  - Replay: a request lives 10 minutes and the server accepts its token once; B opens one
 *    bundle, then drops its private key; A accepts one proof per code it shows.
 *  - Approval by a session that has only the password: it holds no keys to seal.
 *  - A recorded bundle: both ECDH keys are ephemeral and nothing long-term decrypts it.
 * Does not protect against:
 *  - A code shown by A and seen, while valid, by someone signed in to the account: their
 *    request carries a valid proof. A shows the requesting device label and asks first.
 *  - The user scanning a code on a device that is not theirs but is signed in to the
 *    account (an attacker asking them to). The fingerprint proves which screen was
 *    scanned, not whose device it is.
 *  - A compromised A or B, or a hostile server serving the web client's JavaScript: the
 *    code that runs the checks is then the attacker's. Native builds bundle their code.
 *  - Revocation: the keys are the recovery-derived keys. Signing B out makes B drop its
 *    stored copy when it next starts, but does not rotate the keys: a B that already
 *    copied them keeps them. Resetting encryption rotates them.
 *  - A password-only attacker claiming 'recovery' trust for its own device: the server
 *    cannot observe a recovery-phrase unlock. The claim grants no keys.
 *  - Script that once runs in the page of a device keeping a pairing copy: it can read the
 *    encryption and backup keys out.
 *  - Metadata: the server sees that pairing happened, when, and both device labels.
 */

const SALT = new TextEncoder().encode('harmony-device-pairing-v1')
export const PAIRING_PREFIX = 'HMP:'
const BUNDLE_PREFIX = 'pb1.'

const MODE_NEW_DEVICE = 1
const MODE_APPROVER = 2
const SECRET_BYTES = 16
const FINGERPRINT_BYTES = 32
const ACCOUNT_TAG_BYTES = 8
const POINT_BYTES = 65
const IV_BYTES = 12
// 1 mode + 16 uuid + 32 fingerprint + 16 secret + 4 expiry
const NEW_DEVICE_CODE_BYTES = 69
// 1 mode + 8 account tag + 16 secret + 4 expiry
const APPROVER_CODE_BYTES = 29

/** Matches create_device_pairing_request. */
export const NEW_DEVICE_CODE_TTL_MS = 10 * 60_000
export const APPROVER_CODE_TTL_MS = 5 * 60_000
/** Tolerated clock difference between the two devices. */
export const CLOCK_SKEW_MS = 60_000

export type PairingErrorCode =
  | 'malformed'
  | 'expired'
  | 'wrong_account'
  | 'not_found'
  | 'not_pending'
  | 'not_pairing'
  | 'own_device'
  | 'fingerprint_mismatch'
  | 'code_mismatch'
  | 'proof_mismatch'
  | 'already_used'
  | 'bundle_invalid'
  | 'denied'
  | 'keys_unavailable'
  | 'keys_stale'

export class PairingError extends Error {
  readonly code: PairingErrorCode
  constructor(code: PairingErrorCode, message: string) {
    super(message)
    this.name = 'PairingError'
    this.code = code
  }
}

export interface NewDeviceCode {
  mode: 'new-device'
  requestId: string
  keyFingerprint: Uint8Array
  secret: Uint8Array
  /** ms since epoch, whole seconds */
  expiresAt: number
}

export interface ApproverCode {
  mode: 'approver'
  accountTag: Uint8Array
  secret: Uint8Array
  /** ms since epoch, whole seconds */
  expiresAt: number
}

export type PairingCode = NewDeviceCode | ApproverCode

/** Raw 32-byte AES keys, as deriveKeysFromMnemonic produces them. */
export interface PairingKeyMaterial {
  encryptionKey: Uint8Array
  backupKey: Uint8Array
}

export interface PairingKeys extends PairingKeyMaterial {
  userId: string
  approverDeviceId: string
}

/** The device_approval_requests columns the checks read. */
export interface PairingRequestRow {
  id: string
  status: string
  created_at: string
  expires_at?: string | null
  requesting_device_id: string
  requesting_label: string | null
  requesting_ecdh_public_key: string | null
  pairing_token_hash?: string | null
  pairing_proof?: string | null
}

// Encoding.

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url')
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  return base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new PairingError('malformed', 'Not a request id')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToUuid(b: Uint8Array): string {
  const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** Constant-time over equal lengths. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

// TypeScript types Uint8Array.buffer as ArrayBufferLike, which BufferSource rejects; a
// copy's buffer is an ArrayBuffer.
function buf(b: Uint8Array): ArrayBuffer {
  return b.slice().buffer as ArrayBuffer
}

// Codes.

export function looksLikePairingCode(text: string): boolean {
  return text.trim().startsWith(PAIRING_PREFIX)
}

export function encodePairingCode(code: PairingCode): string {
  const expiry = new Uint8Array(4)
  new DataView(expiry.buffer).setUint32(0, Math.floor(code.expiresAt / 1000))
  let body: Uint8Array
  if (code.mode === 'new-device') {
    if (code.keyFingerprint.length !== FINGERPRINT_BYTES || code.secret.length !== SECRET_BYTES) {
      throw new PairingError('malformed', 'Bad code fields')
    }
    body = concat(Uint8Array.of(MODE_NEW_DEVICE), uuidToBytes(code.requestId), code.keyFingerprint, code.secret, expiry)
  } else {
    if (code.accountTag.length !== ACCOUNT_TAG_BYTES || code.secret.length !== SECRET_BYTES) {
      throw new PairingError('malformed', 'Bad code fields')
    }
    body = concat(Uint8Array.of(MODE_APPROVER), code.accountTag, code.secret, expiry)
  }
  return PAIRING_PREFIX + bytesToBase64Url(body)
}

export function decodePairingCode(text: string): PairingCode {
  const t = text.trim()
  if (!t.startsWith(PAIRING_PREFIX)) throw new PairingError('malformed', 'Not a Harmony pairing code')
  let b: Uint8Array
  try {
    b = base64UrlToBytes(t.slice(PAIRING_PREFIX.length))
  } catch {
    throw new PairingError('malformed', 'Not a Harmony pairing code')
  }
  const readExpiry = (at: number) => new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0) * 1000
  if (b[0] === MODE_NEW_DEVICE && b.length === NEW_DEVICE_CODE_BYTES) {
    return {
      mode: 'new-device',
      requestId: bytesToUuid(b.slice(1, 17)),
      keyFingerprint: b.slice(17, 49),
      secret: b.slice(49, 65),
      expiresAt: readExpiry(65),
    }
  }
  if (b[0] === MODE_APPROVER && b.length === APPROVER_CODE_BYTES) {
    return {
      mode: 'approver',
      accountTag: b.slice(1, 9),
      secret: b.slice(9, 25),
      expiresAt: readExpiry(25),
    }
  }
  throw new PairingError('malformed', 'Unsupported pairing code')
}

export function isCodeExpired(expiresAt: number, now = Date.now()): boolean {
  return expiresAt + CLOCK_SKEW_MS <= now
}

// Derivations.

export function generateSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES))
}

async function hkdf(ikm: Uint8Array, info: string, bytes = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(SALT), info: buf(utf8(info)) },
    key,
    bytes * 8,
  )
  return new Uint8Array(bits)
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf(data)))
}

export async function keyFingerprint(publicRaw: Uint8Array): Promise<Uint8Array> {
  return sha256(publicRaw)
}

export async function accountTag(profileId: string): Promise<Uint8Array> {
  return (await sha256(utf8(`harmony-pair-account:${profileId}`))).slice(0, ACCOUNT_TAG_BYTES)
}

export async function deriveApprovalToken(secret: Uint8Array): Promise<string> {
  return bytesToBase64Url(await hkdf(secret, 'approval-token'))
}

/** Hex SHA-256 of the UTF-8 token; approve_device_request computes the same. */
export async function tokenHash(token: string): Promise<string> {
  return Array.from(await sha256(utf8(token)), x => x.toString(16).padStart(2, '0')).join('')
}

async function proofKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    buf(await hkdf(secret, 'proof')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function proofMessage(publicRaw: Uint8Array): Uint8Array {
  return concat(utf8('harmony-pair-proof-v1:'), publicRaw)
}

export async function computeProof(secret: Uint8Array, publicRaw: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await proofKey(secret), buf(proofMessage(publicRaw)))
  return bytesToBase64Url(new Uint8Array(sig))
}

export async function verifyProof(secret: Uint8Array, publicRaw: Uint8Array, proof: string): Promise<boolean> {
  let sig: Uint8Array
  try {
    sig = base64UrlToBytes(proof)
  } catch {
    return false
  }
  return crypto.subtle.verify('HMAC', await proofKey(secret), buf(sig), buf(proofMessage(publicRaw)))
}

// Bundle.

export async function generatePairingKeyPair(): Promise<{ privateKey: CryptoKey; publicRaw: Uint8Array }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  return { privateKey: kp.privateKey, publicRaw }
}

async function importPoint(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== POINT_BYTES || raw[0] !== 4) throw new PairingError('malformed', 'Not a P-256 point')
  return crypto.subtle.importKey('raw', buf(raw), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
}

async function bundleKey(
  privateKey: CryptoKey,
  peerPublicRaw: Uint8Array,
  secret: Uint8Array,
  requestId: string,
): Promise<CryptoKey> {
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPoint(peerPublicRaw) }, privateKey, 256),
  )
  const keyBytes = await hkdf(concat(shared, await hkdf(secret, 'bundle')), `bundle-key:${requestId}`)
  return crypto.subtle.importKey('raw', buf(keyBytes), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function bundleAad(requestId: string, recipientRaw: Uint8Array, ephemeralRaw: Uint8Array): Uint8Array {
  return concat(utf8(`harmony-pair-bundle-v1:${requestId}`), recipientRaw, ephemeralRaw)
}

export async function sealBundle(args: {
  secret: Uint8Array
  requestId: string
  recipientPublicRaw: Uint8Array
  keys: PairingKeys
}): Promise<string> {
  const eph = await generatePairingKeyPair()
  const key = await bundleKey(eph.privateKey, args.recipientPublicRaw, args.secret, args.requestId)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const plaintext = utf8(JSON.stringify({
    v: 1,
    u: args.keys.userId,
    d: args.keys.approverDeviceId,
    e: bytesToBase64Url(args.keys.encryptionKey),
    b: bytesToBase64Url(args.keys.backupKey),
  }))
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: buf(bundleAad(args.requestId, args.recipientPublicRaw, eph.publicRaw)) },
    key,
    buf(plaintext),
  ))
  return BUNDLE_PREFIX + bytesToBase64Url(concat(eph.publicRaw, iv, ct))
}

export async function openBundle(args: {
  secret: Uint8Array
  requestId: string
  privateKey: CryptoKey
  publicRaw: Uint8Array
  bundle: string
}): Promise<PairingKeys> {
  const fail = () => new PairingError('bundle_invalid', 'The keys from the other device did not verify')
  if (!args.bundle.startsWith(BUNDLE_PREFIX)) throw fail()
  let raw: Uint8Array
  try {
    raw = base64UrlToBytes(args.bundle.slice(BUNDLE_PREFIX.length))
  } catch {
    throw fail()
  }
  if (raw.length <= POINT_BYTES + IV_BYTES + 16) throw fail()
  const ephRaw = raw.slice(0, POINT_BYTES)
  const iv = raw.slice(POINT_BYTES, POINT_BYTES + IV_BYTES)
  const ct = raw.slice(POINT_BYTES + IV_BYTES)
  let plain: Uint8Array
  try {
    const key = await bundleKey(args.privateKey, ephRaw, args.secret, args.requestId)
    plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf(iv), additionalData: buf(bundleAad(args.requestId, args.publicRaw, ephRaw)) },
      key,
      buf(ct),
    ))
  } catch {
    throw fail()
  }
  let j: Record<string, unknown>
  try {
    j = JSON.parse(new TextDecoder().decode(plain))
  } catch {
    throw fail()
  }
  if (j.v !== 1 || typeof j.u !== 'string' || typeof j.d !== 'string') throw fail()
  const key32 = (v: unknown): Uint8Array => {
    if (typeof v !== 'string') throw fail()
    const b = base64UrlToBytes(v)
    if (b.length !== 32) throw fail()
    return b
  }
  return {
    userId: j.u,
    approverDeviceId: j.d,
    encryptionKey: key32(j.e),
    backupKey: key32(j.b),
  }
}

// Sessions.

/** The new device's side of one attempt. Opens one bundle, then drops its private key. */
export class NewDevicePairingSession {
  private privateKey: CryptoKey | null
  private opened = false

  private constructor(
    readonly secret: Uint8Array,
    privateKey: CryptoKey,
    readonly publicRaw: Uint8Array,
  ) {
    this.privateKey = privateKey
  }

  static async create(secret: Uint8Array = generateSecret()): Promise<NewDevicePairingSession> {
    if (secret.length !== SECRET_BYTES) throw new PairingError('malformed', 'Bad secret')
    const kp = await generatePairingKeyPair()
    return new NewDevicePairingSession(secret, kp.privateKey, kp.publicRaw)
  }

  get publicKeyBase64(): string {
    return bytesToBase64(this.publicRaw)
  }

  async tokenHash(): Promise<string> {
    return tokenHash(await deriveApprovalToken(this.secret))
  }

  async proof(): Promise<string> {
    return computeProof(this.secret, this.publicRaw)
  }

  async code(requestId: string, expiresAt: number): Promise<NewDeviceCode> {
    return {
      mode: 'new-device',
      requestId,
      keyFingerprint: await keyFingerprint(this.publicRaw),
      secret: this.secret,
      expiresAt,
    }
  }

  get spent(): boolean {
    return this.opened || !this.privateKey
  }

  /** A bundle that fails to verify leaves the session usable. */
  async open(requestId: string, bundle: string): Promise<PairingKeys> {
    if (this.opened || !this.privateKey) {
      throw new PairingError('already_used', 'This pairing code was already used')
    }
    const keys = await openBundle({
      secret: this.secret,
      requestId,
      privateKey: this.privateKey,
      publicRaw: this.publicRaw,
      bundle,
    })
    this.opened = true
    this.privateKey = null
    return keys
  }

  discard(): void {
    this.privateKey = null
  }
}

/** The approver's side of a code it shows. Accepts one proof. */
export class ApproverCodeSession {
  private matchedRequestId: string | null = null

  private constructor(
    readonly secret: Uint8Array,
    readonly tag: Uint8Array,
    readonly expiresAt: number,
    readonly createdAt: number,
  ) {}

  static async create(profileId: string, now = Date.now()): Promise<ApproverCodeSession> {
    const expiresAt = Math.floor((now + APPROVER_CODE_TTL_MS) / 1000) * 1000
    return new ApproverCodeSession(generateSecret(), await accountTag(profileId), expiresAt, now)
  }

  code(): ApproverCode {
    return { mode: 'approver', accountTag: this.tag, secret: this.secret, expiresAt: this.expiresAt }
  }

  text(): string {
    return encodePairingCode(this.code())
  }

  expired(now = Date.now()): boolean {
    return this.expiresAt <= now
  }

  /**
   * True when the row answers this code. A second answering row is an error: the code was
   * scanned twice, and no request is approved from it.
   */
  async match(row: PairingRequestRow, now = Date.now()): Promise<boolean> {
    if (this.matchedRequestId === row.id) return true
    if (!row.pairing_proof || !row.requesting_ecdh_public_key || !row.pairing_token_hash) return false
    if (row.status !== 'pending') return false
    let publicRaw: Uint8Array
    try {
      publicRaw = base64ToBytes(row.requesting_ecdh_public_key)
    } catch {
      return false
    }
    if (!(await verifyProof(this.secret, publicRaw, row.pairing_proof))) return false
    if (row.pairing_token_hash !== (await tokenHash(await deriveApprovalToken(this.secret)))) return false
    if (this.matchedRequestId) {
      throw new PairingError('already_used', 'This code was scanned by more than one device')
    }
    if (this.expired(now)) throw new PairingError('expired', 'This code expired')
    this.matchedRequestId = row.id
    return true
  }
}

/**
 * The approver's check of a scanned new-device code against the row the server returns for
 * its request id. Returns the requesting public key.
 */
export async function verifyScannedRequest(
  code: NewDeviceCode,
  row: PairingRequestRow | null,
  opts: { ownDeviceId: string; now?: number },
): Promise<Uint8Array> {
  const now = opts.now ?? Date.now()
  if (isCodeExpired(code.expiresAt, now)) throw new PairingError('expired', 'This code expired')
  if (!row) throw new PairingError('not_found', 'No sign-in request for this code on your account')
  if (row.status === 'expired' || (row.expires_at && Date.parse(row.expires_at) <= now)) {
    throw new PairingError('expired', 'This code expired')
  }
  if (row.status !== 'pending') throw new PairingError('not_pending', 'This code was already used')
  if (row.requesting_device_id === opts.ownDeviceId) {
    throw new PairingError('own_device', 'This code was shown by this device')
  }
  if (!row.requesting_ecdh_public_key || !row.pairing_token_hash) {
    throw new PairingError('not_pairing', 'This request does not accept keys')
  }
  let publicRaw: Uint8Array
  try {
    publicRaw = base64ToBytes(row.requesting_ecdh_public_key)
  } catch {
    throw new PairingError('fingerprint_mismatch', 'The device key on the server does not match the code')
  }
  if (!equalBytes(await keyFingerprint(publicRaw), code.keyFingerprint)) {
    throw new PairingError('fingerprint_mismatch', 'The device key on the server does not match the code')
  }
  if (row.pairing_token_hash !== (await tokenHash(await deriveApprovalToken(code.secret)))) {
    throw new PairingError('code_mismatch', 'The request on the server does not match the code')
  }
  return publicRaw
}
