-- Fix for missing conversation functions
-- This script implements the missing conversation functions for ActivityPub threading

-- Drop existing incomplete functions first
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread(jsonb) CASCADE;
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread() CASCADE;
DROP FUNCTION IF EXISTS public.get_conversation_context(jsonb) CASCADE;
DROP FUNCTION IF EXISTS public.get_conversation_context() CASCADE;

-- Implement get_conversation_context function
CREATE OR REPLACE FUNCTION public.get_conversation_context(args jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(
    post_id uuid,
    conversation_root_id uuid,
    total_posts integer,
    max_depth integer,
    root_published_at timestamp with time zone,
    latest_activity timestamp with time zone
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    target_post_id uuid;
    root_id uuid;
BEGIN
    -- Extract post_id from jsonb args
    target_post_id := (args->>'post_id')::uuid;
    
    -- If no post_id provided, try conversation_id or conversation_root_id
    IF target_post_id IS NULL THEN
        target_post_id := COALESCE(
            (args->>'conversation_id')::uuid,
            (args->>'conversation_root_id')::uuid
        );
    END IF;
    
    -- If still no ID, return empty result
    IF target_post_id IS NULL THEN
        RETURN;
    END IF;
    
    -- Get the conversation root ID
    SELECT COALESCE(p.conversation_root_id, p.id)
    INTO root_id
    FROM posts p
    WHERE p.id = target_post_id
      AND p.deleted_at IS NULL;
    
    -- If post not found, return empty
    IF root_id IS NULL THEN
        RETURN;
    END IF;
    
    -- Build conversation statistics
    RETURN QUERY
    WITH conversation_stats AS (
        WITH RECURSIVE thread_tree AS (
            -- Root post
            SELECT 
                p.id,
                p.created_at,
                0 as depth,
                ARRAY[p.id] as path
            FROM posts p
            WHERE p.id = root_id
              AND p.deleted_at IS NULL
            
            UNION ALL
            
            -- Recursive replies
            SELECT 
                p.id,
                p.created_at,
                tt.depth + 1,
                tt.path || p.id
            FROM posts p
            JOIN thread_tree tt ON p.in_reply_to = tt.id
            WHERE p.deleted_at IS NULL
              AND p.id != ALL(tt.path) -- Prevent infinite loops
              AND tt.depth < 50 -- Safety limit
        )
        SELECT 
            COUNT(*) as total_posts,
            MAX(depth) as max_depth,
            MIN(created_at) as root_published_at,
            MAX(created_at) as latest_activity
        FROM thread_tree
    )
    SELECT 
        target_post_id,
        root_id,
        cs.total_posts::integer,
        cs.max_depth::integer,
        cs.root_published_at,
        cs.latest_activity
    FROM conversation_stats cs;
END;
$$;

-- Implement get_activitypub_conversation_thread function  
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_thread(args jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(
    id uuid,
    uri text,
    content jsonb,
    content_type text,
    actor_uri text,
    actor_name text,
    actor_preferred_username text,
    actor_icon text,
    reply_to_id uuid,
    conversation_root_id uuid,
    likes_count integer,
    shares_count integer,
    replies_count integer,
    published_at timestamp with time zone,
    updated_at timestamp with time zone,
    depth integer,
    path text
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    target_conversation_id uuid;
    root_id uuid;
BEGIN
    -- Extract conversation parameters from jsonb args
    target_conversation_id := COALESCE(
        (args->>'conversation_root_id')::uuid,
        (args->>'conversation_id')::uuid,
        (args->>'post_id')::uuid
    );
    
    -- If no conversation ID provided, return empty
    IF target_conversation_id IS NULL THEN
        RETURN;
    END IF;
    
    -- Get the actual conversation root ID
    SELECT COALESCE(p.conversation_root_id, p.id)
    INTO root_id
    FROM posts p
    WHERE p.id = target_conversation_id
      AND p.deleted_at IS NULL;
    
    -- If post not found, return empty
    IF root_id IS NULL THEN
        RETURN;
    END IF;
    
    -- Return the threaded conversation
    RETURN QUERY
    WITH RECURSIVE conversation_tree AS (
        -- Root post
        SELECT 
            p.id,
            COALESCE(p.ap_id, p.url, '/posts/' || p.id::text) as uri,
            p.content,
            'text/html' as content_type,
            COALESCE(
                pr.federated_id,
                'https://' || pr.domain || '/users/' || pr.username
            ) as actor_uri,
            COALESCE(pr.display_name, pr.username) as actor_name,
            pr.username as actor_preferred_username,
            pr.avatar_url as actor_icon,
            p.in_reply_to as reply_to_id,
            p.conversation_root_id,
            p.favorites_count as likes_count,
            p.reblogs_count as shares_count,
            p.replies_count,
            p.created_at as published_at,
            p.updated_at,
            0 as depth,
            '0' as path,
            ARRAY[p.id] as id_path
        FROM posts p
        JOIN profiles pr ON p.author_id = pr.id
        WHERE p.id = root_id
          AND p.deleted_at IS NULL
        
        UNION ALL
        
        -- Recursive replies
        SELECT 
            p.id,
            COALESCE(p.ap_id, p.url, '/posts/' || p.id::text) as uri,
            p.content,
            'text/html' as content_type,
            COALESCE(
                pr.federated_id,
                'https://' || pr.domain || '/users/' || pr.username
            ) as actor_uri,
            COALESCE(pr.display_name, pr.username) as actor_name,
            pr.username as actor_preferred_username,
            pr.avatar_url as actor_icon,
            p.in_reply_to as reply_to_id,
            p.conversation_root_id,
            p.favorites_count as likes_count,
            p.reblogs_count as shares_count,
            p.replies_count,
            p.created_at as published_at,
            p.updated_at,
            ct.depth + 1,
            ct.path || '.' || (
                -- Create a sortable path based on creation time within each level
                ROW_NUMBER() OVER (
                    PARTITION BY p.in_reply_to 
                    ORDER BY p.created_at ASC
                )
            )::text,
            ct.id_path || p.id
        FROM posts p
        JOIN profiles pr ON p.author_id = pr.id
        JOIN conversation_tree ct ON p.in_reply_to = ct.id
        WHERE p.deleted_at IS NULL
          AND p.id != ALL(ct.id_path) -- Prevent infinite loops
          AND ct.depth < 50 -- Safety limit
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
    FROM conversation_tree ct
    ORDER BY ct.path;
END;
$$;

-- Also fix the alternative get_conversation_context function that takes direct parameters
CREATE OR REPLACE FUNCTION public.get_conversation_context(p_post_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    conversation_root_id uuid;
    result jsonb;
BEGIN
    -- Get the conversation root ID for this post
    SELECT COALESCE(p.conversation_root_id, p.id)
    INTO conversation_root_id
    FROM posts p
    WHERE p.id = p_post_id
      AND p.deleted_at IS NULL;
    
    -- If post not found, return empty object
    IF conversation_root_id IS NULL THEN
        RETURN '{}'::jsonb;
    END IF;
    
    -- Get conversation context using the main function
    SELECT jsonb_build_object(
        'post_id', ctx.post_id,
        'conversation_root_id', ctx.conversation_root_id,
        'total_posts', ctx.total_posts,
        'max_depth', ctx.max_depth,
        'root_published_at', ctx.root_published_at,
        'latest_activity', ctx.latest_activity
    )
    INTO result
    FROM get_conversation_context(
        jsonb_build_object('post_id', p_post_id)
    ) ctx;
    
    RETURN COALESCE(result, '{}'::jsonb);
END;
$$;

-- Add some helpful comments
COMMENT ON FUNCTION public.get_conversation_context(jsonb) IS 'Gets conversation metadata including post count, depth, and activity timestamps. Accepts jsonb with post_id, conversation_id, or conversation_root_id.';
COMMENT ON FUNCTION public.get_activitypub_conversation_thread(jsonb) IS 'Returns a threaded conversation tree for ActivityPub. Accepts jsonb with conversation_root_id, conversation_id, or post_id.';
COMMENT ON FUNCTION public.get_conversation_context(uuid, uuid) IS 'Legacy function that wraps the main get_conversation_context function for backward compatibility.';

-- Create parameterless versions to handle empty calls
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_thread()
RETURNS TABLE(
    id uuid,
    uri text,
    content jsonb,
    content_type text,
    actor_uri text,
    actor_name text,
    actor_preferred_username text,
    actor_icon text,
    reply_to_id uuid,
    conversation_root_id uuid,
    likes_count integer,
    shares_count integer,
    replies_count integer,
    published_at timestamp with time zone,
    updated_at timestamp with time zone,
    depth integer,
    path text
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    -- Return empty when called without parameters
    RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_conversation_context()
RETURNS TABLE(
    post_id uuid,
    conversation_root_id uuid,
    total_posts integer,
    max_depth integer,
    root_published_at timestamp with time zone,
    latest_activity timestamp with time zone
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    -- Return empty when called without parameters
    RETURN;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION public.get_conversation_context(jsonb) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_activitypub_conversation_thread(jsonb) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_conversation_context(uuid, uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_conversation_context() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_activitypub_conversation_thread() TO authenticated, anon;
