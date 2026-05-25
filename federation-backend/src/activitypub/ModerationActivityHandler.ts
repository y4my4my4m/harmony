/**
 * ModerationActivityHandler - Federated server moderation
 * 
 * Handles federation of moderation actions:
 * - Kick: Remove activity (temporary removal from server)
 * - Ban: harmony:Ban activity (permanent removal with block)
 * - Unban: Undo harmony:Ban activity
 * 
 * These activities are sent from the server actor (Group) to notify
 * other instances when their users have been moderated.
 */

import { getSupabaseClient } from '../config/supabase.js';
import { DeliveryQueue } from '../activitypub/DeliveryQueue.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';

// =============================================================================
// TYPES
// =============================================================================

interface KickPayload {
  server_id: string;
  user_id: string;
  reason?: string;
  moderator_id: string;
}

interface BanPayload {
  server_id: string;
  user_id: string;
  reason?: string;
  moderator_id: string;
  duration?: number; // In seconds, null = permanent
}

interface UnbanPayload {
  server_id: string;
  user_id: string;
  moderator_id: string;
}

// =============================================================================
// KICK HANDLER
// =============================================================================

/**
 * Federate a kick action (Remove activity)
 * Used when a user is removed from a server but not banned
 */
export async function federateKick(payload: KickPayload): Promise<void> {
  try {
    const { server_id, user_id, reason, moderator_id } = payload;
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;

    logger.info(`👢 Federating kick: user ${user_id} from server ${server_id}`);

    // Get server
    const { data: server } = await supabase
      .from('servers')
      .select('*')
      .eq('id', server_id)
      .single();

    if (!server || !server.federation_enabled) {
      return;
    }

    // Get the kicked user
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id, is_local, inbox_url, domain')
      .eq('id', user_id)
      .single();

    if (!user) {
      logger.warn('User not found for kick federation');
      return;
    }

    // Only federate if user is from a remote instance
    if (user.is_local) {
      logger.info('Kicked user is local, no federation needed');
      return;
    }

    const serverUrl = `https://${hostDomain}/servers/${server_id}`;
    const userApId = user.federated_id || `https://${user.domain}/users/${user.username}`;

    // Create Remove activity
    const removeActivity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        { 'harmony': 'https://harmonyapp.dev/ns#' },
      ],
      id: `${serverUrl}/activities/${crypto.randomUUID()}`,
      type: 'Remove',
      actor: serverUrl,
      object: userApId,
      target: serverUrl,
      summary: reason || 'Removed from server',
      published: new Date().toISOString(),
    };

    // Send to user's inbox
    if (user.inbox_url) {
      await DeliveryQueue.sendToInbox(user.inbox_url, removeActivity, moderator_id);
      logger.info(`👢 Sent kick notification to ${user.inbox_url}`);
    }

    // Also send to the user's home instance shared inbox
    if (user.domain) {
      const sharedInbox = `https://${user.domain}/inbox`;
      await DeliveryQueue.sendToInbox(sharedInbox, removeActivity, moderator_id);
    }

    logger.info(`👢 Kick federated for user ${user.username}`);
  } catch (error) {
    logger.error('Error federating kick:', error);
  }
}

// =============================================================================
// BAN HANDLER
// =============================================================================

/**
 * Federate a ban action (harmony:Ban activity)
 * Used when a user is permanently banned from a server
 */
export async function federateBan(payload: BanPayload): Promise<void> {
  try {
    const { server_id, user_id, reason, moderator_id, duration } = payload;
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;

    logger.info(`🔨 Federating ban: user ${user_id} from server ${server_id}`);

    // Get server
    const { data: server } = await supabase
      .from('servers')
      .select('*')
      .eq('id', server_id)
      .single();

    if (!server || !server.federation_enabled) {
      return;
    }

    // Get the banned user
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id, is_local, inbox_url, domain')
      .eq('id', user_id)
      .single();

    if (!user) {
      logger.warn('User not found for ban federation');
      return;
    }

    // Only federate if user is from a remote instance
    if (user.is_local) {
      logger.info('Banned user is local, no federation needed');
      return;
    }

    const serverUrl = `https://${hostDomain}/servers/${server_id}`;
    const userApId = user.federated_id || `https://${user.domain}/users/${user.username}`;

    // Calculate expiry if duration is set
    let expiresAt: string | undefined;
    if (duration && duration > 0) {
      expiresAt = new Date(Date.now() + duration * 1000).toISOString();
    }

    // Create harmony:Ban activity
    const banActivity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        {
          'harmony': 'https://harmonyapp.dev/ns#',
          'Ban': 'harmony:Ban',
          'expiresAt': 'harmony:expiresAt',
        },
      ],
      id: `${serverUrl}/activities/${crypto.randomUUID()}`,
      type: 'harmony:Ban',
      actor: serverUrl,
      object: userApId,
      target: serverUrl,
      summary: reason || 'Banned from server',
      'harmony:expiresAt': expiresAt,
      published: new Date().toISOString(),
    };

    // Send to user's inbox
    if (user.inbox_url) {
      await DeliveryQueue.sendToInbox(user.inbox_url, banActivity, moderator_id);
      logger.info(`🔨 Sent ban notification to ${user.inbox_url}`);
    }

    // Also send to the user's home instance shared inbox
    if (user.domain) {
      const sharedInbox = `https://${user.domain}/inbox`;
      await DeliveryQueue.sendToInbox(sharedInbox, banActivity, moderator_id);
    }

    logger.info(`🔨 Ban federated for user ${user.username}`);
  } catch (error) {
    logger.error('Error federating ban:', error);
  }
}

// =============================================================================
// UNBAN HANDLER
// =============================================================================

/**
 * Federate an unban action (Undo harmony:Ban activity)
 */
export async function federateUnban(payload: UnbanPayload): Promise<void> {
  try {
    const { server_id, user_id, moderator_id } = payload;
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;

    logger.info(`✅ Federating unban: user ${user_id} from server ${server_id}`);

    // Get server
    const { data: server } = await supabase
      .from('servers')
      .select('*')
      .eq('id', server_id)
      .single();

    if (!server || !server.federation_enabled) {
      return;
    }

    // Get the unbanned user
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id, is_local, inbox_url, domain')
      .eq('id', user_id)
      .single();

    if (!user) {
      return;
    }

    if (user.is_local) {
      return;
    }

    const serverUrl = `https://${hostDomain}/servers/${server_id}`;
    const userApId = user.federated_id || `https://${user.domain}/users/${user.username}`;

    // Create Undo Ban activity
    const undoBanActivity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        { 'harmony': 'https://harmonyapp.dev/ns#' },
      ],
      id: `${serverUrl}/activities/${crypto.randomUUID()}`,
      type: 'Undo',
      actor: serverUrl,
      object: {
        type: 'harmony:Ban',
        actor: serverUrl,
        object: userApId,
        target: serverUrl,
      },
      published: new Date().toISOString(),
    };

    // Send to user's inbox
    if (user.inbox_url) {
      await DeliveryQueue.sendToInbox(user.inbox_url, undoBanActivity, moderator_id);
    }

    // Also send to home instance
    if (user.domain) {
      const sharedInbox = `https://${user.domain}/inbox`;
      await DeliveryQueue.sendToInbox(sharedInbox, undoBanActivity, moderator_id);
    }

    logger.info(`✅ Unban federated for user ${user.username}`);
  } catch (error) {
    logger.error('Error federating unban:', error);
  }
}

// =============================================================================
// INCOMING MODERATION HANDLER
// =============================================================================

/**
 * Process incoming ban activity from remote server
 */
export async function processIncomingBan(activity: any): Promise<void> {
  const supabase = getSupabaseClient();
  
  // Extract server and user info
  const serverApId = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
  const userApId = typeof activity.object === 'string' ? activity.object : activity.object?.id;

  if (!serverApId || !userApId) {
    logger.warn('Invalid ban activity: missing actor or object');
    return;
  }

  logger.info(`🔨 Processing incoming ban from ${serverApId} for ${userApId}`);

  // Find the local server reference
  const { data: server } = await supabase
    .from('servers')
    .select('id')
    .eq('ap_id', serverApId)
    .single();

  if (!server) {
    logger.warn('Server not found for incoming ban');
    return;
  }

  // Find the user
  const { data: user } = await supabase
    .from('profiles')
    .select('id, is_local')
    .eq('federated_id', userApId)
    .single();

  if (!user) {
    logger.warn('User not found for incoming ban');
    return;
  }

  // If user is local, remove them from the server
  if (user.is_local) {
    await supabase
      .from('user_servers')
      .delete()
      .eq('server_id', server.id)
      .eq('user_id', user.id);

    logger.info(`🔨 Local user ${user.id} banned from remote server ${server.id}`);
  }
}

/**
 * Process incoming Remove activity (kick) from remote server
 */
export async function processIncomingKick(activity: any): Promise<void> {
  const supabase = getSupabaseClient();
  
  const serverApId = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
  const userApId = typeof activity.object === 'string' ? activity.object : activity.object?.id;

  if (!serverApId || !userApId) {
    return;
  }

  logger.info(`👢 Processing incoming kick from ${serverApId} for ${userApId}`);

  // Find the local server reference
  const { data: server } = await supabase
    .from('servers')
    .select('id')
    .eq('ap_id', serverApId)
    .single();

  if (!server) {
    return;
  }

  // Find the user
  const { data: user } = await supabase
    .from('profiles')
    .select('id, is_local')
    .eq('federated_id', userApId)
    .single();

  if (!user?.is_local) {
    return;
  }

  // Remove from server
  await supabase
    .from('user_servers')
    .delete()
    .eq('server_id', server.id)
    .eq('user_id', user.id);

  logger.info(`👢 Local user ${user.id} kicked from remote server ${server.id}`);
}

/**
 * Process incoming Undo Ban activity
 */
export async function processIncomingUnban(activity: any): Promise<void> {
  const supabase = getSupabaseClient();
  const object = activity.object;

  if (!object || object.type !== 'harmony:Ban') {
    return;
  }

  const serverApId = typeof object.actor === 'string' ? object.actor : object.actor?.id;
  const userApId = typeof object.object === 'string' ? object.object : object.object?.id;

  if (!serverApId || !userApId) {
    return;
  }

  logger.info(`✅ Processing incoming unban from ${serverApId} for ${userApId}`);

  // Find the local server reference
  const { data: server } = await supabase
    .from('servers')
    .select('id')
    .eq('ap_id', serverApId)
    .single();

  if (!server) {
    return;
  }

  // Find the user
  const { data: user } = await supabase
    .from('profiles')
    .select('id')
    .eq('federated_id', userApId)
    .single();

  if (!user) {
    return;
  }

  // Remove from server_bans if exists
  await supabase
    .from('server_bans')
    .delete()
    .eq('server_id', server.id)
    .eq('user_id', user.id);

  logger.info(`✅ Ban lifted for user ${user.id} on server ${server.id}`);
}

