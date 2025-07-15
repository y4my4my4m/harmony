-- ============================================= 
-- DEBUG: FAVORITE STATE ISSUE - FINAL DIAGNOSIS
-- =============================================

-- Test the exact RPC call that the frontend makes and verify the result
SELECT 
    'Frontend RPC Call Result' as test_name,
    id,
    is_favorited,
    is_reblogged,  
    is_bookmarked,
    favorites_count,
    created_at
FROM get_timeline_posts_with_interactions(
    '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::UUID,
    'public',
    20,
    NULL
)
WHERE id = '968f8b30-8de1-4e0f-b9bb-87d8085330a7'
ORDER BY created_at DESC;

-- Verify this specific interaction still exists
SELECT 
    'Interaction Verification' as test_name,
    id,
    post_id,
    user_id,
    interaction_type,
    created_at
FROM post_interactions 
WHERE post_id = '968f8b30-8de1-4e0f-b9bb-87d8085330a7'::UUID
AND user_id = '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::UUID
AND interaction_type = 'favorite'
ORDER BY created_at DESC;
