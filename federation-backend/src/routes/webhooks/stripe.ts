/**
 * Stripe Webhook Endpoint: POST /webhooks/stripe
 *
 * Donations through a Stripe Payment Link. Harmony opens the link with
 * `?client_reference_id=<profile id>`; Checkout copies it onto the session, so the
 * donation is credited to that profile without a handle in a message.
 *
 * Verification: the `Stripe-Signature` header, `t=<unix s>,v1=<hex>[,v1=...]`, where v1 is
 * HMAC-SHA256 over `<t>.<raw body>` keyed with the endpoint's signing secret
 * (`instance_funding.stripe_webhook_secret`, the whole `whsec_...` string). Timestamps more
 * than 300 s from now are refused, as stripe-node's constructEvent does.
 * https://docs.stripe.com/webhooks#verify-manually
 *
 * Events:
 * - checkout.session.completed, checkout.session.async_payment_succeeded: a session with
 *   payment_status 'paid'. mode 'payment' is keyed by its PaymentIntent; mode
 *   'subscription' by its first invoice, and its customer is mapped to the profile in
 *   `instance_stripe_customers`.
 * - invoice.paid: a subscription invoice, credited to the customer's mapped profile and keyed
 *   by the invoice id, so the first invoice and its checkout session record once. An
 *   unmapped first invoice is left to the session event; an unmapped renewal is queued.
 * Sessions with no resolvable profile are queued when they came from a Payment Link and
 * ignored otherwise (other Checkout integrations on the same account).
 *
 * Responses: 2xx once handled, including ignored and duplicate events; 5xx on a storage
 * failure, so Stripe retries (up to three days) and the dedup keys absorb the replay.
 */

import express, { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSupabaseClient } from '../../config/supabase.js';
import { logger } from '../../utils/logger.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import { clientIp, webhookLimiter } from '../../middleware/rateLimit.js';
import {
  recordMatchedDonation,
  recordPendingDonation,
  type DonationRecord,
  type MatchedUser,
} from './donations.js';

const router = Router();

// The app-wide JSON parser keeps the exact bytes on req.rawBody; this parser covers mounts
// without it. body-parser skips a request whose body is already parsed.
router.use(express.raw({ type: '*/*', limit: '1mb' }));

export const SIGNATURE_TOLERANCE_S = 300;

export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  nowS: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = Number.parseInt(value, 10);
    else if (key === 'v1') signatures.push(value);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowS - timestamp) > SIGNATURE_TOLERANCE_S) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  return signatures.some((sig) => {
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    return timingSafeEqual(Buffer.from(sig, 'hex'), expected);
  });
}

/**
 * Currencies Stripe amounts carry without minor units. Three-decimal currencies (BHD, JOD,
 * KWD, OMR, TND) use 1000. https://docs.stripe.com/currencies#zero-decimal
 */
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv',
  'xaf', 'xof', 'xpf',
]);
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

export function fromMinorUnits(amount: number, currency: string): number {
  const c = currency.toLowerCase();
  if (ZERO_DECIMAL.has(c)) return amount;
  if (THREE_DECIMAL.has(c)) return amount / 1000;
  return amount / 100;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stripe expands nothing on webhook objects; a reference is an id string or an object with one. */
function refId(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

interface StripeConfig {
  stripe_webhook_secret: string | null;
  stripe_auto_assign_tier: boolean;
}

async function loadStripeConfig(): Promise<StripeConfig | null> {
  const { data, error } = await getSupabaseClient()
    .from('instance_funding')
    .select('stripe_webhook_secret, stripe_auto_assign_tier')
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.error(`stripe: failed to load funding config: ${error.message}`);
    return null;
  }
  return data as StripeConfig | null;
}

async function profileById(id: string | null): Promise<MatchedUser | null> {
  if (!id || !UUID_RE.test(id)) return null;
  const { data, error } = await getSupabaseClient()
    .from('profiles')
    .select('id, username, domain')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  return data ? { id: data.id, username: data.username, domain: data.domain } : null;
}

async function profileForCustomer(customerId: string | null): Promise<MatchedUser | null> {
  if (!customerId) return null;
  const { data, error } = await getSupabaseClient()
    .from('instance_stripe_customers')
    .select('user_id')
    .eq('customer_id', customerId)
    .maybeSingle();
  if (error) throw new Error(`customer lookup failed: ${error.message}`);
  return data ? profileById(data.user_id) : null;
}

async function mapCustomer(customerId: string, userId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('instance_stripe_customers')
    .upsert({ customer_id: customerId, user_id: userId }, { onConflict: 'customer_id' });
  if (error) throw new Error(`customer mapping failed: ${error.message}`);
}

type Outcome = { status: 'recorded' | 'duplicate' | 'pending' | 'ignored'; reason?: string };

async function credit(
  user: MatchedUser | null,
  donation: DonationRecord,
  email: string | null,
  raw: unknown,
  cfg: StripeConfig,
): Promise<Outcome> {
  if (user) {
    const result = await recordMatchedDonation(user, donation, cfg.stripe_auto_assign_tier);
    return { status: result };
  }
  await recordPendingDonation(donation, email, raw);
  return { status: 'pending' };
}

async function handleCheckoutSession(session: any, cfg: StripeConfig): Promise<Outcome> {
  if (session.payment_status !== 'paid') {
    return { status: 'ignored', reason: `payment_status ${session.payment_status}` };
  }
  if (session.mode !== 'payment' && session.mode !== 'subscription') {
    return { status: 'ignored', reason: `mode ${session.mode}` };
  }

  const user = await profileById(session.client_reference_id ?? null);
  if (!user && !session.payment_link) {
    return { status: 'ignored', reason: 'not a Payment Link session' };
  }

  const customer = refId(session.customer);
  if (session.mode === 'subscription' && user && customer) {
    await mapCustomer(customer, user.id);
  }

  const externalRef = session.mode === 'subscription'
    ? refId(session.invoice) ?? session.id
    : refId(session.payment_intent) ?? session.id;
  const currency = String(session.currency ?? 'usd');
  const donation: DonationRecord = {
    platform: 'stripe',
    amount: fromMinorUnits(Number(session.amount_total ?? 0), currency),
    currency: currency.toUpperCase(),
    externalRef,
    donorName: session.customer_details?.name ?? null,
    donorMessage: null,
  };
  if (!(donation.amount > 0)) return { status: 'ignored', reason: 'zero amount' };

  return credit(user, donation, session.customer_details?.email ?? null, session, cfg);
}

async function handleInvoicePaid(invoice: any, cfg: StripeConfig): Promise<Outcome> {
  // API versions from 2025-03-31 move the subscription under parent.subscription_details.
  const subscription = refId(invoice.subscription) ?? refId(invoice.parent?.subscription_details?.subscription);
  if (!subscription) return { status: 'ignored', reason: 'not a subscription invoice' };

  const currency = String(invoice.currency ?? 'usd');
  const donation: DonationRecord = {
    platform: 'stripe',
    amount: fromMinorUnits(Number(invoice.amount_paid ?? 0), currency),
    currency: currency.toUpperCase(),
    externalRef: invoice.id,
    donorName: invoice.customer_name ?? null,
    donorMessage: null,
  };
  if (!(donation.amount > 0)) return { status: 'ignored', reason: 'zero amount' };

  const user = await profileForCustomer(refId(invoice.customer));
  if (!user && invoice.billing_reason === 'subscription_create') {
    return { status: 'ignored', reason: 'first invoice; recorded from its checkout session' };
  }
  if (!user && invoice.billing_reason !== 'subscription_cycle') {
    return { status: 'ignored', reason: `billing_reason ${invoice.billing_reason}` };
  }
  return credit(user, donation, invoice.customer_email ?? null, invoice, cfg);
}

router.post('/stripe', webhookLimiter, async (req: Request, res: Response) => {
  const rawBody: Buffer | null = (req as any).rawBody ?? (Buffer.isBuffer(req.body) ? req.body : null);
  if (!rawBody || rawBody.length === 0) {
    return sendError(res, 'Missing body', 400);
  }

  const cfg = await loadStripeConfig();
  if (!cfg?.stripe_webhook_secret) {
    return sendError(res, 'Stripe webhook is not configured on this instance', 503);
  }

  if (!verifyStripeSignature(rawBody, req.get('stripe-signature'), cfg.stripe_webhook_secret)) {
    logger.warn(`stripe: signature verification failed from ${clientIp(req)}`);
    return sendError(res, 'Invalid signature', 400);
  }

  let event: any;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return sendError(res, 'Invalid JSON', 400);
  }
  const object = event?.data?.object;
  if (typeof event?.type !== 'string' || !object || typeof object !== 'object') {
    return sendError(res, 'Invalid event shape', 400);
  }

  try {
    let outcome: Outcome;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        outcome = await handleCheckoutSession(object, cfg);
        break;
      case 'invoice.paid':
        outcome = await handleInvoicePaid(object, cfg);
        break;
      default:
        outcome = { status: 'ignored', reason: `event ${event.type}` };
    }
    if (outcome.status === 'ignored') {
      logger.info(`stripe: ignored ${event.id} (${outcome.reason})`);
    }
    return sendSuccess(res, outcome);
  } catch (err) {
    logger.error(`stripe: ${event.type} ${event.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    return sendError(res, 'Processing failed', 500);
  }
});

export default router;
