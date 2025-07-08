-- Fix ambiguous column reference in get_user_timeline function
-- The issue was that both timeline_entries and posts tables have created_at columns

CREATE OR REPLACE FUNCTION get_user_timeline(
    p_user_id UUID,
    p_timeline_type TEXT DEFAULT 'home',
    p_limit INTEGER DEFAULT 20,
    p_max_id UUID DEFAULT NULL
)
RETURNS TABLE(
    post_id UUID,
    content JSONB,
    author_id UUID,
    author_username TEXT,
    author_display_name TEXT,
    author_avatar_url TEXT,
    author_domain TEXT,
    created_at TIMESTAMP WITH TIME ZONE,
    visibility TEXT,
    replies_count INTEGER,
    reblogs_count INTEGER,
    favorites_count INTEGER,
    in_reply_to UUID,
    media_attachments JSONB,
    is_favorited BOOLEAN,
    is_reblogged BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id as post_id,
        p.content,
        p.author_id,
        pr.username as author_username,
        pr.display_name as author_display_name,
        pr.avatar_url as author_avatar_url,
        pr.domain as author_domain,
        p.created_at,
        p.visibility,
        p.replies_count,
        p.reblogs_count,
        p.favorites_count,
        p.in_reply_to,
        p.media_attachments,
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
            AND pi.user_id = p_user_id 
            AND pi.interaction_type = 'favorite'
        ) as is_favorited,
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
            AND pi.user_id = p_user_id 
            AND pi.interaction_type = 'reblog'
        ) as is_reblogged
    FROM timeline_entries te
    JOIN posts p ON te.post_id = p.id
    JOIN profiles pr ON p.author_id = pr.id
    WHERE te.user_id = p_user_id
    AND te.timeline_type = p_timeline_type
    AND p.is_deleted = false
    AND (p_max_id IS NULL OR p.created_at < (SELECT p2.created_at FROM posts p2 WHERE p2.id = p_max_id))
    ORDER BY p.created_at DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
