import { describe, it, expect } from 'vitest'
import {
  ApproverCodeSession,
  NewDevicePairingSession,
  PairingError,
  accountTag,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  computeProof,
  decodePairingCode,
  deriveApprovalToken,
  encodePairingCode,
  generatePairingKeyPair,
  generateSecret,
  isCodeExpired,
  sealBundle,
  tokenHash,
  verifyProof,
  verifyScannedRequest,
  type NewDeviceCode,
  type PairingKeys,
  type PairingRequestRow,
} from '../devicePairing'

const REQUEST_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)

function keys(): PairingKeys {
  return {
    userId: '11111111-0000-0000-0000-000000000001',
    approverDeviceId: 'device-a',
    encryptionKey: crypto.getRandomValues(new Uint8Array(32)),
    backupKey: crypto.getRandomValues(new Uint8Array(32)),
  }
}

async function pendingRow(session: NewDevicePairingSession, over: Partial<PairingRequestRow> = {}): Promise<PairingRequestRow> {
  return {
    id: REQUEST_ID,
    status: 'pending',
    created_at: new Date(NOW - 30_000).toISOString(),
    expires_at: new Date(NOW + 9 * 60_000).toISOString(),
    requesting_device_id: 'device-b',
    requesting_label: 'Firefox on Linux',
    requesting_ecdh_public_key: session.publicKeyBase64,
    pairing_token_hash: await session.tokenHash(),
    pairing_proof: null,
    ...over,
  }
}

async function expectPairingError(p: Promise<unknown>, code: string) {
  const err = await p.then(() => null, e => e)
  expect(err).toBeInstanceOf(PairingError)
  expect((err as PairingError).code).toBe(code)
}

describe('pairing codes', () => {
  it('round-trips a new-device code', async () => {
    const session = await NewDevicePairingSession.create()
    const code = await session.code(REQUEST_ID, NOW + 600_000)
    const text = encodePairingCode(code)
    expect(text.startsWith('HMP:')).toBe(true)
    expect(text.length).toBeLessThan(100)
    const back = decodePairingCode(text) as NewDeviceCode
    expect(back.mode).toBe('new-device')
    expect(back.requestId).toBe(REQUEST_ID)
    expect(Array.from(back.keyFingerprint)).toEqual(Array.from(code.keyFingerprint))
    expect(Array.from(back.secret)).toEqual(Array.from(session.secret))
    expect(back.expiresAt).toBe(NOW + 600_000)
  })

  it('round-trips an approver code', async () => {
    const session = await ApproverCodeSession.create('profile-1', NOW)
    const back = decodePairingCode(session.text())
    expect(back.mode).toBe('approver')
    if (back.mode !== 'approver') return
    expect(Array.from(back.accountTag)).toEqual(Array.from(await accountTag('profile-1')))
    expect(Array.from(back.secret)).toEqual(Array.from(session.secret))
    expect(back.expiresAt).toBe(session.expiresAt)
  })

  it('refuses text that is not a pairing code', () => {
    for (const text of ['', 'hello', 'HMP:', 'HMP:!!!', 'HMP:AQID', btoa(JSON.stringify({ v: 1, m: 'a b c' }))]) {
      expect(() => decodePairingCode(text)).toThrow(PairingError)
    }
  })

  it('refuses an unknown mode byte', async () => {
    const session = await NewDevicePairingSession.create()
    const text = encodePairingCode(await session.code(REQUEST_ID, NOW))
    const bytes = base64UrlToBytes(text.slice(4))
    bytes[0] = 9
    const forged = 'HMP:' + bytesToBase64Url(bytes)
    expect(() => decodePairingCode(forged)).toThrow(PairingError)
  })

  it('treats a code as expired after its expiry plus skew', () => {
    expect(isCodeExpired(NOW, NOW)).toBe(false)
    expect(isCodeExpired(NOW, NOW + 59_000)).toBe(false)
    expect(isCodeExpired(NOW, NOW + 61_000)).toBe(true)
  })
})

describe('derivations', () => {
  it('hashes a token as hex SHA-256 of its UTF-8 text, as the server does', async () => {
    expect(await tokenHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('derives a 43-character base64url token, stable per secret', async () => {
    const s = generateSecret()
    const t = await deriveApprovalToken(s)
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await deriveApprovalToken(s)).toBe(t)
    expect(await deriveApprovalToken(generateSecret())).not.toBe(t)
  })

  it('verifies a proof only for the key it was made for', async () => {
    const s = generateSecret()
    const a = await generatePairingKeyPair()
    const b = await generatePairingKeyPair()
    const proof = await computeProof(s, a.publicRaw)
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await verifyProof(s, a.publicRaw, proof)).toBe(true)
    expect(await verifyProof(s, b.publicRaw, proof)).toBe(false)
    expect(await verifyProof(generateSecret(), a.publicRaw, proof)).toBe(false)
    expect(await verifyProof(s, a.publicRaw, 'not a proof')).toBe(false)
  })

  it('matches the formats the database accepts', async () => {
    const session = await NewDevicePairingSession.create()
    expect(session.publicKeyBase64).toMatch(/^B[A-Za-z0-9+/]{86}=$/)
    expect(await session.tokenHash()).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('approver check of a scanned code', () => {
  it('accepts the row whose key matches the fingerprint', async () => {
    const session = await NewDevicePairingSession.create()
    const code = await session.code(REQUEST_ID, NOW + 600_000)
    const raw = await verifyScannedRequest(code, await pendingRow(session), { ownDeviceId: 'device-a', now: NOW })
    expect(bytesToBase64(raw)).toBe(session.publicKeyBase64)
  })

  it('refuses a row whose key the server substituted', async () => {
    const session = await NewDevicePairingSession.create()
    const attacker = await NewDevicePairingSession.create(session.secret)
    const code = await session.code(REQUEST_ID, NOW + 600_000)
    const row = await pendingRow(session, { requesting_ecdh_public_key: attacker.publicKeyBase64 })
    await expectPairingError(verifyScannedRequest(code, row, { ownDeviceId: 'device-a', now: NOW }), 'fingerprint_mismatch')
  })

  it('refuses a row whose token hash belongs to another code', async () => {
    const session = await NewDevicePairingSession.create()
    const other = await NewDevicePairingSession.create()
    const code = await session.code(REQUEST_ID, NOW + 600_000)
    const row = await pendingRow(session, { pairing_token_hash: await other.tokenHash() })
    await expectPairingError(verifyScannedRequest(code, row, { ownDeviceId: 'device-a', now: NOW }), 'code_mismatch')
  })

  it('refuses expired codes and rows', async () => {
    const session = await NewDevicePairingSession.create()
    const code = await session.code(REQUEST_ID, NOW - 120_000)
    await expectPairingError(verifyScannedRequest(code, await pendingRow(session), { ownDeviceId: 'a', now: NOW }), 'expired')
    const fresh = await session.code(REQUEST_ID, NOW + 600_000)
    const lapsed = await pendingRow(session, { expires_at: new Date(NOW - 1000).toISOString() })
    await expectPairingError(verifyScannedRequest(fresh, lapsed, { ownDeviceId: 'a', now: NOW }), 'expired')
    const marked = await pendingRow(session, { status: 'expired' })
    await expectPairingError(verifyScannedRequest(fresh, marked, { ownDeviceId: 'a', now: NOW }), 'expired')
  })

  it('refuses a used request, a missing row, a plain request and its own code', async () => {
    const session = await NewDevicePairingSession.create()
    const code = await session.code(REQUEST_ID, NOW + 600_000)
    const opts = { ownDeviceId: 'device-a', now: NOW }
    await expectPairingError(verifyScannedRequest(code, await pendingRow(session, { status: 'approved' }), opts), 'not_pending')
    await expectPairingError(verifyScannedRequest(code, null, opts), 'not_found')
    await expectPairingError(verifyScannedRequest(code, await pendingRow(session, { pairing_token_hash: null }), opts), 'not_pairing')
    await expectPairingError(
      verifyScannedRequest(code, await pendingRow(session), { ownDeviceId: 'device-b', now: NOW }),
      'own_device',
    )
  })
})

describe('sealed bundle', () => {
  it('opens on the new device with the same keys', async () => {
    const session = await NewDevicePairingSession.create()
    const k = keys()
    const bundle = await sealBundle({ secret: session.secret, requestId: REQUEST_ID, recipientPublicRaw: session.publicRaw, keys: k })
    expect(bundle.startsWith('pb1.')).toBe(true)
    expect(bundle.length).toBeLessThan(4096)
    const got = await session.open(REQUEST_ID, bundle)
    expect(got.userId).toBe(k.userId)
    expect(got.approverDeviceId).toBe('device-a')
    expect(Array.from(got.encryptionKey)).toEqual(Array.from(k.encryptionKey))
    expect(Array.from(got.backupKey)).toEqual(Array.from(k.backupKey))
  })

  it('is single use', async () => {
    const session = await NewDevicePairingSession.create()
    const bundle = await sealBundle({ secret: session.secret, requestId: REQUEST_ID, recipientPublicRaw: session.publicRaw, keys: keys() })
    await session.open(REQUEST_ID, bundle)
    expect(session.spent).toBe(true)
    await expectPairingError(session.open(REQUEST_ID, bundle), 'already_used')
  })

  it('refuses a bundle sealed without the QR secret', async () => {
    const session = await NewDevicePairingSession.create()
    const forged = await sealBundle({ secret: generateSecret(), requestId: REQUEST_ID, recipientPublicRaw: session.publicRaw, keys: keys() })
    await expectPairingError(session.open(REQUEST_ID, forged), 'bundle_invalid')
    expect(session.spent).toBe(false)
  })

  it('refuses a bundle for another request or with a flipped byte', async () => {
    const session = await NewDevicePairingSession.create()
    const bundle = await sealBundle({ secret: session.secret, requestId: REQUEST_ID, recipientPublicRaw: session.publicRaw, keys: keys() })
    await expectPairingError(session.open('7c9e6679-7425-40de-944b-e07fc1f90ae7', bundle), 'bundle_invalid')
    const i = bundle.length - 5
    const flipped = bundle.slice(0, i) + (bundle[i] === 'A' ? 'B' : 'A') + bundle.slice(i + 1)
    await expectPairingError(session.open(REQUEST_ID, flipped), 'bundle_invalid')
    await expectPairingError(session.open(REQUEST_ID, 'pb1.AAAA'), 'bundle_invalid')
    await expectPairingError(session.open(REQUEST_ID, 'garbage'), 'bundle_invalid')
  })

  it('cannot be opened by a device that did not make the request', async () => {
    const session = await NewDevicePairingSession.create()
    const other = await NewDevicePairingSession.create(session.secret)
    const bundle = await sealBundle({ secret: session.secret, requestId: REQUEST_ID, recipientPublicRaw: session.publicRaw, keys: keys() })
    await expectPairingError(other.open(REQUEST_ID, bundle), 'bundle_invalid')
  })
})

describe('approver code session', () => {
  async function answeringRow(approver: ApproverCodeSession, id = REQUEST_ID): Promise<{ row: PairingRequestRow; device: NewDevicePairingSession }> {
    const device = await NewDevicePairingSession.create(approver.secret)
    const row: PairingRequestRow = {
      id,
      status: 'pending',
      created_at: new Date(NOW).toISOString(),
      expires_at: new Date(NOW + 600_000).toISOString(),
      requesting_device_id: 'device-b',
      requesting_label: 'Chrome on Android',
      requesting_ecdh_public_key: device.publicKeyBase64,
      pairing_token_hash: await device.tokenHash(),
      pairing_proof: await device.proof(),
    }
    return { row, device }
  }

  it('matches the request that answered its code', async () => {
    const approver = await ApproverCodeSession.create('profile-1', NOW)
    const { row } = await answeringRow(approver)
    expect(await approver.match(row, NOW)).toBe(true)
    expect(await approver.match(row, NOW)).toBe(true)
  })

  it('ignores a request whose proof binds another key', async () => {
    const approver = await ApproverCodeSession.create('profile-1', NOW)
    const { row } = await answeringRow(approver)
    const intruder = await NewDevicePairingSession.create()
    expect(await approver.match({ ...row, requesting_ecdh_public_key: intruder.publicKeyBase64 }, NOW)).toBe(false)
    expect(await approver.match({ ...row, pairing_proof: await intruder.proof() }, NOW)).toBe(false)
    expect(await approver.match({ ...row, status: 'approved' }, NOW)).toBe(false)
  })

  it('accepts one answer per code', async () => {
    const approver = await ApproverCodeSession.create('profile-1', NOW)
    const first = await answeringRow(approver, REQUEST_ID)
    const second = await answeringRow(approver, '7c9e6679-7425-40de-944b-e07fc1f90ae7')
    expect(await approver.match(first.row, NOW)).toBe(true)
    await expectPairingError(approver.match(second.row, NOW), 'already_used')
  })

  it('refuses an answer after the code expired', async () => {
    const approver = await ApproverCodeSession.create('profile-1', NOW)
    const { row } = await answeringRow(approver)
    await expectPairingError(approver.match(row, approver.expiresAt + 1), 'expired')
  })
})
