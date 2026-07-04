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
    const { data: follower } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', follower_id)
      .single();

    const { data: following } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', following_id)
      .single();

    // 'respond' = local user resolved a remote follower's pending request;
    // deliver Accept/Reject back to the follower (inverse direction of
    // create/delete, which federate a LOCAL follower's actions outward).
    // federation_status lifecycle mirrors 'create': the trigger stamps
    // 'pending' (sweep retry marker), we move it to processing/completed.
    if (type === 'respond') {
      if (!follower || follower.is_local || !following || !following.is_local) {
        logger.debug('Follow response needs remote follower + local target, skipping');
        await updateFederationStatus(follow_id, 'follows', 'skipped');
        return;
      }
      await updateFederationStatus(follow_id, 'follows', 'processing');
      const sent = await sendFollowResponse(data, follower, following);
      await updateFederationStatus(follow_id, 'follows', sent ? 'completed' : 'skipped');
      return;
    }

    if (!follower || !follower.is_local) {
      logger.debug('Follow from remote user, skipping outgoing federation');
      await updateFederationStatus(follow_id, 'follows', 'skipped');
      return;
    }

    if (!following || following.is_local) {
      logger.debug('Follow of local user, no federation needed');
      await updateFederationStatus(follow_id, 'follows', 'skipped');
      return;
    }

    await updateFederationStatus(follow_id, 'follows', 'processing');

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const followerActorUrl = `${baseUrl}/users/${follower.username}`;

    if (type === 'create') {
      const followActivity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${baseUrl}/activities/follow/${follow_id}`,
        type: 'Follow',
        actor: followerActorUrl,
        object: following.federated_id || following.ap_id
      };

      if (following.inbox_url) {
        await DeliveryQueue.sendToInbox(following.inbox_url, followActivity, follower.id);
        logger.info(`✅ Follow request sent to ${following.inbox_url}`);
      }
    } else if (type === 'delete') {
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

async function sendFollowResponse(
  data: FederationJobData,
  follower: any,
  following: any,
): Promise<boolean> {
  const { status, ap_id } = data;

  if (status !== 'accepted' && status !== 'rejected') {
    logger.warn(`Follow response with unexpected status '${status}', skipping`);
    return false;
  }
  if (!follower.inbox_url) {
    logger.warn(`Cannot federate follow ${status}: follower ${follower.username} has no inbox_url`);
    return false;
  }

  // Remote side matches the Accept/Reject on object.id = their original
  // Follow activity id, which processFollow stored in follows.ap_id.
  const followActivity = {
    id: ap_id,
    type: 'Follow',
    actor: follower.federated_id,
    object: `https://${config.INSTANCE_DOMAIN}/users/${following.username}`,
  };

  const { createAcceptActivity, createRejectActivity } = await import('../../activitypub/converters/toActivityPub.js');
  const activity = status === 'accepted'
    ? createAcceptActivity(following, followActivity)
    : createRejectActivity(following, followActivity);

  await DeliveryQueue.sendToInbox(follower.inbox_url, activity, following.id);
  logger.info(`✅ Follow ${status === 'accepted' ? 'Accept' : 'Reject'} sent to ${follower.inbox_url}`);
  return true;
}

async function updateFederationStatus(
  id: string,
  table: string,
  status: string
): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase.from(table).update({ federation_status: status }).eq('id', id);
}

