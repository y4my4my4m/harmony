// Instance funding for the funding journeys: the single instance_funding row, tiers, Stripe
// events signed as Stripe signs them (federation-backend routes/webhooks/stripe.ts), the project
// fund (project_funding), and a stand-in for the Harmony project's instance and its feeds.

import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import type { SupabaseClient } from '@supabase/supabase-js'
import { expect, type Page, type Request } from '@playwright/test'
import { dismissAnnouncements, openChannel } from './harness'

export const STRIPE_SECRET = 'whsec_e2e_funding_journeys'

export interface FundingSetup {
  links?: Array<{ platform: string; url: string; label: string }>
  messagesPublic?: boolean
}

/**
 * Funding on with a monthly goal, Stripe links, messages on; the signing secret set.
 * supporter_messages_public is written only when `setup.messagesPublic` names it: the row is
 * instance-wide, and a spec running beside funding-donor-messages would otherwise turn its
 * sign-in strip back on mid-test.
 */
export async function enableFunding(admin: SupabaseClient, setup: FundingSetup = {}): Promise<void> {
  const config: Record<string, unknown> = {
    enabled: true,
    goal_amount: 100,
    goal_currency: 'USD',
    funding_period: 'monthly',
    show_in_context_bar: true,
    show_progress_bar: true,
    goal_description: 'Server costs',
    funding_links: setup.links ?? [
      { platform: 'stripe', url: 'https://buy.stripe.com/test_e2e_once', label: '' },
      { platform: 'ko-fi', url: 'https://ko-fi.com/e2e', label: '' },
    ],
    supporter_messages_enabled: true,
    stripe_webhook_secret: STRIPE_SECRET,
    stripe_auto_assign_tier: true,
  }
  const { data } = await admin.from('instance_funding').select('id').limit(1).maybeSingle()
  if (setup.messagesPublic !== undefined || !data) config.supporter_messages_public = setup.messagesPublic ?? true
  const { error } = data
    ? await admin.from('instance_funding').update(config).eq('id', data.id)
    : await admin.from('instance_funding').insert(config)
  if (error) throw new Error(`instance_funding: ${error.message}`)
}

/** Stripe-Signature for `body`: t=<unix s>,v1=HMAC-SHA256(secret, "<t>.<body>"). */
export function stripeSignature(body: string, secret = STRIPE_SECRET, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
}

let eventSeq = 0

/**
 * A paid checkout of the Payment Link `paymentLink` for `amountCents`, credited to `profileId`,
 * posted to the backend.
 */
export async function postStripeCheckout(
  backendUrl: string,
  profileId: string,
  amountCents = 500,
  paymentLink = 'plink_e2e',
): Promise<Response> {
  eventSeq += 1
  const ref = `${Date.now().toString(36)}${eventSeq}`
  const body = JSON.stringify({
    id: `evt_e2e_${ref}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_e2e_${ref}`,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        payment_link: paymentLink,
        payment_intent: `pi_e2e_${ref}`,
        amount_total: amountCents,
        currency: 'usd',
        customer: null,
        customer_details: { email: 'donor@e2e.harmony.local', name: 'Donor' },
        client_reference_id: profileId,
      },
    },
  })
  return fetch(`${backendUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': stripeSignature(body) },
    body,
  })
}

/** Funding reads the page makes: the summary and the per-table reads it replaces. */
export const FUNDING_REQUEST =
  /\/rest\/v1\/(instance_funding|instance_supporter_tiers|instance_supporters|instance_donation_history|rpc\/(get_funding_summary|get_funding_current_total))\b/

export interface RequestLog {
  /** Requests since the last take(), as "METHOD path". */
  take(): string[]
}

export function logRequests(page: Page, pattern: RegExp): RequestLog {
  const seen: string[] = []
  page.on('request', (request: Request) => {
    const url = new URL(request.url())
    if (pattern.test(url.pathname)) seen.push(`${request.method()} ${url.pathname}`)
  })
  return { take: () => seen.splice(0) }
}

/** Opens the Support window from the support pill above a channel of `server`. */
export async function openSupportFromChat(page: Page, server: { id: string; generalChannelId: string }): Promise<void> {
  await openChannel(page, server.id, server.generalChannelId)
  await page.locator('.funding-indicator').first().click()
  await expect(page.getByTestId('support-modal')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('support-panel-instance').getByTestId('support-raised')).toBeVisible({ timeout: 15000 })
}

/** Opens the Support window from User settings -> My account -> Support. */
export async function openSupportFromSettings(page: Page): Promise<void> {
  await page.goto('/settings/account')
  await dismissAnnouncements(page)
  await page.getByTestId('settings-support-instance').click({ timeout: 30000 })
  await expect(page.getByTestId('support-modal')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('support-panel-instance').getByTestId('support-raised')).toBeVisible({ timeout: 15000 })
}

/**
 * The Harmony development fund's Payment Links (federation-backend services/projectFunding.ts
 * PROJECT_PAYMENT_LINK_IDS): one-time and monthly.
 */
export const PROJECT_PLINK = 'plink_1UYKJgIByukKkdhljBcFnf5I'
export const PROJECT_PLINK_MONTHLY = 'plink_1UYKRBIByukKkdhlRV8itB6j'

/** The Harmony development tab's links, in order (src/services/FundingService.ts PROJECT_LINKS). */
export const PROJECT_LINK_URLS = [
  'https://donate.stripe.com/fZu8wQ29W5S97hrcqKb7y03',
  'https://donate.stripe.com/8x25kEbKwbct59jcqKb7y04',
  'https://ko-fi.com/y4my4my4m',
]

export interface ProjectFundSetup {
  enabled?: boolean
  goal?: number
}

/** Removes the project fund's donations, pending donations and messages. */
async function clearProjectFund(admin: SupabaseClient): Promise<void> {
  for (const table of ['instance_supporter_messages', 'instance_donation_history', 'instance_pending_donations']) {
    const { error } = await admin.from(table).delete().eq('fund', 'project')
    if (error) throw new Error(`${table}: ${error.message}`)
  }
}

/**
 * The project fund's one row, as an admin of the project's instance sets it: a monthly goal,
 * messages on; its donations, pending donations and messages removed, so its total is the spec's
 * own.
 */
export async function resetProjectFund(admin: SupabaseClient, setup: ProjectFundSetup = {}): Promise<void> {
  await clearProjectFund(admin)
  const { error } = await admin.from('project_funding').upsert({
    id: true,
    enabled: setup.enabled ?? true,
    goal_amount: setup.goal ?? 2000,
    goal_currency: 'USD',
    funding_period: 'monthly',
    goal_description: 'Harmony development',
    supporter_messages_enabled: true,
    supporter_messages_public: true,
  }, { onConflict: 'id' })
  if (error) throw new Error(`project_funding: ${error.message}`)
}

/** The project fund's row with every column at its default, and none of its donations or messages. */
export async function installProjectFund(admin: SupabaseClient): Promise<void> {
  await clearProjectFund(admin)
  const { error: gone } = await admin.from('project_funding').delete().eq('id', true)
  if (gone) throw new Error(`project_funding: ${gone.message}`)
  const { error } = await admin.from('project_funding').insert({ id: true })
  if (error) throw new Error(`project_funding: ${error.message}`)
}

/** This month's instance donations, as the instance's progress counts them. */
export async function instanceRaised(admin: SupabaseClient): Promise<number> {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const { data, error } = await admin.from('instance_donation_history').select('amount').eq('fund', 'instance').gte('donated_at', start)
  if (error) throw new Error(`instance_donation_history: ${error.message}`)
  return (data ?? []).reduce((sum, row) => sum + Number(row.amount), 0)
}

export interface ProjectFeed {
  /** E2E_PROJECT_FEED_URL for startBackend(): the stand-in's /api/federation/funding/project-feed. */
  url: string
  /** Reads of the project fund feed so far. */
  reads: number
  /** Reads of the stand-in's own instance feed (/api/federation/funding/public) so far. */
  publicReads: number
  stop(): Promise<void>
}

/** The host can listen on `ip` (directoryPeer.ts hostHolds). */
function hostHolds(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(0, ip, () => probe.close(() => resolve(true)))
  })
}

/**
 * The Harmony project's instance: GET /api/federation/funding/project-feed serving `feed`, or with
 * `proxyTo` (a backend's URL) that backend's /funding/project-feed and /funding/public. The
 * backend reads it through safeFetch, which refuses loopback and private addresses, so the server
 * listens on the gateway of a Docker bridge network on E2E_FUNDING_PEER_SUBNET (default
 * 192.0.2.0/24, TEST-NET-1), as directoryPeer.ts does; a network already holding the gateway is
 * reused. Plain http: the backend runs with NODE_ENV=development.
 */
export async function startProjectFeed(feed: unknown, options: { proxyTo?: string } = {}): Promise<ProjectFeed> {
  const subnet = process.env.E2E_FUNDING_PEER_SUBNET ?? '192.0.2.0/24'
  const ip = `${subnet.split('/')[0].split('.').slice(0, 3).join('.')}.1`
  const network = `${process.env.E2E_PROJECT ?? 'hme2e'}-funding-peer`
  let created = false
  if (!(await hostHolds(ip))) {
    try { execFileSync('docker', ['network', 'rm', network], { stdio: 'ignore' }) } catch { /* absent */ }
    execFileSync('docker', ['network', 'create', '--driver', 'bridge', '--subnet', subnet, '--gateway', ip, network], { stdio: 'ignore' })
    created = true
    for (let i = 0; i < 50 && !(await hostHolds(ip)); i++) await new Promise((r) => setTimeout(r, 100))
    if (!(await hostHolds(ip))) throw new Error(`docker network ${network} gave the host no ${ip}`)
  }
  const result: ProjectFeed = {
    url: '',
    reads: 0,
    publicReads: 0,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (created) {
        try { execFileSync('docker', ['network', 'rm', network], { stdio: 'ignore' }) } catch { /* gone */ }
      }
    },
  }
  const proxy = async (res: http.ServerResponse, path: string) => {
    const upstream = await fetch(`${options.proxyTo}${path}`, { headers: { Accept: 'application/json' } })
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' })
    res.end(await upstream.text())
  }
  const server = http.createServer((req, res) => {
    const fail = () => { if (!res.headersSent) res.writeHead(502).end() }
    if (req.method === 'GET' && req.url === '/api/federation/funding/project-feed') {
      result.reads += 1
      if (options.proxyTo) void proxy(res, '/funding/project-feed').catch(fail)
      else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(feed))
      return
    }
    if (req.method === 'GET' && req.url === '/api/federation/funding/public') {
      result.publicReads += 1
      if (options.proxyTo) void proxy(res, '/funding/public').catch(fail)
      else res.writeHead(404).end()
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, ip, resolve))
  result.url = `http://${ip}:${(server.address() as net.AddressInfo).port}/api/federation/funding/project-feed`
  return result
}
