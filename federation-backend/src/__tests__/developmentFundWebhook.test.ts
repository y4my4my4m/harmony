import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'
import express from 'express'
import supertest from 'supertest'

// POST /webhooks/stripe on any instance: an event of the Harmony development fund (its two
// Payment Links, or metadata fund=harmony-development on the session or on the subscription an
// invoice bills) is answered 200 'ignored' and writes nothing. har.mony.lol's own funding shares
// the fund's Stripe account; every other event is the instance's, as before.

const SECRET = 'whsec_test_secret'
const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001'
const ONCE = 'plink_1UYKJgIByukKkdhljBcFnf5I'
const MONTHLY = 'plink_1UYKRBIByukKkdhlRV8itB6j'
const TAG = { fund: 'harmony-development' }

const cfg = vi.hoisted(() => ({
  INSTANCE_DOMAIN: 'har.mony.lol',
  NODE_ENV: 'test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
}))
vi.mock('../config/index.js', () => ({ default: cfg, config: cfg }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let rpcCalls: Array<{ fn: string; args: any }> = []
let writes: string[] = []
let nextId = 1

/** In-memory Supabase double for the calls the Stripe webhook makes. */
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
          writes.push(table)
          const dup = (table === 'instance_donation_history' || table === 'instance_pending_donations')
            && rows().some((r) => r.platform === row.platform && r.external_reference === row.external_reference)
          if (dup) error = { code: '23505', message: 'duplicate key' }
          else rows().push({ id: `row-${nextId++}`, ...row })
          return Promise.resolve({ data: null, error })
        },
        upsert(row: Row, opts: { onConflict: string }) {
          writes.push(table)
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

const { default: stripeRouter } = await import('../routes/webhooks/stripe.js')

const app = express()
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf } }))
app.use('/webhooks', stripeRouter)

function sign(body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`
}

function post(event: object) {
  const body = JSON.stringify(event)
  return supertest(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json; charset=utf-8')
    .set('Stripe-Signature', sign(body))
    .send(body)
}

function sessionEvent(session: Row, type = 'checkout.session.completed') {
  return {
    id: `evt_${nextId++}`,
    type,
    data: {
      object: {
        id: `cs_${nextId++}`,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        payment_link: 'plink_instance',
        payment_intent: `pi_${nextId++}`,
        amount_total: 500,
        currency: 'usd',
        customer: null,
        customer_details: { email: 'alice@example.com', name: 'Alice' },
        client_reference_id: ALICE,
        metadata: {},
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
        id: `in_${nextId++}`,
        object: 'invoice',
        customer: 'cus_1',
        customer_email: 'alice@example.com',
        amount_paid: 700,
        currency: 'usd',
        billing_reason: 'subscription_cycle',
        subscription: 'sub_1',
        ...invoice,
      },
    },
  }
}

const IGNORED = { status: 'ignored', reason: expect.stringMatching(/Harmony development fund/) }

beforeEach(() => {
  nextId = 1
  rpcCalls = []
  writes = []
  tables = {
    instance_funding: [{ id: 'f1', stripe_webhook_secret: SECRET, stripe_auto_assign_tier: true }],
    profiles: [{ id: ALICE, username: 'alice', domain: cfg.INSTANCE_DOMAIN }],
    instance_stripe_customers: [{ customer_id: 'cus_1', user_id: ALICE }],
  }
})

for (const domain of ['har.mony.lol', 'self.example']) {
  describe(`POST /webhooks/stripe on ${domain}`, () => {
    beforeEach(() => { cfg.INSTANCE_DOMAIN = domain })

    it('ignores a checkout of either development Payment Link, credited or not', async () => {
      const once = await post(sessionEvent({ payment_link: ONCE }))
      const monthly = await post(sessionEvent({
        mode: 'subscription', payment_link: { id: MONTHLY }, invoice: 'in_first', subscription: 'sub_dev', customer: 'cus_dev',
      }))
      const anonymous = await post(sessionEvent({ payment_link: ONCE, client_reference_id: null }))
      const async = await post(sessionEvent({ payment_link: MONTHLY }, 'checkout.session.async_payment_succeeded'))
      for (const res of [once, monthly, anonymous, async]) {
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject(IGNORED)
      }
      expect(writes).toEqual([])
      expect(rpcCalls).toEqual([])
    })

    it('ignores a checkout whose metadata names the development fund', async () => {
      const credited = await post(sessionEvent({ payment_link: 'plink_other', metadata: TAG }))
      const anonymous = await post(sessionEvent({ payment_link: 'plink_other', metadata: TAG, client_reference_id: null }))
      expect(credited.body).toMatchObject(IGNORED)
      expect(anonymous.body).toMatchObject(IGNORED)
      expect(writes).toEqual([])
    })

    it('ignores an invoice of a tagged subscription, in each place Stripe puts the metadata', async () => {
      const parent = await post(invoiceEvent({
        subscription: undefined,
        parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_dev', metadata: TAG } },
      }))
      const legacy = await post(invoiceEvent({ subscription_details: { metadata: TAG } }))
      const line = await post(invoiceEvent({ lines: { data: [{ metadata: {} }, { metadata: TAG }] } }))
      const unmapped = await post(invoiceEvent({ customer: 'cus_unknown', subscription_details: { metadata: TAG } }))
      for (const res of [parent, legacy, line, unmapped]) {
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject(IGNORED)
      }
      expect(writes).toEqual([])
      expect(rpcCalls).toEqual([])
    })

    it('records an instance donation as before, and queues an uncredited one', async () => {
      const own = await post(sessionEvent({ payment_link: 'plink_instance', payment_intent: 'pi_own', metadata: { fund: 'servers' } }))
      expect(own.body).toMatchObject({ status: 'recorded' })
      expect(tables.instance_donation_history).toEqual([expect.objectContaining({
        user_id: ALICE, amount: 5, external_reference: 'pi_own', supporter_id: tables.instance_supporters[0].id,
      })])
      expect(rpcCalls).toEqual([{ fn: 'recompute_supporter_tier', args: { p_user_id: ALICE } }])

      const renewal = await post(invoiceEvent({ id: 'in_own', subscription_details: { metadata: {} } }))
      expect(renewal.body).toMatchObject({ status: 'recorded' })

      const anonymous = await post(sessionEvent({ client_reference_id: null, payment_intent: 'pi_anon' }))
      expect(anonymous.body).toMatchObject({ status: 'pending' })
      expect(tables.instance_pending_donations).toEqual([expect.objectContaining({ external_reference: 'pi_anon', amount: 5 })])
    })
  })
}
