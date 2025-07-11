-- Fix conversation functions to match frontend calls
-- PostgREST expects functions with single JSONB parameters when called with object syntax

-- Drop all existing conversation function variants
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread();
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread(jsonb);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread(args jsonb);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread(conversation_root_id uuid);
DROP FUNCTION IF EXISTS public.get_conversation_context();
DROP FUNCTION IF EXISTS public.get_conversation_context(jsonb);
DROP FUNCTION IF EXISTS public.get_conversation_context(args jsonb);
DROP FUNCTION IF EXISTS public.get_conversation_context(uuid, uuid);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_context(jsonb);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_context(post_id uuid);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_root(jsonb);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_root(post_id uuid);

-- Create function for getting conversation root with SINGLE JSONB PARAMETER
-- This matches PostgREST convention: supabase.rpc('get_activitypub_conversation_root', { post_id: postId })
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_root(jsonb)
RETURNS TABLE(root_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    target_post_id uuid;
BEGIN
    -- Extract post_id from JSONB parameter
    target_post_id := ($1->>'post_id')::uuid;
    
    -- Return the conversation root ID
    RETURN QUERY
    SELECT COALESCE(p.conversation_root_id, p.id) as root_id
    FROM posts p
    WHERE p.id = target_post_id
      AND p.deleted_at IS NULL;
END;
$$;

-- Create function for getting conversation thread with NAMED PARAMETERS
-- This matches the frontend call: supabase.rpc('get_activitypub_conversation_thread', { conversation_root_id: conversationRootId })
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_thread(conversation_root_id uuid)
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
    root_id uuid,
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
    target_root_id uuid;
BEGIN
    -- Use a different variable name to avoid conflicts
    target_root_id := get_activitypub_conversation_thread.conversation_root_id;
    
    -- Return the threaded conversation using recursive CTE
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
            p.conversation_root_id as root_id,
            p.favorites_count as likes_count,
            p.reblogs_count as shares_count,
            p.replies_count,
            p.created_at as published_at,
            p.updated_at,
            0 as depth,
            ARRAY[p.id] as id_path,
            '0' as path
        FROM posts p
        JOIN profiles pr ON p.author_id = pr.id
        WHERE COALESCE(p.conversation_root_id, p.id) = target_root_id
          AND p.deleted_at IS NULL
          AND p.in_reply_to IS NULL
        
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
            p.conversation_root_id as root_id,
            p.favorites_count as likes_count,
            p.reblogs_count as shares_count,
            p.replies_count,
            p.created_at as published_at,
            p.updated_at,
            ct.depth + 1,
            ct.id_path || p.id,
            ct.path || '.' || (
                ROW_NUMBER() OVER (
                    PARTITION BY p.in_reply_to 
                    ORDER BY p.created_at ASC
                )
            )::text
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
        ct.root_id,
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

-- Create function for getting conversation context with NAMED PARAMETERS
-- This matches the frontend call: supabase.rpc('get_activitypub_conversation_context', { post_id: postId })
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_context(post_id uuid)
RETURNS TABLE(
    target_post_id uuid,
    conversation_root_id uuid,
    total_posts integer,
    max_depth integer,
    root_published_at timestamp with time zone,
    latest_activity timestamp with time zone
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    root_id uuid;
    target_post_id uuid;
BEGIN
    -- Use different variable names to avoid conflicts
    target_post_id := get_activitypub_conversation_context.post_id;
    
    -- Get the conversation root ID
    SELECT COALESCE(p.conversation_root_id, p.id)
    INTO root_id
    FROM posts p
    WHERE p.id = target_post_id
      AND p.deleted_at IS NULL;
    
    -- If post not found, return empty result
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
        WHERE COALESCE(p.conversation_root_id, p.id) = root_id
          AND p.deleted_at IS NULL
          AND p.in_reply_to IS NULL
        
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

-- Create legacy function for backward compatibility
-- This matches older frontend calls: supabase.rpc('get_conversation_context', { p_post_id: postId, p_user_id: user.id })
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
    
    -- Get all posts in conversation ordered chronologically
    WITH conversation_posts AS (
        SELECT 
            p.id,
            p.content,
            p.created_at,
            p.in_reply_to,
            jsonb_build_object(
                'id', pr.id,
                'username', pr.username,
                'display_name', pr.display_name,
                'avatar_url', pr.avatar_url,
                'domain', pr.domain
            ) as author,
            p.visibility,
            p.favorites_count,
            p.reblogs_count,
            p.replies_count,
            p.media_attachments,
            p.content_warning,
            p.is_sensitive,
            p.url,
            CASE 
                WHEN pi_fav.user_id IS NOT NULL THEN true 
                ELSE false 
            END as is_favorited,
            CASE 
                WHEN pi_reb.user_id IS NOT NULL THEN true 
                ELSE false 
            END as is_reblogged,
            CASE 
                WHEN pi_book.user_id IS NOT NULL THEN true 
                ELSE false 
            END as is_bookmarked
        FROM posts p
        JOIN profiles pr ON p.author_id = pr.id
        LEFT JOIN post_interactions pi_fav ON p.id = pi_fav.post_id 
            AND pi_fav.user_id = p_user_id 
            AND pi_fav.interaction_type = 'favorite'
        LEFT JOIN post_interactions pi_reb ON p.id = pi_reb.post_id 
            AND pi_reb.user_id = p_user_id 
            AND pi_reb.interaction_type = 'reblog'
        LEFT JOIN post_interactions pi_book ON p.id = pi_book.post_id 
            AND pi_book.user_id = p_user_id 
            AND pi_book.interaction_type = 'bookmark'
        WHERE COALESCE(p.conversation_root_id, p.id) = conversation_root_id
          AND p.deleted_at IS NULL
        ORDER BY p.created_at ASC
    )
    SELECT jsonb_build_object(
        'ancestors', jsonb_agg(
            jsonb_build_object(
                'id', cp.id,
                'content', cp.content,
                'created_at', cp.created_at,
                'author', cp.author,
                'visibility', cp.visibility,
                'favorites_count', cp.favorites_count,
                'reblogs_count', cp.reblogs_count,
                'replies_count', cp.replies_count,
                'media_attachments', cp.media_attachments,
                'content_warning', cp.content_warning,
                'is_sensitive', cp.is_sensitive,
                'url', cp.url,
                'is_favorited', cp.is_favorited,
                'is_reblogged', cp.is_reblogged,
                'is_bookmarked', cp.is_bookmarked
            )
        ) FILTER (WHERE cp.created_at < (SELECT created_at FROM posts WHERE id = p_post_id)),
        'descendants', jsonb_agg(
            jsonb_build_object(
                'id', cp.id,
                'content', cp.content,
                'created_at', cp.created_at,
                'author', cp.author,
                'visibility', cp.visibility,
                'favorites_count', cp.favorites_count,
                'reblogs_count', cp.reblogs_count,
                'replies_count', cp.replies_count,
                'media_attachments', cp.media_attachments,
                'content_warning', cp.content_warning,
                'is_sensitive', cp.is_sensitive,
                'url', cp.url,
                'is_favorited', cp.is_favorited,
                'is_reblogged', cp.is_reblogged,
                'is_bookmarked', cp.is_bookmarked
            )
        ) FILTER (WHERE cp.created_at > (SELECT created_at FROM posts WHERE id = p_post_id)),
        'conversation_id', conversation_root_id
    ) INTO result
    FROM conversation_posts cp;
    
    RETURN COALESCE(result, jsonb_build_object(
        'ancestors', '[]'::jsonb,
        'descendants', '[]'::jsonb,
        'conversation_id', conversation_root_id
    ));
END;
$$;

-- Add helpful comments
COMMENT ON FUNCTION public.get_activitypub_conversation_root(uuid) IS 'Returns the conversation root ID for a given post. Accepts post_id as named parameter.';
COMMENT ON FUNCTION public.get_activitypub_conversation_thread(uuid) IS 'Returns a threaded conversation tree for ActivityPub. Accepts conversation_root_id as named parameter.';
COMMENT ON FUNCTION public.get_activitypub_conversation_context(uuid) IS 'Gets conversation metadata including post count, depth, and activity timestamps. Accepts post_id as named parameter.';
COMMENT ON FUNCTION public.get_conversation_context(uuid, uuid) IS 'Legacy function for backward compatibility with existing frontend calls.';
