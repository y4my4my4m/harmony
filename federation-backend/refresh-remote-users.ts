/**
 * Utility to refresh remote user profile data
 * Fetches actor data from remote servers and updates inbox URLs
 * 
 * Run with: npm run refresh-users
 */

import { getSupabaseClient } from './src/config/supabase.js';
import { safeFetch } from './src/utils/ssrfProtection.js';

async function refreshRemoteUser(supabase: any, userId: string, federatedId: string): Promise<boolean> {
  try {
    console.log(`\nFetching actor data for: ${federatedId}`);
    
    // BUGS.md L22: `federatedId` is the stored remote actor URL - refreshing
    // already-known remote rows, but defense-in-depth via safeFetch covers
    // poisoned profile rows from earlier inserts.
    const response = await safeFetch(federatedId, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json',
      },
    });
    
    if (!response.ok) {
      console.error(`❌ Failed to fetch actor ${federatedId}: ${response.status}`);
      return false;
    }
    
    const actor = await response.json();
    console.log(`✅ Fetched actor: ${actor.preferredUsername}`);
    
    // Extract inbox URLs
    const inbox_url = actor.inbox;
    const shared_inbox_url = actor.endpoints?.sharedInbox;
    const outbox_url = actor.outbox;
    const public_key = actor.publicKey?.publicKeyPem;
    
    console.log(`   Inbox: ${inbox_url}`);
    console.log(`   Shared Inbox: ${shared_inbox_url || 'N/A'}`);
    console.log(`   Outbox: ${outbox_url}`);
    
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
      console.error(`❌ Failed to update profile ${userId}:`, error);
      return false;
    }
    
    console.log(`✅ Updated profile in database`);
    
    return true;
  } catch (error) {
    console.error(`❌ Error refreshing ${federatedId}:`, error);
    return false;
  }
}

async function refreshAllRemoteUsers() {
  console.log('🔄 Refreshing all remote user profiles...\n');
  
  const supabase = getSupabaseClient();
  
  // Get all remote users - use select('*') like the check script
  const { data: remoteUsers, error: queryError } = await supabase
    .from('profiles')
    .select('*')
    .eq('is_local', false);
  
  if (queryError) {
    console.error('❌ Error querying remote users:', queryError);
    return;
  }
  
  if (!remoteUsers || remoteUsers.length === 0) {
    console.log('⚠️  No remote users found');
    return;
  }
  
  console.log(`Found ${remoteUsers.length} remote users\n`);
  
  let updated = 0;
  let failed = 0;
  
  for (const user of remoteUsers) {
    console.log('='.repeat(70));
    console.log(`Processing: ${user.username}@${user.domain}`);
    
    if (!user.federated_id) {
      console.log(`⚠️  No federated_id, skipping`);
      failed++;
      continue;
    }
    
    const success = await refreshRemoteUser(supabase, user.id, user.federated_id);
    if (success) {
      updated++;
    } else {
      failed++;
    }
    
    // Wait a bit between requests to be polite
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('📊 Results:');
  console.log(`  ✅ Updated: ${updated}`);
  console.log(`  ❌ Failed: ${failed}`);
}

// Run the refresh
refreshAllRemoteUsers().then(() => {
  console.log('\n✅ Refresh complete\n');
  process.exit(0);
}).catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});

