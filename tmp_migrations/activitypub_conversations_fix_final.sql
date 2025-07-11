-- Fix the conversation functions to use the correct 'posts' table instead of 'activitypub_posts'

BEGIN;

-- Drop the broken functions
DROP FUNCTION IF EXISTS get_activitypub_conversation_root(jsonb) CASCADE;
DROP FUNCTION IF EXISTS get_activitypub_conversation_thread(jsonb) CASCADE;
DROP FUNCTION IF EXISTS get_activitypub_conversation_context(jsonb) CASCADE;
DROP FUNCTION IF EXISTS get_conversation_context(jsonb) CASCADE;

-- Create get_activitypub_conversation_root function (corrected to use 'posts' table)
CREATE OR REPLACE FUNCTION get_activitypub_conversation_root(params jsonb)
RETURNS TABLE(root_id uuid) 
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    post_id uuid;
BEGIN
    -- Extract post_id from JSON parameter
    post_id := (params->>'post_id')::uuid;
    
    -- O(1) lookup using conversation_root_id column
    RETURN QUERY
    SELECT COALESCE(p.conversation_root_id, p.id) as root_id
    FROM posts p
    WHERE p.id = post_id
    AND p.deleted_at IS NULL;
END;
$$;

-- Create get_activitypub_conversation_thread function (corrected to use 'posts' table)
CREATE OR REPLACE FUNCTION get_activitypub_conversation_thread(args jsonb)
RETURNS TABLE(
    id UUID,
    uri TEXT,
    content JSONB,
    content_type TEXT,
    actor_uri TEXT,
    actor_name TEXT,
    actor_preferred_username TEXT,
    actor_icon TEXT,
    reply_to_id UUID,
    conversation_root_id UUID,
    likes_count INTEGER,
    shares_count INTEGER,
    replies_count INTEGER,
    published_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    depth INTEGER,
    path TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    root_id UUID;
BEGIN
    -- Extract conversation_root_id from jsonb args
    root_id := (args->>'conversation_root_id')::UUID;
    
    -- Get the complete conversation thread with proper ordering from the posts table
    RETURN QUERY
    WITH RECURSIVE conversation_thread AS (
        -- Base case: get the root post
        SELECT 
            p.id,
            p.url as uri,
            p.content,
            'text/html' as content_type,
            COALESCE(prof.federated_id, 'https://har.mony.lol/users/' || prof.username) as actor_uri,
            COALESCE(prof.display_name, prof.username) as actor_name,
            prof.username as actor_preferred_username,
            prof.avatar_url as actor_icon,
            p.in_reply_to as reply_to_id,
            p.conversation_root_id,
            p.favorites_count as likes_count,
            p.reblogs_count as shares_count,
            p.replies_count,
            p.created_at as published_at,
            p.updated_at,
            0 as depth,
            LPAD(ROW_NUMBER() OVER (ORDER BY p.created_at)::TEXT, 10, '0') as path
        FROM posts p
        LEFT JOIN profiles prof ON p.author_id = prof.id
        WHERE (p.id = root_id OR p.conversation_root_id = root_id)
           AND p.in_reply_to IS NULL
           AND p.deleted_at IS NULL
        
        UNION ALL
        
        -- Recursive case: get replies ordered by publication time
        SELECT 
            reply.id,
            reply.url as uri,
            reply.content,
            'text/html' as content_type,
            COALESCE(prof.federated_id, 'https://har.mony.lol/users/' || prof.username) as actor_uri,
            COALESCE(prof.display_name, prof.username) as actor_name,
            prof.username as actor_preferred_username,
            prof.avatar_url as actor_icon,
            reply.in_reply_to as reply_to_id,
            reply.conversation_root_id,
            reply.replies_count,
            reply.created_at as published_at,
            reply.updated_at,
            ct.depth + 1,
            ct.path || '.' || LPAD(ROW_NUMBER() OVER (ORDER BY reply.created_at)::TEXT, 10, '0')
        FROM posts reply
        LEFT JOIN profiles prof ON reply.author_id = prof.id
        INNER JOIN conversation_thread ct ON reply.in_reply_to = ct.id
        WHERE ct.depth < 20 -- Reasonable thread depth limit
           AND reply.deleted_at IS NULL
    )
    SELECT 
        ct.id,
        ct.uri,
        ct.content,
        ct.content_type,
        ct.actor_uri,
        ct.actor_name,
        ct.actor_preferred_username,
        ct.actor_icon,
        ct.reply_to_id,
        ct.conversation_root_id,
        ct.likes_count,
        ct.shares_count,
        ct.replies_count,
        ct.published_at,
        ct.updated_at,
        ct.depth,
        ct.path
    FROM conversation_thread ct
    ORDER BY ct.path;
END;
$$;

-- Create get_activitypub_conversation_context function (corrected to use 'posts' table)
CREATE OR REPLACE FUNCTION get_activitypub_conversation_context(args jsonb)
RETURNS TABLE(
    post_id UUID,
    conversation_root_id UUID,
    total_posts INTEGER,
    max_depth INTEGER,
    root_published_at TIMESTAMPTZ,
    latest_activity TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    target_post_id UUID;
    root_id UUID;
BEGIN
    -- Extract post_id from jsonb args
    target_post_id := (args->>'post_id')::UUID;
    
    -- First, find the conversation root
    SELECT cr.root_id INTO root_id
    FROM get_activitypub_conversation_root(jsonb_build_object('post_id', target_post_id)) cr;
    
    -- Get conversation context statistics from the posts table
    RETURN QUERY
    WITH conversation_stats AS (
        SELECT 
            COUNT(*) as total_posts,
            MAX(CASE 
                WHEN p.in_reply_to IS NULL THEN 0
                ELSE (
                    WITH RECURSIVE depth_calc AS (
                        SELECT id, in_reply_to, 1 as depth
                        FROM posts 
                        WHERE id = p.id
                        
                        UNION ALL
                        
                        SELECT parent.id, parent.in_reply_to, dc.depth + 1
                        FROM posts parent
                        INNER JOIN depth_calc dc ON parent.id = dc.in_reply_to
                        WHERE dc.depth < 20
                    )
                    SELECT COALESCE(MAX(depth), 0) FROM depth_calc
                )
            END) as max_depth,
            MIN(p.created_at) as root_published_at,
            MAX(p.updated_at) as latest_activity
        FROM posts p
        WHERE (p.id = root_id OR p.conversation_root_id = root_id)
           AND p.deleted_at IS NULL
    )
    SELECT 
        target_post_id,
        root_id,
        cs.total_posts::INTEGER,
        cs.max_depth::INTEGER,
        cs.root_published_at,
        cs.latest_activity
    FROM conversation_stats cs;
END;
$$;

-- Create get_conversation_context as an alias for compatibility
CREATE OR REPLACE FUNCTION get_conversation_context(args jsonb)
RETURNS TABLE(
    post_id UUID,
    conversation_root_id UUID,
    total_posts INTEGER,
    max_depth INTEGER,
    root_published_at TIMESTAMPTZ,
    latest_activity TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Just call the main function
    RETURN QUERY SELECT * FROM get_activitypub_conversation_context(args);
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_root(jsonb) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_thread(jsonb) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_context(jsonb) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_conversation_context(jsonb) TO authenticated, anon;

-- Force PostgREST schema reload
NOTIFY pgrst, 'reload schema';

COMMIT;

-- Test that the functions work
SELECT 'Functions created successfully!' as status;