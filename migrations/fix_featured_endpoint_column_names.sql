-- Fix Featured Endpoint Column Names
-- This migration fixes references to non-existent 'interactions_count' column
-- and replaces them with the correct engagement calculation

-- =====================================================
-- STEP 1: DROP INCORRECT INDEXES AND FUNCTIONS
-- =====================================================

-- Drop the incorrect index that references non-existent interactions_count
DROP INDEX IF EXISTS idx_posts_featured;

-- Drop any functions that reference interactions_count
DROP FUNCTION IF EXISTS get_featured_posts_hybrid(uuid, integer);
DROP FUNCTION IF EXISTS get_user_featured_posts(uuid, integer);

-- =====================================================
-- STEP 2: CREATE CORRECT INDEXES
-- =====================================================

-- Add is_pinned column if it doesn't exist
ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;

-- Create correct index for featured posts using engagement calculation
CREATE INDEX IF NOT EXISTS idx_posts_featured_engagement 
ON posts(author_id, (favorites_count + reblogs_count + replies_count) DESC, created_at DESC) 
WHERE (favorites_count + reblogs_count + replies_count) > 0;

-- Create index for pinned posts
CREATE INDEX IF NOT EXISTS idx_posts_pinned 
ON posts(author_id, is_pinned, created_at DESC) 
WHERE is_pinned = true;

-- =====================================================
-- STEP 3: CREATE CORRECTED FEATURED POSTS FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION get_featured_posts_hybrid(
    p_author_id UUID,
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE(
    id UUID,
    content JSONB,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    author_id UUID,
    engagement_count INT,
    replies_count INT,
    is_pinned BOOLEAN,
    ap_id TEXT,
    ap_type TEXT,
    visibility TEXT,
    media_attachments JSONB,
    content_warning TEXT,
    in_reply_to UUID,
    favorites_count INT,
    reblogs_count INT
) AS $$
DECLARE
    pinned_count INT;
    remaining_limit INT;
BEGIN
    -- First, get pinned posts
    RETURN QUERY
    SELECT 
        p.id, p.content, p.created_at, p.updated_at, p.author_id,
        (p.favorites_count + p.reblogs_count + p.replies_count) as engagement_count,
        p.replies_count, p.is_pinned,
        p.ap_id, p.ap_type, p.visibility, p.media_attachments,
        p.content_warning, p.in_reply_to, p.favorites_count, p.reblogs_count
    FROM posts p
    WHERE p.author_id = p_author_id 
        AND p.is_pinned = true
        AND p.is_deleted = false
        AND p.visibility IN ('public', 'unlisted')
    ORDER BY p.created_at DESC
    LIMIT p_limit;

    -- Count how many pinned posts we got
    GET DIAGNOSTICS pinned_count = ROW_COUNT;
    remaining_limit := p_limit - pinned_count;

    -- If we have room for more, add popular posts
    IF remaining_limit > 0 THEN
        RETURN QUERY
        SELECT 
            p.id, p.content, p.created_at, p.updated_at, p.author_id,
            (p.favorites_count + p.reblogs_count + p.replies_count) as engagement_count,
            p.replies_count, p.is_pinned,
            p.ap_id, p.ap_type, p.visibility, p.media_attachments,
            p.content_warning, p.in_reply_to, p.favorites_count, p.reblogs_count
        FROM posts p
        WHERE p.author_id = p_author_id 
            AND p.is_pinned = false
            AND p.is_deleted = false
            AND p.visibility IN ('public', 'unlisted')
            AND (p.favorites_count + p.reblogs_count + p.replies_count) > 0
        ORDER BY (p.favorites_count + p.reblogs_count + p.replies_count) DESC, p.created_at DESC
        LIMIT remaining_limit;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- STEP 4: CREATE SIMPLIFIED FEATURED POSTS FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION get_user_featured_posts(
    p_author_id UUID,
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE(
    id UUID,
    content JSONB,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    author_id UUID,
    engagement_count INT,
    replies_count INT,
    is_pinned BOOLEAN,
    ap_id TEXT,
    ap_type TEXT,
    visibility TEXT,
    media_attachments JSONB,
    content_warning TEXT,
    in_reply_to UUID,
    favorites_count INT,
    reblogs_count INT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id, p.content, p.created_at, p.updated_at, p.author_id,
        (p.favorites_count + p.reblogs_count + p.replies_count) as engagement_count,
        p.replies_count, p.is_pinned,
        p.ap_id, p.ap_type, p.visibility, p.media_attachments,
        p.content_warning, p.in_reply_to, p.favorites_count, p.reblogs_count
    FROM posts p
    WHERE p.author_id = p_author_id 
        AND p.is_deleted = false
        AND p.visibility IN ('public', 'unlisted')
    ORDER BY 
        CASE WHEN p.is_pinned THEN 1 ELSE 2 END,
        (p.favorites_count + p.reblogs_count + p.replies_count) DESC,
        p.created_at DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- STEP 5: GRANT PERMISSIONS
-- =====================================================

-- Grant execute permissions to the service role
GRANT EXECUTE ON FUNCTION get_featured_posts_hybrid(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION get_user_featured_posts(UUID, INTEGER) TO service_role;

-- Grant execute permissions to authenticated users
GRANT EXECUTE ON FUNCTION get_featured_posts_hybrid(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_featured_posts(UUID, INTEGER) TO authenticated;

-- Grant execute permissions to anon users (for public access)
GRANT EXECUTE ON FUNCTION get_featured_posts_hybrid(UUID, INTEGER) TO anon;
GRANT EXECUTE ON FUNCTION get_user_featured_posts(UUID, INTEGER) TO anon;
