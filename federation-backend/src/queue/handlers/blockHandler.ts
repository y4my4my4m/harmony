/**
 * Block Federation Job Handler
 * 
 * Processes federate-block jobs (block/unblock notifications)
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';
import type { FederationJobData } from '../BullMQManager.js';

export async function handleBlockJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, block_id, blocker_id, blocked_id } = data;

  logger.info(`🚫 Processing block job: ${type} for block ${block_id}`);

  try {
    // Get blocker profile
    const { data: blocker } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', blocker_id)
      .single();

    if (!blocker || !blocker.is_local) {
      logger.debug('Block from remote user, skipping');
      await updateFederationStatus(block_id, 'user_blocks', 'skipped');
      return;
    }

    // Get blocked profile
    const { data: blocked } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', blocked_id)
      .single();

    if (!blocked || blocked.is_local) {
      logger.debug('Block of local user, no federation needed');
      await updateFederationStatus(block_id, 'user_blocks', 'skipped');
      return;
    }

    await updateFederationStatus(block_id, 'user_blocks', 'processing');

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const blockerActorUrl = `${baseUrl}/users/${blocker.username}`;

    if (type === 'create') {
      // Create Block activity
      const blockActivity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${baseUrl}/activities/block/${block_id}`,
        type: 'Block',
        actor: blockerActorUrl,
        object: blocked.federated_id || blocked.ap_id
      };

      // Send to the blocked user's inbox
      if (blocked.inbox_url) {
        await DeliveryQueue.sendToInbox(blocked.inbox_url, blockActivity, blocker.id);
        logger.info(`✅ Block notification sent to ${blocked.inbox_url}`);
      }
    } else if (type === 'delete') {
      // Create Undo Block activity
      const undoBlockActivity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${baseUrl}/activities/undo-block/${block_id}`,
        type: 'Undo',
        actor: blockerActorUrl,
        object: {
          type: 'Block',
          actor: blockerActorUrl,
          object: blocked.federated_id || blocked.ap_id
        }
      };

      if (blocked.inbox_url) {
        await DeliveryQueue.sendToInbox(blocked.inbox_url, undoBlockActivity, blocker.id);
        logger.info(`✅ Unblock sent to ${blocked.inbox_url}`);
      }
    }

    await updateFederationStatus(block_id, 'user_blocks', 'completed');

  } catch (error) {
    logger.error(`Failed to federate block ${block_id}:`, error);
    await updateFederationStatus(block_id, 'user_blocks', 'failed');
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

