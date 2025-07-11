-- DEFINITIVE FIX for ActivityPub conversation functions
-- This migration follows the EXACT same pattern as working functions in the schema
-- All functions use single JSONB parameters for PostgREST/Supabase RPC compatibility

-- Drop ALL existing variants to avoid any conflicts
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread();
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread(jsonb);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread(args jsonb);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread(conversation_root_id uuid);
DROP FUNCTION IF EXISTS public.get_conversation_context();
DROP FUNCTION IF EXISTS public.get_conversation_context(jsonb);
DROP FUNCTION IF EXISTS public.get_conversation_context(args jsonb);
DROP FUNCTION IF EXISTS public.get_conversation_context(uuid, uuid);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_context(jsonb);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_context(args jsonb);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_context(post_id uuid);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_root(jsonb);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_root(params jsonb);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_root(post_id uuid);

-- 1. CREATE get_activitypub_conversation_root with JSONB parameter
-- Matches frontend call: supabase.rpc('get_activitypub_conversation_root', { post_id: postId })
CREATE FUNCTION public.get_activitypub_conversation_root(params jsonb) 
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

-- 2. CREATE get_activitypub_conversation_thread with JSONB parameter
-- Matches frontend call: supabase.rpc('get_activitypub_conversation_thread', { conversation_root_id: conversationRootId })
CREATE FUNCTION public.get_activitypub_conversation_thread(args jsonb) 
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
            COALESCE(p.ap_id, p.url, '/posts/' || p.id::text) as uri,
            p.content,
            'text/html' as content_type,
            COALESCE(
                prof.federated_id, 
                'https://' || prof.domain || '/users/' || prof.username
            ) as actor_uri,
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
            COALESCE(reply.ap_id, reply.url, '/posts/' || reply.id::text) as uri,
            reply.content,
            'text/html' as content_type,
            COALESCE(
                prof.federated_id, 
                'https://' || prof.domain || '/users/' || prof.username
            ) as actor_uri,
            COALESCE(prof.display_name, prof.username) as actor_name,
            prof.username as actor_preferred_username,
            prof.avatar_url as actor_icon,
            reply.in_reply_to as reply_to_id,
            reply.conversation_root_id,
            reply.favorites_count as likes_count,
            reply.reblogs_count as shares_count,
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

-- 3. CREATE get_activitypub_conversation_context with JSONB parameter
-- Matches frontend call: supabase.rpc('get_activitypub_conversation_context', { post_id: postId })
CREATE FUNCTION public.get_activitypub_conversation_context(args jsonb) 
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

-- 4. CREATE get_conversation_context for backward compatibility (EXACT same as legacy)
-- Matches frontend call: supabase.rpc('get_conversation_context', { p_post_id: postId, p_user_id: user.id })
CREATE FUNCTION public.get_conversation_context(p_post_id uuid, p_user_id uuid) 
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

-- Add helpful comments explaining PostgREST compatibility
COMMENT ON FUNCTION public.get_activitypub_conversation_root(jsonb) IS 'Returns the conversation root ID for a given post. PostgREST-compatible with single JSONB parameter.';
COMMENT ON FUNCTION public.get_activitypub_conversation_thread(jsonb) IS 'Returns a threaded conversation tree for ActivityPub. PostgREST-compatible with single JSONB parameter.';
COMMENT ON FUNCTION public.get_activitypub_conversation_context(jsonb) IS 'Gets conversation metadata including post count, depth, and activity timestamps. PostgREST-compatible with single JSONB parameter.';
COMMENT ON FUNCTION public.get_conversation_context(uuid, uuid) IS 'Legacy function for backward compatibility with existing frontend calls that use named parameters.';

-- Verify functions were created successfully
SELECT routine_name, routine_type, data_type 
FROM information_schema.routines 
WHERE routine_schema = 'public' 
  AND routine_name LIKE '%conversation%'
ORDER BY routine_name;
