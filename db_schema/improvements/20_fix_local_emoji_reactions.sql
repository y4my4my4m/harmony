-- Migration: Fix Local Emoji Reactions
-- 
-- BUG: Local emoji reactions to local posts don't persist after page refresh
-- 
-- ROOT CAUSE: get_post_emoji_reactions and get_batch_post_emoji_reactions
-- use auth.uid() directly to check current_user_reacted, but post_interactions.user_id
-- stores PROFILE IDs (not auth user IDs).
-- 
-- - auth.uid() returns the Supabase auth user ID
-- - post_interactions.user_id stores profile IDs
-- - These are different UUIDs, so the comparison always fails
-- 
-- FIX: Use get_current_profile_id() instead of auth.uid() to get the correct
-- profile ID for the current_user_reacted check.
-- 
-- This also explains why remote user reactions work - they don't need the
-- current_user_reacted check to function properly.

-- =====================================================
-- FIX 1: get_post_emoji_reactions function
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_post_emoji_reactions(
    p_post_id uuid, 
    p_user_limit integer DEFAULT 5
) RETURNS TABLE(
    emoji_id uuid, 
    emoji_name text, 
    emoji_url text, 
    custom_emoji_content text, 
    reaction_count bigint, 
    user_reactions jsonb, 
    current_user_reacted boolean
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    current_profile_id uuid;
BEGIN
    -- FIXED: Use get_current_profile_id() instead of auth.uid()
    -- post_interactions.user_id stores PROFILE IDs, not auth user IDs
    current_profile_id := public.get_current_profile_id();
    
    RETURN QUERY
    SELECT 
        pi.emoji_id,
        e.name::text as emoji_name,
        -- Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Only include limited user data for tooltips
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', sub_pi.user_id,
                    'username', sub_p.username,
                    'display_name', sub_p.display_name,
                    'avatar_url', sub_p.avatar_url,
                    'created_at', sub_pi.created_at
                )
                ORDER BY sub_pi.created_at DESC
            )
            FROM post_interactions sub_pi
            LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
            WHERE sub_pi.post_id = p_post_id
              AND sub_pi.interaction_type = 'emoji_reaction'
              AND (
                  (pi.emoji_id IS NOT NULL AND sub_pi.emoji_id = pi.emoji_id) OR
                  (pi.custom_emoji_content IS NOT NULL AND sub_pi.custom_emoji_content = pi.custom_emoji_content)
              )
            LIMIT p_user_limit
        ) as user_reactions,
        -- FIXED: Check if current user has reacted using PROFILE ID
        CASE 
            WHEN current_profile_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = p_post_id
                  AND check_pi.user_id = current_profile_id  -- FIXED: was auth.uid()
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND (
                      (pi.emoji_id IS NOT NULL AND check_pi.emoji_id = pi.emoji_id) OR
                      (pi.custom_emoji_content IS NOT NULL AND check_pi.custom_emoji_content = pi.custom_emoji_content)
                  )
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = p_post_id 
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY reaction_count DESC, MIN(pi.created_at) ASC;
END;
$$;

COMMENT ON FUNCTION public.get_post_emoji_reactions(uuid, integer) IS 
    'Get emoji reactions for a post. Returns grouped reactions with user data for tooltips. FIXED: Uses profile ID (not auth ID) for current_user_reacted check.';


-- =====================================================
-- FIX 2: get_batch_post_emoji_reactions function
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_batch_post_emoji_reactions(
    p_post_ids uuid[], 
    p_user_limit integer DEFAULT 5
) RETURNS TABLE(
    post_id uuid, 
    emoji_id uuid, 
    emoji_name text, 
    emoji_url text, 
    custom_emoji_content text, 
    reaction_count bigint, 
    user_reactions jsonb, 
    current_user_reacted boolean
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    current_profile_id uuid;
BEGIN
    -- FIXED: Use get_current_profile_id() instead of auth.uid()
    -- post_interactions.user_id stores PROFILE IDs, not auth user IDs
    current_profile_id := public.get_current_profile_id();
    
    RETURN QUERY
    SELECT 
        pi.post_id,
        pi.emoji_id,
        e.name::text as emoji_name,
        -- Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Limited user data for tooltips
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', sub_pi.user_id,
                    'username', sub_p.username,
                    'display_name', sub_p.display_name,
                    'avatar_url', sub_p.avatar_url,
                    'created_at', sub_pi.created_at
                )
                ORDER BY sub_pi.created_at DESC
            )
            FROM post_interactions sub_pi
            LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
            WHERE sub_pi.post_id = pi.post_id
              AND sub_pi.interaction_type = 'emoji_reaction'
              AND (
                  (pi.emoji_id IS NOT NULL AND sub_pi.emoji_id = pi.emoji_id) OR
                  (pi.custom_emoji_content IS NOT NULL AND sub_pi.custom_emoji_content = pi.custom_emoji_content)
              )
            LIMIT p_user_limit
        ) as user_reactions,
        -- FIXED: Check if current user has reacted using PROFILE ID
        CASE 
            WHEN current_profile_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = pi.post_id
                  AND check_pi.user_id = current_profile_id  -- FIXED: was auth.uid()
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND (
                      (pi.emoji_id IS NOT NULL AND check_pi.emoji_id = pi.emoji_id) OR
                      (pi.custom_emoji_content IS NOT NULL AND check_pi.custom_emoji_content = pi.custom_emoji_content)
                  )
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = ANY(p_post_ids)
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.post_id, pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY pi.post_id, reaction_count DESC, MIN(pi.created_at) ASC;
END;
$$;

COMMENT ON FUNCTION public.get_batch_post_emoji_reactions(uuid[], integer) IS 
    'Batch get emoji reactions for multiple posts. Used for timeline loading. FIXED: Uses profile ID (not auth ID) for current_user_reacted check.';

