/**
 * Check why Misskey posts aren't being received
 */

import { getSupabaseClient } from './src/config/supabase.js';

const supabase = getSupabaseClient();

async function checkMisskey() {
  console.log('🔍 Checking Misskey Follow Relationship\n');
  
  // Get y4my4m's user ID
  const { data: localUser } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('username', 'y4my4m')
    .eq('is_local', true)
    .single();
  
  if (!localUser) {
    console.error('Local user not found');
    return;
  }
  
  console.log(`Local user: ${localUser.username} (${localUser.id})\n`);
  
  // Get Misskey user
  const { data: misskeyUser } = await supabase
    .from('profiles')
    .select('*')
    .eq('domain', 'misskey.io')
    .eq('username', 'tester004')
    .single();
  
  if (!misskeyUser) {
    console.error('Misskey user not found in database');
    return;
  }
  
  console.log('=== MISSKEY USER ===');
  console.log(`Username: ${misskeyUser.username}@${misskeyUser.domain}`);
  console.log(`ID: ${misskeyUser.id}`);
  console.log(`Federated ID: ${misskeyUser.federated_id}`);
  console.log(`Inbox: ${misskeyUser.inbox_url}`);
  console.log(`Shared Inbox: ${misskeyUser.shared_inbox_url}`);
  console.log(`Outbox: ${misskeyUser.outbox_url}`);
  console.log('');
  
  // Check follow relationship
  const { data: followRelationship } = await supabase
    .from('follows')
    .select('*')
    .eq('follower_id', localUser.id)
    .eq('following_id', misskeyUser.id)
    .single();
  
  console.log('=== FOLLOW RELATIONSHIP ===');
  if (followRelationship) {
    console.log(`Status: ${followRelationship.status}`);
    console.log(`Created: ${followRelationship.created_at}`);
    console.log(`AP Activity ID: ${followRelationship.ap_activity_id || 'MISSING'}`);
    console.log(`Is Local: ${followRelationship.is_local}`);
  } else {
    console.log('❌ NO FOLLOW RELATIONSHIP FOUND!');
    console.log('You need to follow this user for their posts to appear.');
  }
  console.log('');
  
  // Check for recent posts from Misskey user
  const { data: misskeyPosts } = await supabase
    .from('posts')
    .select('id, created_at, visibility, content, is_local')
    .eq('author_id', misskeyUser.id)
    .order('created_at', { ascending: false })
    .limit(5);
  
  console.log('=== RECENT POSTS FROM MISSKEY USER ===');
  if (misskeyPosts && misskeyPosts.length > 0) {
    console.log(`Found ${misskeyPosts.length} posts:\n`);
    misskeyPosts.forEach(post => {
      console.log(`- ${post.created_at} | ${post.visibility} | local: ${post.is_local}`);
    });
  } else {
    console.log('❌ NO POSTS FOUND from this Misskey user');
    console.log('Either they haven\'t posted, or posts aren\'t being received.');
  }
  console.log('');
  
  // Check timeline entries for these posts
  if (misskeyPosts && misskeyPosts.length > 0) {
    console.log('=== TIMELINE ENTRIES ===');
    for (const post of misskeyPosts) {
      const { data: timelineEntries } = await supabase
        .from('timeline_entries')
        .select('timeline_type')
        .eq('post_id', post.id)
        .eq('user_id', localUser.id);
      
      const types = timelineEntries?.map(te => te.timeline_type).join(', ') || 'NONE';
      console.log(`Post ${post.id.substring(0, 8)}... → Timelines: ${types || '❌ MISSING'}`);
    }
  }
  console.log('');
  
  // Check recent AP activities from Misskey
  const { data: misskeyActivities } = await supabase
    .from('ap_activities')
    .select('ap_type, created_at, activity_data')
    .eq('actor_ap_id', misskeyUser.federated_id)
    .order('created_at', { ascending: false })
    .limit(10);
  
  console.log('=== RECENT ACTIVITIES FROM MISSKEY ===');
  if (misskeyActivities && misskeyActivities.length > 0) {
    console.log(`Found ${misskeyActivities.length} activities:\n`);
    misskeyActivities.forEach(act => {
      console.log(`- ${act.created_at.substring(0, 19)} | ${act.ap_type}`);
    });
  } else {
    console.log('❌ NO ACTIVITIES from this Misskey user');
    console.log('Federation backend is not receiving activities from them.');
  }
  
  console.log('\n=== DIAGNOSIS ===');
  if (!followRelationship) {
    console.log('❌ You are not following this Misskey user.');
    console.log('   Solution: Follow them from Harmony UI');
  } else if (followRelationship.status !== 'accepted') {
    console.log('⚠️  Follow status is:', followRelationship.status);
    console.log('   It should be "accepted"');
  } else if (!misskeyActivities || misskeyActivities.length === 0) {
    console.log('❌ Not receiving activities from Misskey');
    console.log('   Possible causes:');
    console.log('   1. Misskey doesn\'t know about your follow (check their side)');
    console.log('   2. Their posts aren\'t reaching your inbox');
    console.log('   3. Federation backend not processing them');
  } else if (!misskeyPosts || misskeyPosts.length === 0) {
    console.log('⚠️  Activities received but posts not created');
    console.log('   Check federation backend logs for errors');
  } else {
    console.log('✅ Everything looks correct!');
    console.log('   If posts still not in home timeline, run:');
    console.log('   psql ... -f ~/harmony/db_schema/fix_timeline_for_federated_posts.sql');
  }
}

checkMisskey().then(() => {
  console.log('\n✅ Check complete\n');
  process.exit(0);
}).catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});

