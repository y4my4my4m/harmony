import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { createECDH, createPrivateKey, randomBytes, sign } from 'node:crypto'
import { createRequire } from 'node:module'

// The relay as an instance meets it: web-push builds the request exactly as the backend's
// UnifiedPush delivery does, the relay forwards the ciphertext to FCM unread, and the device's
// keys decrypt what FCM carries.

const require = createRequire(import.meta.url)
const webPush = require('web-push')
const ece = require(require.resolve('http_ece', { paths: [require.resolve('web-push')] }))

const relayConfig = vi.hoisted(() => ({ INSTANCE_DOMAIN: 'relay.test', PUSH_RELAY_ENABLED: true }))
vi.mock('../config/index.js', () => ({ default: relayConfig, config: relayConfig }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const limits = vi.hoisted(() => ({ sender: true, token: true, keys: [] as string[] }))
vi.mock('../middleware/rateLimit.js', () => ({
  pushRelaySenderLimit: async (res: any, key: string) => {
    limits.keys.push(`sender:${key}`)
    if (!limits.sender) res.status(429).json({ error: 'sender' })
    return limits.sender
  },
  pushRelayTokenLimit: async (res: any, key: string) => {
    limits.keys.push(`token:${key}`)
    if (!limits.token) res.status(429).json({ error: 'token' })
    return limits.token
  },
}))

const sent: Array<{ token: string; data: Record<string, string>; options: any }> = []
const fcm = vi.hoisted(() => ({ configured: true, result: { ok: true } as any }))
vi.mock('../services/PushNotificationService.js', () => ({
  PushNotificationService: {
    getFcmSender: () => ({
      isConfigured: () => fcm.configured,
      send: async (token: string, data: Record<string, string>, options: any) => {
        sent.push({ token, data, options })
        return fcm.result
      },
    }),
  },
}))

const { default: relay, parseVapidAuthorization, vapidProblem, MAX_BODY_BYTES } = await import('../routes/pushRelay.js')

const app = () => {
  const a = express()
  a.use(express.json())
  a.use('/push/relay', relay)
  return a
}

const TOKEN = 'dGVzdC10b2tlbg:APA91bH' + 'x'.repeat(140)
const vapid = webPush.generateVAPIDKeys()

/** The device's UnifiedPush keys, as the connector generates them. */
function deviceKeys() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  const b64 = (b: Buffer) => b.toString('base64url')
  return { ecdh, auth, sub: { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) } }
}

function request(payload: string, opts: { audience?: string; token?: string; ttl?: number; urgency?: string; topic?: string } = {}) {
  const device = deviceKeys()
  const endpoint = `https://${opts.audience ?? 'relay.test'}/push/relay/fcm/${opts.token ?? TOKEN}`
  const details = webPush.generateRequestDetails(
    { endpoint, keys: device.sub },
    payload,
    {
      vapidDetails: { subject: 'mailto:admin@instance.test', publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: opts.ttl ?? 60,
      contentEncoding: 'aes128gcm',
      ...(opts.urgency ? { urgency: opts.urgency } : {}),
      ...(opts.topic ? { topic: opts.topic } : {}),
    },
  )
  return { details, device, path: `/push/relay/fcm/${opts.token ?? TOKEN}` }
}

const post = (details: any, path: string) => {
  let r = supertest(app()).post(path)
  for (const [k, v] of Object.entries(details.headers)) r = r.set(k, String(v))
  return r.send(details.body)
}

beforeEach(() => {
  sent.length = 0
  limits.sender = true
  limits.token = true
  limits.keys.length = 0
  fcm.configured = true
  fcm.result = { ok: true }
  relayConfig.PUSH_RELAY_ENABLED = true
})

describe('push relay', () => {
  it('forwards the ciphertext to FCM, which the device decrypts', async () => {
    const payload = JSON.stringify({ kind: 'notification', title: 'Alice', body: 'hello from elsewhere' })
    const { details, device, path } = request(payload, { urgency: 'high', ttl: 120, topic: 'chan-1' })
    const res = await post(details, path)

    expect(res.status).toBe(201)
    expect(sent).toHaveLength(1)
    expect(sent[0].token).toBe(TOKEN)
    expect(Object.keys(sent[0].data)).toEqual(['wp'])
    expect(sent[0].options).toEqual({ priority: 'high', ttlSeconds: 120, collapseKey: 'chan-1' })
    const ciphertext = Buffer.from(sent[0].data.wp, 'base64url')
    expect(ciphertext.equals(details.body)).toBe(true)
    expect(ciphertext.toString('utf8')).not.toContain('hello from elsewhere')
    const clear = ece.decrypt(ciphertext, { version: 'aes128gcm', privateKey: device.ecdh, authSecret: device.auth.toString('base64url') })
    expect(clear.toString('utf8')).toBe(payload)
  })

  it('fits the largest message into one FCM data message', async () => {
    const { details, path } = request('x'.repeat(MAX_BODY_BYTES - 103))
    expect(details.body.length).toBe(MAX_BODY_BYTES)
    expect((await post(details, path)).status).toBe(201)
    expect(Buffer.byteLength('wp') + Buffer.byteLength(sent[0].data.wp)).toBeLessThanOrEqual(4096)
    const { details: big, path: bigPath } = request('x'.repeat(MAX_BODY_BYTES - 102))
    expect((await post(big, bigPath)).status).toBe(413)
  })

  it('counts senders by VAPID key and devices by token, and answers 429 past either', async () => {
    const { details, path } = request('{}')
    await post(details, path)
    expect(limits.keys.map((k) => k.split(':')[0])).toEqual(['sender', 'token'])
    expect(limits.keys.join(' ')).not.toContain(TOKEN)
    limits.token = false
    expect((await post(request('{}').details, path)).status).toBe(429)
    expect(sent).toHaveLength(1)
  })

  it('refuses a sender without VAPID, for another audience, or not aes128gcm', async () => {
    const { details, path } = request('{}')
    const noAuth = { ...details, headers: { ...details.headers } }
    delete noAuth.headers.Authorization
    expect((await post(noAuth, path)).status).toBe(401)

    const other = request('{}', { audience: 'elsewhere.test' })
    const res = await post(other.details, other.path)
    expect(res.status).toBe(401)
    expect(res.body.error).toContain('aud')

    const aesgcm = { ...details, headers: { ...details.headers, 'Content-Encoding': 'aesgcm' } }
    expect((await post(aesgcm, path)).status).toBe(415)
    expect(sent).toHaveLength(0)
  })

  it('answers 404 when off, unconfigured or not a token', async () => {
    relayConfig.PUSH_RELAY_ENABLED = false
    const { details, path } = request('{}')
    expect((await post(details, path)).status).toBe(404)
    relayConfig.PUSH_RELAY_ENABLED = true
    fcm.configured = false
    expect((await post(request('{}').details, path)).status).toBe(404)
    fcm.configured = true
    const bad = request('{}', { token: 'short' })
    expect((await post(bad.details, bad.path)).status).toBe(404)
    expect(sent).toHaveLength(0)
  })

  it('maps FCM answers: a dead token is 410 Gone, a quota 429, anything else 502', async () => {
    fcm.result = { ok: false, prune: true, reason: 'UNREGISTERED', status: 404 }
    const a = request('{}')
    expect((await post(a.details, a.path)).status).toBe(410)
    fcm.result = { ok: false, prune: false, reason: 'QUOTA_EXCEEDED', status: 429 }
    const b = request('{}')
    const quota = await post(b.details, b.path)
    expect(quota.status).toBe(429)
    expect(quota.headers['retry-after']).toBe('60')
    fcm.result = { ok: false, prune: false, reason: 'INTERNAL', status: 500 }
    const c = request('{}')
    expect((await post(c.details, c.path)).status).toBe(502)
  })

  it('clamps TTL and keeps only a Topic FCM accepts as collapse key', async () => {
    const a = request('{}', { ttl: 99_999_999 })
    a.details.headers.Topic = 'bad topic!'
    await post(a.details, a.path)
    expect(sent[0].options).toEqual({ priority: 'normal', ttlSeconds: 28 * 24 * 3600 })
  })
})

describe('VAPID checks', () => {
  const now = Math.floor(Date.now() / 1000)
  const headersFor = (audience: string, exp?: number) =>
    webPush.getVapidHeaders(audience, 'mailto:a@b.test', vapid.publicKey, vapid.privateKey, 'aes128gcm', exp)

  it('accepts a fresh JWT for this audience and names every failure', () => {
    const ok = parseVapidAuthorization(headersFor('https://relay.test').Authorization)!
    expect(vapidProblem(ok.t, ok.k, 'https://relay.test', now)).toBeNull()
    expect(vapidProblem(ok.t, ok.k, 'https://other.test', now)).toBe('aud is not this relay')
    expect(vapidProblem(ok.t, ok.k, 'https://relay.test', now + 13 * 3600)).toBe('expired')

    const otherKey = webPush.generateVAPIDKeys().publicKey
    expect(vapidProblem(ok.t, otherKey, 'https://relay.test', now)).toBe('bad signature')
    const [h, c, s] = ok.t.split('.')
    // A middle character: the last one of an ES256 signature carries padding bits.
    const flipped = `${s.slice(0, 10)}${s[10] === 'A' ? 'B' : 'A'}${s.slice(11)}`
    expect(vapidProblem(`${h}.${c}.${flipped}`, ok.k, 'https://relay.test', now)).toBe('bad signature')
    expect(vapidProblem('a.b', ok.k, 'https://relay.test', now)).toBe('malformed JWT')
    expect(vapidProblem(ok.t, 'AAAA', 'https://relay.test', now)).toBe('k is not an uncompressed P-256 key')

    // web-push refuses to sign past a day; signed here with the same key.
    const raw = (b64: string) => Buffer.from(b64, 'base64url')
    const pub = raw(vapid.publicKey)
    const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: vapid.privateKey, x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' })
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: 'https://relay.test', exp: now + 3 * 24 * 3600, sub: 'mailto:a@b.test' })}`
    const sig = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    expect(vapidProblem(`${unsigned}.${sig}`, vapid.publicKey, 'https://relay.test', now)).toBe('exp further than a day')
  })

  it('reads only the vapid scheme', () => {
    expect(parseVapidAuthorization('Bearer x')).toBeNull()
    expect(parseVapidAuthorization('vapid t=a.b.c')).toBeNull()
    expect(parseVapidAuthorization('vapid t=a.b.c, k=K')).toEqual({ t: 'a.b.c', k: 'K' })
  })
})
