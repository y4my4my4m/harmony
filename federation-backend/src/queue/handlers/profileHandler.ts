/**
 * Profile Federation Job Handler
 * 
 * Processes federate-profile jobs (local user profile updates)
 * Sends Update Person activities to followers AND server co-member instances
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { profileToActor } from '../../activitypub/converters/toActivityPub.js';
import { resolveLocalProfileEmojis } from '../../activitypub/emojiResolver.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';
import { getServerCoMemberInstances } from '../../utils/federationUtils.js';
import type { FederationJobData } from '../BullMQManager.js';

export async function handleProfileJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { profile_id, username } = data;

  logger.info(`👤 Processing profile update job for: ${username}`);

  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', profile_id)
      .single();

    if (!profile || !profile.is_local) {
      logger.debug('Profile not found or not local, skipping');
      return;
    }

    const domain = config.INSTANCE_DOMAIN;
    const actorUrl = `https://${domain}/users/${profile.username}`;

    // Resolve emoji shortcodes so the Actor includes proper tags
    await resolveLocalProfileEmojis(profile, supabase);

    const actor = profileToActor(profile);

    const updateActivity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        'https://w3id.org/security/v1'
      ],
      id: `${actorUrl}#updates/${Date.now()}`,
      type: 'Update',
      actor: actorUrl,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: actor,
    };

    // Broadcast to followers (existing behavior)
    await DeliveryQueue.broadcastToFollowers(profile.id, updateActivity);

    // Also broadcast to all remote instances where the user shares servers.
    const coMemberGroups = await getServerCoMemberInstances(profile.id);
    if (coMemberGroups.length > 0) {
      let deliveredCount = 0;
      for (const group of coMemberGroups) {
        const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
        await DeliveryQueue.enqueue(updateActivity, inbox, profile.id);
        deliveredCount++;
      }
      logger.info(`📡 Profile update also sent to ${deliveredCount} server co-member instances`);
    }
    
    logger.info(`✅ Profile update federated for ${profile.username}`);

  } catch (error) {
    logger.error(`Failed to federate profile update for ${profile_id}:`, error);
    throw error;
  }
}

