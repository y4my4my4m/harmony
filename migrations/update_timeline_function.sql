-- Update the existing get_timeline_posts_with_interactions function to use the new logic
-- This ensures backward compatibility while fixing the timeline issues

-- Replace the existing function with enhanced logic
CREATE OR REPLACE FUNCTION get_timeline_posts_with_interactions(
    p_user_id UUID, 
    p_timeline_type TEXT DEFAULT 'public',
    p_limit INTEGER DEFAULT 20, 
    p_max_id TEXT DEFAULT NULL
) 
RETURNS TABLE(
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
    reply_context JSONB,
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
    is_deleted BOOLEAN,
    deleted_at TIMESTAMPTZ,
    author JSONB,
    is_favorited BOOLEAN,
    is_reblogged BOOLEAN,
    is_bookmarked BOOLEAN,
    reblog JSONB,
    reblog_author JSONB
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        tp.id::TEXT,
        tp.created_at,
        tp.updated_at,
        tp.content,
        tp.content_warning,
        'en'::TEXT as language,
        (tp.author->>'id')::TEXT as author_id,
        p.ap_id::TEXT,
        COALESCE(p.ap_type, 'Note')::TEXT as ap_type,
        tp.url,
        tp.reply_context,
        tp.conversation_id::TEXT,
        tp.visibility,
        (tp.author->>'is_local')::BOOLEAN as is_local,
        NOT (tp.author->>'is_local')::BOOLEAN as is_federated,
        tp.replies_count,
        tp.reblogs_count,
        tp.favorites_count,
        tp.media_attachments,
        COALESCE(p.metadata, '{}'::JSONB) as metadata,
        tp.is_sensitive,
        COALESCE(p.is_deleted, false) as is_deleted,
        p.deleted_at,
        tp.author,
        
        -- User interaction states
        COALESCE(fav.user_id IS NOT NULL, false) as is_favorited,
        COALESCE(reb.user_id IS NOT NULL, false) as is_reblogged,
        COALESCE(book.user_id IS NOT NULL, false) as is_bookmarked,
        
        -- Reblog fields
        tp.reblog,
        tp.reblog_author
        
    FROM timeline_posts tp
    JOIN posts p ON tp.id = p.id
    LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
        AND fav.user_id = p_user_id 
        AND fav.interaction_type = 'favorite'
    LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
        AND reb.user_id = p_user_id 
        AND reb.interaction_type = 'reblog'
    LEFT JOIN post_interactions book ON tp.id = book.post_id 
        AND book.user_id = p_user_id 
        AND book.interaction_type = 'bookmark'
    
    WHERE 
        CASE 
            -- HOME: Use timeline_entries for proper following logic
            WHEN p_timeline_type = 'home' THEN 
                EXISTS (
                    SELECT 1 FROM timeline_entries te 
                    WHERE te.user_id = p_user_id 
                      AND te.post_id = tp.id 
                      AND te.timeline_type = 'home'
                )
            
            -- LOCAL: Only public posts from local users
            WHEN p_timeline_type = 'local' THEN 
                tp.visibility = 'public' 
                AND (tp.author->>'is_local')::BOOLEAN = true
            
            -- PUBLIC/FEDERATED: All public posts (local + remote) - standard ActivityPub timeline
            WHEN p_timeline_type IN ('public', 'federated') THEN 
                tp.visibility = 'public'
                
            ELSE tp.visibility = 'public'
        END
        
        -- Pagination
        AND (p_max_id IS NULL OR tp.created_at < (
            SELECT tp2.created_at FROM timeline_posts tp2 WHERE tp2.id = p_max_id::UUID
        ))
    
    ORDER BY tp.created_at DESC
    LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION get_timeline_posts_with_interactions(UUID, TEXT, INTEGER, TEXT) IS 
'Enhanced timeline function with proper home timeline support using timeline_entries. Supports standard ActivityPub timelines: home (followed users), local (instance posts), public/federated (all public posts).';
