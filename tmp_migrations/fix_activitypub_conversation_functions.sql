-- Fix existing ActivityPub conversation functions
-- These functions already exist but have empty bodies, so we need to drop and recreate them

-- Drop existing functions first
DROP FUNCTION IF EXISTS get_activitypub_conversation_root(UUID);
DROP FUNCTION IF EXISTS get_activitypub_conversation_thread(UUID);
DROP FUNCTION IF EXISTS get_activitypub_conversation_context(UUID);

-- Create function to get conversation root
CREATE OR REPLACE FUNCTION get_activitypub_conversation_root(post_id UUID)
RETURNS TABLE(root_id UUID) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- O(1) lookup using conversation_root_id column
    RETURN QUERY
    SELECT 
        COALESCE(p.conversation_root_id, p.id) as root_id
    FROM posts p
    WHERE p.id = post_id;
END;
$$;

-- Create function to get conversation thread
CREATE OR REPLACE FUNCTION get_activitypub_conversation_thread(conversation_root_id UUID)
RETURNS TABLE(
    id UUID,
    content JSONB,
    created_at TIMESTAMP WITH TIME ZONE,
    author JSONB,
    visibility TEXT,
    favorites_count INTEGER,
    reblogs_count INTEGER,
    replies_count INTEGER,
    is_favorited BOOLEAN,
    is_reblogged BOOLEAN,
    is_bookmarked BOOLEAN,
    media_attachments JSONB,
    reply_context JSONB,
    content_warning TEXT,
    is_sensitive BOOLEAN,
    reblog JSONB,
    reblog_author JSONB,
    url TEXT,
    thread_depth INTEGER
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- O(log n) lookup using indexed conversation_root_id
    -- Returns posts in chronological order with thread depth calculation
    RETURN QUERY
    WITH RECURSIVE thread_tree AS (
        -- Start with the root post
        SELECT 
            p.id,
            p.content,
            p.created_at,
            tp.author,
            p.visibility,
            COALESCE(p.favorites_count, 0) as favorites_count,
            COALESCE(p.reblogs_count, 0) as reblogs_count,
            COALESCE(p.replies_count, 0) as replies_count,
            false as is_favorited, -- TODO: Calculate based on current user
            false as is_reblogged, -- TODO: Calculate based on current user  
            false as is_bookmarked, -- TODO: Calculate based on current user
            COALESCE(p.media_attachments, '[]'::jsonb) as media_attachments,
            tp.reply_context,
            p.content_warning,
            COALESCE(p.is_sensitive, false) as is_sensitive,
            NULL::jsonb as reblog, -- TODO: Handle reblogs
            NULL::jsonb as reblog_author, -- TODO: Handle reblog authors
            p.url,
            0 as thread_depth,
            p.created_at as sort_key
        FROM posts p
        JOIN timeline_posts tp ON p.id = tp.id
        WHERE p.conversation_root_id = get_activitypub_conversation_thread.conversation_root_id
           OR (p.conversation_root_id IS NULL AND p.id = get_activitypub_conversation_thread.conversation_root_id)
        
        UNION ALL
        
        -- Get replies to posts in the thread
        SELECT 
            p.id,
            p.content,
            p.created_at,
            tp.author,
            p.visibility,
            COALESCE(p.favorites_count, 0) as favorites_count,
            COALESCE(p.reblogs_count, 0) as reblogs_count,
            COALESCE(p.replies_count, 0) as replies_count,
            false as is_favorited,
            false as is_reblogged,
            false as is_bookmarked,
            COALESCE(p.media_attachments, '[]'::jsonb) as media_attachments,
            tp.reply_context,
            p.content_warning,
            COALESCE(p.is_sensitive, false) as is_sensitive,
            NULL::jsonb as reblog,
            NULL::jsonb as reblog_author,
            p.url,
            tt.thread_depth + 1,
            p.created_at as sort_key
        FROM posts p
        JOIN timeline_posts tp ON p.id = tp.id
        JOIN thread_tree tt ON p.in_reply_to = tt.id
        WHERE p.conversation_root_id = get_activitypub_conversation_thread.conversation_root_id
           AND tt.thread_depth < 50 -- Prevent infinite recursion
    )
    SELECT 
        tt.id,
        tt.content,
        tt.created_at,
        tt.author,
        tt.visibility,
        tt.favorites_count,
        tt.reblogs_count,
        tt.replies_count,
        tt.is_favorited,
        tt.is_reblogged,
        tt.is_bookmarked,
        tt.media_attachments,
        tt.reply_context,
        tt.content_warning,
        tt.is_sensitive,
        tt.reblog,
        tt.reblog_author,
        tt.url,
        tt.thread_depth
    FROM thread_tree tt
    ORDER BY tt.sort_key ASC; -- Chronological order like Twitter/X
END;
$$;

-- Create function to get conversation context
CREATE OR REPLACE FUNCTION get_activitypub_conversation_context(post_id UUID)
RETURNS TABLE(
    conversation_root_id UUID,
    total_posts INTEGER,
    participant_count INTEGER,
    created_at TIMESTAMP WITH TIME ZONE,
    last_activity TIMESTAMP WITH TIME ZONE
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    conv_root_id UUID;
BEGIN
    -- Get conversation_root_id for the post
    SELECT COALESCE(p.conversation_root_id, p.id) 
    INTO conv_root_id
    FROM posts p 
    WHERE p.id = post_id;
    
    -- Return conversation statistics
    RETURN QUERY
    SELECT 
        conv_root_id as conversation_root_id,
        COUNT(*)::INTEGER as total_posts,
        COUNT(DISTINCT p.author_id)::INTEGER as participant_count,
        MIN(p.created_at) as created_at,
        MAX(p.created_at) as last_activity
    FROM posts p
    WHERE COALESCE(p.conversation_root_id, p.id) = conv_root_id
      AND p.deleted_at IS NULL;
END;
$$;

-- Grant permissions to authenticated users
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_root(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_thread(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_context(UUID) TO authenticated;

-- Ensure we have proper indexes for performance
CREATE INDEX IF NOT EXISTS idx_posts_conversation_root_id 
ON posts(conversation_root_id) 
WHERE conversation_root_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_posts_in_reply_to_conversation 
ON posts(in_reply_to, conversation_root_id) 
WHERE in_reply_to IS NOT NULL;

-- Add trigger to automatically set conversation_root_id if not already done
CREATE OR REPLACE FUNCTION set_activitypub_conversation_root_id()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.in_reply_to IS NULL THEN
        -- This is a root post
        NEW.conversation_root_id = NEW.id;
    ELSE
        -- This is a reply, get the conversation_root_id from the parent
        SELECT COALESCE(p.conversation_root_id, p.id)
        INTO NEW.conversation_root_id
        FROM posts p
        WHERE p.id = NEW.in_reply_to;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger if it doesn't exist
DROP TRIGGER IF EXISTS set_conversation_root_id_trigger ON posts;
CREATE TRIGGER set_conversation_root_id_trigger
    BEFORE INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION set_activitypub_conversation_root_id();

COMMIT;
