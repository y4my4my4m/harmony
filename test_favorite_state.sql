-- Test if get_timeline_posts_with_interactions is working correctly
-- Check what data it returns for a specific user and post

-- Replace these UUIDs with actual values from your database
SELECT 
  id,
  is_favorited,
  is_reblogged,
  is_bookmarked,
  favorites_count,
  reblogs_count
FROM get_timeline_posts_with_interactions(
  '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::uuid,  -- Your user ID
  'public'::text,
  20::integer,
  null::text
)
WHERE id = '968f8b30-8de1-4e0f-b9bb-87d8085330a7'  -- The post you favorited
LIMIT 1;

-- Also check if post_interactions table has the data
SELECT 
  pi.id,
  pi.user_id,
  pi.post_id,
  pi.interaction_type,
  pi.created_at
FROM post_interactions pi
WHERE pi.user_id = '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'
AND pi.post_id = '968f8b30-8de1-4e0f-b9bb-87d8085330a7'
AND pi.interaction_type = 'favorite';
