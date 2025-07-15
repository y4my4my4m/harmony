-- Test the RPC function directly to see if it returns our target post
-- This will help us understand why the debug log never appears

-- Call the exact same RPC the frontend is calling
SELECT 
    'Direct RPC Test' as test_name,
    id,
    created_at,
    is_favorited,
    favorites_count,
    visibility,
    is_local,
    author
FROM get_timeline_posts_with_interactions(
    '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::UUID,  -- Your user ID
    'public',
    100,  -- Large limit to catch the post
    NULL  -- No pagination
)
WHERE id = '968f8b30-8de1-4e0f-b9bb-87d8085330a7';

-- If the above returns nothing, let's see what posts ARE being returned
SELECT 
    'RPC Returns Count' as test_name,
    COUNT(*) as total_posts,
    COUNT(CASE WHEN is_local THEN 1 END) as local_posts,
    COUNT(CASE WHEN NOT is_local THEN 1 END) as federated_posts,
    MIN(created_at) as oldest_post,
    MAX(created_at) as newest_post
FROM get_timeline_posts_with_interactions(
    '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::UUID,
    'public',
    100,
    NULL
);

-- Let's also check what posts are close to our target post by date
SELECT 
    'Posts Around Target Date' as test_name,
    id,
    created_at,
    visibility,
    (author->>'username') as author_username,
    is_favorited,
    favorites_count
FROM get_timeline_posts_with_interactions(
    '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::UUID,
    'public',
    100,
    NULL
)
WHERE created_at BETWEEN '2025-07-11 20:00:00'::timestamp AND '2025-07-11 21:00:00'::timestamp
ORDER BY created_at DESC;
