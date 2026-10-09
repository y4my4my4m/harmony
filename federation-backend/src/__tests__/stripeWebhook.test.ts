import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'
import express from 'express'
import supertest from 'supertest'

// POST /webhooks/stripe: a signed Checkout or invoice event credits the profile named by
// the Payment Link's client_reference_id, or the subscription's mapped customer.

const SECRET = 'whsec_test_secret'
const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001'

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let rpcCalls: Array<{ fn: string; args: any }> = []
let nextId = 1

/** In-memory Supabase double for the calls the donation webhooks make. */
function fakeSupabase() {
  return {
    rpc: (fn: string, args: any) => {
      rpcCalls.push({ fn, args })
      return Promise.resolve({ data: 'tier-1', error: null })
    },
    from(table: string) {
      const rows = () => (tables[table] ??= [])
      const filters: Array<(r: Row) => boolean> = []
      let written: Row | null = null
      let error: any = null
      const builder: any = {
        select: () => builder,
        limit: () => builder,
        eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return builder },
        maybeSingle: () => Promise.resolve({ data: written ?? rows().find((r) => filters.every((f) => f(r))) ?? null, error }),
        single: () => Promise.resolve({ data: written, error }),
        insert(row: Row) {
          const dup = (table === 'instance_donation_history' || table === 'instance_pending_donations')
            && rows().some((r) => r.platform === row.platform && r.external_reference === row.external_reference)
          if (dup) error = { code: '23505', message: 'duplicate key' }
          else rows().push({ id: `row-${nextId++}`, ...row })
          return Promise.resolve({ data: null, error })
        },
        upsert(row: Row, opts: { onConflict: string }) {
          const existing = rows().find((r) => r[opts.onConflict] === row[opts.onConflict])
          if (existing) Object.assign(existing, row)
          written = existing ?? { id: `row-${nextId++}`, ...row }
          if (!existing) rows().push(written)
          return Object.assign(Promise.resolve({ data: null, error: null }), builder)
        },
      }
      return builder
    },
  }
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => fakeSupabase(),
  getSupabaseClientWithAuth: () => { throw new Error('unused') },
}))

const { default: stripeRouter, verifyStripeSignature, fromMinorUnits } = await import('../routes/webhooks/stripe.js')

// As server.ts: the app-wide JSON parser keeps the raw bytes.
const app = express()
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf } }))
app.use('/webhooks', stripeRouter)

function sign(body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

function post(event: object, signature?: string) {
  const body = JSON.stringify(event)
  return supertest(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json; charset=utf-8')
    .set('Stripe-Signature', signature ?? sign(body))
    .send(body)
}

function sessionEvent(session: Row, type = 'checkout.session.completed') {
  return {
    id: `evt_${nextId++}`,
    type,
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        payment_link: 'plink_1',
        payment_intent: 'pi_1',
        amount_total: 500,
        currency: 'usd',
        customer: null,
        customer_details: { email: 'alice@example.com', name: 'Alice' },
        client_reference_id: ALICE,
        ...session,
      },
    },
  }
}

function invoiceEvent(invoice: Row) {
  return {
    id: `evt_${nextId++}`,
    type: 'invoice.paid',
    data: {
      object: {
        id: 'in_2',
        object: 'invoice',
        customer: 'cus_1',
        customer_email: 'alice@example.com',
        amount_paid: 500,
        currency: 'usd',
        billing_reason: 'subscription_cycle',
        subscription: 'sub_1',
        ...invoice,
      },
    },
  }
}

beforeEach(() => {
  nextId = 1
  rpcCalls = []
  tables = {
    instance_funding: [{ id: 'f1', stripe_webhook_secret: SECRET, stripe_auto_assign_tier: true }],
    profiles: [{ id: ALICE, username: 'alice', domain: 'harmony.test' }],
  }
})

describe('verifyStripeSignature', () => {
  const body = Buffer.from('{"id":"evt_1"}')
  const now = 1_800_000_000

  it('accepts a matching v1 among several', () => {
    const good = createHmac('sha256', SECRET).update(`${now}.${body}`).digest('hex')
    expect(verifyStripeSignature(body, `t=${now},v1=${'0'.repeat(64)},v1=${good}`, SECRET, now)).toBe(true)
  })

  it('refuses another secret, a stale timestamp and a malformed header', () => {
    expect(verifyStripeSignature(body, sign(body.toString(), 'whsec_other', now), SECRET, now)).toBe(false)
    expect(verifyStripeSignature(body, sign(body.toString(), SECRET, now - 301), SECRET, now)).toBe(false)
    expect(verifyStripeSignature(body, 'v1=abc', SECRET, now)).toBe(false)
    expect(verifyStripeSignature(body, undefined, SECRET, now)).toBe(false)
  })
})

describe('fromMinorUnits', () => {
  it('follows Stripe currency exponents', () => {
    expect(fromMinorUnits(1250, 'usd')).toBe(12.5)
    expect(fromMinorUnits(500, 'JPY')).toBe(500)
    expect(fromMinorUnits(1500, 'kwd')).toBe(1.5)
  })
})

describe('POST /webhooks/stripe', () => {
  it('refuses an unsigned or wrongly signed event', async () => {
    const event = sessionEvent({})
    expect((await post(event, 't=1,v1=00')).status).toBe(400)
    expect((await post(event, sign(JSON.stringify(event), 'whsec_other'))).status).toBe(400)
    expect(tables.instance_donation_history).toBeUndefined()
  })

  it('answers 503 while no signing secret is set', async () => {
    tables.instance_funding[0].stripe_webhook_secret = null
    expect((await post(sessionEvent({}))).status).toBe(503)
  })

  it('credits a one-off donation to the client_reference_id profile, once', async () => {
    const event = sessionEvent({})
    const res = await post(event)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('recorded')
    expect(tables.instance_donation_history).toEqual([
      expect.objectContaining({ user_id: ALICE, amount: 5, currency: 'USD', platform: 'stripe', external_reference: 'pi_1' }),
    ])
    expect(tables.instance_supporters[0]).toMatchObject({ user_id: ALICE, platform: 'stripe', is_active: true })
    expect(rpcCalls).toEqual([{ fn: 'recompute_supporter_tier', args: { p_user_id: ALICE } }])

    const retry = await post(event)
    expect(retry.body.status).toBe('duplicate')
    expect(tables.instance_donation_history).toHaveLength(1)
  })

  it('leaves the tier alone when auto-assign is off', async () => {
    tables.instance_funding[0].stripe_auto_assign_tier = false
    await post(sessionEvent({}))
    expect(tables.instance_donation_history).toHaveLength(1)
    expect(rpcCalls).toEqual([])
  })

  it('waits for an asynchronous payment to succeed', async () => {
    const res = await post(sessionEvent({ payment_status: 'unpaid' }))
    expect(res.body.status).toBe('ignored')
    expect((await post(sessionEvent({}, 'checkout.session.async_payment_succeeded'))).body.status).toBe('recorded')
  })

  it('queues a Payment Link donation without a known profile', async () => {
    const res = await post(sessionEvent({ client_reference_id: null }))
    expect(res.body.status).toBe('pending')
    expect(tables.instance_pending_donations).toEqual([
      expect.objectContaining({ platform: 'stripe', external_reference: 'pi_1', amount: 5, donor_email: 'alice@example.com', donor_name: 'Alice' }),
    ])
    expect((await post(sessionEvent({ client_reference_id: 'not-a-uuid', payment_intent: 'pi_9' }))).body.status).toBe('pending')
  })

  it('ignores Checkout sessions from outside Payment Links', async () => {
    const res = await post(sessionEvent({ client_reference_id: null, payment_link: null }))
    expect(res.body.status).toBe('ignored')
    expect(tables.instance_pending_donations).toBeUndefined()
  })

  it('records a subscription once from its session and first invoice, then credits renewals', async () => {
    const session = sessionEvent({ mode: 'subscription', payment_intent: null, customer: 'cus_1', invoice: 'in_1', subscription: 'sub_1' })
    // The first invoice can arrive before the session that maps its customer.
    const early = await post(invoiceEvent({ id: 'in_1', billing_reason: 'subscription_create' }))
    expect(early.body.status).toBe('ignored')

    expect((await post(session)).body.status).toBe('recorded')
    expect(tables.instance_stripe_customers).toEqual([expect.objectContaining({ customer_id: 'cus_1', user_id: ALICE })])
    expect((await post(invoiceEvent({ id: 'in_1', billing_reason: 'subscription_create' }))).body.status).toBe('duplicate')

    const renewal = await post(invoiceEvent({ id: 'in_2', amount_paid: 700 }))
    expect(renewal.body.status).toBe('recorded')
    expect(tables.instance_donation_history.map((r) => [r.external_reference, r.amount])).toEqual([['in_1', 5], ['in_2', 7]])
  })

  it('reads the subscription from parent.subscription_details on newer API versions', async () => {
    tables.instance_stripe_customers = [{ customer_id: 'cus_1', user_id: ALICE }]
    const res = await post(invoiceEvent({ subscription: undefined, parent: { subscription_details: { subscription: 'sub_1' } } }))
    expect(res.body.status).toBe('recorded')
  })

  it('queues an unmapped renewal and ignores one-off invoices', async () => {
    expect((await post(invoiceEvent({}))).body.status).toBe('pending')
    expect(tables.instance_pending_donations[0]).toMatchObject({ external_reference: 'in_2', donor_email: 'alice@example.com' })
    expect((await post(invoiceEvent({ id: 'in_3', subscription: null }))).body.status).toBe('ignored')
  })

  it('ignores other event types', async () => {
    const res = await post({ id: 'evt_x', type: 'customer.created', data: { object: { id: 'cus_1' } } })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ignored')
  })
})
