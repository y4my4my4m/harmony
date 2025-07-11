-- Fix function overloading conflicts for conversation functions
-- Drop all conflicting functions and implement clean, unambiguous versions

-- Drop all existing conversation function variants
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread();
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread(jsonb);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread(args jsonb);
DROP FUNCTION IF EXISTS public.get_conversation_context();
DROP FUNCTION IF EXISTS public.get_conversation_context(jsonb);
DROP FUNCTION IF EXISTS public.get_conversation_context(args jsonb);
DROP FUNCTION IF EXISTS public.get_conversation_context(uuid, uuid);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_context(jsonb);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_root(jsonb);

-- Create clean function for getting conversation root
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_root(params jsonb)
RETURNS TABLE(root_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    post_id uuid;
BEGIN
    -- Extract post_id from JSON parameter
    post_id := (params->>'post_id')::uuid;
    
    -- Return the conversation root ID
    RETURN QUERY
    SELECT COALESCE(p.conversation_root_id, p.id) as root_id
    FROM posts p
    WHERE p.id = post_id
      AND p.deleted_at IS NULL;
END;
$$;

-- Create clean function for getting conversation thread  
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_thread(params jsonb)
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
    path text,
    author jsonb,
    reply_context jsonb,
    visibility text,
    media_attachments jsonb,
    is_sensitive boolean,
    content_warning text
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    target_conversation_root_id uuid;
BEGIN
    -- Extract conversation_root_id from jsonb params
    target_conversation_root_id := (params->>'conversation_root_id')::uuid;
    
    -- If no conversation_root_id provided, try other parameters
    IF target_conversation_root_id IS NULL THEN
        target_conversation_root_id := COALESCE(
            (params->>'conversation_id')::uuid,
            (params->>'post_id')::uuid
        );
    END IF;
    
    -- If still no ID, return empty
    IF target_conversation_root_id IS NULL THEN
        RETURN;
    END IF;
    
    -- Get the actual conversation root if needed
    IF NOT EXISTS (
        SELECT 1 FROM posts 
        WHERE id = target_conversation_root_id 
          AND (conversation_root_id IS NULL OR conversation_root_id = id)
          AND deleted_at IS NULL
    ) THEN
        -- Find the root of this conversation
        SELECT COALESCE(p.conversation_root_id, p.id)
        INTO target_conversation_root_id
        FROM posts p
        WHERE p.id = target_conversation_root_id
          AND p.deleted_at IS NULL;
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
            COALESCE(p.conversation_root_id, p.id) as conversation_root_id,
            p.favorites_count as likes_count,
            p.reblogs_count as shares_count,
            p.replies_count,
            p.created_at as published_at,
            p.updated_at,
            0 as depth,
            '0' as path,
            jsonb_build_object(
                'id', pr.id,
                'username', pr.username,
                'display_name', COALESCE(pr.display_name, pr.username),
                'avatar_url', pr.avatar_url,
                'domain', pr.domain,
                'is_local', pr.is_local
            ) as author,
            NULL::jsonb as reply_context,
            p.visibility,
            p.media_attachments,
            p.is_sensitive,
            p.content_warning,
            ARRAY[p.id] as id_path
        FROM posts p
        JOIN profiles pr ON p.author_id = pr.id
        WHERE p.id = target_conversation_root_id
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
            COALESCE(p.conversation_root_id, target_conversation_root_id) as conversation_root_id,
            p.favorites_count as likes_count,
            p.reblogs_count as shares_count,
            p.replies_count,
            p.created_at as published_at,
            p.updated_at,
            ct.depth + 1,
            ct.path || '.' || (
                ROW_NUMBER() OVER (
                    PARTITION BY p.in_reply_to 
                    ORDER BY p.created_at ASC
                )
            )::text,
            jsonb_build_object(
                'id', pr.id,
                'username', pr.username,
                'display_name', COALESCE(pr.display_name, pr.username),
                'avatar_url', pr.avatar_url,
                'domain', pr.domain,
                'is_local', pr.is_local
            ) as author,
            CASE 
                WHEN p.in_reply_to IS NOT NULL THEN
                    jsonb_build_object(
                        'id', rp.id,
                        'author', jsonb_build_object(
                            'id', rpr.id,
                            'username', rpr.username,
                            'display_name', COALESCE(rpr.display_name, rpr.username),
                            'domain', rpr.domain
                        ),
                        'created_at', rp.created_at,
                        'content_preview', LEFT(rp.content::text, 100)
                    )
                ELSE NULL
            END as reply_context,
            p.visibility,
            p.media_attachments,
            p.is_sensitive,
            p.content_warning,
            ct.id_path || p.id
        FROM posts p
        JOIN profiles pr ON p.author_id = pr.id
        LEFT JOIN posts rp ON p.in_reply_to = rp.id
        LEFT JOIN profiles rpr ON rp.author_id = rpr.id
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
        ct.path,
        ct.author,
        ct.reply_context,
        ct.visibility,
        ct.media_attachments,
        ct.is_sensitive,
        ct.content_warning
    FROM conversation_tree ct
    ORDER BY ct.path;
END;
$$;

-- Create clean function for getting conversation context
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_context(params jsonb)
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
    -- Extract post_id from jsonb params
    target_post_id := (params->>'post_id')::uuid;
    
    -- If no post_id provided, try other parameters
    IF target_post_id IS NULL THEN
        target_post_id := COALESCE(
            (params->>'conversation_id')::uuid,
            (params->>'conversation_root_id')::uuid
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
    ),
    conversation_stats AS (
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

-- Add helpful comments
COMMENT ON FUNCTION public.get_activitypub_conversation_root(jsonb) IS 'Gets the root post ID of an ActivityPub conversation. Accepts jsonb with post_id parameter.';
COMMENT ON FUNCTION public.get_activitypub_conversation_thread(jsonb) IS 'Returns a complete threaded conversation tree for ActivityPub. Accepts jsonb with conversation_root_id, conversation_id, or post_id parameter.';
COMMENT ON FUNCTION public.get_activitypub_conversation_context(jsonb) IS 'Gets conversation metadata including post count, depth, and activity timestamps. Accepts jsonb with post_id, conversation_id, or conversation_root_id parameter.';

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.get_activitypub_conversation_root(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_activitypub_conversation_thread(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_activitypub_conversation_context(jsonb) TO authenticated;
