// Instance funding for the funding journeys: the single instance_funding row, tiers, Stripe
// events signed as Stripe signs them (federation-backend routes/webhooks/stripe.ts), and the
// Harmony development fund's links.

import { createHmac } from 'node:crypto'
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
 * The Harmony development fund's Payment Links, one-time then monthly (federation-backend
 * routes/webhooks/stripe.ts DEVELOPMENT_PAYMENT_LINK_IDS).
 */
export const DEVELOPMENT_PLINKS = ['plink_1UYKJgIByukKkdhljBcFnf5I', 'plink_1UYKRBIByukKkdhlRV8itB6j']

/** The Harmony development tab's Stripe Payment Links, one-time then monthly (src/services/developmentFund.ts). */
export const DEVELOPMENT_LINK_URLS = [
  'https://donate.stripe.com/fZu8wQ29W5S97hrcqKb7y03',
  'https://donate.stripe.com/8x25kEbKwbct59jcqKb7y04',
]

export const DEVELOPMENT_SUPPORTERS_URL = 'https://mony.lol/supporters'
