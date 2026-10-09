/**
 * Ko-fi Webhook Endpoint
 *
 * Receives donation events from Ko-fi (Gold tier feature) at POST /webhooks/kofi.
 * Ko-fi posts `application/x-www-form-urlencoded` with a single `data` field
 * containing a JSON string. Reference:
 * https://help.ko-fi.com/hc/en-us/articles/360004162298-Webhooks
 *
 * Verification:
 * - The payload's `verification_token` field is matched against
 *   `instance_funding.kofi_webhook_token`. Ko-fi does not sign requests with
 *   HMAC, so the token is the only proof of authenticity. This endpoint must
 *   be served over HTTPS and the token treated as a secret.
 *
 * Matching strategy:
 * - Parse `message` and `from_name` for `@username@domain` or `@username`.
 * - Match against `profiles.username` (+ optional `domain`).
 * - On match: insert into `instance_donation_history` and optionally upsert
 *   the user into `instance_supporters` with the highest tier whose
 *   `min_amount <= amount` (when `kofi_auto_assign_tier` is true).
 * - On miss: insert into `instance_pending_donations` for admin review.
 *
 * Dedup:
 * - `kofi_transaction_id` is stored as `external_reference`. The partial
 *   unique index on `(platform, external_reference)` ensures retries don't
 *   double-count, even across concurrent webhook deliveries.
 */

import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
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

// Ko-fi sends application/x-www-form-urlencoded - the global express.json
// parser ignores this content-type. Apply urlencoded parsing scoped to this
// router only.
router.use(express.urlencoded({ extended: false, limit: '64kb' }));

/** Subset of Ko-fi's payload used here. See Ko-fi docs for the rest. */
const KofiPayloadSchema = z.object({
  verification_token: z.string().min(1),
  message_id: z.string().optional(),
  timestamp: z.string().optional(),
  type: z.enum(['Donation', 'Subscription', 'Commission', 'Shop Order']),
  is_public: z.boolean().optional(),
  from_name: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
  amount: z.string(),
  url: z.string().url().optional(),
  email: z.string().email().nullable().optional(),
  currency: z.string().default('USD'),
  is_subscription_payment: z.boolean().optional(),
  is_first_subscription_payment: z.boolean().optional(),
  kofi_transaction_id: z.string(),
  shop_items: z.array(z.unknown()).nullable().optional(),
  tier_name: z.string().nullable().optional(),
  shipping: z.unknown().nullable().optional(),
});

type KofiPayload = z.infer<typeof KofiPayloadSchema>;

interface ParsedHandle {
  username: string;
  domain: string | null;
}

/**
 * Extracts a `@username@domain` or `@username` handle from arbitrary text.
 * Returns the first match. Handles are case-insensitive.
 *
 * Matches both bare ("alice@mony.lol") and at-prefixed ("@alice@mony.lol")
 * forms, since donors don't reliably include the leading @.
 */
function extractHandle(...sources: (string | null | undefined)[]): ParsedHandle | null {
  // Username chars per ActivityPub convention; domain chars per DNS.
  const HANDLE_RE = /@?([a-zA-Z0-9_-]{1,32})(?:@([a-zA-Z0-9.-]{1,253}))?/g;
  for (const source of sources) {
    if (!source) continue;
    HANDLE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HANDLE_RE.exec(source)) !== null) {
      // Require either an explicit @ prefix OR a domain part - otherwise
      // any random word in the message would match.
      const hasAtPrefix = source[match.index] === '@';
      if (!hasAtPrefix && !match[2]) continue;
      return {
        username: match[1].toLowerCase(),
        domain: match[2]?.toLowerCase() ?? null,
      };
    }
  }
  return null;
}

/**
 * Looks up a profile by username and optional domain.
 * - If `domain` is provided: exact match against that instance.
 * - If `domain` is null: prefer the local user, fall back to any matching
 *   username (but only if unambiguous).
 */
async function findUserByHandle(handle: ParsedHandle, localDomain: string): Promise<MatchedUser | null> {
  const supabase = getSupabaseClient();

  if (handle.domain) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, domain')
      .ilike('username', handle.username)
      .ilike('domain', handle.domain)
      .maybeSingle();
    if (error) {
      logger.error(`kofi: profile lookup by handle+domain failed: ${error.message}`);
      return null;
    }
    return data ? { id: data.id, username: data.username, domain: data.domain } : null;
  }

  // No domain - prefer local match.
  const { data: local } = await supabase
    .from('profiles')
    .select('id, username, domain')
    .ilike('username', handle.username)
    .ilike('domain', localDomain)
    .maybeSingle();
  if (local) return { id: local.id, username: local.username, domain: local.domain };

  const { data: candidates } = await supabase
    .from('profiles')
    .select('id, username, domain')
    .ilike('username', handle.username)
    .limit(2);
  if (candidates?.length === 1) {
    return { id: candidates[0].id, username: candidates[0].username, domain: candidates[0].domain };
  }
  return null;
}

interface FundingConfig {
  id: string;
  kofi_webhook_token: string | null;
  kofi_auto_assign_tier: boolean;
}

async function loadFundingConfig(): Promise<FundingConfig | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('instance_funding')
    .select('id, kofi_webhook_token, kofi_auto_assign_tier')
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.error(`kofi: failed to load funding config: ${error.message}`);
    return null;
  }
  return data as FundingConfig | null;
}

/**
 * POST /webhooks/kofi
 *
 * Always returns 200 OK after successful auth so Ko-fi does not retry on
 * processing errors; a failed match is already persisted to
 * pending_donations. 401/403 are returned only for token mismatches.
 */
router.post('/kofi', webhookLimiter, async (req: Request, res: Response) => {
  // Ko-fi posts the JSON string inside a `data` form field.
  const rawData = (req.body as Record<string, unknown>)?.data;
  if (typeof rawData !== 'string') {
    return sendError(res, 'Missing data field', 400);
  }

  let payload: KofiPayload;
  try {
    const parsed = JSON.parse(rawData);
    const result = KofiPayloadSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn(`kofi: payload schema validation failed: ${JSON.stringify(result.error.issues)}`);
      return sendError(res, 'Invalid payload shape', 400);
    }
    payload = result.data;
  } catch (err) {
    logger.warn(`kofi: payload JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return sendError(res, 'Invalid JSON in data field', 400);
  }

  const cfg = await loadFundingConfig();
  if (!cfg?.kofi_webhook_token) {
    return sendError(res, 'Ko-fi webhook is not configured on this instance', 503);
  }

  // Not constant-time: crypto.timingSafeEqual requires equal-length buffers.
  // The shared-secret model has no HMAC, so plain equality is the bound here.
  if (payload.verification_token !== cfg.kofi_webhook_token) {
    logger.warn(`kofi: verification_token mismatch from ${clientIp(req)}`);
    return sendError(res, 'Invalid verification token', 401);
  }

  // Only Donation and Subscription events count as revenue; Shop Order and
  // Commission are ignored.
  if (payload.type !== 'Donation' && payload.type !== 'Subscription') {
    logger.info(`kofi: ignoring ${payload.type} event (txn=${payload.kofi_transaction_id})`);
    return sendSuccess(res, { status: 'ignored' });
  }

  const amount = Number.parseFloat(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return sendError(res, 'Invalid amount', 400);
  }

  const donation: DonationRecord = {
    platform: 'ko-fi',
    amount,
    currency: payload.currency,
    externalRef: payload.kofi_transaction_id,
    donorName: payload.from_name ?? null,
    donorMessage: payload.message ?? null,
  };

  const handle = extractHandle(payload.message, payload.from_name);
  const localDomain =
    process.env.INSTANCE_DOMAIN ??
    process.env.VITE_DOMAIN ??
    'localhost';

  if (handle) {
    const matched = await findUserByHandle(handle, localDomain);
    if (matched) {
      try {
        await recordMatchedDonation(matched, donation, cfg.kofi_auto_assign_tier);
        return sendSuccess(res, { status: 'recorded', userId: matched.id });
      } catch (err) {
        // Persist to pending so admin can still see it, then 200 so Ko-fi doesn't retry.
        logger.error(
          `kofi: matched donation write failed, queuing as pending: ${err instanceof Error ? err.message : String(err)}`,
        );
        await recordPendingDonation(donation, payload.email ?? null, payload).catch(() => {});
        return sendSuccess(res, { status: 'pending', reason: 'write_failed' });
      }
    }
  }

  await recordPendingDonation(donation, payload.email ?? null, payload);
  return sendSuccess(res, { status: 'pending', reason: handle ? 'no_profile_match' : 'no_handle_in_message' });
});

export default router;
