-- Fix timeline entries for federated posts from followed users
-- Issue: Federated posts appear in federated_timeline but not home_timeline

-- First, let's check the current trigger
SELECT 
    tgname as trigger_name,
    pg_get_triggerdef(oid) as trigger_definition
FROM pg_trigger 
WHERE tgname LIKE '%timeline%' 
  AND tgrelid = 'posts'::regclass;

-- Check if timeline entries are being created for federated posts
SELECT 
    'Federated posts without timeline entries' as issue,
    COUNT(*) as count
FROM posts p
WHERE p.is_local = false
  AND p.visibility IN ('public', 'unlisted')
  AND NOT EXISTS (
    SELECT 1 FROM timeline_entries te
    WHERE te.post_id = p.id
  );

-- Manually create missing timeline entries for posts from followed users
-- This is what the trigger should do automatically
INSERT INTO timeline_entries (user_id, post_id, timeline_type, created_at)
SELECT DISTINCT
    f.follower_id as user_id,
    p.id as post_id,
    'home' as timeline_type,
    p.created_at
FROM posts p
JOIN follows f ON f.following_id = p.author_id AND f.status = 'accepted'
WHERE p.is_local = false
  AND p.visibility IN ('public', 'unlisted')
  AND NOT EXISTS (
    SELECT 1 FROM timeline_entries te
    WHERE te.post_id = p.id 
      AND te.user_id = f.follower_id
      AND te.timeline_type = 'home'
  )
ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;

-- Also ensure they appear in public timeline (federated timeline)
INSERT INTO timeline_entries (user_id, post_id, timeline_type, created_at)
SELECT DISTINCT
    local_users.id as user_id,
    p.id as post_id,
    'public' as timeline_type,
    p.created_at
FROM posts p
CROSS JOIN (SELECT id FROM profiles WHERE is_local = true) as local_users
WHERE p.is_local = false
  AND p.visibility = 'public'
  AND NOT EXISTS (
    SELECT 1 FROM timeline_entries te
    WHERE te.post_id = p.id 
      AND te.user_id = local_users.id
      AND te.timeline_type = 'public'
  )
ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;

-- Show results
SELECT 
    'Timeline entries created' as result,
    COUNT(*) as total_entries
FROM timeline_entries
WHERE created_at >= NOW() - INTERVAL '1 minute';

