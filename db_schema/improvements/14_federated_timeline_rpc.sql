-- =============================================
-- FEDERATED TIMELINE RPC FUNCTION
-- Date: 2025-11-28
-- =============================================
-- 
-- Creates a proper RPC function for the federated timeline that:
-- 1. Queries ALL known remote public posts (not just from followed users)
-- 2. Filters deleted posts server-side
-- 3. Filters suspended users server-side
-- 4. Includes user interaction states
-- 5. Uses SECURITY DEFINER for proper access control
-- =============================================

BEGIN;

-- Drop existing function if it exists
DROP FUNCTION IF EXISTS public.get_federated_timeline(uuid, integer, text);

-- Create the federated timeline function
CREATE OR REPLACE FUNCTION public.get_federated_timeline(
    p_user_id UUID,
    p_limit INTEGER DEFAULT 20,
    p_max_id TEXT DEFAULT NULL
)
RETURNS TABLE (
    id TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    content JSONB,
    content_warning TEXT,
    language TEXT,
    author_id TEXT,
    ap_id TEXT,
    ap_type TEXT,
    url TEXT,
    conversation_id TEXT,
    visibility TEXT,
    is_local BOOLEAN,
    is_federated BOOLEAN,
    replies_count INTEGER,
    reblogs_count INTEGER,
    favorites_count INTEGER,
    media_attachments JSONB,
    metadata JSONB,
    is_sensitive BOOLEAN,
    author JSONB,
    is_favorited BOOLEAN,
    is_reblogged BOOLEAN,
    is_bookmarked BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id::TEXT,
        p.created_at,
        p.updated_at,
        p.content,
        p.content_warning,
        p.language,
        p.author_id::TEXT,
        p.ap_id,
        p.ap_type,
        p.url,
        p.conversation_id::TEXT,
        p.visibility,
        p.is_local,
        p.is_federated,
        COALESCE(p.replies_count, 0)::INTEGER,
        COALESCE(p.reblogs_count, 0)::INTEGER,
        COALESCE(p.favorites_count, 0)::INTEGER,
        COALESCE(p.media_attachments, '[]'::jsonb),
        COALESCE(p.metadata, '{}'::jsonb),
        COALESCE(p.is_sensitive, false),
        -- Author object
        jsonb_build_object(
            'id', pr.id,
            'username', pr.username,
            'display_name', pr.display_name,
            'avatar_url', pr.avatar_url,
            'domain', COALESCE(pr.domain, 'har.mony.lol'),
            'handle', CASE 
                WHEN COALESCE(pr.is_local, true) THEN '@' || pr.username
                ELSE '@' || pr.username || '@' || pr.domain
            END,
            'is_local', COALESCE(pr.is_local, true),
            'bio', pr.bio,
            'color', pr.color
        ) AS author,
        -- User interaction states
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
              AND pi.user_id = p_user_id 
              AND pi.interaction_type IN ('favorite', 'emoji_reaction')
        ) AS is_favorited,
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
              AND pi.user_id = p_user_id 
              AND pi.interaction_type = 'reblog'
        ) AS is_reblogged,
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
              AND pi.user_id = p_user_id 
              AND pi.interaction_type = 'bookmark'
        ) AS is_bookmarked
        
    FROM posts p
    INNER JOIN profiles pr ON p.author_id = pr.id
    
    WHERE 
        -- Remote posts only (federated content from other instances)
        p.is_local = false
        -- Public visibility only
        AND p.visibility = 'public'
        -- Not deleted (check both fields for safety)
        AND (p.is_deleted = false OR p.is_deleted IS NULL)
        AND p.deleted_at IS NULL
        -- Not from suspended users
        AND (pr.is_suspended = false OR pr.is_suspended IS NULL)
        -- Top-level posts only (not replies)
        AND p.in_reply_to IS NULL
        -- Pagination
        AND (p_max_id IS NULL OR p.created_at < (
            SELECT p2.created_at FROM posts p2 WHERE p2.id::TEXT = p_max_id
        ))
    
    ORDER BY p.created_at DESC
    LIMIT p_limit;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.get_federated_timeline(UUID, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_federated_timeline(UUID, INTEGER, TEXT) TO service_role;

-- Add helpful comment
COMMENT ON FUNCTION public.get_federated_timeline IS 
'Returns all known remote public posts for the federated timeline. 
Unlike the home timeline, this shows ALL remote posts the instance knows about,
not just posts from followed users. Matches Mastodon/Misskey federated timeline behavior.';

-- Create index for efficient federated timeline queries
CREATE INDEX IF NOT EXISTS idx_posts_federated_timeline 
ON posts (created_at DESC) 
WHERE is_local = false 
  AND visibility = 'public' 
  AND (is_deleted = false OR is_deleted IS NULL)
  AND deleted_at IS NULL
  AND in_reply_to IS NULL;

COMMIT;

