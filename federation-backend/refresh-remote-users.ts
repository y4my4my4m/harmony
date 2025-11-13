/**
 * Utility to refresh remote user profile data
 * Fetches actor data from remote servers and updates inbox URLs
 * 
 * Run with: npm run refresh-users
 */

import { getSupabaseClient } from './src/config/supabase.js';
import { actorToProfile } from './src/activitypub/converters/fromActivityPub.js';
import { logger } from './src/utils/logger.js';

const supabase = getSupabaseClient();

async function refreshRemoteUser(userId: string, federatedId: string): Promise<boolean> {
  try {
    logger.info(`Fetching actor data for: ${federatedId}`);
    
    const response = await fetch(federatedId, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json',
      },
    });
    
    if (!response.ok) {
      logger.error(`Failed to fetch actor ${federatedId}: ${response.status}`);
      return false;
    }
    
    const actor = await response.json();
    logger.info(`Fetched actor: ${actor.preferredUsername}`);
    
    // Extract inbox URLs
    const inbox_url = actor.inbox;
    const shared_inbox_url = actor.endpoints?.sharedInbox;
    const outbox_url = actor.outbox;
    const public_key = actor.publicKey?.publicKeyPem;
    
    // Update profile
    const { error } = await supabase
      .from('profiles')
      .update({
        inbox_url,
        shared_inbox_url,
        outbox_url,
        public_key,
      })
      .eq('id', userId);
    
    if (error) {
      logger.error(`Failed to update profile ${userId}:`, error);
      return false;
    }
    
    logger.info(`✅ Updated profile for ${federatedId}`);
    logger.info(`  Inbox: ${inbox_url}`);
    logger.info(`  Shared Inbox: ${shared_inbox_url || 'N/A'}`);
    logger.info(`  Outbox: ${outbox_url}`);
    
    return true;
  } catch (error) {
    logger.error(`Error refreshing ${federatedId}:`, error);
    return false;
  }
}

async function refreshAllRemoteUsers() {
  logger.info('🔄 Refreshing all remote user profiles...\n');
  
  // Get all remote users
  const { data: remoteUsers } = await supabase
    .from('profiles')
    .select('id, username, domain, federated_id, inbox_url, shared_inbox_url')
    .eq('is_local', false);
  
  if (!remoteUsers || remoteUsers.length === 0) {
    logger.info('No remote users found');
    return;
  }
  
  logger.info(`Found ${remoteUsers.length} remote users\n`);
  
  let updated = 0;
  let failed = 0;
  
  for (const user of remoteUsers) {
    if (!user.federated_id) {
      logger.warn(`User ${user.username}@${user.domain} has no federated_id, skipping`);
      failed++;
      continue;
    }
    
    const success = await refreshRemoteUser(user.id, user.federated_id);
    if (success) {
      updated++;
    } else {
      failed++;
    }
    
    // Wait a bit between requests to be polite
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  logger.info(`\n📊 Results:`);
  logger.info(`  ✅ Updated: ${updated}`);
  logger.info(`  ❌ Failed: ${failed}`);
}

// Run the refresh
refreshAllRemoteUsers().then(() => {
  logger.info('\n✅ Refresh complete');
  process.exit(0);
}).catch(err => {
  logger.error('❌ Error:', err);
  process.exit(1);
});

