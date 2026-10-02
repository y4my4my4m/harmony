/**
 * Reaction Federation Job Handler
 *
 * Processes federate-reaction jobs: favourites and emoji reactions on posts, encoded per
 * receiving software by postEngagement.ts. Bookmarks are private; a reblog federates as the
 * Announce of its boost post.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import {
  federatePostEngagement,
  isLikeInteraction,
  type PostEngagementEvent,
} from '../../activitypub/postEngagement.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../BullMQManager.js';

export async function handleReactionJob(data: FederationJobData): Promise<void> {
  const event = data as unknown as PostEngagementEvent;
  const isCreate = event.type === 'create';

  logger.info(`Processing reaction job: ${event.type} for interaction ${event.interaction_id}`);

  if (event.type !== 'create' && event.type !== 'delete') {
    logger.warn(`Unknown reaction job type: ${event.type}`);
    return;
  }

  if (!isLikeInteraction(event.interaction_type)) {
    logger.info(`${event.interaction_type} ${event.interaction_id} federates nothing, skipping`);
    if (isCreate) await updateFederationStatus(event.interaction_id, 'skipped');
    return;
  }

  try {
    if (isCreate) await updateFederationStatus(event.interaction_id, 'processing');
    const outcome = await federatePostEngagement(event);
    if (isCreate) await updateFederationStatus(event.interaction_id, outcome);
  } catch (error) {
    logger.error(`Failed to federate reaction ${event.interaction_id}:`, error);
    if (isCreate) await updateFederationStatus(event.interaction_id, 'failed');
    throw error;
  }
}

async function updateFederationStatus(id: string, status: string): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase.from('post_interactions').update({ federation_status: status }).eq('id', id);
}
