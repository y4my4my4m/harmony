/**
 * Profile Federation Job Handler
 * 
 * Processes federate-profile jobs (local user profile updates)
 * Sends Update Person activities to followers
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';
import type { FederationJobData } from '../QueueManager.js';

export async function handleProfileJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { profile_id, username, display_name, bio, avatar_url, banner_url } = data;

  logger.info(`👤 Processing profile update job for: ${username}`);

  try {
    // Get full profile
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

    // Create Update Person activity
    const updateActivity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        'https://w3id.org/security/v1'
      ],
      id: `${actorUrl}#updates/${Date.now()}`,
      type: 'Update',
      actor: actorUrl,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: {
        id: actorUrl,
        type: 'Person',
        preferredUsername: profile.username,
        name: profile.display_name || profile.username,
        summary: profile.bio || '',
        url: `https://${domain}/@${profile.username}`,
        icon: profile.avatar_url ? {
          type: 'Image',
          mediaType: 'image/png',
          url: profile.avatar_url
        } : undefined,
        image: profile.banner_url ? {
          type: 'Image',
          mediaType: 'image/png',
          url: profile.banner_url
        } : undefined,
        inbox: `${actorUrl}/inbox`,
        outbox: `${actorUrl}/outbox`,
        followers: `${actorUrl}/followers`,
        following: `${actorUrl}/following`,
        publicKey: {
          id: `${actorUrl}#main-key`,
          owner: actorUrl,
          publicKeyPem: profile.public_key
        }
      }
    };

    // Broadcast to followers
    await DeliveryQueue.broadcastToFollowers(profile.id, updateActivity);
    
    logger.info(`✅ Profile update federated for ${profile.username}`);

  } catch (error) {
    logger.error(`Failed to federate profile update for ${profile_id}:`, error);
    throw error;
  }
}

