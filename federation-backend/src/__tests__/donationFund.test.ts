import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'
import express from 'express'
import supertest from 'supertest'

// Which fund a donation webhook records into (instance_donation_history.fund, 20261106400001):
// on the Harmony project's own instance, a Stripe event of a project Payment Link, or of a
// subscription whose metadata.fund is harmony-development, and a Ko-fi event carrying the
// project's own token, are the project's; everything else is the instance's.

const SECRET = 'whsec_test_secret'
const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001'
const ONCE = 'plink_1UYKJgIByukKkdhljBcFnf5I'
const MONTHLY = 'plink_1UYKRBIByukKkdhlRV8itB6j'

const cfg = vi.hoisted(() => ({
  INSTANCE_DOMAIN: 'har.mony.lol',
  NODE_ENV: 'test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  PROJECT_FUNDING_URL: 'https://har.mony.lol/api/federation/funding/project-feed',
  PROJECT_INSTANCE: 'auto',
}))
vi.mock('../config/index.js', () => ({ default: cfg, config: cfg }))
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
      return Promise.resolve({ data: null, error: null })
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
        ilike: (col: string, val: string) => {
          filters.push((r) => String(r[col] ?? '').toLowerCase() === val.toLowerCase())
          return builder
        },
        maybeSingle: () => Promise.resolve({ data: written ?? rows().find((r) => filters.every((f) => f(r))) ?? null, error }),
        single: () => Promise.resolve({ data: written, error }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: rows().filter((r) => filters.every((f) => f(r))), error }),
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

const { default: stripeRouter, sessionFund, invoiceFund } = await import('../routes/webhooks/stripe.js')
const { default: kofiRouter } = await import('../routes/webhooks/kofi.js')

const app = express()
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf } }))
app.use('/webhooks', kofiRouter)
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

function sessionEvent(session: Row) {
  return {
    id: `evt_${nextId++}`,
    type: 'checkout.session.completed',
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
        ...invoice,
      },
    },
  }
}

function kofi(token: string, message: string | null, txn: string) {
  const data = JSON.stringify({
    verification_token: token,
    type: 'Donation',
    from_name: 'Ko-fi donor',
    message,
    amount: '3.00',
    email: 'donor@example.com',
    currency: 'USD',
    kofi_transaction_id: txn,
  })
  return supertest(app).post('/webhooks/kofi').type('form').send({ data })
}

const history = () => tables.instance_donation_history ?? []
const pending = () => tables.instance_pending_donations ?? []

beforeEach(() => {
  nextId = 1
  rpcCalls = []
  cfg.PROJECT_INSTANCE = 'auto'
  tables = {
    instance_funding: [{ id: 'f1', stripe_webhook_secret: SECRET, stripe_auto_assign_tier: true, kofi_webhook_token: 'kofi-instance', kofi_auto_assign_tier: true }],
    project_funding: [{ id: true, stripe_payment_links: [ONCE, MONTHLY], kofi_webhook_token: 'kofi-project' }],
    profiles: [{ id: ALICE, username: 'alice', domain: 'har.mony.lol' }],
  }
})

describe('sessionFund and invoiceFund', () => {
  const links = new Set([ONCE, MONTHLY])

  it('a session is the project\'s by its Payment Link or its own metadata', () => {
    expect(sessionFund({ payment_link: ONCE }, links)).toBe('project')
    expect(sessionFund({ payment_link: { id: MONTHLY } }, links)).toBe('project')
    expect(sessionFund({ payment_link: 'plink_other', metadata: { fund: 'harmony-development' } }, links)).toBe('project')
    expect(sessionFund({ payment_link: 'plink_other', metadata: { fund: 'servers' } }, links)).toBe('instance')
    expect(sessionFund({ payment_link: null }, links)).toBe('instance')
  })

  it('an invoice is the project\'s by its subscription\'s metadata, in either API shape', () => {
    expect(invoiceFund({ parent: { subscription_details: { metadata: { fund: 'harmony-development' } } } }, links)).toBe('project')
    expect(invoiceFund({ subscription_details: { metadata: { fund: 'harmony-development' } } }, links)).toBe('project')
    expect(invoiceFund({ lines: { data: [{ metadata: {} }, { metadata: { fund: 'harmony-development' } }] } }, links)).toBe('project')
    expect(invoiceFund({ subscription_details: { metadata: {} }, lines: { data: [{ metadata: null }] } }, links)).toBe('instance')
    expect(invoiceFund({}, links)).toBe('instance')
  })

  it('off the project\'s instance everything is the instance\'s', () => {
    expect(sessionFund({ payment_link: ONCE, metadata: { fund: 'harmony-development' } }, null)).toBe('instance')
    expect(invoiceFund({ subscription_details: { metadata: { fund: 'harmony-development' } } }, null)).toBe('instance')
  })
})

describe('POST /webhooks/stripe on the project\'s instance', () => {
  it('a checkout of a project Payment Link records a project donation and no supporter row', async () => {
    const res = await post(sessionEvent({ payment_link: ONCE, amount_total: 1234, payment_intent: 'pi_proj' }))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'recorded', fund: 'project' })
    expect(history()).toEqual([expect.objectContaining({
      user_id: ALICE, amount: 12.34, external_reference: 'pi_proj', fund: 'project', supporter_id: null,
    })])
    expect(tables.instance_supporters ?? []).toEqual([])
    expect(rpcCalls.filter((c) => c.fn === 'recompute_supporter_tier')).toEqual([])
  })

  it('a checkout of the instance\'s own link stays the instance\'s, with its supporter row and tier', async () => {
    const res = await post(sessionEvent({ payment_link: 'plink_instance', payment_intent: 'pi_inst' }))
    expect(res.body).toMatchObject({ status: 'recorded', fund: 'instance' })
    // The instance's fund is the column default: the row names none.
    expect(history()).toEqual([expect.objectContaining({ external_reference: 'pi_inst' })])
    expect(history()[0]).not.toHaveProperty('fund')
    expect(history()[0].supporter_id).toBe(tables.instance_supporters[0].id)
    expect(rpcCalls).toEqual([{ fn: 'recompute_supporter_tier', args: { p_user_id: ALICE } }])
  })

  it('a monthly checkout of 7 units records the session total, 7 dollars', async () => {
    const res = await post(sessionEvent({
      mode: 'subscription', payment_link: MONTHLY, invoice: 'in_first', subscription: 'sub_p', customer: 'cus_p', amount_total: 700,
    }))
    expect(res.body).toMatchObject({ status: 'recorded', fund: 'project' })
    expect(history()).toEqual([expect.objectContaining({ external_reference: 'in_first', amount: 7, fund: 'project' })])
    expect(tables.instance_stripe_customers).toEqual([expect.objectContaining({ customer_id: 'cus_p', user_id: ALICE })])
  })

  it('a renewal is the project\'s by its subscription metadata, credited to the mapped customer', async () => {
    tables.instance_stripe_customers = [{ customer_id: 'cus_p', user_id: ALICE }]
    const res = await post(invoiceEvent({
      id: 'in_renew', customer: 'cus_p', amount_paid: 700,
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_p', metadata: { fund: 'harmony-development' } } },
    }))
    expect(res.body).toMatchObject({ status: 'recorded', fund: 'project' })
    expect(history()).toEqual([expect.objectContaining({ external_reference: 'in_renew', amount: 7, fund: 'project', supporter_id: null })])
  })

  it('a renewal of an unmapped customer is queued in the project fund', async () => {
    const res = await post(invoiceEvent({
      id: 'in_anon', customer: 'cus_anon', subscription: 'sub_a',
      subscription_details: { metadata: { fund: 'harmony-development' } },
    }))
    expect(res.body).toMatchObject({ status: 'pending', fund: 'project' })
    expect(pending()).toEqual([expect.objectContaining({ external_reference: 'in_anon', amount: 7, fund: 'project' })])
  })

  it('a checkout from mony.lol with no account is queued in the project fund', async () => {
    const res = await post(sessionEvent({ payment_link: ONCE, client_reference_id: null, payment_intent: 'pi_anon' }))
    expect(res.body).toMatchObject({ status: 'pending', fund: 'project' })
    expect(pending()).toEqual([expect.objectContaining({ external_reference: 'pi_anon', fund: 'project' })])
  })

  it('a renewal without project metadata stays the instance\'s', async () => {
    tables.instance_stripe_customers = [{ customer_id: 'cus_i', user_id: ALICE }]
    const res = await post(invoiceEvent({ id: 'in_inst', customer: 'cus_i', subscription: 'sub_i', subscription_details: { metadata: {} } }))
    expect(res.body).toMatchObject({ status: 'recorded', fund: 'instance' })
  })

  it('the first invoice and its session record once, both in the project fund', async () => {
    tables.instance_stripe_customers = [{ customer_id: 'cus_p', user_id: ALICE }]
    await post(invoiceEvent({
      id: 'in_create', customer: 'cus_p', billing_reason: 'subscription_create', amount_paid: 500,
      parent: { subscription_details: { subscription: 'sub_p', metadata: { fund: 'harmony-development' } } },
    }))
    const res = await post(sessionEvent({
      mode: 'subscription', payment_link: MONTHLY, invoice: 'in_create', subscription: 'sub_p', customer: 'cus_p',
    }))
    expect(res.body).toMatchObject({ status: 'duplicate', fund: 'project' })
    expect(history()).toEqual([expect.objectContaining({ external_reference: 'in_create', fund: 'project' })])
  })
})

describe('POST /webhooks/stripe on another instance', () => {
  it('records a project-looking checkout and renewal as the instance\'s, without reading project_funding', async () => {
    cfg.PROJECT_INSTANCE = 'false'
    tables.project_funding = []
    tables.instance_stripe_customers = [{ customer_id: 'cus_p', user_id: ALICE }]
    const once = await post(sessionEvent({ payment_link: ONCE, payment_intent: 'pi_self' }))
    const renewal = await post(invoiceEvent({
      id: 'in_self', customer: 'cus_p', subscription: 'sub_p', subscription_details: { metadata: { fund: 'harmony-development' } },
    }))
    expect(once.body).toMatchObject({ status: 'recorded', fund: 'instance' })
    expect(renewal.body).toMatchObject({ status: 'recorded', fund: 'instance' })
    expect(history().every((r) => r.fund === undefined && r.supporter_id)).toBe(true)
  })
})

describe('POST /webhooks/kofi', () => {
  it('the project\'s token records into the project fund; the instance\'s into the instance\'s', async () => {
    const project = await kofi('kofi-project', 'for harmony @alice', 'kofi_p1')
    expect(project.body).toMatchObject({ status: 'recorded', fund: 'project' })
    const own = await kofi('kofi-instance', '@alice', 'kofi_i1')
    expect(own.body).toMatchObject({ status: 'recorded', fund: 'instance' })
    const anon = await kofi('kofi-project', null, 'kofi_p2')
    expect(anon.body).toMatchObject({ status: 'pending', fund: 'project' })
    expect(history().map((r) => [r.external_reference, r.fund ?? 'instance', r.supporter_id ?? null]))
      .toEqual([['kofi_p1', 'project', null], ['kofi_i1', 'instance', expect.any(String)]])
    expect(pending()).toEqual([expect.objectContaining({ external_reference: 'kofi_p2', fund: 'project' })])
  })

  it('without a project token, or off the project\'s instance, Ko-fi stays the instance\'s', async () => {
    tables.project_funding = [{ id: true, stripe_payment_links: [], kofi_webhook_token: null }]
    expect((await kofi('kofi-project', '@alice', 'kofi_x')).status).toBe(401)
    cfg.PROJECT_INSTANCE = 'false'
    tables.project_funding = [{ id: true, stripe_payment_links: [], kofi_webhook_token: 'kofi-project' }]
    expect((await kofi('kofi-project', '@alice', 'kofi_y')).status).toBe(401)
    expect((await kofi('kofi-instance', '@alice', 'kofi_z')).body).toMatchObject({ fund: 'instance' })
  })
})
