/**
 * Deep diagnostic to understand database state
 * Run with: tsx diagnose-deep.ts
 */

import { getSupabaseClient } from './src/config/supabase.js';

const supabase = getSupabaseClient();

async function deepDiagnose() {
  console.log('🔍 DEEP FEDERATION DIAGNOSTICS\n');
  console.log('='.repeat(60));
  
  // 1. Check ALL profiles
  console.log('\n1. ALL PROFILES IN DATABASE');
  console.log('-'.repeat(60));
  const { data: allProfiles, count: profileCount } = await supabase
    .from('profiles')
    .select('id, username, domain, is_local, federated_id, inbox_url', { count: 'exact' });
  
  console.log(`Total profiles: ${profileCount}`);
  console.log(`\nBreakdown:`);
  
  const localCount = allProfiles?.filter(p => p.is_local).length || 0;
  const remoteCount = allProfiles?.filter(p => !p.is_local).length || 0;
  
  console.log(`  Local users: ${localCount}`);
  console.log(`  Remote users: ${remoteCount}`);
  
  if (allProfiles && allProfiles.length > 0) {
    console.log('\nAll profiles:');
    allProfiles.forEach(p => {
      console.log(`  - ${p.username}@${p.domain} (is_local: ${p.is_local})`);
      if (!p.is_local) {
        console.log(`    Federated ID: ${p.federated_id || 'MISSING'}`);
        console.log(`    Inbox URL: ${p.inbox_url || 'MISSING'}`);
      }
    });
  }
  
  // 2. Check ALL follows
  console.log('\n\n2. ALL FOLLOW RELATIONSHIPS');
  console.log('-'.repeat(60));
  const { data: allFollows, count: followCount } = await supabase
    .from('follows')
    .select('*', { count: 'exact' });
  
  console.log(`Total follow relationships: ${followCount}`);
  
  if (allFollows && allFollows.length > 0) {
    console.log('\nFollow relationships:');
    for (const follow of allFollows) {
      const { data: follower } = await supabase
        .from('profiles')
        .select('username, domain, is_local')
        .eq('id', follow.follower_id)
        .single();
      
      const { data: following } = await supabase
        .from('profiles')
        .select('username, domain, is_local')
        .eq('id', follow.following_id)
        .single();
      
      if (follower && following) {
        const followerStr = `${follower.username}@${follower.domain}`;
        const followingStr = `${following.username}@${following.domain}`;
        console.log(`  ${followerStr} → ${followingStr} (status: ${follow.status})`);
      }
    }
  } else {
    console.log('  ⚠️  NO FOLLOW RELATIONSHIPS FOUND!');
  }
  
  // 3. Check recent posts
  console.log('\n\n3. RECENT POSTS');
  console.log('-'.repeat(60));
  const { data: recentPosts } = await supabase
    .from('posts')
    .select('id, author_id, is_local, ap_id, visibility, created_at')
    .order('created_at', { ascending: false })
    .limit(5);
  
  console.log(`Recent posts (last 5):`);
  if (recentPosts && recentPosts.length > 0) {
    for (const post of recentPosts) {
      const { data: author } = await supabase
        .from('profiles')
        .select('username, domain, is_local')
        .eq('id', post.author_id)
        .single();
      
      const authorStr = author ? `${author.username}@${author.domain}` : 'unknown';
      console.log(`  - ${post.created_at.substring(0, 19)} | ${authorStr} | local: ${post.is_local} | vis: ${post.visibility}`);
    }
  } else {
    console.log('  No posts found');
  }
  
  // 4. Check ap_activities table
  console.log('\n\n4. ACTIVITYPUB ACTIVITIES');
  console.log('-'.repeat(60));
  const { data: activities, count: activityCount } = await supabase
    .from('ap_activities')
    .select('ap_type, is_local, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(10);
  
  console.log(`Total AP activities: ${activityCount}`);
  
  if (activities && activities.length > 0) {
    console.log('\nRecent activities:');
    activities.forEach(a => {
      console.log(`  - ${a.created_at.substring(0, 19)} | ${a.ap_type} | local: ${a.is_local}`);
    });
  }
  
  // 5. Check delivery queue
  console.log('\n\n5. DELIVERY QUEUE STATUS');
  console.log('-'.repeat(60));
  const { data: queueStats } = await supabase
    .from('federation_delivery_queue')
    .select('status')
    .then(({ data }) => {
      const stats = {
        pending: data?.filter(q => q.status === 'pending').length || 0,
        delivered: data?.filter(q => q.status === 'delivered').length || 0,
        failed: data?.filter(q => q.status === 'failed').length || 0,
      };
      return { data: stats };
    });
  
  console.log(`Queue status:`);
  console.log(`  Pending: ${queueStats?.data.pending || 0}`);
  console.log(`  Delivered: ${queueStats?.data.delivered || 0}`);
  console.log(`  Failed: ${queueStats?.data.failed || 0}`);
  
  // 6. Summary and diagnosis
  console.log('\n\n' + '='.repeat(60));
  console.log('DIAGNOSIS');
  console.log('='.repeat(60));
  
  if (remoteCount === 0) {
    console.log('\n❌ CRITICAL: NO REMOTE USERS IN DATABASE!');
    console.log('\nPossible causes:');
    console.log('  1. Fresh database with no federation activity yet');
    console.log('  2. Remote users were deleted or database was reset');
    console.log('  3. Never received any Follow activities from remote users');
    console.log('  4. Database migration issue');
    console.log('\nTo fix:');
    console.log('  - Try following someone on Mastodon/Misskey from Harmony');
    console.log('  - Ask someone on Mastodon/Misskey to follow you');
    console.log('  - Check federation backend logs for incoming activities');
  }
  
  if (followCount === 0) {
    console.log('\n⚠️  WARNING: NO FOLLOW RELATIONSHIPS!');
    console.log('  You need to follow or be followed by someone for federation to work.');
  }
}

deepDiagnose().then(() => {
  console.log('\n✅ Deep diagnostics complete\n');
  process.exit(0);
}).catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});

