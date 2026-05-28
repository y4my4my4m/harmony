/**
 * Check remote user details
 * Run with: tsx check-remote-users.ts
 */

import { getSupabaseClient } from './src/config/supabase.js';

const supabase = getSupabaseClient();

async function checkRemoteUsers() {
  console.log('🔍 Checking Remote User Details\n');
  
  const { data: remoteUsers } = await supabase
    .from('profiles')
    .select('*')
    .eq('is_local', false);
  
  if (!remoteUsers || remoteUsers.length === 0) {
    console.log('No remote users found');
    return;
  }
  
  for (const user of remoteUsers) {
    console.log('='.repeat(70));
    console.log(`User: ${user.username}@${user.domain}`);
    console.log('='.repeat(70));
    console.log(`ID: ${user.id}`);
    console.log(`Federated ID: ${user.federated_id || '❌ MISSING'}`);
    console.log(`Inbox URL: ${user.inbox_url || '❌ MISSING'}`);
    console.log(`Shared Inbox URL: ${user.shared_inbox_url || '❌ MISSING'}`);
    console.log(`Outbox URL: ${user.outbox_url || '❌ MISSING'}`);
    console.log(`Public Key: ${user.public_key ? 'Present' : '❌ MISSING'}`);
    console.log('');
  }
  
  const missingSharedInbox = remoteUsers.filter(u => !u.shared_inbox_url);
  const missingInbox = remoteUsers.filter(u => !u.inbox_url);
  
  console.log('\n📊 Summary:');
  console.log(`Total remote users: ${remoteUsers.length}`);
  console.log(`Missing inbox_url: ${missingInbox.length}`);
  console.log(`Missing shared_inbox_url: ${missingSharedInbox.length} ⚠️`);
  
  if (missingSharedInbox.length > 0) {
    console.log('\n⚠️  WARNING: Remote users missing shared_inbox_url!');
    console.log('This is likely why Misskey isn\'t receiving your posts.');
    console.log('\nRun: npm run refresh-users');
  }
}

checkRemoteUsers().then(() => {
  console.log('\n✅ Check complete\n');
  process.exit(0);
}).catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});

