/**
 * Sends outgoing webhook deliveries (migration 20261028600001), one attempt per job.
 *
 * Body: { "type": <event>, "timestamp": <ISO time the event was queued>, "data": <the gateway's
 * d, with server_id> }. Headers follow Standard Webhooks (standardwebhooks.com):
 *
 *   webhook-id         the delivery id; the same on every attempt
 *   webhook-timestamp  Unix seconds at this attempt
 *   webhook-signature  "v1," + base64(HMAC-SHA256(key, id + "." + timestamp + "." + body)), the key
 *                      being the base64 after "whsec_" in the webhook's secret
 *
 * Only https; redirects are failures. The address is checked as the connection is made, so a name
 * that resolves to a private, loopback or link-local address is refused however it resolved
 * before. A 2xx answer within TIMEOUT_MS delivers; anything else is a failed attempt, which
 * record_outgoing_webhook_attempt reschedules.
 */

import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { isBlockedAddress } from '../utils/ssrfProtection.js';
import { federationUserAgent } from '../utils/userAgent.js';
import { logger } from '../utils/logger.js';

const TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  const signature = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${signature}`;
}

/** Why the URL is not sent to, or null. */
export function refusedWebhookUrl(raw: string, allowLoopback = config.OUTGOING_WEBHOOKS_ALLOW_LOOPBACK): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.username || url.password) return 'credentials in the URL';
  const loopback = allowLoopback && LOOPBACK_HOSTS.has(url.hostname);
  // An IP literal makes no lookup: connect.lookup never sees it.
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal) && isBlockedAddress(literal) && !loopback) return 'an internal address';
  // One spelling per host: the URL parser rewrites numeric, escaped, Unicode and IPv6 spellings,
  // while blocked domains and the per-host rate key on the host as stored with the webhook.
  const written = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^/:?#]*)/i.exec(raw)?.[1]?.toLowerCase();
  if (written !== url.hostname) return 'host not in canonical form';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && loopback) return null;
  return 'not https';
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** net.connect's lookup, refusing every internal address it resolves to. */
export function guardedLookup(allowLoopback: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, '', 0);
        return;
      }
      const list = addresses as dns.LookupAddress[];
      const refused = list.find((a) => isBlockedAddress(a.address)
        && !(allowLoopback && (a.address === '127.0.0.1' || a.address === '::1')));
      if (refused || list.length === 0) {
        const error: NodeJS.ErrnoException = new Error(`${hostname} resolves to ${refused?.address ?? 'nothing'}, which is not reachable from here`);
        error.code = 'EADDRNOTAVAIL';
        callback(error, '', 0);
        return;
      }
      if (options.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };
}

let dispatcherPromise: Promise<unknown> | null = null;
async function webhookDispatcher(): Promise<unknown> {
  dispatcherPromise ??= import('undici').then(({ Agent }) => new Agent({
    connect: { lookup: guardedLookup(config.OUTGOING_WEBHOOKS_ALLOW_LOOPBACK) as any, timeout: TIMEOUT_MS },
    headersTimeout: TIMEOUT_MS,
    bodyTimeout: TIMEOUT_MS,
  }));
  return dispatcherPromise;
}

interface ClaimedDelivery {
  delivery_id: string;
  url: string;
  secret: string;
  event: string;
  payload: unknown;
  created_at: string;
}

/** claim_outgoing_webhook_delivery's row: a delivery to send, or only defer_ms. */
interface ClaimRow extends Partial<ClaimedDelivery> {
  defer_ms: number | null;
}

export interface AttemptOutcome {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** One POST of a claimed delivery. Never throws. */
export async function sendDelivery(delivery: ClaimedDelivery, now = Date.now()): Promise<AttemptOutcome> {
  const refusal = refusedWebhookUrl(delivery.url);
  if (refusal) return { ok: false, status: null, error: `URL refused: ${refusal}` };

  const body = JSON.stringify({
    type: delivery.event,
    timestamp: new Date(delivery.created_at).toISOString(),
    data: delivery.payload,
  });
  const timestamp = Math.floor(now / 1000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
  try {
    const response = await fetch(delivery.url, {
      method: 'POST',
      redirect: 'manual',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': federationUserAgent(),
        'webhook-id': delivery.delivery_id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signWebhook(delivery.secret, delivery.delivery_id, timestamp, body),
      },
      body,
      // undici's dispatcher; not in lib.dom's RequestInit.
      ...({ dispatcher: await webhookDispatcher() } as Record<string, unknown>),
    });
    await response.body?.cancel().catch(() => {});
    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status, error: null };
    const error = response.status >= 300 && response.status < 400 ? 'redirects are not followed' : `HTTP ${response.status}`;
    return { ok: false, status: response.status, error };
  } catch (err) {
    const cause = (err as { cause?: { message?: string } })?.cause?.message;
    return { ok: false, status: null, error: cause ?? (err instanceof Error ? err.message : String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Claims, sends and records one delivery. Returns the milliseconds to wait before trying again
 * when the claim was deferred (two attempts of the webhook in flight, or its host at its rate),
 * else null. A database error throws, for the job to retry.
 */
export async function deliverOutgoingWebhook(deliveryId: string): Promise<number | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('claim_outgoing_webhook_delivery', { p_delivery_id: deliveryId });
  if (error) throw new Error(`claim_outgoing_webhook_delivery ${deliveryId}: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as ClaimRow | undefined;
  if (!row) return null;
  if (row.defer_ms != null) return row.defer_ms;
  const delivery = row as ClaimedDelivery;

  const outcome = await sendDelivery(delivery);
  const { data: status, error: recordError } = await supabase.rpc('record_outgoing_webhook_attempt', {
    p_delivery_id: deliveryId,
    p_ok: outcome.ok,
    p_status: outcome.status,
    p_error: outcome.error,
  });
  if (recordError) throw new Error(`record_outgoing_webhook_attempt ${deliveryId}: ${recordError.message}`);
  logger.info(`Outgoing webhook ${delivery.event} ${deliveryId}: ${outcome.ok ? 'delivered' : `${outcome.error}; ${status}`}`);
  return null;
}
