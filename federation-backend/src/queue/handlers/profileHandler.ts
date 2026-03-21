/**
 * Profile Federation Job Handler
 * 
 * Processes federate-profile jobs (local user profile updates)
 * Sends Update Person activities to followers
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { profileToActor } from '../../activitypub/converters/toActivityPub.js';
import { resolveLocalProfileEmojis } from '../../activitypub/emojiResolver.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';
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

    await DeliveryQueue.broadcastToFollowers(profile.id, updateActivity);
    
    logger.info(`✅ Profile update federated for ${profile.username}`);

  } catch (error) {
    logger.error(`Failed to federate profile update for ${profile_id}:`, error);
    throw error;
  }
}

