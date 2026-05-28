/**
 * Follow Federation Job Handler
 * 
 * Processes federate-follow jobs (follow/unfollow requests)
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';
import type { FederationJobData } from '../BullMQManager.js';

export async function handleFollowJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, follow_id, follower_id, following_id } = data;

  logger.info(`👥 Processing follow job: ${type} for follow ${follow_id}`);

  try {
    // Get follower profile
    const { data: follower } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', follower_id)
      .single();

    if (!follower || !follower.is_local) {
      logger.debug('Follow from remote user, skipping outgoing federation');
      await updateFederationStatus(follow_id, 'follows', 'skipped');
      return;
    }

    // Get following profile
    const { data: following } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', following_id)
      .single();

    if (!following || following.is_local) {
      logger.debug('Follow of local user, no federation needed');
      await updateFederationStatus(follow_id, 'follows', 'skipped');
      return;
    }

    await updateFederationStatus(follow_id, 'follows', 'processing');

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const followerActorUrl = `${baseUrl}/users/${follower.username}`;

    if (type === 'create') {
      // Create Follow activity
      const followActivity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${baseUrl}/activities/follow/${follow_id}`,
        type: 'Follow',
        actor: followerActorUrl,
        object: following.federated_id || following.ap_id
      };

      // Send to the followed user's inbox
      if (following.inbox_url) {
        await DeliveryQueue.sendToInbox(following.inbox_url, followActivity, follower.id);
        logger.info(`✅ Follow request sent to ${following.inbox_url}`);
      }
    } else if (type === 'delete') {
      // Create Undo Follow activity
      const undoFollowActivity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${baseUrl}/activities/undo-follow/${follow_id}`,
        type: 'Undo',
        actor: followerActorUrl,
        object: {
          type: 'Follow',
          actor: followerActorUrl,
          object: following.federated_id || following.ap_id
        }
      };

      if (following.inbox_url) {
        await DeliveryQueue.sendToInbox(following.inbox_url, undoFollowActivity, follower.id);
        logger.info(`✅ Unfollow sent to ${following.inbox_url}`);
      }
    }

    await updateFederationStatus(follow_id, 'follows', 'completed');

  } catch (error) {
    logger.error(`Failed to federate follow ${follow_id}:`, error);
    await updateFederationStatus(follow_id, 'follows', 'failed');
    throw error;
  }
}

async function updateFederationStatus(
  id: string,
  table: string,
  status: string
): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase.from(table).update({ federation_status: status }).eq('id', id);
}

