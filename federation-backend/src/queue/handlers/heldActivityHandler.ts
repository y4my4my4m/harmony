/**
 * Delivers an inbound activity an admin released from the suspicious-activity queue.
 * Jobs are queued by review_suspicious_activity (migration 20261005100001); the
 * activity passed signature verification when it arrived and is processed without
 * the spam heuristics.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { logger } from '../../utils/logger.js';

export interface HeldActivityJobData {
  suspicious_activity_id: string;
}

export async function handleReleaseHeldActivityJob(data: HeldActivityJobData): Promise<void> {
  const id = data?.suspicious_activity_id;
  if (typeof id !== 'string' || !id) {
    logger.warn('Release job without suspicious_activity_id, dropped');
    return;
  }

  const { data: row, error } = await getSupabaseClient()
    .from('suspicious_activity')
    .select('id, status, action, activity')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!row || row.status !== 'released' || row.action !== 'held' || !row.activity) {
    logger.warn(`Release job for ${id}: not a released held activity, dropped`);
    return;
  }

  const { ActivityProcessor } = await import('../../activitypub/ActivityProcessor.js');
  await ActivityProcessor.processIncomingActivity(row.activity, { skipSpamGuard: true });
  logger.info(`Released held activity ${id} delivered`);
}
