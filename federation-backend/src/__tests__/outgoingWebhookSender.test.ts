import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import dns from 'node:dns'
import crypto from 'node:crypto'

// Outgoing webhook deliveries (migration 20261028600001, services/OutgoingWebhookSender.ts).

vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
const cfg = vi.hoisted(() => ({ OUTGOING_WEBHOOKS_ALLOW_LOOPBACK: true, INSTANCE_DOMAIN: 'harmony.test' }))
vi.mock('../config/index.js', () => ({ default: cfg, config: cfg }))
const rpc = vi.hoisted(() => vi.fn())
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({ rpc }) }))

const { signWebhook, refusedWebhookUrl, guardedLookup, sendDelivery, deliverOutgoingWebhook } =
  await import('../services/OutgoingWebhookSender.js')

let server: http.Server
let base = ''
let received: Array<{ headers: http.IncomingHttpHeaders; body: string; url: string }> = []
let answer = 204

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      received.push({ headers: req.headers, body, url: req.url ?? '' })
      if (req.url === '/moved') {
        res.writeHead(302, { Location: `${base}/elsewhere` }).end()
        return
      }
      res.writeHead(answer).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://localhost:${(server.address() as { port: number }).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
beforeEach(() => {
  received = []
  answer = 204
  rpc.mockReset()
})

const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`
const delivery = (url: string) => ({
  delivery_id: '9f0e2d4c-0000-4000-8000-000000000001', url, secret: SECRET, event: 'MESSAGE_CREATE',
  payload: { id: 'm1', server_id: 's1' }, created_at: '2026-10-24T09:00:00.000Z',
})

describe('signWebhook', () => {
  it('matches the Standard Webhooks reference signature', () => {
    expect(signWebhook('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}'))
      .toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=')
  })
})

describe('refusedWebhookUrl', () => {
  it('takes https, and http to localhost only when loopback is allowed', () => {
    expect(refusedWebhookUrl('https://hooks.example/x', false)).toBeNull()
    expect(refusedWebhookUrl('http://hooks.example/x', true)).toBe('not https')
    expect(refusedWebhookUrl('http://localhost:9/x', false)).toBe('not https')
    expect(refusedWebhookUrl('http://localhost:9/x', true)).toBeNull()
    expect(refusedWebhookUrl('https://u:p@hooks.example/', false)).toBe('credentials in the URL')
    expect(refusedWebhookUrl('nonsense', false)).toBe('not a URL')
  })

  it('refuses an internal IP literal, which no lookup sees', () => {
    for (const url of [
      'https://127.0.0.1/x', 'https://10.0.0.5:8443/x', 'https://169.254.169.254/latest',
      'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://0x7f000001/x', 'https://[fd00::1]/x',
    ]) expect(refusedWebhookUrl(url, false), url).toBe('an internal address')
    expect(refusedWebhookUrl('https://93.184.216.34/x', false)).toBeNull()
    for (const url of ['https://1572395042/x', 'https://exa%6Dple.com/x', 'https://ｅxample.com/x', 'https://[2001:DB8:0::1]/x']) {
      expect(refusedWebhookUrl(url, false), url).toBe('host not in canonical form')
    }
    expect(refusedWebhookUrl('https://Hooks.Example:8443/x', false)).toBeNull()
    expect(refusedWebhookUrl('https://[2001:db8::1]/x', false)).toBeNull()
    expect(refusedWebhookUrl('http://127.0.0.1:9/x', true)).toBeNull()
  })
})

describe('guardedLookup', () => {
  const resolveTo = (address: string, family = 4) =>
    vi.spyOn(dns, 'lookup').mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) =>
      cb(null, [{ address, family }])) as any)
  const lookup = (allowLoopback: boolean) => new Promise<{ err: any; address: unknown }>((resolve) =>
    guardedLookup(allowLoopback)('hooks.example', {}, (err, address) => resolve({ err, address })))

  it('refuses a name resolving to a private, link-local or loopback address at connect time', async () => {
    for (const address of ['10.0.0.5', '169.254.169.254', '127.0.0.1', '::1', 'fd00::1']) {
      const spy = resolveTo(address, address.includes(':') ? 6 : 4)
      expect((await lookup(false)).err?.code).toBe('EADDRNOTAVAIL')
      spy.mockRestore()
    }
  })

  it('passes a public address, and loopback when allowed for tests', async () => {
    let spy = resolveTo('93.184.216.34')
    expect(await lookup(false)).toEqual({ err: null, address: '93.184.216.34' })
    spy.mockRestore()
    spy = resolveTo('127.0.0.1')
    expect((await lookup(true)).err).toBeNull()
    spy.mockRestore()
  })
})

describe('sendDelivery', () => {
  it('posts the event signed as Standard Webhooks', async () => {
    const outcome = await sendDelivery(delivery(`${base}/hook`), Date.parse('2026-10-24T09:00:05Z'))
    expect(outcome).toEqual({ ok: true, status: 204, error: null })
    const [hit] = received
    expect(JSON.parse(hit.body)).toEqual({ type: 'MESSAGE_CREATE', timestamp: '2026-10-24T09:00:00.000Z', data: { id: 'm1', server_id: 's1' } })
    expect(hit.headers['webhook-id']).toBe('9f0e2d4c-0000-4000-8000-000000000001')
    expect(hit.headers['webhook-timestamp']).toBe(String(Date.parse('2026-10-24T09:00:05Z') / 1000))
    const expected = crypto.createHmac('sha256', Buffer.alloc(32, 7))
      .update(`${hit.headers['webhook-id']}.${hit.headers['webhook-timestamp']}.${hit.body}`).digest('base64')
    expect(hit.headers['webhook-signature']).toBe(`v1,${expected}`)
  })

  it('counts a redirect as a failure and does not follow it', async () => {
    const outcome = await sendDelivery(delivery(`${base}/moved`))
    expect(outcome).toEqual({ ok: false, status: 302, error: 'redirects are not followed' })
    expect(received.map((r) => r.url)).toEqual(['/moved'])
  })

  it('counts an error answer, an unreachable host and a refused URL as failures', async () => {
    answer = 500
    expect(await sendDelivery(delivery(`${base}/hook`))).toEqual({ ok: false, status: 500, error: 'HTTP 500' })
    expect((await sendDelivery(delivery('http://localhost:1/hook'))).ok).toBe(false)
    expect(await sendDelivery(delivery('http://hooks.example/hook'))).toEqual({ ok: false, status: null, error: 'URL refused: not https' })
  })
})

describe('deliverOutgoingWebhook', () => {
  it('claims, sends and records one attempt', async () => {
    rpc.mockImplementation(async (fn: string) => fn === 'claim_outgoing_webhook_delivery'
      ? { data: [{ ...delivery(`${base}/hook`), defer_ms: null }], error: null }
      : { data: 'delivered', error: null })
    expect(await deliverOutgoingWebhook('9f0e2d4c-0000-4000-8000-000000000001')).toBeNull()
    expect(received).toHaveLength(1)
    expect(rpc).toHaveBeenCalledWith('record_outgoing_webhook_attempt', {
      p_delivery_id: '9f0e2d4c-0000-4000-8000-000000000001', p_ok: true, p_status: 204, p_error: null,
    })
  })

  it('returns the delay of a deferred claim and sends nothing', async () => {
    rpc.mockResolvedValue({ data: [{ delivery_id: null, url: null, secret: null, event: null, payload: null, created_at: null, defer_ms: 2000 }], error: null })
    expect(await deliverOutgoingWebhook('9f0e2d4c-0000-4000-8000-000000000001')).toBe(2000)
    expect(received).toHaveLength(0)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('sends nothing when there is nothing to claim', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    await deliverOutgoingWebhook('9f0e2d4c-0000-4000-8000-000000000001')
    expect(received).toHaveLength(0)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('throws on a database error, for the job to retry', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } })
    await expect(deliverOutgoingWebhook('9f0e2d4c-0000-4000-8000-000000000001')).rejects.toThrow('down')
  })
})
