-- ============================================= 
-- FINAL DIAGNOSIS: Check if post appears in timeline
-- =============================================

-- 1. Check if post exists in timeline_posts view
SELECT 
    'Timeline Posts Check' as test_name,
    id,
    created_at,
    visibility,
    (author->>'is_local')::boolean as is_local,
    author
FROM timeline_posts 
WHERE id = '968f8b30-8de1-4e0f-b9bb-87d8085330a7'::UUID;

-- 2. Check if post exists in posts table
SELECT 
    'Posts Table Check' as test_name,
    id,
    created_at,
    visibility,
    is_local
FROM posts 
WHERE id = '968f8b30-8de1-4e0f-b9bb-87d8085330a7'::UUID;

-- 3. Test RPC with specific user and post
SELECT 
    'RPC Call Test' as test_name,
    id,
    is_favorited,
    favorites_count,
    visibility,
    is_local
FROM get_timeline_posts_with_interactions(
    '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::UUID,
    'public',
    100,  -- Increased limit to catch more posts
    NULL
)
WHERE id = '968f8b30-8de1-4e0f-b9bb-87d8085330a7';

-- 4. Raw check of the JOIN logic
SELECT 
    'Raw JOIN Test' as test_name,
    tp.id,
    tp.visibility,
    fav.user_id as fav_user_id,
    fav.interaction_type,
    COALESCE(fav.user_id IS NOT NULL, false) as is_favorited_calc
FROM timeline_posts tp
LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
    AND fav.user_id = '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::UUID
    AND fav.interaction_type = 'favorite'
WHERE tp.id = '968f8b30-8de1-4e0f-b9bb-87d8085330a7'::UUID;
