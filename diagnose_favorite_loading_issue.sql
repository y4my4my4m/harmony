-- ============================================= 
-- DIAGNOSE FAVORITE STATE LOADING ISSUE
-- =============================================

-- 1. Check the specific post and interaction that's failing
DO $$
DECLARE
    test_post_id UUID := '968f8b30-8de1-4e0f-b9bb-87d8085330a7'::UUID;
    test_user_id UUID := '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::UUID;
BEGIN
    -- Check if post exists in posts table
    RAISE NOTICE '=== POST EXISTENCE CHECK ===';
    IF EXISTS (SELECT 1 FROM posts WHERE id = test_post_id) THEN
        RAISE NOTICE 'GOOD: Post % exists in posts table', test_post_id;
    ELSE
        RAISE NOTICE 'ERROR: Post % NOT found in posts table', test_post_id;
    END IF;
    
    -- Check if post exists in timeline_posts view
    IF EXISTS (SELECT 1 FROM timeline_posts WHERE id = test_post_id) THEN
        RAISE NOTICE 'GOOD: Post % exists in timeline_posts view', test_post_id;
    ELSE
        RAISE NOTICE 'ERROR: Post % NOT found in timeline_posts view', test_post_id;
    END IF;
    
    -- Check if interaction exists
    RAISE NOTICE '=== INTERACTION EXISTENCE CHECK ===';
    IF EXISTS (
        SELECT 1 FROM post_interactions 
        WHERE post_id = test_post_id 
        AND user_id = test_user_id 
        AND interaction_type = 'favorite'
    ) THEN
        RAISE NOTICE 'GOOD: Favorite interaction exists for post % user %', test_post_id, test_user_id;
    ELSE
        RAISE NOTICE 'ERROR: Favorite interaction NOT found for post % user %', test_post_id, test_user_id;
    END IF;
END $$;

-- 2. Check data types and values in the JOIN
SELECT 
    'Data Types Check' as check_name,
    pg_typeof(tp.id) as timeline_posts_id_type,
    pg_typeof(fav.post_id) as post_interactions_post_id_type,
    tp.id as tp_id_value,
    fav.post_id as fav_post_id_value,
    fav.user_id as fav_user_id,
    fav.interaction_type,
    CASE WHEN tp.id = fav.post_id THEN 'MATCH' ELSE 'NO_MATCH' END as join_result
FROM timeline_posts tp
LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
    AND fav.user_id = '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::UUID
    AND fav.interaction_type = 'favorite'
WHERE tp.id = '968f8b30-8de1-4e0f-b9bb-87d8085330a7'::UUID;

-- 3. Test the exact RPC function call that's failing
SELECT 
    'RPC Function Test' as test_name,
    id,
    is_favorited,
    is_reblogged,
    is_bookmarked,
    favorites_count
FROM get_timeline_posts_with_interactions(
    '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::UUID,
    'public',
    20,
    NULL
)
WHERE id = '968f8b30-8de1-4e0f-b9bb-87d8085330a7';

-- 4. Manual JOIN test to see what's happening
SELECT 
    'Manual JOIN Test' as test_name,
    tp.id as post_id,
    tp.favorites_count,
    fav.user_id as fav_user_id,
    fav.interaction_type,
    fav.post_id as fav_post_id,
    COALESCE(fav.user_id IS NOT NULL, false) as is_favorited_calc
FROM timeline_posts tp
LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
    AND fav.user_id = '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::UUID
    AND fav.interaction_type = 'favorite'
WHERE tp.id = '968f8b30-8de1-4e0f-b9bb-87d8085330a7'::UUID;

-- 5. Check all interactions for this post/user combo
SELECT 
    'All Interactions Check' as test_name,
    post_id,
    user_id,
    interaction_type,
    created_at,
    id
FROM post_interactions 
WHERE post_id = '968f8b30-8de1-4e0f-b9bb-87d8085330a7'::UUID
AND user_id = '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::UUID
ORDER BY created_at DESC;
