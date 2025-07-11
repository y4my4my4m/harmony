-- Fix PostgREST function signatures to match calling convention
-- PostgREST expects functions to take a single JSON parameter when called with object syntax

BEGIN;

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';

-- Drop existing functions
DROP FUNCTION IF EXISTS get_activitypub_conversation_root(jsonb) CASCADE;
DROP FUNCTION IF EXISTS get_activitypub_conversation_root(uuid) CASCADE;
DROP FUNCTION IF EXISTS get_activitypub_conversation_thread(uuid) CASCADE;
DROP FUNCTION IF EXISTS get_activitypub_conversation_context(uuid) CASCADE;
DROP FUNCTION IF EXISTS get_conversation_context(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS get_conversation_context(uuid) CASCADE;

-- Create functions that accept JSON parameters (PostgREST convention)
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

-- Create get_activitypub_conversation_thread with PostgREST-compatible signature
CREATE OR REPLACE FUNCTION get_activitypub_conversation_thread(args jsonb)
RETURNS TABLE(
    id UUID,
    uri TEXT,
    content TEXT,
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
            p.uri,
            p.content,
            p.content_type,
            p.actor_uri,
            p.actor_name,
            p.actor_preferred_username,
            p.actor_icon,
            p.reply_to_id,
            p.conversation_root_id,
            p.likes_count,
            p.shares_count,
            p.replies_count,
            p.published_at,
            p.updated_at,
            0 as depth,
            LPAD(ROW_NUMBER() OVER (ORDER BY p.published_at)::TEXT, 10, '0') as path
        FROM posts p
        WHERE (p.id = root_id OR p.conversation_root_id = root_id)
           AND p.reply_to_id IS NULL
           AND p.deleted_at IS NULL
        
        UNION ALL
        
        -- Recursive case: get replies ordered by publication time
        SELECT 
            reply.id,
            reply.uri,
            reply.content,
            reply.content_type,
            reply.actor_uri,
            reply.actor_name,
            reply.actor_preferred_username,
            reply.actor_icon,
            reply.reply_to_id,
            reply.conversation_root_id,
            reply.likes_count,
            reply.shares_count,
            reply.replies_count,
            reply.published_at,
            reply.updated_at,
            ct.depth + 1,
            ct.path || '.' || LPAD(ROW_NUMBER() OVER (ORDER BY reply.published_at)::TEXT, 10, '0')
        FROM posts reply
        INNER JOIN conversation_thread ct ON reply.reply_to_id = ct.id
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

-- Create get_activitypub_conversation_context with PostgREST-compatible signature
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
                WHEN p.reply_to_id IS NULL THEN 0
                ELSE (
                    WITH RECURSIVE depth_calc AS (
                        SELECT id, reply_to_id, 1 as depth
                        FROM posts 
                        WHERE id = p.id
                        
                        UNION ALL
                        
                        SELECT parent.id, parent.reply_to_id, dc.depth + 1
                        FROM posts parent
                        INNER JOIN depth_calc dc ON parent.id = dc.reply_to_id
                        WHERE dc.depth < 20
                    )
                    SELECT COALESCE(MAX(depth), 0) FROM depth_calc
                )
            END) as max_depth,
            MIN(p.published_at) as root_published_at,
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

-- Create get_conversation_context as an alias for get_activitypub_conversation_context
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

-- Grant execute permissions for both jsonb and no-parameter versions
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_root(jsonb) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_thread(jsonb) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_context(jsonb) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_conversation_context(jsonb) TO authenticated, anon;

-- Also create compatibility functions for calls without parameters (if needed)
CREATE OR REPLACE FUNCTION get_activitypub_conversation_thread()
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    RETURN 'ERROR: get_activitypub_conversation_thread requires conversation_root_id parameter';
END;
$$;

CREATE OR REPLACE FUNCTION get_conversation_context()
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    RETURN 'ERROR: get_conversation_context requires post_id parameter';
END;
$$;

GRANT EXECUTE ON FUNCTION get_activitypub_conversation_thread() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_conversation_context() TO authenticated, anon;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

-- Verify functions exist with correct signatures
SELECT 
    routines.routine_name,
    parameters.parameter_name,
    parameters.data_type,
    parameters.parameter_mode
FROM information_schema.routines
LEFT JOIN information_schema.parameters ON routines.specific_name = parameters.specific_name
WHERE routines.routine_name LIKE '%activitypub_conversation%'
ORDER BY routines.routine_name, parameters.ordinal_position;
