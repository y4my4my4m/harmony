/**
 * Diagnostic script to check federation data
 * Run with: npm run diagnose [username]
 * 
 * Example: npm run diagnose y4my4m
 */

import { getSupabaseClient } from './src/config/supabase.js';

const supabase = getSupabaseClient();
const username = process.argv[2] || 'y4my4m';

async function diagnose() {
  console.log('🔍 Federation Diagnostics\n');
  
  // Get user ID
  const { data: localUser } = await supabase
    .from('profiles')
    .select('id, username, domain')
    .eq('username', username)
    .eq('is_local', true)
    .single();
  
  if (!localUser) {
    console.error(`User '${username}' not found`);
    process.exit(1);
  }
  
  console.log(`User: ${localUser.username}@${localUser.domain}`);
  console.log(`ID: ${localUser.id}\n`);
  
  // Check remote followers
  console.log('=== REMOTE FOLLOWERS ===');
  const { data: followers } = await supabase
    .from('follows')
    .select(`
      id,
      status,
      ap_activity_id,
      profiles!follows_follower_id_fkey (
        username,
        domain,
        is_local,
        inbox_url,
        shared_inbox_url,
        federated_id
      )
    `)
    .eq('following_id', localUser.id)
    .eq('status', 'accepted');
  
  console.log(`Found ${followers?.length || 0} followers:\n`);
  followers?.forEach((f: any) => {
    const profile = f.profiles;
    console.log(`User: ${profile.username}@${profile.domain}`);
    console.log(`  Is Local: ${profile.is_local}`);
    console.log(`  Inbox URL: ${profile.inbox_url || '❌ MISSING'}`);
    console.log(`  Shared Inbox: ${profile.shared_inbox_url || '⚠️  MISSING'}`);
    console.log(`  Federated ID: ${profile.federated_id || '❌ MISSING'}`);
    console.log(`  AP Activity ID: ${f.ap_activity_id || '⚠️  MISSING'}`);
    console.log('');
  });
  
  // Check who we're following
  console.log('\n=== USERS WE FOLLOW ===');
  const { data: following } = await supabase
    .from('follows')
    .select(`
      id,
      status,
      ap_activity_id,
      profiles!follows_following_id_fkey (
        username,
        domain,
        is_local,
        inbox_url,
        shared_inbox_url,
        federated_id,
        outbox_url
      )
    `)
    .eq('follower_id', localUser.id)
    .eq('status', 'accepted');
  
  console.log(`Following ${following?.length || 0} users:\n`);
  following?.forEach((f: any) => {
    const profile = f.profiles;
    console.log(`User: ${profile.username}@${profile.domain}`);
    console.log(`  Is Local: ${profile.is_local}`);
    console.log(`  Inbox URL: ${profile.inbox_url || '❌ MISSING'}`);
    console.log(`  Shared Inbox: ${profile.shared_inbox_url || '⚠️  MISSING'}`);
    console.log(`  Outbox URL: ${profile.outbox_url || '❌ MISSING'}`);
    console.log(`  Federated ID: ${profile.federated_id || '❌ MISSING'}`);
    console.log(`  AP Activity ID: ${f.ap_activity_id || '⚠️  MISSING'}`);
    console.log('');
  });
  
  // Check for any remote users
  console.log('\n=== ALL REMOTE USERS SUMMARY ===');
  const { data: remoteUsers } = await supabase
    .from('profiles')
    .select('username, domain, inbox_url, shared_inbox_url, federated_id')
    .eq('is_local', false);
  
  const withSharedInbox = remoteUsers?.filter(u => u.shared_inbox_url).length || 0;
  const withoutInbox = remoteUsers?.filter(u => !u.inbox_url).length || 0;
  
  console.log(`Total remote users: ${remoteUsers?.length || 0}`);
  console.log(`  With shared inbox: ${withSharedInbox}`);
  console.log(`  Missing inbox URL: ${withoutInbox}`);
  
  if (withoutInbox > 0) {
    console.log('\n⚠️  WARNING: Some remote users missing inbox URLs!');
    console.log('Run: npm run refresh-users');
  }
}

diagnose().then(() => {
  console.log('\n✅ Diagnostics complete');
  process.exit(0);
}).catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});

