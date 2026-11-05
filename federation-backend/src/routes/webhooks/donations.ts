/**
 * Donation recording shared by the provider webhooks (Ko-fi, Stripe).
 *
 * - A donation attributed to a profile: supporter row upserted, history row inserted, tier
 *   recomputed from the cycle total when the provider's auto-assign flag is on.
 * - An unattributed donation: a row in `instance_pending_donations` for admin review.
 *
 * Both are idempotent on `(platform, external_reference)`: the history table's partial
 * unique index and the pending table's unique constraint turn provider retries into no-ops.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { logger } from '../../utils/logger.js';

export type DonationPlatform = 'ko-fi' | 'stripe';

export interface DonationRecord {
  platform: DonationPlatform;
  amount: number;
  currency: string;
  externalRef: string;
  donorName: string | null;
  donorMessage: string | null;
}

export interface MatchedUser {
  id: string;
  username: string;
  domain: string | null;
}

/**
 * Recomputes a user's tier from their cumulative cycle donations through
 * recompute_supporter_tier, which also writes the supporter row. NULL: no tier reached.
 */
async function recomputeUserTier(platform: DonationPlatform, userId: string): Promise<string | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('recompute_supporter_tier', {
    p_user_id: userId,
  });
  if (error) {
    logger.error(`${platform}: tier recompute failed for ${userId}: ${error.message}`);
    return null;
  }
  return (data as string | null) ?? null;
}

/** Returns 'duplicate' when this external reference was already recorded. */
export async function recordMatchedDonation(
  matchedUser: MatchedUser,
  donation: DonationRecord,
  autoAssignTier: boolean,
): Promise<'recorded' | 'duplicate'> {
  const supabase = getSupabaseClient();
  const { platform } = donation;

  // Tier is recomputed from the cycle total below, not derived from this donation.
  const { data: supporter, error: upsertErr } = await supabase
    .from('instance_supporters')
    .upsert(
      {
        user_id: matchedUser.id,
        amount: donation.amount,
        platform,
        is_active: true,
        started_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    .select('id')
    .single();

  if (upsertErr || !supporter) {
    logger.error(`${platform}: supporter upsert failed for user ${matchedUser.id}: ${upsertErr?.message ?? 'no row returned'}`);
    throw upsertErr ?? new Error('Supporter upsert returned no row');
  }

  const { error: histErr } = await supabase
    .from('instance_donation_history')
    .insert({
      supporter_id: supporter.id,
      user_id: matchedUser.id,
      amount: donation.amount,
      currency: donation.currency,
      platform,
      external_reference: donation.externalRef,
      note: donation.donorMessage ?? null,
    });

  if (histErr) {
    if (histErr.code === '23505') {
      logger.info(`${platform}: duplicate transaction ${donation.externalRef} ignored (already recorded)`);
      return 'duplicate';
    }
    logger.error(`${platform}: donation_history insert failed: ${histErr.message}`);
    throw histErr;
  }

  // Auto-assign off: admins manage the tier by hand.
  let resolvedTierId: string | null = null;
  if (autoAssignTier) {
    resolvedTierId = await recomputeUserTier(platform, matchedUser.id);
  }

  const handle = `@${matchedUser.username}${matchedUser.domain ? '@' + matchedUser.domain : ''}`;
  logger.info(
    `${platform}: recorded ${donation.currency} ${donation.amount} from ${handle} ` +
    `(txn=${donation.externalRef}, tier=${resolvedTierId ?? 'none'})`,
  );
  return 'recorded';
}

export async function recordPendingDonation(
  donation: DonationRecord,
  donorEmail: string | null,
  rawPayload: unknown,
): Promise<void> {
  const supabase = getSupabaseClient();
  const { platform } = donation;
  const { error } = await supabase
    .from('instance_pending_donations')
    .insert({
      platform,
      external_reference: donation.externalRef,
      amount: donation.amount,
      currency: donation.currency,
      donor_name: donation.donorName,
      donor_email: donorEmail,
      donor_message: donation.donorMessage,
      raw_payload: rawPayload,
    });

  if (error) {
    if (error.code === '23505') {
      logger.info(`${platform}: duplicate pending entry ${donation.externalRef} ignored`);
      return;
    }
    logger.error(`${platform}: pending_donations insert failed: ${error.message}`);
    throw error;
  }

  logger.info(
    `${platform}: queued ${donation.currency} ${donation.amount} (txn=${donation.externalRef}) for manual review`,
  );
}
